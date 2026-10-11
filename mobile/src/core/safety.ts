/**
 * Guarda de segurança antes de iniciar a navegação. "Rota revisada" só quando os critérios REALMENTE são satisfeitos:
 *  - nenhum metro em trilha/caminho não urbano nem em trecho sem dados confiáveis;
 *  - nenhum destino aproximado (só a rua / interpolado / posição de TESTE).
 * Nunca afirma verificação independente: "confirmado" = confirmado pelo usuário ou número localizado na fonte.
 */
import type { RouteQuality } from "./plan";

export type Level = "reviewed" | "unverified" | "approximate" | "both";
export interface Guard { level: Level; label: string; reasons: string[]; needsConfirm: boolean }

export function assessRoute(quality: RouteQuality | undefined, stops: { approximate: boolean; code: string }[]): Guard {
  const reasons: string[] = [];
  const unverified = !!quality && !quality.reviewed;
  if (unverified) reasons.push(...quality!.reasons);
  const approx = stops.filter((s) => s.approximate || s.code === "street" || s.code === "interpolated" || s.code === "test" || s.code === "unlocated").length;
  if (approx > 0) reasons.push(`${approx} destino(s) com posição aproximada (número não confirmado no local)`);
  if (!quality) reasons.push("qualidade do trajeto não calculada nesta rota (recalcule)");
  const level: Level = unverified && approx > 0 ? "both" : unverified ? "unverified" : approx > 0 || !quality ? "approximate" : "reviewed";
  const label = level === "reviewed" ? "Rota revisada" : unverified ? "Trechos não verificados — revisar antes de seguir" : "Destinos aproximados — confirme no local";
  return { level, label, reasons, needsConfirm: level !== "reviewed" };
}
