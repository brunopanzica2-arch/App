/** Auditoria V2 — reprodução dos alertas no app móvel (B, C, D, F, E, H). */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { type Graph, parseGraph } from "../src/core/graph";
import { mapRows, parseText, suggestMapping } from "../src/core/importer";
import { evaluate, feasibility, solve, validateRoute } from "../src/core/optimizer";
import { computePlan } from "../src/core/plan";
import { DEFAULT_PROFILE, Router, SnapError } from "../src/core/router";
import { safeCell } from "../src/core/service";

const D = 0.001;

/** Monta um Graph mínimo (mesmo formato do santos-graph.bin). */
function mkGraph(nodes: [number, number][], edges: { a: number; b: number; fwd?: boolean; bwd?: boolean; flags?: number }[]): Graph {
  const n = nodes.length, m = edges.length;
  const R = 6371008.8, rad = Math.PI / 180;
  const hav = (p: [number, number], q: [number, number]) => {
    const a = Math.sin(((q[0] - p[0]) * rad) / 2) ** 2 + Math.cos(p[0] * rad) * Math.cos(q[0] * rad) * Math.sin(((q[1] - p[1]) * rad) / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(a));
  };
  return {
    n, m,
    lat: Float64Array.from(nodes.map((p) => p[0])), lon: Float64Array.from(nodes.map((p) => p[1])),
    nodeFlags: new Uint8Array(n),
    ea: Uint32Array.from(edges.map((e) => e.a)), eb: Uint32Array.from(edges.map((e) => e.b)),
    len: Float32Array.from(edges.map((e) => hav(nodes[e.a], nodes[e.b]))),
    eflags: Uint8Array.from(edges.map((e) => e.flags ?? 0)),
    dir: Uint8Array.from(edges.map((e) => ((e.fwd ?? true) ? 1 : 0) | ((e.bwd ?? true) ? 2 : 0))),
    share: new Float32Array(m).fill(1), nameIdx: new Uint32Array(m), names: [""],
  };
}

const P = { ...DEFAULT_PROFILE, sidewalk_mode: "ride" as const };

function grid(ox: number, k: number, base = 0) {
  const nodes: [number, number][] = [];
  const edges: { a: number; b: number }[] = [];
  for (let r = 0; r < k; r++) for (let c = 0; c < k; c++) nodes.push([r * D, ox + c * D]);
  for (let r = 0; r < k; r++) for (let c = 0; c < k; c++) {
    const i = base + r * k + c;
    if (c + 1 < k) edges.push({ a: i, b: i + 1 });
    if (r + 1 < k) edges.push({ a: i, b: i + k });
  }
  return { nodes, edges };
}

function twoIslands() {
  const big = grid(0, 5);
  const small = grid(0.02, 3, 25);
  return mkGraph([...big.nodes, ...small.nodes], [...big.edges, ...small.edges]);
}

describe("[B] malha eleita a partir da origem", () => {
  it("origem na ilha menor roteia nela (antes: 'fora da malha')", () => {
    const g = twoIslands();
    const res = computePlan(g, {
      start: { lat: 0, lon: 0.02 }, mode: "open", strategy: "global", profile: P, timeLimitMs: 300, maxSnap: 150,
      stops: [{ key: "p1", lat: D, lon: 0.02 + D, service: 0 }, { key: "p2", lat: 2 * D, lon: 0.02 + 2 * D, service: 0 }],
    });
    expect(res.order.length).toBe(2);
    expect(res.totalDistance).toBeLessThan(1000);
  });

  it("parada em outra componente sai com motivo e rota fica PARCIAL", () => {
    const g = twoIslands();
    const res = computePlan(g, {
      start: { lat: 0, lon: 0.02 }, mode: "open", strategy: "global", profile: P, timeLimitMs: 300, maxSnap: 150,
      stops: [{ key: "mesma", lat: D, lon: 0.02 + D, service: 0 }, { key: "outra", lat: D, lon: D, service: 0 }],
    });
    expect(res.status).toBe("partial");
    expect(res.excluded.map((e) => e.key)).toEqual(["outra"]);
  });
});

describe("[F] factibilidade em matriz assimétrica", () => {
  it("par impossível nunca entra na sequência", () => {
    const I = Infinity;
    const T = [[0, 10, 10, 10], [10, 0, 5, 5], [I, I, 0, I], [10, 5, I, 0]];
    const f = feasibility(T, 0, [1, 2, 3], null);
    expect(f.kept.sort()).toEqual([1, 2, 3]);
    const res = solve({ T, D: T, start: 0, stops: f.kept, end: null, timeLimitMs: 200, compRank: f.compRank });
    expect(validateRoute(res.order, T, 0, f.kept, null)).toEqual([]);
    expect(res.order.at(-1)).toBe(2);
  });

  it("dois becos sem saída: só um entra; o outro sai com motivo", () => {
    const I = Infinity;
    const T = [[0, 5, 5], [I, 0, I], [I, I, 0]];
    const f = feasibility(T, 0, [1, 2], null);
    expect(f.kept.length).toBe(1);
    expect(Object.keys(f.excluded).length).toBe(1);
  });

  for (const [n, pInf, seed] of [[150, 0, 1], [150, 0.03, 2], [300, 0, 3], [60, 0.2, 4]] as const) {
    it(`${n} paradas, p(inf)=${pInf}, seed ${seed}: rota válida`, () => {
      const { T, Dm } = asym(seed, n + 1, pInf);
      const stops = Array.from({ length: n }, (_, i) => i + 1);
      const f = feasibility(T, 0, stops, null);
      expect(f.kept.length + Object.keys(f.excluded).length).toBe(n);
      const res = solve({ T, D: Dm, start: 0, stops: f.kept, end: null, timeLimitMs: 1500, compRank: f.compRank, seed });
      expect(validateRoute(res.order, T, 0, f.kept, null)).toEqual([]);
    });
  }
});

describe("[E] objetivo = avaliação = ETA", () => {
  it("rota aberta, circular e destino fixo", () => {
    const { T, Dm } = asym(9, 12, 0);
    const service = Object.fromEntries(Array.from({ length: 10 }, (_, i) => [i + 1, 10 + 25 * (i % 4)]));
    for (const end of [null, 0, 11]) {
      const res = solve({ T, D: Dm, start: 0, stops: Array.from({ length: 10 }, (_, i) => i + 1), end, service, timeLimitMs: 300 });
      const e = evaluate(res.order, { T, D: Dm, start: 0, stops: [], end, service });
      expect(res.best.time_s).toBeCloseTo(e.time, 6);
    }
  });
});

describe("[C] snapping com evidências", () => {
  it("acesso cruzando outra via e via mais próxima desconectada", () => {
    // rua conectada (lat 0) e rua isolada (lat 0.0004); ponto logo acima da isolada
    const g = mkGraph([[0, 0], [0, 4 * D], [0.0004, 0], [0.0004, 4 * D]], [{ a: 0, b: 1 }, { a: 2, b: 3 }]);
    const r = new Router(g, P);
    const { reach } = r.snapOrigin(0, 0.0001, 150);
    const s = r.snap(0.0005, 2 * D, 150, reach);
    expect(s.distance).toBeGreaterThan(40);
    expect(s.flags).toContain("acesso_cruza_outra_via");
    expect(s.flags).toContain("via_mais_proxima_desconectada");
    expect(() => r.snap(0.0005, 2 * D, 20, reach)).toThrow(SnapError);
  });
});

describe("[D] CSV RFC 4180", () => {
  it("campo citado com quebra de linha é UM registro", () => {
    const t = parseText('﻿id;rua;numero;complemento\r\nX1;Rua A;10;"bloco A\r\napto 2"\r\nX2;Rua B;20;"a;b ""c"""\r\n');
    expect(t.headers).toEqual(["id", "rua", "numero", "complemento"]);
    expect(t.rows.length).toBe(2);
    expect(t.rows[0][3]).toBe("bloco A\napto 2");
    expect(t.rows[1][3]).toBe('a;b "c"');
  });

  it("fixture adversarial: 30 linhas, 1 erro", () => {
    const raw = readFileSync(new URL("../../test-data/casos_adversariais_30.csv", import.meta.url), "utf8");
    const t = parseText(raw);
    const rows = mapRows(t, suggestMapping(t.headers));
    expect(rows.length).toBe(30);
    expect(rows.filter((r) => r.errors.length).length).toBe(1);
  });

  it("cenário de 300 cartas: 300 linhas, 300 IDs, 150 chaves, 3 bairros", () => {
    const raw = readFileSync(new URL("../../test-data/cenario_300_cartas_centro_paqueta_vila_nova.csv", import.meta.url), "utf8");
    const t = parseText(raw);
    const rows = mapRows(t, suggestMapping(t.headers));
    expect(rows.length).toBe(300);
    expect(new Set(rows.map((r) => r.values.external_id)).size).toBe(300);
    expect(new Set(rows.map((r) => r.key)).size).toBe(150);
    expect(new Set(rows.map((r) => r.values.neighborhood)).size).toBe(3);
  });
});

describe("[G] chave de endereço", () => {
  it("ignora bairro e complemento, distingue tipo de via e município", () => {
    const raw = readFileSync(new URL("../../test-data/casos_adversariais_30.csv", import.meta.url), "utf8");
    const t = parseText(raw);
    const k = Object.fromEntries(mapRows(t, suggestMapping(t.headers)).map((r) => [r.values.external_id, r.key]));
    expect(k.ADV11).toBe(k.ADV12);
    expect(k.ADV25).toBe(k.ADV26);
    expect(k.ADV25).not.toBe(k.ADV27);
    expect(k.ADV07!.split("|")[2]).toBe("108");
    expect(k.ADV08!.split("|")[2]).toBe("110");
    expect(k.ADV10!.split("|")[3]).not.toBe(k.ADV09!.split("|")[3]);
  });
});

describe("[H] injeção de fórmula na exportação", () => {
  it("neutraliza = + - @ TAB sem perder o texto", () => {
    expect(safeCell('=HYPERLINK("x")')).toBe(`'=HYPERLINK("x")`);
    expect(safeCell("+55")).toBe("'+55");
    expect(safeCell("@a")).toBe("'@a");
    expect(safeCell("\tx")).toBe("'\tx");
    expect(safeCell("normal")).toBe("normal");
    expect(safeCell(42)).toBe(42);
  });
});

function asym(seed: number, n: number, pInf: number) {
  let s = seed * 2654435761 >>> 0 || 1;
  const rnd = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
  const pts = Array.from({ length: n }, () => [rnd() * 3000, rnd() * 3000]);
  const Dm = pts.map((p, i) => pts.map((q, j) => (i === j ? 0 : Math.hypot(p[0] - q[0], p[1] - q[1]) * (1 + rnd() * 0.6))));
  const T = Dm.map((r) => r.map((d) => d / 4.2));
  if (pInf) for (let i = 1; i < n; i++) for (let j = 1; j < n; j++) if (i !== j && rnd() < pInf) { T[i][j] = Infinity; Dm[i][j] = Infinity; }
  return { T, Dm };
}

// referência para uso em outros testes
export { mkGraph, parseGraph };
