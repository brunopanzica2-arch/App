/** Cálculo completo de uma rota (roda no Web Worker; testável em Node). */
import type { Graph } from "./graph";
import { evaluate, feasibility, solve, validateRoute } from "./optimizer";
import { type LegFeature, type Profile, Router, type Snap, SnapError } from "./router";

export interface PlanStop {
  key: string;
  lat: number;
  lon: number;
  service: number;
  priority?: number;
  sector?: string;
  label?: string;
  importRow?: number;
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
  snapReviewM?: number;
  fixedFirst?: string[];
}

export interface PlanResult {
  status: "complete" | "partial";
  feasible: true;
  order: { key: string; seq: number; eta: number; legDistance: number; legTime: number; snapDistance: number; access: number; confidence: string; flags: string[] }[];
  excluded: { key: string; reason: string }[];
  snapReview: { key: string; distance: number; confidence: string; flags: string[] }[];
  features: LegFeature[];
  totalTime: number;
  travelTime: number;
  serviceTime: number;
  accessTime: number;
  totalDistance: number;
  byMode: Record<string, number>;
  flags: Record<string, number>;
  candidates: any[];
  strategy: string;
  timings: Record<string, number>;
  warnings: string[];
  originFlags: string[];
}

export class PlanError extends Error {}

let cache: { profile: string; router: Router } | null = null;

export function routerFor(g: Graph, p: Profile): Router {
  const k = JSON.stringify(p);
  if (!cache || cache.profile !== k) cache = { profile: k, router: new Router(g, p) };
  return cache.router;
}

export function computePlan(g: Graph, req: PlanRequest, progress?: (stage: string, p: number) => void, shouldStop?: () => boolean): PlanResult {
  const t0 = performance.now();
  const r = routerFor(g, req.profile);
  const reviewM = req.snapReviewM ?? 30;
  const warnings: string[] = [];
  const excluded: { key: string; reason: string }[] = [];
  const keys = req.stops.map((s) => s.key);
  // validação do prefixo fixo (alerta L)
  const fixedKeys = req.fixedFirst || [];
  if (new Set(fixedKeys).size !== fixedKeys.length) throw new PlanError("Parada fixa duplicada.");
  for (const k of fixedKeys) if (!keys.includes(k)) throw new PlanError("Parada fixa inexistente ou sem cartas pendentes.");

  let origin: { snap: Snap; reach: Uint8Array };
  try {
    origin = r.snapOrigin(req.start.lat, req.start.lon, req.maxSnap);
  } catch (e) {
    throw new PlanError(`Ponto de partida fora da malha: ${(e as Error).message}`);
  }
  if (origin.snap.flags.includes("origem_em_trecho_isolado"))
    warnings.push("A origem está num trecho que alcança pouca malha; confira o pino de partida.");
  let snapEnd: Snap | null = null;
  if (req.mode === "fixed_end" && req.end) {
    try {
      snapEnd = r.snap(req.end.lat, req.end.lon, req.maxSnap, origin.reach);
    } catch (e) {
      throw new PlanError(`Destino final fora da malha: ${(e as Error).message}`);
    }
  }
  const okStops: PlanStop[] = [];
  const snaps: Snap[] = [origin.snap];
  const snapReview: PlanResult["snapReview"] = [];
  for (const s of req.stops) {
    try {
      const sn = r.snap(s.lat, s.lon, req.maxSnap, origin.reach);
      snaps.push(sn);
      okStops.push(s);
      if (sn.distance > reviewM || sn.flags.length) snapReview.push({ key: s.key, distance: sn.distance, confidence: sn.confidence, flags: sn.flags });
    } catch (e) {
      if (!(e instanceof SnapError)) throw e;
      excluded.push({ key: s.key, reason: e.message });
    }
  }
  if (snapEnd) snaps.push(snapEnd);
  if (!okStops.length) throw new PlanError("Nenhuma parada alcançável pela malha de pedestres a partir da origem.");
  const solver = r.solver(snaps);
  const t1 = performance.now();
  const { T, D } = solver.matrices((p) => progress?.("matriz", p), shouldStop);
  const matrixMs = performance.now() - t1;
  const endIdx = snapEnd ? snaps.length - 1 : null;
  const circular = req.mode === "circular";
  const idxAll = okStops.map((_, i) => i + 1);

  // factibilidade (alertas A/F): só uma sequência sem pares impossíveis
  const feas = feasibility(T, 0, idxAll, circular ? 0 : endIdx);
  for (const [i, why] of Object.entries(feas.excluded)) excluded.push({ key: okStops[+i - 1].key, reason: why });
  const ok = feas.kept;
  if (!ok.length) throw new PlanError("Nenhuma parada pode ser visitada a partir da origem.");
  const okSet = new Set(ok);

  const walk = req.profile.walk_speed_kmh / 3.6;
  const access = (i: number) => (2 * snaps[i].distance) / walk; // ida e volta a pé até o ponto do imóvel
  const fixed = fixedKeys.map((k) => okStops.findIndex((s) => s.key === k) + 1);
  if (fixed.some((i) => !okSet.has(i))) throw new PlanError("Parada fixa sem caminho de pedestre viável.");
  const free = ok.filter((i) => !fixed.includes(i));
  const service = Object.fromEntries(ok.map((i) => [i, okStops[i - 1].service + access(i)]));
  const priority = Object.fromEntries(ok.filter((i) => okStops[i - 1].priority).map((i) => [i, okStops[i - 1].priority!]));
  const sector = req.strategy === "sectors" ? Object.fromEntries(ok.map((i) => [i, okStops[i - 1].sector || "?"])) : undefined;
  const label = (i: number) => okStops[i - 1].label || okStops[i - 1].key;
  const baselines = {
    ordem_importada: [...free].sort((a, b) => (okStops[a - 1].importRow ?? 0) - (okStops[b - 1].importRow ?? 0)),
    alfabetica: [...free].sort((a, b) => label(a).localeCompare(label(b))),
    bairro_agrupado: [...free].sort((a, b) => (okStops[a - 1].sector || "").localeCompare(okStops[b - 1].sector || "") || label(a).localeCompare(label(b))),
  };
  progress?.("otimização", 0);
  const t2 = performance.now();
  const startForSolver = fixed.length ? fixed[fixed.length - 1] : 0;
  const end = circular ? 0 : endIdx;
  const res = solve({
    T, D, start: startForSolver, stops: free, end, service, priority, sector, timeLimitMs: req.timeLimitMs,
    compRank: feas.compRank, baselines, shouldStop,
  });
  const solveMs = performance.now() - t2;
  const order = [...fixed, ...res.order];
  const problems = validateRoute(order, T, 0, ok, end);
  if (problems.length) throw new PlanError("Rota inválida: " + problems.join("; ")); // nunca declarar sucesso

  progress?.("geometria", 0);
  const seq = [0, ...order, ...(circular ? [0] : endIdx != null ? [endIdx] : [])];
  const out: PlanResult = {
    status: excluded.length ? "partial" : "complete", feasible: true,
    order: [], excluded, snapReview, features: [], totalTime: 0, travelTime: 0, serviceTime: 0, accessTime: 0, totalDistance: 0,
    byMode: {}, flags: {}, candidates: res.candidates.map(({ order: _o, ...c }) => c), strategy: res.best.strategy,
    timings: {}, warnings, originFlags: origin.snap.flags,
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
    if (b >= 1 && b <= okStops.length && okSet.has(b)) {
      const st = okStops[b - 1], sn = snaps[b];
      out.order.push({ key: st.key, seq: out.order.length + 1, eta: clock, legDistance: leg.distance, legTime: leg.time,
        snapDistance: sn.distance, access: access(b), confidence: sn.confidence, flags: sn.flags });
      clock += service[b];
      out.serviceTime += service[b];
      out.accessTime += access(b);
    }
  }
  out.totalTime = clock;
  // ETA acumulado == avaliação do objetivo (alerta E)
  const ev = evaluate(order, { T, D, start: 0, end, service });
  if (Math.abs(ev.time - clock) > 1 + 1e-3 * clock) throw new PlanError(`Inconsistência interna: ETA ${clock.toFixed(1)} s x ${ev.time.toFixed(1)} s.`);
  for (const [f, m] of Object.entries(out.flags))
    if (["escada", "acesso_privado", "barreira", "portao_privado", "proibido_pedalar", "travessia_de_praca"].includes(f))
      warnings.push(`Trecho sinalizado no percurso: ${f.replace(/_/g, " ")} (${Math.round(m)} m). Verifique no local.`);
  for (const e of excluded) warnings.push(`Parada excluída: ${e.reason}`);
  if (snapReview.length) warnings.push(`${snapReview.length} parada(s) com posição a revisar (distância até a via ou acesso duvidoso).`);
  out.timings = { matrix_ms: Math.round(matrixMs), solve_ms: Math.round(solveMs), total_ms: Math.round(performance.now() - t0) };
  return out;
}
