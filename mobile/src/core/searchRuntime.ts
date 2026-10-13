/** Liga o SearchService ao app: índice de ruas da malha local (carregado uma vez) + geocodificador configurado em Ajustes. */
import { isPublicProvider, search as geoSearch } from "./geocode";
import { parseGraph } from "./graph";
import { ensureLocalBase, localBase } from "./localgeo";
import { lookupCnefe } from "./cnefe";
import { buildStreetIndex, createSearchService, type AddressHit, type ParsedQuery, type StreetEntry } from "./search";

let indexP: Promise<StreetEntry[]> | null = null;
let userPos: { lat: number; lon: number } | null = null;
export const setSearchUser = (p: { lat: number; lon: number } | null) => { userPos = p; };

function loadIndex(): Promise<StreetEntry[]> {
  indexP ??= fetch(new URL("santos-graph.bin", document.baseURI).href)
    .then((r) => { if (!r.ok) throw new Error(`malha HTTP ${r.status}`); return r.arrayBuffer(); })
    .then((b) => buildStreetIndex(parseGraph(b)))
    .catch((e) => { indexP = null; throw e; });
  return indexP;
}

/** número encontrado na base do IBGE (offline): resultado com número CONFIRMADO NA FONTE, não só a rua */
function localHits(p: ParsedQuery): AddressHit[] {
  const db = localBase();
  if (!db || !p.number) return [];
  const r = lookupCnefe(db, { street: p.street, number: p.number });
  if (!r.street) return [];
  const ok = (r.kind === "exact" || r.kind === "face") && r.lat != null;
  if (!ok && r.kind !== "estimated") return [];
  return [{ id: `i|${r.lat!.toFixed(5)}|${r.lon!.toFixed(5)}`, title: `${r.street}, ${p.number}`, subtitle: `Santos/SP${r.locality ? ` · ${r.locality}` : ""} · IBGE (Censo 2022)`,
    lat: r.lat!, lon: r.lon!, precision: r.kind === "exact" ? "exact" : "interpolated", numberAsked: p.number, numberConfirmed: r.kind === "exact" || r.kind === "face",
    note: r.reason, source: "malha", score: r.kind === "exact" ? 2 : r.kind === "face" ? 1.5 : 0.8 }];
}

export const searchService = createSearchService({
  local: localHits,
  index: async () => { await ensureLocalBase(); return loadIndex().catch(() => []); }, // a base do IBGE carrega junto (offline, ~1 MB)
  user: () => userPos,
  // Nominatim público proíbe autocomplete: consulta só ao confirmar. Provedor próprio pode ser consultado ao digitar.
  liveRemote: () => !isPublicProvider(),
  online: () => typeof navigator === "undefined" || navigator.onLine !== false,
  remote: (p) => geoSearch({ street: p.number ? `${p.number} ${p.street}` : p.street, city: "Santos", state: "SP", country: "Brasil" }),
});
