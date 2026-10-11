/** Liga o SearchService ao app: índice de ruas da malha local (carregado uma vez) + geocodificador configurado em Ajustes. */
import { isPublicProvider, search as geoSearch } from "./geocode";
import { parseGraph } from "./graph";
import { buildStreetIndex, createSearchService, type StreetEntry } from "./search";

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

export const searchService = createSearchService({
  index: () => loadIndex().catch(() => []),
  user: () => userPos,
  // Nominatim público proíbe autocomplete: consulta só ao confirmar. Provedor próprio pode ser consultado ao digitar.
  liveRemote: () => !isPublicProvider(),
  online: () => typeof navigator === "undefined" || navigator.onLine !== false,
  remote: (p) => geoSearch({ street: p.number ? `${p.number} ${p.street}` : p.street, city: "Santos", state: "SP", country: "Brasil" }),
});
