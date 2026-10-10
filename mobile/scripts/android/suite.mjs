#!/usr/bin/env node
// Suíte visual Android — dirige o APK REAL no emulador/aparelho (adb + WebView via CDP) e guarda capturas reais.
// Uso: node scripts/android/suite.mjs <apk> <run-id> [--only 01,02] [--base]    (emulador/aparelho já iniciado e desbloqueado)
// Cada cenário grava PASS/FAIL/SKIP/BLOCKED com motivo em docs/evidencias-android/<run-id>/resultado.json. Nada é forjado:
// se um passo não puder ser executado, o cenário fica SKIP/BLOCKED, nunca PASS.
import fs from "node:fs";
import path from "node:path";
import { PKG, adb, cdpConnect, deviceInfo, geoFix, screencap, sh, sleep, waitFor } from "./lib.mjs";
import crypto from "node:crypto";

const [apk, runId = new Date().toISOString().replace(/[:.]/g, "-")] = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const only = (process.argv.find((a) => a.startsWith("--only"))?.split("=")[1] ?? "").split(",").filter(Boolean);
const OUT = path.resolve("../docs/evidencias-android", runId);
fs.mkdirSync(OUT, { recursive: true });
const results = {};
const rec = (id, status, detail, shots = []) => { results[id] = { status, detail, shots }; console.log(`${status} ${id}: ${detail}`); fs.writeFileSync(path.join(OUT, "resultado.json"), JSON.stringify({ run: runId, apk: path.basename(apk ?? ""), results }, null, 2)); };
const shot = (n) => { screencap(path.join(OUT, `${n}.png`)); return `${n}.png`; };
const want = (id) => !only.length || only.includes(id);

// Santos (Centro/Vila Nova) — coordenadas de teste ao longo de ruas
const P0 = [-23.948914, -46.333680], P1 = [-23.9496, -46.3329], P2 = [-23.9503, -46.3322], P3 = [-23.9510, -46.3315];

// ---------------------------------------------------------------- preparação
const info = deviceInfo();
const apkHash = apk ? crypto.createHash("sha256").update(fs.readFileSync(apk)).digest("hex") : "";
fs.writeFileSync(path.join(OUT, "ambiente.json"), JSON.stringify({ ...info, apk: apk ? path.basename(apk) : null, apkSha256: apkHash, data: new Date().toISOString() }, null, 2));
console.log("ambiente", info);
if (apk) { sh(`pm uninstall ${PKG}`, { allowFail: true }); adb(["install", "-r", "-t", apk], { timeout: 600000 }); }
sh("input keyevent KEYCODE_WAKEUP", { allowFail: true });
sh("wm dismiss-keyguard", { allowFail: true });
const grant = () => ["ACCESS_FINE_LOCATION", "ACCESS_COARSE_LOCATION", "POST_NOTIFICATIONS"].forEach((p) => sh(`pm grant ${PKG} android.permission.${p}`, { allowFail: true }));
const revoke = () => ["ACCESS_FINE_LOCATION", "ACCESS_COARSE_LOCATION"].forEach((p) => sh(`pm revoke ${PKG} android.permission.${p}`, { allowFail: true }));
async function launch(clear = false) {
  if (clear) sh(`pm clear ${PKG}`, { allowFail: true });
  sh(`am force-stop ${PKG}`, { allowFail: true });
  sh("logcat -c", { allowFail: true });
  sh(`am start -n ${PKG}/.MainActivity`);
  await sleep(4000);
  return cdpConnect();
}
const saveLog = (name) => fs.writeFileSync(path.join(OUT, `${name}.logcat.txt`), adb(["logcat", "-d", "-v", "threadtime"], { allowFail: true, timeout: 120000 }));
const home = (cdp) => cdp.evaluate(`(() => { const e = document.querySelector("[data-testid=map-home]"); return e ? { map: e.dataset.mapState, gps: e.dataset.gpsState, nav: e.dataset.nav, fix: e.dataset.fix } : null; })()`);

// ---------------------------------------------------------------- 01 tela principal sem cartas
let cdp;
try {
  if (want("01")) {
    grant(); geoFix(...P0);
    const t0 = Date.now();
    cdp = await launch(true);
    shot("01_home_abertura");
    let st;
    try {
      await waitFor(cdp, `(() => { const e = document.querySelector("[data-testid=map-home]"); return e && (e.dataset.mapState === "operational" || e.dataset.mapState === "rendered" || e.dataset.mapState === "error"); })()`, 600000, 3000);
      st = await home(cdp);
    } catch (e) { st = { erro: String(e) }; }
    const ms = Date.now() - t0;
    const s2 = shot("02_home_mapa_carregado");
    const geom = await cdp.evaluate(`(() => { const c = document.querySelector("[role=application] canvas"); const r = c?.getBoundingClientRect(); return { w: r?.width, h: r?.height }; })()`);
    // verificação semântica: canvas com tamanho real e mapa operacional (não só "load")
    const ok = st?.map === "operational" && geom.h > 300;
    rec("01", ok ? "PASS" : "FAIL", `estado=${JSON.stringify(st)} canvas=${JSON.stringify(geom)} tempo até mapa=${ms} ms (emulador sem KVM: lento; não é medida de aparelho)`, ["01_home_abertura.png", s2]);
    saveLog("logcat_01");
  }
} catch (e) { rec("01", "FAIL", String(e)); }

// ---------------------------------------------------------------- 02 GPS
try {
  if (want("02") && cdp) {
    geoFix(...P0);
    await waitFor(cdp, `document.querySelector("[data-testid=map-home]")?.dataset.gpsState === "ok"`, 300000, 3000).catch(() => {});
    const a = await home(cdp);
    await sleep(3000);
    const s4 = shot("04_gps_autorizado_marcador");
    rec("02a", a?.gps === "ok" && a.fix ? "PASS" : "FAIL", `gps=${a?.gps} fix=${a?.fix}`, [s4]);
    const moves = [P1, P2, P3];
    const shots = [];
    const seen = [];
    for (let i = 0; i < moves.length; i++) {
      geoFix(...moves[i]);
      await waitFor(cdp, `(() => { const f = document.querySelector("[data-testid=map-home]")?.dataset.fix; return f && f !== ${JSON.stringify(seen.at(-1) ?? "")}; })()`, 180000, 3000).catch(() => {});
      await sleep(2500);
      seen.push((await home(cdp))?.fix);
      shots.push(shot(`0${5 + i}_gps_movimento_${i + 1}`));
    }
    const distinct = new Set(seen).size;
    rec("02b", distinct === 3 ? "PASS" : "FAIL", `fixes observados: ${seen.join(" | ")}`, shots);
    saveLog("logcat_02");
  }
} catch (e) { rec("02", "FAIL", String(e)); }

// ---------------------------------------------------------------- 02h permissão negada / GPS desligado / retomada
try {
  if (want("02h")) {
    revoke();
    cdp = await launch(false);
    await waitFor(cdp, `["denied","needs_permission"].includes(document.querySelector("[data-testid=map-home]")?.dataset.gpsState)`, 300000, 3000).catch(() => {});
    const d = await home(cdp);
    const s = shot("08_gps_permissao_negada");
    rec("02c", ["denied", "needs_permission"].includes(d?.gps) ? "PASS" : "FAIL", `gps=${d?.gps}; marcador azul não deve aparecer sem fix: fix='${d?.fix}'`, [s]);
    grant(); geoFix(...P0);
    cdp = await launch(false);
    await waitFor(cdp, `document.querySelector("[data-testid=map-home]")?.dataset.gpsState === "ok"`, 300000, 3000).catch(() => {});
    const d2 = await home(cdp);
    rec("02d", d2?.gps === "ok" ? "PASS" : "FAIL", `retomada após conceder permissão: gps=${d2?.gps}`, [shot("10_gps_retomado")]);
    rec("02e", "SKIP", "GPS do aparelho desligado (09_gps_desligado): o emulador não expõe interruptor confiável por adb nesta imagem");
  }
} catch (e) { rec("02h", "FAIL", String(e)); }

console.log("fim parcial; veja", OUT);
process.exit(0);
