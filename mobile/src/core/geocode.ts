/**
 * Geocodificação pelo Nominatim (OpenStreetMap), direto do aparelho.
 * - 1 consulta por segundo (política do serviço) e cache local;
 * - endereços confirmados no mapa são reaproveitados sem nova consulta;
 * - NUNCA envia nome do destinatário nem complemento;
 * - precisão explícita: exato / interpolado / aproximado na rua / bairro / não localizado.
 */
import { CapacitorHttp, Capacitor } from "@capacitor/core";
import { type Address, type Candidate, db } from "./db";
import { type NormalizedAddress, normText } from "./normalize";

const URL_BASE = "https://nominatim.openstreetmap.org/search";
let last = 0;

async function http(params: Record<string, string>): Promise<any[]> {
  const wait = 1100 - (Date.now() - last);
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  last = Date.now();
  if (Capacitor.isNativePlatform()) {
    const r = await CapacitorHttp.get({ url: URL_BASE, params, headers: { "User-Agent": "RotaSantos/1.0 (app pessoal de entregas)" } });
    if (r.status >= 400) throw new Error(`Nominatim HTTP ${r.status}`);
    return typeof r.data === "string" ? JSON.parse(r.data) : r.data;
  }
  const r = await fetch(`${URL_BASE}?${new URLSearchParams(params)}`);
  if (!r.ok) throw new Error(`Nominatim HTTP ${r.status}`);
  return r.json();
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
  else [precision, confidence] = hn ? ["exact", 0.8] : ["street", 0.3];
  return {
    lat: +item.lat, lon: +item.lon, label: item.display_name, precision, confidence,
    road: a.road || a.pedestrian || a.footway || null, houseNumber: hn ?? null,
    city: a.city || a.town || a.municipality || null, postcode: a.postcode || null,
  };
}

export async function search(q: Record<string, string>, email = ""): Promise<Candidate[]> {
  const key = JSON.stringify(q);
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
  await db.addresses.update(key, {
    lat, lon, precision: "manual", confidence: 1, source: "manual", needsReview: false, reason: null,
    confirmedAt: new Date().toISOString(),
  });
}
