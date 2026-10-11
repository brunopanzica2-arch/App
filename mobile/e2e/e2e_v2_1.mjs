// E2E 2.1 no Chromium (viewport de celular 412x915). NÃO é Android: as capturas ficam em docs/evidencias-chromium-2_1/.
// Cobre: mapa real, GPS automático, importação de texto livre sem separador, rota, navegação, recompensa, conclusão (rota some),
// encerrar (rota some), retomar, ajustes de localização, regressão visual por pixel (pixelmatch) e checagem de "tela vazia".
// Uso: node e2e/e2e_v2_1.mjs [--update-baseline]
import fs from "node:fs";
import path from "node:path";
import AxeBuilder from "@axe-core/playwright";
import pixelmatch from "pixelmatch";
import { PNG } from "pngjs";
import { chromium } from "playwright";

const BASE = process.env.E2E_BASE || "http://localhost:4173/";
const OUT = path.resolve(process.env.E2E_SHOTS || "../docs/evidencias-chromium-2_1");
const BASELINE = path.resolve("e2e/baseline");
const UPDATE = process.argv.includes("--update-baseline");
const TD = path.resolve("../test-data");
fs.mkdirSync(OUT, { recursive: true });
fs.mkdirSync(BASELINE, { recursive: true });
const results = {};
const pass = (id, ok, d) => { results[id] = { ok, detail: d }; console.log(`${ok ? "PASSOU" : "FALHOU"} ${id}: ${d}`); };

// ---- fixtures: endereços em TEXTO LIVRE (sem separador, sem cabeçalho) a partir das posições TESTE
const posCsv = fs.readFileSync(path.join(TD, "posicoes_teste_osm.csv"), "utf8").replace(/^﻿/, "").trim().split(/\r?\n/).slice(1);
const rows = posCsv.map((l) => { const c = l.split(";"); return { bairro: c[1], rua: c[2], num: c[3] }; });
const pick = rows.filter((r, i) => i % 9 === 0).slice(0, 7);
const lines = pick.map((r) => `${r.rua} ${r.num} ${r.bairro}`);
lines.push(lines[0], lines[0]); // 3 cartas no mesmo imóvel (uma parada)
const FREE = lines.join("\n");

const browser = await chromium.launch({ args: ["--use-gl=swiftshader", "--enable-webgl", "--ignore-gpu-blocklist", "--enable-unsafe-swiftshader"], executablePath: process.env.CHROMIUM_PATH || undefined });
const ctx = await browser.newContext({ viewport: { width: 412, height: 915 }, deviceScaleFactor: 1, locale: "pt-BR", serviceWorkers: "block",
  geolocation: { latitude: -23.9372, longitude: -46.3318, accuracy: 10 }, permissions: ["geolocation"] });
const page = await ctx.newPage();
page.setDefaultTimeout(120000);
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
page.on("dialog", (d) => d.accept());
let nominatim = 0;
const nomUrls = [];
// o teste não usa a rede pública: as consultas são interceptadas (e contadas) para provar o escopo Santos/SP e o limite de consultas
await ctx.route(/nominatim\.openstreetmap\.org/, (r) => { nominatim++; nomUrls.push(r.request().url()); return r.fulfill({ status: 200, contentType: "application/json", body: "[]" }); });

const shotFiles = [];
async function shot(name) {
  const f = path.join(OUT, `${name}.png`);
  await page.screenshot({ path: f });
  shotFiles.push(name);
  return f;
}
/** Tela vazia/branca? Mede variância de cor na região do mapa. */
function variance(file, box) {
  const img = PNG.sync.read(fs.readFileSync(file));
  const { x, y, w, h } = box;
  let n = 0, sum = 0, sum2 = 0;
  for (let j = y; j < Math.min(y + h, img.height); j += 3) for (let i = x; i < Math.min(x + w, img.width); i += 3) {
    const k = (img.width * j + i) * 4; const l = 0.3 * img.data[k] + 0.59 * img.data[k + 1] + 0.11 * img.data[k + 2];
    n++; sum += l; sum2 += l * l;
  }
  const m = sum / n; return Math.sqrt(Math.max(0, sum2 / n - m * m));
}
function diffAgainstBaseline(name, mask = []) {
  const cur = PNG.sync.read(fs.readFileSync(path.join(OUT, `${name}.png`)));
  const bf = path.join(BASELINE, `${name}.png`);
  if (UPDATE || !fs.existsSync(bf)) { fs.copyFileSync(path.join(OUT, `${name}.png`), bf); return { ratio: 0, created: true }; }
  const base = PNG.sync.read(fs.readFileSync(bf));
  if (base.width !== cur.width || base.height !== cur.height) return { ratio: 1, size: true };
  for (const m of mask) for (let j = m.y; j < m.y + m.h; j++) for (let i = m.x; i < m.x + m.w; i++) { const k = (cur.width * j + i) * 4; for (let c = 0; c < 4; c++) { cur.data[k + c] = 0; base.data[k + c] = 0; } }
  const diff = new PNG({ width: cur.width, height: cur.height });
  const bad = pixelmatch(base.data, cur.data, diff.data, cur.width, cur.height, { threshold: 0.12 });
  if (bad / (cur.width * cur.height) > 0.02) fs.writeFileSync(path.join(OUT, `${name}.DIFF.png`), PNG.sync.write(diff));
  return { ratio: bad / (cur.width * cur.height) };
}
const home = () => page.evaluate(() => { const e = document.querySelector("[data-testid=map-home]"); return e ? { ...e.dataset } : null; });
const waitHome = (cond, t = 120000) => page.waitForFunction(cond, null, { timeout: t });

// ---------------------------------------------------------------- semente: sem ponto manual (a origem é o GPS)
await page.goto(BASE);
await page.evaluate(() => new Promise((res, rej) => {
  const o = indexedDB.open("rota-santos");
  o.onsuccess = () => { const db = o.result, tx = db.transaction("settings", "readwrite");
    tx.objectStore("settings").put({ key: "main", start: null, startAddress: "x", serviceTime: 45, perLetterService: 10, routeMode: "open", nominatimEmail: "", currentBatch: null });
    tx.oncomplete = () => { db.close(); res(); }; tx.onerror = () => rej(tx.error); };
}));
await page.reload();

// 1. home sem entregas
await waitHome(() => ["operational", "error"].includes(document.querySelector("[data-testid=map-home]")?.dataset.mapState));
await waitHome(() => document.querySelector("[data-testid=map-home]")?.dataset.gpsState === "ok").catch(() => {});
await page.waitForTimeout(1500);
const f1 = await shot("01_home_sem_entregas");
let h = await home();
pass("P0.1 mapa real na home sem cartas", h.mapState === "operational" && variance(f1, { x: 0, y: 150, w: 412, h: 350 }) > 12, `estado=${h.mapState} variância=${variance(f1, { x: 0, y: 150, w: 412, h: 350 }).toFixed(1)}`);
pass("P0.3 GPS automático (sem ponto manual)", h.gpsState === "ok" && /^-23\.937/.test(h.fix), `gps=${h.gpsState} fix=${h.fix}`);
pass("UX home vazia: CTA Importar", await page.getByRole("button", { name: /Importar cartas/ }).last().isVisible(), "botão visível");

// 2. importação por texto livre, sem separador/cabeçalho
await page.getByRole("button", { name: /Importar cartas/ }).last().click();
await page.getByRole("tab", { name: /Colar texto/ }).click();
await shot("02_importacao_vazia");
await page.locator("#text").fill(FREE);
await page.getByRole("button", { name: "Pré-visualizar" }).click();
await page.getByTestId("inferred").waitFor();
await page.waitForTimeout(400);
const f3 = await shot("03_importacao_texto_livre");
const prev = await page.locator("[aria-label='Prévia das linhas']").innerText();
const okFree = pick.every((r) => prev.includes(String(r.num)));
pass("IMP texto livre: rua e número reconhecidos sem separador", okFree && /Linhas lidas:\s*9/.test(await page.locator("main").innerText()), `${lines.length} linhas; prévia contém todos os números`);
await page.getByRole("button", { name: /Confirmar e localizar/ }).click();
await page.getByText(/Lote:/).waitFor();
const res = await page.locator("main").innerText();
pass("IMP 3 cartas no mesmo imóvel preservadas", /Inseridas:\s*9/.test(res) && /duplicadas:\s*0/.test(res), (res.match(/Inseridas:[^\n]*/) || [""])[0]);
// posições TESTE (fixtures) → rota
await page.getByRole("button", { name: "Revisar endereços" }).click();
await page.getByLabel("Importar coordenadas").setInputFiles(path.join(TD, "posicoes_teste_osm.csv"));
await page.getByText(/Coordenadas:/).waitFor();
await shot("04_revisao_enderecos");

// 3. home com entregas e sem rota
await page.goto(BASE + "#/");
await waitHome(() => document.querySelector("[data-testid=map-home]")?.dataset.phase === "unplanned");
await page.waitForTimeout(1200);
const f5 = await shot("05_home_com_entregas_sem_rota");
h = await home();
pass("estado B: entregas sem rota (sem rota no mapa, CTA Calcular)", h.phase === "unplanned" && h.route === "off" && await page.getByRole("button", { name: "Calcular rota" }).isVisible(), `fase=${h.phase} rota=${h.route}`);

// 4. rota calculada (origem = GPS)
await page.getByRole("button", { name: "Calcular rota" }).click();
await waitHome(() => document.querySelector("[data-testid=map-home]")?.dataset.phase === "planned", 240000);
await page.waitForTimeout(2500);
const f6 = await shot("06_home_rota_calculada");
h = await home();
pass("estado C: rota calculada visível + Iniciar navegação", h.route === "on" && await page.getByRole("button", { name: /Iniciar navegação/ }).isVisible(), `fase=${h.phase} rota=${h.route}`);

// 5. navegação: 2D → 3D imersivo
await page.getByRole("button", { name: /Iniciar navegação/ }).click();
await waitHome(() => document.querySelector("[data-testid=map-home]")?.dataset.phase === "navigating");
await page.waitForTimeout(2500);
await shot("07_navegacao");
h = await home();
const cam = async () => (await page.evaluate(() => document.querySelector("[role=application]")?.parentElement?.dataset.cam ?? "")).split(",").map(Number);
await page.waitForFunction(() => Number((document.querySelector("[role=application]")?.parentElement?.dataset.cam ?? "0,0,0").split(",")[1]) > 40, null, { timeout: 20000 }).catch(() => {});
const [z3, p3] = await cam();
pass("estado D: navegando (câmera 3D por padrão, rota ligada)", h.phase === "navigating" && h.follow === "3d" && h.route === "on", `fase=${h.phase} câmera=${h.follow}`);
pass("navegação imersiva: câmera REALMENTE inclinada e aproximada", p3 >= 45 && z3 >= 17.5, `zoom=${z3} pitch=${p3}°`);
await page.getByRole("button", { name: /Câmera 3D/ }).click();
await page.waitForTimeout(1800);
await shot("08_navegacao_2d");
h = await home();
const [, p2] = await cam();
pass("alternar 2D/3D (pitch volta a 0 no 2D)", h.follow === "2d" && p2 < 5, `câmera=${h.follow} pitch=${p2}°`);
await page.getByRole("button", { name: /Câmera 2D/ }).click();
await page.waitForTimeout(1500);

// 6. concluir uma entrega: recompensa
await page.getByRole("button", { name: /^(Entregue|Entregar todas)/ }).first().click();
if (await page.getByRole("dialog", { name: "Confirmar entrega" }).count()) await page.getByRole("dialog", { name: "Confirmar entrega" }).getByRole("button", { name: "Entregar todas" }).click();
await page.getByTestId("reward").waitFor();
await page.waitForTimeout(500);
await shot("09_apos_uma_entrega_recompensa");
const rw = await page.getByTestId("reward").innerText();
pass("recompensa pós-entrega (curta, com restantes e XP)", /Restam|Última carta/.test(rw) && /XP/.test(rw), rw.replace(/\n/g, " | "));

// 7. concluir TODAS: rota some, sem CTA de navegação
let guard = 0;
while ((await home()).phase !== "completed" && guard++ < 40) {
  const btn = page.getByRole("button", { name: /^(Entregue|Entregar todas)/ }).first();
  if (!(await btn.count())) break;
  await btn.click();
  if (await page.getByRole("dialog", { name: "Confirmar entrega" }).count()) await page.getByRole("dialog", { name: "Confirmar entrega" }).getByRole("button", { name: "Entregar todas" }).click();
  await page.waitForTimeout(700);
}
await waitHome(() => document.querySelector("[data-testid=map-home]")?.dataset.phase === "completed", 60000);
await page.waitForTimeout(1500);
const f10 = await shot("10_rota_concluida");
h = await home();
const cta = await page.getByRole("button", { name: /Iniciar navegação/ }).count();
pass("P0 rota some do mapa ao concluir", h.route === "off" && h.nav === "off", `fase=${h.phase} rota=${h.route} nav=${h.nav}`);
pass("P0 sem 'Iniciar navegação' após concluir", cta === 0, `botões 'Iniciar navegação'=${cta}`);
pass("conclusão: resumo e saída clara", await page.getByTestId("completion").isVisible() && await page.getByRole("button", { name: /Encerrar e limpar o mapa/ }).isVisible(), (await page.getByTestId("completion").innerText()).replace(/\n/g, " | ").slice(0, 160));
pass("mapa continua renderizado após concluir", h.mapState === "operational" && variance(f10, { x: 0, y: 120, w: 412, h: 250 }) > 12, `estado=${h.mapState}`);
await page.getByRole("button", { name: /Encerrar e limpar o mapa/ }).click();
await page.waitForTimeout(1200);
await shot("11_apos_limpar");
h = await home();
pass("após limpar: nenhum overlay e nenhuma rota ativa", h.route === "off" && (await page.getByRole("button", { name: /Iniciar navegação/ }).count()) === 0, `fase=${h.phase}`);

// 8. encerrar manualmente (novo lote com os mesmos endereços)
await page.goto(BASE + "#/importar");
await page.getByRole("tab", { name: /Colar texto/ }).click();
await page.locator("#text").fill(lines.slice(0, 6).join("\n"));
await page.getByRole("button", { name: "Pré-visualizar" }).click();
await page.getByTestId("inferred").waitFor();
await page.getByRole("button", { name: /Confirmar e localizar/ }).click();
await page.getByText(/Lote:/).waitFor();
await page.getByRole("button", { name: "Revisar endereços" }).click();
await page.getByLabel("Importar coordenadas").setInputFiles(path.join(TD, "posicoes_teste_osm.csv"));
await page.getByText(/Coordenadas:/).waitFor();
await page.goto(BASE + "#/");
await waitHome(() => document.querySelector("[data-testid=map-home]")?.dataset.phase === "unplanned");
await page.getByRole("button", { name: "Calcular rota" }).click();
await waitHome(() => document.querySelector("[data-testid=map-home]")?.dataset.phase === "planned", 240000);
await page.getByRole("button", { name: /Iniciar navegação/ }).click();
await waitHome(() => document.querySelector("[data-testid=map-home]")?.dataset.phase === "navigating");
await page.waitForTimeout(1500);
await page.getByRole("button", { name: /Encerrar/ }).click();
await waitHome(() => document.querySelector("[data-testid=map-home]")?.dataset.phase === "ended");
await page.waitForTimeout(1200);
const f12 = await shot("12_apos_encerrar");
h = await home();
pass("P0 rota some do mapa ao ENCERRAR", h.route === "off" && h.nav === "off" && h.follow === "off", `fase=${h.phase} rota=${h.route} nav=${h.nav} câmera=${h.follow}`);
pass("P0 encerrado: sem 'Iniciar navegação', com 'Retomar rota'", (await page.getByRole("button", { name: /Iniciar navegação/ }).count()) === 0 && await page.getByRole("button", { name: "Retomar rota" }).isVisible(), "ok");
await page.getByRole("button", { name: "Retomar rota" }).click();
await waitHome(() => document.querySelector("[data-testid=map-home]")?.dataset.phase === "navigating");
h = await home();
pass("retomar após encerrar volta a desenhar a rota", h.route === "on", `fase=${h.phase}`);
await page.waitForTimeout(1000);
await shot("13_retomada");

// 9. recuperar após fechar/reabrir (diário da sessão)
await page.reload();
await waitHome(() => document.querySelector("[data-testid=map-home]")?.dataset.mapState === "operational");
await page.waitForTimeout(1500);
const f14 = await shot("14_reabrir_app");
h = await home();
pass("reabrir: estado coerente (rota planejada com 'Retomar')", h.phase === "planned" && (await page.getByTestId("resume").count()) === 1, `fase=${h.phase}`);

// 10. ajustes de localização
await page.goto(BASE + "#/ajustes");
await page.getByTestId("location-mode").waitFor();
await page.waitForTimeout(1500);
await shot("15_ajustes_localizacao");
const lm = await page.getByTestId("location-mode").innerText();
pass("ajustes: 3 origens distintas", /localização atual/i.test(lm) && /ponto de partida manual/i.test(lm) && /última posição/i.test(lm), lm.replace(/\n/g, " | ").slice(0, 200));

// 11. regressão visual (pixels) nas telas determinísticas
// regiões dinâmicas mascaradas: chip de GPS (idade do fix), recompensa temporária e tempo ativo
const masks = { gps: { x: 0, y: 60, w: 412, h: 170 }, time: { x: 300, y: 690, w: 100, h: 50 } };
const reg = {};
for (const n of ["01_home_sem_entregas", "03_importacao_texto_livre", "10_rota_concluida"]) reg[n] = diffAgainstBaseline(n, [masks.gps, masks.time]);
const worst = Object.entries(reg).sort((a, b) => b[1].ratio - a[1].ratio)[0];
pass("regressão visual (pixelmatch, <2% de pixels diferentes)", Object.values(reg).every((r) => r.ratio < 0.02), JSON.stringify(Object.fromEntries(Object.entries(reg).map(([k, v]) => [k, v.created ? "baseline criada" : (v.ratio * 100).toFixed(2) + "%"]))));
void worst; void f3; void f5; void f6; void f12; void f14;

// 12. acessibilidade
const ax = [];
for (const [n, hsh] of [["Mapa", "#/"], ["Entregas", "#/entregas"], ["Ajustes", "#/ajustes"], ["Importar", "#/importar"]]) {
  await page.goto(BASE + hsh); await page.waitForTimeout(1500);
  const r = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).exclude(".maplibregl-map").analyze();
  ax.push({ n, v: r.violations.map((v) => `${v.id}(${v.nodes.length})`) });
}
pass("axe sem violações (A/AA)", ax.every((a) => !a.v.length), JSON.stringify(ax));
const scoped = nomUrls.length > 0 && nomUrls.every((u) => /viewbox=/.test(u) && /city=Santos/i.test(decodeURIComponent(u)) && /state=SP/i.test(decodeURIComponent(u)));
pass("geocodificação: escopo Santos/SP (viewbox+cidade+UF) e sem consulta em massa", scoped && nominatim <= 20, `${nominatim} consultas interceptadas (nenhuma saiu para a rede); todas com viewbox de Santos, city=Santos, state=SP: ${scoped}`);
pass("sem erros de página", errors.length === 0, errors.slice(0, 3).join(" | ") || "nenhum");

fs.writeFileSync(path.join(OUT, "resultado_e2e_2_1.json"), JSON.stringify({ ambiente: "Chromium (NÃO Android)", data: new Date().toISOString(), results, screenshots: shotFiles }, null, 2));
await browser.close();
const bad = Object.entries(results).filter(([, r]) => !r.ok);
console.log(bad.length ? `FALHAS: ${bad.map(([k]) => k).join(", ")}` : "TODOS PASSARAM");
process.exit(bad.length ? 1 : 0);
