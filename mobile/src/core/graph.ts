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
}

export function parseGraph(buf: ArrayBuffer): Graph {
  const magic = new TextDecoder().decode(new Uint8Array(buf, 0, 4));
  if (magic !== "RSG1") throw new Error("Arquivo de malha inválido");
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
  const names = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, off))) as string[];
  const lat = new Float64Array(n);
  const lon = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    lat[i] = latI[i] / 1e7;
    lon[i] = lonI[i] / 1e7;
  }
  return { n, m, lat, lon, nodeFlags, ea, eb, len, eflags, dir, share, nameIdx, names };
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
