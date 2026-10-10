import { describe, expect, it } from "vitest";
import { buildNavRoute, classify, turnAngle } from "../src/core/navroute";

// ruas fictícias em torno de (-23.96, -46.33): ~111 km/grau
const M = 1 / 111000;
const feat = (leg: number, pts: [number, number][], streets: string[]) => ({
  type: "Feature" as const, geometry: { type: "LineString" as const, coordinates: pts.map(([la, lo]) => [lo, la] as [number, number]) },
  properties: { kind: "path" as const, mode: "calcada" as any, flags: [], distance_m: 0, time_s: 0, streets: [...new Set(streets)], leg, segStreets: streets },
});
const order = (key: string, seq: number) => ({ key, seq, eta: 0, legDistance: 0, legTime: 0, snapDistance: 0, access: 0, confidence: "", flags: [] });

describe("manobras a partir da geometria", () => {
  it("classificação de ângulos", () => {
    expect(classify(0)).toBeNull();
    expect(classify(20)).toBeNull();
    expect(classify(90)).toBe("right");
    expect(classify(-90)).toBe("left");
    expect(classify(35)).toBe("slight_right");
    expect(classify(-150)).toBe("sharp_left");
    expect(classify(180)).toBe("uturn");
    expect(turnAngle(350, 10)).toBe(20);
    expect(turnAngle(10, 350)).toBe(-20);
  });

  it("norte 100 m na Rua A, depois leste 100 m na Rua B → uma curva à direita para a Rua B", () => {
    const a: [number, number] = [-23.96, -46.33], b: [number, number] = [a[0] + 100 * M, a[1]], c: [number, number] = [b[0], b[1] + 100 * M / Math.cos(23.96 * Math.PI / 180)];
    const plan = { features: [feat(1, [a, b, c], ["Rua A", "Rua B"])], order: [order("s1", 1)] };
    const r = buildNavRoute(plan, { lat: a[0], lon: a[1] }, new Map([["s1", { street: "Rua B", number: "118", letters: 3, precision: "entrance" }]]));
    expect(r.maneuvers.map((m) => [m.kind, m.street])).toEqual([["depart", "Rua A"], ["right", "Rua B"]]);
    expect(Math.round(r.maneuvers[1].at)).toBe(100);
    expect(Math.round(r.length)).toBe(200);
    expect(r.stops).toHaveLength(1);
    expect(r.stops[0]).toMatchObject({ key: "s1", street: "Rua B", number: "118", letters: 3, precision: "entrance" });
    expect(Math.round(r.stops[0].at)).toBe(200);
  });

  it("nós intermediários quase colineares não geram manobra", () => {
    const pts: [number, number][] = [0, 1, 2, 3, 4].map((i) => [-23.96 + i * 30 * M, -46.33 + (i % 2 ? 0.5 : 0) * M]);
    const r = buildNavRoute({ features: [feat(1, pts, Array(4).fill("Rua A"))], order: [order("s", 1)] }, { lat: pts[0][0], lon: pts[0][1] }, new Map());
    expect(r.maneuvers.map((m) => m.kind)).toEqual(["depart"]);
  });

  it("troca de nome sem curva vira 'continue' com a nova rua", () => {
    const pts: [number, number][] = [0, 1, 2, 3].map((i) => [-23.96 + i * 40 * M, -46.33]);
    const r = buildNavRoute({ features: [feat(1, pts, ["Rua A", "Rua A", "Rua B"])], order: [order("s", 1)] }, { lat: pts[0][0], lon: pts[0][1] }, new Map());
    // sem desvio angular ≥10°, não inventa instrução
    expect(r.maneuvers.map((m) => m.kind)).toEqual(["depart"]);
  });

  it("duas paradas: posições 'at' crescentes e dentro da rota", () => {
    const p0: [number, number] = [-23.96, -46.33], p1: [number, number] = [p0[0] + 80 * M, p0[1]], p2: [number, number] = [p1[0] + 80 * M, p1[1]];
    const plan = { features: [feat(1, [p0, p1], ["Rua A"]), feat(2, [p1, p2], ["Rua A"])], order: [order("a", 1), order("b", 2)] };
    const r = buildNavRoute(plan, { lat: p0[0], lon: p0[1] }, new Map());
    expect(r.stops.map((s) => Math.round(s.at))).toEqual([80, 160]);
    expect(r.stops[1].at).toBeGreaterThan(r.stops[0].at);
  });

  it("virada à esquerda e retorno", () => {
    const a: [number, number] = [-23.96, -46.33], b: [number, number] = [a[0], a[1] + 100 * M], c: [number, number] = [a[0] + 100 * M, b[1]];
    const r = buildNavRoute({ features: [feat(1, [a, b, c], ["Rua A", "Rua B"])], order: [order("s", 1)] }, { lat: a[0], lon: a[1] }, new Map());
    expect(r.maneuvers[1].kind).toBe("left");
  });
});
