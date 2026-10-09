/** Cálculo completo de uma rota (roda no Web Worker; testável em Node). */
import type { Graph } from "./graph";
import { solve } from "./optimizer";
import { type LegFeature, type Profile, Router, SnapError } from "./router";

export interface PlanStop {
  key: string;
  lat: number;
  lon: number;
  service: number;
  priority?: number;
  sector?: string;
}

export interface PlanRequest {
  start: { lat: number; lon: number };
  end?: { lat: number; lon: number } | null;
  mode: "open" | "circular" | "fixed_end";
  strategy: "global" | "sectors";
  stops: PlanStop[];
  profile: Profile;
  timeLimitMs: number;
  maxSnap: number;
  fixedFirst?: string[]; // chaves das próximas paradas fixadas
}

export interface PlanResult {
  order: { key: string; seq: number; eta: number; legDistance: number; legTime: number; snapDistance: number }[];
  excluded: { key: string; reason: string }[];
  features: LegFeature[];
  totalTime: number;
  travelTime: number;
  serviceTime: number;
  totalDistance: number;
  byMode: Record<string, number>;
  flags: Record<string, number>;
  candidates: any[];
  strategy: string;
  timings: Record<string, number>;
  warnings: string[];
}

let cache: { profile: string; router: Router } | null = null;

export function routerFor(g: Graph, p: Profile): Router {
  const k = JSON.stringify(p);
  if (!cache || cache.profile !== k) cache = { profile: k, router: new Router(g, p) };
  return cache.router;
}

export function computePlan(g: Graph, req: PlanRequest, progress?: (stage: string, p: number) => void): PlanResult {
  const t0 = performance.now();
  const r = routerFor(g, req.profile);
  const warnings: string[] = [];
  const excluded: { key: string; reason: string }[] = [];
  let snapStart;
  try {
    snapStart = r.snap(req.start.lat, req.start.lon, req.maxSnap);
  } catch (e) {
    throw new Error(`Ponto de partida fora da malha: ${(e as Error).message}`);
  }
  let snapEnd = null;
  if (req.mode === "fixed_end" && req.end) {
    try {
      snapEnd = r.snap(req.end.lat, req.end.lon, req.maxSnap);
    } catch (e) {
      throw new Error(`Destino final fora da malha: ${(e as Error).message}`);
    }
  }
  const okStops: PlanStop[] = [];
  const snaps = [snapStart];
  for (const s of req.stops) {
    try {
      const sn = r.snap(s.lat, s.lon, req.maxSnap);
      if (sn.distance > 60) warnings.push(`${s.key.split("|")[1]} ${s.key.split("|")[2]}: ponto a ${Math.round(sn.distance)} m da via mais próxima.`);
      snaps.push(sn);
      okStops.push(s);
    } catch (e) {
      if (!(e instanceof SnapError)) throw e;
      excluded.push({ key: s.key, reason: e.message });
    }
  }
  if (snapEnd) snaps.push(snapEnd);
  if (!okStops.length) throw new Error("Nenhuma parada alcançável pela malha de pedestres.");
  const solver = r.solver(snaps);
  const t1 = performance.now();
  const { T, D } = solver.matrices((p) => progress?.("matriz", p));
  const matrixMs = performance.now() - t1;
  const endIdx = snapEnd ? snaps.length - 1 : null;
  const idx = okStops.map((_, i) => i + 1);
  const fixed = (req.fixedFirst || []).map((k) => okStops.findIndex((s) => s.key === k) + 1).filter((i) => i > 0);
  const free = idx.filter((i) => !fixed.includes(i));
  const service = Object.fromEntries(idx.map((i) => [i, okStops[i - 1].service]));
  const priority = Object.fromEntries(idx.filter((i) => okStops[i - 1].priority).map((i) => [i, okStops[i - 1].priority!]));
  const sector = req.strategy === "sectors" ? Object.fromEntries(idx.map((i) => [i, okStops[i - 1].sector || "?"])) : undefined;
  progress?.("otimização", 0);
  const t2 = performance.now();
  const res = solve({
    T, D, start: fixed.length ? fixed[fixed.length - 1] : 0, stops: free,
    end: req.mode === "circular" ? 0 : endIdx, service, priority, sector, timeLimitMs: req.timeLimitMs,
  });
  const solveMs = performance.now() - t2;
  const order = [...fixed, ...res.order];
  const seq = [0, ...order, ...(req.mode === "circular" ? [0] : endIdx != null ? [endIdx] : [])];
  progress?.("geometria", 0);
  const out: PlanResult = {
    order: [], excluded, features: [], totalTime: 0, travelTime: 0, serviceTime: 0, totalDistance: 0,
    byMode: {}, flags: {}, candidates: res.candidates.map(({ order: _o, ...c }) => c), strategy: res.best.strategy,
    timings: {}, warnings,
  };
  let clock = 0;
  for (let k = 0; k < seq.length - 1; k++) {
    const leg = solver.leg(seq[k], seq[k + 1]);
    leg.features.forEach((f) => { f.properties.leg = k + 1; out.features.push(f); });
    for (const [m, v] of Object.entries(leg.byMode)) out.byMode[m] = (out.byMode[m] || 0) + v;
    for (const [m, v] of Object.entries(leg.flags)) out.flags[m] = (out.flags[m] || 0) + v;
    clock += leg.time;
    out.travelTime += leg.time;
    out.totalDistance += leg.distance;
    const b = seq[k + 1];
    if (b >= 1 && b <= okStops.length) {
      const st = okStops[b - 1];
      out.order.push({ key: st.key, seq: out.order.length + 1, eta: clock, legDistance: leg.distance, legTime: leg.time, snapDistance: snaps[b].distance });
      clock += st.service;
      out.serviceTime += st.service;
    }
  }
  out.totalTime = clock;
  for (const [f, m] of Object.entries(out.flags))
    if (["escada", "acesso_privado", "barreira", "portao_privado", "proibido_pedalar", "travessia_de_praca"].includes(f))
      warnings.push(`Trecho sinalizado no percurso: ${f.replace(/_/g, " ")} (${Math.round(m)} m). Verifique no local.`);
  for (const e of excluded) warnings.push(`Parada excluída: ${e.reason}`);
  out.timings = { matrix_ms: Math.round(matrixMs), solve_ms: Math.round(solveMs), total_ms: Math.round(performance.now() - t0) };
  return out;
}
