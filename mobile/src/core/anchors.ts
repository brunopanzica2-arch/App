/**
 * Posição ESTIMADA pela numeração, a partir de "âncoras" (endereços da MESMA rua com número e posição confiáveis:
 * número localizado pelo provedor, porta confirmada pelo entregador, coordenada importada).
 * O OpenStreetMap tem poucos números de casa em Santos; quando o provedor só acha a rua, dois números conhecidos que
 * "cercam" o número procurado permitem estimar onde ele fica (interpolação linear entre as âncoras).
 * Honestidade: o resultado é "interpolated", sempre com aviso "estimado entre os nºs X e Y", nunca "exato" e nunca porta confirmada.
 */
import { db, type Address } from "./db";
import { normText } from "./normalize";
import { haversine } from "./rank";

export interface Anchor { number: number; lat: number; lon: number }
export interface Estimate { lat: number; lon: number; between: [number, number]; spanM: number; sameParity: boolean }

const numOf = (n: string | null | undefined): number | null => { const m = /^(\d{1,6})/.exec((n ?? "").trim()); return m ? parseInt(m[1], 10) : null; };

/** Interpola entre a âncora mais próxima abaixo e a mais próxima acima do número alvo. null = sem âncoras que cerquem com segurança. */
export function estimateByNumber(target: number, anchors: Anchor[], opts: { maxSpanM?: number; maxNumberGap?: number } = {}): Estimate | null {
  const maxSpan = opts.maxSpanM ?? 450, maxGap = opts.maxNumberGap ?? 400;
  const uniq = new Map<number, Anchor>();
  for (const a of anchors) if (!uniq.has(a.number)) uniq.set(a.number, a);
  const list = [...uniq.values()];
  if (list.some((a) => a.number === target)) return null; // já existe uma âncora com este número: não estima
  const best = (pool: Anchor[]): Estimate | null => {
    const lows = pool.filter((a) => a.number < target).sort((a, b) => b.number - a.number);
    const highs = pool.filter((a) => a.number > target).sort((a, b) => a.number - b.number);
    let out: Estimate | null = null;
    for (const lo of lows.slice(0, 3)) for (const hi of highs.slice(0, 3)) {
      const span = haversine(lo, hi);
      if (span > maxSpan || hi.number - lo.number > maxGap) continue;
      const gap = hi.number - lo.number;
      if (!out || gap < out.between[1] - out.between[0]) {
        const t = (target - lo.number) / gap;
        out = { lat: lo.lat + (hi.lat - lo.lat) * t, lon: lo.lon + (hi.lon - lo.lon) * t, between: [lo.number, hi.number], spanM: Math.round(span), sameParity: true };
      }
    }
    return out;
  };
  // prefere âncoras do mesmo lado da rua (mesma paridade); se não houver par, aceita os dois lados e avisa
  const sameSide = best(list.filter((a) => a.number % 2 === target % 2));
  if (sameSide) return sameSide;
  const any = best(list);
  return any ? { ...any, sameParity: false } : null;
}

const streetId = (a: Pick<Address, "street" | "city">) => `${normText(a.street)}|${normText(a.city)}`;
const GOOD: Address["precision"][] = ["exact", "manual", "test"];

/** Endereços que podem servir de âncora: número localizado/confirmado e coordenadas. */
const posOf = (a: Address) => (a.entrance ? { lat: a.entrance.lat, lon: a.entrance.lon } : a.lat != null && a.lon != null ? { lat: a.lat, lon: a.lon } : null);
export function isAnchor(a: Address): boolean {
  return posOf(a) != null && numOf(a.number) != null && (GOOD.includes(a.precision) || !!a.confirmedAt) && !!a.street;
}
/** Endereços que podem receber estimativa: nunca sobrescreve porta confirmada, número exato, coordenada manual ou de teste. */
export function isEstimable(a: Address): boolean {
  return numOf(a.number) != null && !a.confirmedAt && !a.entrance && !GOOD.includes(a.precision) && a.precision !== "interpolated";
}

/** Aplica estimativas a todos os endereços do lote que só têm a rua (ou nada). Devolve quantos foram refinados. */
export async function refineByAnchors(keys?: string[]): Promise<{ refined: number; keys: string[] }> {
  const all = await db.addresses.toArray();
  const byStreet = new Map<string, Anchor[]>();
  for (const a of all) if (isAnchor(a)) { const p = posOf(a)!; (byStreet.get(streetId(a)) ?? byStreet.set(streetId(a), []).get(streetId(a))!).push({ number: numOf(a.number)!, lat: p.lat, lon: p.lon }); }
  const want = keys ? new Set(keys) : null;
  const done: string[] = [];
  for (const a of all) {
    if (want && !want.has(a.key)) continue;
    if (!isEstimable(a)) continue;
    const anchors = byStreet.get(streetId(a));
    if (!anchors?.length) continue;
    const e = estimateByNumber(numOf(a.number)!, anchors);
    if (!e) continue;
    const [lo, hi] = e.between;
    await db.addresses.update(a.key, {
      lat: e.lat, lon: e.lon, precision: "interpolated", confidence: e.sameParity ? 0.55 : 0.45, needsReview: true,
      source: `estimado|nºs ${lo}–${hi}|${e.spanM} m`,
      reason: `Posição ESTIMADA pela numeração entre os nºs ${lo} e ${hi} desta rua (${e.spanM} m)${e.sameParity ? "" : ", lados opostos"}; confirme na porta.`,
    });
    done.push(a.key);
  }
  return { refined: done.length, keys: done };
}
