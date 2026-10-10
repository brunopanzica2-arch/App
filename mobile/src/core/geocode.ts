/**
 * Geocodificação pelo Nominatim (OpenStreetMap), direto do aparelho.
 * - 1 consulta por segundo (política do serviço) e cache local;
 * - endereços confirmados no mapa são reaproveitados sem nova consulta;
 * - NUNCA envia nome do destinatário nem complemento;
 * - precisão explícita: exato / interpolado / aproximado na rua / bairro / não localizado.
 */
import { confirmPin } from "./address";
import { CapacitorHttp, Capacitor } from "@capacitor/core";
import { type Address, type Candidate, db } from "./db";
import { type NormalizedAddress, normText } from "./normalize";

const PUBLIC_URL = "https://nominatim.openstreetmap.org/search";
export interface GeoProviderCfg { baseUrl: string; apiKey?: string; minIntervalMs?: number }
let cfg: GeoProviderCfg = { baseUrl: PUBLIC_URL };
let last = 0;
let dailyQuota = 250;
export function setDailyQuota(n: number) { dailyQuota = n; }
export class QuotaError extends Error {}

/** Configura o provedor. Vazio/indefinido = Nominatim público. */
export function setProvider(c?: GeoProviderCfg | null) { cfg = c && c.baseUrl ? c : { baseUrl: PUBLIC_URL }; }
export function providerId(): string { try { return new URL(cfg.baseUrl).host; } catch { return cfg.baseUrl; } }
/** Nominatim público: política de uso proíbe lote/volume. Só consultas pontuais + cota diária. */
export function isPublicProvider(): boolean { try { return new URL(cfg.baseUrl).host.endsWith("openstreetmap.org"); } catch { return false; } }

function quotaKey() { return `rota.geocode.${new Date().toISOString().slice(0, 10)}`; }
export function quotaUsed(): number {
  try { return +(localStorage.getItem(quotaKey()) || 0); } catch { return 0; }
}
function countQuery() {
  try { localStorage.setItem(quotaKey(), String(quotaUsed() + 1)); } catch { /* sem localStorage */ }
}
async function logUsage(error: boolean) {
  const date = new Date().toISOString().slice(0, 10), id = `${date}|${providerId()}`;
  await db.transaction("rw", db.geousage, async () => {
    const u = (await db.geousage.get(id)) ?? { id, date, provider: providerId(), queries: 0, errors: 0 };
    u.queries += 1;
    if (error) u.errors += 1;
    await db.geousage.put(u);
  });
}

async function http(params: Record<string, string>): Promise<any[]> {
  const pub = isPublicProvider();
  if (pub && quotaUsed() >= dailyQuota) throw new QuotaError(`Cota diária de ${dailyQuota} consultas ao Nominatim público atingida. Confirme os demais no mapa, importe coordenadas ou configure um provedor próprio em Ajustes.`);
  if (pub) countQuery();
  const gap = pub ? 1100 : (cfg.minIntervalMs ?? 150);
  const wait = gap - (Date.now() - last);
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  last = Date.now();
  const headers: Record<string, string> = { "User-Agent": "RotaSantos/1.1 (app pessoal de entregas)" };
  if (cfg.apiKey) headers.Authorization = `Bearer ${cfg.apiKey}`;
  try {
    let data: any[];
    if (Capacitor.isNativePlatform()) {
      const r = await CapacitorHttp.get({ url: cfg.baseUrl, params, headers });
      if (r.status >= 400) throw new Error(`Geocodificador HTTP ${r.status}`);
      data = typeof r.data === "string" ? JSON.parse(r.data) : r.data;
    } else {
      const r = await fetch(`${cfg.baseUrl}?${new URLSearchParams(params)}`, cfg.apiKey ? { headers: { Authorization: headers.Authorization } } : undefined);
      if (!r.ok) throw new Error(`Geocodificador HTTP ${r.status}`);
      data = await r.json();
    }
    await logUsage(false);
    return data;
  } catch (e) {
    await logUsage(true);
    throw e;
  }
}

export function classify(item: any, wanted: string | null): Candidate {
  const a = item.address || {};
  const cat = item.category || item.class;
  const hn: string | undefined = a.house_number;
  let precision: Candidate["precision"], confidence: number;
  if (hn && wanted && normText(hn).split("-")[0] === normText(wanted)) {
    if (item.osm_type === "way" && item.type === "house") [precision, confidence] = ["interpolated", 0.7];
    else [precision, confidence] = ["exact", 0.9];
  } else if (hn && wanted) [precision, confidence] = ["street", 0.4];
  else if (cat === "highway" || ["road", "street"].includes(item.addresstype)) [precision, confidence] = ["street", 0.5];
  else if (["suburb", "neighbourhood", "quarter", "city_district"].includes(item.addresstype) || cat === "place")
    [precision, confidence] = ["neighborhood", 0.2];
  else [precision, confidence] = hn && wanted ? ["exact", 0.8] : ["street", 0.3]; // sem número pedido, nunca "exato"
  return {
    lat: +item.lat, lon: +item.lon, label: item.display_name, precision, confidence,
    road: a.road || a.pedestrian || a.footway || null, houseNumber: hn ?? null,
    city: a.city || a.town || a.municipality || null, postcode: a.postcode || null,
  };
}

export async function search(q: Record<string, string>, email = ""): Promise<Candidate[]> {
  const key = providerId() + "|" + JSON.stringify(q);
  const cached = await db.geocache.get(key);
  if (cached) return cached.result;
  const params: Record<string, string> = { ...q, format: "jsonv2", addressdetails: "1", limit: "5", countrycodes: "br", "accept-language": "pt-BR" };
  if (email) params.email = email;
  let err: unknown;
  for (let attempt = 0, delay = 1000; attempt < 3; attempt++, delay *= 2) {
    try {
      const items = await http(params);
      const wanted = q.street?.split(" ")[0];
      const res = items.map((it) => classify(it, /^\d/.test(wanted || "") ? wanted! : null));
      await db.geocache.put({ q: key, at: new Date().toISOString(), result: res });
      return res;
    } catch (e) {
      if (e instanceof QuotaError) throw e;
      err = e;
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw err;
}

const sameRoad = (c: Candidate, na: NormalizedAddress) => {
  if (!c.road) return false;
  const stop = new Set(["RUA", "AVENIDA", "DE", "DA", "DO", "DOS", "DAS", "PRACA", "TRAVESSA"]);
  const a = new Set(normText(c.road).split(" ").filter((w) => !stop.has(w)));
  const b = na.name.split(" ").filter((w) => !["DE", "DA", "DO", "DOS", "DAS"].includes(w));
  return b.length > 0 && b.filter((w) => a.has(w)).length / b.length >= 0.6;
};

export function queryFor(na: NormalizedAddress): Record<string, string> {
  const q: Record<string, string> = {
    street: na.number ? `${na.number} ${na.street}` : na.street,
    city: na.city, state: na.state, country: "Brasil",
  };
  if (na.cep) q.postalcode = na.cep;
  return q;
}

export async function resolve(na: NormalizedAddress, email = "", force = false): Promise<Address> {
  const existing = await db.addresses.get(na.key);
  if (existing && !force && (existing.confirmedAt || ["exact", "interpolated", "manual"].includes(existing.precision))) return existing;
  const q = queryFor(na);
  let cands = await search(q, email);
  if (!cands.length && q.postalcode) {
    const { postalcode, ...rest } = q;
    void postalcode;
    cands = await search(rest, email);
  }
  if (!cands.length && na.number) cands = await search({ street: na.street, city: na.city, state: na.state, country: "Brasil" }, email);
  const base: Address = {
    key: na.key, display: na.display, original: na.original, street: na.street, number: na.number,
    neighborhood: na.neighborhood, city: na.city, cep: na.cep, lat: null, lon: null, precision: "not_found",
    confidence: 0, source: "nominatim", candidates: cands.slice(0, 5), needsReview: true,
    reason: "Endereço não localizado pelo provedor.", verifiedAt: new Date().toISOString(), confirmedAt: null,
  };
  if (!cands.length) {
    await db.addresses.put(base);
    return base;
  }
  const cityOk = cands.filter((c) => !c.city || normText(c.city) === normText(na.city));
  const pool = cityOk.length ? cityOk : cands;
  const good = (c: Candidate) => ["exact", "interpolated"].includes(c.precision);
  const best = pool.reduce((a, b) => ((+good(b) > +good(a) || (good(b) === good(a) && b.confidence > a.confidence)) ? b : a));
  const reasons: string[] = [];
  let conf = best.confidence;
  if (!cityOk.length) { reasons.push("Resultado fora do município informado."); conf *= 0.3; }
  if (!sameRoad(best, na)) { reasons.push(`Logradouro retornado ('${best.road ?? "?"}') difere do informado.`); conf *= 0.5; }
  const distinct = new Set(pool.filter(good).map((c) => `${c.lat.toFixed(3)},${c.lon.toFixed(3)}`));
  if (distinct.size > 1) { reasons.push(`${distinct.size} candidatos distintos (endereço ambíguo).`); conf *= 0.6; }
  if (best.precision === "street") reasons.push("Número não localizado: ponto aproximado na rua.");
  if (best.precision === "neighborhood") reasons.push("Somente o bairro foi localizado.");
  if (na.cep && best.postcode && best.postcode.replace("-", "") !== na.cep.replace("-", "")) {
    reasons.push(`CEP retornado (${best.postcode}) difere do informado.`);
    conf *= 0.8;
  }
  const addr: Address = {
    ...base, lat: best.lat, lon: best.lon, precision: best.precision, confidence: Math.round(conf * 1000) / 1000,
    needsReview: reasons.length > 0 || !good(best), reason: reasons.join(" ") || null,
  };
  await db.addresses.put(addr);
  return addr;
}

export async function confirmAddress(key: string, lat: number, lon: number) {
  await confirmPin(key, lat, lon);
}
