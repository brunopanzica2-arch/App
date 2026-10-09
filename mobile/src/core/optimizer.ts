/**
 * Sequenciamento no aparelho (sem OR-Tools): construção + busca local
 * (2-opt, Or-opt) + perturbação iterada (ILS) até o limite de tempo.
 * Objetivo = tempo total (ms) + 1 por metro (desempate) + penalidades
 * (setor/bairro no modo por setores; prioridade sobre o horário de chegada).
 * Não garante ótimo global. Validado contra o OR-Tools em tests/optimizer.test.ts.
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
}

export interface Candidate {
  strategy: string;
  order: number[];
  objective: number;
  time_s: number;
  distance_m: number;
  solve_ms: number;
}

const SECTOR_SWITCH_S = 300;
const BIG = 1e12;

function rng(seed: number) {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return (s >>> 0) / 4294967296;
  };
}

export function evaluate(order: number[], inp: SolveInput): { time: number; dist: number } {
  const seq = [inp.start, ...order, ...(inp.end != null ? [inp.end] : [])];
  let t = 0, d = 0;
  for (let k = 0; k < seq.length - 1; k++) {
    t += inp.T[seq[k]][seq[k + 1]];
    d += inp.D[seq[k]][seq[k + 1]];
  }
  for (const i of order) t += inp.service?.[i] ?? 0;
  return { time: t, dist: d };
}

export function solve(inp: SolveInput): { order: number[]; best: Candidate; candidates: Candidate[] } {
  const { T, D, start, stops } = inp;
  const end = inp.end ?? null;
  const svc = (i: number) => inp.service?.[i] ?? 0;
  const prio = inp.priority || {};
  const hasPrio = Object.values(prio).some((p) => p > 0);
  const sector = inp.sector;
  const limit = inp.timeLimitMs ?? 5000;
  const rand = rng(inp.seed ?? 12345);

  const arc = (a: number, b: number) => {
    const t = T[a][b], d = D[a][b];
    if (!isFinite(t) || !isFinite(d)) return BIG;
    let c = t * 1000 + d;
    if (sector && sector[a] != null && sector[b] != null && sector[a] !== sector[b]) c += SECTOR_SWITCH_S * 1000;
    return c;
  };
  const cost = (order: number[]): number => {
    let c = 0, clock = 0, prev = start;
    for (const i of order) {
      c += arc(prev, i);
      clock += T[prev][i];
      if (hasPrio && prio[i]) c += prio[i] * clock * 1000;
      clock += svc(i);
      prev = i;
    }
    if (end != null) c += arc(prev, end);
    return c;
  };

  const cands: Candidate[] = [];
  const finish = (strategy: string, order: number[], t0: number) => {
    const e = evaluate(order, inp);
    const c: Candidate = {
      strategy, order: [...order], objective: Math.round(cost(order)), time_s: e.time, distance_m: e.dist,
      solve_ms: Math.round(performance.now() - t0),
    };
    cands.push(c);
    return c;
  };

  if (!stops.length) {
    const c: Candidate = { strategy: "trivial", order: [], objective: 0, time_s: 0, distance_m: 0, solve_ms: 0 };
    return { order: [], best: c, candidates: [c] };
  }

  // 1) vizinho mais próximo (linha de base)
  let t0 = performance.now();
  const nn: number[] = [];
  {
    const left = new Set(stops);
    let cur = start;
    while (left.size) {
      let best = -1, bc = Infinity;
      for (const j of left) {
        const c = arc(cur, j);
        if (c < bc) {
          bc = c;
          best = j;
        }
      }
      nn.push(best);
      left.delete(best);
      cur = best;
    }
  }
  finish("nearest_neighbor_baseline", nn, t0);

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
          if (delta < bd) {
            bd = delta;
            bj = j;
            bp = p;
          }
        }
      }
      ins.splice(bp, 0, bj);
      left.delete(bj);
    }
  }

  const deadline = performance.now() + limit;
  const localSearch = (order: number[]): number[] => {
    let best = order.slice();
    let bc = cost(best);
    let improved = true;
    while (improved && performance.now() < deadline) {
      improved = false;
      const n = best.length;
      // 2-opt (inverte trecho; custo assimétrico avaliado por completo)
      for (let i = 0; i < n - 1 && performance.now() < deadline; i++) {
        for (let j = i + 1; j < n; j++) {
          const cand = best.slice(0, i).concat(best.slice(i, j + 1).reverse(), best.slice(j + 1));
          const c = cost(cand);
          if (c < bc - 1e-6) {
            best = cand;
            bc = c;
            improved = true;
          }
        }
      }
      // Or-opt: move blocos de 1 a 3 paradas
      for (let len = 1; len <= 3; len++) {
        for (let i = 0; i + len <= best.length && performance.now() < deadline; i++) {
          const seg = best.slice(i, i + len);
          const rest = best.slice(0, i).concat(best.slice(i + len));
          for (let p = 0; p <= rest.length; p++) {
            if (p === i) continue;
            const cand = rest.slice(0, p).concat(seg, rest.slice(p));
            const c = cost(cand);
            if (c < bc - 1e-6) {
              best = cand;
              bc = c;
              improved = true;
              break;
            }
          }
        }
      }
    }
    return best;
  };

  const lsIns = localSearch(ins);
  finish("cheapest_insertion+local_search", lsIns, t0);
  const lsNN = localSearch(nn);
  finish("nearest_neighbor+local_search", lsNN, t0);

  // 3) busca local iterada (perturbação double-bridge) até o limite
  let cur = cost(lsIns) <= cost(lsNN) ? lsIns : lsNN;
  let curC = cost(cur);
  let best = cur, bestC = curC;
  let iters = 0;
  while (performance.now() < deadline && cur.length >= 8) {
    const n = cur.length;
    const p = [1 + Math.floor(rand() * (n / 4)), 0, 0];
    p[1] = p[0] + 1 + Math.floor(rand() * (n / 4));
    p[2] = p[1] + 1 + Math.floor(rand() * (n / 4));
    if (p[2] >= n) continue;
    const pert = cur.slice(0, p[0]).concat(cur.slice(p[2]), cur.slice(p[1], p[2]), cur.slice(p[0], p[1]));
    const ls = localSearch(pert);
    const c = cost(ls);
    if (c < curC) {
      cur = ls;
      curC = c;
      if (c < bestC) {
        best = ls;
        bestC = c;
      }
    }
    iters++;
  }
  finish(`iterated_local_search(${iters})`, best, t0);

  const solved = cands.filter((c) => c.strategy !== "nearest_neighbor_baseline");
  const winner = solved.reduce((a, b) => (b.objective < a.objective ? b : a));
  return { order: winner.order, best: winner, candidates: cands };
}
