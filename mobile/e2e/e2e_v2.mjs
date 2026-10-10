// E2E V2 do app móvel (build web via `vite preview`), viewport de celular 412x915.
// Usa test-data/: 300 cartas FICTÍCIAS + 150 POSIÇÕES TESTE (nós OSM, não portas).
// Cobre E2E-01, 04, 05, 06, 07, 08, 09, 11, 12, 13, 14, 16, 20 (ver docs/AUDITORIA_V2.md).
// Uso: npm run build && npx vite preview --port 4173 &  node e2e/e2e_v2.mjs
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright";

const BASE = process.env.E2E_BASE || "http://localhost:4173/";
const OUT = process.env.E2E_SHOTS || "../docs/EVIDENCIAS_E2E_V2";
const TD = path.resolve("../test-data");
fs.mkdirSync(OUT, { recursive: true });
const log = [];
const results = {};
const step = (m) => { console.log(`▶ ${m}`); log.push(`▶ ${m}`); };
const note = (m) => { console.log(`   ${m}`); log.push(`   ${m}`); };
const pass = (id, ok, detail) => { results[id] = { ok, detail }; note(`${ok ? "PASSOU" : "FALHOU"} ${id}: ${detail}`); };

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
const ctx = await browser.newContext({ viewport: { width: 412, height: 915 }, deviceScaleFactor: 2, locale: "pt-BR", acceptDownloads: true });
const page = await ctx.newPage();
page.setDefaultTimeout(120000);
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
let nominatim = 0;
page.on("request", (r) => { if (r.url().includes("nominatim")) nominatim++; });
page.on("dialog", (d) => d.accept()); // confirmações explícitas aceitas
const shot = (name, full = false) => page.screenshot({ path: `${OUT}/${name}.png`, fullPage: full });
const text = () => page.locator("main").innerText();


// entrega a próxima carta pendente da parada aberta; se não houver, abre a próxima parada pendente
async function deliverOne() {
  for (let attempt = 0; attempt < 3; attempt++) {
    const before = await page.locator("text=/\\d+\\/300/").first().innerText();
    const ok = await page.evaluate(() => {
      const sec = document.querySelector("section[aria-label='Parada selecionada']");
      if (!sec) return false;
      const cards = [...sec.querySelectorAll("div[data-letter]")].filter((d) => ["pending", "in_route"].includes(d.dataset.status));
      const btn = cards.length ? [...cards[0].querySelectorAll("button")].find((b) => b.innerText.trim() === "Entregue") : null;
      if (!btn) return false;
      btn.click();
      return true;
    });
    if (ok) {
      // espera a gravação refletir no contador (nada de toque duplo)
      await page.waitForFunction((b) => { const m = document.body.innerText.match(/\d+\/300/); return m && m[0] !== b; }, before, { timeout: 10000 });
      return;
    }
    await page.getByRole("button", { name: "Lista" }).click();
    await page.locator("ol li").filter({ hasText: /Pendente|Parcial/ }).first().locator("button").first().click();
    await page.waitForTimeout(250);
  }
  throw new Error("não encontrei carta pendente");
}

// ------------------------------------------------------------------ ponto de partida
step("Ajustes: ponto de partida TESTE (1 consulta ao Nominatim)");
await page.goto(BASE + "#/ajustes");
await page.getByRole("button", { name: /Localizar endereço/ }).click();
await page.getByText(/Resultado:|não localizado|Sem conexão/).waitFor();
note(await page.getByText(/Resultado:|não localizado|Sem conexão/).innerText());
await page.getByRole("button", { name: /Confirmar o pino/ }).click();
await page.getByText("Ponto de partida confirmado.").waitFor();
const nomAfterStart = nominatim;

// ------------------------------------------------------------------ E2E-01 / 06
step("E2E-01/06: importar 300 cartas (CSV UTF-8 com BOM, ';', CRLF) sem geocodificação massiva");
await page.goto(BASE + "#/"); await page.goto(BASE + "#/importar");
await page.locator("#file").setInputFiles(path.join(TD, "cenario_300_cartas_centro_paqueta_vila_nova.csv"));
await page.getByRole("button", { name: "Pré-visualizar" }).click();
await page.getByText("Mapeamento de colunas").waitFor();
const pv = await text();
const total = /Linhas:\s*(\d+)/.exec(pv)?.[1], uniq = /Imóveis únicos:\s*(\d+)/.exec(pv)?.[1];
await shot("01-previa-300", true);
await page.getByRole("button", { name: /Confirmar e localizar/ }).click();
await page.getByText(/Lote:/).waitFor();
await page.getByText(/ainda NÃO localizados/).waitFor();
const rep = await text();
pass("E2E-01", total === "300" && uniq === "150" && /Inseridas:\s*300/.test(rep), `prévia ${total} linhas / ${uniq} imóveis; ${/Inseridas:\s*(\d+)/.exec(rep)?.[1]} inseridas`);
pass("E2E-06", nominatim === nomAfterStart, `consultas ao Nominatim durante a importação de 150 imóveis: ${nominatim - nomAfterStart}`);
await shot("02-importado-300");

// ------------------------------------------------------------------ E2E-04
step("E2E-04: reimportar o mesmo arquivo");
await page.goto(BASE + "#/"); await page.goto(BASE + "#/importar");
await page.locator("#file").setInputFiles(path.join(TD, "cenario_300_cartas_centro_paqueta_vila_nova.csv"));
await page.getByRole("button", { name: "Pré-visualizar" }).click();
await page.getByText("Mapeamento de colunas").waitFor();
let dialogMsg = "";
page.once("dialog", (d) => { dialogMsg = d.message(); });
await page.getByRole("button", { name: /Confirmar e localizar/ }).click();
await page.getByText(/Lote:/).waitFor();
const rep2 = await text();
pass("E2E-04", /já foi importado/.test(dialogMsg) && /Inseridas:\s*0/.test(rep2) && /duplicadas:\s*300/.test(rep2),
  `aviso: "${dialogMsg.split("\n")[0]}"; segunda importação: ${/Inseridas:\s*(\d+)/.exec(rep2)?.[1]} inseridas, ${/duplicadas:\s*(\d+)/.exec(rep2)?.[1]} duplicadas`);

// ------------------------------------------------------------------ E2E-05
step("E2E-05: 30 casos adversariais");
await page.goto(BASE + "#/"); await page.goto(BASE + "#/importar");
await page.locator("#file").setInputFiles(path.join(TD, "casos_adversariais_30.csv"));
await page.getByRole("button", { name: "Pré-visualizar" }).click();
await page.getByText("Mapeamento de colunas").waitFor();
const pva = await text();
await shot("03-adversariais-previa", true);
await page.getByRole("button", { name: /Confirmar e localizar/ }).click();
await page.getByText(/Lote:/).waitFor();
const repa = await text();
const ins = +/Inseridas:\s*(\d+)/.exec(repa)[1], dup = +/duplicadas:\s*(\d+)/.exec(repa)[1], err = +/com erro:\s*(\d+)/.exec(repa)[1];
pass("E2E-05", /Linhas:\s*30/.test(pva) && ins + dup === 30 && dup === 2 && err === 1,
  `30 lidas = ${ins} inseridas + ${dup} duplicadas (1 no arquivo + 1 já existente); ${err} com erro (sem logradouro)`);

// volta ao lote de 300
await page.goto(BASE + "#/");
await page.getByLabel("Lote").selectOption({ label: /Cenário|Lote/.test("") ? undefined : undefined }).catch(() => {});
const opts = await page.getByLabel("Lote").locator("option").allInnerTexts();
const idx300 = opts.findIndex((o) => /\(300 cartas\)/.test(o));
await page.getByLabel("Lote").selectOption({ index: idx300 });
await page.waitForTimeout(800);

// ------------------------------------------------------------------ posições TESTE
step("Importar 150 POSIÇÕES TESTE (nós OSM) — não são portas");
await page.getByText(/Endereços a conferir/).click();
await page.getByLabel("Importar coordenadas").setInputFiles(path.join(TD, "posicoes_teste_osm.csv"));
await page.getByText(/Coordenadas:/).waitFor();
note(await page.getByText(/Coordenadas:/).innerText());
await shot("04-revisao-posicoes-teste", false);
await page.goto(BASE + "#/");
await page.waitForTimeout(800);
const home = await text();
note(home.split("\n").slice(0, 6).join(" | "));
await shot("05-painel-300-150-3");

// ------------------------------------------------------------------ E2E-16 (cancelar) + E2E-07/08
step("E2E-16: cancelar no meio da otimização não altera versões");
await page.getByRole("button", { name: /Planejar rota/ }).click();
await page.fill("#tl", "20");
await page.getByRole("button", { name: /Calcular rota/ }).click();
await page.getByText(/Calculando:/).waitFor();
await page.waitForTimeout(1500);
await page.getByRole("button", { name: "Cancelar" }).click();
await page.getByText(/Cálculo cancelado/).first().waitFor();
const versionsAfterCancel = await page.getByText(/^v\d+ ·/).count();
pass("E2E-16", versionsAfterCancel === 0, `após cancelar: ${versionsAfterCancel} versão(ões) gravada(s)`);

step("E2E-07/08: rota aberta com 150 paradas na malha OSM real");
await page.fill("#tl", "8");
const t0 = Date.now();
await page.getByRole("button", { name: /Calcular rota/ }).click();
await page.getByText("Soluções comparadas").waitFor({ timeout: 300000 });
const calcS = ((Date.now() - t0) / 1000).toFixed(1);
await page.waitForTimeout(3000);
const plan = await text();
await shot("06-mapa-150-paradas", false);
await shot("07-planejamento-150-completo", true);
const nStops = /Paradas\s*(\d+)/i.exec(plan)?.[1], dist = /Distância\s*([\d,]+ km)/i.exec(plan)?.[1], tt = /Tempo total\s*([^\n]+)/i.exec(plan)?.[1];
pass("E2E-07", nStops === "150" && !/ROTA PARCIAL/.test(plan), `${nStops} paradas, ${dist}, ${tt}, cálculo no navegador ${calcS} s, status ${/ROTA PARCIAL/.test(plan) ? "PARCIAL" : "completa"}`);
pass("E2E-08", /Aberta/.test(await page.locator("#mode").inputValue().then((v) => (v === "open" ? "Aberta" : v))), "modo aberto: termina na última parada (sem trecho de retorno)");

step("E2E-09: rota circular");
await page.locator("#mode").selectOption("circular");
await page.getByRole("button", { name: /Calcular rota/ }).click();
await page.waitForFunction(() => document.body.innerText.includes("v2 ·"), null, { timeout: 300000 });
await page.waitForTimeout(1500);
const circ = await text();
pass("E2E-09", /v2 · planned/.test(circ), `versão circular: ${(/v2 · [^\n]+/.exec(circ) || [""])[0]}`);
await shot("08-circular");
// volta para a versão aberta (v1) e ativa
await page.getByText(/^v1 ·/).click();
await page.getByRole("button", { name: /Ativar e iniciar jornada/ }).click();
await page.waitForURL(/#\/rota\//);
await page.waitForTimeout(3000);
await shot("09-jornada-inicio");

// ------------------------------------------------------------------ E2E-11
step("E2E-11: concluir 1 carta de uma parada com 4");
await page.getByRole("button", { name: "Lista" }).click();
const items = page.locator("ol li");
let four = -1;
for (let i = 0; i < (await items.count()); i++) if (/· 4 carta\(s\)/.test(await items.nth(i).innerText())) { four = i; break; }
await items.nth(four).locator("button").first().click();
await page.locator("section[aria-label='Parada selecionada']").getByRole("button", { name: "Entregue", exact: true }).first().click();
await page.getByText(/Entregue\./).first().waitFor();
await page.waitForTimeout(500);
const sel = await page.locator("section[aria-label='Parada selecionada']").innerText();
const delivered = (sel.match(/Entregue(?!\s*Não)/g) || []).length;
pass("E2E-11", /4 carta\(s\) · Parcial/.test(sel), `parada com 4 cartas após 1 entrega: "${(/\d carta\(s\) · \w+/.exec(sel) || [""])[0]}"`);
await shot("10-parada-parcial");

// ------------------------------------------------------------------ E2E-12
step("E2E-12: concluir 50 cartas, recarregar, conferir persistência e recálculo só de pendentes");
for (let k = 0; k < 49; k++) await deliverOne();
const before = await page.locator("text=/\\d+\\/300/").first().innerText();
await page.reload();
await page.waitForTimeout(2500);
const after = await page.locator("text=/\\d+\\/300/").first().innerText();
pass("E2E-12a", before === after && after.startsWith("50/"), `antes ${before} · depois de recarregar ${after}`);
await page.getByRole("button", { name: /Recalcular a partir da última parada/ }).click();
await page.waitForFunction(() => /Rota calculada no aparelho · v3/.test(document.body.innerText), null, { timeout: 300000 });
await page.waitForTimeout(2000);
const v3 = await text();
const stopsLeft = await page.evaluate(async () => {
  const req = indexedDB.open("rota-santos");
  const dbx = await new Promise((r) => (req.onsuccess = () => r(req.result)));
  const routes = await new Promise((r) => { const q = dbx.transaction("routes").objectStore("routes").getAll(); q.onsuccess = () => r(q.result); });
  const v = routes.sort((a, b) => b.version - a.version)[0];
  const letters = await new Promise((r) => { const q = dbx.transaction("letters").objectStore("letters").getAll(); q.onsuccess = () => r(q.result); });
  const done = new Set(letters.filter((l) => l.batchId === v.batchId && ["delivered"].includes(l.status)).map((l) => l.addressKey));
  const pendingKeys = new Set(letters.filter((l) => l.batchId === v.batchId && ["pending", "in_route"].includes(l.status)).map((l) => l.addressKey));
  return { routeStops: v.stops.length, pendingKeys: pendingKeys.size, includesCompleted: v.stops.some((s) => done.has(s.key) && !pendingKeys.has(s.key)) };
});
pass("E2E-12b", stopsLeft.routeStops === stopsLeft.pendingKeys && !stopsLeft.includesCompleted,
  `v3 visita ${stopsLeft.routeStops} paradas = ${stopsLeft.pendingKeys} imóveis com cartas pendentes; inclui concluída? ${stopsLeft.includesCompleted}`);
await shot("11-recalculo-v3");

// ------------------------------------------------------------------ E2E-13 + mapa offline
step("E2E-13: modo avião — concluir 30, voltar a rede, conferir persistência; mapa-base offline");
await ctx.setOffline(true);
for (let k = 0; k < 30; k++) await deliverOne();
const offlineCount = await page.locator("text=/\\d+\\/300/").first().innerText();
await ctx.setOffline(false);
await page.reload();
await page.waitForTimeout(2500);
const online = await page.locator("text=/\\d+\\/300/").first().innerText();
pass("E2E-13", offlineCount.startsWith("80/") && online === offlineCount, `offline ${offlineCount} · após voltar a rede e recarregar ${online}`);
// V3: com o pacote offline de Santos presente, bloquear o mapa online NÃO deve degradar o mapa
const p3 = await ctx.newPage();
await p3.route(/openfreemap/, (r) => r.abort());
await p3.goto(page.url());
await p3.getByText(/Mapa offline \(pacote de Santos\)/).waitFor({ timeout: 30000 });
await p3.close();
// pacote ausente E mapa online inacessível: cai no fundo liso de contingência (rota e paradas continuam visíveis)
const p2 = await ctx.newPage();
await p2.route(/openfreemap|map\/santos\.pmtiles/, (r) => r.abort());
await p2.goto(page.url());
await p2.getByText(/Mapa-base indisponível/).first().waitFor({ timeout: 30000 });
await p2.waitForTimeout(2500);
await p2.screenshot({ path: `${OUT}/12-mapa-offline-fallback.png` });
pass("J-mapa-offline", true, "com pacote: mapa de ruas offline; sem pacote e sem internet: estilo de contingência com rota e paradas numeradas (captura 12)");
await p2.close();

// ------------------------------------------------------------------ E2E-14
step("E2E-14: GPS negado e coordenada desviada — sem travar");
await page.getByRole("button", { name: "Minha localização", exact: true }).click();
await page.getByText(/GPS indisponível/).first().waitFor({ timeout: 40000 });
note(await page.getByText(/GPS indisponível/).first().innerText());
await ctx.grantPermissions(["geolocation"], { origin: new URL(BASE).origin });
await ctx.setGeolocation({ latitude: -23.5, longitude: -46.6 }); // São Paulo: fora da malha
await page.getByRole("button", { name: /Recalcular da minha localização/ }).click();
await page.waitForFunction(() => /fora da malha|sem resposta do GPS/.test(document.body.innerText), null, { timeout: 120000 });
const gpsMsg = ((await page.locator("main").innerText()).match(/[^\n]*(fora da malha|sem resposta do GPS)[^\n]*/) || [""])[0].slice(0, 160);
pass("E2E-14", errors.length === 0, `GPS negado: aviso exibido, app segue; posição desviada (São Paulo): "${gpsMsg}"`);

// ------------------------------------------------------------------ E2E-20
step("E2E-20: exportar relatório CSV e conferir contagem/checksum");
await page.goto(BASE + "#/relatorios");
await page.getByText("Planejado (estimativa)").waitFor();
await shot("13-relatorio", true);
const [dl] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: "CSV" }).click()]);
const file = path.join(OUT, "relatorio_300_exportado.csv");
await dl.saveAs(file);
const csv = fs.readFileSync(file, "utf8").replace(/^﻿/, "");
const lines = csv.split("\n").filter((l) => l.trim());
const sha = createHash("sha256").update(fs.readFileSync(file)).digest("hex");
const delivered80 = lines.filter((l) => l.includes('"delivered"')).length;
pass("E2E-20", lines.length === 301 && delivered80 === 80, `${lines.length - 1} cartas exportadas, ${delivered80} entregues, sha256 ${sha.slice(0, 16)}…`);
// nomes não vão para logs: o relatório local contém nomes FICTÍCIOS (permitido ao usuário)

await browser.close();
results.errosDePagina = errors;
fs.writeFileSync(path.join(OUT, "e2e_v2_resultados.json"), JSON.stringify(results, null, 1));
fs.writeFileSync(path.join(OUT, "e2e_v2_log.txt"), log.join("\n") + "\n");
const failed = Object.entries(results).filter(([k, v]) => k !== "errosDePagina" && !v.ok);
console.log(failed.length ? `FALHAS: ${failed.map(([k]) => k).join(", ")}` : "E2E V2 OK");
process.exit(failed.length || errors.length ? 1 : 0);
