/**
 * Base offline de endereços COM NÚMERO: CNEFE do IBGE (Censo 2022) de Santos, compactada em `santos-enderecos.bin` (formato RSA1,
 * ver backend/scripts/export_cnefe.py). Resolve o número sem internet, sem cota e sem depender do OpenStreetMap (que quase não tem números).
 * Honestidade: o ponto do CNEFE é "para fins estatísticos" — nível 1 = ponto do endereço, nível 2 = face da quadra, nunca a porta confirmada.
 */
import { estimateByNumber } from "./anchors";
import { splitStreet } from "./normalize";

export const STOP = new Set(["DE", "DA", "DO", "DAS", "DOS", "E"]);
/** títulos que o usuário costuma omitir/acrescentar ("Rua Pastor X" × "Rua X"): só entram no casamento RELAXADO */
const TITLES = new Set(["DOUTOR", "DOUTORA", "PROFESSOR", "PROFESSORA", "CAPITAO", "CORONEL", "GENERAL", "COMANDANTE", "ENGENHEIRO", "PASTOR", "PADRE", "VEREADOR", "CONSELHEIRO", "ALMIRANTE", "MARECHAL", "PRESIDENTE", "BARAO", "VISCONDE", "MONSENHOR", "SENADOR", "DEPUTADO", "TENENTE", "SARGENTO", "MAJOR", "COMENDADOR", "DESEMBARGADOR", "MINISTRO", "SANTO", "SANTA", "SAO"]);

const UNITS = ["zero", "um", "dois", "tres", "quatro", "cinco", "seis", "sete", "oito", "nove", "dez", "onze", "doze", "treze", "quatorze", "quinze", "dezesseis", "dezessete", "dezoito", "dezenove"];
const TENS: Record<number, string> = { 20: "vinte", 30: "trinta", 40: "quarenta", 50: "cinquenta", 60: "sessenta", 70: "setenta", 80: "oitenta", 90: "noventa" };
export function num2wordsPt(n: number): string {
  if (n < 20) return UNITS[n];
  if (n < 100) { const t = Math.floor(n / 10) * 10, u = n % 10; return u === 0 ? TENS[t] : `${TENS[t]} e ${UNITS[u]}`; }
  return String(n);
}
const strip = (s: string) => s.normalize("NFKD").replace(/[̀-ͯ]/g, "");
/** Mesma regra do exportador Python: MAIÚSCULAS sem acento; dígitos 1..99 viram palavras ("7 de Setembro" = "Sete de Setembro"). */
export function keyOf(text: string): string {
  const toks = strip(text ?? "").toUpperCase().replace(/[^A-Z0-9 ]/g, " ").split(/\s+/).filter(Boolean);
  const out: string[] = [];
  for (const t of toks) {
    if (/^\d+$/.test(t) && +t >= 1 && +t <= 99) out.push(...num2wordsPt(+t).toUpperCase().split(" "));
    else out.push(t);
  }
  return out.join(" ");
}
/** Grafia equivalente (Luiz/Luis, Anna/Ana, Glycerio/Glicerio, Arthur/Artur, Adolpho/Adolfo, Victorino/Vitorino): só para COMPARAR nomes. */
export function phon(t: string): string {
  if (/\d/.test(t) || /^[IVXLCDM]+$/.test(t)) return t; // números e algarismos romanos (Dom Pedro I ≠ Dom Pedro II) não são alterados
  return t.replace(/PH/g, "F").replace(/TH/g, "T").replace(/CT/g, "T").replace(/Y/g, "I").replace(/W/g, "V").replace(/K/g, "C").replace(/Z/g, "S").replace(/(.)\1+/g, "$1");
}
const coreTokens = (s: string) => keyOf(s).split(" ").filter((t) => t && !STOP.has(t)).map(phon);
const TITLES_P = new Set([...TITLES].map(phon));
const isTitle = (t: string) => TITLES_P.has(t);

export interface CnefeStreet { k: string; t: string; n: string; core: string[] }
export interface CnefeDb {
  start: Uint32Array; num: Uint32Array; lat: Int32Array; lon: Int32Array; loc: Uint16Array; suf: Uint8Array; lc: Uint8Array;
  streets: CnefeStreet[]; localities: string[]; byToken: Map<string, number[]>; vocab: string[];
  meta: { fonte: string; url: string; registros: number; logradouros: number; aviso: string; municipio: string };
}

export function parseCnefe(buf: ArrayBuffer): CnefeDb {
  const dv = new DataView(buf);
  if (new TextDecoder().decode(new Uint8Array(buf, 0, 4)) !== "RSA1") throw new Error("Base de endereços inválida");
  const nS = dv.getUint32(4, true), nR = dv.getUint32(8, true), nL = dv.getUint32(12, true), jl = dv.getUint32(16, true);
  let o = 20;
  const start = new Uint32Array(buf.slice(o, o + (nS + 1) * 4)); o += (nS + 1) * 4;
  const num = new Uint32Array(buf.slice(o, o + nR * 4)); o += nR * 4;
  const lat = new Int32Array(buf.slice(o, o + nR * 4)); o += nR * 4;
  const lon = new Int32Array(buf.slice(o, o + nR * 4)); o += nR * 4;
  const loc = new Uint16Array(buf.slice(o, o + nR * 2)); o += nR * 2;
  const suf = new Uint8Array(buf.slice(o, o + nR)); o += nR;
  const lc = new Uint8Array(buf.slice(o, o + nR)); o += nR;
  const meta = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, o, jl)));
  const streets: CnefeStreet[] = meta.streets.map((s: { k: string; t: string; n: string }) => ({ ...s, core: coreTokens(s.n) }));
  const byToken = new Map<string, number[]>();
  streets.forEach((s, i) => { for (const t of new Set(s.core)) (byToken.get(t) ?? byToken.set(t, []).get(t)!).push(i); });
  void nL;
  return { start, num, lat, lon, loc, suf, lc, streets, localities: meta.loc, byToken, vocab: [...byToken.keys()], meta };
}

export type CnefeKind = "exact" | "face" | "estimated" | "street" | "ambiguous" | "none";
export interface CnefeCand { street: string; type: string; locality: string | null; lat: number; lon: number; level: number; units: number; exactNumber: boolean }
export interface CnefeResult {
  kind: CnefeKind;
  lat?: number; lon?: number;
  /** nome oficial do logradouro no IBGE (ex.: "Avenida Conselheiro Nebias") */
  street?: string;
  locality?: string | null;
  level?: number;
  between?: [number, number];
  /** o nome digitado não era idêntico ao do IBGE (faltava/sobrava título): o usuário deve conferir */
  nameAdjusted?: boolean;
  candidates: CnefeCand[];
  reason: string;
}

const lev1 = (a: string, b: string) => { // distância de edição ≤ 1
  if (a === b) return true;
  if (Math.abs(a.length - b.length) > 1) return false;
  let i = 0, j = 0, d = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { i++; j++; continue; }
    if (++d > 1) return false;
    if (a.length > b.length) i++; else if (a.length < b.length) j++; else { i++; j++; }
  }
  return d + (a.length - i) + (b.length - j) <= 1;
};

/** Todos os registros (um por bairro) de um logradouro com o número pedido; o sufixo exato vale mais ("480A"), senão o número base. */
function findAll(db: CnefeDb, s: number, n: number, suf: number): number[] {
  let lo = db.start[s], hi = db.start[s + 1] - 1, first = -1;
  while (lo <= hi) { const m = (lo + hi) >> 1; if (db.num[m] < n) lo = m + 1; else if (db.num[m] > n) hi = m - 1; else { first = m; hi = m - 1; } }
  if (first < 0) return [];
  const all: number[] = [];
  for (let i = first; i < db.start[s + 1] && db.num[i] === n; i++) all.push(i);
  const same = all.filter((i) => db.suf[i] === suf);
  if (same.length) return same;
  const base = all.filter((i) => db.suf[i] === 0);
  return base.length ? base : all;
}

const lvlOf = (db: CnefeDb, i: number) => db.lc[i] >> 6;
const unitsOf = (db: CnefeDb, i: number) => db.lc[i] & 63;
const prettyName = (db: CnefeDb, s: number) => { const st = db.streets[s]; return `${st.t[0] ?? ""}${st.t.slice(1).toLowerCase()} ${st.n.toLowerCase().replace(/(^|\s)(\S)/g, (_m, a, b) => a + b.toUpperCase())}`.replace(/\s(De|Da|Do|Das|Dos|E)\s/g, (m) => m.toLowerCase()); };

function candOf(db: CnefeDb, s: number, i: number, exact: boolean): CnefeCand {
  return { street: prettyName(db, s), type: db.streets[s].t, locality: db.localities[db.loc[i]] ?? null, lat: db.lat[i] / 1e6, lon: db.lon[i] / 1e6, level: lvlOf(db, i), units: unitsOf(db, i), exactNumber: exact };
}

export interface StreetMatch { s: number; extra: number; typeOk: boolean; relaxed: boolean; /** só sobram TÍTULOS (Doutor, Coronel…) em relação ao digitado: seguro como alternativa */ safe: boolean; /** o nome oficial não é igual ao digitado (título a mais/a menos) */ adj: boolean }

/** Logradouros do IBGE que casam com o nome digitado, do melhor para o pior. `relaxed` = faltou 1 palavra (típico: título "Pastor"). */
export function matchStreets(db: CnefeDb, streetText: string): StreetMatch[] {
  let fuzzy = false;
  const [userType, name] = splitStreet(streetText);
  let toks = coreTokens(name);
  if (!toks.length) return [];
  // corrige 1 letra trocada/faltando em palavras de ≥ 5 letras que não existem na base (ex.: "Nebas" → "NEBIAS"); só se houver UMA candidata
  toks = toks.map((t) => {
    if (db.byToken.has(t) || t.length < 5) return t;
    const near = db.vocab.filter((v) => lev1(t, v));
    if (near.length === 1) { fuzzy = true; return near[0]; }
    return t;
  });
  const uset = new Set(toks);
  const uT = toks.filter((t) => !isTitle(t));
  const mk = (s: number, relaxed: boolean): StreetMatch => {
    const core = db.streets[s].core;
    const extraNon = core.filter((t) => !uset.has(t) && !isTitle(t)).length;
    return {
      s, extra: Math.max(0, core.length - toks.length), relaxed: relaxed || fuzzy, // nome corrigido por semelhança = nunca aceito sozinho
      typeOk: !userType || strip(db.streets[s].t).toUpperCase() === userType,
      safe: extraNon === 0, adj: relaxed || core.length !== uset.size || core.some((t) => !uset.has(t)),
    };
  };
  const inter = (ts: string[]) => { const ss = ts.map((t) => db.byToken.get(t)); if (!ts.length || !ss.every(Boolean)) return [] as number[]; let ids = ss[0]!.slice(); for (const st of ss.slice(1)) { const set = new Set(st); ids = ids.filter((x) => set.has(x)); } return ids; };
  const seen = new Set<number>();
  let out: StreetMatch[] = [];
  for (const s of inter(toks)) { seen.add(s); out.push(mk(s, false)); }                     // todas as palavras digitadas estão na rua do IBGE
  if (uT.length && uT.length < toks.length || (uT.length === toks.length && !out.length)) { // título a mais no digitado ("Doutor Carvalho de Mendonça" × "Carvalho de Mendonça")
    for (const s of inter(uT)) {
      if (seen.has(s)) continue;
      const nt = db.streets[s].core.filter((t) => !isTitle(t));
      // só com o MESMO tipo de via: "Rua Pastor Narciso de Andrade" ≠ "Praça Narciso de Andrade"
      if (nt.length === uT.length && (!userType || strip(db.streets[s].t).toUpperCase() === userType)) { seen.add(s); out.push(mk(s, false)); }
    }
  }
  if (!out.length && toks.length >= 3) { // relaxado: ignora UMA palavra que a base não tem naquela rua (ex.: "Pastor")
    for (let drop = 0; drop < toks.length; drop++) {
      const rest = toks.filter((_, i) => i !== drop);
      for (const s of inter(rest)) if (!seen.has(s)) { seen.add(s); out.push(mk(s, true)); }
    }
  }
  return out.sort((a, b) => Number(a.relaxed) - Number(b.relaxed) || Number(!a.typeOk) - Number(!b.typeOk) || a.extra - b.extra || Number(a.adj) - Number(b.adj)
    || (db.start[b.s + 1] - db.start[b.s]) - (db.start[a.s + 1] - db.start[a.s]));
}

const parseNum = (n: string | null | undefined): { n: number; suf: number } | null => {
  const m = /^\s*(\d{1,6})\s*([A-Za-z]?)\b/.exec(n ?? "");
  return m ? { n: parseInt(m[1], 10), suf: m[2] ? m[2].toUpperCase().charCodeAt(0) - 64 : 0 } : null;
};

/** Consulta principal. `neighborhood` (se houver) desempata ruas homônimas. */
export function lookupCnefe(db: CnefeDb, q: { street: string; number: string | null; neighborhood?: string | null }): CnefeResult {
  const ms = matchStreets(db, q.street);
  if (!ms.length) return { kind: "none", candidates: [], reason: "Logradouro não encontrado na base do IBGE." };
  const want = parseNum(q.number);
  const nb = q.neighborhood ? keyOf(q.neighborhood) : "";
  const best = ms[0];
  // grupos de ruas igualmente boas (mesmo tipo, mesmas palavras sobrando). Se o melhor grupo NÃO tem o número, tenta os seguintes
  // somente se só sobram TÍTULOS ("Rua Oswaldo Cruz" × "Rua Doutor Oswaldo Cruz"); nunca outra rua de nome parecido.
  const groups: StreetMatch[][] = [];
  for (const m of ms) { const g = groups[groups.length - 1]; if (g && g[0].relaxed === m.relaxed && g[0].typeOk === m.typeOk && g[0].extra === m.extra) g.push(m); else groups.push([m]); }
  let pool = groups[0];
  let hits: { m: StreetMatch; i: number }[] = [];
  if (want) for (const [gi, g] of groups.entries()) {
    if (gi > 0 && !g.every((m) => m.safe && !m.relaxed)) break;
    const h = g.flatMap((m) => findAll(db, m.s, want.n, want.suf).map((i) => ({ m, i })));
    if (h.length) { pool = g; hits = h; break; }
  }
  const cands = hits.slice(0, 4).map((h) => candOf(db, h.m.s, h.i, true));
  const adjusted = (m: StreetMatch) => m.adj;
  if (hits.length) {
    // pontos do MESMO número a menos de 100 m um do outro são o mesmo lugar (apartamentos/duplicatas); a mais que isso = ruas/bairros homônimos
    const km = (a: number, b: number) => { const dla = (db.lat[a] - db.lat[b]) / 1e6 * 111_195, dlo = (db.lon[a] - db.lon[b]) / 1e6 * 111_195 * Math.cos(-23.96 * Math.PI / 180); return Math.hypot(dla, dlo); };
    const distinct: typeof hits = [];
    for (const h of hits) if (!distinct.some((d) => km(d.i, h.i) < 100)) distinct.push(h);
    let pick = distinct[0];
    if (distinct.length > 1) {
      const byLoc = nb ? distinct.filter((h) => { const l = keyOf(db.localities[db.loc[h.i]] ?? ""); return l === nb || l.replace("MATHIAS", "MATIAS") === nb.replace("MATHIAS", "MATIAS"); }) : [];
      if (byLoc.length === 1) pick = byLoc[0];
      else {
        const cs = distinct.slice(0, 4).map((h) => candOf(db, h.m.s, h.i, true));
        return { kind: "ambiguous", candidates: cs, street: cs[0].street, reason: `O nº ${q.number} existe em mais de um lugar com esse nome de rua: ${cs.map((c) => `${c.street} (${c.locality ?? "?"})`).join("; ")}. Informe o bairro ou confirme no mapa.` };
      }
    }
    const lv = lvlOf(db, pick.i);
    const c = candOf(db, pick.m.s, pick.i, true);
    const kind: CnefeKind = lv === 1 ? "exact" : "face";
    const adj = adjusted(pick.m);
    return {
      kind: pick.m.relaxed ? "ambiguous" : kind, ...(pick.m.relaxed ? {} : { lat: c.lat, lon: c.lon }), street: c.street, locality: c.locality, level: lv, nameAdjusted: adj, candidates: cands.length ? [c, ...cands.filter((x) => x.lat !== c.lat || x.lon !== c.lon)].slice(0, 4) : [c],
      reason: pick.m.relaxed
        ? `O nome digitado não bate exatamente com nenhum logradouro; o IBGE tem "${c.street}" com o nº ${q.number}. Confirme se é essa rua.`
        : `IBGE (Censo 2022): ${c.street}, ${q.number}${c.locality ? ` — ${c.locality}` : ""}; ${lv === 1 ? "ponto do endereço" : "posição na face da quadra (aproximada)"}${adj ? `. Atenção: o nome oficial é "${c.street}".` : "."}`,
    };
  }
  // número não existe na base: estima entre vizinhos da MESMA rua (o IBGE tem muitos pontos por rua)
  if (want && !best.relaxed) {
    const a = db.start[best.s], b = db.start[best.s + 1];
    let near = -1;
    for (let i = a; i < b; i++) if (lvlOf(db, i) <= 2 && (near < 0 || Math.abs(db.num[i] - want.n) < Math.abs(db.num[near] - want.n))) near = i;
    const anchors: { number: number; lat: number; lon: number }[] = [];
    if (near >= 0) for (let i = a; i < b; i++) if (db.loc[i] === db.loc[near] && Math.abs(db.num[i] - want.n) <= 80 && lvlOf(db, i) <= 2) anchors.push({ number: db.num[i], lat: db.lat[i] / 1e6, lon: db.lon[i] / 1e6 });
    const e = estimateByNumber(want.n, anchors, { maxSpanM: 350, maxNumberGap: 120 });
    if (e) return {
      kind: "estimated", lat: e.lat, lon: e.lon, street: prettyName(db, best.s), between: e.between, nameAdjusted: adjusted(best), candidates: [],
      reason: `IBGE: o nº ${q.number} não consta; posição ESTIMADA entre os nºs ${e.between[0]} e ${e.between[1]} (${e.spanM} m).`,
    };
    const mid = db.num.slice(a, b);
    return { kind: "street", street: prettyName(db, best.s), nameAdjusted: adjusted(best), candidates: [], reason: `IBGE: a rua existe (${prettyName(db, best.s)}), mas o nº ${q.number} não consta${mid.length ? ` (números de ${mid[0]} a ${mid[mid.length - 1]})` : ""}.` };
  }
  if (best.relaxed) return { kind: "street", street: prettyName(db, best.s), nameAdjusted: true, candidates: [], reason: `Nome parecido no IBGE: "${prettyName(db, best.s)}"; sem o nº ${q.number ?? "?"} nessa rua.` };
  return { kind: "street", street: prettyName(db, best.s), nameAdjusted: adjusted(best), candidates: [], reason: "IBGE: rua encontrada, mas o endereço não informa número." };
}
