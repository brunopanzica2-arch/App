/** V3 §5: geocodificação em lote — fila persistente, retomada, backoff, circuit breaker, cancelamento, privacidade. */
import "fake-indexeddb/auto";
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type Address, db } from "../src/core/db";
import { classify, QuotaError, setProvider } from "../src/core/geocode";
import { enqueueBatch, MAX_ATTEMPTS, PUBLIC_BATCH_CAP, queueStats, runQueue, usageReport } from "../src/core/geoqueue";
import { commitImport, parseText, suggestMapping } from "../src/core/importer";
import { backupJson } from "../src/core/service";

const CSV = readFileSync(new URL("../../test-data/cenario_300_cartas_centro_paqueta_vila_nova.csv", import.meta.url), "utf8");
let batchId = "";

const addr = (key: string): Address => ({
  key, display: key, original: key, street: "x", number: "1", neighborhood: null, city: "Santos", cep: null, lat: -23.95, lon: -46.33,
  precision: "exact", confidence: 0.9, source: "mock", candidates: [], needsReview: false, reason: null, verifiedAt: "x", confirmedAt: null,
});

function clock() {
  let t = 1_000_000;
  const waits: number[] = [];
  return { now: () => t, sleep: async (ms: number) => { waits.push(ms); t += ms; }, waits };
}

beforeEach(async () => {
  await db.delete();
  await db.open();
  setProvider({ baseUrl: "https://geocoder.exemplo.test/search", minIntervalMs: 0 });
  const t = parseText(CSV);
  batchId = (await commitImport(t, suggestMapping(t.headers), "300", "2026-10-10", "csv", "c.csv")).id;
});
afterEach(() => { setProvider(null); vi.unstubAllGlobals(); });

describe("fila de geocodificação", () => {
  it("uma tarefa por ENDEREÇO ÚNICO (150), não por carta (300); reexecutar não duplica", async () => {
    expect(await enqueueBatch(batchId)).toBe(150);
    expect(await enqueueBatch(batchId)).toBe(0);
    expect((await queueStats(batchId)).total).toBe(150);
  });

  it("processa os 150 com provedor simulado: 150 chamadas, nenhuma por carta", async () => {
    const calls: string[] = [];
    const c = clock();
    const r = await runQueue(batchId, {
      ...c, resolver: async (l) => { calls.push(l.addressKey!); await db.addresses.put(addr(l.addressKey!)); },
    });
    expect(r).toMatchObject({ stopped: "completed", done: 150, failed: 0, remaining: 0 });
    expect(new Set(calls).size).toBe(150);
    expect(calls.length).toBe(150);
    // já resolvidos não voltam para a fila
    expect(await enqueueBatch(batchId)).toBe(0);
  });

  it("falha transitória: backoff exponencial 2 s, 4 s e depois sucesso", async () => {
    const c = clock();
    let n = 0;
    const r = await runQueue(batchId, {
      ...c, resolver: async (l) => {
        if (l.addressKey === [...new Set((await db.letters.toArray()).map((x) => x.addressKey))][0] && n++ < 2) throw new Error("HTTP 503");
        await db.addresses.put(addr(l.addressKey!));
      },
    });
    expect(r.done).toBe(150);
    expect(c.waits.slice(0, 2)).toEqual([2000, 4000]);
  });

  it("falha isolada por registro: após MAX_ATTEMPTS fica 'failed' com motivo e os demais seguem", async () => {
    const c = clock();
    const bad = (await db.letters.toArray())[0].addressKey!;
    const r = await runQueue(batchId, {
      ...c, resolver: async (l) => { if (l.addressKey === bad) throw new Error("endereço rejeitado"); await db.addresses.put(addr(l.addressKey!)); },
    });
    expect(r).toMatchObject({ stopped: "completed", done: 149, failed: 1, remaining: 0 });
    expect((await db.geojobs.get(bad))!).toMatchObject({ state: "failed", attempts: MAX_ATTEMPTS, error: "endereço rejeitado" });
    expect(r.errors[0]).toMatch(/endereço rejeitado/);
  });

  it("circuit breaker: 5 falhas seguidas interrompem sem perder nada; pendentes continuam pendentes", async () => {
    const c = clock();
    const r = await runQueue(batchId, { ...c, resolver: async () => { throw new Error("rede fora"); } });
    expect(r.stopped).toBe("circuit_open");
    expect(r.remaining).toBe(150);
    expect(r.done).toBe(0);
    expect(r.message).toMatch(/Nada foi perdido/);
  });

  it("cancelamento mantém o resolvido e a retomada continua sem refazer", async () => {
    const c = clock();
    const sig = { aborted: false };
    const seen = new Set<string>();
    const resolver = async (l: { addressKey: string | null }) => {
      expect(seen.has(l.addressKey!)).toBe(false); // nunca reprocessa um endereço concluído
      seen.add(l.addressKey!);
      await db.addresses.put(addr(l.addressKey!));
      if (seen.size === 40) sig.aborted = true;
    };
    const r1 = await runQueue(batchId, { ...c, signal: sig, resolver });
    expect(r1.stopped).toBe("cancelled");
    expect(r1.done).toBe(40);
    const r2 = await runQueue(batchId, { ...c, resolver });
    expect(r2).toMatchObject({ stopped: "completed", done: 150, remaining: 0 });
  });

  it("retomada após fechamento forçado: tarefa 'running' volta a 'pending'", async () => {
    await enqueueBatch(batchId, 1_000_000);
    const k = (await db.geojobs.toArray())[0].key;
    await db.geojobs.update(k, { state: "running" });
    const r = await runQueue(batchId, { ...clock(), resolver: async (l) => { await db.addresses.put(addr(l.addressKey!)); } });
    expect(r.done).toBe(150);
  });

  it("cota esgotada para a execução com mensagem e mantém pendentes", async () => {
    const r = await runQueue(batchId, { ...clock(), resolver: async () => { throw new QuotaError("Cota diária atingida."); } });
    expect(r.stopped).toBe("quota");
    expect(r.remaining).toBe(150);
  });
});

describe("Nominatim público e privacidade", () => {
  it("público: no máximo PUBLIC_BATCH_CAP por execução; o resto fica pendente com instrução", async () => {
    setProvider(null); // Nominatim público
    expect(PUBLIC_BATCH_CAP).toBe(30);
    let n = 0;
    const r = await runQueue(batchId, { ...clock(), publicCap: 5, resolver: async (l) => { n++; await db.addresses.put(addr(l.addressKey!)); } });
    expect(n).toBe(5);
    expect(r.stopped).toBe("public_cap");
    expect(r.remaining).toBe(145);
    expect(r.message).toMatch(/provedor próprio/i);
  });

  it("só o ENDEREÇO sai do aparelho: nenhuma consulta contém destinatário ou complemento", async () => {
    const urls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (u: string) => { urls.push(String(u)); return { ok: true, json: async () => [] }; }));
    await db.letters.toCollection().modify((l) => { l.recipient = "ZZ Destinatário Secreto"; l.complement = "apto 999-SECRETO"; });
    const r = await runQueue(batchId, { ...clock(), email: "" });
    expect(urls.length).toBeGreaterThan(0);
    for (const u of urls) { expect(decodeURIComponent(u)).not.toMatch(/Secret|Destinat|apto|999/i); }
    expect(r.done).toBe(150); // não localizado ≠ falha: fica registrado como "não localizado" para revisão
    expect((await db.addresses.where("precision").equals("not_found").count())).toBe(150);
  });

  it("consumo por provedor é registrado; custo só aparece se o usuário informou o preço", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => [] })));
    await runQueue(batchId, { ...clock() });
    const [u] = await usageReport();
    // cada endereço pode gerar até 3 consultas (com CEP, sem CEP, só a rua); o cache por consulta reaproveita as repetidas
    expect(u.provider).toBe("geocoder.exemplo.test");
    expect(u.errors).toBe(0);
    expect(u.costBRL).toBeNull();
    expect(u.queries).toBeGreaterThanOrEqual(150);
    expect(u.queries).toBeLessThan(450);
    expect((await usageReport(0.01))[0].costBRL).toBe(+(u.queries * 0.01).toFixed(2));
  });

  it("a chave do provedor NÃO entra no backup", async () => {
    await db.settings.put({ key: "main", geocoder: { baseUrl: "https://g.test/search", apiKey: "SEGREDO-123" } } as never);
    const json = await backupJson();
    expect(json).not.toContain("SEGREDO-123");
    expect(json).toContain("https://g.test/search");
  });

  it("classify: resultado do provedor sem número pedido nunca vira 'exato'", () => {
    expect(classify({ lat: "1", lon: "1", display_name: "x", category: "highway", address: { road: "R", house_number: "5" } }, null).precision).toBe("street");
  });
});
