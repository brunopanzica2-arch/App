import { useCallback, useEffect, useRef, useState } from "react";
import type { Route } from "../core/db";
import { buildNavRoute, type NavRoute, type StopMeta } from "../core/navroute";
import { getNavPrefs, journalNav, rerouteFrom, stopsOf, type StopView } from "../core/service";
import { drainEvents, type NavFix, type NavState, nav, onNavEvent } from "../native/rotaNav";

const REROUTE_COOLDOWN_MS = 45_000; // histerese: no máx. 1 recálculo por desvio a cada 45 s

export function stopMeta(s: StopView): StopMeta {
  const code = s.trust.code;
  return { street: s.address.street, number: s.address.number ?? "", letters: s.letters.filter((l) => !["delivered", "not_delivered", "returned", "address_not_found"].includes(l.status)).length || s.letters.length,
    precision: code === "test" ? "street" : code };
}

export interface NavUi {
  active: boolean; paused: boolean; backend: string;
  fix: NavFix | null; state: NavState | null; instruction: string; nearStopKey: string | null; nearStopText: string;
  offRoute: boolean; rerouting: boolean; error: string | null; route: NavRoute | null;
  /** trecho restante [lon,lat][] */ ahead: [number, number][] | null;
}

const IDLE: NavUi = { active: false, paused: false, backend: "", fix: null, state: null, instruction: "", nearStopKey: null, nearStopText: "", offRoute: false, rerouting: false, error: null, route: null, ahead: null };

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
        case "location": fixRef.current = d; setUi((u) => (u.active || !u.route ? { ...u, fix: d } : u)); break;
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
        case "locationError": setUi((u) => ({ ...u, error: d.message })); break;
        case "navigation":
          if (d.status === "paused") setUi((u) => ({ ...u, paused: true }));
          if (d.status === "resumed") setUi((u) => ({ ...u, paused: false }));
          if (d.status === "stopped") setUi((u) => ({ ...IDLE, fix: u.fix }));
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
    setUi((u) => ({ ...IDLE, fix: u.fix }));
  }, []);

  /** Posição sem rota (botão "minha localização"). */
  const locate = useCallback(async () => {
    const p = await nav.requestPermissions();
    if (p.location !== "granted" && nav.isNative()) { setUi((u) => ({ ...u, error: "Sem permissão de localização." })); return; }
    try { await nav.startLocation(); } catch (e) { setUi((u) => ({ ...u, error: (e as Error).message })); }
  }, []);

  return { ui, start, stop, locate, pause: () => nav.pause(), resume: () => nav.resume(), repeat: () => nav.repeat(),
    advance: () => nav.advanceStop(), dismissNear: () => setUi((u) => ({ ...u, nearStopKey: null, nearStopText: "" })), getFix: () => fixRef.current };
}
