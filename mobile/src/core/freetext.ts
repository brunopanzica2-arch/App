/**
 * FreeTextAddressResolver (parte local, determinística): lê uma linha de endereço em linguagem livre, como um geocodificador,
 * SEM depender de separador, cabeçalho ou ordem fixa. Entende "Rua Joaquim Távora 480", "R. Joaquim Távora, 480, Vila Belmiro",
 * "Praça Visconde de Mauá 11", "Av. Ana Costa 100 apto 3 Gonzaga Santos SP", "Rua 7 de Setembro 120".
 * Cidade/UF ausentes ficam em branco aqui; o padrão Santos/SP é aplicado depois (normalizeAddress) e depois pontuado pelo geocodificador.
 * Nenhum modelo generativo: só regras e listas.
 */
import { BAIRROS, CITIES, UFS } from "./schema";
import { clean, normText, stripAccents } from "./normalize";

export interface FreeAddress {
  street: string | null; number: string | null; complement: string | null; neighborhood: string | null;
  city: string | null; state: string | null; cep: string | null;
  /** 0–1: confiança do PARSE (não da posição) */
  confidence: number; notes: string[];
}

const TYPE_RE = /^(R|RUA|AV|AVE|AVN|AVENIDA|TV|TRV|TRAV|TRAVESSA|PC|PCA|PRACA|AL|ALAMEDA|EST|ESTR|ESTRADA|ROD|RODOVIA|LG|LGO|LARGO|VD|VIADUTO|BC|BECO|LADEIRA|VIELA|CAMINHO|PASSAGEM|PSG|PRACETA|PQ|PARQUE|CANAL|CAIS|CALCADAO)\.?$/;
const COMP_MARK = /^(AP|APT|APTO|APARTAMENTO|BL|BLOCO|CASA|FUNDOS|SALA|CJ|CONJ|CONJUNTO|LOJA|ANDAR|TORRE|SOBRADO|FRENTE|BOX|GARAGEM|KM)\.?$/;
const NUM_MARK = /^(N|NO|NUM|NUMERO|NRO|N\.?O|#)\.?$/;
const MONTHS = new Set("JANEIRO FEVEREIRO MARCO ABRIL MAIO JUNHO JULHO AGOSTO SETEMBRO OUTUBRO NOVEMBRO DEZEMBRO".split(" "));
const NUMTOK = /^\d{1,6}[A-Z]?$/;

const N = (t: string) => normText(t).replace(/\./g, "");

function splitBairro(tokens: string[]): { bairro: string | null; rest: string[] } {
  // maior sequência de tokens que seja um bairro conhecido (ex.: VILA NOVA, PONTA DA PRAIA)
  for (let len = Math.min(4, tokens.length); len >= 1; len--) {
    for (let i = 0; i + len <= tokens.length; i++) {
      const cand = tokens.slice(i, i + len).map(N).join(" ");
      if (BAIRROS.has(cand)) return { bairro: tokens.slice(i, i + len).join(" "), rest: [...tokens.slice(0, i), ...tokens.slice(i + len)] };
    }
  }
  return { bairro: null, rest: tokens };
}

/** Consome marcadores de complemento ("apto 12", "casa 2 fundos") de uma lista de tokens. */
function takeComplement(tokens: string[]): { comp: string | null; rest: string[] } {
  const comp: string[] = [];
  const rest: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    if (COMP_MARK.test(N(tokens[i]))) {
      const part = [tokens[i]];
      const nx = tokens[i + 1];
      if (nx && /^[A-Za-z]?\d{0,4}[A-Za-z]?$/.test(nx) && !COMP_MARK.test(N(nx)) && N(nx) !== "") { part.push(nx); i++; }
      comp.push(part.join(" "));
    } else rest.push(tokens[i]);
  }
  return { comp: comp.join(", ") || null, rest };
}

export function parseFreeAddress(input: string): FreeAddress {
  const notes: string[] = [];
  let s = clean(input).replace(/^\s*\d{1,3}\s*[).\-:]\s+(?=\S)/, ""); // "1) Rua X 10"
  { // número ANTES da rua ("53 Rua João Éboli", "53, Rua João Éboli"): leva o número para depois do nome da rua
    const t = s.split(" ");
    const first = (t[0] ?? "").replace(/,$/, "");
    if (NUMTOK.test(N(first)) && t[1] && TYPE_RE.test(N(t[1]).replace(/\.$/, "")) && t.length > 2) s = [...t.slice(1), first].join(" ");
  }
  const out: FreeAddress = { street: null, number: null, complement: null, neighborhood: null, city: null, state: null, cep: null, confidence: 0, notes };
  const cm = s.match(/\b(\d{5})-?(\d{3})\b/);
  if (cm) { out.cep = `${cm[1]}-${cm[2]}`; s = clean(s.replace(cm[0], " ")); }
  // "Santos/SP", "Santos - SP" (cidade conhecida + UF juntas)
  for (const c of [...CITIES].sort((x, y) => y.length - x.length)) {
    const re = new RegExp(`(?:^|[\\s,;-])(${c.split(" ").join("\\s+")})\\s*[/-]\\s*([A-Za-z]{2})\\b`, "i");
    const m = stripAccents(s).match(re);
    if (m && UFS.has(m[2].toUpperCase())) {
      out.city = c.split(" ").map((w) => w[0] + w.slice(1).toLowerCase()).join(" "); out.state = m[2].toUpperCase();
      s = clean(s.slice(0, m.index!) + " " + s.slice(m.index! + m[0].length))
      break;
    }
  }
  const segs = s.split(/\s*[,;|]\s*|\s+-\s+/).map(clean).filter(Boolean);
  if (!segs.length) return out;

  const tailTokens: string[] = [];
  let numberFromSeg: string | null = null;
  // segmentos depois do primeiro: número, complemento, UF, cidade, bairro
  for (const seg of segs.slice(1)) {
    const t = seg.split(" ");
    const joined = N(seg);
    if (NUM_MARK.test(N(t[0])) && t[1] && NUMTOK.test(N(t[1]))) { numberFromSeg ??= t[1].toUpperCase(); continue; }
    if (NUMTOK.test(joined.replace(/\s/g, "")) && !numberFromSeg && /^\d/.test(joined)) { numberFromSeg = joined.replace(/\s/g, ""); continue; }
    if (/^S\s*\/?\s*N$/.test(joined)) { notes.push("Sem número (S/N)"); continue; }
    tailTokens.push(...t);
  }

  // primeiro segmento: rua [+ número] [+ resto]
  let head = segs[0].split(" ");
  const headNormTokens = head.map(N);
  // ignora marcador "nº" antes do número
  const cleanedHead: string[] = [];
  for (let i = 0; i < head.length; i++) {
    if (NUM_MARK.test(headNormTokens[i]) && head[i + 1] && NUMTOK.test(headNormTokens[i + 1])) continue;
    cleanedHead.push(head[i]);
  }
  head = cleanedHead;

  let numIdx = -1;
  if (!numberFromSeg) {
    // último token numérico (índice ≥ 1) que não faça parte de "7 de Setembro" nem de um complemento ("apto 12")
    for (let i = head.length - 1; i >= 1; i--) {
      const nt = N(head[i]);
      if (!NUMTOK.test(nt)) continue;
      const prev = N(head[i - 1] ?? "");
      if (COMP_MARK.test(prev)) continue;
      if (N(head[i + 1] ?? "") === "DE" && MONTHS.has(N(head[i + 2] ?? ""))) continue;
      numIdx = i;
      break;
    }
  }
  let streetTokens: string[], after: string[];
  if (numberFromSeg) { streetTokens = head; after = []; out.number = numberFromSeg.toUpperCase(); }
  else if (numIdx >= 0) { streetTokens = head.slice(0, numIdx); after = head.slice(numIdx + 1); out.number = N(head[numIdx]); }
  else {
    // sem número: a rua é o que sobrar antes de complemento/bairro/cidade
    streetTokens = head; after = [];
    const nm = head.map(N).findIndex((t, i) => i > 0 && (COMP_MARK.test(t) || CITIES.has(t)));
    if (nm > 0) { streetTokens = head.slice(0, nm); after = head.slice(nm); }
    notes.push("Número não informado");
  }

  const rest = [...after, ...tailTokens];
  const { comp, rest: r1 } = takeComplement(rest);
  out.complement = comp;
  // UF / cidade soltas no fim ("Santos SP", "Santos")
  let r2 = [...r1];
  if (r2.length && UFS.has(N(r2[r2.length - 1])) && r2.length >= 1 && (r2.length === 1 || CITIES.has(N(r2[r2.length - 2])) || CITIES.has(r2.slice(-3, -1).map(N).join(" ")))) {
    if (!out.state) out.state = N(r2[r2.length - 1]); r2 = r2.slice(0, -1);
  }
  for (let len = Math.min(3, r2.length); len >= 1 && !out.city; len--) {
    const tail = r2.slice(-len).map(N).join(" ");
    if (CITIES.has(tail)) { out.city = r2.slice(-len).join(" "); r2 = r2.slice(0, -len); }
  }
  const { bairro, rest: r3 } = splitBairro(r2);
  if (bairro) out.neighborhood = bairro;
  else if (r3.length) { out.neighborhood = r3.join(" "); notes.push(`Bairro inferido do texto: ${out.neighborhood}`); }
  if (bairro && r3.length) out.complement = [out.complement, r3.join(" ")].filter(Boolean).join(", ");

  out.street = streetTokens.join(" ") || null;
  const hasType = streetTokens.length > 1 && TYPE_RE.test(N(streetTokens[0]));
  out.confidence = Math.min(1, 0.35 + (hasType ? 0.25 : 0) + (out.number ? 0.25 : 0) + (bairro ? 0.1 : 0) + (out.cep ? 0.05 : 0));
  if (!hasType && out.street) notes.push("Tipo de logradouro não informado (Rua/Av./Praça…)");
  void stripAccents;
  return out;
}

/* ---------------------------------------------------------------------------------------------------------------
 * Vários endereços colados na MESMA linha ("Rua A 53, Avenida B 78, Rua C 197"; ou separados por ";", "|", "1)" …).
 * Um novo endereço começa numa palavra de tipo de via (Rua, Av., Travessa, Praça…) que vem logo depois de um separador
 * (, ; |) ou de um número (o número da casa anterior). "Rua da Praça 15" não corta (a palavra "Praça" vem depois de "da").
 * --------------------------------------------------------------------------------------------------------------- */
const SPLIT_TYPE = /^(R|RUA|AV|AVE|AVN|AVENIDA|TV|TRV|TRAV|TRAVESSA|PC|PCA|PRACA|AL|ALAMEDA|EST|ESTR|ESTRADA|ROD|RODOVIA|LG|LGO|LARGO|VD|VIADUTO|BC|BECO|LADEIRA|VIELA|CAMINHO|PASSAGEM|PSG|PRACETA)$/;
const NUM_TOKEN = /^\d{1,6}[A-Z]?$/;

export function splitMultiAddress(line: string): string[] {
  const tokens = clean(line).replace(/([,;|])(?=[A-Za-zÀ-ú])/g, "$1 ").split(" ").filter(Boolean); // "184,Avenida" → "184, Avenida"
  if (tokens.length < 4) return [clean(line)];
  const bare = (t: string) => N(t).replace(/[,;|]+$/g, "");
  const isType = (t: string) => SPLIT_TYPE.test(bare(t));
  const CONNECT = new Set(["E", "&", "+", "/", "-", "–", "—"]);
  const marker = (t: string) => /^\d{1,3}[).:]$/.test(t);
  const cuts: { at: number; drop: number }[] = []; // `at` = 1º token do próximo endereço; `drop` = tokens conectores/marcadores a descartar antes dele
  let lastCut = 0;
  for (let i = 1; i < tokens.length - 1; i++) {
    if (!isType(tokens[i])) continue;
    // o trecho anterior precisa ser um endereço de verdade (ter uma palavra de via): "53 Rua X" e "João - Rua X" não cortam
    if (!tokens.slice(lastCut, i).some(isType)) continue;
    const prev = tokens[i - 1];
    const afterSep = /[,;|]$/.test(prev);
    const afterNumber = NUM_TOKEN.test(bare(prev)) && !marker(prev);
    const afterConnector = CONNECT.has(N(prev).replace(/[,;|]+$/g, "")) || /^[-–—/&+]$/.test(prev);
    const afterMarker = marker(prev);
    if (!(afterSep || afterNumber || afterConnector || afterMarker)) continue;
    if (bare(tokens[i]) === "R" && !/^[A-Za-zÀ-ú]{3,}/.test(tokens[i + 1])) continue; // "R" sozinho só vale se a palavra seguinte parece nome
    const drop = afterConnector || afterMarker ? 1 : 0;
    cuts.push({ at: i, drop });
    lastCut = i;
  }
  if (!cuts.length) return [clean(line)];
  const parts: string[] = [];
  let from = 0;
  for (const c of [...cuts, { at: tokens.length, drop: 0 }]) { parts.push(tokens.slice(from, c.at - c.drop).join(" ")); from = c.at; }
  return parts.map((p) => clean(p.replace(/^\d{1,3}[).:]\s+/, "").replace(/[,;|\s]+$/g, ""))).filter(Boolean);
}

/**
 * Formato "Rua X, números: 1, 2, 3" (cabeçalho de rua + números nas linhas seguintes ou na mesma linha) e
 * "Rua X 197, 200" (um número colado e outros depois). Devolve uma linha "Rua X N" por número, NA ORDEM em que foram escritos.
 */
export function expandStreetNumberBlocks(lines: string[]): { lines: string[]; extra: number } {
  const out: string[] = [];
  let street: string | null = null;
  let extra = 0;
  const nums = (t: string) => { const m = t.match(/\d{1,6}[A-Za-z]?(?![\d])/g); return m ?? []; };
  const onlyNumbers = (t: string) => /^[\s\d,;eE.\-–A-Za-z]*$/.test(t) && /\d/.test(t) && !/[A-Za-zÀ-ú]{3,}/.test(t.replace(/\b[eE]\b/g, ""));
  for (const raw of lines) {
    const l = raw.trim();
    if (!l) { out.push(raw); continue; }
    const head = l.match(/^(.*?)[,\s]*\bn[úu]meros?\b\s*[:\-–]?\s*(.*)$/i);
    if (head && /[A-Za-zÀ-ú]{3,}/.test(head[1])) {
      street = head[1].replace(/[,:;\s]+$/g, "").trim();
      const n = nums(head[2]);
      for (const x of n) out.push(`${street} ${x}`);
      extra += Math.max(0, n.length - 1);
      continue;
    }
    if (street && onlyNumbers(l)) {
      const n = nums(l);
      for (const x of n) out.push(`${street} ${x}`);
      extra += Math.max(0, n.length - 1);
      continue;
    }
    street = null; // linha comum: encerra o bloco
    const multi = l.match(/^([A-Za-zÀ-ú][^\d]*?)\s+(\d{1,6}[A-Za-z]?)((?:\s*[,;]\s*\d{1,6}[A-Za-z]?)+)\s*[,;]?$/);
    if (multi && SPLIT_TYPE.test(N(multi[1].trim().split(/\s+/)[0]))) {
      const n = [multi[2], ...nums(multi[3])];
      for (const x of n) out.push(`${multi[1].trim().replace(/[,;]+$/, "")} ${x}`);
      extra += n.length - 1;
      continue;
    }
    out.push(raw);
  }
  return { lines: out, extra };
}

/** Aplica `splitMultiAddress` ao texto inteiro, linha a linha. Não mexe em tabelas (CSV/TSV com cabeçalho de colunas conhecido). */
export function explodeMultiAddressText(raw: string): { text: string; extra: number } {
  const lines = raw.replace(/^﻿/, "").split(/\r\n?|\n/);
  const head = stripAccents(lines.find((l) => l.trim()) ?? "").toLowerCase();
  const looksLikeTable = /(logradouro|endereco|street|numero|bairro|cep)/.test(head) && (head.match(/[;\t|]/g) ?? []).length >= 2;
  if (looksLikeTable) return { text: raw, extra: 0 };
  const blocks = expandStreetNumberBlocks(lines);
  let extra = blocks.extra;
  const out = blocks.lines.flatMap((l) => { const p = splitMultiAddress(l); extra += p.length - 1; return p; });
  return extra > 0 ? { text: out.join("\n"), extra } : { text: raw, extra: 0 };
}
