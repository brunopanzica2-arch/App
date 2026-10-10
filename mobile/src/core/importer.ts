/** Importação: CSV, XLSX, texto colado e manual. Nenhuma linha é descartada em silêncio. */
import { type Batch, db, type Letter, uid } from "./db";
import { clean, normalizeAddress, normText, parseAddressLine } from "./normalize";

export const FIELDS: [string, string][] = [
  ["external_id", "Identificador"], ["recipient", "Destinatário"], ["street", "Logradouro"], ["number", "Número"],
  ["complement", "Complemento"], ["neighborhood", "Bairro"], ["city", "Município"], ["cep", "CEP"],
  ["notes", "Observações"], ["full_address", "Endereço completo (texto livre)"],
];
const SYN: Record<string, string[]> = {
  external_id: ["id", "identificador", "codigo", "cod", "objeto", "registro", "rastreio", "n objeto"],
  recipient: ["destinatario", "nome", "cliente", "recebedor"],
  street: ["logradouro", "rua", "endereco", "end", "via"],
  number: ["numero", "num", "n", "nº", "no"],
  complement: ["complemento", "compl", "apto", "apartamento"],
  neighborhood: ["bairro"],
  city: ["municipio", "cidade", "localidade"],
  cep: ["cep", "codigo postal"],
  notes: ["observacoes", "observacao", "obs", "nota", "notas"],
  full_address: ["endereco completo"],
};

export interface Table {
  headers: string[];
  rows: string[][];
  original: string;
  hasHeader: boolean;
}

/** RFC 4180: aspas, aspas duplicadas, delimitador e QUEBRA DE LINHA dentro de campo citado, CRLF. */
export function csvRecords(text: string, d: string): string[][] {
  const out: string[][] = [];
  let row: string[] = [], cell = "", q = false, quotedCell = false;
  const push = () => {
    const v = cell.replace(/\r\n?/g, "\n");
    row.push(v.includes("\n") ? v.split("\n").map(clean).join("\n") : clean(v));
    cell = ""; quotedCell = false;
  };
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') q = false;
      else cell += c;
    } else if (c === '"' && !cell.trim()) { q = true; quotedCell = true; cell = ""; }
    else if (c === d) push();
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      push();
      if (row.some((x) => x)) out.push(row);
      row = [];
    } else cell += c;
  }
  if (cell || quotedCell || row.length) { push(); if (row.some((x) => x)) out.push(row); }
  return out;
}

/** Separador escolhido pela contagem de CAMPOS por registro (respeitando aspas). */
export function detectDelimiter(text: string, hasHeader: boolean): string | null {
  let best: [string, number, number] | null = null;
  for (const d of [";", "\t", "|", ","]) {
    const recs = csvRecords(text.slice(0, 200000), d).slice(0, 50);
    if (!recs.length) continue;
    const widths = recs.map((r) => r.length);
    const count = new Map<number, number>();
    widths.forEach((w) => count.set(w, (count.get(w) || 0) + 1));
    let common = 0, cn = 0;
    count.forEach((n, w) => { if (n > cn || (n === cn && w > common)) { cn = n; common = w; } });
    const share = cn / widths.length;
    if (common < 2 || share < 0.8) continue;
    if (d === "," && !hasHeader) continue; // "Rua X, 123" sem cabeçalho é ambíguo
    if (!best || share > best[1] || (share === best[1] && common > best[2])) best = [d, share, common];
  }
  return best ? best[0] : null;
}

export function parseText(text: string, delimiter = "auto", hasHeader = true): Table {
  text = text.replace(/^\ufeff/, "");
  if (!text.trim()) throw new Error("Conteúdo vazio.");
  const d = delimiter === "auto" ? detectDelimiter(text, hasHeader) : delimiter;
  let rows = d ? csvRecords(text, d) : text.split(/\r\n?|\n/).filter((l) => l.trim()).map((l) => [clean(l)]);
  if (!rows.length) throw new Error("Conteúdo vazio.");
  let headers: string[];
  if (hasHeader) { headers = rows[0]; rows = rows.slice(1); }
  else headers = Array.from({ length: Math.max(...rows.map((r) => r.length)) }, (_, i) => `coluna_${i + 1}`);
  headers = headers.map((h, i) => h || `coluna_${i + 1}`);
  return { headers, rows, original: text, hasHeader };
}

export async function parseFile(file: File, delimiter = "auto", hasHeader = true): Promise<Table> {
  if (file.size > 10 * 1024 * 1024) throw new Error("Arquivo maior que 10 MB.");
  if (/\.xlsx$/i.test(file.name)) {
    const { default: readXlsx } = await import("read-excel-file/browser");
    const data: any = await readXlsx(file);
    const sheet: any[][] = Array.isArray(data?.[0]?.data) ? data[0].data : data;
    let rows = sheet.map((r: any[]) => r.map((v) => (v == null ? "" : clean(String(v))))).filter((r: string[]) => r.some((x) => x));
    if (!rows.length) throw new Error("Planilha vazia.");
    let headers: string[];
    if (hasHeader) { headers = rows[0]; rows = rows.slice(1); }
    else headers = rows[0].map((_: string, i: number) => `coluna_${i + 1}`);
    const original = [headers, ...rows].map((r) => r.join(";")).join("\n");
    return { headers: headers.map((h, i) => h || `coluna_${i + 1}`), rows, original, hasHeader };
  }
  return parseText(await file.text(), delimiter, hasHeader);
}

export function suggestMapping(headers: string[]): Record<string, string | null> {
  const map: Record<string, string | null> = Object.fromEntries(FIELDS.map(([f]) => [f, null]));
  const used = new Set<string>();
  for (const [f] of FIELDS) {
    for (const h of headers) {
      if (used.has(h)) continue;
      const n = normText(h).toLowerCase();
      if (n === f || SYN[f].includes(n) || SYN[f].includes(n.replace(/_/g, " "))) {
        map[f] = h;
        used.add(h);
        break;
      }
    }
  }
  if (headers.length === 1 && !map.street) map.full_address = headers[0];
  return map;
}

export interface MappedRow {
  row: number;
  values: Record<string, string | null>;
  errors: string[];
  warnings: string[];
  key: string | null;
}

export function mapRows(t: Table, mapping: Record<string, string | null>): MappedRow[] {
  if (!mapping.street && !mapping.full_address) throw new Error("Mapeie a coluna de logradouro ou de endereço completo.");
  const idx = Object.fromEntries(t.headers.map((h, i) => [h, i]));
  const out: MappedRow[] = [];
  t.rows.forEach((r, k) => {
    const v: Record<string, string | null> = {};
    for (const [f] of FIELDS) v[f] = mapping[f] ? clean(r[idx[mapping[f]!]] ?? "") || null : null;
    if (v.full_address) {
      const p = parseAddressLine(v.full_address);
      for (const [kk, vv] of Object.entries(p)) if (!v[kk]) v[kk] = vv;
    }
    if (!Object.values(v).some(Boolean)) return;
    const na = normalizeAddress(v.street, v.number, v.neighborhood, v.city, v.cep);
    out.push({ row: k + (t.hasHeader ? 2 : 1), values: v, errors: na.errors, warnings: na.issues, key: na.errors.length ? null : na.key });
  });
  return out;
}

export function preview(t: Table, mapping: Record<string, string | null>) {
  const rows = mapRows(t, mapping);
  const ids = rows.map((r) => r.values.external_id).filter(Boolean) as string[];
  return {
    total: rows.length,
    errorRows: rows.filter((r) => r.errors.length).length,
    warningRows: rows.filter((r) => r.warnings.length).length,
    duplicateIds: [...new Set(ids.filter((x, i) => ids.indexOf(x) !== i))],
    uniqueAddresses: new Set(rows.map((r) => r.key).filter(Boolean)).size,
    rows: rows.slice(0, 30),
  };
}

export class DuplicateImportError extends Error {
  constructor(public existing: Batch) {
    super(`Este conteúdo já foi importado no lote "${existing.reference}" (${existing.date}).`);
  }
}

export async function sha256(text: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function commitImport(t: Table, mapping: Record<string, string | null>, reference: string, date: string,
  sourceType: Batch["sourceType"], filename?: string, batchId?: string, allowSameContent = false): Promise<Batch> {
  const rows = mapRows(t, mapping);
  const importHash = await sha256(t.original);
  if (!batchId && !allowSameContent) {
    const same = await db.batches.where("importHash").equals(importHash).first();
    if (same) throw new DuplicateImportError(same);
  }
  const existingIds = new Set((await db.letters.toArray()).map((l) => l.externalId).filter(Boolean));
  const seen = new Set<string>();
  const report: Batch["report"] = { inserted: 0, duplicates: [], withErrors: [] };
  const letters: Letter[] = [];
  let batch = batchId ? await db.batches.get(batchId) : undefined;
  if (!batch) batch = { id: uid(), reference, date, createdAt: new Date().toISOString(), sourceType, filename, original: t.original, importHash, report };
  const startRow = batchId ? (await db.letters.where("batchId").equals(batch.id).count()) : 0;
  for (const r of rows) {
    const ext = r.values.external_id;
    if (ext && (existingIds.has(ext) || seen.has(ext))) {
      report.duplicates.push({ row: r.row, externalId: ext });
      continue;
    }
    if (ext) seen.add(ext);
    if (r.errors.length) report.withErrors.push({ row: r.row, errors: r.errors });
    letters.push({
      id: uid(), batchId: batch.id, row: startRow + r.row, externalId: ext, recipient: r.values.recipient,
      street: r.values.street, number: r.values.number, complement: r.values.complement,
      neighborhood: r.values.neighborhood, city: r.values.city, cep: r.values.cep, notes: r.values.notes,
      status: "pending", errors: r.errors, warnings: r.warnings, excluded: false, addressKey: r.key,
    });
  }
  report.inserted = letters.length;
  if (batchId) {
    batch.report = {
      inserted: batch.report.inserted + report.inserted,
      duplicates: [...batch.report.duplicates, ...report.duplicates],
      withErrors: [...batch.report.withErrors, ...report.withErrors],
    };
    batch.original += "\n" + t.original;
  } else batch.report = report;
  await db.transaction("rw", db.batches, db.letters, async () => {
    await db.batches.put(batch!);
    await db.letters.bulkAdd(letters);
  });
  return batch;
}
