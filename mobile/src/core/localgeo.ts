/**
 * Geocodificador LOCAL: aplica a base IBGE/CNEFE (cnefe.ts) aos endereços do app, sem rede e sem cota.
 * Ordem de confiança: porta/pino confirmado > número localizado (IBGE nível 1, OSM) > face da quadra/estimado > só a rua.
 * Nunca sobrescreve o que o usuário confirmou. Tudo rotulado com a fonte ("ibge-cnefe-2022").
 */
import { type Address, type Candidate, db } from "./db";
import { type CnefeDb, type CnefeResult, lookupCnefe, parseCnefe } from "./cnefe";
import { type NormalizedAddress, normalizeAddress } from "./normalize";

let base: CnefeDb | null = null;
let loading: Promise<CnefeDb | null> | null = null;
/** para testes */
export const setLocalBase = (d: CnefeDb | null) => { base = d; loading = null; };
export const localBase = () => base;

/** Carrega a base uma única vez (arquivo local do app: funciona offline). Falha em silêncio: o app segue só com o provedor online. */
export function ensureLocalBase(): Promise<CnefeDb | null> {
  if (base) return Promise.resolve(base);
  loading ??= (async () => {
    try {
      const r = await fetch(new URL("santos-enderecos.bin", document.baseURI).href);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      base = parseCnefe(await r.arrayBuffer());
    } catch (e) { console.warn("[rota:ibge] base de endereços indisponível", (e as Error).message); base = null; loading = null; }
    return base;
  })();
  return loading;
}

export function localLookup(a: Pick<NormalizedAddress, "street" | "number" | "neighborhood">): CnefeResult | null {
  return base ? lookupCnefe(base, { street: a.street, number: a.number, neighborhood: a.neighborhood }) : null;
}

const toCandidate = (c: CnefeResult["candidates"][number], num: string | null): Candidate => ({
  lat: c.lat, lon: c.lon, label: `${c.street}${num ? `, ${num}` : ""}${c.locality ? ` — ${c.locality}` : ""} (IBGE)`,
  precision: c.level === 1 ? "exact" : "interpolated", confidence: c.level === 1 ? 0.85 : 0.6, road: c.street, houseNumber: num, city: "Santos",
});

/** Campos do Address que o resultado local define. null = nada utilizável como posição (só vale como candidato/aviso). */
export function patchFromLocal(loc: CnefeResult, number: string | null): Partial<Address> | null {
  const now = new Date().toISOString();
  const cands = loc.candidates.map((c) => toCandidate(c, number));
  const adj = loc.nameAdjusted ? ` Nome oficial no IBGE: "${loc.street}" — confira.` : "";
  if (loc.kind === "exact" && loc.lat != null)
    return { lat: loc.lat, lon: loc.lon!, precision: "exact", confidence: loc.nameAdjusted ? 0.75 : 0.85, source: `ibge-cnefe-2022|nv1|${loc.locality ?? ""}`, candidates: cands, needsReview: !!loc.nameAdjusted, reason: loc.nameAdjusted ? loc.reason : null, verifiedAt: now };
  if (loc.kind === "face" && loc.lat != null)
    return { lat: loc.lat, lon: loc.lon!, precision: "interpolated", confidence: 0.6, source: `ibge-cnefe-2022|face|${loc.locality ?? ""}`, candidates: cands, needsReview: true, reason: `${loc.reason}${loc.nameAdjusted ? adj : ""}`, verifiedAt: now };
  if (loc.kind === "estimated" && loc.lat != null)
    return { lat: loc.lat, lon: loc.lon!, precision: "interpolated", confidence: 0.5, source: `ibge-cnefe-2022|estimado|nºs ${loc.between?.join("–")}`, candidates: [], needsReview: true, reason: loc.reason, verifiedAt: now };
  return null;
}

const KEEP: Address["precision"][] = ["exact", "manual", "test"];

/** Resolve localmente os endereços ÚNICOS do lote (cria o registro se não existir). Devolve quantos ficaram com posição. */
export async function resolveBatchLocally(batchId: string): Promise<{ resolved: number; exact: number; estimated: number; ambiguous: number; checked: number }> {
  const out = { resolved: 0, exact: 0, estimated: 0, ambiguous: 0, checked: 0 };
  if (!base) return out;
  const letters = (await db.letters.where("batchId").equals(batchId).toArray()).filter((l) => l.addressKey && !l.excluded);
  const first = new Map<string, (typeof letters)[number]>();
  for (const l of letters) if (!first.has(l.addressKey!)) first.set(l.addressKey!, l);
  const existing = new Map((await db.addresses.bulkGet([...first.keys()])).filter(Boolean).map((a) => [a!.key, a!]));
  for (const [key, l] of first) {
    const na = normalizeAddress(l.street, l.number, l.neighborhood, l.city, l.cep);
    const ex = existing.get(key);
    if (ex && (ex.confirmedAt || ex.entrance || KEEP.includes(ex.precision))) continue;
    if (/^santos$/i.test(na.city) === false) continue; // a base é só de Santos
    out.checked++;
    const loc = localLookup(na);
    if (!loc) continue;
    const patch = patchFromLocal(loc, na.number);
    const baseAddr: Address = ex ?? {
      key, display: na.display, original: na.original, street: na.street, number: na.number, neighborhood: na.neighborhood, city: na.city, cep: na.cep,
      lat: null, lon: null, precision: "not_found", confidence: 0, source: null, candidates: [], needsReview: true, reason: null, verifiedAt: null, confirmedAt: null,
    };
    if (patch) {
      await db.addresses.put({ ...baseAddr, ...patch } as Address);
      out.resolved++;
      if (loc.kind === "estimated") out.estimated++; else out.exact++;
    } else if (loc.kind === "ambiguous" && !ex) { // não escolhe sozinho: guarda os candidatos e o aviso para o usuário decidir
      await db.addresses.put({ ...baseAddr, candidates: loc.candidates.map((c) => toCandidate(c, na.number)), reason: loc.reason, needsReview: true });
      out.ambiguous++;
    }
  }
  return out;
}
