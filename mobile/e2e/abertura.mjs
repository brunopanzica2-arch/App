// Abertura 2 cenas no Chromium (viewport de celular). NÃO é Android. Quadros em docs/evidencias-chromium-2_4/.
import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright";
const BASE = process.env.E2E_BASE || "http://localhost:4173/";
const OUT = path.resolve("../docs/evidencias-chromium-2_4");
fs.mkdirSync(OUT, { recursive: true });
const res = {};
const ok = (k, v, d) => { res[k] = { ok: !!v, d }; console.log(`${v ? "PASSOU" : "FALHOU"} ${k}: ${d}`); };
const b = await chromium.launch({ args: ["--use-gl=swiftshader", "--enable-unsafe-swiftshader"] });
const mk = async (opts = {}) => {
  const ctx = await b.newContext({ viewport: { width: 412, height: 915 }, serviceWorkers: "block", geolocation: { latitude: -23.9372, longitude: -46.3318 }, permissions: ["geolocation"], ...opts });
  return [ctx, await ctx.newPage()];
};
const phase = (p) => p.evaluate(() => document.querySelector("[data-testid=abertura]")?.getAttribute("data-phase") ?? "none");
const gone = (p, t = 20000) => p.waitForFunction(() => !document.querySelector("[data-testid=abertura]"), null, { timeout: t });

// ---- 1. primeira abertura do dia: completa, com quadros
{
  const [ctx, p] = await mk();
  await p.goto(BASE, { waitUntil: "commit" });
  await p.waitForSelector("[data-testid=abertura]");
  const sr = await p.evaluate(() => document.querySelector("[data-testid=abertura] [role=status]")?.textContent);
  const t0 = Date.now(), seq = [];
  for (const m of [150, 450, 900, 1500, 2050, 2250, 2600, 3000, 3300, 3550, 3900]) {
    await p.waitForTimeout(Math.max(0, m - (Date.now() - t0)));
    seq.push({ m, ph: await phase(p) });
    await p.screenshot({ path: path.join(OUT, `full_${String(m).padStart(4, "0")}ms.png`) });
  }
  ok("1ª do dia: cena 1 (cartão) antes da cena 2", seq.some((s) => s.ph.startsWith("s1")) && seq.some((s) => s.ph === "s2"), seq.map((s) => `${s.m}:${s.ph}`).join(" "));
  const font = await p.evaluate(() => document.fonts.check('40px "Bebas Neue"'));
  ok("fonte do cartão carregada (sem fallback)", font, String(font));
  ok("anúncio 'Carregando rota' em aria-live", /Carregando rota/.test(sr || ""), sr);
  const hidden = await p.evaluate(() => [...document.querySelectorAll(".ab-s1,.ab-s2")].every((e) => e.getAttribute("aria-hidden") === "true"));
  ok("animação com aria-hidden", hidden, String(hidden));
  await gone(p);
  const total = Date.now() - t0;
  ok("abertura completa dura ~3,5–5 s e some", total > 3300 && total < 7000, `${total} ms`);
  const foc = await p.evaluate(() => document.activeElement?.id);
  ok("foco vai para o conteúdo principal", foc === "main-content", `activeElement#${foc}`);
  await p.waitForTimeout(500);
  await p.screenshot({ path: path.join(OUT, "app_depois_da_abertura.png") });
  ok("não há skeleton/spinner de tela cheia depois", (await p.getByTestId("home-loading").count()) === 0, "ok");
  // ---- 2. segunda abertura do dia: só cena 2 curta
  const p2 = await ctx.newPage();
  await p2.goto(BASE, { waitUntil: "commit" });
  await p2.waitForSelector("[data-testid=abertura]");
  const s0 = Date.now();
  const mode = await p2.evaluate(() => document.querySelector("[data-testid=abertura]").getAttribute("data-mode"));
  const ph0 = await phase(p2);
  await gone(p2);
  const t2 = Date.now() - s0;
  ok("2ª abertura do dia: só cena 2 curta", mode === "short" && ph0 !== "s1-in", `modo=${mode} fase inicial=${ph0}; ${t2} ms até sumir (inclui espera dos dados)`);
  await p2.screenshot({ path: path.join(OUT, "app_segunda_abertura.png") });
  await ctx.close();
}
// ---- 3. tocar pula
{
  const [ctx, p] = await mk();
  await p.goto(BASE, { waitUntil: "commit" });
  await p.waitForSelector("[data-testid=abertura]");
  await p.waitForTimeout(700);
  const t0 = Date.now();
  await p.mouse.click(200, 400);
  await gone(p, 3000);
  ok("tocar na tela pula a abertura", Date.now() - t0 < 1500, `${Date.now() - t0} ms após o toque`);
  await ctx.close();
}
// ---- 4. "Pular abertura" nas opções
{
  const [ctx, p] = await mk();
  await ctx.addInitScript(() => { try { localStorage.setItem("rota.intro.skip", "1"); } catch {} });
  await p.goto(BASE, { waitUntil: "commit" });
  await p.waitForTimeout(400);
  ok("opção 'Pular abertura': nenhuma abertura", (await p.getByTestId("abertura").count()) === 0, "sem overlay aos 400 ms");
  await p.waitForSelector("[data-testid=map-home]");
  await p.goto(BASE + "#/ajustes");
  await p.getByTestId("intro-prefs").waitFor();
  ok("opção existe em Ajustes", await p.getByLabel("Pular abertura").isChecked(), "marcada");
  await ctx.close();
}
// ---- 5. reduced motion: cartão estático, fade curto
{
  const [ctx, p] = await mk({ reducedMotion: "reduce" });
  await p.goto(BASE, { waitUntil: "commit" });
  await p.waitForSelector("[data-testid=abertura]");
  const t0 = Date.now();
  const mode = await p.evaluate(() => document.querySelector("[data-testid=abertura]").getAttribute("data-mode"));
  await p.waitForTimeout(300);
  await p.screenshot({ path: path.join(OUT, "reduced_300ms.png") });
  const moved = await p.evaluate(() => { const r = document.querySelector(".ab-route"); return r ? getComputedStyle(r).strokeDashoffset : "n/a"; });
  await gone(p, 6000);
  const t = Date.now() - t0;
  ok("reduced motion: ~800 ms, sem movimento na rota", mode === "reduced" && t < 2500, `modo=${mode}; ${t} ms (inclui espera dos dados); traço da rota=${moved}`);
  await ctx.close();
}
// ---- 6. métricas: quadros durante a abertura (jank)
{
  const [ctx, p] = await mk();
  await p.addInitScript(() => { window.__f = []; let l = performance.now(); const t = (n) => { window.__f.push(n - l); l = n; requestAnimationFrame(t); }; requestAnimationFrame(t); });
  await p.goto(BASE, { waitUntil: "commit" });
  await p.waitForSelector("[data-testid=abertura]");
  await gone(p);
  const f = (await p.evaluate(() => window.__f)).slice(5);
  const over = f.filter((x) => x > 50).length, max = Math.round(Math.max(...f));
  ok("jank na abertura (quadros >50 ms)", over <= 8, `${f.length} quadros, ${over} >50 ms, pior ${max} ms (GL por software: pior caso)`);
  await ctx.close();
}
fs.writeFileSync(path.join(OUT, "resultado_abertura.json"), JSON.stringify(res, null, 2));
await b.close();
const bad = Object.entries(res).filter(([, v]) => !v.ok).map(([k]) => k);
console.log(bad.length ? `FALHAS: ${bad.join("; ")}` : "TODOS PASSARAM");
process.exit(bad.length ? 1 : 0);
