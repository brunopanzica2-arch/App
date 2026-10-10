/** Rota Santos 2.0 §2/§14 — importação inteligente. Os dois primeiros testes REPRODUZEM os bugs do relatório (falhavam antes). */
import "fake-indexeddb/auto";
import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it } from "vitest";
import { db } from "../src/core/db";
import { commitImport, mapRows, parseText, prepareText, suggestMapping } from "../src/core/importer";
import { inferSchema } from "../src/core/schema";

beforeEach(async () => { await db.delete(); await db.open(); });

const imp = async (raw: string, extra: { allow?: boolean } = {}) => {
  const p = prepareText(raw);
  const b = await commitImport(p.table, p.mapping, "t", "2026-10-10", "text", undefined, undefined, extra.allow ?? true, p.inferred);
  return { p, b, rows: mapRows(p.table, p.mapping) };
};

/** 211 linhas sem cabeçalho: Rua;número;bairro;município;UF — 28 números distintos, como no relatório do usuário */
function lines211() {
  const ruas = ["Rua Itororó", "Avenida Ana Costa", "Rua Amador Bueno", "Rua Braz Cubas", "Rua General Câmara"];
  return Array.from({ length: 211 }, (_, i) => `${ruas[i % 5]};${100 + (i % 28)};${["Centro", "Vila Nova", "Paquetá"][i % 3]};Santos;SP`).join("\r\n");
}

describe("regressão do relatório", () => {
  it("'Rua Itororó;118;Centro;Santos;SP' vira rua/número/bairro/município/UF sem mapear nada", () => {
    const p = prepareText("Rua Itororó;118;Centro;Santos;SP");
    expect(p.inferred.hasHeader).toBe(false);
    const [r] = mapRows(p.table, p.mapping);
    expect(r.values).toMatchObject({ street: "Rua Itororó", number: "118", neighborhood: "Centro", city: "Santos/SP", state: "SP" });
    expect(r.errors).toEqual([]);
    expect(r.key).toBe("RUA|ITORORO|118|SANTOS|SP");
    expect(p.inferred.confidence).toBeGreaterThanOrEqual(0.8);
  });

  it("211 linhas NÃO viram 28 inseridas + 183 'duplicadas' (antes: identificador mapeado numa coluna repetida)", async () => {
    // mapeamento ruim, exatamente como no relatório (identificador = coluna do número, 28 valores distintos)
    const t = parseText(lines211(), "auto", false);
    const bad = { ...suggestMapping(t.headers), street: "coluna_1", number: "coluna_2", external_id: "coluna_2", neighborhood: "coluna_3", city: "coluna_4" };
    const b = await commitImport(t, bad, "x", "2026-10-10", "text");
    expect(b.report.inserted).toBe(211);
    expect(b.report.duplicates).toEqual([]);
    expect(b.report.warnings!.join(" ")).toMatch(/identificador/i);
  });

  it("211 linhas sem cabeçalho, sem mapear nada: 211 cartas, 140 imóveis, 0 duplicadas", async () => {
    const { b, p } = await imp(lines211());
    expect(b.report.inserted).toBe(211);
    expect(b.report.duplicates.length).toBe(0);
    expect(new Set((await db.letters.toArray()).map((l) => l.addressKey)).size).toBe(140);
    expect(p.inferred.mapping).toMatchObject({ street: 0, number: 1, neighborhood: 2, city: 3, state: 4 });
  });

  it("logradouro que é só número (coluna deslocada) vira ERRO visível, não parada '141, 141'", () => {
    const t = parseText("141;141;Vila Nova;Santos;Santos", "auto", false);
    const rows = mapRows(t, { street: "coluna_1", number: "coluna_2", neighborhood: "coluna_3" } as never);
    expect(rows[0].errors.join(" ")).toMatch(/só um número|deslocada/);
  });
});

describe("matriz de formatos", () => {
  it("com cabeçalho e sinônimos (logradouro/número/bairro/cidade/UF/destinatário/identificador/complemento/CEP)", async () => {
    const csv = "Identificador;Destinatário;Logradouro;Número;Complemento;Bairro;Cidade;UF;CEP\nA1;Maria Teste;Rua Braz Cubas;20;apto 3;Centro;Santos;SP;11010-000\nA2;João Teste;Av. Ana Costa;55;;Gonzaga;Santos;SP;11060-001";
    const { rows, p } = await imp(csv);
    expect(p.inferred.hasHeader).toBe(true);
    expect(rows[0].values).toMatchObject({ external_id: "A1", street: "Rua Braz Cubas", number: "20", complement: "apto 3", cep: "11010-000" });
    expect(rows[1].values.recipient).toBe("João Teste");
  });
  it("coluna_1 e cabeçalhos ruins não são tratados como dados nem como rótulo", () => {
    const p = prepareText("coluna_1;coluna_2;coluna_3\nRua Itororó;118;Centro\nRua Braz Cubas;20;Vila Nova");
    expect(p.inferred.hasHeader).toBe(false);
    expect(p.table.rows.length).toBe(3);
  });
  it("TSV colado do Excel", async () => {
    const { rows } = await imp("Rua Braz Cubas\t20\tCentro\nAvenida Ana Costa\t55\tGonzaga");
    expect(rows.map((r) => r.values.number)).toEqual(["20", "55"]);
  });
  it("CSV com vírgula e aspas, sem quebrar o endereço dentro das aspas", async () => {
    const { rows } = await imp('"Rua Braz Cubas, bloco B",20,Centro,Santos,SP\n"Avenida Ana Costa",55,Gonzaga,Santos,SP\n"Rua Itororó",118,Centro,Santos,SP');
    expect(rows[0].values.street).toBe("Rua Braz Cubas, bloco B");
    expect(rows[2].values).toMatchObject({ street: "Rua Itororó", number: "118" });
  });
  it("texto livre, uma linha por endereço (vírgula faz parte do endereço)", async () => {
    const { rows, p } = await imp("Rua Itororó, 118 - Centro, Santos/SP\nAvenida Ana Costa, 55, apto 4 - Gonzaga");
    expect(p.inferred.freeText).toBe(true);
    expect(rows[0].values).toMatchObject({ street: "Rua Itororó", number: "118" });
    expect(rows[1].values).toMatchObject({ street: "Avenida Ana Costa", number: "55" });
  });
  it("número com sufixo/zero à esquerda/decimal de planilha; CEP em coluna própria", () => {
    const p = prepareText("Rua A;106A;Centro;11010000\nRua B;0110;Centro;11010-001\nRua C;108.0;Centro;11010-002");
    const r = mapRows(p.table, p.mapping);
    expect(p.inferred.mapping.cep).toBe(3);
    expect(r.map((x) => x.key?.split("|")[2])).toEqual(["106A", "110", "108"]);
  });
  it("UF diferente de SP é respeitada; município diferente é avisado", () => {
    const [r] = mapRows(...(() => { const p = prepareText("Rua Itororó;118;Centro;São Vicente;SP"); return [p.table, p.mapping] as const; })());
    expect(r.warnings.join(" ")).toMatch(/diferente do padrão/);
  });
  it("sem cabeçalho e UF no meio: o conteúdo manda, não a posição", () => {
    const inf = inferSchema("11010-000;SP;Santos;Rua Itororó;118");
    expect(inf.mapping).toMatchObject({ cep: 0, state: 1, city: 2, street: 3, number: 4 });
  });
});

describe("identidade: carta ≠ endereço ≠ parada", () => {
  it("3 cartas em Rua Itororó, 118 = 1 endereço, 3 cartas (não '2 duplicadas')", async () => {
    const { b } = await imp("Rua Itororó;118;apto 1;Centro\nRua Itororó;118;apto 2;Centro\nRua Itororó;118;apto 3;Centro");
    const l = await db.letters.toArray();
    expect(b.report.inserted).toBe(3);
    expect(new Set(l.map((x) => x.addressKey)).size).toBe(1);
  });
  it("duas ruas com número 118 são endereços diferentes", async () => {
    await imp("Rua Itororó;118;Centro\nRua Braz Cubas;118;Centro");
    expect(new Set((await db.letters.toArray()).map((x) => x.addressKey)).size).toBe(2);
  });
  it("mesmo identificador + mesmo conteúdo = duplicada CONFIRMADA (com motivo); mesmo ID com conteúdo diferente entra com aviso", async () => {
    const csv = "id;rua;numero;bairro\nX100;Rua Itororó;118;Centro\nX100;Rua Itororó;118;Centro\nX100;Rua Braz Cubas;20;Centro\nX101;Rua A;1;Centro";
    const { b } = await imp(csv);
    expect(b.report.duplicates.length).toBe(1);
    expect(b.report.duplicates[0].reason).toMatch(/mesmo identificador e mesmo conteúdo/);
    expect(b.report.inserted).toBe(3);
    const warned = (await db.letters.toArray()).filter((l) => l.warnings.some((w) => /conteúdo diferente/.test(w)));
    expect(warned.length).toBe(1);
  });
  it("a linha ORIGINAL e o esquema inferido ficam guardados (auditoria/reversão)", async () => {
    const { b } = await imp("Rua Itororó;118;Centro;Santos;SP");
    const l = (await db.letters.toArray())[0];
    expect(l.raw).toEqual(["Rua Itororó", "118", "Centro", "Santos", "SP"]);
    expect(b.schema!.columns.map((c) => c.field)).toEqual(["street", "number", "neighborhood", "city", "state"]);
  });
});

describe("volumes", () => {
  const big = readFileSync(new URL("../../test-data/v3/cenario_1000_cartas_500_paradas.csv", import.meta.url), "utf8");
  const lines = big.replace(/^﻿/, "").split(/\r\n/).filter(Boolean);
  for (const n of [1, 5, 10, 211, 300, 500, 1000]) {
    it(`${n} linhas: nenhuma some`, async () => {
      const csv = [lines[0], ...lines.slice(1, 1 + n)].join("\r\n");
      const { b } = await imp(csv);
      expect(b.report.inserted + b.report.duplicates.length).toBe(Math.min(n, 1000));
      expect(await db.letters.count()).toBe(Math.min(n, 1000));
    });
  }
});

describe("desfazer importação", () => {
  it("apaga só o lote escolhido; outros lotes e endereços confirmados ficam; dá para voltar pelo instantâneo", async () => {
    const { undoBatch, batchUndoSummary, undoRestore } = await import("../src/core/service");
    const a = await imp("Rua Itororó;118;Centro\nRua Braz Cubas;20;Centro");
    const b = await imp("Avenida Ana Costa;55;Gonzaga", { allow: true });
    await db.addresses.put({ key: "K", display: "x", original: "x", street: "x", number: null, neighborhood: null, city: "Santos", cep: null, lat: -23.9, lon: -46.3, precision: "manual", confidence: 1, source: "manual", candidates: [], needsReview: false, reason: null, verifiedAt: null, confirmedAt: "x" } as never);
    expect((await batchUndoSummary(a.b.id)).letters).toBe(2);
    const sum = await undoBatch(a.b.id);
    expect(sum.letters).toBe(2);
    expect(await db.letters.count()).toBe(1);
    expect((await db.letters.toArray())[0].batchId).toBe(b.b.id);
    expect(await db.batches.get(a.b.id)).toBeUndefined();
    expect(await db.addresses.get("K")).toBeDefined();
    expect(await db.snapshots.count()).toBeGreaterThan(0);
    void undoRestore;
  });
});
