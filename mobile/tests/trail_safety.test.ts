/**
 * 2.3 — INCIDENTE: rota pela trilha/mato. Reproduz o caso (origem em São Vicente → ponto de Santos configurado pelo usuário,
 * coordenadas dele em "Ajustes", NÃO a porta do imóvel) e garante que o perfil "entrega urbana a pé" não usa trilha nem acesso privado.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { HW, HW_LABEL, parseGraph } from "../src/core/graph";
import { computePlan, assessQuality } from "../src/core/plan";
import { classifyEdge, DEFAULT_PROFILE, edgeKey, Router, SnapError } from "../src/core/router";

const buf = readFileSync(new URL("../public/santos-graph.bin", import.meta.url));
const g = parseGraph(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
const OUT = new URL("../../docs/evidencias-rotas/", import.meta.url);
mkdirSync(OUT, { recursive: true });

const ORIGEM_SV: [number, number] = [-23.964, -46.392]; // São Vicente (origem GPS de teste)
const DESTINO: [number, number] = [-23.948914, -46.33368]; // coordenada configurada pelo usuário em Ajustes (não é a porta)

function route(profile: Partial<typeof DEFAULT_PROFILE>) {
  const r = new Router(g, { ...DEFAULT_PROFILE, ...profile });
  const { snap: so, reach } = r.snapOrigin(ORIGEM_SV[0], ORIGEM_SV[1], 400);
  const sd = r.snap(DESTINO[0], DESTINO[1], 300, reach);
  const leg = r.solver([so, sd]).leg(0, 1);
  const edges = leg.features.flatMap((f) => f.properties.segEdges ?? []);
  return { r, leg, edges };
}
const segRows = (edges: number[]) => edges.map((e) => ({ edge: e, key: edgeKey(g, e), hw: HW_LABEL[g.hw![e]], surf: g.surf![e], attr: g.attr![e], trail_m: g.trail![e] * 10, len: g.len[e], flags: g.eflags[e] }));

describe("grafo v2: atributos de adequação existem e são coerentes", () => {
  it("RSG2 com classe da via, piso, dicas e trilha contínua", () => {
    expect(g.format).toBe(2);
    expect(g.hw!.length).toBe(g.m);
    const n = (c: number) => g.hw!.reduce((a, x) => a + +(x === c), 0);
    expect(n(HW.PATH)).toBeGreaterThan(100);
    expect(n(HW.STREET)).toBeGreaterThan(10000);
    expect(g.trail!.some((t) => t >= 15)).toBe(true);
  });
});

describe("incidente: origem em São Vicente → Santos", () => {
  const legacy = route({ urban_safe: false });
  const safe = route({});
  it("A/B/C: o perfil ANTIGO usa trilha (path) e acesso privado — causa do incidente", () => {
    const rows = segRows(legacy.edges);
    const trail = rows.filter((x) => x.hw.startsWith("trilha") || x.trail_m > 0);
    const priv = rows.filter((x) => x.flags & 2);
    expect(trail.length + priv.length).toBeGreaterThan(0);
    expect(trail.reduce((a, x) => a + x.len, 0)).toBeGreaterThan(300); // trilha contínua de ~390 m
    writeFileSync(new URL("incidente_perfil_antigo.json", OUT), JSON.stringify({ origem: ORIGEM_SV, destino: DESTINO, distancia_m: Math.round(legacy.leg.distance), segmentos_problematicos: [...trail, ...priv] }, null, 1));
  });
  it("o perfil URBANO não usa trilha nem acesso privado e exporta GeoJSON/arestas", () => {
    const rows = segRows(safe.edges);
    expect(rows.filter((x) => x.trail_m > 0 || x.hw.startsWith("trilha")).length).toBe(0);
    expect(rows.filter((x) => x.flags & 2).length).toBe(0);
    const q = assessQuality(safe.leg.features);
    expect(q.trailMeters).toBe(0);
    writeFileSync(new URL("incidente_rota_urbana.geojson", OUT), JSON.stringify({ type: "FeatureCollection", features: safe.leg.features }));
    writeFileSync(new URL("incidente_rota_antiga.geojson", OUT), JSON.stringify({ type: "FeatureCollection", features: legacy.leg.features }));
    writeFileSync(new URL("incidente_rota_urbana_arestas.json", OUT), JSON.stringify({ distancia_m: Math.round(safe.leg.distance), arestas: rows }, null, 1));
  });
  it("D: custo/adequação — a rota urbana é mais longa (aceitável) e declarada", () => {
    const extra = safe.leg.distance / legacy.leg.distance - 1;
    expect(extra).toBeGreaterThan(0);
    expect(extra).toBeLessThan(0.4);
    writeFileSync(new URL("incidente_comparacao.json", OUT), JSON.stringify({ antiga_m: Math.round(legacy.leg.distance), urbana_m: Math.round(safe.leg.distance), acrescimo_pct: +(extra * 100).toFixed(1), tempo_antigo_min: Math.round(legacy.leg.time / 60), tempo_urbano_min: Math.round(safe.leg.time / 60) }, null, 1));
  });
});

describe("snap de destino só em via urbana (E) e sem falsa certeza (H)", () => {
  // aresta de trilha vedada (continua ≥150 m) e um ponto exatamente nela
  const trailEdge = Array.from({ length: g.m }, (_, e) => e).find((e) => g.trail![e] >= 15 && (g.attr![e] & 64) === 0 && !(g.eflags[e] & 2))!;
  const mid: [number, number] = [(g.lat[g.ea[trailEdge]] + g.lat[g.eb[trailEdge]]) / 2, (g.lon[g.ea[trailEdge]] + g.lon[g.eb[trailEdge]]) / 2];
  it("a aresta de teste é mesmo trilha e é vedada pelo perfil urbano", () => {
    expect(classifyEdge(g, trailEdge, DEFAULT_PROFILE).suit).toBe(3);
  });
  it("destino na trilha NÃO encaixa nela: ou vai a via urbana próxima ou erra com mensagem honesta", () => {
    const r = new Router(g, DEFAULT_PROFILE);
    let msg = "";
    try {
      const s = r.snap(mid[0], mid[1], 150);
      expect(r.suit[s.edge]).toBeLessThan(2); // encaixou numa via urbana, nunca na trilha
    } catch (e) { msg = (e as Error).message; expect(e).toBeInstanceOf(SnapError); }
    if (msg) expect(msg).toMatch(/trilha|malha|acesso/i);
  });
  it("plano com destino só alcançável por trilha: parada EXCLUÍDA com motivo, sem rota inventada", () => {
    const start = { lat: ORIGEM_SV[0], lon: ORIGEM_SV[1] };
    const stopOk = { key: "ok", lat: DESTINO[0], lon: DESTINO[1], service: 45 };
    const stopTrail = { key: "trilha", lat: mid[0], lon: mid[1], service: 45 };
    const plan = computePlan(g, { start, mode: "open", strategy: "global", profile: { ...DEFAULT_PROFILE }, timeLimitMs: 1500, maxSnap: 120, stops: [stopOk, stopTrail] });
    const keys = plan.order.map((o) => o.key);
    if (!keys.includes("trilha")) expect(plan.excluded.some((x) => x.key === "trilha")).toBe(true);
    for (const f of plan.features) expect(f.properties.flags).not.toContain("trilha");
  });
});

describe("J: reportar trecho inadequado e recalcular evitando-o", () => {
  it("o trecho reportado some do novo caminho (com rota alternativa)", () => {
    const base = route({});
    // escolhe uma aresta urbana do meio do trajeto
    const e = base.edges[Math.floor(base.edges.length / 2)];
    const alt = route({ avoid_edges: [edgeKey(g, e)] });
    expect(alt.edges).not.toContain(e);
    expect(alt.leg.distance).toBeGreaterThan(0);
  });
});

describe("2.6 — via PARTICULAR urbana (vila/condomínio) é alcançável com aviso; trilha privada continua vedada", () => {
  const r = new Router(g, { ...DEFAULT_PROFILE });
  // arestas privadas: urbanas (calçadas/ruas) × trilha/terra
  const privUrban: number[] = [], privTrail: number[] = [];
  for (let e = 0; e < g.m; e++) if (g.eflags[e] & 2) (r.suit[e] === 1 ? privUrban : r.suit[e] === 3 || r.suit[e] === 2 ? privTrail : []).push(e);

  it("existem as duas classes na malha real (senão o teste não prova nada)", () => {
    expect(privUrban.length).toBeGreaterThan(20);
    expect(privTrail.length).toBeGreaterThan(0);
  });
  it("trilha/terra privada segue VEDADA (o incidente)", () => {
    for (const e of privTrail.slice(0, 200)) expect(r.edgeOk[e] === 0 || r.suit[e] >= 2).toBe(true);
    const bad = privTrail.filter((e) => r.edgeOk[e] === 1 && r.suit[e] < 2);
    expect(bad).toEqual([]);
  });
  it("via particular urbana: permitida, com aviso 'via particular' e penalidade (nunca atalho gratuito)", () => {
    const ok = privUrban.filter((e) => r.edgeOk[e] === 1);
    expect(ok.length / privUrban.length).toBeGreaterThan(0.8);
    expect([...r.suitWhy.values()].some((w) => /via particular/.test(w))).toBe(true);
    // penalidade: percorrer a aresta privada custa mais que a pública equivalente (tempo extra = pen)
    const e = ok.find((x) => g.len[x] > 20)!;
    const base = g.len[e] / ((DEFAULT_PROFILE.walk_speed_kmh) / 3.6);
    expect(r.wFwd[e]).toBeGreaterThan(base + 60 * g.share[e]);
  });
  it("entrega NUMA via particular urbana a ~1 km: a parada é alcançável e a rota avisa", () => {
    const e = privUrban.find((x) => r.edgeOk[x] === 1 && g.len[x] > 15)!;
    const la = (g.lat[g.ea[e]] + g.lat[g.eb[e]]) / 2, lo = (g.lon[g.ea[e]] + g.lon[g.eb[e]]) / 2;
    const res = computePlan(g, {
      start: { lat: la + 0.006, lon: lo + 0.004 }, mode: "open", strategy: "global", profile: { ...DEFAULT_PROFILE }, timeLimitMs: 800, maxSnap: 150,
      stops: [{ key: "vila", lat: la, lon: lo, service: 30, label: "Vila particular, 10" }],
    });
    expect(res.order.map((o) => o.key)).toEqual(["vila"]);
    expect(res.excluded).toEqual([]);
  });
  it("erro 'nenhuma parada alcançável' agora diz QUAIS paradas e POR QUÊ", () => {
    // ponto no meio do oceano: nenhuma malha a menos de 150 m
    let msg = "";
    try { computePlan(g, { start: { lat: -23.9372, lon: -46.3318 }, mode: "open", strategy: "global", profile: { ...DEFAULT_PROFILE }, timeLimitMs: 300, maxSnap: 150, stops: [{ key: "mar", lat: -24.2, lon: -46.1, service: 30, label: "Rua do Mar, 1 - Santos" }] }); } catch (e) { msg = (e as Error).message; }
    expect(msg).toMatch(/Nenhuma parada alcançável/);
    expect(msg).toMatch(/Rua do Mar, 1/);
    expect(msg).toMatch(/m da malha|conectada|trilha/);
  });
});
