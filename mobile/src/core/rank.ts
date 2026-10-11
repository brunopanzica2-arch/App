/** Pontuação de candidatos do geocodificador: Santos/SP primeiro, depois bairro/CEP, e a proximidade do usuário como desempate. Pura e testável. */
import type { Candidate } from "./db";
import { normText } from "./normalize";

/** Caixa envolvente aproximada do município de Santos (ilha + continente), usada só como viés/validação. */
export const SANTOS_BBOX = { south: -24.03, north: -23.80, west: -46.46, east: -46.25 };
export const SANTOS_VIEWBOX = `${SANTOS_BBOX.west},${SANTOS_BBOX.north},${SANTOS_BBOX.east},${SANTOS_BBOX.south}`; // left,top,right,bottom

export const inSantosBox = (lat: number, lon: number) => lat >= SANTOS_BBOX.south && lat <= SANTOS_BBOX.north && lon >= SANTOS_BBOX.west && lon <= SANTOS_BBOX.east;

export function haversine(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
  const R = 6371008.8, r = Math.PI / 180;
  const dLat = (b.lat - a.lat) * r, dLon = (b.lon - a.lon) * r;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

export interface RankCtx {
  city: string; neighborhood?: string | null; cep?: string | null; user?: { lat: number; lon: number } | null;
}
export interface Ranked { c: Candidate; score: number; why: string[] }

export function scoreCandidate(c: Candidate, ctx: RankCtx): Ranked {
  const why: string[] = [];
  let score = c.confidence;
  if (c.city) {
    if (normText(c.city) === normText(ctx.city)) { score += 0.25; why.push("município coincide"); } else { score -= 0.5; why.push(`município diferente (${c.city})`); }
  }
  if (inSantosBox(c.lat, c.lon)) { score += 0.15; why.push("dentro de Santos"); } else { score -= 0.3; why.push("fora do recorte de Santos"); }
  if (ctx.neighborhood && normText(c.label).includes(normText(ctx.neighborhood))) { score += 0.1; why.push("bairro coincide"); }
  if (ctx.cep && c.postcode && c.postcode.replace(/\D/g, "") === ctx.cep.replace(/\D/g, "")) { score += 0.1; why.push("CEP coincide"); }
  if (ctx.user) {
    const d = haversine(ctx.user, c);
    const bonus = 0.2 * Math.exp(-d / 3000);
    score += bonus;
    if (bonus > 0.05) why.push(`a ${d < 1000 ? Math.round(d) + " m" : (d / 1000).toFixed(1) + " km"} de você`);
  }
  return { c, score, why };
}

export interface Pick { best: Ranked; ranked: Ranked[]; ambiguous: boolean; alternative: Ranked | null; reason: string | null }

/** Escolhe o melhor candidato. `ambiguous` só quando há duas posições plausíveis distintas e a diferença de pontuação é pequena. */
export function pickBest(cands: Candidate[], ctx: RankCtx, isGood: (c: Candidate) => boolean = (c) => ["exact", "interpolated"].includes(c.precision)): Pick | null {
  if (!cands.length) return null;
  const ranked = cands.map((c) => scoreCandidate(c, ctx)).sort((a, b) => b.score - a.score);
  const best = ranked[0];
  const alt = ranked.slice(1).find((r) => isGood(r.c) && haversine(r.c, best.c) > 150) ?? null;
  const ambiguous = !!alt && isGood(best.c) && best.score - alt.score < 0.15;
  const reason = ambiguous ? `Dois pontos plausíveis em Santos (${Math.round(haversine(alt!.c, best.c))} m de distância); confirme a posição.` : null;
  return { best, ranked, ambiguous, alternative: alt, reason };
}
