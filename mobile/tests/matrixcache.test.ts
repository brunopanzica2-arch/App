/** V3 §12: cache de matriz por assinatura do ponto + invalidação incremental == reconstrução total; partida a quente. */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseGraph } from "../src/core/graph";
import { clearMatrixCache, computePlan, graphKey } from "../src/core/plan";
import { DEFAULT_PROFILE, Router, snapSig } from "../src/core/router";

const buf = readFileSync(new URL("../public/santos-graph.bin", import.meta.url));
const graph = parseGraph(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
const P = JSON.parse(readFileSync(new URL("../../test-data/resultados/paridade_150_open.json", import.meta.url), "utf8"));
const PTS: number[][] = P.points; // [0] = origem TESTE, depois 150 posições TESTE
const profile = { ...DEFAULT_PROFILE, ride_speed_kmh: 15, pedestrian: false };
const key = () => `${graphKey(graph)}|${JSON.stringify(profile)}`;

function build(points: number[][]) {
  const r = new Router(graph, profile);
  const { snap, reach } = r.snapOrigin(points[0][0], points[0][1], 150);
  const snaps = [snap, ...points.slice(1).map((p) => r.snap(p[0], p[1], 150, reach))];
  return { solver: r.solver(snaps), sigs: snaps.map(snapSig) };
}
function maxDiff(A: number[][], B: number[][]) {
  let m = 0;
  for (let i = 0; i < A.length; i++) for (let j = 0; j < A.length; j++) {
    if (!isFinite(A[i][j]) || !isFinite(B[i][j])) { expect(isFinite(A[i][j])).toBe(isFinite(B[i][j])); continue; }
    m = Math.max(m, Math.abs(A[i][j] - B[i][j]));
  }
  return m;
}

describe("matriz em cache: incremental == total", () => {
  const first = build(PTS);
  const cold = first.solver.matricesCached(first.sigs, null, key());

  it("primeira execução: tudo calculado, e igual à matriz total", () => {
    expect(cold.stats.dirtyPoints).toBe(151);
    const full = first.solver.matrices();
    expect(maxDiff(cold.T, full.T)).toBe(0);
    expect(maxDiff(cold.D, full.D)).toBe(0);
  });

  it("só mudou o status (50 paradas concluídas saem): submatriz do cache, ZERO árvores de Dijkstra", () => {
    const remaining = [PTS[0], ...PTS.slice(1).filter((_, i) => i >= 50)];
    const b = build(remaining);
    const inc = b.solver.matricesCached(b.sigs, cold.cache, key());
    expect(inc.stats).toMatchObject({ dirtyPoints: 0, treesRun: 0, cleanPoints: 101 });
    const full = b.solver.matrices();
    expect(maxDiff(inc.T, full.T)).toBeLessThan(1e-6);
    expect(maxDiff(inc.D, full.D)).toBeLessThan(1e-6);
  });

  it("mover UMA portaria: só 1 linha completa; o resto é coluna parcial; resultado == reconstrução total", () => {
    const moved = PTS.map((p) => p.slice());
    moved[77] = [PTS[77][0] + 0.0009, PTS[77][1] + 0.0007]; // ~110 m
    const b = build(moved);
    expect(b.sigs.filter((s, i) => s !== first.sigs[i]).length).toBe(1);
    const inc = b.solver.matricesCached(b.sigs, cold.cache, key());
    expect(inc.stats).toMatchObject({ dirtyPoints: 1, fullTrees: 1 });
    expect(inc.stats.treesRun).toBe(151); // 1 linha completa + 150 colunas parciais (param ao achar o nó movido)
    const full = b.solver.matrices();
    expect(maxDiff(inc.T, full.T)).toBeLessThan(1e-6);
    expect(maxDiff(inc.D, full.D)).toBeLessThan(1e-6);
    // pares entre pontos inalterados idênticos ao cache
    expect(inc.T[3][9]).toBe(cold.T[3][9]);
  });

  it("acrescentar 3 cartas novas em endereços novos == reconstrução total", () => {
    const extra = [[-23.9455, -46.3329], [-23.9531, -46.3372], [-23.9402, -46.3281]];
    const b = build([...PTS, ...extra]);
    const inc = b.solver.matricesCached(b.sigs, cold.cache, key());
    expect(inc.stats.dirtyPoints).toBeGreaterThanOrEqual(1);
    expect(inc.stats.dirtyPoints).toBeLessThanOrEqual(3);
    const full = b.solver.matrices();
    expect(maxDiff(inc.T, full.T)).toBeLessThan(1e-6);
    expect(maxDiff(inc.D, full.D)).toBeLessThan(1e-6);
  });

  it("perfil diferente invalida o cache (nada de custo antigo)", () => {
    const b = build(PTS);
    const inc = b.solver.matricesCached(b.sigs, cold.cache, key() + "|outro");
    expect(inc.stats.dirtyPoints).toBe(151);
  });
});

describe("computePlan com cacheKey", () => {
  const stops = (pts: number[][], from = 0) => pts.slice(1).map((p, i) => ({ key: `K${i + 1}`, lat: p[0], lon: p[1], service: 45 })).slice(from);
  const req = (st: ReturnType<typeof stops>) => ({
    start: { lat: PTS[0][0], lon: PTS[0][1] }, mode: "open" as const, strategy: "global" as const, profile, timeLimitMs: 600, maxSnap: 150, stops: st, cacheKey: "lote-x",
  });

  it("replanejar só os pendentes usa o cache e a rota anterior como partida a quente", () => {
    clearMatrixCache();
    const a = computePlan(graph, req(stops(PTS.slice(0, 61))));
    expect(a.matrixStats).toMatchObject({ cacheHit: false, warmStart: false });
    expect(a.order.length).toBe(60);
    const done = new Set(a.order.slice(0, 20).map((o) => o.key));
    const b = computePlan(graph, req(stops(PTS.slice(0, 61)).filter((s) => !done.has(s.key))));
    expect(b.order.length).toBe(40);
    expect(b.matrixStats).toMatchObject({ cacheHit: true, warmStart: true, dirtyPoints: 0, treesRun: 0 });
    expect(b.candidates.some((c) => c.strategy === "warm_start+local_search" && c.feasible)).toBe(true);
    // nenhuma parada concluída reaparece e nenhuma pendente some
    expect(b.order.every((o) => !done.has(o.key))).toBe(true);
    expect(new Set(b.order.map((o) => o.key)).size).toBe(40);
  }, 60000);

  it("sem cacheKey o comportamento é o de antes (sem estatística de cache)", () => {
    const { cacheKey: _c, ...r } = req(stops(PTS.slice(0, 21)));
    expect(computePlan(graph, r).matrixStats).toBeUndefined();
  });

  it("graphKey é estável", () => { expect(graphKey(graph)).toBe(graphKey(graph)); });
});
