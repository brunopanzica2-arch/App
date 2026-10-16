/**
 * Efeito sonoro da abertura, SINTETIZADO com Web Audio (nenhum arquivo, nenhuma licença de terceiros, ~0 KB).
 * Cada som é agendado no instante da animação correspondente (tempo em segundos desde o início da página):
 *   0,10 s  crescendo grave + "whoosh" de ar (acompanha a luz passando)      — cena 1
 *   0,70 s  batida grave + acorde brilhante (o título "assenta")             — cena 1
 *   1,00 s  faíscas agudas (brilho nas letras)                               — cena 1
 *   2,00 s  tiques ascendentes (a rota é desenhada)                          — cena 2
 *   3,38 s  "plop" + sino (o pino pousa)                                     — cena 2
 *   3,66 s  campainha suave (o nome do app aparece)                          — cena 2
 * Volume baixo, com compressor (nunca estoura). Usa o volume de MÍDIA do aparelho.
 */
export const SOUND_TIMES = { whoosh: 0.1, hit: 0.7, sparks: 1.0, route: 2.0, pin: 3.38, name: 3.66, end: 4.7 } as const;

type Ctx = BaseAudioContext;

interface Opts {
  /** instante (no relógio do contexto) que corresponde ao início da animação (t = 0) */
  start: number;
  /** ganho geral (0..1) */
  volume?: number;
}

const NOTE = (n: number) => 440 * 2 ** ((n - 69) / 12);
// escala pentatônica maior em Lá (A4=69): A C# E F# ... dá sensação de "avanço" sem ser melodia chata
const PENTA = [69, 71, 73, 76, 78, 81, 83, 85, 88, 90];

function tone(c: Ctx, out: AudioNode, t: number, o: { type?: OscillatorType; f0: number; f1?: number; dur: number; gain: number; attack?: number; curve?: "exp" | "lin" }) {
  if (t + o.dur < c.currentTime) return; // já passou (ex.: o app abriu depois da animação começar)
  const osc = c.createOscillator(), g = c.createGain();
  osc.type = o.type ?? "sine";
  const t0 = Math.max(t, c.currentTime);
  osc.frequency.setValueAtTime(o.f0, t0);
  if (o.f1) osc.frequency.exponentialRampToValueAtTime(o.f1, t0 + o.dur);
  const a = o.attack ?? 0.01;
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.linearRampToValueAtTime(o.gain, t0 + a);
  if (o.curve === "lin") g.gain.linearRampToValueAtTime(0.0001, t0 + o.dur);
  else g.gain.exponentialRampToValueAtTime(0.0001, t0 + o.dur);
  osc.connect(g).connect(out);
  osc.start(t0);
  osc.stop(t0 + o.dur + 0.05);
}

function whoosh(c: Ctx, out: AudioNode, t: number, dur: number, gain: number) {
  if (t + dur < c.currentTime) return;
  const t0 = Math.max(t, c.currentTime);
  const len = Math.ceil(c.sampleRate * dur);
  const buf = c.createBuffer(1, len, c.sampleRate);
  const d = buf.getChannelData(0);
  let seed = 1234567; // ruído determinístico (mesmo som sempre; testável)
  for (let i = 0; i < len; i++) { seed = (seed * 1664525 + 1013904223) >>> 0; d[i] = (seed / 4294967296) * 2 - 1; }
  const src = c.createBufferSource(); src.buffer = buf;
  const f = c.createBiquadFilter(); f.type = "bandpass"; f.Q.value = 1.4;
  f.frequency.setValueAtTime(300, t0);
  f.frequency.exponentialRampToValueAtTime(3200, t0 + dur * 0.75);
  f.frequency.exponentialRampToValueAtTime(1200, t0 + dur);
  const g = c.createGain();
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.linearRampToValueAtTime(gain, t0 + dur * 0.5);
  g.gain.linearRampToValueAtTime(0.0001, t0 + dur);
  src.connect(f).connect(g).connect(out);
  src.start(t0);
}

/** Agenda TODO o som no contexto. Devolve o nó mestre (para desvanecer ao pular) e o instante final. */
export function scheduleIntroSound(c: Ctx, o: Opts): { master: GainNode; end: number } {
  const T = (s: number) => o.start + s;
  const master = c.createGain();
  master.gain.value = o.volume ?? 0.55;
  const comp = c.createDynamicsCompressor();
  comp.threshold.value = -18; comp.ratio.value = 6; comp.attack.value = 0.003; comp.release.value = 0.2;
  master.connect(comp).connect(c.destination);

  // ---- cena 1: o estúdio ----
  tone(c, master, T(SOUND_TIMES.whoosh), { type: "sine", f0: 48, f1: 96, dur: 1.5, gain: 0.55, attack: 0.9, curve: "lin" });          // crescendo grave
  whoosh(c, master, T(SOUND_TIMES.whoosh), 1.5, 0.22);                                                                              // ar passando
  tone(c, master, T(SOUND_TIMES.hit), { type: "sine", f0: 150, f1: 42, dur: 0.55, gain: 0.9, attack: 0.004 });                       // batida
  for (const [i, f] of [220, 330, 440, 659].entries())                                                                              // acorde brilhante A–E–A–E
    tone(c, master, T(SOUND_TIMES.hit + 0.02 * i), { type: "sine", f0: f, dur: 2.2, gain: 0.11 - i * 0.012, attack: 0.04 });
  for (const [i, f] of [2093, 2637, 3136, 3951, 3136].entries())                                                                    // faíscas
    tone(c, master, T(SOUND_TIMES.sparks + i * 0.11), { type: "triangle", f0: f, dur: 0.22, gain: 0.05, attack: 0.002 });

  // ---- cena 2: a rota até o pino ----
  for (let i = 0; i < PENTA.length; i++) {                                                                                          // tiques ascendentes
    const f = NOTE(PENTA[i]);
    tone(c, master, T(SOUND_TIMES.route + i * 0.13), { type: "triangle", f0: f, dur: 0.16, gain: 0.11 + i * 0.005, attack: 0.002 });
  }
  tone(c, master, T(SOUND_TIMES.pin), { type: "sine", f0: 260, f1: 90, dur: 0.18, gain: 0.8, attack: 0.003 });                        // plop do pino
  tone(c, master, T(SOUND_TIMES.pin + 0.04), { type: "sine", f0: 880, dur: 1.3, gain: 0.12, attack: 0.005 });                         // sino
  tone(c, master, T(SOUND_TIMES.pin + 0.04), { type: "sine", f0: 1320, dur: 1.0, gain: 0.07, attack: 0.005 });
  tone(c, master, T(SOUND_TIMES.name), { type: "sine", f0: 1760, dur: 0.9, gain: 0.05, attack: 0.01 });                               // campainha do nome
  return { master, end: T(SOUND_TIMES.end) };
}

export interface IntroSoundHandle { stop(fadeMs?: number): void }

/** Cria o AudioContext e toca. `elapsedMs` = quanto da animação já passou quando o som é iniciado. Devolve null se o aparelho não tem áudio. */
export function playIntroSound(elapsedMs = 0, volume?: number): IntroSoundHandle | null {
  try {
    const AC: typeof AudioContext | undefined = (window as unknown as { AudioContext?: typeof AudioContext; webkitAudioContext?: typeof AudioContext }).AudioContext
      ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AC) return null;
    const ctx = new AC();
    void ctx.resume?.().catch(() => { /* sem gesto do usuário (navegador): fica mudo, sem erro */ });
    const { master, end } = scheduleIntroSound(ctx, { start: ctx.currentTime - elapsedMs / 1000, volume });
    const closeAt = Math.max(0, (end - ctx.currentTime) * 1000 + 600);
    const closer = setTimeout(() => void ctx.close().catch(() => {}), closeAt);
    return {
      stop(fadeMs = 180) {
        try {
          clearTimeout(closer);
          master.gain.cancelScheduledValues(ctx.currentTime);
          master.gain.setValueAtTime(master.gain.value, ctx.currentTime);
          master.gain.linearRampToValueAtTime(0.0001, ctx.currentTime + fadeMs / 1000);
          setTimeout(() => void ctx.close().catch(() => {}), fadeMs + 80);
        } catch { /* já fechado */ }
      },
    };
  } catch { return null; }
}
