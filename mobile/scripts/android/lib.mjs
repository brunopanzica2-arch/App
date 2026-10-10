// Utilitários da suíte visual Android: adb, captura de tela real do aparelho/emulador e CDP do WebView (app em depuração).
// Nada aqui simula o app: as capturas vêm de `adb exec-out screencap -p` e os comandos de gestos/toques do `adb shell input`.
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export const SDK = process.env.ANDROID_HOME || "/root/android-sdk";
export const ADB = process.env.ADB || path.join(SDK, "platform-tools", "adb");
export const PKG = "br.santos.rota";
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function adb(args, opts = {}) {
  const r = spawnSync(ADB, Array.isArray(args) ? args : args.split(" "), { encoding: opts.binary ? "buffer" : "utf8", maxBuffer: 256 * 1024 * 1024, timeout: opts.timeout ?? 120000 });
  if (r.status !== 0 && !opts.allowFail) throw new Error(`adb ${args} → ${r.status}: ${String(r.stderr).slice(0, 300)}`);
  return opts.binary ? r.stdout : String(r.stdout).trim();
}
export const sh = (cmd, opts) => adb(["shell", cmd], opts);

export function screencap(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const buf = adb(["exec-out", "screencap", "-p"], { binary: true, timeout: 180000 });
  fs.writeFileSync(file, buf);
  return buf.length;
}
export const geoFix = (lat, lon) => adb(["emu", "geo", "fix", String(lon), String(lat)], { allowFail: true }); // ordem: longitude, latitude

export function deviceInfo() {
  const g = (k) => sh(`getprop ${k}`, { allowFail: true });
  return {
    modelo: g("ro.product.model"), api: g("ro.build.version.sdk"), release: g("ro.build.version.release"),
    abi: g("ro.product.cpu.abi"), resolucao: sh("wm size", { allowFail: true }), densidade: sh("wm density", { allowFail: true }),
    locale: g("persist.sys.locale") || g("ro.product.locale"), qemu: g("ro.kernel.qemu"),
  };
}

// ------------------------------------------------------------------ CDP do WebView
export async function cdpConnect(port = 9333, tries = 40) {
  let pid = "";
  for (let i = 0; i < tries && !pid; i++) {
    const unix = sh("cat /proc/net/unix", { allowFail: true });
    const m = unix.match(/webview_devtools_remote_(\d+)/);
    const appPid = sh(`pidof ${PKG}`, { allowFail: true }).split(/\s+/)[0];
    if (m && (!appPid || m[1] === appPid)) pid = m[1];
    else await sleep(1500);
  }
  if (!pid) throw new Error("socket de depuração do WebView não encontrado (app não está em primeiro plano ou não é debuggable)");
  adb(["forward", `tcp:${port}`, `localabstract:webview_devtools_remote_${pid}`]);
  let list = [];
  for (let i = 0; i < 20; i++) {
    try { list = await (await fetch(`http://127.0.0.1:${port}/json`)).json(); if (list.length) break; } catch { /* tenta de novo */ }
    await sleep(1000);
  }
  const page = list.find((p) => p.type === "page" && !/devtools/.test(p.url)) ?? list[0];
  if (!page) throw new Error("nenhuma página no WebView");
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error("falha ao abrir CDP")); });
  let id = 0;
  const pending = new Map();
  const logs = [];
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { const { res, rej } = pending.get(m.id); pending.delete(m.id); m.error ? rej(new Error(m.error.message)) : res(m.result); }
    else if (m.method === "Runtime.consoleAPICalled") logs.push(`${m.params.type}: ${m.params.args.map((a) => a.value ?? a.description ?? "").join(" ")}`.slice(0, 300));
    else if (m.method === "Runtime.exceptionThrown") logs.push(`EXCEPTION: ${m.params.exceptionDetails?.exception?.description ?? m.params.exceptionDetails?.text}`.slice(0, 400));
  };
  const send = (method, params = {}) => new Promise((res, rej) => { const i = ++id; pending.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method, params })); setTimeout(() => pending.has(i) && (pending.delete(i), rej(new Error(`timeout CDP ${method}`))), 60000); });
  await send("Runtime.enable");
  const evaluate = async (expression) => {
    const r = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
    return r.result.value;
  };
  return { send, evaluate, logs, close: () => ws.close(), pid };
}

/** Espera uma condição JS (string) ficar verdadeira dentro do WebView. */
export async function waitFor(cdp, cond, timeoutMs = 120000, every = 1500) {
  const t0 = Date.now();
  let last;
  while (Date.now() - t0 < timeoutMs) {
    try { last = await cdp.evaluate(cond); if (last) return last; } catch (e) { last = String(e); }
    await sleep(every);
  }
  throw new Error(`timeout (${timeoutMs} ms) esperando: ${cond} — último: ${JSON.stringify(last)}`);
}

/** Toque nativo (adb input) no centro de um elemento do DOM: converte px CSS → px de tela. */
export async function tapSelector(cdp, selector) {
  const r = await cdp.evaluate(`(() => { const e = document.querySelector(${JSON.stringify(selector)}); if (!e) return null; const b = e.getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + b.height / 2, dpr: devicePixelRatio, sy: window.screenY || 0 }; })()`);
  if (!r) throw new Error(`elemento não encontrado: ${selector}`);
  const off = await cssToScreenOffset(cdp);
  sh(`input tap ${Math.round(r.x * r.dpr + off.x)} ${Math.round(r.y * r.dpr + off.y)}`);
}
let offCache = null;
export async function cssToScreenOffset(cdp) {
  if (offCache) return offCache;
  // o WebView ocupa a janela do app; o deslocamento vertical é a altura da barra de status (WebView não vai sob ela neste app)
  const top = sh("dumpsys window | grep -m1 -E 'mStatusBarHeight|statusBars'", { allowFail: true });
  const sbh = Number((sh("dumpsys window displays | grep -m1 -oE 'statusBars.*?frame=\\[[0-9,]+\\]\\[[0-9,]+\\]'", { allowFail: true }).match(/\]\[\d+,(\d+)\]/) || [])[1]) || 0;
  void top;
  const off = { x: 0, y: sbh };
  offCache = off;
  return off;
}
