/** Benchmarks V2 do app (TypeScript) sobre os MESMOS pontos do backend (test-data/benchmarks/*.json).
 * Roda em Node no computador — NÃO é medição de celular. Uso: BENCH=1 npx vitest run bench/ */
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import { execSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { parseGraph } from "../src/core/graph";
import { computePlan } from "../src/core/plan";
import { DEFAULT_PROFILE } from "../src/core/router";

const BD = new URL("../../test-data/benchmarks/", import.meta.url);

describe.skipIf(!process.env.BENCH)("benchmarks V2 — app (Node, desktop)", () => {
  it("roda os cenários do backend", () => {
    const tl = Date.now();
    const buf = readFileSync(new URL("../public/santos-graph.bin", import.meta.url));
    const graph = parseGraph(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
    const loadMs = Date.now() - tl;
    const backend = JSON.parse(readFileSync(new URL("resultados_backend.json", BD), "utf8"));
    const names = readdirSync(BD).filter((f) => f.endsWith(".json") && !f.startsWith("resultados")).map((f) => f.replace(".json", ""));
    const rows: any[] = [];
    for (const name of backend.linhas.map((l: any) => l.cenario).filter((n: string) => names.includes(n))) {
      const sc = JSON.parse(readFileSync(new URL(`${name}.json`, BD), "utf8"));
      (globalThis as any).gc?.();
      const heap0 = process.memoryUsage().heapUsed;
      let heapPeak = heap0;
      const t0 = performance.now();
      const res = computePlan(graph, {
        start: { lat: sc.origin[0], lon: sc.origin[1] }, mode: "open", strategy: "global",
        profile: { ...DEFAULT_PROFILE, ride_speed_kmh: 15 }, timeLimitMs: 15000, maxSnap: 150,
        stops: sc.stops.map((s: any, i: number) => ({ key: `K${i + 1}`, lat: s.p[0], lon: s.p[1], service: 45 + 10 * Math.max(s.cartas - 1, 0) })),
      }, () => { heapPeak = Math.max(heapPeak, process.memoryUsage().heapUsed); });
      const wall = performance.now() - t0;
      heapPeak = Math.max(heapPeak, process.memoryUsage().heapUsed);
      const b = backend.linhas.find((l: any) => l.cenario === name);
      expect(new Set(res.order.map((o) => o.key)).size).toBe(res.order.length);
      const row = {
        cenario: name, paradas: sc.stops.length, roteadas: res.order.length, excluidas: res.excluded.length, status: res.status,
        matriz_ms: res.timings.matrix_ms, solver_ms: res.timings.solve_ms, total_ms: Math.round(wall),
        km: +(res.totalDistance / 1000).toFixed(2), tempo_total_h: +(res.totalTime / 3600).toFixed(2),
        heap_pico_mb: +(heapPeak / 2 ** 20).toFixed(1), backend_km: b?.km, backend_h: b?.tempo_total_h,
        razao_tempo_app_backend: b ? +(res.totalTime / 3600 / b.tempo_total_h).toFixed(4) : null,
      };
      console.log(JSON.stringify(row));
      rows.push(row);
    }
    const meta = {
      data: new Date().toISOString(), commit: execSync("git rev-parse --short HEAD").toString().trim(),
      hardware: `${os.platform()} ${os.release()} · ${os.cpus()[0]?.model} · ${os.cpus().length} vCPU`, node: process.version,
      carga_malha_ms: loadMs, limite_solver_ms: 15000, implementacao: "app (TypeScript, mesmo código do APK) rodando em Node — NÃO é celular",
      nota: "Tempo do app inclui acesso (2×snap/velocidade a pé) no tempo total, igual ao backend. Ver docs/RESULTADOS_COMPARATIVOS_V2.md.",
    };
    writeFileSync(new URL("resultados_app_node.json", BD), JSON.stringify({ meta, linhas: rows }, null, 1));
  }, 600_000);
});
