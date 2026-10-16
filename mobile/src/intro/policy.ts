/**
 * Política da abertura (pura e testável). Sem React, sem DOM além do Storage injetado.
 *  - "full"  : cena 1 (cartão do estúdio) + cena 2 (rota até o pino) — TODA vez que o app abre (a partir da 2.8).
 *  - "short" : (legado, não é mais escolhido) só a cena 2 encurtada.
 *  - "none"  : direto para o app — "Pular abertura" ligado nas opções.
 *  - "reduced": cartão estático com fade curto (~800 ms), sem movimento na rota — prefers-reduced-motion.
 * Tocar na tela pula a abertura a qualquer momento (tratado no componente).
 */
export type IntroMode = "full" | "short" | "none" | "reduced";

export const KEY_SKIP = "rota.intro.skip";
export const KEY_LAST = "rota.intro.last";
export const KEY_SOUND = "rota.intro.sound";

export interface Store { getItem(k: string): string | null; setItem(k: string, v: string): void }

export const localDay = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

function read(s: Store | null, k: string): string | null { try { return s?.getItem(k) ?? null; } catch { return null; } }
function write(s: Store | null, k: string, v: string) { try { s?.setItem(k, v); } catch { /* armazenamento indisponível: a abertura completa volta a tocar */ } }

export function decideIntro(o: { store: Store | null; reducedMotion: boolean; now?: Date }): IntroMode {
  if (read(o.store, KEY_SKIP) === "1") return "none";
  if (o.reducedMotion) return "reduced";
  return "full"; // sempre: o usuário pediu a animação em toda abertura; "Pular abertura" (Ajustes) e o toque na tela continuam valendo
}

/** Marca a abertura do dia como já exibida (chamar quando a abertura COMEÇA, para um fechamento no meio não repetir a completa). */
export function markShown(store: Store | null, now?: Date) { write(store, KEY_LAST, localDay(now)); }

export const introSkip = (s: Store | null) => read(s, KEY_SKIP) === "1";
export const setIntroSkip = (s: Store | null, v: boolean) => write(s, KEY_SKIP, v ? "1" : "0");
/** Som da abertura: LIGADO por padrão (a 2.8 em diante); só desliga se o usuário desligar em Ajustes. */
export const introSound = (s: Store | null) => read(s, KEY_SOUND) !== "0";
export const setIntroSound = (s: Store | null, v: boolean) => write(s, KEY_SOUND, v ? "1" : "0");

/** Durações (ms) de cada modo. O app só espera além disto se os dados ainda não chegaram (aí entra o skeleton, nunca congela no pino). */
export const TIMING = {
  fadeIn: 600, hold: 900, fadeOut: 500,         // cena 1 = 2000 ms
  route: 2300,                                   // cena 2 completa (rota 1400 ms + pino, ondas e nome)
  routeShort: 700,                               // cena 2 encurtada (demais aberturas do dia)
  waitCap: 2500,                                 // espera máxima pelos dados depois da cena 2
  handoff: 320,
  reduced: 800,
} as const;
