/** Persistência local: migração Dexie, importação de 300 cartas, backup cifrado, desfazer, integridade. */
import "fake-indexeddb/auto";
import Dexie from "dexie";
import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it } from "vitest";
import { db } from "../src/core/db";
import { commitImport, DuplicateImportError, parseText, suggestMapping } from "../src/core/importer";
import {
  backupJson, exportRows, recordEvent, restoreJson, stopStatus, undoLastEvent, undoRestore, verifyIntegrity,
} from "../src/core/service";

const CSV = readFileSync(new URL("../../test-data/cenario_300_cartas_centro_paqueta_vila_nova.csv", import.meta.url), "utf8");

async function import300(allow = false) {
  const t = parseText(CSV);
  return commitImport(t, suggestMapping(t.headers), "Cenário 300", "2026-10-10", "csv", "cenario.csv", undefined, allow);
}

beforeEach(async () => {
  await db.delete();
  await db.open();
});

describe("E2E-01 / E2E-04: importação de 300 cartas", () => {
  it("300 importadas, 300 IDs, 150 endereços, 3 bairros, zero desaparecimentos", async () => {
    const b = await import300();
    const letters = await db.letters.where("batchId").equals(b.id).toArray();
    expect(letters.length).toBe(300);
    expect(new Set(letters.map((l) => l.externalId)).size).toBe(300);
    expect(new Set(letters.map((l) => l.addressKey)).size).toBe(150);
    expect(new Set(letters.map((l) => l.neighborhood)).size).toBe(3);
    expect(b.report.inserted).toBe(300);
    expect(await verifyIntegrity()).toEqual([]);
  });

  it("reimportar o MESMO arquivo exige confirmação explícita; IDs não duplicam", async () => {
    await import300();
    await expect(import300()).rejects.toBeInstanceOf(DuplicateImportError);
    const b2 = await import300(true); // usuário confirmou
    expect(b2.report.inserted).toBe(0);
    expect(b2.report.duplicates.length).toBe(300);
    expect(await db.letters.count()).toBe(300);
  });

  it("E2E-02: ordem das linhas não muda o conjunto importado", async () => {
    const lines = CSV.replace(/^﻿/, "").split("\r\n").filter(Boolean);
    const shuffled = [lines[0], ...lines.slice(1).reverse()].join("\r\n");
    const t = parseText(shuffled);
    const b = await commitImport(t, suggestMapping(t.headers), "embaralhado", "2026-10-10", "csv");
    const keys = new Set((await db.letters.where("batchId").equals(b.id).toArray()).map((l) => l.addressKey));
    expect(keys.size).toBe(150);
  });
});

describe("E2E-11 / desfazer", () => {
  it("1 carta entregue de um imóvel com 4: parada PARCIAL; desfazer restaura", async () => {
    const b = await import300();
    const letters = await db.letters.where("batchId").equals(b.id).toArray();
    const byKey = new Map<string, typeof letters>();
    letters.forEach((l) => byKey.set(l.addressKey!, [...(byKey.get(l.addressKey!) || []), l]));
    const four = [...byKey.values()].find((g) => g.length === 4)!;
    await recordEvent(four[0].id, "delivered", null);
    const after = await db.letters.bulkGet(four.map((l) => l.id));
    expect(stopStatus(after.map((l) => l!))).toBe("partial");
    expect(after.filter((l) => l!.status === "delivered").length).toBe(1);
    const ev = await undoLastEvent(b.id);
    expect(ev?.letterId).toBe(four[0].id);
    expect((await db.letters.get(four[0].id))!.status).toBe("pending");
    expect((await db.events.get(ev!.id))!.undoneAt).toBeTruthy(); // histórico preservado
  });
});

describe("backup e restauração", () => {
  it("backup cifrado: senha errada falha, certa restaura; desfazer restauração", async () => {
    const b = await import300();
    const l = (await db.letters.where("batchId").equals(b.id).first())!;
    await recordEvent(l.id, "delivered", null);
    const enc = await backupJson("senha-forte-123");
    expect(enc).not.toContain(l.recipient!); // nomes não ficam legíveis no arquivo
    await db.letters.clear();
    await expect(restoreJson(enc, { password: "errada" })).rejects.toThrow(/Senha incorreta/);
    const r = await restoreJson(enc, { password: "senha-forte-123", mode: "replace" });
    expect(r.letters).toBe(300);
    expect((await db.letters.get(l.id))!.status).toBe("delivered");
    expect(await verifyIntegrity()).toEqual([]);
    await undoRestore(); // volta ao estado anterior (cartas apagadas)
    expect(await db.letters.count()).toBe(0);
  });

  it("backup inconsistente é recusado sem tocar nos dados", async () => {
    await import300();
    const bad = JSON.stringify({ app: "rota-santos", batches: [], letters: [{ id: "x", batchId: "nao-existe" }], addresses: [], routes: [], events: [], settings: [] });
    await expect(restoreJson(bad, { mode: "replace" })).rejects.toThrow(/inconsistente/);
    expect(await db.letters.count()).toBe(300);
  });
});

describe("E2E-20: exportação", () => {
  it("todas as cartas exportadas e células perigosas neutralizadas", async () => {
    const t = parseText(readFileSync(new URL("../../test-data/casos_adversariais_30.csv", import.meta.url), "utf8"));
    const b = await commitImport(t, suggestMapping(t.headers), "adv", "2026-10-10", "csv");
    const { rows } = await exportRows(b.id);
    expect(rows.length).toBe(b.report.inserted);
    const flat = rows.flat().map(String);
    expect(flat.some((c) => c.startsWith("'=HYPERLINK"))).toBe(false); // obs não é exportada; nome sim
    expect(flat.filter((c) => /^[=+\-@]/.test(c)).length).toBe(0);
  });
});

describe("migração IndexedDB v1 -> v2", () => {
  it("dados da versão anterior permanecem", async () => {
    db.close();
    await Dexie.delete("rota-santos");
    const v1 = new Dexie("rota-santos");
    v1.version(1).stores({
      batches: "id, date, createdAt", letters: "id, batchId, externalId, addressKey, status",
      addresses: "key, needsReview, precision", geocache: "q", routes: "id, batchId, version, status",
      events: "id, letterId, batchId, at", settings: "key",
    });
    await v1.open();
    await v1.table("batches").put({ id: "b1", reference: "antigo", date: "2026-10-09", createdAt: "x", sourceType: "csv", original: "", report: { inserted: 1, duplicates: [], withErrors: [] } });
    await v1.table("letters").put({ id: "l1", batchId: "b1", row: 2, status: "delivered", addressKey: "k" });
    await v1.table("events").put({ id: "e1", letterId: "l1", batchId: "b1", at: "2026-10-09T10:00:00Z", status: "delivered", previousStatus: "pending" });
    v1.close();
    await db.open();
    expect(db.verno).toBe(2);
    expect((await db.letters.get("l1"))!.status).toBe("delivered");
    expect((await db.events.get("e1"))!.undoneAt).toBeNull();
    expect(await verifyIntegrity()).toEqual([]);
  });
});
