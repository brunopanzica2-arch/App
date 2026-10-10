/** V3 §14-B: propriedades metamórficas (embaralhar, duplicar carta, prefixo fixo, reimportação não reabre entregas). */
import "fake-indexeddb/auto";
import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it } from "vitest";
import { db } from "../src/core/db";
import { parseGraph } from "../src/core/graph";
import { commitImport, parseText, suggestMapping } from "../src/core/importer";
import { clearMatrixCache, computePlan, PlanError } from "../src/core/plan";
import { DEFAULT_PROFILE } from "../src/core/router";
import { recordEvent, stopsOf } from "../src/core/service";

const buf = readFileSync(new URL("../public/santos-graph.bin", import.meta.url));
const graph = parseGraph(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
const P = JSON.parse(readFileSync(new URL("../../test-data/resultados/paridade_150_open.json", import.meta.url), "utf8"));
const CSV = readFileSync(new URL("../../test-data/cenario_300_cartas_centro_paqueta_vila_nova.csv", import.meta.url), "utf8");
const profile = { ...DEFAULT_PROFILE, ride_speed_kmh: 15, pedestrian: false };
const base = (n: number) => P.points.slice(1, n + 1).map((p: number[], i: number) => ({ key: `K${i + 1}`, lat: p[0], lon: p[1], service: 45 }));
const req = (stops: any[], extra: object = {}) => ({
  start: { lat: P.points[0][0], lon: P.points[0][1] }, mode: "open" as const, strategy: "global" as const, profile, timeLimitMs: 2500, maxSnap: 150, stops, ...extra,
});

describe("embaralhar a entrada", () => {
  it("mesma rota em conjunto e custo equivalente (<1,5%) com a lista de paradas invertida ou embaralhada", () => {
    clearMatrixCache();
    const s = base(60);
    const a = computePlan(graph, req(s));
    const b = computePlan(graph, req([...s].reverse()));
    const shuffled = [...s].sort((x, y) => ((+x.key.slice(1) * 7919) % 61) - ((+y.key.slice(1) * 7919) % 61));
    const c = computePlan(graph, req(shuffled));
    for (const r of [b, c]) {
      expect(new Set(r.order.map((o) => o.key))).toEqual(new Set(a.order.map((o) => o.key)));
      expect(Math.abs(r.totalTime - a.totalTime) / a.totalTime).toBeLessThan(0.015);
    }
  }, 60000);
});

describe("prefixo fixo", () => {
  it("as paradas fixas abrem a rota na ordem pedida e o ETA continua consistente", () => {
    const s = base(40);
    const r = computePlan(graph, req(s, { fixedFirst: ["K17", "K3"] }));
    expect(r.order.slice(0, 2).map((o) => o.key)).toEqual(["K17", "K3"]);
    expect(r.order.length).toBe(40);
    expect(r.totalTime).toBeCloseTo(r.timeBreakdown.travel + r.timeBreakdown.service + r.timeBreakdown.access, 3);
  }, 30000);
  it("fixa inexistente ou duplicada é erro de validação, não é ignorada", () => {
    const s = base(10);
    expect(() => computePlan(graph, req(s, { fixedFirst: ["K999"] }))).toThrow(PlanError);
    expect(() => computePlan(graph, req(s, { fixedFirst: ["K1", "K1"] }))).toThrow(PlanError);
  });
});

describe("carta duplicada no mesmo endereço / reimportação", () => {
  beforeEach(async () => { await db.delete(); await db.open(); });
  async function importWith(extra = "") {
    const t = parseText(CSV.trimEnd() + "\r\n" + extra);
    return commitImport(t, suggestMapping(t.headers), "m", "2026-10-10", "csv", "m.csv", undefined, true);
  }
  it("mais uma carta na MESMA entrada não cria parada nova; só soma carta", async () => {
    const first = (await db.letters.toArray()).length;
    expect(first).toBe(0);
    const b = await importWith("");
    const before = await stopsOf(b.id);
    expect(before.stops.length).toBe(0); // ainda sem posição: nenhuma parada inventada
    const L = (await db.letters.toArray())[0];
    const extra = `V3DUP01;Pessoa Teste Extra;${L.street};${L.number};apto 99;${L.neighborhood};Santos;;duplicada`;
    await db.delete(); await db.open();
    const b2 = await importWith(extra);
    const lets = await db.letters.where("batchId").equals(b2.id).toArray();
    expect(lets.length).toBe(301);
    const keys = new Set(lets.map((l) => l.addressKey));
    expect(keys.size).toBe(150); // 150 endereços lógicos continuam 150
  });
  it("reimportar o mesmo arquivo não reabre carta já entregue", async () => {
    const b = await importWith("");
    const l = (await db.letters.where("batchId").equals(b.id).toArray())[10];
    await recordEvent(l.id, "delivered", null);
    await importWith(""); // mesma carga, confirmação explícita
    const again = await db.letters.get(l.id);
    expect(again!.status).toBe("delivered");
    expect((await db.letters.where("externalId").equals(l.externalId!).toArray()).length).toBe(1); // sem duplicata de ID
  });
});
