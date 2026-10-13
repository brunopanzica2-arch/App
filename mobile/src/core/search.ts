/**
 * SearchService — busca universal de endereços (estilo "caixa de busca do mapa"), separada de "Minhas entregas".
 *  - Offline: índice de nomes de ruas da malha (autocomplete instantâneo, tolerante a acento/caixa/abreviação).
 *  - Online: provedor de geocodificação (só ao confirmar a busca quando o provedor é o Nominatim público: política de uso
 *    proíbe autocomplete; com provedor próprio/configurado pode ser usado a cada digitação, com debounce).
 *  - Escopo: Santos/SP. Homônimos de outros municípios nunca viram o 1º resultado; proximidade só desempata.
 *  - Honestidade: resultado sem número confirmado NUNCA é marcado como "exato"; o número pedido é preservado.
 */
import type { Candidate } from "./db";
import type { Graph } from "./graph";
import { parseFreeAddress } from "./freetext";
import { clean, normText, prettyKeep, splitStreet } from "./normalize";
import { haversine, inSantosBox } from "./rank";

export type HitPrecision = "street" | "exact" | "interpolated" | "neighborhood";
export interface AddressHit {
  id: string;
  /** texto para exibir (com acento) */
  title: string;
  subtitle: string;
  lat: number;
  lon: number;
  precision: HitPrecision;
  /** número digitado pelo usuário (preservado, nunca vira S/N) */
  numberAsked: string | null;
  /** true só se o provedor devolveu exatamente esse número */
  numberConfirmed: boolean;
  /** frase honesta sobre a posição */
  note: string;
  source: "malha" | "provedor";
  score: number;
}

export interface StreetEntry { name: string; norm: string; tokens: string[]; lat: number; lon: number; edges: number; type: string | null; core: string }

const STOP = new Set(["DE", "DA", "DO", "DAS", "DOS", "E"]);

/** Índice de ruas nomeadas da malha. O ponto representativo é o meio da aresta mediana (fica sobre a rua, não no "centro" geométrico). */
export function buildStreetIndex(g: Pick<Graph, "m" | "ea" | "eb" | "lat" | "lon" | "nameIdx" | "names">): StreetEntry[] {
  const by = new Map<number, number[]>();
  for (let e = 0; e < g.m; e++) {
    const ni = g.nameIdx[e];
    if (!g.names[ni]) continue; // aresta sem nome
    (by.get(ni) ?? by.set(ni, []).get(ni)!).push(e);
  }
  const out: StreetEntry[] = [];
  for (const [ni, es] of by) {
    const name = g.names[ni];
    if (!name) continue;
    const mid = es[Math.floor(es.length / 2)];
    const lat = (g.lat[g.ea[mid]] + g.lat[g.eb[mid]]) / 2, lon = (g.lon[g.ea[mid]] + g.lon[g.eb[mid]]) / 2;
    const norm = normText(name);
    const [type, core] = splitStreet(name);
    out.push({ name, norm, tokens: norm.split(" ").filter(Boolean), lat, lon, edges: es.length, type, core });
  }
  return out;
}

export interface ParsedQuery { street: string; number: string | null; raw: string; hasDigits: boolean }

/** Separa rua e número de uma digitação parcial ("rua joaq tav 48" → rua "joaq tav", número 48). */
export function parseQuery(q: string): ParsedQuery {
  const raw = clean(q);
  const f = parseFreeAddress(raw);
  let street = f.street ?? raw;
  let number = f.number;
  if (!number) {
    const m = raw.match(/^(.*\D)\s+(\d{1,6}[A-Za-z]?)$/); // "rua x 48" quando o parse livre não achou
    if (m && !/\b\d+\s+de\s+\w+$/i.test(raw)) { street = m[1]; number = m[2].toUpperCase(); }
  }
  return { street: clean(street).replace(/[,;]+$/, ""), number, raw, hasDigits: /\d/.test(raw) };
}

const expandType = (tok: string): string[] => {
  const [t] = splitStreet(tok + " X");
  return t && t !== tok ? [t] : [];
};

/** Todos os termos digitados precisam ser prefixo de algum termo do nome (abreviações de tipo e de título são expandidas). */
export function matchStreet(entry: StreetEntry, street: string): number {
  const qTokens = normText(street).split(" ").filter(Boolean);
  if (!qTokens.length) return 0;
  let score = 0;
  const used = new Set<number>();
  for (const [qi, qt] of qTokens.entries()) {
    const alts = [qt, ...(qi === 0 ? expandType(qt) : [])];
    let hit = -1, exact = false;
    for (const a of alts) {
      for (let i = 0; i < entry.tokens.length; i++) {
        const t = entry.tokens[i];
        if (used.has(i)) continue;
        if (t === a) { hit = i; exact = true; break; }
        if (hit < 0 && a.length >= 2 && !STOP.has(t) && t.startsWith(a)) hit = i;
      }
      if (exact) break;
    }
    if (hit < 0) return 0;
    used.add(hit);
    score += exact ? 1 : 0.6;
  }
  const full = qTokens.join(" ") === entry.norm || qTokens.join(" ") === entry.core;
  return score / Math.max(qTokens.length, 1) * 0.7 + (full ? 0.3 : 0) + Math.min(0.05, entry.edges / 4000);
}

export function suggestStreets(index: StreetEntry[], q: string, opts: { limit?: number; user?: { lat: number; lon: number } | null } = {}): AddressHit[] {
  const p = parseQuery(q);
  if (normText(p.street).length < 2) return [];
  const hits: AddressHit[] = [];
  for (const e of index) {
    const s = matchStreet(e, p.street);
    if (s <= 0) continue;
    let score = s;
    if (opts.user) score += 0.15 * Math.exp(-haversine(opts.user, e) / 4000); // proximidade: só desempate
    hits.push({
      id: `m|${e.norm}`, title: prettyKeep(e.name) + (p.number ? `, ${p.number}` : ""), subtitle: "Santos/SP · rua (posição aproximada)",
      lat: e.lat, lon: e.lon, precision: "street", numberAsked: p.number, numberConfirmed: false,
      note: p.number ? `Número ${p.number} não confirmado: ponto aproximado na rua, não a porta.` : "Ponto aproximado na rua.",
      source: "malha", score,
    });
  }
  return hits.sort((a, b) => b.score - a.score).slice(0, opts.limit ?? 6);
}

/** Converte candidatos do provedor em resultados, aplicando o filtro de Santos (município + caixa). */
export function fromCandidates(cands: Candidate[], p: ParsedQuery, opts: { user?: { lat: number; lon: number } | null; city?: string } = {}): AddressHit[] {
  const city = normText(opts.city ?? "Santos");
  const out: AddressHit[] = [];
  for (const c of cands) {
    const sameCity = c.city ? normText(c.city) === city : false;
    const inBox = inSantosBox(c.lat, c.lon);
    if (!sameCity && !inBox) continue; // homônimo de outro município nunca entra na lista principal
    const confirmed = !!p.number && !!c.houseNumber && normText(c.houseNumber).split("-")[0] === normText(p.number) && (c.precision === "exact" || c.precision === "interpolated");
    const precision: HitPrecision = confirmed ? c.precision as HitPrecision : c.precision === "neighborhood" ? "neighborhood" : "street";
    let score = c.confidence + (sameCity ? 0.4 : 0) + (inBox ? 0.2 : 0) + (confirmed ? 0.3 : 0);
    if (opts.user) score += 0.15 * Math.exp(-haversine(opts.user, c) / 4000);
    const road = c.road ? prettyKeep(c.road) : c.label.split(",")[0];
    out.push({
      id: `p|${c.lat.toFixed(5)}|${c.lon.toFixed(5)}`,
      title: road + (p.number ? `, ${confirmed ? c.houseNumber : p.number}` : ""),
      subtitle: [c.city ?? "Santos", c.postcode].filter(Boolean).join(" · ") + (sameCity ? "" : " · município não confirmado"),
      lat: c.lat, lon: c.lon, precision, numberAsked: p.number, numberConfirmed: confirmed,
      note: confirmed ? (c.precision === "interpolated" ? `Número ${p.number} interpolado entre vizinhos; confirme na porta.` : `Número ${p.number} localizado pelo provedor.`)
        : p.number ? `Número ${p.number} não localizado: ponto aproximado na rua, não a porta.` : "Rua localizada; sem número.",
      source: "provedor", score,
    });
  }
  return out.sort((a, b) => b.score - a.score);
}

/** Junta malha + provedor sem repetir a mesma rua; quem tem número confirmado sobe. */
export function mergeHits(local: AddressHit[], remote: AddressHit[], limit = 8): AddressHit[] {
  const seen = new Set<string>();
  const all = [...remote, ...local].sort((a, b) => Number(b.numberConfirmed) - Number(a.numberConfirmed) || b.score - a.score);
  const out: AddressHit[] = [];
  for (const h of all) {
    const k = normText(h.title) + (h.numberConfirmed ? "|ok" : "");
    if (seen.has(k) || (!h.numberConfirmed && seen.has(normText(h.title) + "|ok"))) continue; // o resultado com número confirmado substitui o "só a rua" igual
    seen.add(k);
    out.push(h);
    if (out.length >= limit) break;
  }
  return out;
}

/** Pesquisa dentro das entregas já importadas (rua, número, código, destinatário, bairro). */
export function searchDeliveries<L extends { street?: string | null; number?: string | null; neighborhood?: string | null; externalId?: string | null; recipient?: string | null; complement?: string | null; addressKey?: string | null; row: number }>(
  letters: L[], q: string, limit = 30): { key: string; line: string; sub: string }[] {
  const t = normText(q);
  if (!t) return [];
  const m = new Map<string, { key: string; line: string; sub: string }>();
  for (const l of letters) {
    if (!l.addressKey) continue;
    const hay = [l.street, l.number, l.neighborhood, l.externalId, l.recipient, l.complement].map((v) => normText(v ?? ""));
    if (!hay.some((v) => v.includes(t))) continue;
    if (!m.has(l.addressKey)) m.set(l.addressKey, { key: l.addressKey, line: [l.street, l.number].filter(Boolean).join(", "), sub: `${l.neighborhood ?? ""} · ${l.externalId ?? "carta " + l.row}` });
  }
  return [...m.values()].slice(0, limit);
}

export interface SearchDeps {
  /** base local de endereços (IBGE): hits com NÚMERO confirmado na fonte, offline */
  local?: (p: ParsedQuery) => AddressHit[];
  remote: (p: ParsedQuery, signal: AbortSignal) => Promise<Candidate[]>;
  index: () => Promise<StreetEntry[]>;
  user: () => { lat: number; lon: number } | null;
  /** true: o provedor aceita autocomplete a cada digitação. false (Nominatim público): consulta só em `submit`. */
  liveRemote: () => boolean;
  online: () => boolean;
}
export interface SearchResult { hits: AddressHit[]; state: "ok" | "offline" | "error" | "empty" | "short"; message: string | null; fromRemote: boolean }

/** Serviço com cancelamento da busca anterior, cache em memória e limite de taxa. */
export function createSearchService(deps: SearchDeps) {
  const cache = new Map<string, AddressHit[]>();
  let ctl: AbortController | null = null;
  let lastRemote = 0;
  return {
    cancel() { ctl?.abort(); ctl = null; },
    async query(q: string, opts: { submit?: boolean } = {}): Promise<SearchResult> {
      ctl?.abort();
      const my = (ctl = new AbortController());
      const p = parseQuery(q);
      if (normText(p.street).length < 2) return { hits: [], state: "short", message: null, fromRemote: false };
      const idx = await deps.index(); // carrega a malha e a base do IBGE ANTES de consultar (o 1º resultado já vem completo)
      const local = mergeHits(deps.local?.(p) ?? [], suggestStreets(idx, q, { user: deps.user() }));
      if (my.signal.aborted) return { hits: local, state: "ok", message: null, fromRemote: false };
      const wantRemote = opts.submit || deps.liveRemote();
      if (!wantRemote) return { hits: local, state: local.length ? "ok" : "empty", message: local.length ? null : "Toque em buscar para consultar o provedor.", fromRemote: false };
      if (!deps.online()) return { hits: local, state: "offline", message: "Sem internet: mostrando só ruas do mapa offline.", fromRemote: false };
      const key = normText(q);
      let remote = cache.get(key);
      if (!remote) {
        const wait = 1100 - (Date.now() - lastRemote);
        if (wait > 0) await new Promise((r) => setTimeout(r, wait));
        if (my.signal.aborted) return { hits: local, state: "ok", message: null, fromRemote: false };
        lastRemote = Date.now();
        try {
          remote = fromCandidates(await deps.remote(p, my.signal), p, { user: deps.user() });
          cache.set(key, remote);
        } catch (e) {
          if (my.signal.aborted) return { hits: local, state: "ok", message: null, fromRemote: false };
          return { hits: local, state: "error", message: `Provedor indisponível (${(e as Error).message}). Mostrando ruas do mapa offline.`, fromRemote: false };
        }
      }
      const hits = mergeHits(local, remote);
      return { hits, state: hits.length ? "ok" : "empty", message: hits.length ? null : "Nenhum endereço encontrado em Santos.", fromRemote: true };
    },
  };
}
