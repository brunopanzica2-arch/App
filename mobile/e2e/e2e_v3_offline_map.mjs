// E2E V3 — mapa-base OFFLINE de Santos: primeira abertura SEM INTERNET (toda requisição externa é bloqueada e contada).
// Fluxo: ponto de partida (TESTE) -> importar 300 cartas -> posições TESTE -> planejar -> tela Rota com ruas locais.
// Uso: npm run build && npx vite preview --port 4173 &  node e2e/e2e_v3_offline_map.mjs
import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright";

const BASE = process.env.E2E_BASE || "http://localhost:4173/";
const OUT = process.env.E2E_SHOTS || "../docs/EVIDENCIAS_V3";
const TD = path.resolve("../test-data");
fs.mkdirSync(OUT, { recursive: true });
const results = {};
const pass = (id, ok, detail) => { results[id] = { ok, detail }; console.log(`${ok ? "PASSOU" : "FALHOU"} ${id}: ${detail}`); };

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
const ctx = await browser.newContext({ viewport: { width: 412, height: 915 }, deviceScaleFactor: 2, locale: "pt-BR", serviceWorkers: "block" });
const external = [];
await ctx.route("**/*", (route) => {
  const u = new URL(route.request().url());
  if (u.hostname === "localhost" || u.protocol === "data:" || u.protocol === "blob:") return route.continue();
  external.push(route.request().url());
  return route.abort("internetdisconnected");
});
const page = await ctx.newPage();
page.setDefaultTimeout(180000);
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
page.on("dialog", (d) => d.accept());
const consoleMsgs = [];
page.on("console", (m) => { if (["error", "warning"].includes(m.type())) consoleMsgs.push(`${m.type()}: ${m.text()}`.slice(0, 300)); });
const text = () => page.locator("main").innerText();

await page.goto(BASE);
// ponto de partida TESTE gravado direto no IndexedDB (a geocodificação da origem exige internet; aqui não há)
await page.evaluate(async () => {
  await new Promise((res, rej) => {
    const open = indexedDB.open("rota-santos");
    open.onsuccess = () => {
      const db = open.result;
      const tx = db.transaction("settings", "readwrite");
      tx.objectStore("settings").put({ key: "main", start: { label: "PONTO TESTE (Rua Joaquim Távora, centro da rua)", lat: -23.9480025, lon: -46.3406209, confirmed: true },
        startAddress: "Rua Joaquim Távora, 480, Santos/SP", serviceTime: 45, perLetterService: 10, routeMode: "open", nominatimEmail: "", currentBatch: null });
      tx.oncomplete = () => { db.close(); res(); };
      tx.onerror = () => rej(tx.error);
    };
    open.onerror = () => rej(open.error);
  });
});
await page.goto(BASE + "#/"); await page.reload();

await page.goto(BASE + "#/importar");
await page.locator("#file").setInputFiles(path.join(TD, "cenario_300_cartas_centro_paqueta_vila_nova.csv"));
await page.getByRole("button", { name: "Pré-visualizar" }).click();
await page.getByText("Mapeamento de colunas").waitFor();
await page.getByRole("button", { name: /Confirmar e localizar/ }).click();
await page.getByText(/Lote:/).waitFor();
await page.goto(BASE + "#/"); await page.waitForTimeout(500);
await page.getByText(/Endereços a conferir/).click();
await page.getByLabel("Importar coordenadas").setInputFiles(path.join(TD, "posicoes_teste_osm.csv"));
await page.getByText(/Coordenadas:/).waitFor();
// mapa da revisão (pino + candidatos) também usa o pacote offline
await page.waitForTimeout(2500);
await page.screenshot({ path: `${OUT}/20-revisao-mapa-offline.png` });
await page.goto(BASE + "#/");
await page.waitForTimeout(800);
await page.getByRole("button", { name: /Planejar rota/ }).click();
await page.fill("#tl", "6");
await page.getByRole("button", { name: /Calcular rota/ }).click();
await page.getByText("Soluções comparadas").waitFor({ timeout: 300000 });
await page.waitForTimeout(3500);
await page.screenshot({ path: `${OUT}/21-planejamento-mapa-offline.png` });

await page.goto(BASE + "#/"); await page.waitForTimeout(500);
await page.getByRole("button", { name: /Abrir jornada/ }).click();
await page.getByText("Mapa offline (pacote de Santos)").waitFor({ timeout: 30000 }).catch(() => {});
await page.waitForTimeout(4000);
const badge = await page.getByText(/Mapa offline \(pacote de Santos\)|Mapa-base indisponível|Mapa online/).first().innerText().catch(() => "(sem selo)");
await page.screenshot({ path: `${OUT}/22-jornada-mapa-offline.png` });
pass("OFFLINE-1-primeira-abertura-sem-internet", /pacote de Santos/.test(badge), `selo do mapa: "${badge}"`);
pass("OFFLINE-2-zero-chamadas-externas", external.length === 0, `requisições externas bloqueadas: ${external.length}${external.length ? " → " + [...new Set(external.map((u) => new URL(u).host))].join(", ") : ""}`);
pass("OFFLINE-3-sem-erros-de-pagina", errors.length === 0, errors.length ? errors.slice(0, 3).join(" | ") : "nenhum erro de página");
fs.writeFileSync(`${OUT}/e2e_v3_offline_map_resultados.json`, JSON.stringify({ results, externas: external.slice(0, 20), errors, console: consoleMsgs.slice(0, 30) }, null, 1));
await browser.close();
process.exit(Object.values(results).every((r) => r.ok) ? 0 : 1);
