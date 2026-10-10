/**
 * Roteamento PEDESTRE no próprio aparelho (porta de backend/roteamento/router.py).
 * - sentido único de automóveis NÃO restringe (só sinaliza contramão);
 * - sem prioridade a ciclovias;
 * - trechos pedaláveis x conduzir a pé x escada, com velocidades próprias;
 * - escadas / acessos privados / barreiras: permitir, penalizar ou evitar;
 * - só a maior componente fortemente conexa é usada (ilhas são detectadas);
 * - nenhuma ligação nova é criada: paradas são projetadas sobre trechos reais.
 */
import {
  F_DISMOUNT, F_PRIVATE, F_SIDEWALK, F_STEPS, FLAG_NAMES, type Graph, N_BARRIER, N_BLOCKED, N_PRIVATE,
} from "./graph";

export type Policy = "allow" | "penalize" | "forbid";
export interface Profile {
  ride_speed_kmh: number;
  walk_speed_kmh: number;
  steps_speed_factor: number;
  sidewalk_mode: "walk" | "ride";
  steps_policy: Policy;
  steps_penalty_s: number;
  private_policy: Policy;
  private_penalty_s: number;
  barrier_policy: Policy;
  barrier_penalty_s: number;
  contraflow_factor: number;
}

export const DEFAULT_PROFILE: Profile = {
  ride_speed_kmh: 15,
  walk_speed_kmh: 4.5,
  steps_speed_factor: 0.5,
  sidewalk_mode: "walk",
  steps_policy: "penalize",
  steps_penalty_s: 30,
  private_policy: "penalize",
  private_penalty_s: 120,
  barrier_policy: "penalize",
  barrier_penalty_s: 20,
  contraflow_factor: 1,
};

export type Mode = "ride" | "walk" | "steps";
const MODE_CODE: Record<Mode, number> = { ride: 0, walk: 1, steps: 2 };
const MODES: Mode[] = ["ride", "walk", "steps"];
const TIEBREAK = 1e-5; // entre caminhos de mesmo tempo, o mais curto
const M_PER_DEG = 111320;

export function edgeMode(flags: number, p: Profile): Mode {
  if (flags & F_STEPS) return "steps";
  if (flags & F_DISMOUNT) return "walk";
  if (flags & F_SIDEWALK) return p.sidewalk_mode;
  return "ride";
}

export interface Snap {
  lat: number;
  lon: number;
  edge: number;
  t: number;
  snapLat: number;
  snapLon: number;
  distance: number;
  /** evidências (auditoria V2, alerta C) */
  flags: string[];
  nearestAny: number;
  confidence: "alta" | "boa" | "media" | "baixa";
}

export function snapConfidence(d: number): Snap["confidence"] {
  return d <= 15 ? "alta" : d <= 30 ? "boa" : d <= 60 ? "media" : "baixa";
}

function segCross(p1: number[], p2: number[], q1: number[], q2: number[]) {
  const o = (a: number[], b: number[], c: number[]) => {
    const v = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
    return Math.abs(v) < 1e-9 ? 0 : v > 0 ? 1 : -1;
  };
  return o(p1, p2, q1) * o(p1, p2, q2) < 0 && o(q1, q2, p1) * o(q1, q2, p2) < 0;
}

export class SnapError extends Error {}

/** Arco extra (pedaço de aresta até um nó virtual). */
interface XArc {
  to: number;
  edge: number;
  f0: number;
  f1: number;
}

class Heap {
  private k: number[] = [];
  private v: number[] = [];
  get size() {
    return this.k.length;
  }
  push(key: number, val: number) {
    const k = this.k, v = this.v;
    let i = k.length;
    k.push(key);
    v.push(val);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (k[p] <= key) break;
      k[i] = k[p];
      v[i] = v[p];
      i = p;
    }
    k[i] = key;
    v[i] = val;
  }
  pop(): [number, number] {
    const k = this.k, v = this.v;
    const rk = k[0], rv = v[0];
    const lk = k.pop()!, lv = v.pop()!;
    const n = k.length;
    if (n) {
      let i = 0;
      for (;;) {
        let c = 2 * i + 1;
        if (c >= n) break;
        if (c + 1 < n && k[c + 1] < k[c]) c++;
        if (k[c] >= lk) break;
        k[i] = k[c];
        v[i] = v[c];
        i = c;
      }
      k[i] = lk;
      v[i] = lv;
    }
    return [rk, rv];
  }
}

export class Router {
  readonly g: Graph;
  readonly p: Profile;
  readonly nodeOk: Uint8Array;
  readonly nodePen: Float64Array;
  readonly edgeOk: Uint8Array;
  readonly mode: Uint8Array;
  readonly wFwd: Float64Array; // tempo (s) da aresta inteira em cada sentido, com penalidades
  readonly wBwd: Float64Array;
  // CSR dos arcos permitidos
  readonly off: Uint32Array;
  readonly arcTo: Uint32Array;
  readonly arcEdge: Uint32Array;
  readonly arcFwd: Uint8Array;
  readonly comp: Int32Array;
  private kx: number;
  private grid = new Map<string, number[]>();
  private readonly CELL = 100;

  constructor(g: Graph, p: Profile) {
    this.g = g;
    this.p = p;
    const { n, m } = g;
    this.nodeOk = new Uint8Array(n);
    this.nodePen = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      const f = g.nodeFlags[i];
      let ok = !(f & N_BLOCKED);
      if (ok && f & N_BARRIER) {
        if (p.barrier_policy === "forbid") ok = false;
        else if (p.barrier_policy === "penalize") this.nodePen[i] += p.barrier_penalty_s;
      }
      if (ok && f & N_PRIVATE) {
        if (p.private_policy === "forbid") ok = false;
        else if (p.private_policy === "penalize") this.nodePen[i] += p.private_penalty_s;
      }
      this.nodeOk[i] = ok ? 1 : 0;
    }
    const speed = [p.ride_speed_kmh / 3.6, p.walk_speed_kmh / 3.6, (p.walk_speed_kmh / 3.6) * p.steps_speed_factor];
    this.edgeOk = new Uint8Array(m);
    this.mode = new Uint8Array(m);
    this.wFwd = new Float64Array(m);
    this.wBwd = new Float64Array(m);
    for (let e = 0; e < m; e++) {
      const f = g.eflags[e];
      let ok = this.nodeOk[g.ea[e]] && this.nodeOk[g.eb[e]];
      let pen = 0;
      if (f & F_STEPS) {
        if (p.steps_policy === "forbid") ok = 0;
        else if (p.steps_policy === "penalize") pen += p.steps_penalty_s * g.share[e];
      }
      if (f & F_PRIVATE) {
        if (p.private_policy === "forbid") ok = 0;
        else if (p.private_policy === "penalize") pen += p.private_penalty_s * g.share[e];
      }
      const md = MODE_CODE[edgeMode(f, p)];
      const t = g.len[e] / speed[md];
      this.edgeOk[e] = ok ? 1 : 0;
      this.mode[e] = md;
      this.wFwd[e] = t * (g.dir[e] & 4 ? p.contraflow_factor : 1) + pen;
      this.wBwd[e] = t * (g.dir[e] & 8 ? p.contraflow_factor : 1) + pen;
    }
    // CSR
    const deg = new Uint32Array(n + 1);
    for (let e = 0; e < m; e++) {
      if (!this.edgeOk[e]) continue;
      if (g.dir[e] & 1) deg[g.ea[e] + 1]++;
      if (g.dir[e] & 2) deg[g.eb[e] + 1]++;
    }
    for (let i = 0; i < n; i++) deg[i + 1] += deg[i];
    const total = deg[n];
    this.off = deg;
    this.arcTo = new Uint32Array(total);
    this.arcEdge = new Uint32Array(total);
    this.arcFwd = new Uint8Array(total);
    const pos = deg.slice(0, n);
    for (let e = 0; e < m; e++) {
      if (!this.edgeOk[e]) continue;
      if (g.dir[e] & 1) {
        const k = pos[g.ea[e]]++;
        this.arcTo[k] = g.eb[e];
        this.arcEdge[k] = e;
        this.arcFwd[k] = 1;
      }
      if (g.dir[e] & 2) {
        const k = pos[g.eb[e]]++;
        this.arcTo[k] = g.ea[e];
        this.arcEdge[k] = e;
        this.arcFwd[k] = 0;
      }
    }
    // diagnóstico apenas: a malha operacional é eleita a partir da ORIGEM (snapOrigin)
    this.comp = this.scc();
    let latSum = 0;
    for (let i = 0; i < n; i++) latSum += g.lat[i];
    this.kx = Math.cos(((latSum / Math.max(n, 1)) * Math.PI) / 180);
    this.buildGrid();
  }

  /** Componentes fortemente conexas (Kosaraju iterativo). */
  private scc(): Int32Array {
    const n = this.g.n;
    const { off, arcTo } = this;
    // grafo reverso
    const rdeg = new Uint32Array(n + 1);
    for (let k = 0; k < arcTo.length; k++) rdeg[arcTo[k] + 1]++;
    for (let i = 0; i < n; i++) rdeg[i + 1] += rdeg[i];
    const rpos = rdeg.slice(0, n);
    const rto = new Uint32Array(arcTo.length);
    for (let u = 0; u < n; u++) for (let k = off[u]; k < off[u + 1]; k++) rto[rpos[arcTo[k]]++] = u;
    const order: number[] = [];
    const seen = new Uint8Array(n);
    const stack: number[] = [];
    const it: number[] = [];
    for (let s = 0; s < n; s++) {
      if (seen[s]) continue;
      seen[s] = 1;
      stack.push(s);
      it.push(off[s]);
      while (stack.length) {
        const u = stack[stack.length - 1];
        const k = it[it.length - 1];
        if (k < off[u + 1]) {
          it[it.length - 1]++;
          const v = arcTo[k];
          if (!seen[v]) {
            seen[v] = 1;
            stack.push(v);
            it.push(off[v]);
          }
        } else {
          stack.pop();
          it.pop();
          order.push(u);
        }
      }
    }
    const comp = new Int32Array(n).fill(-1);
    let c = 0;
    for (let i = order.length - 1; i >= 0; i--) {
      const s = order[i];
      if (comp[s] >= 0) continue;
      comp[s] = c;
      const st = [s];
      while (st.length) {
        const u = st.pop()!;
        for (let k = rdeg[u]; k < rdeg[u + 1]; k++) {
          const v = rto[k];
          if (comp[v] < 0) {
            comp[v] = c;
            st.push(v);
          }
        }
      }
      c++;
    }
    return comp;
  }

  private x(i: number) {
    return this.g.lon[i] * this.kx * M_PER_DEG;
  }
  private y(i: number) {
    return this.g.lat[i] * M_PER_DEG;
  }

  private buildGrid() {
    const g = this.g;
    for (let e = 0; e < g.m; e++) {
      if (!this.edgeOk[e]) continue;
      const a = g.ea[e], b = g.eb[e];
      const x0 = Math.min(this.x(a), this.x(b)), x1 = Math.max(this.x(a), this.x(b));
      const y0 = Math.min(this.y(a), this.y(b)), y1 = Math.max(this.y(a), this.y(b));
      for (let cx = Math.floor(x0 / this.CELL); cx <= Math.floor(x1 / this.CELL); cx++)
        for (let cy = Math.floor(y0 / this.CELL); cy <= Math.floor(y1 / this.CELL); cy++) {
          const key = cx + ":" + cy;
          const list = this.grid.get(key);
          if (list) list.push(e);
          else this.grid.set(key, [e]);
        }
    }
  }

  private project(e: number, px: number, py: number): [number, number] {
    const a = this.g.ea[e], b = this.g.eb[e];
    const ax = this.x(a), ay = this.y(a), dx = this.x(b) - ax, dy = this.y(b) - ay;
    const L2 = dx * dx + dy * dy;
    const t = L2 === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / L2));
    return [Math.hypot(px - (ax + t * dx), py - (ay + t * dy)), t];
  }

  /** Nós alcançáveis a partir de `from` respeitando sentidos de pedestre (BFS no CSR). */
  reachFrom(from: number[]): Uint8Array {
    const seen = new Uint8Array(this.g.n);
    const st = [...from];
    for (const v of st) seen[v] = 1;
    while (st.length) {
      const u = st.pop()!;
      for (let k = this.off[u]; k < this.off[u + 1]; k++) {
        const v = this.arcTo[k];
        if (!seen[v]) { seen[v] = 1; st.push(v); }
      }
    }
    return seen;
  }

  exitNodes(e: number): number[] {
    const g = this.g;
    return [...(g.dir[e] & 1 ? [g.eb[e]] : []), ...(g.dir[e] & 2 ? [g.ea[e]] : [])];
  }

  edgeReachable(e: number, reach: Uint8Array): boolean {
    const g = this.g;
    return !!((g.dir[e] & 1 && reach[g.ea[e]]) || (g.dir[e] & 2 && reach[g.eb[e]]));
  }

  private candidates(px: number, py: number, maxDist: number): [number, number, number][] {
    const cx = Math.floor(px / this.CELL), cy = Math.floor(py / this.CELL);
    const rings = Math.floor(maxDist / this.CELL) + 1;
    const out: [number, number, number][] = [];
    const seen = new Set<number>();
    for (let i = cx - rings; i <= cx + rings; i++)
      for (let j = cy - rings; j <= cy + rings; j++)
        for (const e of this.grid.get(i + ":" + j) || []) {
          if (seen.has(e)) continue;
          seen.add(e);
          const [d, t] = this.project(e, px, py);
          if (d <= maxDist) out.push([d, e, t]);
        }
    return out.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  }

  private crossesOther(e: number, px: number, py: number, qx: number, qy: number): boolean {
    const g = this.g;
    const ends = new Set([g.ea[e], g.eb[e]]);
    const seen = new Set<number>();
    for (let i = Math.floor(Math.min(px, qx) / this.CELL); i <= Math.floor(Math.max(px, qx) / this.CELL); i++)
      for (let j = Math.floor(Math.min(py, qy) / this.CELL); j <= Math.floor(Math.max(py, qy) / this.CELL); j++)
        for (const f of this.grid.get(i + ":" + j) || []) {
          if (f === e || seen.has(f)) continue;
          seen.add(f);
          const a = g.ea[f], b = g.eb[f];
          if (ends.has(a) || ends.has(b)) continue;
          if (segCross([px, py], [qx, qy], [this.x(a), this.y(a)], [this.x(b), this.y(b)])) return true;
        }
    return false;
  }

  private makeSnap(lat: number, lon: number, d: number, e: number, t: number, px: number, py: number, nearestAny: number): Snap {
    const g = this.g, a = g.ea[e], b = g.eb[e];
    const qx = this.x(a) + t * (this.x(b) - this.x(a)), qy = this.y(a) + t * (this.y(b) - this.y(a));
    const flags: string[] = [];
    if (d > 1 && this.crossesOther(e, px, py, qx, qy)) flags.push("acesso_cruza_outra_via");
    if (nearestAny + 10 < d) flags.push("via_mais_proxima_desconectada");
    let confidence = snapConfidence(d);
    if (flags.length && (confidence === "alta" || confidence === "boa")) confidence = "media";
    return {
      lat, lon, edge: e, t, distance: d, flags, nearestAny, confidence,
      snapLat: g.lat[a] + t * (g.lat[b] - g.lat[a]), snapLon: g.lon[a] + t * (g.lon[b] - g.lon[a]),
    };
  }

  /** Projeta no trecho real mais próximo; com `reach`, só em trechos alcançáveis da origem. */
  snap(lat: number, lon: number, maxDist: number, reach?: Uint8Array): Snap {
    const px = lon * this.kx * M_PER_DEG, py = lat * M_PER_DEG;
    const c = this.candidates(px, py, maxDist);
    if (!c.length) throw new SnapError(`Ponto a mais de ${Math.round(maxDist)} m da malha de circulação acessível.`);
    for (const [d, e, t] of c) if (!reach || this.edgeReachable(e, reach)) return this.makeSnap(lat, lon, d, e, t, px, py, c[0][0]);
    throw new SnapError(`Há vias a ${Math.round(c[0][0])} m, mas nenhuma conectada à origem num raio de ${Math.round(maxDist)} m.`);
  }

  /** Elege a malha operacional a partir da ORIGEM (trecho até 30 m além do mais próximo que alcança mais nós). */
  snapOrigin(lat: number, lon: number, maxDist: number, slack = 30): { snap: Snap; reach: Uint8Array } {
    const px = lon * this.kx * M_PER_DEG, py = lat * M_PER_DEG;
    const c = this.candidates(px, py, maxDist);
    if (!c.length) throw new SnapError(`Origem a mais de ${Math.round(maxDist)} m da malha.`);
    let best: { size: number; d: number; e: number; t: number; reach: Uint8Array } | null = null;
    for (const [d, e, t] of c) {
      if (d > c[0][0] + slack) break;
      const reach = this.reachFrom(this.exitNodes(e));
      let size = 0;
      for (let i = 0; i < reach.length; i++) size += reach[i];
      if (!best || size > best.size) best = { size, d, e, t, reach };
    }
    const b = best!;
    const g = this.g;
    if (g.dir[b.e] & 2) b.reach[g.ea[b.e]] = 1;
    if (g.dir[b.e] & 1) b.reach[g.eb[b.e]] = 1;
    const snap = this.makeSnap(lat, lon, b.d, b.e, b.t, px, py, c[0][0]);
    if (b.size < 0.01 * g.n) snap.flags.push("origem_em_trecho_isolado");
    return { snap, reach: b.reach };
  }

  solver(snaps: Snap[]) {
    return new Solver(this, snaps);
  }
}

export interface LegFeature {
  type: "Feature";
  geometry: { type: "LineString"; coordinates: [number, number][] };
  properties: { kind: "path"; mode: Mode; flags: string[]; distance_m: number; time_s: number; streets: string[]; leg?: number };
}

export interface Leg {
  distance: number;
  time: number;
  features: LegFeature[];
  byMode: Record<string, number>;
  flags: Record<string, number>;
}

/** Matriz já calculada, indexada pela ASSINATURA do ponto na malha (aresta + posição), não pela ordem das paradas. */
export interface MatrixCacheData {
  key: string; // hash da malha + perfil
  index: Map<string, number>;
  n: number;
  T: Float64Array;
  D: Float64Array;
}
export interface MatrixStats { total: number; cleanPoints: number; dirtyPoints: number; treesRun: number; fullTrees: number; reusedPairs: number }

/** Assinatura estável do ponto encaixado: mesma aresta e mesma fração => mesmas distâncias. */
export const snapSig = (s: Snap) => `${s.edge}:${Math.round(s.t * 1e7)}`;

/** Grafo da consulta: malha + nós virtuais nas paradas. */
export class Solver {
  readonly r: Router;
  readonly nodes: number[]; // nó de cada parada
  private extra = new Map<number, XArc[]>();
  private vpos: [number, number][] = [];
  private N: number;
  private trees = new Map<number, { time: Float64Array; meters: Float64Array; pNode: Int32Array; pArc: Int32Array; pX: (XArc | null)[] }>();

  constructor(r: Router, snaps: Snap[]) {
    this.r = r;
    const g = r.g;
    let next = g.n;
    const byEdge = new Map<number, Snap[]>();
    this.nodes = snaps.map(() => -1);
    snaps.forEach((s, i) => {
      if (s.t <= 1e-6) this.nodes[i] = g.ea[s.edge];
      else if (s.t >= 1 - 1e-6) this.nodes[i] = g.eb[s.edge];
      else {
        const l = byEdge.get(s.edge) || [];
        l.push(s);
        byEdge.set(s.edge, l);
      }
    });
    byEdge.forEach((group, e) => {
      const ts = [...new Set(group.map((s) => Math.round(s.t * 1e9) / 1e9))].sort((a, b) => a - b);
      const ids = ts.map((t) => {
        const a = g.ea[e], b = g.eb[e];
        this.vpos.push([g.lat[a] + t * (g.lat[b] - g.lat[a]), g.lon[a] + t * (g.lon[b] - g.lon[a])]);
        return next++;
      });
      snaps.forEach((s, i) => {
        if (s.edge === e && this.nodes[i] < 0) this.nodes[i] = ids[ts.indexOf(Math.round(s.t * 1e9) / 1e9)];
      });
      const chain = [g.ea[e], ...ids, g.eb[e]];
      const fr = [0, ...ts, 1];
      for (let k = 0; k < chain.length - 1; k++) {
        if (g.dir[e] & 1) this.addX(chain[k], { to: chain[k + 1], edge: e, f0: fr[k], f1: fr[k + 1] });
        if (g.dir[e] & 2) this.addX(chain[k + 1], { to: chain[k], edge: e, f0: fr[k + 1], f1: fr[k] });
      }
    });
    this.N = next;
  }

  private addX(u: number, a: XArc) {
    const l = this.extra.get(u);
    if (l) l.push(a);
    else this.extra.set(u, [a]);
  }

  latlon(v: number): [number, number] {
    return v < this.r.g.n ? [this.r.g.lat[v], this.r.g.lon[v]] : this.vpos[v - this.r.g.n];
  }

  private arcCost(edge: number, fwd: boolean, frac: number, to: number): [number, number] {
    const r = this.r;
    const t = (fwd ? r.wFwd[edge] : r.wBwd[edge]) * frac + (to < r.g.n ? r.nodePen[to] : 0);
    return [t, r.g.len[edge] * frac];
  }

  /** Dijkstra a partir da parada i; para cedo quando todos os `targets` saem do heap. */
  private tree(i: number, targets?: number[]) {
    const cached = this.trees.get(i);
    if (cached) return cached;
    const N = this.N, r = this.r;
    const key = new Float64Array(N).fill(Infinity);
    const time = new Float64Array(N).fill(Infinity);
    const meters = new Float64Array(N).fill(Infinity);
    const pNode = new Int32Array(N).fill(-1);
    const pArc = new Int32Array(N).fill(-1);
    const pX: (XArc | null)[] = new Array(N).fill(null);
    const done = new Uint8Array(N);
    const s = this.nodes[i];
    key[s] = 0;
    time[s] = 0;
    meters[s] = 0;
    const h = new Heap();
    h.push(0, s);
    let remaining = targets ? new Set(targets) : null;
    while (h.size) {
      const [k, u] = h.pop();
      if (done[u] || k > key[u]) continue;
      done[u] = 1;
      if (remaining) {
        remaining.delete(u);
        if (!remaining.size) break;
      }
      if (u < r.g.n) {
        for (let a = r.off[u]; a < r.off[u + 1]; a++) {
          const v = r.arcTo[a];
          const fwd = r.arcFwd[a] === 1;
          const [t, l] = this.arcCost(r.arcEdge[a], fwd, 1, v);
          const nk = k + t + TIEBREAK * l + 1e-9;
          if (nk < key[v]) {
            key[v] = nk;
            time[v] = time[u] + t;
            meters[v] = meters[u] + l;
            pNode[v] = u;
            pArc[v] = a;
            pX[v] = null;
            h.push(nk, v);
          }
        }
      }
      for (const x of this.extra.get(u) || []) {
        const frac = Math.abs(x.f1 - x.f0);
        const [t, l] = this.arcCost(x.edge, x.f1 > x.f0, frac, x.to);
        const nk = k + t + TIEBREAK * l + 1e-9;
        if (nk < key[x.to]) {
          key[x.to] = nk;
          time[x.to] = time[u] + t;
          meters[x.to] = meters[u] + l;
          pNode[x.to] = u;
          pArc[x.to] = -1;
          pX[x.to] = x;
          h.push(nk, x.to);
        }
      }
    }
    const res = { time, meters, pNode, pArc, pX };
    if (!targets) this.trees.set(i, res);
    return res;
  }

  /** Matrizes de tempo (s) e distância (m) entre todas as paradas. */
  matrices(onProgress?: (p: number) => void, shouldStop?: () => boolean): { T: number[][]; D: number[][] } {
    const k = this.nodes.length;
    const T: number[][] = [], D: number[][] = [];
    for (let i = 0; i < k; i++) {
      if (shouldStop?.()) throw new Error("Cálculo cancelado.");
      const tr = this.tree(i, this.nodes);
      T.push(this.nodes.map((v) => (v === this.nodes[i] ? 0 : tr.time[v])));
      D.push(this.nodes.map((v) => (v === this.nodes[i] ? 0 : tr.meters[v])));
      onProgress?.((i + 1) / k);
    }
    return { T, D };
  }

  /**
   * Como `matrices()`, reaproveitando `cache` (V3 §12). Mover/acrescentar uma parada invalida só a LINHA e a COLUNA dela:
   * os pares entre pontos inalterados vêm do cache (nós virtuais só subdividem arestas, não mudam custos).
   * Pontos novos/alterados ("dirty"): árvore completa (linha); pontos inalterados: árvore parando nos nós dirty (coluna).
   */
  matricesCached(sigs: string[], cache: MatrixCacheData | null, key: string, onProgress?: (p: number) => void, shouldStop?: () => boolean):
    { T: number[][]; D: number[][]; stats: MatrixStats; cache: MatrixCacheData } {
    const k = this.nodes.length;
    const valid = cache && cache.key === key ? cache : null;
    const idx = (i: number) => (valid ? valid.index.get(sigs[i]) : undefined);
    const clean = Array.from({ length: k }, (_, i) => idx(i) !== undefined);
    const dirtyIdx = clean.map((c, i) => (c ? -1 : i)).filter((i) => i >= 0);
    const dirtyNodes = [...new Set(dirtyIdx.map((i) => this.nodes[i]))];
    const T: number[][] = Array.from({ length: k }, () => new Array(k).fill(0));
    const D: number[][] = Array.from({ length: k }, () => new Array(k).fill(0));
    const stats: MatrixStats = { total: k * k, cleanPoints: k - dirtyIdx.length, dirtyPoints: dirtyIdx.length, treesRun: 0, fullTrees: 0, reusedPairs: 0 };
    for (let i = 0; i < k; i++) {
      if (shouldStop?.()) throw new Error("Cálculo cancelado.");
      const ci = clean[i];
      if (!ci || dirtyNodes.length) {
        // linha dirty => todos os destinos; linha limpa => só os destinos dirty
        const tr = this.tree(i, ci ? dirtyNodes : this.nodes);
        stats.treesRun++;
        if (!ci) stats.fullTrees++;
        for (let j = 0; j < k; j++) {
          if (ci && clean[j]) continue;
          const same = this.nodes[j] === this.nodes[i];
          T[i][j] = same ? 0 : tr.time[this.nodes[j]];
          D[i][j] = same ? 0 : tr.meters[this.nodes[j]];
        }
      }
      if (ci) {
        for (let j = 0; j < k; j++) {
          if (!clean[j]) continue;
          const a = idx(i)!, b = idx(j)!;
          T[i][j] = valid!.T[a * valid!.n + b];
          D[i][j] = valid!.D[a * valid!.n + b];
          stats.reusedPairs++;
        }
      }
      onProgress?.((i + 1) / k);
    }
    const index = new Map<string, number>();
    sigs.forEach((sg, i) => { if (!index.has(sg)) index.set(sg, i); });
    const n = k, Tf = new Float64Array(n * n), Df = new Float64Array(n * n);
    for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) { Tf[i * n + j] = T[i][j]; Df[i * n + j] = D[i][j]; }
    return { T, D, stats, cache: { key, index, n, T: Tf, D: Df } };
  }

  /** Geometria real do trecho i -> j, agrupada por modo e sinalizações. */
  leg(i: number, j: number): Leg {
    const g = this.r.g;
    const s = this.nodes[i], t = this.nodes[j];
    const res: Leg = { distance: 0, time: 0, features: [], byMode: {}, flags: {} };
    if (s === t) return res;
    const tr = this.tree(i);
    if (!isFinite(tr.time[t])) throw new Error("Trecho sem caminho válido na malha.");
    const path: { u: number; v: number; edge: number; fwd: boolean; frac: number }[] = [];
    let v = t;
    while (v !== s) {
      const u = tr.pNode[v];
      if (u < 0) throw new Error("Caminho interrompido.");
      const a = tr.pArc[v];
      if (a >= 0) path.push({ u, v, edge: this.r.arcEdge[a], fwd: this.r.arcFwd[a] === 1, frac: 1 });
      else {
        const x = tr.pX[v]!;
        path.push({ u, v, edge: x.edge, fwd: x.f1 > x.f0, frac: Math.abs(x.f1 - x.f0) });
      }
      v = u;
    }
    path.reverse();
    let cur: LegFeature | null = null;
    let curKey = "";
    for (const p of path) {
      const [tt, l] = this.arcCost(p.edge, p.fwd, p.frac, p.v);
      const mode = MODES[this.r.mode[p.edge]];
      const flags = FLAG_NAMES.filter(([f]) => g.eflags[p.edge] & f).map(([, nm]) => nm);
      if (g.dir[p.edge] & (p.fwd ? 4 : 8)) flags.push("contramao_veiculos");
      if (p.v < g.n && g.nodeFlags[p.v] & N_BARRIER) flags.push("barreira");
      if (p.v < g.n && g.nodeFlags[p.v] & N_PRIVATE) flags.push("portao_privado");
      res.distance += l;
      res.time += tt;
      res.byMode[mode] = (res.byMode[mode] || 0) + l;
      for (const f of flags) res.flags[f] = (res.flags[f] || 0) + l;
      const name = g.names[g.nameIdx[p.edge]] || "";
      const k = mode + "|" + flags.join(",");
      const [la, lo] = this.latlon(p.u);
      const [lb, lob] = this.latlon(p.v);
      if (cur && curKey === k) {
        cur.geometry.coordinates.push([lob, lb]);
        cur.properties.distance_m += l;
        cur.properties.time_s += tt;
        if (name && !cur.properties.streets.includes(name)) cur.properties.streets.push(name);
      } else {
        cur = {
          type: "Feature",
          geometry: { type: "LineString", coordinates: [[lo, la], [lob, lb]] },
          properties: { kind: "path", mode, flags, distance_m: l, time_s: tt, streets: name ? [name] : [] },
        };
        curKey = k;
        res.features.push(cur);
      }
    }
    return res;
  }
}
