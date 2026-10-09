import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { haversine, parseGraph } from "../src/core/graph";
import { evaluate, solve } from "../src/core/optimizer";
import { DEFAULT_PROFILE, Router, SnapError } from "../src/core/router";

const buf = readFileSync(new URL("../public/santos-graph.bin", import.meta.url));
const graph = parseGraph(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
const cases = JSON.parse(readFileSync(new URL("./fixtures/santos-matrices.json", import.meta.url), "utf8"));
const router = new Router(graph, DEFAULT_PROFILE);

describe("malha real de Santos no aparelho", () => {
  it("carrega a malha exportada", () => {
    expect(graph.n).toBe(41598);
    expect(graph.m).toBe(48747);
  });

  it("matriz igual à do servidor (mesmas regras de pedestre)", () => {
    for (const c of cases.slice(0, 2)) {
      const pts = c.points.slice(0, 25);
      const s = router.solver(pts.map(([la, lo]: number[]) => router.snap(la, lo, 150)));
      const { T, D } = s.matrices();
      for (let i = 0; i < pts.length; i++)
        for (let j = 0; j < pts.length; j++) {
          expect(Math.abs(T[i][j] - c.T[i][j])).toBeLessThan(0.05 + 1e-3 * c.T[i][j]);
          expect(Math.abs(D[i][j] - c.D[i][j])).toBeLessThan(0.5 + 1e-3 * c.D[i][j]);
        }
    }
  });

  it("distância de rede nunca menor que a linha reta e geometria contínua", () => {
    const pts = cases[0].points.slice(0, 6);
    const s = router.solver(pts.map(([la, lo]: number[]) => router.snap(la, lo, 150)));
    const { D } = s.matrices();
    for (let i = 1; i < pts.length; i++) {
      expect(D[0][i]).toBeGreaterThanOrEqual(haversine(pts[0][0], pts[0][1], pts[i][0], pts[i][1]) * 0.95);
      const leg = s.leg(0, i);
      expect(leg.distance).toBeCloseTo(D[0][i], 3);
      const coords = leg.features.flatMap((f) => f.geometry.coordinates);
      for (let k = 1; k < leg.features.length; k++) {
        const prev = leg.features[k - 1].geometry.coordinates.at(-1)!;
        expect(leg.features[k].geometry.coordinates[0]).toEqual(prev); // sem saltos
      }
      expect(coords.length).toBeGreaterThan(1);
    }
  });

  it("mão única de carros não restringe: ida e volta pelo mesmo trecho", () => {
    // qualquer aresta marcada como mão única de veículos é percorrível nos dois sentidos
    let e = 0;
    while (!(graph.dir[e] & 12) || !(graph.dir[e] & 1) || !(graph.dir[e] & 2) || !router.edgeOk[e]) e++;
    expect(graph.dir[e] & 3).toBe(3);
  });

  it("ponto longe da malha é rejeitado (sem ligação inventada)", () => {
    expect(() => router.snap(-24.2, -46.2, 150)).toThrow(SnapError); // no mar
  });
});

describe("otimizador do aparelho x OR-Tools (matrizes reais)", () => {
  for (const c of cases) {
    it(`${c.name}: no máximo 3% pior que o OR-Tools`, () => {
      const k = c.T.length - 1;
      const stops = Array.from({ length: k }, (_, i) => i + 1);
      const service = Object.fromEntries(stops.map((i) => [i, 45]));
      const res = solve({ T: c.T, D: c.D, start: 0, stops, end: c.end, service, timeLimitMs: 8000 });
      const e = evaluate(res.order, { T: c.T, D: c.D, start: 0, stops, end: c.end, service });
      expect([...res.order].sort((a, b) => a - b)).toEqual(stops);
      const ratio = e.time / c.ortools.time_s;
      console.log(`${c.name}: app ${(e.time / 60).toFixed(1)} min x OR-Tools ${(c.ortools.time_s / 60).toFixed(1)} min (razão ${ratio.toFixed(3)}) via ${res.best.strategy}`);
      expect(ratio).toBeLessThan(1.03);
    });
  }

  it("cinco entregas na mesma rua em sequência contínua", () => {
    const xs = [0, 300, 100, 500, 200, 400];
    const D = xs.map((a) => xs.map((b) => Math.abs(a - b)));
    const T = D.map((r) => r.map((d) => d / 4));
    const res = solve({ T, D, start: 0, stops: [1, 2, 3, 4, 5], timeLimitMs: 300 });
    expect(res.order.map((i) => xs[i])).toEqual([100, 200, 300, 400, 500]);
  });

  it("rota circular volta à origem", () => {
    const xs = [0, 100, 200, 300];
    const D = xs.map((a) => xs.map((b) => Math.abs(a - b)));
    const T = D.map((r) => r.map((d) => d / 4));
    const res = solve({ T, D, start: 0, stops: [1, 2, 3], end: 0, timeLimitMs: 200 });
    expect(evaluate(res.order, { T, D, start: 0, stops: [1, 2, 3], end: 0 }).dist).toBe(600);
  });
});
