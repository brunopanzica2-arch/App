/** V3 §7.3: factibilidade ótima (comparada com busca exata) também no app. */
import { describe, expect, it } from "vitest";
import { feasibility, isClosed, solve, validateRoute } from "../src/core/optimizer";

function rng(seed: number) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}
function digraph(r: () => number, n: number, p: number): number[][] {
  const A = Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_, j) => (i === j ? 0 : r() < p ? 1 + Math.floor(r() * 9) : Infinity)));
  return A;
}
function floyd(A: number[][]): number[][] {
  const d = A.map((r) => r.slice()), n = d.length;
  for (let k = 0; k < n; k++) for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) if (d[i][k] + d[k][j] < d[i][j]) d[i][j] = d[i][k] + d[k][j];
  return d;
}
function exactMax(T: number[][], start: number, stops: number[], end: number | null): number {
  const m = stops.length, fin = (a: number, b: number) => isFinite(T[a][b]);
  const ok = new Set<number>();
  for (let i = 0; i < m; i++) if (fin(start, stops[i])) ok.add((1 << i) * 32 + i);
  let best = 0;
  for (let mask = 1; mask < 1 << m; mask++)
    for (let l = 0; l < m; l++) {
      if (!ok.has(mask * 32 + l)) continue;
      if (end == null || fin(stops[l], end)) best = Math.max(best, mask.toString(2).replace(/0/g, "").length);
      for (let x = 0; x < m; x++) if (!(mask >> x & 1) && fin(stops[l], stops[x])) ok.add((mask | 1 << x) * 32 + x);
    }
  return best;
}

describe("[V3 §7.3] factibilidade vs busca exata", () => {
  for (const mode of ["open", "circular"] as const)
    it(`matrizes de caminho mínimo (${mode}): cadeia = ótimo, e o solver devolve sequência válida`, () => {
      const r = rng(7);
      for (let it = 0; it < 120; it++) {
        const n = 5 + Math.floor(r() * 5);
        const T = floyd(digraph(r, n, [0.15, 0.25, 0.4][it % 3]));
        const stops = Array.from({ length: Math.min(n, 8) - 1 }, (_, i) => i + 1);
        const end = mode === "circular" ? 0 : null;
        const f = feasibility(T, 0, stops, end);
        const reach = stops.filter((s) => isFinite(T[0][s]) && (end == null || isFinite(T[s][0])));
        expect(f.kept.length).toBe(exactMax(T, 0, reach, end));
        expect(isClosed(T, [0, ...stops])).toBe(true);
        if (f.kept.length) {
          const res = solve({ T, D: T, start: 0, stops: f.kept, end, timeLimitMs: 30, compRank: f.compRank });
          expect(validateRoute(res.order, T, 0, f.kept, end)).toEqual([]);
        }
      }
    });

  it("matrizes sem fecho transitivo usam busca exata e nunca mantêm conjunto inseguro", () => {
    const r = rng(5);
    for (const p of [0.12, 0.2, 0.3])
      for (let it = 0; it < 150; it++) {
        const n = 5 + Math.floor(r() * 5);
        const T = digraph(r, n, p);
        const stops = Array.from({ length: n - 1 }, (_, i) => i + 1);
        const f = feasibility(T, 0, stops, null);
        const reach = stops.filter((s) => isFinite(T[0][s]));
        expect(f.kept.length).toBe(exactMax(T, 0, reach, null));
        expect(validateRoute(f.kept, T, 0, f.kept, null)).toEqual([]);
      }
  });
});

import { readFileSync } from "node:fs";
import { parseGraph } from "../src/core/graph";
import { computePlan } from "../src/core/plan";
import { DEFAULT_PROFILE } from "../src/core/router";

describe("[V3 §7.1] decomposição do tempo no app", () => {
  it("ETA = deslocamento + serviço + acesso; penalidade de prioridade fica fora do ETA", () => {
    const buf = readFileSync(new URL("../public/santos-graph.bin", import.meta.url));
    const g = parseGraph(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
    const P = JSON.parse(readFileSync(new URL("../../test-data/resultados/paridade_150_open.json", import.meta.url), "utf8"));
    const pts: number[][] = P.points.slice(0, 31);
    const res = computePlan(g, {
      start: { lat: pts[0][0], lon: pts[0][1] }, mode: "open", strategy: "global", profile: { ...DEFAULT_PROFILE, ride_speed_kmh: 15, pedestrian: false },
      timeLimitMs: 800, maxSnap: 150,
      stops: pts.slice(1).map((p, i) => ({ key: `K${i}`, lat: p[0] + (i === 3 ? 0.00015 : 0), lon: p[1], service: 45, priority: i < 2 ? 2 : 0 })),
    });
    const b = res.timeBreakdown;
    expect(b.estimatedDuration).toBeCloseTo(b.travel + b.service + b.access, 3);
    expect(b.estimatedDuration).toBeCloseTo(res.totalTime, 3);
    expect(b.service).toBeCloseTo(45 * res.order.length, 3);
    expect(b.access).toBeGreaterThan(0);
    expect(b.priorityPenalty).toBeGreaterThan(0);
    expect(b.generalizedObjective).toBeCloseTo(b.estimatedDuration + b.priorityPenalty + b.sectorPenalty, 3);
  });
});
