/**
 * Malha de pedestres de Santos (exportada do backend por
 * backend/scripts/export_mobile_graph.py). Mesmas regras do motor do servidor.
 */

// flags de aresta (iguais a roteamento/network.py)
export const F_STEPS = 1;
export const F_PRIVATE = 2;
export const F_AREA = 4;
export const F_SIDEWALK = 8;
export const F_DISMOUNT = 16;
// flags de nó
export const N_BARRIER = 1;
export const N_PRIVATE = 2;
export const N_BLOCKED = 128;

export const FLAG_NAMES: [number, string][] = [
  [F_STEPS, "escada"],
  [F_PRIVATE, "acesso_privado"],
  [F_AREA, "travessia_de_praca"],
  [F_SIDEWALK, "calcada"],
  [F_DISMOUNT, "proibido_pedalar"],
];

// classes de via (iguais a roteamento/network.py › HW_*)
export const HW = { OTHER: 0, STREET: 1, ARTERIAL: 2, SERVICE: 3, PEDESTRIAN: 4, FOOTWAY: 5, SIDEWALK: 6, STEPS: 7, PATH: 8, TRACK: 9, CYCLEWAY: 10, BRIDLEWAY: 11, MOTORWAY: 12 } as const;
export const HW_LABEL = ["outra", "rua", "via arterial", "via de serviço", "calçadão", "caminho de pedestres", "calçada/travessia", "escada", "trilha (path)", "estrada de terra (track)", "ciclovia", "via equestre", "via expressa"];
export const SURF = { UNKNOWN: 0, PAVED: 1, UNPAVED: 2 } as const;
export const ATTR = { LIT: 1, SIDEWALK: 2, DESIGNATED: 4, TRAILHINT: 8, BRIDGE_TUNNEL: 16, INCLINE: 32, NAMED: 64 } as const;

export interface Graph {
  n: number;
  m: number;
  lat: Float64Array;
  lon: Float64Array;
  nodeFlags: Uint8Array;
  ea: Uint32Array;
  eb: Uint32Array;
  len: Float32Array;
  eflags: Uint8Array;
  dir: Uint8Array; // bit0 fwd, bit1 bwd, bit2 contramão fwd, bit3 contramão bwd
  share: Float32Array;
  nameIdx: Uint32Array;
  names: string[];
  /** formato do arquivo: 1 = sem atributos de adequação (tudo "desconhecido"); 2 = classe da via, piso, dicas e trilha contínua */
  format?: 1 | 2;
  hw?: Uint8Array;
  surf?: Uint8Array;
  attr?: Uint8Array;
  /** comprimento contínuo da trilha a que a aresta pertence, em dezenas de metros (0 = não é trilha) */
  trail?: Uint8Array;
}

export function parseGraph(buf: ArrayBuffer): Graph {
  const magic = new TextDecoder().decode(new Uint8Array(buf, 0, 4));
  if (magic !== "RSG1" && magic !== "RSG2") throw new Error("Arquivo de malha inválido");
  const dv = new DataView(buf);
  const n = dv.getUint32(4, true);
  const m = dv.getUint32(8, true);
  let off = 16;
  const take = <T>(ctor: { new (b: ArrayBuffer): T }, count: number, size: number): T => {
    const t = new ctor(buf.slice(off, off + count * size));
    off += count * size;
    return t;
  };
  const latI = take(Int32Array, n, 4);
  const lonI = take(Int32Array, n, 4);
  const nodeFlags = take(Uint8Array, n, 1);
  const ea = take(Uint32Array, m, 4);
  const eb = take(Uint32Array, m, 4);
  const len = take(Float32Array, m, 4);
  const eflags = take(Uint8Array, m, 1);
  const dir = take(Uint8Array, m, 1);
  const share = take(Float32Array, m, 4);
  const nameIdx = take(Uint32Array, m, 4);
  let hw: Uint8Array | undefined, surf: Uint8Array | undefined, attr: Uint8Array | undefined, trail: Uint8Array | undefined;
  if (magic === "RSG2") {
    hw = take(Uint8Array, m, 1);
    surf = take(Uint8Array, m, 1);
    attr = take(Uint8Array, m, 1);
    trail = take(Uint8Array, m, 1);
  }
  const names = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, off))) as string[];
  const lat = new Float64Array(n);
  const lon = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    lat[i] = latI[i] / 1e7;
    lon[i] = lonI[i] / 1e7;
  }
  return { n, m, lat, lon, nodeFlags, ea, eb, len, eflags, dir, share, nameIdx, names, format: magic === "RSG2" ? 2 : 1, hw, surf, attr, trail };
}

const R = 6371008.8;
export function haversine(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const p1 = (lat1 * Math.PI) / 180;
  const p2 = (lat2 * Math.PI) / 180;
  const dp = p2 - p1;
  const dl = ((lon2 - lon1) * Math.PI) / 180;
  const a = Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}
