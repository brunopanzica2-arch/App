/** 2.1 — importação de texto livre: sem separador, sem cabeçalho, Santos/SP por padrão. */
import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it } from "vitest";
import { db } from "../src/core/db";
import { commitImport, mapRows, prepareText } from "../src/core/importer";

beforeEach(async () => { await db.delete(); await db.open(); });
const run = (raw: string) => { const p = prepareText(raw); return { p, rows: mapRows(p.table, p.mapping) }; };

describe("linhas livres", () => {
  it("lista simples sem separador: rua + número, Santos/SP assumidos", () => {
    const { rows, p } = run("Rua Joaquim Távora 480\nPraça Visconde de Mauá 11\nAv. Ana Costa 100 apto 3 Gonzaga\nRua 7 de Setembro 120");
    expect(rows.map((r) => [r.values.street, r.values.number])).toEqual([
      ["Rua Joaquim Távora", "480"], ["Praça Visconde de Mauá", "11"], ["Av. Ana Costa", "100"], ["Rua 7 de Setembro", "120"]]);
    expect(rows[2].values).toMatchObject({ complement: "apto 3", neighborhood: "Gonzaga" });
    expect(rows.every((r) => !r.errors.length)).toBe(true);
    expect(p.inferred.freeText || p.mapping.full_address).toBeTruthy();
    // chave normalizada: Santos/SP por padrão
    expect(rows[0].key).toContain("SANTOS|SP");
  });
  it("formatos mistos na mesma colagem (vírgulas, hífens, CEP, numeração de lista)", () => {
    const { rows } = run("1) R. Joaquim Távora, 480, Vila Belmiro\nRua Braz Cubas, 20 - Centro - Santos/SP, 11010-000\nAmador Bueno 25");
    expect(rows.map((r) => r.values.number)).toEqual(["480", "20", "25"]);
    expect(rows[0].values.neighborhood).toBe("Vila Belmiro");
    expect(rows[1].values.cep).toBe("11010-000");
  });
  it("duas cartas para o mesmo imóvel continuam sendo duas cartas e uma parada", async () => {
    const raw = "Rua Joaquim Távora 480\nRua Joaquim Távora 480\nRua Braz Cubas 20";
    const p = prepareText(raw);
    const b = await commitImport(p.table, p.mapping, "t", "2026-10-11", "text", undefined, undefined, true, p.inferred);
    expect(b.report.inserted).toBe(3);
    expect(b.report.duplicates.length).toBe(0);
    const ls = await db.letters.where("batchId").equals(b.id).toArray();
    expect(new Set(ls.map((l) => l.addressKey)).size).toBe(2);
  });
  it("não aceita lixo como endereço: linha só numérica vai para correção", () => {
    const { rows } = run("106\nRua Braz Cubas 20");
    const bad = rows.find((r) => r.values.street === "106" || r.errors.length);
    expect(bad?.errors.length).toBeGreaterThan(0);
  });
  it("CSV com cabeçalho e sem cabeçalho continuam funcionando", () => {
    expect(run("Rua Itororó;118;Centro;Santos;SP").rows[0].values).toMatchObject({ street: "Rua Itororó", number: "118", neighborhood: "Centro" });
    expect(run("logradouro;numero;bairro\nRua Braz Cubas;20;Centro").rows[0].values).toMatchObject({ street: "Rua Braz Cubas", number: "20" });
  });
});
