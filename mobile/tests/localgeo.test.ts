import "fake-indexeddb/auto";
import { readFileSync } from "node:fs";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { parseCnefe } from "../src/core/cnefe";
import { db } from "../src/core/db";
import { resolve } from "../src/core/geocode";
import { commitImport, prepareText } from "../src/core/importer";
import { normalizeAddress } from "../src/core/normalize";
import { resolveBatchLocally, setLocalBase } from "../src/core/localgeo";
import { geocodeBatch, numberStatusSummary, saveSettings } from "../src/core/service";

const LISTA = readFileSync(new URL("../../listas/entregas_santos_18_colar.txt", import.meta.url), "utf8");
beforeAll(() => { const b = readFileSync(new URL("../public/santos-enderecos.bin", import.meta.url)); setLocalBase(parseCnefe(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer)); });
beforeEach(async () => { await Promise.all(db.tables.map((t) => t.clear())); vi.restoreAllMocks(); });

async function importLista(text = LISTA) {
  const p = prepareText(text);
  return commitImport(p.table, p.mapping, "Lista", "2026-10-13", "text", undefined, undefined, true, p.inferred);
}

describe("geocodificação local (IBGE) aplicada ao lote", () => {
  it("a lista de 18 do usuário: números localizados SEM nenhuma consulta de rede", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("rede proibida neste teste"));
    const b = await importLista();
    const r = await resolveBatchLocally(b.id);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(r.checked).toBe(18);
    expect(r.resolved).toBeGreaterThanOrEqual(17); // só "Pastor Narciso de Andrade" pede confirmação
    const sum = await numberStatusSummary(b.id);
    expect(sum.located + sum.estimated).toBeGreaterThanOrEqual(17);
    const joao = (await db.addresses.toArray()).find((a) => /joao eboli/i.test(a.street))!;
    expect(joao.precision).toBe("exact");
    expect(joao.source).toMatch(/ibge-cnefe-2022/);
    expect(joao.lat).toBeCloseTo(-23.9417, 2);
  });
  it("'Pastor Narciso de Andrade' não é aceito sozinho: fica com candidato e aviso", async () => {
    const b = await importLista("rua pastor narciso de Andrade, 42");
    await resolveBatchLocally(b.id);
    const a = (await db.addresses.toArray())[0];
    expect(a.precision).not.toBe("exact");
    expect(a.lat).toBeNull();
    expect(a.candidates.length).toBeGreaterThan(0);
    expect(a.reason).toMatch(/Confirme|confirme/);
  });
  it("nunca sobrescreve porta confirmada nem coordenada manual", async () => {
    const b = await importLista("rua tiro naval, 8");
    const key = normalizeAddress("rua tiro naval", "8", null, "Santos", null).key;
    await db.addresses.put({ key, display: "x", original: "", street: "Rua Tiro Naval", number: "8", neighborhood: null, city: "Santos", cep: null, lat: -23.9, lon: -46.3, precision: "manual", confidence: 1, source: "manual", candidates: [], needsReview: false, reason: null, verifiedAt: null, confirmedAt: "2026-10-01" });
    await resolveBatchLocally(b.id);
    expect((await db.addresses.get(key))!.lat).toBe(-23.9);
  });
  it("resolve() usa a base local: número exato sem rede; endereço de outra cidade não usa a base", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("sem rede"));
    const a = await resolve(normalizeAddress("rua doutor cesario bastos", "1", null, "Santos", null));
    expect(a.precision).toBe("exact");
    expect(fetchSpy).not.toHaveBeenCalled();
    await expect(resolve(normalizeAddress("rua doutor cesario bastos", "1", null, "São Vicente", null))).rejects.toThrow();
  });
  it("geocodeBatch: resolve localmente ANTES da fila e a fila não gasta cota do provedor público com o que já tem número", async () => {
    await saveSettings({ geocoder: null });
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("sem rede"));
    const b = await importLista("rua doutor cesario bastos, 1\nrua tiro naval, 8\nrua general camara, 85");
    const r = await geocodeBatch(b.id);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(r.local.resolved).toBe(3);
    expect(r.errors).toEqual([]);
  });

  it("o CSV entregue ao usuário (com bairros do IBGE) importa e resolve 17 de 18 offline", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("rede proibida"));
    const csv = readFileSync(new URL("../../listas/entregas_santos_18.csv", import.meta.url), "utf8");
    const b = await importLista(csv);
    const r = await resolveBatchLocally(b.id);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(r.checked).toBe(18);
    expect(r.exact).toBeGreaterThanOrEqual(17);
    expect(r.ambiguous).toBe(1);
  });
});
