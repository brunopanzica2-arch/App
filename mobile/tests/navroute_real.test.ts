// Manobras sobre uma rota REAL calculada na malha OSM de Santos (150 posições TESTE; nenhuma é porta real).
import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseGraph } from "../src/core/graph";
import { buildNavRoute } from "../src/core/navroute";
import { computePlan } from "../src/core/plan";
import { DEFAULT_PROFILE } from "../src/core/router";

const FILE = new URL("../../test-data/resultados/paridade_150_open.json", import.meta.url);
const buf = readFileSync(new URL("../public/santos-graph.bin", import.meta.url));
const graph = parseGraph(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));

describe.skipIf(!existsSync(FILE))("manobras em rota real (150 paradas)", () => {
  it("geometria, manobras e paradas coerentes", () => {
    const P = JSON.parse(readFileSync(FILE, "utf8"));
    const plan = computePlan(graph, {
      start: { lat: P.points[0][0], lon: P.points[0][1] }, mode: "open", strategy: "global", profile: { ...DEFAULT_PROFILE, ride_speed_kmh: 15 }, timeLimitMs: 3000, maxSnap: 150,
      stops: P.points.slice(1).map((p: number[], i: number) => ({ key: `K${i + 1}`, lat: p[0], lon: p[1], service: 45 })),
    });
    const r = buildNavRoute(plan, { lat: P.points[0][0], lon: P.points[0][1] }, new Map());
    // distância da geometria ≈ distância do plano (±2%)
    expect(Math.abs(r.length - plan.totalDistance) / plan.totalDistance).toBeLessThan(0.02);
    expect(r.stops.length).toBe(150);
    for (let i = 1; i < r.stops.length; i++) expect(r.stops[i].at).toBeGreaterThanOrEqual(r.stops[i - 1].at);
    for (let i = 1; i < r.maneuvers.length; i++) expect(r.maneuvers[i].at).toBeGreaterThan(r.maneuvers[i - 1].at);
    const named = r.maneuvers.filter((m) => m.street).length / r.maneuvers.length;
    const kinds: Record<string, number> = {};
    r.maneuvers.forEach((m) => (kinds[m.kind] = (kinds[m.kind] || 0) + 1));
    console.log(`rota real: ${(r.length / 1000).toFixed(2)} km, ${r.lat.length} vértices, ${r.maneuvers.length} manobras (${(r.length / r.maneuvers.length).toFixed(0)} m/manobra), com nome de rua ${(named * 100).toFixed(0)}%`, JSON.stringify(kinds));
    expect(r.maneuvers.length).toBeGreaterThan(50);
    expect(r.length / r.maneuvers.length).toBeGreaterThan(25); // sem enxurrada de instruções
  });
});
