/** V3 §4: posição do endereço × portaria × ponto na malha; hierarquia de confiança; histórico e reversão. */
import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it } from "vitest";
import { clearEntrance, confirmEntrance, confirmPin, invalidateConfirmation, isStale, revertLast, routePoint, trustOf, trustSummary } from "../src/core/address";
import { type Address, db } from "../src/core/db";
import { classify } from "../src/core/geocode";
import { stopsOf } from "../src/core/service";

const base = (key: string, over: Partial<Address> = {}): Address => ({
  key, display: key, original: key, street: "Rua Joaquim Távora", number: "480", neighborhood: "Vila Nova", city: "Santos", cep: null,
  lat: -23.948, lon: -46.3406, precision: "street", confidence: 0.3, source: "nominatim", candidates: [], needsReview: true,
  reason: "Número não localizado: ponto aproximado na rua.", verifiedAt: null, confirmedAt: null, ...over,
});

beforeEach(async () => {
  await db.delete();
  await db.open();
});

describe("hierarquia de confiança", () => {
  it("portaria > pino > número na fonte > interpolado > rua > não localizado", () => {
    const lv = (p: Partial<Address>) => trustOf({ precision: "street", entrance: null, ...p } as Address).level;
    expect([
      lv({ entrance: { lat: 1, lon: 1, note: null, confirmedAt: "x", by: "u" } }), lv({ precision: "manual" }), lv({ precision: "exact" }),
      lv({ precision: "interpolated" }), lv({ precision: "street" }), lv({ precision: "neighborhood" }), lv({ precision: "not_found" }),
    ]).toEqual([1, 2, 3, 4, 5, 6, 6]);
    expect(trustOf({ precision: "street" } as Address).approximate).toBe(true);
    expect(trustOf({ precision: "exact" } as Address).approximate).toBe(false);
  });

  it("centro da rua nunca vira 'exato': resultado sem número pedido ou com outro número é 'street'", () => {
    const item = (o: object) => ({ lat: "-23.9", lon: "-46.3", display_name: "x", category: "highway", type: "residential", address: { road: "Rua X" }, ...o });
    expect(classify(item({}), null).precision).toBe("street");
    expect(classify(item({ address: { road: "Rua X", house_number: "10" } }), null).precision).toBe("street"); // não pediram número
    expect(classify(item({ address: { road: "Rua X", house_number: "10" } }), "480").precision).toBe("street"); // número diferente
    expect(classify(item({ address: { road: "Rua X", house_number: "480" } }), "480").precision).toBe("exact");
  });
});

describe("portaria ≠ posição do endereço", () => {
  it("confirmar a portaria não apaga a posição postal; routePoint usa a portaria", async () => {
    await db.addresses.put(base("k1"));
    const a = await confirmEntrance("k1", -23.9482, -46.3409, "portão azul");
    expect(a.lat).toBe(-23.948);
    expect(a.entrance).toMatchObject({ lat: -23.9482, lon: -46.3409, note: "portão azul" });
    expect(routePoint(a)).toEqual({ lat: -23.9482, lon: -46.3409, kind: "entrance" });
    expect(trustOf(a).code).toBe("entrance");
    expect(a.needsReview).toBe(false);
  });

  it("confirmar só o pino marca 'manual' (pino), não 'portaria'", async () => {
    await db.addresses.put(base("k2"));
    const a = await confirmPin("k2", -23.9481, -46.3407);
    expect(trustOf(a).code).toBe("pin");
    expect(a.entrance ?? null).toBeNull();
  });

  it("histórico com reversão: pino → portaria → reverter → reverter volta ao geocodificado", async () => {
    await db.addresses.put(base("k3"));
    await confirmPin("k3", -23.9481, -46.3407);
    await confirmEntrance("k3", -23.9483, -46.341);
    expect((await db.addresses.get("k3"))!.history).toHaveLength(2);
    let a = await revertLast("k3");
    expect(a.entrance ?? null).toBeNull();
    expect(a.precision).toBe("manual");
    a = await revertLast("k3");
    expect(a.precision).toBe("street");
    expect([a.lat, a.lon]).toEqual([-23.948, -46.3406]);
    await expect(revertLast("k3")).rejects.toThrow(/Nada para reverter/);
  });

  it("invalidar confirmação antiga volta o endereço para revisão sem perder a coordenada", async () => {
    await db.addresses.put(base("k4"));
    await confirmPin("k4", -23.9481, -46.3407);
    await confirmEntrance("k4", -23.9483, -46.341);
    const a = await invalidateConfirmation("k4");
    expect(a.needsReview).toBe(true);
    expect(a.entrance ?? null).toBeNull();
    expect(a.confirmedAt).toBeNull();
    expect(trustOf(a).approximate).toBe(true);
    expect(isStale({ confirmedAt: "2020-01-01T00:00:00Z" })).toBe(true);
    expect(isStale({ confirmedAt: new Date().toISOString() })).toBe(false);
  });

  it("rejeita coordenada inválida e limpa portaria", async () => {
    await db.addresses.put(base("k5"));
    await expect(confirmEntrance("k5", 999, 0)).rejects.toThrow(/inválida/);
    await confirmEntrance("k5", -23.9, -46.3);
    expect((await clearEntrance("k5")).entrance ?? null).toBeNull();
  });
});

describe("política de endereços aproximados", () => {
  async function setup(policy: "include" | "block") {
    await db.settings.put({ key: "main", approxPolicy: policy } as never);
    await db.batches.put({ id: "b", reference: "r", date: "2026-10-10", createdAt: "", sourceType: "manual", original: "", report: { inserted: 0, duplicates: [], withErrors: [] } });
    const mk = (k: string, over: Partial<Address>) => base(k, over);
    await db.addresses.bulkPut([mk("rua", {}), mk("exato", { precision: "exact", confidence: 0.9, needsReview: false }), mk("porta", {}),
      mk("bairro", { precision: "neighborhood" }), mk("achado", { precision: "not_found", lat: null, lon: null })]);
    await confirmEntrance("porta", -23.9, -46.3);
    await db.letters.bulkPut(["rua", "exato", "porta", "bairro", "achado"].map((k, i) => ({
      id: `L${i}`, batchId: "b", row: i, externalId: null, recipient: null, street: null, number: null, complement: null, neighborhood: null,
      city: null, cep: null, notes: null, status: "pending", errors: [], warnings: [], excluded: false, addressKey: k,
    })) as never);
    return stopsOf("b");
  }
  it("include (padrão): rua e interpolados entram sinalizados; bairro e não encontrado nunca", async () => {
    const { stops, unlocated } = await setup("include");
    expect(stops.map((s) => s.key).sort()).toEqual(["exato", "porta", "rua"]);
    expect(stops.find((s) => s.key === "rua")!.uncertain).toBe(true);
    expect(stops.find((s) => s.key === "porta")!.uncertain).toBe(false);
    expect(unlocated.length).toBe(2);
  });
  it("block: aproximados ficam fora até confirmar; portaria confirmada entra", async () => {
    const { stops, unlocated } = await setup("block");
    expect(stops.map((s) => s.key).sort()).toEqual(["exato", "porta"]);
    expect(unlocated.length).toBe(3);
  });
  it("resumo de confiança conta cada nível", async () => {
    await setup("include");
    const s = trustSummary(await db.addresses.toArray());
    expect(s).toMatchObject({ entrance: 1, verified: 1, street: 1, unlocated: 2, total: 5 });
  });
});
