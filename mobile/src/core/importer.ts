/** Importação: CSV, XLSX, texto colado e manual. Nenhuma linha é descartada em silêncio. */
import { type Batch, db, type Letter, uid } from "./db";
import { parseFreeAddress } from "./freetext";
import { clean, normalizeAddress, normText, parseAddressLine } from "./normalize";
import { explodeMultiAddressText } from "./freetext";
import { type Inferred, inferRows, inferSchema } from "./schema";

export const FIELDS: [string, string][] = [
  ["external_id", "Identificador"], ["recipient", "Destinatário"], ["street", "Logradouro"], ["number", "Número"],
  ["complement", "Complemento"], ["neighborhood", "Bairro"], ["city", "Município"], ["cep", "CEP"],
  ["state", "UF"], ["notes", "Observações"], ["full_address", "Endereço completo (texto livre)"],
];
const SYN: Record<string, string[]> = {
  external_id: ["id", "identificador", "codigo", "cod", "objeto", "registro", "rastreio", "n objeto"],
  recipient: ["destinatario", "nome", "cliente", "recebedor"],
  street: ["logradouro", "rua", "endereco", "end", "via"],
  number: ["numero", "num", "n", "nº", "no"],
  complement: ["complemento", "compl", "apto", "apartamento"],
  neighborhood: ["bairro"],
  city: ["municipio", "cidade", "localidade"],
  state: ["uf", "estado"],
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
  raw: string[];
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
    let fnotes: string[] = [];
    const v: Record<string, string | null> = {};
    for (const [f] of FIELDS) v[f] = mapping[f] ? clean(r[idx[mapping[f]!]] ?? "") || null : null;
    if (v.full_address) {
      // texto livre: sem separador/cabeçalho/ordem fixa (FreeTextAddressResolver); o escopo padrão Santos/SP é aplicado na normalização
      const p = parseFreeAddress(v.full_address);
      for (const k of ["street", "number", "complement", "neighborhood", "city", "state", "cep"] as const) if (!v[k] && p[k]) v[k] = p[k];
      if (p.notes.length) fnotes = p.notes;
    }
    if (v.state && !/\/\s*[A-Za-z]{2}$/.test(v.city ?? "")) v.city = `${v.city || "Santos"}/${v.state.toUpperCase()}`;
    if (!Object.values(v).some(Boolean)) return;
    const na = normalizeAddress(v.street, v.number, v.neighborhood, v.city, v.cep);
    out.push({ row: k + (t.hasHeader ? 2 : 1), raw: r, values: v, errors: na.errors, warnings: [...na.issues, ...fnotes], key: na.errors.length ? null : na.key });
  });
  return out;
}

export interface Prepared { table: Table; mapping: Record<string, string | null>; inferred: Inferred; warnings: string[] }

/** Evita o bug "211 linhas → 28 inseridas": coluna de identificador com valores repetidos NÃO é identificador;
 *  uma mesma coluna não pode alimentar logradouro e número ao mesmo tempo. */
export function sanitizeMapping(t: Table, mapping: Record<string, string | null>): { mapping: Record<string, string | null>; warnings: string[] } {
  const m = { ...mapping };
  const warnings: string[] = [];
  const idx = Object.fromEntries(t.headers.map((h, i) => [h, i]));
  if (m.external_id) {
    const vals = t.rows.map((r) => clean(r[idx[m.external_id!]] ?? "")).filter(Boolean);
    const distinct = new Set(vals).size;
    if (vals.length >= 3 && distinct / vals.length < 0.5) {
      warnings.push(`A coluna "${m.external_id}" não foi usada como identificador: ${vals.length} linhas têm só ${distinct} valores distintos. Nenhuma carta foi descartada por isso.`);
      m.external_id = null;
    }
  }
  const seen = new Map<string, string>();
  for (const f of ["street", "number", "neighborhood", "city", "state", "cep", "complement", "recipient"]) {
    const h = m[f];
    if (!h) continue;
    if (seen.has(h)) {
      warnings.push(`A coluna "${h}" estava mapeada para "${seen.get(h)}" e "${f}"; mantive só "${seen.get(h)}".`);
      m[f] = null;
    } else seen.set(h, f);
  }
  return { mapping: m, warnings };
}

export function fromInferred(inf: Inferred, original: string): Prepared {
  const table: Table = { headers: inf.headers, rows: inf.rows, original, hasHeader: inf.hasHeader };
  const raw: Record<string, string | null> = Object.fromEntries(FIELDS.map(([f]) => [f, inf.mapping[f as keyof typeof inf.mapping] !== undefined ? inf.headers[inf.mapping[f as keyof typeof inf.mapping]!] : null]));
  const { mapping, warnings } = sanitizeMapping(table, raw);
  return { table, mapping, inferred: inf, warnings: [...inf.warnings, ...warnings] };
}

/** Texto colado ou conteúdo de arquivo CSV/TSV/TXT: detecta tudo sozinho. */
export function prepareText(raw: string, forced?: { delimiter?: string | null; hasHeader?: boolean }): Prepared {
  // vários endereços na mesma linha ("Rua A 53, Avenida B 78, …") viram um por linha ANTES de detectar delimitador/colunas
  const { text, extra } = forced?.delimiter === undefined ? explodeMultiAddressText(raw) : { text: raw, extra: 0 };
  const p = fromInferred(inferSchema(text, forced), text.replace(/^\ufeff/, ""));
  if (extra > 0) p.warnings.unshift(`Separei ${extra + 1} endereços que estavam juntos na mesma linha. Confira a prévia.`);
  return p;
}

export async function prepareFile(file: File, forced?: { delimiter?: string | null; hasHeader?: boolean }): Promise<Prepared> {
  if (file.size > 10 * 1024 * 1024) throw new Error("Arquivo maior que 10 MB.");
  if (/\.xlsx$/i.test(file.name)) {
    const { default: readXlsx } = await import("read-excel-file/browser");
    const data: any = await readXlsx(file);
    const sheet: any[][] = Array.isArray(data?.[0]?.data) ? data[0].data : data;
    const rows = sheet.map((r: any[]) => r.map((v) => (v == null ? "" : clean(String(v)))));
    const inf = inferRows(rows, null, forced?.hasHeader);
    return fromInferred(inf, [inf.headers, ...inf.rows].map((r) => r.join(";")).join("\n"));
  }
  return prepareText(await file.text(), forced);
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
    withNumber: rows.filter((r) => !r.errors.length && !!r.values.number && !/^S\s*\/?\s*N$/i.test(r.values.number)).length,
    rows: [...rows.filter((r) => r.errors.length), ...rows.filter((r) => !r.errors.length)].slice(0, 30), // inválidas primeiro (revisão)
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

export async function commitImport(t: Table, mapping0: Record<string, string | null>, reference: string, date: string,
  sourceType: Batch["sourceType"], filename?: string, batchId?: string, allowSameContent = false, inferred?: Inferred): Promise<Batch> {
  const sane = sanitizeMapping(t, mapping0);
  const mapping = sane.mapping;
  const rows = mapRows(t, mapping);
  const importHash = await sha256(t.original);
  if (!batchId && !allowSameContent) {
    const same = await db.batches.where("importHash").equals(importHash).first();
    if (same) throw new DuplicateImportError(same);
  }
  // Duplicata CONFIRMADA = mesmo identificador E mesmo conteúdo (endereço + destinatário + complemento).
  // Mesmo identificador com conteúdo diferente NÃO é descartado: entra, com aviso para revisão.
  const sig = (key: string | null, v: Record<string, string | null>, r: string[]) =>
    [key ?? r.join("|"), normText(v.recipient), normText(v.complement)].join("#");
  const known = new Map<string, Set<string>>();
  for (const l of await db.letters.toArray()) {
    if (!l.externalId) continue;
    const g = known.get(l.externalId) ?? new Set<string>();
    g.add([l.addressKey ?? (l.raw ?? []).join("|"), normText(l.recipient), normText(l.complement)].join("#"));
    known.set(l.externalId, g);
  }
  const report: Batch["report"] = { inserted: 0, duplicates: [], withErrors: [], warnings: sane.warnings };
  const letters: Letter[] = [];
  let batch = batchId ? await db.batches.get(batchId) : undefined;
  if (!batch) batch = { id: uid(), reference, date, createdAt: new Date().toISOString(), sourceType, filename, original: t.original, importHash, report };
  if (inferred) batch.schema = { hasHeader: inferred.hasHeader, delimiter: inferred.delimiter, confidence: inferred.confidence, columns: inferred.columns.map((c) => ({ index: c.index, field: c.field, score: c.score })) };
  const startRow = batchId ? (await db.letters.where("batchId").equals(batch.id).count()) : 0;
  for (const r of rows) {
    const ext = r.values.external_id;
    const s = sig(r.key, r.values, r.raw);
    const warnings = [...r.warnings];
    if (ext) {
      const g = known.get(ext);
      if (g?.has(s)) {
        report.duplicates.push({ row: r.row, externalId: ext, reason: "mesmo identificador e mesmo conteúdo (carta já importada)" });
        continue;
      }
      if (g) warnings.push(`Identificador ${ext} já existe com conteúdo diferente: carta mantida; confira se é a mesma correspondência.`);
      (g ?? known.set(ext, new Set()).get(ext)!).add(s);
    }
    // linha inválida (ex.: logradouro que é só um número) NÃO é gravada: fica no relatório, com a linha original, para correção
    if (r.errors.length) { report.withErrors.push({ row: r.row, errors: r.errors, raw: r.raw }); continue; }
    letters.push({
      id: uid(), batchId: batch.id, row: startRow + r.row, externalId: ext, recipient: r.values.recipient,
      street: r.values.street, number: r.values.number, complement: r.values.complement,
      neighborhood: r.values.neighborhood, city: r.values.city, cep: r.values.cep, notes: r.values.notes,
      status: "pending", errors: r.errors, warnings, excluded: false, addressKey: r.key, raw: r.raw,
    });
  }
  report.inserted = letters.length;
  if (batchId) {
    batch.report = {
      inserted: batch.report.inserted + report.inserted,
      duplicates: [...batch.report.duplicates, ...report.duplicates],
      withErrors: [...batch.report.withErrors, ...report.withErrors],
      warnings: [...(batch.report.warnings ?? []), ...(report.warnings ?? [])],
    };
    batch.original += "\n" + t.original;
  } else batch.report = report;
  await db.transaction("rw", db.batches, db.letters, async () => {
    await db.batches.put(batch!);
    await db.letters.bulkAdd(letters);
  });
  return batch;
}
