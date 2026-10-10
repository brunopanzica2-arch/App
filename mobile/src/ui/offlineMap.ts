/**
 * Mapa-base OFFLINE de Santos (V3 §9): pacote PMTiles vetorial (dados © OpenStreetMap, ODbL; compilação Protomaps)
 * empacotado no app em `map/santos.pmtiles` + estilo local (esquema Protomaps) + fontes Noto Sans locais.
 * Sem chamadas externas: funciona em modo avião desde a primeira abertura.
 * Se o pacote não existir, `loadOfflineStyle()` devolve null e o mapa usa o estilo online ou o fundo liso.
 */
import { layers, namedFlavor } from "@protomaps/basemaps";
import * as maplibregl from "maplibre-gl";
import { PMTiles, Protocol, type RangeResponse, type Source } from "pmtiles";

export interface PackInfo {
  arquivo: string; bytes: number; sha256: string; tiles: number; compilacao: string; recorte_bbox: number[]; zoom_max: number;
  atribuicao: string; licenca: string;
}

/** Fonte PMTiles em memória: o arquivo inteiro (~2,5 MB) é lido uma vez; evita depender de Range no WebView local. */
class BufferSource implements Source {
  constructor(private buf: ArrayBuffer, private key: string) {}
  getKey() { return this.key; }
  async getBytes(offset: number, length: number): Promise<RangeResponse> {
    return { data: this.buf.slice(offset, offset + length) };
  }
}

let protocolReady = false;
let cached: Promise<{ style: any; info: PackInfo } | null> | null = null;

const base = () => document.baseURI;

export async function sha256Hex(buf: ArrayBuffer): Promise<string> {
  const h = new Uint8Array(await crypto.subtle.digest("SHA-256", buf));
  return [...h].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Remove dependência de sprite (ícones de POI) e rótulos que exigem imagens que não empacotamos. */
export function offlineLayers(): any[] {
  return (layers("protomaps", namedFlavor("light"), { lang: "pt" }) as any[])
    .filter((l) => !["roads_oneway", "roads_shields", "pois"].includes(l.id))
    .map((l) => {
      if (l.layout && "icon-image" in l.layout) {
        const { ["icon-image"]: _i, ["icon-size"]: _s, ["icon-allow-overlap"]: _a, ...rest } = l.layout;
        return { ...l, layout: rest };
      }
      return l;
    });
}

export const packKey = (info: PackInfo) => `santos-${info.sha256.slice(0, 12)}`;

export function buildStyle(info: PackInfo): any {
  return {
    version: 8,
    glyphs: new URL("fonts/{fontstack}/{range}.pbf", base()).href.replace("%7Bfontstack%7D", "{fontstack}").replace("%7Brange%7D", "{range}"),
    sources: { protomaps: { type: "vector", url: `pmtiles://${packKey(info)}`, attribution: info.atribuicao } },
    layers: offlineLayers(),
  };
}

/** Carrega e verifica (SHA-256) o pacote. Devolve null se ausente/inválido (o chamador cai para o online ou o fundo liso). */
export function loadOfflineStyle(): Promise<{ style: any; info: PackInfo } | null> {
  if (!cached) {
    cached = (async () => {
      try {
        const info: PackInfo = await (await fetch(new URL("map/santos.pmtiles.json", base()))).json();
        const r = await fetch(new URL("map/santos.pmtiles", base()));
        if (!r.ok) return null;
        const buf = await r.arrayBuffer();
        if (buf.byteLength !== info.bytes || (await sha256Hex(buf)) !== info.sha256) {
          console.warn("[mapa offline] pacote com tamanho/hash diferente do declarado; ignorado");
          return null; // pacote corrompido: não usar
        }
        if (!protocolReady) {
          const protocol = new Protocol({ metadata: false });
          maplibregl.addProtocol("pmtiles", protocol.tile);
          (loadOfflineStyle as any).protocol = protocol;
          protocolReady = true;
        }
        ((loadOfflineStyle as any).protocol as Protocol).add(new PMTiles(new BufferSource(buf, packKey(info))));
        return { style: buildStyle(info), info };
      } catch (e) {
        console.warn("[mapa offline] pacote indisponível:", e);
        return null;
      }
    })();
  }
  return cached;
}
