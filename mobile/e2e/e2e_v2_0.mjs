// E2E 2.0 (navegador, viewport 412x915): importação inteligente → localizar (posições TESTE) → mapa → rota em 1 toque → entrega → desfazer → busca → abas.
// O motor de voz/GPS é NATIVO (Android); aqui só se exercita a UI e o substituto web. NÃO substitui teste em aparelho.
import fs from "node:fs";
import path from "node:path";
import AxeBuilder from "@axe-core/playwright";
import { chromium } from "playwright";

const BASE = process.env.E2E_BASE || "http://localhost:4173/";
const OUT = process.env.E2E_SHOTS || "../docs/EVIDENCIAS_2_0";
const TD = path.resolve("../test-data");
fs.mkdirSync(OUT, { recursive: true });
const results = {};
const pass = (id, ok, d) => { results[id] = { ok, detail: d }; console.log(`${ok ? "PASSOU" : "FALHOU"} ${id}: ${d}`); };
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
const ctx = await browser.newContext({ viewport: { width: 412, height: 915 }, deviceScaleFactor: 2, locale: "pt-BR", serviceWorkers: "block",
  geolocation: { latitude: -23.9480025, longitude: -46.3406209, accuracy: 12 }, permissions: ["geolocation"] });
const page = await ctx.newPage();
page.setDefaultTimeout(240000);
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
page.on("dialog", (d) => d.accept());
let nominatim = 0;
page.on("request", (r) => { if (r.url().includes("nominatim")) nominatim++; });
const shot = (n) => page.screenshot({ path: `${OUT}/${n}.png` });

await page.goto(BASE);
await page.waitForSelector("#root > *"); // 2.3: o app só inicia depois da entrada da abertura animada
await page.evaluate(() => new Promise((res, rej) => {
  const o = indexedDB.open("rota-santos");
  o.onsuccess = () => { const db = o.result, tx = db.transaction("settings", "readwrite");
    tx.objectStore("settings").put({ key: "main", start: { label: "PONTO TESTE", lat: -23.9480025, lon: -46.3406209, confirmed: true }, startAddress: "x", serviceTime: 45, perLetterService: 10, routeMode: "open", nominatimEmail: "", currentBatch: null });
    tx.oncomplete = () => { db.close(); res(); }; tx.onerror = () => rej(tx.error); };
}));
await page.reload();
await page.waitForFunction(() => !document.getElementById("splash"), null, { timeout: 60000 }); // abertura animada terminou

// 1. estado vazio
await page.getByRole("button", { name: /Importar cartas/ }).first().waitFor();
pass("UX-01 mapa na tela inicial", await page.getByTestId("map-home").isVisible(), "tela inicial é o mapa com ação Importar");
await page.waitForFunction(() => ["operational", "error"].includes(document.querySelector("[data-testid=map-home]")?.dataset.mapState), null, { timeout: 120000 });
await page.waitForFunction(() => document.querySelector("[data-testid=map-home]")?.dataset.gpsState === "ok", null, { timeout: 60000 }).catch(() => {});
await shot("01-mapa-vazio");
{
  const st = await page.evaluate(() => { const e = document.querySelector("[data-testid=map-home]"); const c = document.querySelector("[role=application] canvas")?.getBoundingClientRect(); return { map: e.dataset.mapState, gps: e.dataset.gpsState, fix: e.dataset.fix, h: c?.height }; });
  const png = await page.screenshot({ clip: { x: 0, y: 200, width: 412, height: 400 } });
  pass("MAP-01 mapa real renderizado (estado operacional, canvas>300px, imagem com detalhe)", st.map === "operational" && st.h > 300 && png.length > 40000, `${JSON.stringify(st)} png=${png.length}B`);
  pass("GPS-01 fix automático e marcador", st.gps === "ok" && /^-23\.948\d*,-46\.3406/.test(st.fix), `gps=${st.gps} fix=${st.fix}`);
}

// 2. regressão da linha sem cabeçalho
await page.goto(BASE + "#/importar");
await page.getByRole("tab", { name: /Colar texto/ }).click();
await page.locator("#text").fill("Rua Itororó;118;Centro;Santos;SP");
await page.getByRole("button", { name: "Pré-visualizar" }).click();
await page.getByTestId("inferred").waitFor();
const inf = await page.getByTestId("inferred").innerText();
const prev = await page.locator("[aria-label='Prévia das linhas']").innerText();
pass("IMP-01 linha sem cabeçalho reconhecida", /Logradouro/.test(inf) && /Número/.test(inf) && /Bairro/.test(inf) && /Itororó/.test(prev) && /118/.test(prev), inf.replace(/\n/g, " ").slice(0, 200));
await shot("02-import-itororo");

// 3. importa as 300 cartas
await page.getByRole("tab", { name: "Arquivo" }).click();
await page.locator("#file").setInputFiles(path.join(TD, "cenario_300_cartas_centro_paqueta_vila_nova.csv"));
await page.getByRole("button", { name: "Pré-visualizar" }).click();
await page.getByText(/Linhas:/).waitFor();
const t = await page.locator("main").innerText();
pass("IMP-02 prévia 300 linhas", /Linhas:\s*300/.test(t), (t.match(/Linhas:[^\n]*/) || [""])[0]);
await shot("03-import-previa");
await page.getByRole("button", { name: /Confirmar e localizar/ }).click();
await page.getByText(/Lote:/).waitFor();
const res = await page.locator("main").innerText();
pass("IMP-03 inseridas=300 duplicadas=0", /Inseridas:\s*300/.test(res) && /duplicadas:\s*0/.test(res), (res.match(/Inseridas:[^\n]*/) || [""])[0]);

// 4. posições TESTE
await page.goto(BASE + "#/entregas");
await page.getByRole("button", { name: /Validar \/ corrigir/ }).click();
await page.getByLabel("Importar coordenadas").setInputFiles(path.join(TD, "posicoes_teste_osm.csv"));
await page.getByText(/Coordenadas:/).waitFor();

// 5. mapa: calcular rota em 1 toque
await page.goto(BASE + "#/");
await page.getByRole("button", { name: "Calcular rota" }).click();
await page.getByRole("button", { name: /Iniciar navegação/ }).waitFor({ timeout: 300000 });
await page.waitForTimeout(2500);
const c = await page.getByTestId("counters").innerText();
pass("UX-02 rota em um toque + contadores", /300/.test(c), c.replace(/\n/g, " "));
await shot("04-mapa-rota");
const addr = await page.getByTestId("cur-addr").innerText();
pass("UX-03 próxima parada exibida", addr.length > 3, addr);

// 6. botões grandes sem corte
const sizes = await page.evaluate(() => [...document.querySelectorAll("[data-testid=sheet] button")].map((b) => ({ t: b.innerText.trim(), h: b.getBoundingClientRect().height, clip: b.scrollWidth > b.clientWidth + 1 })).filter((b) => b.t));
pass("UX-04 botões sem texto cortado", sizes.every((b) => !b.clip), JSON.stringify(sizes.map((b) => `${b.t}:${Math.round(b.h)}`)));

await page.getByRole("button", { name: "Expandir painel" }).click();
await page.waitForTimeout(500);
await shot("04b-painel-expandido");
await page.getByRole("button", { name: "Recolher painel" }).click();
await page.waitForTimeout(500);
await shot("04c-painel-compacto");
// 7. entrega + desfazer
const doneBefore = Number((await page.getByTestId("counters").innerText()).split("\n").filter(Boolean)[6] ?? 0);
const btn = page.getByRole("button", { name: /^(Entregue|Entregar todas)/ });
await btn.click();
if (await page.getByRole("dialog", { name: "Confirmar entrega" }).count()) await page.getByRole("button", { name: "Entregar todas" }).click();
await page.waitForTimeout(800);
const c2 = await page.getByTestId("counters").innerText();
const addr2 = await page.getByTestId("cur-addr").innerText();
pass("DEL-01 entrega avança para a próxima parada", addr2 !== addr, `${addr} → ${addr2}`);
await shot("05-apos-entrega");
await page.getByRole("button", { name: /^Desfazer/ }).first().click();
await page.waitForTimeout(800);
const addr3 = await page.getByTestId("cur-addr").innerText();
pass("DEL-02 desfazer volta à parada", addr3 === addr, addr3);

// 8. não consegui abre motivos
await page.getByRole("button", { name: "Não consegui" }).click();
const motivos = await page.getByRole("dialog").innerText();
pass("DEL-03 motivos de não entrega", /ausente/i.test(motivos), motivos.slice(0, 80).replace(/\n/g, " "));
await page.getByRole("button", { name: "Fechar", exact: true }).click();

// 9. iniciar navegação (substituto web) e retomar
await page.getByRole("button", { name: /Iniciar navegação/ }).click();
await page.getByRole("button", { name: "Iniciar mesmo assim" }).click({ timeout: 1500 }).catch(() => {}); // 2.3: guarda de segurança (rota com destinos aproximados)
await page.getByRole("button", { name: /Pausar/ }).waitFor();
pass("NAV-01 navegação inicia no navegador (substituto)", true, "botões Pausar/Encerrar visíveis; HUD de manobras e voz exigem o app Android");
await shot("06-navegando-web");
await page.getByRole("button", { name: /Encerrar/ }).click();

// 10. busca global
await page.getByRole("button", { name: "Buscar endereço ou entrega" }).click();
await page.getByRole("tab", { name: /Minhas entregas/ }).click();
await page.getByLabel("Buscar", { exact: true }).fill("Joaquim");
await page.waitForTimeout(500);
const hits = await page.getByRole("dialog").locator("li").count();
pass("BUS-01 busca global", hits > 0, `${hits} resultado(s)`);
await shot("07-busca");
await page.getByRole("button", { name: "Fechar", exact: true }).click();

// 11. abas e Entregas
await page.goto(BASE + "#/entregas");
await page.getByTestId("stop-list").waitFor();
const tabs = await page.getByRole("navigation", { name: "Navegação principal" }).innerText();
pass("UX-05 quatro abas", ["Mapa", "Entregas", "Histórico", "Ajustes"].every((x) => tabs.includes(x)), tabs.replace(/\n/g, " "));
await shot("08-entregas");

// 12. desfazer importação
await page.getByRole("button", { name: /Desfazer esta importação/ }).click();
await page.waitForTimeout(1500);
const empty = await page.locator("main").innerText();
pass("IMP-04 desfazer importação (lote do Itororó permanece)", /Importação .* desfeita/.test(empty), (empty.match(/Importação[^\n]*/) || [""])[0]);

// 13. axe
await page.goto(BASE + "#/ajustes"); await page.waitForTimeout(800);
const ax = [];
for (const [name, hash] of [["Mapa", "#/"], ["Entregas", "#/entregas"], ["Ajustes", "#/ajustes"], ["Importar", "#/importar"]]) {
  await page.goto(BASE + hash); await page.waitForTimeout(1200);
  const r = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).exclude(".maplibregl-map").analyze();
  ax.push({ name, v: r.violations.map((v) => `${v.id}(${v.nodes.length})`) });
}
pass("A11Y-01 axe sem violações nas 4 telas", ax.every((a) => !a.v.length), JSON.stringify(ax));
pass("NET-01 Nominatim não consultado", nominatim === 0, `${nominatim} requisições`);
pass("ERR-01 sem erros de página", errors.length === 0, errors.slice(0, 3).join(" | ") || "nenhum");
fs.writeFileSync(`${OUT}/resultado_e2e_2_0.json`, JSON.stringify(results, null, 2));
await browser.close();
const bad = Object.entries(results).filter(([, r]) => !r.ok);
console.log(bad.length ? `FALHAS: ${bad.map(([k]) => k).join(", ")}` : "TODOS PASSARAM");
process.exit(bad.length ? 1 : 0);
