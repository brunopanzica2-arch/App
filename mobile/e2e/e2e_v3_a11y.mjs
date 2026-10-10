// E2E V3 — acessibilidade automatizada (axe-core, WCAG 2.0/2.1 A e AA) nas telas principais, modo claro e escuro.
// Cobre só o que o axe detecta automaticamente; NÃO substitui teste com leitor de tela no aparelho.
import fs from "node:fs";
import path from "node:path";
import AxeBuilder from "@axe-core/playwright";
import { chromium } from "playwright";

const BASE = process.env.E2E_BASE || "http://localhost:4173/";
const OUT = process.env.E2E_SHOTS || "../docs/EVIDENCIAS_V3";
const TD = path.resolve("../test-data");
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
const ctx = await browser.newContext({ viewport: { width: 412, height: 915 }, deviceScaleFactor: 2, locale: "pt-BR", serviceWorkers: "block" });
const page = await ctx.newPage();
page.setDefaultTimeout(240000);
page.on("dialog", (d) => d.accept());
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
await page.goto(BASE + "#/importar");
await page.locator("#file").setInputFiles(path.join(TD, "cenario_300_cartas_centro_paqueta_vila_nova.csv"));
await page.getByRole("button", { name: "Pré-visualizar" }).click();
await page.getByText("Mapeamento de colunas").waitFor();
const screens = [];
const scan = async (name) => {
  for (const theme of ["light", "dark"]) {
    await page.evaluate((t) => { document.documentElement.dataset.theme = t; document.documentElement.classList.toggle("dark", t === "dark"); }, theme);
    await page.waitForTimeout(400);
    const r = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).exclude(".maplibregl-map").analyze();
    screens.push({ tela: name, tema: theme, violacoes: r.violations.map((v) => ({ id: v.id, impacto: v.impact, descricao: v.help, ocorrencias: v.nodes.length, exemplo: v.nodes[0]?.html?.slice(0, 600) })) });
  }
};
await scan("Importar (prévia)");
await page.getByRole("button", { name: /Confirmar e localizar/ }).click();
await page.getByText(/Lote:/).waitFor();
await scan("Importar (resultado)");
await page.goto(BASE + "#/"); await page.waitForTimeout(600);
await page.getByText(/Endereços a conferir/).click();
await page.getByLabel("Importar coordenadas").setInputFiles(path.join(TD, "posicoes_teste_osm.csv"));
await page.getByText(/Coordenadas:/).waitFor();
await page.goto(BASE + "#/"); await page.waitForTimeout(600);
await scan("Painel");
await page.getByText(/Endereços a conferir/).click(); await page.waitForTimeout(800);
await scan("Revisão de endereços");
await page.goto(BASE + "#/"); await page.waitForTimeout(400);
await page.getByRole("button", { name: /Planejar rota/ }).click();
await page.waitForTimeout(500);
await scan("Planejar");
await page.fill("#tl", "4");
await page.getByRole("button", { name: /Calcular rota/ }).click();
await page.getByText("Soluções comparadas").waitFor({ timeout: 300000 });
await page.waitForTimeout(1500);
await scan("Planejar (resultado)");
await page.goto(BASE + "#/"); await page.waitForTimeout(400);
await page.getByRole("button", { name: /Abrir jornada/ }).click();
await page.getByText(/Próxima parada · 1 de/).waitFor();
await page.waitForTimeout(2500);
await scan("Jornada (rota)");
await page.getByRole("button", { name: "Lista de paradas" }).click();
await page.waitForTimeout(500);
await scan("Jornada (lista)");
await page.getByRole("button", { name: "Fechar lista" }).click();
await page.locator("section[aria-label='Parada selecionada'] button").first().click().catch(() => {});
await page.waitForTimeout(500);
await scan("Jornada (parada aberta)");
await page.goto(BASE + "#/relatorios"); await page.waitForTimeout(800);
await scan("Relatórios");
await page.goto(BASE + "#/ajustes"); await page.waitForTimeout(800);
await scan("Ajustes");
const total = screens.flatMap((s) => s.violacoes);
const graves = total.filter((v) => ["serious", "critical"].includes(v.impacto));
fs.writeFileSync(`${OUT}/a11y_axe_resultados.json`, JSON.stringify({ ferramenta: "axe-core via @axe-core/playwright, tags wcag2a/wcag2aa/wcag21a/wcag21aa; mapa excluído", telas: screens }, null, 1));
for (const s of screens) console.log(`${s.tela} [${s.tema}]: ${s.violacoes.length ? s.violacoes.map((v) => `${v.id}(${v.impacto}×${v.ocorrencias})`).join(", ") : "sem violações"}`);
console.log(`\nTotal: ${total.length} violações (${graves.length} sérias/críticas)`);
await browser.close();
process.exit(graves.length ? 1 : 0);
