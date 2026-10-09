// E2E do fluxo vertical pela interface real (Playwright + Chromium).
// Pré-requisitos: API em :8000 e web em :3000; usuário admin criado.
// Dados: endereços PÚBLICOS reais de Santos + destinatários SINTÉTICOS.
// Uso: E2E_EMAIL=... E2E_PASSWORD=... node e2e/flow.mjs
import { chromium } from "playwright";
import fs from "node:fs";

const BASE = process.env.E2E_BASE || "http://localhost:3000";
const OUT = process.env.E2E_SHOTS || "../docs/screenshots";
fs.mkdirSync(OUT, { recursive: true });

const RUN = Date.now().toString(36);
const LETTERS = [
  "identificador;destinatario;logradouro;numero;complemento;bairro",
  `E2E-${RUN}-001;Destinatário Sintético 1;Avenida Ana Costa;300;;Gonzaga`,
  `E2E-${RUN}-002;Destinatário Sintético 2;Avenida Ana Costa;300;apto 21;Gonzaga`,
  `E2E-${RUN}-003;Destinatário Sintético 3;Avenida Conselheiro Nébias;500;;Boqueirão`,
  `E2E-${RUN}-004;Destinatário Sintético 4;Rua Oswaldo Cruz;100;;Boqueirão`,
  `E2E-${RUN}-005;Destinatário Sintético 5;Rua Joaquim Távora;300;;Marapé`,
  `E2E-${RUN}-006;Destinatário Sintético 6;Avenida Bernardino de Campos;200;;Campo Grande`,
  `E2E-${RUN}-007;Destinatário Sintético 7;Rua Azevedo Sodré;50;;Gonzaga`,
  `E2E-${RUN}-008;Destinatário Sintético 8;Rua Inexistente da Silva Xyz;10;;Centro`,
].join("\n");

const step = (m) => console.log(`\n▶ ${m}`);
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
const ctx = await browser.newContext({ viewport: { width: 412, height: 915 }, deviceScaleFactor: 2, locale: "pt-BR" });
const page = await ctx.newPage();
page.setDefaultTimeout(180000);
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));

step("login");
await page.goto(`${BASE}/login`);
await page.fill("#email", process.env.E2E_EMAIL);
await page.fill("#password", process.env.E2E_PASSWORD);
await page.click("button[type=submit]");
await page.waitForURL(`${BASE}/`);
await page.screenshot({ path: `${OUT}/01-painel-vazio.png` });

step("confirmar ponto de partida (geocodificação real + pino)");
await page.goto(`${BASE}/configuracoes`);
await page.getByRole("button", { name: /Geocodificar endereço padrão/ }).click();
await page.getByText(/Resultado:|não localizado/).waitFor();
const geoMsg = await page.getByRole("status").first().innerText().catch(() => "");
console.log("  geocodificação do início:", geoMsg);
await page.waitForTimeout(2500);
await page.screenshot({ path: `${OUT}/02-ponto-partida.png` });
await page.getByRole("button", { name: /Confirmar posição do pino/ }).click();
await page.getByText("Ponto de partida confirmado.").waitFor();

step("importar (texto colado) + prévia + confirmação");
await page.goto(`${BASE}/importar`);
await page.getByRole("tab", { name: /Colar texto/ }).click();
await page.fill("#text", LETTERS);
await page.getByRole("button", { name: "Pré-visualizar" }).click();
await page.getByText("Mapeamento de colunas").waitFor();
await page.screenshot({ path: `${OUT}/03-previa-importacao.png`, fullPage: true });
await page.getByRole("button", { name: /Confirmar importação/ }).click();
await page.getByText(/Geocodificação concluída/).waitFor({ timeout: 300000 });
console.log("  ", await page.getByText(/Geocodificação concluída/).innerText());
await page.screenshot({ path: `${OUT}/04-importado.png` });

step("revisão de endereços");
await page.getByRole("button", { name: "Revisar endereços" }).click();
await page.waitForURL(/enderecos/);
await page.waitForTimeout(2500);
await page.screenshot({ path: `${OUT}/05-revisao-enderecos.png`, fullPage: true });

step("planejar rota (matriz de pedestres real + OR-Tools)");
await page.goto(page.url().replace("enderecos", "planejar"));
await page.fill("#tl", "5");
await page.getByRole("button", { name: /Calcular rota/ }).click();
await page.getByText("Comparação de soluções candidatas").waitFor({ timeout: 300000 });
await page.waitForTimeout(3000);
await page.screenshot({ path: `${OUT}/06-planejamento.png`, fullPage: true });

step("ativar e operar a jornada");
await page.getByRole("button", { name: /Ativar e iniciar jornada/ }).click();
await page.waitForURL(/\/rota\//);
await page.waitForTimeout(3000);
await page.screenshot({ path: `${OUT}/07-jornada.png` });
await page.getByRole("button", { name: "Entregue" }).first().click();
await page.getByText(/Entregue registrada/).waitFor();
await page.waitForTimeout(1500);
await page.screenshot({ path: `${OUT}/08-entrega-registrada.png` });

step("offline: registrar sem rede e sincronizar depois");
await ctx.setOffline(true);
await page.getByRole("button", { name: "Adiar" }).first().click();
await page.getByText(/offline — será enviada depois/).waitFor();
await page.getByText(/pendente\(s\) de envio/).waitFor();
await page.screenshot({ path: `${OUT}/09-offline.png` });
await ctx.setOffline(false);
await page.evaluate(() => window.dispatchEvent(new Event("online")));
await page.getByText(/pendente\(s\) de envio/).waitFor({ state: "detached", timeout: 60000 }).catch(async (e) => {
  console.log("  badge:", await page.getByLabel("Estado da sincronização").innerText());
  throw e;
});

step("recalcular a partir da última parada");
await page.getByRole("button", { name: /Recalcular a partir da última parada/ }).click();
await page.waitForURL((u) => /\/rota\//.test(u.toString()) && !u.toString().endsWith(page.url().split("/").pop()), { timeout: 300000 }).catch(() => {});
await page.getByText(/Jornada · v2/).waitFor({ timeout: 300000 });
await page.waitForTimeout(2500);
await page.screenshot({ path: `${OUT}/10-recalculo-v2.png` });

step("relatório");
await page.goto(`${BASE}/relatorios`);
await page.getByText("Planejado (estimativa)").waitFor();
await page.screenshot({ path: `${OUT}/11-relatorio.png`, fullPage: true });

await page.emulateMedia({ colorScheme: "dark" });
await page.evaluate(() => { localStorage.setItem("rota.theme", "dark"); document.documentElement.classList.add("dark"); });
await page.goto(`${BASE}/`);
await page.waitForTimeout(1500);
await page.screenshot({ path: `${OUT}/12-painel-escuro.png` });

await browser.close();
if (errors.length) {
  console.error("Erros de página:", errors);
  process.exit(1);
}
console.log("\nE2E OK");
