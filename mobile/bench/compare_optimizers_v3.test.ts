/** V3 §7.2: otimizador do app na MESMA matriz/objetivo do backend (test-data/resultados/paridade_150_open.json). Roda em Node (não é celular).
 * Uso: BENCH=1 npx vitest run bench/compare_optimizers_v3.test.ts  -> test-data/v3/comparacao_app.json */
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { evaluate, feasibility, solve, validateRoute } from "../src/core/optimizer";

const FILE = new URL("../../test-data/resultados/paridade_150_open.json", import.meta.url);

describe.skipIf(!process.env.BENCH)("app x backend na mesma matriz", () => {
  it("5 sementes x 3 limites de tempo", () => {
    const raw = readFileSync(FILE);
    const P = JSON.parse(raw.toString());
    const inf = (x: number) => (x < 0 ? Infinity : x);
    const T = P.T.map((r: number[]) => r.map(inf)), D = P.D.map((r: number[]) => r.map(inf));
    const service = Object.fromEntries(Object.entries(P.service).map(([k, v]) => [+k, v as number]));
    const f = feasibility(T, 0, Array.from({ length: T.length - 1 }, (_, i) => i + 1), null);
    const rows: any[] = [];
    for (const limit of [3000, 6000, 15000]) {
      const runs: any[] = [];
      for (const seed of [1, 2, 3, 4, 5]) {
        const t0 = performance.now();
        const res = solve({ T, D, start: 0, stops: f.kept, end: null, service, timeLimitMs: limit, compRank: f.compRank, seed });
        const wall = performance.now() - t0;
        expect(validateRoute(res.order, T, 0, f.kept, null)).toEqual([]);
        const e = evaluate(res.order, { T, D, start: 0, end: null, service });
        runs.push({ seed, tempo_s: +e.time.toFixed(2), km: +(e.dist / 1000).toFixed(3), execucao_s: +(wall / 1000).toFixed(1), estrategia: res.best.strategy });
      }
      const ts = runs.map((r) => r.tempo_s);
      rows.push({ limite_ms: limit, melhor_s: Math.min(...ts), pior_s: Math.max(...ts), media_s: +(ts.reduce((a, b) => a + b, 0) / ts.length).toFixed(2), runs });
    }
    writeFileSync(new URL("../../test-data/v3/comparacao_app.json", import.meta.url), JSON.stringify({
      entrada: "paridade_150_open.json", entrada_sha256: createHash("sha256").update(raw).digest("hex"), paradas: f.kept.length,
      ambiente: `Node ${process.version} (desktop, NÃO é celular)`, app: rows,
    }, null, 1));
  }, 900_000);
});
