/** 2.0.1 — registros antigos corrompidos (“106, 106”): diagnóstico, reprocessamento a partir da linha original, sem inventar nem apagar. */
import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it } from "vitest";
import { type Address, db, type Letter, uid } from "../src/core/db";
import { commitImport, prepareText } from "../src/core/importer";
import { diagnoseLegacy, reprocessLegacy, stopsOf, streetProblem } from "../src/core/service";

beforeEach(async () => { await db.delete(); await db.open(); });

const letter = (o: Partial<Letter>): Letter => ({ id: uid(), batchId: "B", row: 1, externalId: null, recipient: null, street: null, number: null, complement: null, neighborhood: null,
  city: null, cep: null, notes: null, status: "pending", errors: [], warnings: [], excluded: false, addressKey: null, ...o });

describe("streetProblem", () => {
  it("detecta logradouro vazio, numérico e igual ao número", () => {
    expect(streetProblem("106", "106")).toMatch(/só um número/);
    expect(streetProblem("", "10")).toMatch(/vazio/);
    expect(streetProblem("141", null)).toMatch(/só um número/);
    expect(streetProblem("Rua Itororó", "118")).toBeNull();
  });
});

describe("novas importações bloqueiam linha inválida antes de gravar", () => {
  it("linha com logradouro numérico vai para o relatório e NÃO vira carta", async () => {
    const p = prepareText("Rua Itororó;118;Centro;Santos;SP\r\nRua Braz Cubas;20;Centro;Santos;SP");
    const b = await commitImport(p.table, p.mapping, "t", "2026-10-10", "text", undefined, undefined, true, p.inferred);
    expect(b.report.inserted).toBe(2);
    // forçando mapeamento errado (coluna do número como logradouro) nenhuma carta com “118, 118” pode ser gravada
    const bad = { ...p.mapping, street: p.mapping.number, number: p.mapping.number };
    const b2 = await commitImport(p.table, bad, "t2", "2026-10-11", "text", undefined, undefined, true);
    const ls = (await db.letters.where("batchId").equals(b2.id).toArray());
    expect(ls.every((l) => !streetProblem(l.street, l.number))).toBe(true);
  });
});

describe("lote antigo corrompido", () => {
  async function seed() {
    // colunas deslocadas na importação antiga: logradouro = número
    const raws = [["Rua Itororó", "106", "Centro"], ["Avenida Ana Costa", "141", "Centro"], ["Rua Braz Cubas", "20", "Centro"]];
    const addr: Address = { key: "K106", display: "106, 106", original: "106;106", street: "106", number: "106", neighborhood: null, city: "Santos", cep: null, lat: -23.96, lon: -46.33,
      precision: "street", confidence: 0.3, source: "x", candidates: [], needsReview: false, reason: null, verifiedAt: null, confirmedAt: null };
    await db.addresses.put(addr);
    await db.letters.bulkAdd(raws.map((r, i) => letter({ batchId: "B", row: i + 1, street: r[1], number: r[1], addressKey: i === 0 ? "K106" : null, raw: r })));
    await db.batches.put({ id: "B", reference: "antigo", date: "2026-10-01", createdAt: "x", sourceType: "text", original: "", importHash: "h", report: { inserted: 3, duplicates: [], withErrors: [] } } as any);
  }

  it("diagnostica, não vira parada e reprocessa pela linha original sem apagar cartas", async () => {
    await seed();
    const d = await diagnoseLegacy("B");
    expect(d.issues.length).toBe(3);
    expect(d.issues.every((i) => i.canReprocess)).toBe(true);
    const sv = await stopsOf("B");
    expect(sv.stops.length).toBe(0); // “106, 106” nunca é parada
    const r = await reprocessLegacy("B");
    expect(r.fixed).toBe(3);
    expect(r.remaining).toBe(0);
    const ls = await db.letters.where("batchId").equals("B").toArray();
    expect(ls.length).toBe(3);
    expect(ls.map((l) => [l.street, l.number]).sort()).toEqual([["Avenida Ana Costa", "141"], ["Rua Braz Cubas", "20"], ["Rua Itororó", "106"]]);
  });

  it("sem linha original não inventa logradouro", async () => {
    await db.letters.add(letter({ batchId: "C", street: "106", number: "106" }));
    const r = await reprocessLegacy("C");
    expect(r.fixed).toBe(0);
    expect(r.skippedNoRaw).toBe(1);
    expect((await db.letters.where("batchId").equals("C").toArray())[0].street).toBe("106");
  });
});
