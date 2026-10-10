/**
 * Converte o resultado do planejamento (trechos por aresta da malha de pedestres) em geometria contínua + manobras + paradas
 * para o motor de navegação nativo. Tudo determinístico a partir da geometria e dos nomes das vias do OSM;
 * nenhum modelo generativo decide ruas ou manobras.
 */
import type { PlanResult } from "./plan";

export interface NavManeuver { kind: string; street: string; lat: number; lon: number; at: number }
export interface NavStop { key: string; seq: number; lat: number; lon: number; at: number; street: string; number: string; letters: number; precision: string }
export interface NavRoute { lat: number[]; lon: number[]; maneuvers: NavManeuver[]; stops: NavStop[]; length: number }
export interface StopMeta { street: string; number: string; letters: number; precision: string }

const R = 6371008.8;
const rad = (d: number) => (d * Math.PI) / 180;
export function dist(a: [number, number], b: [number, number]): number {
  const dLat = rad(b[0] - a[0]), dLon = rad(b[1] - a[1]);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a[0])) * Math.cos(rad(b[0])) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}
export function bearing(a: [number, number], b: [number, number]): number {
  const y = Math.sin(rad(b[1] - a[1])) * Math.cos(rad(b[0]));
  const x = Math.cos(rad(a[0])) * Math.sin(rad(b[0])) - Math.sin(rad(a[0])) * Math.cos(rad(b[0])) * Math.cos(rad(b[1] - a[1]));
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}
/** ângulo de giro em (-180,180]; positivo = direita */
export function turnAngle(from: number, to: number): number {
  let d = (to - from + 540) % 360 - 180;
  if (d === -180) d = 180;
  return d;
}

export function classify(angle: number): string | null {
  const a = Math.abs(angle), right = angle > 0;
  if (a < 25) return null;
  if (a < 45) return right ? "slight_right" : "slight_left";
  if (a < 135) return right ? "right" : "left";
  if (a < 165) return right ? "sharp_right" : "sharp_left";
  return "uturn";
}

/** Direção média de um lado do vértice, olhando até `span` metros para trás/frente (reduz ruído de nós OSM muito próximos). */
function sideBearing(pts: [number, number][], cum: number[], k: number, dir: -1 | 1, span = 18): number {
  let j = k;
  while (j + dir >= 0 && j + dir < pts.length && Math.abs(cum[j + dir] - cum[k]) < span) j += dir;
  if (j === k && k + dir >= 0 && k + dir < pts.length) j = k + dir;
  return dir < 0 ? bearing(pts[j], pts[k]) : bearing(pts[k], pts[j]);
}

export function buildNavRoute(plan: Pick<PlanResult, "features" | "order">, start: { lat: number; lon: number }, meta: Map<string, StopMeta>): NavRoute {
  const pts: [number, number][] = [[start.lat, start.lon]];
  const segStreet: string[] = [];
  const legEnd = new Map<number, number>(); // leg → índice do último ponto
  for (const f of plan.features) {
    const c = f.geometry.coordinates;
    for (let i = 0; i < c.length - 1; i++) {
      const b: [number, number] = [c[i + 1][1], c[i + 1][0]];
      const a = pts[pts.length - 1];
      // junção entre trechos: pula o ponto repetido; primeiro ponto do trecho pode não coincidir com o último (snap) → liga reto
      if (i === 0 && dist(a, [c[0][1], c[0][0]]) > 0.5) { pts.push([c[0][1], c[0][0]]); segStreet.push(f.properties.segStreets?.[0] ?? f.properties.streets[0] ?? ""); }
      if (dist(pts[pts.length - 1], b) < 0.3) continue;
      pts.push(b);
      segStreet.push(f.properties.segStreets?.[i] ?? f.properties.streets[0] ?? "");
    }
    if (f.properties.leg != null) legEnd.set(f.properties.leg, pts.length - 1);
  }
  const cum = [0];
  for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + dist(pts[i - 1], pts[i]));

  const maneuvers: NavManeuver[] = [{ kind: "depart", street: segStreet[0] ?? "", lat: pts[0][0], lon: pts[0][1], at: 0 }];
  for (let k = 1; k < pts.length - 1; k++) {
    const turn = turnAngle(sideBearing(pts, cum, k, -1), sideBearing(pts, cum, k, 1));
    const kind = classify(turn);
    const before = segStreet[k - 1] ?? "", after = segStreet[k] ?? "";
    const renamed = !!after && !!before && after !== before;
    let m: NavManeuver | null = null;
    if (kind) m = { kind, street: after, lat: pts[k][0], lon: pts[k][1], at: cum[k] };
    else if (renamed && Math.abs(turn) >= 10) m = { kind: "straight", street: after, lat: pts[k][0], lon: pts[k][1], at: cum[k] };
    if (!m) continue;
    const last = maneuvers[maneuvers.length - 1];
    if (last.kind !== "depart" && m.at - last.at < 12) { // curvas encadeadas: mantém a mais forte
      if (m.kind !== "straight" && (last.kind === "straight" || Math.abs(turn) > 60)) maneuvers[maneuvers.length - 1] = m;
      continue;
    }
    maneuvers.push(m);
  }

  const stops: NavStop[] = plan.order.map((o, idx) => {
    const k = legEnd.get(idx + 1) ?? pts.length - 1;
    const mt = meta.get(o.key) ?? { street: "", number: "", letters: 1, precision: "street" };
    return { key: o.key, seq: o.seq, lat: pts[k][0], lon: pts[k][1], at: cum[k], street: mt.street, number: mt.number, letters: mt.letters, precision: mt.precision };
  });
  return { lat: pts.map((p) => p[0]), lon: pts.map((p) => p[1]), maneuvers, stops, length: cum[cum.length - 1] };
}
