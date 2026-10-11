/**
 * NavigationSessionService + RouteOverlayController (parte pura).
 * UMA função decide, a partir dos dados reais, em que fase o app está e o que o mapa pode desenhar. Assim o estado visual
 * (rota, marcadores, CTA) nunca diverge do estado lógico (rota concluída/encerrada continuava no mapa na 2.0.1).
 */
import { db } from "./db";
import { getSettings, journalNav, saveSettings } from "./service";

export type Phase = "empty" | "unplanned" | "planned" | "navigating" | "paused" | "ended" | "completed";

export interface ViewInput {
  letters: number;
  /** cartas ainda não tratadas (pendentes/em rota/adiadas contam como pendentes do dia) */
  pendingLetters: number;
  routeId: string | null;
  /** paradas da rota ativa com cartas pendentes ou parciais */
  openStops: number;
  navActive: boolean;
  paused: boolean;
  endedRouteId: string | null;
}

export interface View {
  phase: Phase;
  /** desenhar a polilinha da rota, o marcador de início e a numeração das paradas */
  showRoute: boolean;
  /** desenhar pinos simples das paradas (lote sem rota) */
  showStopPins: boolean;
  canStart: boolean;
  canResume: boolean;
  canPlan: boolean;
  /** câmera de navegação e instruções só existem nestas fases */
  navUi: boolean;
}

export function deriveView(i: ViewInput): View {
  let phase: Phase;
  if (i.letters === 0) phase = "empty";
  else if (!i.routeId) phase = i.pendingLetters === 0 ? "completed" : "unplanned";
  else if (i.openStops === 0) phase = "completed";
  else if (i.navActive) phase = i.paused ? "paused" : "navigating";
  else if (i.endedRouteId === i.routeId) phase = "ended";
  else phase = "planned";
  const live = phase === "planned" || phase === "navigating" || phase === "paused";
  return {
    phase,
    showRoute: live,
    showStopPins: phase === "unplanned",
    canStart: phase === "planned",
    canResume: phase === "ended",
    canPlan: phase === "unplanned" || phase === "ended",
    navUi: phase === "navigating" || phase === "paused",
  };
}

/** Encerrar manualmente: some a rota do mapa, mas não apaga nada (cartas e rota continuam; dá para retomar). */
export async function endSession(routeId: string) {
  await saveSettings({ endedRouteId: routeId });
  await journalNav(null);
}

export async function resumeSession() {
  await saveSettings({ endedRouteId: null });
}

/** Concluir: marca a rota como finalizada; o mapa volta ao estado padrão. Cartas pendentes fora da rota permanecem no lote. */
export async function finishRoute(routeId: string) {
  await db.routes.update(routeId, { status: "finished" });
  await saveSettings({ endedRouteId: null });
  await journalNav(null);
}

export async function getEnded(): Promise<string | null> {
  return (await getSettings()).endedRouteId ?? null;
}
