import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import type { Candidate } from "../src/core/db";
import { parseGraph } from "../src/core/graph";
import { buildStreetIndex, createSearchService, fromCandidates, mergeHits, parseQuery, searchDeliveries, type StreetEntry, suggestStreets } from "../src/core/search";

let idx: StreetEntry[];
beforeAll(() => {
  const b = readFileSync(new URL("../public/santos-graph.bin", import.meta.url));
  idx = buildStreetIndex(parseGraph(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer));
});

const cand = (o: Partial<Candidate>): Candidate => ({ lat: -23.96, lon: -46.33, label: "x", precision: "street", confidence: 0.5, road: "Rua Joaquim Távora", houseNumber: null, city: "Santos", postcode: null, ...o } as Candidate);

describe("busca de endereços (offline, malha real)", () => {
  it("índice tem ruas de Santos", () => { expect(idx.length).toBeGreaterThan(500); });

  it("autocomplete tolera acento, caixa e abreviação", () => {
    for (const q of ["joaquim tavora", "JOAQUIM TÁVORA", "r. joaquim tav", "rua joaq"]) {
      const h = suggestStreets(idx, q);
      expect(h.length, q).toBeGreaterThan(0);
      expect(h[0].title.toLowerCase()).toContain("joaquim");
    }
  });

  it("número digitado é preservado e nunca marcado como exato/confirmado", () => {
    const h = suggestStreets(idx, "Rua Joaquim Távora 480");
    expect(h[0].title).toContain("480");
    expect(h[0].numberAsked).toBe("480");
    expect(h[0].numberConfirmed).toBe(false);
    expect(h[0].precision).toBe("street");
    expect(h[0].note).toMatch(/não confirmado/);
    expect(JSON.stringify(h[0])).not.toMatch(/S\/N/);
  });

  it("proximidade só desempata", () => {
    const far = { lat: -23.5, lon: -46.6 };
    const a = suggestStreets(idx, "rua", { user: far, limit: 3 });
    expect(a.length).toBeGreaterThan(0);
  });

  it("parseQuery separa rua/número sem confundir '7 de Setembro'", () => {
    expect(parseQuery("rua x 48").number).toBe("48");
    expect(parseQuery("Rua 7 de Setembro").number).toBeNull();
  });
});

describe("filtro de Santos para resultados do provedor", () => {
  const p = parseQuery("Rua Joaquim Távora 480");
  it("homônimo em outro município é descartado", () => {
    const hits = fromCandidates([cand({ city: "São Vicente", lat: -23.96, lon: -46.39 }), cand({ city: "São Paulo", lat: -23.55, lon: -46.63 })], p);
    expect(hits.some((h) => h.subtitle.includes("São Paulo"))).toBe(false);
  });
  it("só a rua achada: número NÃO confirmado", () => {
    const [h] = fromCandidates([cand({ houseNumber: null })], p);
    expect(h.numberConfirmed).toBe(false);
    expect(h.precision).toBe("street");
    expect(h.title).toContain("480");
  });
  it("número devolvido pelo provedor: confirmado", () => {
    const [h] = fromCandidates([cand({ houseNumber: "480", precision: "exact", confidence: 0.9 })], p);
    expect(h.numberConfirmed).toBe(true);
    expect(h.precision).toBe("exact");
  });
  it("com número confirmado sobe na lista mesclada", () => {
    const local = suggestStreets(idx, "Rua Joaquim Távora 480");
    const remote = fromCandidates([cand({ houseNumber: "480", precision: "exact", confidence: 0.9 })], p);
    expect(mergeHits(local, remote)[0].numberConfirmed).toBe(true);
  });
});

describe("SearchService", () => {
  const mk = (over: Partial<Parameters<typeof createSearchService>[0]> = {}) => {
    let calls = 0;
    const svc = createSearchService({
      index: async () => idx, user: () => null, liveRemote: () => false, online: () => true,
      remote: async () => { calls++; return [cand({ houseNumber: "480", precision: "exact", confidence: 0.9 })]; }, ...over,
    });
    return { svc, calls: () => calls };
  };
  it("provedor público: digitação NÃO consulta a rede; só ao enviar", async () => {
    const { svc, calls } = mk();
    const r = await svc.query("rua joaquim tavora 480");
    expect(r.fromRemote).toBe(false);
    expect(calls()).toBe(0);
    const s = await svc.query("rua joaquim tavora 480", { submit: true });
    expect(s.fromRemote).toBe(true);
    expect(calls()).toBe(1);
    await svc.query("rua joaquim tavora 480", { submit: true });
    expect(calls()).toBe(1); // cache
  });
  it("offline: estado explícito e resultados da malha", async () => {
    const { svc } = mk({ online: () => false });
    const r = await svc.query("rua joaquim tavora", { submit: true });
    expect(r.state).toBe("offline");
    expect(r.hits.length).toBeGreaterThan(0);
  });
  it("erro do provedor não derruba a busca", async () => {
    const { svc } = mk({ remote: async () => { throw new Error("HTTP 503"); } });
    const r = await svc.query("rua joaquim tavora", { submit: true });
    expect(r.state).toBe("error");
    expect(r.hits.length).toBeGreaterThan(0);
  });
  it("consulta curta não busca", async () => {
    expect((await mk().svc.query("r")).state).toBe("short");
  });
});

describe("Minhas entregas", () => {
  it("encontra por rua, código e destinatário, sem acento", () => {
    const ls = [{ street: "Rua Joaquim Távora", number: "480", neighborhood: "Vila Belmiro", externalId: "AB123", recipient: "João", addressKey: "k1", row: 1 }];
    expect(searchDeliveries(ls, "joaquim tavora")).toHaveLength(1);
    expect(searchDeliveries(ls, "ab123")).toHaveLength(1);
    expect(searchDeliveries(ls, "joao")).toHaveLength(1);
    expect(searchDeliveries(ls, "zzz")).toHaveLength(0);
  });
});

describe("busca com a base local do IBGE", () => {
  it("'rua tiro naval 8' → resultado com número CONFIRMADO NA FONTE (offline)", async () => {
    const { readFileSync } = await import("node:fs");
    const { parseCnefe } = await import("../src/core/cnefe");
    const { setLocalBase, localBase } = await import("../src/core/localgeo");
    const { lookupCnefe } = await import("../src/core/cnefe");
    const b = readFileSync(new URL("../public/santos-enderecos.bin", import.meta.url));
    setLocalBase(parseCnefe(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer));
    const r = lookupCnefe(localBase()!, { street: "rua tiro naval", number: "8" });
    expect(["exact", "face"]).toContain(r.kind);
    const svc = createSearchService({
      index: async () => idx, user: () => null, liveRemote: () => false, online: () => true, remote: async () => [],
      local: (p) => { const x = lookupCnefe(localBase()!, { street: p.street, number: p.number }); return x.lat != null && (x.kind === "exact" || x.kind === "face")
        ? [{ id: "i", title: `${x.street}, ${p.number}`, subtitle: "IBGE", lat: x.lat, lon: x.lon!, precision: "exact", numberAsked: p.number, numberConfirmed: true, note: x.reason, source: "malha", score: 2 }] : []; },
    });
    const res = await svc.query("rua tiro naval 8");
    expect(res.hits[0].numberConfirmed).toBe(true);
    expect(res.hits[0].title).toMatch(/Tiro Naval, 8/);
  });
});
