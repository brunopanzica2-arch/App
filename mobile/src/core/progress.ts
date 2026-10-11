/** DeliveryProgressService + GameFeedbackService. Recompensa sempre secundária à navegação: texto curto, sem exagero. */
import type { DayStats } from "./db";
import { getSettings, saveSettings } from "./service";

const XP_PER_LETTER = 10;
const STREAK_BONUS = 5; // a partir da 3ª entrega seguida sem falha

const today = () => new Date().toISOString().slice(0, 10);
const blank = (): DayStats => ({ date: today(), delivered: 0, notDelivered: 0, skipped: 0, streak: 0, bestStreak: 0, xp: 0, startedAt: Date.now(), lastAt: Date.now(), activeMs: 0 });

export async function getDayStats(): Promise<DayStats> {
  const s = (await getSettings()).dayStats;
  return s && s.date === today() ? s : blank();
}

export interface Reward { title: string; subtitle: string; xp: number; streak: number; remainingLetters: number; remainingStops: number }

const TITLES = ["Muito bem!", "Entrega concluída!", "Boa! Mais uma parada resolvida.", "Perfeito! Você está avançando rápido."];

/** Pura: dado o estado do dia e o resultado, devolve o novo estado e a recompensa a exibir. */
export function applyOutcome(prev: DayStats, kind: "delivered" | "not_delivered" | "skipped", letters: number, ctx: { remainingLetters: number; remainingStops: number; stopIndex: number; stopTotal: number }, now = Date.now()): { stats: DayStats; reward: Reward | null } {
  const gap = now - prev.lastAt;
  const s: DayStats = { ...prev, lastAt: now, activeMs: prev.activeMs + (gap > 0 && gap < 10 * 60_000 ? gap : 0) };
  if (kind !== "delivered") {
    if (kind === "not_delivered") s.notDelivered += letters; else s.skipped += letters;
    s.streak = 0; // falha ou pulo interrompe a sequência
    return { stats: s, reward: null };
  }
  s.delivered += letters;
  s.streak += 1;
  s.bestStreak = Math.max(s.bestStreak, s.streak);
  const xp = letters * XP_PER_LETTER + (s.streak >= 3 ? STREAK_BONUS : 0);
  s.xp += xp;
  const title = TITLES[(s.delivered - 1 + TITLES.length) % TITLES.length];
  const bits = [ctx.remainingLetters > 0 ? `Restam ${ctx.remainingLetters} ${ctx.remainingLetters === 1 ? "carta" : "cartas"}` : "Última carta desta rota", `Parada ${ctx.stopIndex} de ${ctx.stopTotal}`];
  return { stats: s, reward: { title, subtitle: bits.join(" · "), xp, streak: s.streak, remainingLetters: ctx.remainingLetters, remainingStops: ctx.remainingStops } };
}

export async function recordOutcome(kind: "delivered" | "not_delivered" | "skipped", letters: number, ctx: Parameters<typeof applyOutcome>[3]): Promise<Reward | null> {
  const { stats, reward } = applyOutcome(await getDayStats(), kind, letters, ctx);
  await saveSettings({ dayStats: stats });
  return reward;
}

/** Desfazer: remove o efeito (sem punir: só devolve entregas/XP e zera a sequência, que não é reconstruível). */
export async function revertOutcome(kind: "delivered" | "not_delivered" | "skipped", letters: number) {
  const s = { ...(await getDayStats()) };
  if (kind === "delivered") { s.delivered = Math.max(0, s.delivered - letters); s.xp = Math.max(0, s.xp - letters * XP_PER_LETTER); }
  else if (kind === "not_delivered") s.notDelivered = Math.max(0, s.notDelivered - letters);
  else s.skipped = Math.max(0, s.skipped - letters);
  s.streak = 0;
  await saveSettings({ dayStats: s });
}

export function levelOf(xp: number): { level: number; into: number; need: number } {
  let level = 1, need = 100, left = xp;
  while (left >= need) { left -= need; level++; need = Math.round(need * 1.35); }
  return { level, into: left, need };
}

/** Som curto opcional (WebAudio): nunca depende de arquivo; silencioso se o navegador bloquear. */
export function chime() {
  try {
    const AC = (window as any).AudioContext || (window as any).webkitAudioContext;
    const c = new AC();
    const o = c.createOscillator(), g = c.createGain();
    o.type = "sine"; o.frequency.value = 660;
    o.frequency.exponentialRampToValueAtTime(990, c.currentTime + 0.12);
    g.gain.setValueAtTime(0.0001, c.currentTime); g.gain.exponentialRampToValueAtTime(0.12, c.currentTime + 0.02); g.gain.exponentialRampToValueAtTime(0.0001, c.currentTime + 0.22);
    o.connect(g); g.connect(c.destination); o.start(); o.stop(c.currentTime + 0.24);
    setTimeout(() => c.close(), 400);
  } catch { /* sem som */ }
}
