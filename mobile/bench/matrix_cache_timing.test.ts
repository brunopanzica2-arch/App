/** Tempo de matriz: completa × cache (status) × cache (1 portaria movida). Node/desktop, NÃO celular. BENCH=1 npx vitest run bench/matrix_cache_timing.test.ts */
import { readFileSync, writeFileSync } from "node:fs";
import { describe, it } from "vitest";
import { parseGraph } from "../src/core/graph";
import { DEFAULT_PROFILE, Router, snapSig } from "../src/core/router";

const buf = readFileSync(new URL("../public/santos-graph.bin", import.meta.url));
const graph = parseGraph(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
const P = JSON.parse(readFileSync(new URL("../../test-data/resultados/paridade_150_open.json", import.meta.url), "utf8"));
const profile = { ...DEFAULT_PROFILE, ride_speed_kmh: 15 };
const build = (pts: number[][]) => {
  const r = new Router(graph, profile);
  const { snap, reach } = r.snapOrigin(pts[0][0], pts[0][1], 150);
  const snaps = [snap, ...pts.slice(1).map((p) => r.snap(p[0], p[1], 150, reach))];
  return { solver: r.solver(snaps), sigs: snaps.map(snapSig) };
};
const med = (f: () => unknown, n = 5) => { const t: number[] = []; for (let i = 0; i < n; i++) { const a = performance.now(); f(); t.push(performance.now() - a); } return +t.sort((a, b) => a - b)[Math.floor(n / 2)].toFixed(1); };

describe.skipIf(!process.env.BENCH)("tempo de matriz com cache", () => {
  it("mede", () => {
    const pts: number[][] = P.points;
    const full = med(() => build(pts).solver.matrices());
    const seed = build(pts).solver.matricesCached(build(pts).sigs, null, "k").cache;
    const remaining = [pts[0], ...pts.slice(51)];
    const status = med(() => { const b = build(remaining); b.solver.matricesCached(b.sigs, seed, "k"); });
    const statusFull = med(() => build(remaining).solver.matrices());
    const moved = pts.map((p) => p.slice()); moved[77] = [pts[77][0] + 0.0009, pts[77][1] + 0.0007];
    const one = med(() => { const b = build(moved); b.solver.matricesCached(b.sigs, seed, "k"); });
    const out = { ambiente: `Node ${process.version} (desktop; NÃO é celular)`, paradas: pts.length - 1,
      matriz_completa_150_ms: full, status_so_pendentes_100_sem_cache_ms: statusFull, status_so_pendentes_100_com_cache_ms: status, uma_portaria_movida_150_com_cache_ms: one,
      nota: "inclui snap + montagem do grafo virtual (build) em todas as medidas; mediana de 5" };
    writeFileSync(new URL("../../test-data/v3/cache_matriz_tempos.json", import.meta.url), JSON.stringify(out, null, 1));
    console.log(JSON.stringify(out));
  }, 120000);
});
