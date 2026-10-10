/**
 * Sequenciamento no aparelho (sem OR-Tools).
 *
 * Critério lexicográfico (auditoria V2):
 *   1. FACTIBILIDADE — nenhuma sequência com par sem caminho é aceita (validateRoute);
 *   2. COBERTURA — todas as paradas factíveis (as demais saem com motivo: feasibility);
 *   3. TEMPO — deslocamento + atendimento + penalidades configuradas (prioridade, troca de setor);
 *   4. DISTÂNCIA — só desempata (na busca: 1 km vale 1 ms; na escolha final: comparação exata).
 * Busca: vizinho mais próximo, inserção mais barata, 2-opt e Or-opt com avaliação incremental
 * O(1) correta para matrizes ASSIMÉTRICAS (custo do trecho invertido calculado no sentido
 * real), e busca local iterada com perturbação double-bridge e várias sementes, até o limite
 * de tempo ou estagnação. Não garante ótimo global.
 */

export interface SolveInput {
  T: number[][]; // s
  D: number[][]; // m
  start: number;
  stops: number[];
  end?: number | null; // null = rota aberta; = start => circular
  service?: Record<number, number>;
  priority?: Record<number, number>;
  sector?: Record<number, string>;
  timeLimitMs?: number;
  seed?: number;
  compRank?: Record<number, number>;
  baselines?: Record<string, number[]>;
  shouldStop?: () => boolean;
}

export interface Candidate {
  strategy: string;
  order: number[];
  time_s: number;
  distance_m: number;
  cost_s: number;
  feasible: boolean;
  solve_ms: number;
}

export interface Feasibility {
  kept: number[];
  excluded: Record<number, string>;
  compRank: Record<number, number>;
  /** true: cobertura máxima provada (matriz fechada → cadeia exata; ou busca exata) */
  exact?: boolean;
  method?: "scc_chain" | "exact_dp";
}

const EXACT_DP_MAX = 16;

/** T[a][c] <= T[a][b] + T[b][c] (caminhos mínimos sempre satisfazem). */
export function isClosed(T: number[][], nodes: number[], tol = 1e-6): boolean {
  for (const b of nodes)
    for (const a of nodes) {
      const ab = T[a][b];
      if (!isFinite(ab)) continue;
      for (const c of nodes) if (T[a][c] > ab + T[b][c] + tol) return false;
    }
  return true;
}

/** DP exato por máscaras: maior subconjunto de `cand` visitável numa sequência de arcos finitos. */
function exactCover(T: number[][], start: number, cand: number[], end: number | null): number[] {
  const m = cand.length, fin = (a: number, b: number) => isFinite(T[a][b]);
  const parent = new Map<number, number>(); // chave = mask*32+last → chave anterior (-1 = início)
  const key = (mask: number, last: number) => mask * 32 + last;
  for (let i = 0; i < m; i++) if (fin(start, cand[i])) parent.set(key(1 << i, i), -1);
  let best = 0, bestKey = -1;
  for (let mask = 1; mask < 1 << m; mask++) {
    let pop = 0;
    for (let x = mask; x; x &= x - 1) pop++;
    for (let last = 0; last < m; last++) {
      if (!parent.has(key(mask, last))) continue;
      if ((end == null || fin(cand[last], end)) && pop > best) { best = pop; bestKey = key(mask, last); }
      for (let nx = 0; nx < m; nx++) {
        if (mask >> nx & 1 || !fin(cand[last], cand[nx])) continue;
        const k2 = key(mask | 1 << nx, nx);
        if (!parent.has(k2)) parent.set(k2, key(mask, last));
      }
    }
  }
  const order: number[] = [];
  for (let k = bestKey; k !== -1 && k !== undefined; k = parent.get(k)!) order.push(cand[k % 32]);
  return order.reverse();
}

const SECTOR_SWITCH_S = 300;
const DIST_W = 1e-6; // s por metro na busca (1 km = 1 ms): distância só desempata

function rng(seed: number) {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return (s >>> 0) / 4294967296;
  };
}

export function evaluate(order: number[], inp: Pick<SolveInput, "T" | "D" | "start" | "end" | "service">) {
  const seq = [inp.start, ...order, ...(inp.end != null ? [inp.end] : [])];
  let t = 0, d = 0;
  for (let k = 0; k < seq.length - 1; k++) {
    t += inp.T[seq[k]][seq[k + 1]];
    d += inp.D[seq[k]][seq[k + 1]];
  }
  for (const i of order) t += inp.service?.[i] ?? 0;
  return { time: t, dist: d };
}

export function validateRoute(order: number[], T: number[][], start: number, stops: number[], end: number | null): string[] {
  const p: string[] = [];
  if (new Set(order).size !== order.length) p.push("parada visitada mais de uma vez");
  const a = [...order].sort((x, y) => x - y), b = [...stops].sort((x, y) => x - y);
  if (a.length !== b.length || a.some((v, i) => v !== b[i])) p.push("paradas faltando ou a mais");
  const seq = [start, ...order, ...(end != null ? [end] : [])];
  const bad = seq.slice(1).filter((v, k) => !isFinite(T[seq[k]][v])).length;
  if (bad) p.push(`${bad} trecho(s) sem caminho na malha`);
  return p;
}

/** Componentes fortemente conexas (Tarjan iterativo) da relação de alcance entre paradas. */
function scc(nodes: number[], reach: (a: number, b: number) => boolean): number[][] {
  const index = new Map<number, number>(), low = new Map<number, number>(), on = new Set<number>();
  const stack: number[] = [], out: number[][] = [];
  let counter = 0;
  for (const root of nodes) {
    if (index.has(root)) continue;
    const work: [number, number][] = [[root, 0]];
    index.set(root, counter); low.set(root, counter++); stack.push(root); on.add(root);
    while (work.length) {
      const top = work[work.length - 1];
      const v = top[0];
      let advanced = false;
      while (top[1] < nodes.length) {
        const w = nodes[top[1]++];
        if (w === v || !reach(v, w)) continue;
        if (!index.has(w)) {
          index.set(w, counter); low.set(w, counter++); stack.push(w); on.add(w);
          work.push([w, 0]);
          advanced = true;
          break;
        }
        if (on.has(w)) low.set(v, Math.min(low.get(v)!, index.get(w)!));
      }
      if (advanced) continue;
      work.pop();
      if (work.length) { const u = work[work.length - 1][0]; low.set(u, Math.min(low.get(u)!, low.get(v)!)); }
      if (low.get(v) === index.get(v)) {
        const comp: number[] = [];
        for (;;) { const w = stack.pop()!; on.delete(w); comp.push(w); if (w === v) break; }
        out.push(comp);
      }
    }
  }
  return out;
}

/** Maior conjunto de paradas visitáveis numa única sequência (cadeia de componentes). */
export function feasibility(T: number[][], start: number, stops: number[], end: number | null): Feasibility {
  const fin = (a: number, b: number) => isFinite(T[a][b]);
  const excluded: Record<number, string> = {};
  const cand: number[] = [];
  for (const i of stops) {
    if (!fin(start, i)) excluded[i] = "Sem caminho de pedestre a partir da origem.";
    else if (end != null && !fin(i, end)) excluded[i] = end === start ? "Sem caminho de volta à origem (circular)." : "Sem caminho até o destino final.";
    else cand.push(i);
  }
  const nodes = [start, ...cand, ...(end != null && end !== start ? [end] : [])];
  if (cand.length && !isClosed(T, nodes)) {
    // matriz sem fecho transitivo (não é o caso do motor): a cadeia de SCCs deixa de ser exata/segura
    if (cand.length <= EXACT_DP_MAX) {
      const order = exactCover(T, start, cand, end);
      const rank: Record<number, number> = {};
      order.forEach((v, r) => (rank[v] = r));
      for (const v of cand) if (!(v in rank)) excluded[v] = "Fora da maior sequência visitável (busca exata, matriz sem fecho transitivo).";
      return { kept: order, excluded, compRank: rank, exact: true, method: "exact_dp" };
    }
    const ch = chain(T, cand, fin);
    for (const v of cand) if (!(v in ch.compRank)) excluded[v] = "Sem caminho de pedestre que permita visitá-la na mesma sequência das demais.";
    return { ...ch, excluded, exact: false, method: "scc_chain" };
  }
  const ch = chain(T, cand, fin);
  for (const v of cand)
    if (!(v in ch.compRank)) excluded[v] = "Sem caminho de pedestre que permita visitá-la na mesma sequência das demais (trecho de sentido único ou sem saída).";
  return { ...ch, excluded, exact: true, method: "scc_chain" };
}

function chain(T: number[][], cand: number[], fin: (a: number, b: number) => boolean): Feasibility {
  const comps = scc(cand, fin); // ordem topológica reversa
  const cid = new Map<number, number>();
  comps.forEach((c, k) => c.forEach((v) => cid.set(v, k)));
  const succ = comps.map(() => new Set<number>());
  for (const a of cand) for (const b of cand) if (cid.get(a) !== cid.get(b) && fin(a, b)) succ[cid.get(a)!].add(cid.get(b)!);
  const best = comps.map((c) => c.length), next = comps.map(() => -1);
  for (let k = 0; k < comps.length; k++)
    for (const s of succ[k]) if (best[s] + comps[k].length > best[k]) { best[k] = best[s] + comps[k].length; next[k] = s; }
  const kept: number[] = [], compRank: Record<number, number> = {};
  if (comps.length) {
    let k = 0;
    for (let c = 1; c < comps.length; c++) if (best[c] > best[k]) k = c;
    let r = 0;
    while (k !== -1) { for (const v of comps[k]) { compRank[v] = r; kept.push(v); } r++; k = next[k]; }
  }
  return { kept, excluded: {}, compRank };
}

/** Penalidades do objetivo generalizado (NÃO são tempo físico): prioridade e troca de setor. */
export function penalties(order: number[], inp: SolveInput): { priority: number; sector: number } {
  const prio = inp.priority || {}, start = inp.start, svc = (i: number) => inp.service?.[i] ?? 0;
  let priority = 0, sector = 0, clock = 0, prev = start;
  for (const i of order) { clock += inp.T[prev][i]; priority += (prio[i] || 0) * clock; clock += svc(i); prev = i; }
  if (inp.sector) { const seq = [start, ...order]; for (let k = 2; k < seq.length; k++) if (inp.sector[seq[k - 1]] !== inp.sector[seq[k]]) sector += SECTOR_SWITCH_S; }
  return { priority, sector };
}

export function solve(inp: SolveInput): { order: number[]; best: Candidate; candidates: Candidate[] } {
  const { T, D, start, stops } = inp;
  const end = inp.end ?? null;
  const svc = (i: number) => inp.service?.[i] ?? 0;
  const prio = inp.priority || {};
  const hasPrio = Object.values(prio).some((p) => p > 0);
  const sector = inp.sector;
  const limit = inp.timeLimitMs ?? 5000;
  const rank = inp.compRank || {};

  const arc = (a: number, b: number) => {
    const t = T[a][b], d = D[a][b];
    if (!isFinite(t) || !isFinite(d)) return Infinity;
    let c = t + DIST_W * d;
    if (sector && a !== start && sector[a] != null && sector[b] != null && sector[a] !== sector[b]) c += SECTOR_SWITCH_S;
    return c;
  };
  /** custo de busca (tempo + penalidades + desempate por distância), sem o atendimento constante */
  const searchCost = (order: number[]): number => {
    let c = 0, clock = 0, prev = start;
    for (const i of order) {
      c += arc(prev, i);
      clock += T[prev][i];
      if (hasPrio && prio[i]) c += prio[i] * clock;
      clock += svc(i);
      prev = i;
    }
    if (end != null) c += arc(prev, end);
    return c;
  };
  const exactCost = (order: number[]): [number, number] => {
    const e = evaluate(order, inp);
    let pen = 0;
    if (hasPrio) {
      let clock = 0, prev = start;
      for (const i of order) { clock += T[prev][i]; pen += (prio[i] || 0) * clock; clock += svc(i); prev = i; }
    }
    if (sector) { const seq = [start, ...order]; for (let k = 2; k < seq.length; k++) if (sector[seq[k - 1]] !== sector[seq[k]]) pen += SECTOR_SWITCH_S; }
    return [e.time + pen, e.dist];
  };

  const cands: Candidate[] = [];
  const t0all = performance.now();
  const add = (strategy: string, order: number[], t0: number) => {
    let o = [...order];
    let ok = validateRoute(o, T, start, stops, end).length === 0;
    if (!ok && Object.keys(rank).length) {
      o = [...o].sort((a, b) => (rank[a] ?? 0) - (rank[b] ?? 0));
      ok = validateRoute(o, T, start, stops, end).length === 0;
      strategy += "+reparo";
    }
    const e = evaluate(o, inp);
    const [c] = exactCost(o);
    const cand: Candidate = { strategy, order: o, time_s: e.time, distance_m: e.dist, cost_s: c, feasible: ok, solve_ms: Math.round(performance.now() - t0) };
    cands.push(cand);
    return cand;
  };

  if (!stops.length) {
    const c: Candidate = { strategy: "trivial", order: [], time_s: 0, distance_m: 0, cost_s: 0, feasible: true, solve_ms: 0 };
    return { order: [], best: c, candidates: [c] };
  }

  // 1) linhas de base
  let t0 = performance.now();
  const nn: number[] = [];
  {
    const left = new Set(stops);
    let cur = start;
    while (left.size) {
      let best = -1, bc = Infinity;
      for (const j of left) { const c = arc(cur, j); if (best < 0 || c < bc) { bc = c; best = j; } }
      nn.push(best); left.delete(best); cur = best;
    }
  }
  add("nearest_neighbor_baseline", nn, t0);
  for (const [name, o] of Object.entries(inp.baselines || {})) add(`baseline:${name}`, o, performance.now());

  // 2) inserção mais barata
  t0 = performance.now();
  const ins: number[] = [];
  {
    const left = new Set(stops);
    while (left.size) {
      let bj = -1, bp = 0, bd = Infinity;
      for (const j of left) {
        for (let p = 0; p <= ins.length; p++) {
          const a = p === 0 ? start : ins[p - 1];
          const b = p < ins.length ? ins[p] : end;
          const delta = arc(a, j) + (b != null ? arc(j, b) - arc(a, b) : 0);
          if (bj < 0 || delta < bd) { bd = delta; bj = j; bp = p; }
        }
      }
      ins.splice(bp, 0, bj);
      left.delete(bj);
    }
  }

  const deadline = t0all + limit;
  const stop = () => performance.now() > deadline || (inp.shouldStop?.() ?? false);
  const repair = (o: number[]) => (validateRoute(o, T, start, stops, end).length ? [...o].sort((a, b) => (rank[a] ?? 0) - (rank[b] ?? 0)) : o);

  /** Busca local com avaliação incremental (sem prioridade) ou completa (com prioridade). */
  const localSearch = (order: number[]): number[] => {
    let s = repair(order);
    if (hasPrio) {
      let bc = searchCost(s), improved = true;
      while (improved && !stop()) {
        improved = false;
        for (let i = 0; i < s.length - 1 && !stop(); i++)
          for (let j = i + 1; j < s.length; j++) {
            const c2 = s.slice(0, i).concat(s.slice(i, j + 1).reverse(), s.slice(j + 1));
            const c = searchCost(c2);
            if (c < bc - 1e-9) { s = c2; bc = c; improved = true; }
          }
        for (let len = 1; len <= 3; len++)
          for (let i = 0; i + len <= s.length && !stop(); i++) {
            const seg = s.slice(i, i + len), rest = s.slice(0, i).concat(s.slice(i + len));
            for (let p = 0; p <= rest.length; p++) {
              if (p === i) continue;
              const c2 = rest.slice(0, p).concat(seg, rest.slice(p));
              const c = searchCost(c2);
              if (c < bc - 1e-9) { s = c2; bc = c; improved = true; break; }
            }
          }
      }
      return s;
    }
    // ---- incremental: seq = [start, ...s, end?]; x(k) = nó na posição k da seq
    const hasEnd = end != null;
    let seq: number[] = [start, ...s, ...(hasEnd ? [end!] : [])];
    const n = s.length;
    let F = new Float64Array(seq.length), Rf = new Float64Array(seq.length), Ri = new Int32Array(seq.length);
    const build = () => {
      F = new Float64Array(seq.length); Rf = new Float64Array(seq.length); Ri = new Int32Array(seq.length);
      for (let k = 1; k < seq.length; k++) {
        F[k] = F[k - 1] + arc(seq[k - 1], seq[k]);
        const r = arc(seq[k], seq[k - 1]);
        Rf[k] = Rf[k - 1] + (isFinite(r) ? r : 0);
        Ri[k] = Ri[k - 1] + (isFinite(r) ? 0 : 1);
      }
    };
    const A = (u: number, v: number | undefined) => (v === undefined ? 0 : arc(u, v));
    build();
    let improved = true;
    while (improved && !stop()) {
      improved = false;
      // 2-opt: inverte seq[i..j] (posições 1..n)
      outer2: for (let i = 1; i < n && !stop(); i++) {
        for (let j = i + 1; j <= n; j++) {
          const prev = seq[i - 1], first = seq[i], last = seq[j], nxt = seq[j + 1];
          if (Ri[j] - Ri[i] > 0) continue; // trecho invertido teria par impossível
          const oldC = arc(prev, first) + (F[j] - F[i]) + A(last, nxt);
          const newC = arc(prev, last) + (Rf[j] - Rf[i]) + A(first, nxt);
          if (newC < oldC - 1e-9) {
            const mid = seq.slice(i, j + 1).reverse();
            seq = seq.slice(0, i).concat(mid, seq.slice(j + 1));
            build();
            improved = true;
            break outer2;
          }
        }
      }
      // Or-opt: move bloco seq[i..i+L-1] (sem inverter) para entre seq[p-1] e seq[p]
      for (let L = 1; L <= 3 && !stop(); L++) {
        for (let i = 1; i + L - 1 <= n && !stop(); i++) {
          const a = seq[i - 1], f = seq[i], l = seq[i + L - 1], b = seq[i + L];
          const remGain = arc(a, f) + A(l, b) - A(a, b);
          if (!isFinite(remGain)) continue;
          for (let p = 1; p <= n + 1; p++) {
            if (p >= i && p <= i + L) continue; // posição dentro/adjacente ao próprio bloco
            const x = seq[p - 1], y = p <= n ? seq[p] : (hasEnd ? seq[p] : undefined);
            const insCost = arc(x, f) + A(l, y) - A(x, y);
            if (insCost - remGain < -1e-9) {
              const block = seq.slice(i, i + L);
              const rest = seq.slice(0, i).concat(seq.slice(i + L));
              const pos = p > i ? p - L : p;
              seq = rest.slice(0, pos).concat(block, rest.slice(pos));
              build();
              improved = true;
              break;
            }
          }
        }
      }
    }
    return seq.slice(1, 1 + n);
  };

  const lsIns = localSearch(ins);
  add("cheapest_insertion+local_search", lsIns, t0);
  const lsNN = localSearch(nn);
  add("nearest_neighbor+local_search", lsNN, t0);

  // 3) busca local iterada com várias sementes; para por tempo ou estagnação
  const baseSeed = inp.seed ?? 12345;
  let best = searchCost(lsIns) <= searchCost(lsNN) ? lsIns : lsNN;
  let bestC = searchCost(best);
  let iters = 0, sinceImprove = 0;
  for (let seedK = 0; !stop() && best.length >= 8 && sinceImprove < 400; seedK++) {
    const rand = rng(baseSeed + seedK * 7919);
    let cur = best, curC = bestC;
    for (let it = 0; it < 60 && !stop(); it++) {
      const n = cur.length;
      const a = 1 + Math.floor(rand() * (n / 4)), b = a + 1 + Math.floor(rand() * (n / 4)), c = b + 1 + Math.floor(rand() * (n / 4));
      if (c >= n) continue;
      const pert = cur.slice(0, a).concat(cur.slice(c), cur.slice(b, c), cur.slice(a, b));
      const ls = localSearch(pert);
      const cc = searchCost(ls);
      iters++;
      if (cc < curC - 1e-9) {
        cur = ls; curC = cc;
        if (cc < bestC - 1e-9) { best = ls; bestC = cc; sinceImprove = 0; } else sinceImprove++;
      } else sinceImprove++;
    }
  }
  add(`iterated_local_search(${iters})`, best, t0);

  const feasible = cands.filter((c) => c.feasible);
  if (!feasible.length) throw new Error("Nenhuma sequência factível encontrada (há pares sem caminho na malha).");
  const pick = feasible.reduce((x, y) => {
    const cx = Math.round(x.cost_s * 1000), cy = Math.round(y.cost_s * 1000);
    return cy < cx || (cy === cx && y.distance_m < x.distance_m) ? y : x;
  });
  return { order: pick.order, best: pick, candidates: cands };
}
