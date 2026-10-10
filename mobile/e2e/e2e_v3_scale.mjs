// E2E V3 — escala (E2E-19): 1000 cartas FICTÍCIAS / 500 paradas sobre posições TESTE. Mede no NAVEGADOR (Chromium headless
// no contêiner, NÃO é celular): importação, cálculo, DOM da lista virtualizada, rolagem e memória JS.
// Uso: npm run build && npx vite preview --port 4173 &  node e2e/e2e_v3_scale.mjs
import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright";

const BASE = process.env.E2E_BASE || "http://localhost:4173/";
const OUT = process.env.E2E_SHOTS || "../docs/EVIDENCIAS_V3";
const TD = path.resolve("../test-data");
const N_CARTAS = 1000, N_PARADAS = 500;
const results = {};
const pass = (id, ok, detail) => { results[id] = { ok, detail }; console.log(`${ok ? "PASSOU" : "FALHOU"} ${id}: ${detail}`); };

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
const ctx = await browser.newContext({ viewport: { width: 412, height: 915 }, deviceScaleFactor: 2, locale: "pt-BR", serviceWorkers: "block" });
const page = await ctx.newPage();
page.setDefaultTimeout(300000);
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
page.on("dialog", (d) => d.accept());
await page.addInitScript(() => {
  window.__long = [];
  try { new PerformanceObserver((l) => l.getEntries().forEach((e) => window.__long.push(Math.round(e.duration)))).observe({ entryTypes: ["longtask"] }); } catch {}
});
const text = () => page.locator("main").innerText();
const heap = () => page.evaluate(() => (performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1048576) : null));

await page.goto(BASE);
await page.evaluate(async () => {
  await new Promise((res, rej) => {
    const open = indexedDB.open("rota-santos");
    open.onsuccess = () => {
      const db = open.result, tx = db.transaction("settings", "readwrite");
      tx.objectStore("settings").put({ key: "main", start: { label: "PONTO TESTE", lat: -23.9480025, lon: -46.3406209, confirmed: true },
        startAddress: "Rua Joaquim Távora, 480, Santos/SP", serviceTime: 45, perLetterService: 10, routeMode: "open", nominatimEmail: "", currentBatch: null });
      tx.oncomplete = () => { db.close(); res(); };
      tx.onerror = () => rej(tx.error);
    };
  });
});
await page.reload();

let t0 = Date.now();
await page.goto(BASE + "#/importar");
await page.locator("#file").setInputFiles(path.join(TD, "v3", "cenario_1000_cartas_500_paradas.csv"));
await page.getByRole("button", { name: "Pré-visualizar" }).click();
await page.getByText("Mapeamento de colunas").waitFor();
const pv = await text();
await page.getByRole("button", { name: /Confirmar e localizar/ }).click();
await page.getByText(/Lote:/).waitFor();
const tImport = ((Date.now() - t0) / 1000).toFixed(1);
pass("ESCALA-1-importacao", new RegExp(`Linhas:\\s*${N_CARTAS}`).test(pv) && new RegExp(`Imóveis únicos:\\s*${N_PARADAS}`).test(pv), `prévia ${/Linhas:\s*(\d+)/.exec(pv)?.[1]} linhas / ${/Imóveis únicos:\s*(\d+)/.exec(pv)?.[1]} imóveis; importação em ${tImport} s`);

await page.goto(BASE + "#/"); await page.waitForTimeout(500);
await page.getByText(/Endereços a conferir/).click();
await page.getByLabel("Importar coordenadas").setInputFiles(path.join(TD, "v3", "posicoes_teste_1000.csv"));
await page.getByText(/Coordenadas:/).waitFor();
const coord = await page.getByText(/Coordenadas:/).innerText();
await page.goto(BASE + "#/"); await page.waitForTimeout(800);
const heapAfterImport = await heap();

await page.getByRole("button", { name: /Planejar rota/ }).click();
await page.fill("#tl", "10");
t0 = Date.now();
await page.getByRole("button", { name: /Calcular rota/ }).click();
await page.getByText("Soluções comparadas").waitFor({ timeout: 600000 });
const tPlan = ((Date.now() - t0) / 1000).toFixed(1);
await page.waitForTimeout(2500);
const plan = await text();
const nStops = /Paradas\s*(\d+)/i.exec(plan)?.[1], dist = /Distância\s*([\d,]+ km)/i.exec(plan)?.[1];
const partial = /ROTA PARCIAL/.test(plan);
pass("ESCALA-2-calculo", nStops === String(N_PARADAS) && !partial, `${nStops} paradas, ${dist}, cálculo ${tPlan} s no navegador, ${partial ? "PARCIAL" : "completa"}; ${coord}`);
const heapAfterPlan = await heap();

await page.goto(BASE + "#/"); await page.waitForTimeout(500);
await page.getByRole("button", { name: /Abrir jornada/ }).click();
await page.getByText(/Próxima parada · 1 de/).waitFor();
await page.waitForTimeout(3000);
await page.getByRole("button", { name: "Lista de paradas" }).click();
await page.getByTestId("stop-list").waitFor();
const rowsInDom = await page.locator("[data-testid=stop-list] li").count();
const total = await page.locator("ol[aria-label$='paradas']").getAttribute("aria-label");
pass("ESCALA-3-lista-virtualizada", rowsInDom > 0 && rowsInDom < 60 && /500 paradas/.test(total || ""), `${rowsInDom} linhas no DOM para ${total}`);
await page.screenshot({ path: `${OUT}/23-lista-500-paradas.png` });

if (process.env.HIDE_MAP) await page.evaluate(() => { document.querySelectorAll("canvas").forEach((c) => (c.style.display = "none")); });
// rolagem até o fim: mede quadros perdidos (rAF > 50 ms) e confere que a última parada aparece
const scroll = await page.evaluate(async () => {
  const el = document.querySelector("[data-testid=stop-list]");
  const gaps = []; let last = performance.now(), run = true;
  const tick = () => { const n = performance.now(); gaps.push(n - last); last = n; if (run) requestAnimationFrame(tick); };
  requestAnimationFrame(tick);
  const t0 = performance.now();
  for (let y = 0; y <= el.scrollHeight; y += 400) { el.scrollTop = y; await new Promise((r) => setTimeout(r, 16)); }
  el.scrollTop = el.scrollHeight; await new Promise((r) => setTimeout(r, 400));
  run = false;
  return { ms: Math.round(performance.now() - t0), worst: Math.round(Math.max(...gaps)), over50: gaps.filter((g) => g > 50).length, frames: gaps.length,
    lastVisible: [...el.querySelectorAll("li b")].map((b) => b.textContent).slice(-1)[0] };
});
pass("ESCALA-4-rolagem", scroll.lastVisible === String(N_PARADAS), `rolou 500 paradas em ${scroll.ms} ms; pior quadro ${scroll.worst} ms; ${scroll.over50}/${scroll.frames} quadros > 50 ms; última linha visível: ${scroll.lastVisible}`);
await page.getByLabel("Buscar parada").fill("Campos Salles");
await page.waitForTimeout(500);
const filtered = await page.locator("[data-testid=stop-list] li").count();
pass("ESCALA-5-busca", filtered > 0, `busca "Campos Salles": ${filtered} linhas renderizadas`);
const longtasks = await page.evaluate(() => window.__long);
const heapEnd = await heap();
pass("ESCALA-6-estabilidade", errors.length === 0, `erros de página: ${errors.length}; tarefas longas (>50 ms): ${longtasks.length}, maior ${Math.max(0, ...longtasks)} ms; heap JS: ${heapAfterImport}→${heapAfterPlan}→${heapEnd} MB`);
fs.writeFileSync(`${OUT}/e2e_v3_scale_resultados${process.env.HIDE_MAP ? '_sem_mapa' : ''}.json`, JSON.stringify({ results, medidas: { tImport, tPlan, scroll, rowsInDom, longtasks: longtasks.length, heapMB: { aposImport: heapAfterImport, aposPlano: heapAfterPlan, fim: heapEnd } },
  ambiente: "Chromium headless em contêiner Linux 4 vCPU — NÃO é celular", errors }, null, 1));
await browser.close();
process.exit(Object.values(results).every((r) => r.ok) ? 0 : 1);
