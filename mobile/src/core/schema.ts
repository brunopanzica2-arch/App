/**
 * Inferência de esquema de importação (Rota Santos 2.0): descobre delimitador, presença de cabeçalho e o CAMPO de cada
 * coluna pelo CONTEÚDO (rua, número, CEP, UF, município, bairro, complemento, destinatário, identificador), não pela posição.
 * Nunca descarta linha; devolve confiança e avisos para a prévia. Toda a lógica é local e determinística.
 */
import { csvRecords, detectDelimiter } from "./importer";
import { clean, normText, stripAccents } from "./normalize";

export type FieldId = "external_id" | "recipient" | "street" | "number" | "complement" | "neighborhood" | "city" | "state" | "cep" | "notes" | "full_address";

export const FIELD_LABEL: Record<FieldId, string> = {
  external_id: "Identificador", recipient: "Destinatário", street: "Logradouro", number: "Número", complement: "Complemento",
  neighborhood: "Bairro", city: "Município", state: "UF", cep: "CEP", notes: "Observações", full_address: "Endereço completo",
};

const UFS = new Set("AC AL AP AM BA CE DF ES GO MA MT MS MG PA PB PR PE PI RJ RN RS RO RR SC SP SE TO".split(" "));
const CITIES = new Set(["SANTOS", "SAO VICENTE", "GUARUJA", "CUBATAO", "PRAIA GRANDE", "BERTIOGA", "SAO PAULO", "SANTO ANDRE", "SAO BERNARDO DO CAMPO",
  "CAMPINAS", "MONGAGUA", "ITANHAEM", "PERUIBE", "SAO CAETANO DO SUL", "OSASCO", "GUARULHOS", "SOROCABA", "RIO DE JANEIRO"]);
/** Bairros de Santos (uso só para DESEMPATAR coluna de bairro × destinatário; não valida o endereço). */
const BAIRROS = new Set(["CENTRO", "VILA NOVA", "PAQUETA", "GONZAGA", "BOQUEIRAO", "EMBARE", "APARECIDA", "PONTA DA PRAIA", "CAMPO GRANDE", "MACUCO",
  "VILA MATHIAS", "VILA BELMIRO", "JOSE MENINO", "MARAPE", "ESTUARIO", "ENCRUZILHADA", "VALONGO", "SABOO", "ALEMOA", "CHICO DE PAULA", "AREIA BRANCA",
  "BOM RETIRO", "CASTELO", "JABAQUARA", "MORRO DA NOVA CINTRA", "MONTE SERRAT", "PENHA", "SAO BENTO", "VILA CASCATINHA", "CAMPO GRANDE", "RADIO CLUB",
  "PORTO", "CATIOCA", "FERRAZOPOLIS", "SAO MANOEL", "NOVA CINTRA", "VILA SAO JORGE", "CAIS DO PORTO"]);
const STREET_PREFIX = /^(R|RUA|AV|AVE|AVN|AVENIDA|TV|TRV|TRAV|TRAVESSA|PC|PCA|PRACA|AL|ALAMEDA|EST|ESTR|ESTRADA|ROD|RODOVIA|LG|LGO|LARGO|VD|VIADUTO|BC|BECO|LADEIRA|VIELA|CAMINHO|PASSAGEM|PSG|PRACETA|PQ|PARQUE|CANAL|CAIS)\b\.?\s+\S/i;
const COMPLEMENT = /^(AP|APT|APTO|APARTAMENTO|BL|BLOCO|CASA|FUNDOS|SALA|CJ|CONJ|LOJA|ANDAR|TORRE|SOBRADO|FRENTE)\b/i;
const NUMBER = /^(\d{1,6}\s*[A-Za-z]?|\d+\.0|S\s*\/?\s*N|SN)$/i;
const CEP = /^\d{5}-?\d{3}$/;

const SYN: Record<FieldId, string[]> = {
  external_id: ["id", "identificador", "codigo", "cod", "objeto", "registro", "rastreio", "n objeto", "codigo de rastreio", "carta", "numero do objeto"],
  recipient: ["destinatario", "nome", "cliente", "recebedor", "morador"],
  street: ["logradouro", "rua", "via", "endereco", "end", "nome da rua", "avenida"],
  number: ["numero", "num", "n", "nº", "no", "n°", "numero da casa", "numero do imovel"],
  complement: ["complemento", "compl", "apto", "apartamento", "bloco"],
  neighborhood: ["bairro"],
  city: ["municipio", "cidade", "localidade"],
  state: ["uf", "estado"],
  cep: ["cep", "codigo postal"],
  notes: ["observacoes", "observacao", "obs", "nota", "notas"],
  full_address: ["endereco completo", "endereco completo"],
};
const headerField = (h: string): FieldId | null => {
  const n = normText(h).toLowerCase().replace(/_/g, " ");
  for (const f of Object.keys(SYN) as FieldId[]) if (n === f || SYN[f].includes(n)) return f;
  return null;
};

export interface ColumnGuess { index: number; field: FieldId | null; score: number; sample: string }
export interface Inferred {
  delimiter: string | null;
  hasHeader: boolean;
  headers: string[];
  rows: string[][];
  columns: ColumnGuess[];
  /** campo → índice da coluna */
  mapping: Partial<Record<FieldId, number>>;
  confidence: number;
  warnings: string[];
  /** true quando há uma única coluna de texto livre ("Rua X, 118 - Centro") */
  freeText: boolean;
}

const frac = (cells: string[], f: (s: string) => boolean) => (cells.length ? cells.filter(f).length / cells.length : 0);

function classify(cells: string[], idx: number, n: number): Partial<Record<FieldId, number>> {
  const c = cells.map(clean).filter(Boolean);
  if (!c.length) return {};
  const uniq = new Set(c).size / c.length;
  const words = c.reduce((a, s) => a + s.split(" ").length, 0) / c.length;
  const norm = (s: string) => normText(s);
  const s: Partial<Record<FieldId, number>> = {};
  s.cep = frac(c, (x) => CEP.test(x));
  s.state = frac(c, (x) => UFS.has(x.toUpperCase()) && x.length === 2);
  s.number = frac(c, (x) => NUMBER.test(x)) * (frac(c, (x) => /\d/.test(x)) > 0.5 || frac(c, (x) => /^S\s*\/?\s*N$|^SN$/i.test(x)) > 0.5 ? 1 : 0.4);
  s.street = Math.max(frac(c, (x) => STREET_PREFIX.test(stripAccents(x))), 0);
  s.city = frac(c, (x) => CITIES.has(norm(x)) || /\/\s*[A-Za-z]{2}$/.test(x));
  s.complement = frac(c, (x) => COMPLEMENT.test(stripAccents(x)));
  s.neighborhood = frac(c, (x) => BAIRROS.has(norm(x)));
  // identificador: quase todo único, sem espaços, com algum dígito, e não parece número de casa/CEP
  s.external_id = uniq >= 0.95 && n >= 3 ? frac(c, (x) => /^[A-Za-z0-9._-]{3,32}$/.test(x) && /\d/.test(x) && !CEP.test(x) && !NUMBER.test(x)) : 0;
  const personLike = frac(c, (x) => /^[A-Za-zÀ-ÿ'.-]+( [A-Za-zÀ-ÿ'.-]+)+$/.test(x) && !STREET_PREFIX.test(stripAccents(x)) && !BAIRROS.has(norm(x)) && !CITIES.has(norm(x)));
  s.recipient = words >= 2 ? personLike * (uniq > 0.3 || n < 5 ? 1 : 0.5) : 0;
  s.full_address = frac(c, (x) => STREET_PREFIX.test(stripAccents(x)) && /,\s*\d+/.test(x));
  void idx;
  return s;
}

/** Infere tudo a partir do TEXTO bruto (colado ou lido de arquivo). */
export function inferSchema(raw: string, forced?: { delimiter?: string | null; hasHeader?: boolean }): Inferred {
  const text = raw.replace(/^﻿/, "");
  const warnings: string[] = [];
  if (!text.trim()) throw new Error("Conteúdo vazio.");
  // 1) delimitador: primeiro os não ambíguos (;, TAB, |); a vírgula só vale se TODOS os registros têm o mesmo nº de campos (>= 3)
  let delimiter: string | null = forced?.delimiter !== undefined ? forced.delimiter : null;
  if (forced?.delimiter === undefined) {
    delimiter = detectDelimiter(text, false);
    if (!delimiter) {
      const recs = csvRecords(text.slice(0, 100000), ",").slice(0, 50);
      const w = recs.map((r) => r.length);
      if (recs.length >= 2 && w[0] >= 3 && w.every((x) => x === w[0])) delimiter = ",";
      else if (recs.length === 1 && w[0] >= 4 && !STREET_PREFIX.test(stripAccents(recs[0][0] ?? ""))) delimiter = ",";
    }
  }
  let rows = delimiter ? csvRecords(text, delimiter) : text.split(/\r\n?|\n/).map(clean).filter(Boolean).map((l) => [l]);
  // vírgula só separa colunas se alguma coluna é um NÚMERO puro em ≥ 70 % das linhas; senão é endereço em texto livre
  // ("Rua X, 118 - Centro, Santos/SP" tem a mesma contagem de vírgulas em todas as linhas, mas não é uma tabela)
  if (delimiter === "," && forced?.delimiter === undefined) {
    const w = Math.max(...rows.map((r) => r.length));
    const numberCols = Array.from({ length: w }, (_, c) => rows.filter((r) => NUMBER.test(clean(r[c] ?? "")) && /\d|S\s*\/?\s*N|SN/i.test(r[c] ?? "")).length / rows.length);
    if (Math.max(...numberCols) < 0.7) {
      delimiter = null;
      rows = text.split(/\r\n?|\n/).map(clean).filter(Boolean).map((l) => [l]);
    }
  }
  return inferRows(rows, delimiter, forced?.hasHeader, warnings);
}

/** Infere o esquema a partir de linhas já separadas (CSV, TSV, XLSX, colagem de tabela). */
export function inferRows(rows0: string[][], delimiter: string | null, forcedHeader?: boolean, warnings: string[] = []): Inferred {
  let rows = rows0.map((r) => r.map((c) => clean(c))).filter((r) => r.some((c) => c));
  if (!rows.length) throw new Error("Conteúdo vazio.");
  const width = Math.max(...rows.map((r) => r.length));
  rows = rows.map((r) => (r.length < width ? [...r, ...Array(width - r.length).fill("")] : r));

  // 2) cabeçalho: ≥ 2 sinônimos conhecidos na 1ª linha (ou 1 sinônimo cobrindo ≥ 40 % das colunas) e nenhuma célula com cara de dado
  const first = rows[0].map(clean);
  const hits = first.map(headerField);
  const nHits = hits.filter(Boolean).length;
  const looksData = first.some((x) => STREET_PREFIX.test(stripAccents(x)) || CEP.test(x) || (NUMBER.test(x) && /\d/.test(x)) || BAIRROS.has(normText(x)));
  let hasHeader = forcedHeader ?? ((nHits >= 2 || (nHits >= 1 && nHits / width >= 0.4)) && !looksData);
  if (width === 1 && forcedHeader === undefined) hasHeader = nHits === 1 && rows.length > 1 && !looksData;
  const seenH = new Map<string, number>();
  const headers = (hasHeader ? first.map((h, i) => h || `coluna_${i + 1}`) : first.map((_, i) => `coluna_${i + 1}`)).map((h) => {
    const n = (seenH.get(h) ?? 0) + 1;
    seenH.set(h, n);
    return n > 1 ? `${h}_${n}` : h;
  });
  const data = hasHeader ? rows.slice(1) : rows;

  // 3) campo de cada coluna: cabeçalho reconhecido manda; senão, o CONTEÚDO
  const sample = data.slice(0, 200);
  const cols: ColumnGuess[] = headers.map((_, i) => ({ index: i, field: null, score: 0, sample: sample.slice(0, 3).map((r) => clean(r[i])).filter(Boolean).join(" | ") }));
  const taken = new Set<FieldId>();
  const mapping: Partial<Record<FieldId, number>> = {};
  const assign = (i: number, f: FieldId, score: number) => { cols[i].field = f; cols[i].score = score; mapping[f] = i; taken.add(f); };

  if (hasHeader) {
    hits.forEach((f, i) => { if (f && !taken.has(f)) assign(i, f, 1); });
  }
  const profile = headers.map((_, i) => classify(sample.map((r) => r[i] ?? ""), i, sample.length));
  const free = () => cols.filter((c) => !c.field);
  const best = (f: FieldId, min: number) => {
    if (taken.has(f)) return;
    let bi = -1, bs = 0;
    for (const c of free()) { const sc = profile[c.index][f] ?? 0; if (sc > bs) { bs = sc; bi = c.index; } }
    if (bi >= 0 && bs >= min) assign(bi, f, bs);
  };
  // coluna única = endereço em texto livre ("Rua X, 118 - Centro"): o analisador de endereço separa os campos
  if (width === 1 && !taken.size) assign(0, "full_address", 0.8);
  // ordem: campos de padrão forte primeiro, texto livre por último
  best("cep", 0.8); best("state", 0.8); best("city", 0.6); best("street", 0.6); best("number", 0.7);
  best("complement", 0.5); best("neighborhood", 0.6);
  // coluna única de endereço completo ("Rua X, 118 - Centro")
  if (!taken.has("street") && !taken.has("full_address")) best("full_address", 0.5);
  // identificador: só com forte unicidade (nunca coluna repetida como número, UF, bairro…)
  best("external_id", 0.9);
  // rua sem prefixo de tipo ("Itororó"): coluna de texto livre imediatamente ANTES da coluna de número
  if (!taken.has("street") && !taken.has("full_address") && mapping.number !== undefined) {
    const cand = cols[mapping.number - 1];
    if (cand && !cand.field && width > 1) assign(cand.index, "street", 0.5);
  }
  // restantes de texto: bairro (pouca variedade, 1 palavra) × destinatário (nome de pessoa)
  for (const c of free()) {
    const col = sample.map((r) => clean(r[c.index])).filter(Boolean);
    if (!col.length) continue;
    const p = profile[c.index];
    if (!taken.has("recipient") && (p.recipient ?? 0) >= 0.7) assign(c.index, "recipient", p.recipient!);
    else if (!taken.has("neighborhood") && new Set(col).size / col.length <= 0.5 || (!taken.has("neighborhood") && col.every((x) => x.split(" ").length <= 3 && !/\d/.test(x)))) assign(c.index, "neighborhood", 0.5);
    else if (!taken.has("notes")) assign(c.index, "notes", 0.3);
  }
  const freeText = width === 1;
  if (freeText && !taken.has("full_address") && !taken.has("street")) assign(0, "full_address", 0.4);

  // 4) confiança + avisos
  const need = freeText ? [mapping.full_address ?? mapping.street] : [mapping.street ?? mapping.full_address, mapping.number];
  let conf = 1;
  if (need[0] === undefined) { conf = 0.1; warnings.push("Não encontrei a coluna de logradouro (rua/avenida).") }
  else if (!freeText && mapping.number === undefined && mapping.full_address === undefined) { conf = Math.min(conf, 0.5); warnings.push("Não encontrei a coluna de número; os endereços ficarão sem número."); }
  for (const c of cols) if (c.field && c.score < 0.6) conf = Math.min(conf, 0.3 + c.score / 2);
  if (!hasHeader && width > 1) conf = Math.min(conf, 0.9);
  const unmapped = cols.filter((c) => !c.field && c.sample);
  if (unmapped.length) warnings.push(`Coluna(s) sem uso: ${unmapped.map((c) => `${c.index + 1} ("${c.sample.slice(0, 20)}")`).join(", ")}.`);
  return { delimiter, hasHeader, headers, rows: data, columns: cols, mapping, confidence: Math.round(conf * 100) / 100, warnings, freeText };
}
