import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it } from "vitest";
import { estimateByNumber, refineByAnchors } from "../src/core/anchors";
import { type Address, db } from "../src/core/db";

const A = (n: number, lat: number, lon: number) => ({ number: n, lat, lon });

describe("estimativa pela numeração (âncoras)", () => {
  it("interpola linearmente entre o número de baixo e o de cima", () => {
    const e = estimateByNumber(50, [A(10, -23.96, -46.33), A(90, -23.96, -46.328)])!;
    expect(e.between).toEqual([10, 90]);
    expect(e.lat).toBeCloseTo(-23.96, 6);
    expect(e.lon).toBeCloseTo(-46.329, 5); // metade do caminho
    expect(e.sameParity).toBe(true);
  });
  it("não extrapola: sem âncora acima OU abaixo, não estima", () => {
    expect(estimateByNumber(50, [A(10, 0, 0), A(20, 0, 0.0001)])).toBeNull();
    expect(estimateByNumber(5, [A(10, 0, 0), A(20, 0, 0.0001)])).toBeNull();
    expect(estimateByNumber(50, [])).toBeNull();
  });
  it("não estima quando as âncoras estão longe demais (>450 m) ou os números muito distantes", () => {
    expect(estimateByNumber(50, [A(10, -23.96, -46.33), A(90, -23.96, -46.30)])).toBeNull();
    expect(estimateByNumber(500, [A(10, -23.96, -46.33), A(900, -23.96, -46.329)])).toBeNull();
  });
  it("prefere o mesmo lado da rua (paridade); sem par do mesmo lado usa os dois e avisa", () => {
    const a = estimateByNumber(50, [A(10, 0, 0), A(90, 0, 0.002), A(49, 0, 0.0005), A(51, 0, 0.0006)])!;
    expect(a.between).toEqual([10, 90]);
    expect(a.sameParity).toBe(true);
    const b = estimateByNumber(50, [A(49, 0, 0.0005), A(53, 0, 0.0009)])!;
    expect(b.sameParity).toBe(false);
  });
  it("número que já é âncora não é estimado", () => { expect(estimateByNumber(10, [A(10, 0, 0), A(20, 0, 0.0001)])).toBeNull(); });
});

const addr = (key: string, street: string, number: string, p: Partial<Address>): Address => ({
  key, display: `${street}, ${number}`, original: "", street, number, neighborhood: null, city: "Santos", cep: null, lat: null, lon: null,
  precision: "street", confidence: 0.4, source: "t", candidates: [], needsReview: true, reason: null, verifiedAt: null, confirmedAt: null, ...p,
});

describe("refineByAnchors no banco", () => {
  beforeEach(async () => { await Promise.all(db.tables.map((t) => t.clear())); });
  it("estima só o que está sem número exato; nunca sobrescreve porta confirmada, exato ou manual", async () => {
    await db.addresses.bulkPut([
      addr("a10", "Rua Tal", "10", { lat: -23.96, lon: -46.33, precision: "exact", confidence: 0.9 }),
      addr("a90", "Rua Tal", "90", { lat: -23.96, lon: -46.328, precision: "exact", confidence: 0.9 }),
      addr("a50", "Rua Tal", "50", { lat: -23.9, lon: -46.3, precision: "street" }),
      addr("a60", "Rua Tal", "60", { lat: -23.96, lon: -46.3285, precision: "manual", confirmedAt: "2026-10-01" }),
      addr("a70", "Rua Tal", "70", {}), // sem posição nenhuma
      addr("b50", "Rua Outra", "50", { lat: -23.9, lon: -46.3 }), // outra rua: sem âncoras
    ] as Address[]);
    const r = await refineByAnchors();
    expect(r.keys.sort()).toEqual(["a50", "a70"]);
    const a50 = (await db.addresses.get("a50"))!;
    expect(a50.precision).toBe("interpolated");
    expect(a50.reason).toMatch(/ESTIMADA.*10 e 60/); // usa a âncora mais próxima (o 60 confirmado à mão)
    expect(a50.lon).toBeCloseTo(-46.33 + (0.0015) * 0.8, 5);
    expect((await db.addresses.get("a60"))!.precision).toBe("manual");
    expect((await db.addresses.get("b50"))!.precision).toBe("street");
    expect((await db.addresses.get("a10"))!.precision).toBe("exact");
  });
  it("idempotente: rodar de novo não muda nada", async () => {
    await db.addresses.bulkPut([addr("a10", "Rua Tal", "10", { lat: -23.96, lon: -46.33, precision: "exact" }), addr("a90", "Rua Tal", "90", { lat: -23.96, lon: -46.328, precision: "exact" }), addr("a50", "Rua Tal", "50", {})] as Address[]);
    expect((await refineByAnchors()).refined).toBe(1);
    expect((await refineByAnchors()).refined).toBe(0);
  });
});

describe("porta marcada com GPS vira âncora", () => {
  beforeEach(async () => { await Promise.all(db.tables.map((t) => t.clear())); });
  it("usa a coordenada da PORTA (entrance), não a da rua, e estima os vizinhos", async () => {
    await db.addresses.bulkPut([
      addr("p10", "Rua Z", "10", { lat: -23.9, lon: -46.3, precision: "street", confirmedAt: "2026-10-13", entrance: { lat: -23.96, lon: -46.33, note: null, confirmedAt: "2026-10-13", by: "gps" } }),
      addr("p30", "Rua Z", "30", { lat: -23.9, lon: -46.3, precision: "street", confirmedAt: "2026-10-13", entrance: { lat: -23.96, lon: -46.328, note: null, confirmedAt: "2026-10-13", by: "gps" } }),
      addr("p20", "Rua Z", "20", {}),
    ] as Address[]);
    expect((await refineByAnchors()).keys).toEqual(["p20"]);
    expect((await db.addresses.get("p20"))!.lon).toBeCloseTo(-46.329, 5);
  });
});
