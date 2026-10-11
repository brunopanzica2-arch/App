// Splash "Panzica Productions" no Chromium (NÃO Android): sequência de quadros, textos animados (nunca surgem/somem de uma vez), saída animada e jank medido.
import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright";
const BASE = process.env.E2E_BASE || "http://localhost:4173/";
const OUT = path.resolve("../docs/evidencias-chromium-2_3");
fs.mkdirSync(OUT, { recursive: true });
const b = await chromium.launch({ args: ["--use-gl=swiftshader", "--enable-unsafe-swiftshader"] });
const ctx = await b.newContext({ viewport: { width: 412, height: 915 }, serviceWorkers: "block", geolocation: { latitude: -23.9372, longitude: -46.3318 }, permissions: ["geolocation"] });
const p = await ctx.newPage();
const res = {};
const ok = (k, v, d) => { res[k] = { ok: v, d }; console.log(`${v ? "PASSOU" : "FALHOU"} ${k}: ${d}`); };
await p.addInitScript(() => {
  window.__frames = []; window.__samples = [];
  let last = performance.now();
  const tick = (t) => { window.__frames.push(t - last); last = t; requestAnimationFrame(tick); };
  requestAnimationFrame(tick);
  setInterval(() => {
    const s = document.getElementById("splash"); if (!s) { window.__samples.push({ t: Math.round(performance.now()), gone: true }); return; }
    const cs = (e) => (e ? +getComputedStyle(e).opacity : null);
    const chars = [...s.querySelectorAll(".c")].map(cs);
    window.__samples.push({ t: Math.round(performance.now()), root: cs(s), logo: cs(s.querySelector(".logo-wrap")), wheel: cs(s.querySelector(".wheel")), msg: cs(s.querySelector(".msg")), charsMin: Math.min(...chars), charsMax: Math.max(...chars), charsMid: chars.filter((o) => o > 0.02 && o < 0.98).length });
  }, 50);
});
await p.goto(BASE, { waitUntil: "commit" });
await p.waitForSelector("#splash");
const t0 = Date.now();
const marks = [300, 800, 1300, 1900, 2500, 3200, 4000];
for (const m of marks) { await p.waitForTimeout(Math.max(0, m - (Date.now() - t0))); await p.screenshot({ path: path.join(OUT, `splash_f${String(m).padStart(4, "0")}ms.png`) }); }
const info = await p.evaluate(() => { const s = document.getElementById("splash"); if (!s) return null; const logo = s.querySelector(".logo").getBoundingClientRect(); return { bg: getComputedStyle(s).backgroundColor, text: [...s.querySelectorAll(".w")].map((w) => w.textContent).join(" "), logoCx: logo.left + logo.width / 2, vw: innerWidth, wheel: getComputedStyle(s.querySelector(".wheel i")).animationName, anims: s.getAnimations({ subtree: true }).length }; });
ok("fundo preto", info?.bg === "rgb(0, 0, 0)", info?.bg);
ok("texto 'Panzica Productions' (letra por letra)", info?.text === "Panzica Productions", info?.text);
ok("logo centralizada", info && Math.abs(info.logoCx - info.vw / 2) < 1, `centro x=${info?.logoCx} de ${info?.vw / 2}`);
ok("roda de carregamento girando", info?.wheel === "sp-rot", info?.wheel);
await p.waitForFunction(() => !document.getElementById("splash"), null, { timeout: 20000 });
const total = Date.now() - t0;
await p.waitForTimeout(600);
await p.screenshot({ path: path.join(OUT, "splash_app_aberto.png") });
const { frames, samples } = await p.evaluate(() => ({ frames: window.__frames, samples: window.__samples }));
const live = samples.filter((s) => !s.gone);
const ramp = (k) => live.filter((s) => s[k] > 0.03 && s[k] < 0.97).length;
ok("duração total (entrada ≥ 4,3 s + saída animada)", total >= 4300, `${total} ms até a remoção`);
ok("letras entram com rampa de opacidade (não surgem do nada)", live.some((s) => s.charsMid >= 3) && ramp("logo") >= 3, `amostras com letras em transição: ${live.filter((s) => s.charsMid > 0).length}; logo em rampa: ${ramp("logo")}`);
ok("roda entra com rampa", ramp("wheel") >= 2, `${ramp("wheel")} amostras`);
const exitRamp = live.filter((s) => s.root !== null && s.root > 0.03 && s.root < 0.97).length;
const charsFade = live.filter((s) => s.charsMid > 0).length;
ok("saída animada: fundo some em rampa e letras saem escalonadas", exitRamp >= 4 && charsFade >= 8, `fundo em rampa: ${exitRamp} amostras; letras em transição: ${charsFade}`);
const f = frames.slice(5).filter((x) => x > 0);
const over50 = f.filter((x) => x > 50).length, max = Math.round(Math.max(...f));
ok("jank medido (quadros >50 ms durante todo o carregamento)", over50 <= 6, `${f.length} quadros, ${over50} acima de 50 ms, pior ${max} ms (Chromium headless com GL por software: pior caso)`);
fs.writeFileSync(path.join(OUT, "resultado_splash.json"), JSON.stringify({ res, total, quadros: f.length, acima50ms: over50, piorMs: max }, null, 2));
await b.close();
process.exit(Object.values(res).every((r) => r.ok) ? 0 : 1);
