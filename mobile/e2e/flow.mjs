// E2E do app móvel (build web servida por `vite preview`), viewport de celular.
// Endereços PÚBLICOS reais de Santos + destinatários SINTÉTICOS; Nominatim real.
// Uso: npm run build && npx vite preview --port 4173 & node e2e/flow.mjs
import { chromium } from "playwright";
import fs from "node:fs";

const BASE = process.env.E2E_BASE || "http://localhost:4173/";
const OUT = process.env.E2E_SHOTS || "../docs/screenshots/mobile";
fs.mkdirSync(OUT, { recursive: true });
const RUN = Date.now().toString(36);
const LETTERS = [
  "identificador;destinatario;logradouro;numero;complemento;bairro",
  `M-${RUN}-1;Destinatário Sintético 1;Avenida Ana Costa;300;;Gonzaga`,
  `M-${RUN}-2;Destinatário Sintético 2;Avenida Ana Costa;300;apto 21;Gonzaga`,
  `M-${RUN}-3;Destinatário Sintético 3;Avenida Conselheiro Nébias;500;;Boqueirão`,
  `M-${RUN}-4;Destinatário Sintético 4;Rua Oswaldo Cruz;100;;Boqueirão`,
  `M-${RUN}-5;Destinatário Sintético 5;Rua Joaquim Távora;300;;Marapé`,
  `M-${RUN}-6;Destinatário Sintético 6;Avenida Bernardino de Campos;200;;Campo Grande`,
  `M-${RUN}-7;Destinatário Sintético 7;Rua Azevedo Sodré;50;;Gonzaga`,
  `M-${RUN}-8;Destinatário Sintético 8;Rua Inexistente da Silva Xyz;10;;Centro`,
].join("\n");

const step = (m) => console.log(`▶ ${m}`);
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
const ctx = await browser.newContext({ viewport: { width: 412, height: 915 }, deviceScaleFactor: 2, locale: "pt-BR" });
const page = await ctx.newPage();
page.setDefaultTimeout(180000);
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
page.on("console", (m) => m.type() === "error" && errors.push(m.text()));

step("ajustes: localizar e confirmar ponto de partida");
await page.goto(BASE + "#/ajustes");
await page.getByRole("button", { name: /Localizar endereço/ }).click();
await page.getByText(/Resultado:|não localizado/).waitFor();
console.log("  ", await page.getByText(/Resultado:|não localizado/).innerText());
await page.waitForTimeout(2500);
await page.screenshot({ path: `${OUT}/01-ajustes.png` });
await page.getByRole("button", { name: /Confirmar o pino/ }).click();
await page.getByText("Ponto de partida confirmado.").waitFor();

step("importar texto colado");
await page.goto(BASE + "#/importar");
await page.getByRole("tab", { name: /Colar texto/ }).click();
await page.fill("#text", LETTERS);
await page.getByRole("button", { name: "Pré-visualizar" }).click();
await page.getByText("Mapeamento de colunas").waitFor();
await page.screenshot({ path: `${OUT}/02-previa.png`, fullPage: true });
await page.getByRole("button", { name: /Confirmar e localizar/ }).click();
await page.getByText(/imóveis consultados/).waitFor({ timeout: 300000 });
console.log("  ", await page.getByText(/imóveis consultados/).innerText());

step("revisar endereços");
await page.getByRole("button", { name: "Revisar endereços" }).click();
await page.waitForTimeout(2500);
await page.screenshot({ path: `${OUT}/03-enderecos.png`, fullPage: true });

step("planejar (matriz + otimização no aparelho)");
await page.goto(page.url().replace("enderecos", "planejar"));
await page.fill("#tl", "4");
await page.getByRole("button", { name: /Calcular rota/ }).click();
await page.getByText("Soluções comparadas").waitFor({ timeout: 300000 });
await page.waitForTimeout(3000);
await page.screenshot({ path: `${OUT}/04-planejamento.png`, fullPage: true });

step("jornada: entregar e recalcular");
await page.getByRole("button", { name: /Ativar e iniciar jornada/ }).click();
await page.waitForURL(/#\/rota\//);
await page.waitForTimeout(3000);
await page.screenshot({ path: `${OUT}/05-jornada.png` });
await page.getByRole("button", { name: "Entregue" }).first().click();
await page.getByText("Entregue registrada.").waitFor();
await page.getByRole("button", { name: /Recalcular a partir da última parada/ }).click();
await page.getByText(/Versão 2/).waitFor({ timeout: 300000 });
await page.waitForTimeout(2500);
await page.screenshot({ path: `${OUT}/06-recalculo.png` });

step("relatório");
await page.goto(BASE + "#/relatorios");
await page.getByText("Planejado (estimativa)").waitFor();
await page.screenshot({ path: `${OUT}/07-relatorio.png`, fullPage: true });

await browser.close();
const real = errors.filter((e) => !/Expected value to be of type number/.test(e));
if (real.length) { console.error("Erros:", real); process.exit(1); }
console.log("E2E OK");
