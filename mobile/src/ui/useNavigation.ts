import { useCallback, useEffect, useRef, useState } from "react";
import { db, type Route } from "../core/db";
import { buildNavRoute, type NavRoute, type StopMeta } from "../core/navroute";
import { getNavPrefs, getSettings, journalNav, rerouteFrom, stopsOf, type StopView } from "../core/service";
import { log } from "../core/log";
import { drainEvents, type NavFix, type NavState, nav, onNavEvent } from "../native/rotaNav";

const REROUTE_COOLDOWN_MS = 45_000; // histerese: no máx. 1 recálculo por desvio a cada 45 s

export function stopMeta(s: StopView): StopMeta {
  const code = s.trust.code;
  return { street: s.address.street, number: s.address.number ?? "", letters: s.letters.filter((l) => !["delivered", "not_delivered", "returned", "address_not_found"].includes(l.status)).length || s.letters.length,
    precision: code === "test" ? "street" : code };
}

export type GpsState = "idle" | "needs_permission" | "asking" | "denied" | "disabled" | "searching" | "ok" | "stale" | "error";
export const STALE_MS = 15_000;
const ASKED_KEY = "rota.locAsked";

export interface NavUi {
  gps: GpsState; gpsMsg: string;
  active: boolean; paused: boolean; backend: string;
  fix: NavFix | null; state: NavState | null; instruction: string; nearStopKey: string | null; nearStopText: string;
  offRoute: boolean; rerouting: boolean; error: string | null; route: NavRoute | null;
  /** trecho restante [lon,lat][] */ ahead: [number, number][] | null;
}

const IDLE: NavUi = { gps: "idle", gpsMsg: "", active: false, paused: false, backend: "", fix: null, state: null, instruction: "", nearStopKey: null, nearStopText: "", offRoute: false, rerouting: false, error: null, route: null, ahead: null };

/** Recorta o trecho restante a partir do progresso (m). */
export function aheadFrom(r: NavRoute, progress: number): [number, number][] {
  const n = r.lat.length;
  let acc = 0, i = 1;
  for (; i < n; i++) {
    const d = Math.hypot((r.lat[i] - r.lat[i - 1]) * 111_000, (r.lon[i] - r.lon[i - 1]) * 111_000 * Math.cos((r.lat[i] * Math.PI) / 180));
    if (acc + d >= progress) break;
    acc += d;
  }
  const out: [number, number][] = [];
  for (let k = Math.max(0, i - 1); k < n; k++) out.push([r.lon[k], r.lat[k]]);
  return out;
}

export function useNavigation(onRerouted?: (r: Route) => void) {
  const [ui, setUi] = useState<NavUi>(IDLE);
  const routeDoc = useRef<Route | null>(null);
  const navRoute = useRef<NavRoute | null>(null);
  const lastReroute = useRef(0);
  const lastAhead = useRef(0);
  const fixRef = useRef<NavFix | null>(null);
  const waiters = useRef<((f: NavFix) => void)[]>([]);
  const cb = useRef(onRerouted);
  cb.current = onRerouted;

  const build = useCallback(async (r: Route) => {
    const { stops } = await stopsOf(r.batchId);
    const meta = new Map(stops.map((s) => [s.key, stopMeta(s)]));
    const nr = buildNavRoute({ features: r.geojson.features, order: r.stops as any }, r.start, meta);
    const firstOpen = r.stops.findIndex((rs) => ["pending", "partial"].includes(stops.find((s) => s.key === rs.key)?.status ?? "completed"));
    return { nr, index: Math.max(0, firstOpen) };
  }, []);

  useEffect(() => {
    const off = onNavEvent((name, d) => {
      switch (name) {
        case "location": {
          fixRef.current = d;
          waiters.current.splice(0).forEach((w) => w(d));
          setUi((u) => ({ ...u, fix: d, gps: d.accuracy > 150 ? "searching" : "ok", gpsMsg: d.accuracy > 150 ? `sinal impreciso (±${Math.round(d.accuracy)} m)` : "" }));
          break;
        }
        case "navState": {
          const now = Date.now();
          setUi((u) => {
            let ahead = u.ahead;
            if (navRoute.current && now - lastAhead.current > 2000) { lastAhead.current = now; ahead = aheadFrom(navRoute.current, d.progress); }
            return { ...u, state: d, offRoute: d.offRoute, ahead };
          });
          break;
        }
        case "instruction": setUi((u) => ({ ...u, instruction: d.text })); break;
        case "nearStop": setUi((u) => ({ ...u, nearStopKey: d.stopKey, nearStopText: d.text, instruction: d.text })); break;
        case "locationError": {
          const off = /desligad|disabled/i.test(String(d.message));
          log("gps", "erro", { msg: String(d.message).slice(0, 80) });
          setUi((u) => ({ ...u, gps: off ? "disabled" : "error", gpsMsg: String(d.message) }));
          break;
        }
        case "navigation":
          if (d.status === "paused") setUi((u) => ({ ...u, paused: true }));
          if (d.status === "resumed") setUi((u) => ({ ...u, paused: false }));
          if (d.status === "stopped") setUi((u) => ({ ...IDLE, fix: u.fix, gps: u.gps }));
          break;
        case "routeEnd": setUi((u) => ({ ...u, instruction: "Rota concluída." })); break;
        case "offRoute": {
          const r = routeDoc.current;
          const now = Date.now();
          if (!r || now - lastReroute.current < REROUTE_COOLDOWN_MS) break;
          lastReroute.current = now;
          setUi((u) => ({ ...u, rerouting: true }));
          rerouteFrom(r, { lat: d.lat, lon: d.lon }).then(async (nr) => {
            routeDoc.current = nr;
            const { nr: navR, index } = await build(nr);
            navRoute.current = navR;
            await nav.updateRoute(navR, index);
            await journalNav(nr);
            setUi((u) => ({ ...u, rerouting: false, route: navR, ahead: aheadFrom(navR, 0) }));
            cb.current?.(nr);
          }).catch((e) => setUi((u) => ({ ...u, rerouting: false, error: `Não foi possível recalcular: ${(e as Error).message}` })));
          break;
        }
      }
    });
    const vis = () => { if (document.visibilityState === "visible") void drainEvents(); };
    document.addEventListener("visibilitychange", vis);
    return () => { off(); document.removeEventListener("visibilitychange", vis); };
  }, [build]);

  const start = useCallback(async (r: Route) => {
    setUi((u) => ({ ...u, error: null }));
    try {
      const perms = await nav.requestPermissions();
      if (perms.location !== "granted" && nav.isNative()) throw new Error("Sem permissão de localização. Ative em Ajustes do Android → Apps → Rota Santos → Permissões.");
      const prefs = await getNavPrefs();
      await nav.configure({ speech: prefs.speech, detailed: prefs.detailed, rate: prefs.rate, volume: prefs.volume, preciseGps: prefs.preciseGps, lockscreenManeuver: prefs.lockscreenManeuver });
      const { nr, index } = await build(r);
      if (nr.lat.length < 2) throw new Error("A rota não tem geometria para navegar.");
      routeDoc.current = r;
      navRoute.current = nr;
      const backend = await nav.start(nr, index);
      await nav.showWhenLocked(prefs.showWhenLocked);
      await journalNav(r);
      setUi((u) => ({ ...u, active: true, paused: false, backend, route: nr, ahead: aheadFrom(nr, 0), error: null, offRoute: false }));
    } catch (e) {
      setUi((u) => ({ ...u, error: (e as Error).message }));
    }
  }, [build]);

  const stop = useCallback(async () => {
    await nav.stop();
    await journalNav(null);
    routeDoc.current = null;
    navRoute.current = null;
    setUi((u) => ({ ...IDLE, fix: u.fix, gps: u.gps }));
  }, []);

  /** Espera o PRÓXIMO fix (evento), nunca lê o estado antes do primeiro evento. Rejeita no timeout. */
  const awaitFirstFix = useCallback((timeoutMs = 15_000) => new Promise<NavFix>((resolve, reject) => {
    const f = fixRef.current;
    if (f && Date.now() - f.time < STALE_MS) return resolve(f);
    const t = setTimeout(() => { waiters.current = waiters.current.filter((w) => w !== h); reject(new Error("sem sinal de GPS")); }, timeoutMs);
    const h = (x: NavFix) => { clearTimeout(t); resolve(x); };
    waiters.current.push(h);
  }), []);

  /** Posição contínua sem rota. `ask`: pede permissão se ainda não foi pedida (uma vez por instalação, em contexto: ao abrir o mapa). */
  const locate = useCallback(async (opts: { ask?: boolean } = {}) => {
    const perms = await nav.permissions();
    let loc = perms.location;
    // navegador: o próprio prompt do browser aparece ao iniciar; só o Android tem estado de permissão confiável para o fluxo abaixo
    if (loc !== "granted" && nav.isNative()) {
      const asked = (() => { try { return localStorage.getItem(ASKED_KEY) === "1"; } catch { return false; } })();
      if (loc === "denied" || (asked && !opts.ask)) { setUi((u) => ({ ...u, gps: loc === "denied" ? "denied" : "needs_permission", gpsMsg: "" })); log("gps", "sem_permissao", { loc }); return; }
      if (!opts.ask && !nav.isNative() && loc === "prompt") { /* navegador: o próprio prompt aparece ao iniciar */ }
      setUi((u) => ({ ...u, gps: "asking" }));
      try { localStorage.setItem(ASKED_KEY, "1"); } catch { /* ignore */ }
      loc = (await nav.requestPermissions()).location;
      if (loc !== "granted" && nav.isNative()) { setUi((u) => ({ ...u, gps: loc === "denied" ? "denied" : "needs_permission" })); return; }
    }
    setUi((u) => ({ ...u, gps: u.fix ? u.gps : "searching", gpsMsg: "" }));
    try { const backend = await nav.startLocation(); log("gps", "iniciado", { backend }); } catch (e) { setUi((u) => ({ ...u, gps: "error", gpsMsg: (e as Error).message })); }
  }, []);

  /** Ao reabrir a tela com a navegação nativa viva (Activity recriada): reconstrói o estado a partir do diário. */
  const attach = useCallback(async () => {
    try {
      const st = await nav.status();
      if (!st.navigating) return false;
      const j = (await getSettings()).navSession;
      const r = j ? await db.routes.get(j.routeId) : null;
      if (!r) return false;
      const { nr } = await build(r);
      routeDoc.current = r; navRoute.current = nr;
      setUi((u) => ({ ...u, active: true, paused: !!st.paused, route: nr, ahead: aheadFrom(nr, 0), backend: st.backend }));
      log("nav", "reanexado", { stopIndex: st.stopIndex });
      await drainEvents();
      return true;
    } catch { return false; }
  }, [build]);

  // idade do fix: marca "stale" quando para de chegar posição
  useEffect(() => {
    const t = setInterval(() => setUi((u) => (nav.isNative() && u.fix && u.gps === "ok" && Date.now() - u.fix.time > STALE_MS ? { ...u, gps: "stale" } : u)), 2000);
    return () => clearInterval(t);
  }, []);

  return { ui, start, stop, locate, awaitFirstFix, attach, pause: () => nav.pause(), resume: () => nav.resume(), repeat: () => nav.repeat(),
    advance: () => nav.advanceStop(), dismissNear: () => setUi((u) => ({ ...u, nearStopKey: null, nearStopText: "" })), getFix: () => fixRef.current };
}
