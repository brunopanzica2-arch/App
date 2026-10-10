/** Item 18 da auditoria: Python (backend) x TypeScript (app) no MESMO cenário real de 150 posições TESTE. */
import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseGraph } from "../src/core/graph";
import { evaluate, feasibility, solve, validateRoute } from "../src/core/optimizer";
import { computePlan } from "../src/core/plan";
import { DEFAULT_PROFILE, Router } from "../src/core/router";

const FILE = new URL("../../test-data/resultados/paridade_150_open.json", import.meta.url);
const buf = readFileSync(new URL("../public/santos-graph.bin", import.meta.url));
const graph = parseGraph(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));

describe.skipIf(!existsSync(FILE))("paridade backend x app — 150 posições TESTE (Centro/Paquetá/Vila Nova)", () => {
  const P = JSON.parse(readFileSync(FILE, "utf8"));
  const inf = (x: number) => (x < 0 ? Infinity : x);
  const Tb: number[][] = P.T.map((r: number[]) => r.map(inf));
  const Db: number[][] = P.D.map((r: number[]) => r.map(inf));

  it("matriz de tempo e distância do app = backend (tolerância 0,1% + 0,5 m/0,05 s)", () => {
    const r = new Router(graph, { ...DEFAULT_PROFILE, ride_speed_kmh: 15, pedestrian: false });
    const { snap, reach } = r.snapOrigin(P.points[0][0], P.points[0][1], 150);
    const snaps = [snap, ...P.points.slice(1).map((p: number[]) => r.snap(p[0], p[1], 150, reach))];
    snaps.forEach((s, i) => {
      expect(s.distance).toBeCloseTo(P.snap[i].d, 1);
      expect([...s.flags].sort()).toEqual([...P.snap[i].flags].sort());
    });
    const { T, D } = r.solver(snaps).matrices();
    let maxRel = 0;
    for (let i = 0; i < T.length; i++)
      for (let j = 0; j < T.length; j++) {
        expect(isFinite(T[i][j])).toBe(isFinite(Tb[i][j]));
        if (!isFinite(T[i][j])) continue;
        expect(Math.abs(T[i][j] - Tb[i][j])).toBeLessThan(0.05 + 1e-3 * Tb[i][j]);
        expect(Math.abs(D[i][j] - Db[i][j])).toBeLessThan(0.5 + 1e-3 * Db[i][j]);
        if (Tb[i][j] > 0) maxRel = Math.max(maxRel, Math.abs(T[i][j] - Tb[i][j]) / Tb[i][j]);
      }
    console.log(`paridade de matriz 151x151: maior diferença relativa ${(maxRel * 100).toFixed(4)}%`);
  });

  it("mesma factibilidade e otimizador do app <= 3% do OR-Tools na mesma matriz", () => {
    const stops = Array.from({ length: Tb.length - 1 }, (_, i) => i + 1);
    const f = feasibility(Tb, 0, stops, null);
    expect([...f.kept].sort((a, b) => a - b)).toEqual([...P.kept].sort((a: number, b: number) => a - b));
    const service = Object.fromEntries(Object.entries(P.service).map(([k, v]) => [+k, v as number]));
    for (const seed of [1, 2, 3]) {
      const res = solve({ T: Tb, D: Db, start: 0, stops: f.kept, end: null, service, timeLimitMs: 6000, compRank: f.compRank, seed });
      expect(validateRoute(res.order, Tb, 0, f.kept, null)).toEqual([]);
      const e = evaluate(res.order, { T: Tb, D: Db, start: 0, end: null, service });
      const ratio = e.time / P.backend_time_s;
      console.log(`seed ${seed}: app ${(e.time / 60).toFixed(1)} min / ${(e.dist / 1000).toFixed(2)} km x backend ${(P.backend_time_s / 60).toFixed(1)} min / ${(P.backend_dist_m / 1000).toFixed(2)} km (razão ${ratio.toFixed(4)})`);
      expect(ratio).toBeLessThan(1.03);
    }
  });

  it("plano completo no app (snap + matriz + otimização + geometria) com 150 paradas", () => {
    const res = computePlan(graph, {
      start: { lat: P.points[0][0], lon: P.points[0][1] }, mode: "open", strategy: "global",
      profile: { ...DEFAULT_PROFILE, ride_speed_kmh: 15, pedestrian: false }, timeLimitMs: 6000, maxSnap: 150,
      stops: P.points.slice(1).map((p: number[], i: number) => ({ key: `K${i + 1}`, lat: p[0], lon: p[1], service: P.service[String(i + 1)] })),
    });
    expect(res.status).toBe("complete");
    expect(res.order.length).toBe(150);
    expect(new Set(res.order.map((o) => o.key)).size).toBe(150);
    // geometria contínua: cada trecho começa onde o anterior terminou
    for (let k = 1; k < res.features.length; k++) {
      const a = res.features[k - 1], b = res.features[k];
      if (a.properties.leg === b.properties.leg) expect(b.geometry.coordinates[0]).toEqual(a.geometry.coordinates.at(-1));
    }
    console.log(`app: ${(res.totalDistance / 1000).toFixed(2)} km, ${(res.totalTime / 60).toFixed(1)} min (viagem ${(res.travelTime / 60).toFixed(1)}), matriz ${res.timings.matrix_ms} ms, solver ${res.timings.solve_ms} ms`);
  });
});
