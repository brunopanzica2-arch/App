// E2E 2.3 no Chromium (viewport de celular 412x915). NÃO é Android: capturas em docs/evidencias-chromium-2_3/.
// Cobre: busca universal (malha offline + provedor interceptado), número preservado (nunca S/N), cartão com ações,
// prévia de rota a pé, guarda de segurança antes de iniciar e relato de trecho com recálculo.
import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright";

const BASE = process.env.E2E_BASE || "http://localhost:4173/";
const OUT = path.resolve(process.env.E2E_SHOTS || "../docs/evidencias-chromium-2_3");
const TD = path.resolve("../test-data");
fs.mkdirSync(OUT, { recursive: true });
const results = {};
const pass = (id, ok, d) => { results[id] = { ok, detail: d }; console.log(`${ok ? "PASSOU" : "FALHOU"} ${id}: ${d}`); };

const posCsv = fs.readFileSync(path.join(TD, "posicoes_teste_osm.csv"), "utf8").replace(/^﻿/, "").trim().split(/\r?\n/).slice(1);
const rows = posCsv.map((l) => { const c = l.split(";"); return { bairro: c[1], rua: c[2], num: c[3] }; });
const lines = rows.filter((r, i) => i % 9 === 0).slice(0, 7).map((r) => `${r.rua} ${r.num} ${r.bairro}`);

const browser = await chromium.launch({ args: ["--use-gl=swiftshader", "--enable-webgl", "--ignore-gpu-blocklist", "--enable-unsafe-swiftshader"], executablePath: process.env.CHROMIUM_PATH || undefined });
const ctx = await browser.newContext({ viewport: { width: 412, height: 915 }, deviceScaleFactor: 1, locale: "pt-BR", serviceWorkers: "block",
  geolocation: { latitude: -23.9372, longitude: -46.3318, accuracy: 10 }, permissions: ["geolocation"] });
const page = await ctx.newPage();
page.setDefaultTimeout(120000);
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
page.on("dialog", (d) => d.accept());
const nomUrls = [];
await ctx.route(/nominatim\.openstreetmap\.org/, (r) => { nomUrls.push(r.request().url()); return r.fulfill({ status: 200, contentType: "application/json", body: "[]" }); });
const shot = (n) => page.screenshot({ path: path.join(OUT, `${n}.png`) });
const home = () => page.evaluate(() => { const e = document.querySelector("[data-testid=map-home]"); return e ? { ...e.dataset } : null; });
const waitHome = (cond, t = 120000) => page.waitForFunction(cond, null, { timeout: t });

await page.goto(BASE);
await page.evaluate(() => new Promise((res, rej) => {
  const o = indexedDB.open("rota-santos");
  o.onsuccess = () => { const db = o.result, tx = db.transaction("settings", "readwrite");
    tx.objectStore("settings").put({ key: "main", start: null, startAddress: "x", serviceTime: 45, perLetterService: 10, routeMode: "open", nominatimEmail: "", currentBatch: null });
    tx.oncomplete = () => { db.close(); res(); }; tx.onerror = () => rej(tx.error); };
}));
await page.reload();
await waitHome(() => ["operational", "error"].includes(document.querySelector("[data-testid=map-home]")?.dataset.mapState));
await waitHome(() => document.querySelector("[data-testid=map-home]")?.dataset.gpsState === "ok").catch(() => {});

// ---------------------------------------------------------------- 1. busca universal (sem nenhuma entrega importada)
await page.getByRole("button", { name: "Buscar endereço ou entrega" }).click();
const box = page.getByLabel("Buscar", { exact: true });
await box.pressSequentially("rua joaquim tavora 480", { delay: 40 });
await page.getByTestId("addr-results").locator("li button").first().waitFor();
const firstTitle = await page.getByTestId("addr-results").locator("li button b").first().innerText();
const resText = await page.getByTestId("addr-results").innerText();
await shot("01_busca_enderecos_offline");
pass("BUSCA-01 autocomplete de ruas sem nenhuma entrega importada", /Joaquim/i.test(firstTitle), `1º resultado: ${firstTitle}`);
pass("BUSCA-02 número digitado preservado e marcado 'não confirmado' (nunca S/N)", /480/.test(firstTitle) && /não confirmado/i.test(resText) && !/S\/N/.test(resText), resText.replace(/\n/g, " | ").slice(0, 160));
pass("BUSCA-03 digitar NÃO consulta o Nominatim público", nomUrls.length === 0, `${nomUrls.length} consulta(s) durante a digitação`);

// submeter: 1 consulta, escopo Santos
await page.getByRole("button", { name: "Buscar endereço", exact: true }).click();
await page.waitForTimeout(2500);
pass("BUSCA-04 enviar consulta ao provedor: 1 requisição, escopo Santos/SP", nomUrls.length === 1 && /viewbox=/.test(nomUrls[0]) && /city=Santos/.test(nomUrls[0]) && /state=SP/.test(nomUrls[0]), nomUrls[0] ? decodeURIComponent(nomUrls[0]).slice(0, 220) : "nenhuma");
await shot("02_busca_enviada");

// cartão com ações
await page.getByTestId("addr-results").locator("li button").first().click();
await page.getByTestId("found-card").waitFor();
const card = await page.getByTestId("found-card").innerText();
await page.waitForTimeout(1200);
await shot("03_cartao_resultado");
pass("BUSCA-05 cartão: 4 ações e 'Número não confirmado'", ["Adicionar carta", "Traçar rota até aqui", "Ver no mapa", "Corrigir posição"].every((a) => card.includes(a)) && /Número não confirmado/.test(card) && !/S\/N/.test(card), card.replace(/\n/g, " | ").slice(0, 220));

// rota a pé até o ponto (perfil urbano seguro)
await page.getByRole("button", { name: /Traçar rota até aqui/ }).click();
await page.getByTestId("preview-info").waitFor({ timeout: 120000 }).catch(() => {});
const pv = (await page.getByTestId("preview-info").count()) ? await page.getByTestId("preview-info").innerText() : "(sem prévia)";
await page.waitForTimeout(1500);
await shot("04_rota_ate_aqui");
pass("BUSCA-06 'Traçar rota até aqui' calcula rota a pé", /m|km/.test(pv) && /a pé/.test(pv), pv);

// corrigir posição: marcador arrastável
await page.getByRole("button", { name: "Corrigir posição" }).click();
await page.waitForTimeout(600);
await shot("05_corrigir_posicao");
pass("BUSCA-07 'Corrigir posição' alterna para 'Pronto'", await page.getByRole("button", { name: "Pronto" }).isVisible(), "ok");
await page.getByRole("button", { name: "Fechar resultado" }).click();

// ---------------------------------------------------------------- 2. importar, rota e guarda
await page.getByRole("button", { name: /Importar cartas/ }).last().click();
await page.getByRole("tab", { name: /Colar texto/ }).click();
await page.locator("#text").fill(lines.join("\n"));
await page.getByRole("button", { name: "Pré-visualizar" }).click();
await page.getByTestId("inferred").waitFor();
await page.getByRole("button", { name: /Confirmar e localizar/ }).click();
await page.getByText(/Lote:/).waitFor();
await page.getByText(/imóveis consultados/).waitFor();
await page.getByRole("button", { name: "Revisar endereços" }).click();
await page.getByLabel("Importar coordenadas").setInputFiles(path.join(TD, "posicoes_teste_osm.csv"));
await page.getByText(/Coordenadas:/).waitFor();
await page.goto(BASE + "#/");
await waitHome(() => document.querySelector("[data-testid=map-home]")?.dataset.phase === "unplanned");
await page.getByRole("button", { name: "Calcular rota" }).click();
await waitHome(() => document.querySelector("[data-testid=map-home]")?.dataset.phase === "planned", 240000);
await page.waitForTimeout(2000);
await shot("06_rota_com_guarda");
const guard = page.getByTestId("route-guard");
const gl = (await guard.count()) ? await guard.getAttribute("data-level") : null;
const gt = (await guard.count()) ? await guard.innerText() : "";
pass("SEG-01 selo de segurança visível; 'Rota revisada' só se nada aproximado/não verificado", !!gl && (gl === "reviewed" ? /Rota revisada/.test(gt) : !/Rota revisada/.test(gt)), `nível=${gl} | ${gt.replace(/\n/g, " | ").slice(0, 200)}`);

await page.getByRole("button", { name: /Iniciar navegação/ }).click();
const dlg = page.getByRole("dialog");
const confirmShown = await dlg.count();
if (confirmShown) { await shot("07_confirmacao_antes_de_iniciar"); }
pass("SEG-02 rota não 100% revisada pede confirmação antes de iniciar", gl === "reviewed" ? !confirmShown : confirmShown > 0, `nível=${gl} diálogo=${confirmShown}`);
if (confirmShown) await page.getByRole("button", { name: "Iniciar mesmo assim" }).click();
await waitHome(() => document.querySelector("[data-testid=map-home]")?.dataset.nav === "on");
await page.waitForTimeout(2500);
await shot("08_navegando");

// relato de trecho → recálculo evitando-o
const before = await page.evaluate(() => new Promise((res) => { const o = indexedDB.open("rota-santos"); o.onsuccess = () => { const r = o.result.transaction("settings").objectStore("settings").get("main"); r.onsuccess = () => res((r.result?.reportedEdges ?? []).length); }; }));
await page.getByTestId("report-segment").click();
await page.getByText(/Calculando rota/).first().waitFor({ timeout: 20000 }).catch(() => {});
await page.getByText(/Calculando rota/).first().waitFor({ state: "detached", timeout: 240000 }).catch(() => {});
await waitHome(() => document.querySelector("[data-testid=map-home]")?.dataset.phase === "planned", 240000).catch(() => {});
await page.waitForTimeout(1500);
await shot("09_apos_relato");
const after = await page.evaluate(() => new Promise((res) => { const o = indexedDB.open("rota-santos"); o.onsuccess = () => { const r = o.result.transaction("settings").objectStore("settings").get("main"); r.onsuccess = () => res((r.result?.reportedEdges ?? []).length); }; }));
pass("SEG-03 'Reportar problema neste trecho' grava o trecho e recalcula uma nova rota", after === before + 1 && (await home()).phase === "planned", `trechos reportados ${before} → ${after}; fase=${(await home()).phase}`);

pass("sem erros de página", errors.length === 0, errors.join(" | ") || "nenhum");
await browser.close();
fs.writeFileSync(path.join(OUT, "resultado_e2e_2_3.json"), JSON.stringify(results, null, 2));
const bad = Object.entries(results).filter(([, v]) => !v.ok).map(([k]) => k);
console.log(bad.length ? `FALHAS: ${bad.join("; ")}` : "TODOS PASSARAM");
process.exit(bad.length ? 1 : 0);
