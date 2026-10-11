import { useCallback, useEffect, useRef, useState } from "react";
import "./abertura.css";
import { dataReady } from "./ready";
import { decideIntro, introSound, type IntroMode, markShown, type Store, TIMING } from "./policy";

export type Phase = "s1-in" | "s1-hold" | "s1-out" | "s2" | "wait" | "handoff" | "done";

interface Props {
  /** armazenamento injetável (testes); padrão localStorage */
  store?: Store | null;
  reducedMotion?: boolean;
  now?: Date;
  onDone?: () => void;
  /** nome do app (cena 2) */
  appName?: string;
}

const defaultStore = (): Store | null => { try { return window.localStorage; } catch { return null; } };
const prefersReduced = () => typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

/** Som curto e discreto (sintetizado: sem arquivo). Só com a opção ligada; o navegador pode bloquear sem gesto do usuário. */
function chime() {
  try {
    const AC = window.AudioContext ?? (window as any).webkitAudioContext;
    if (!AC) return;
    const ctx = new AC();
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, ctx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.04, ctx.currentTime + 0.35); // volume baixo
    g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 1.6);
    g.connect(ctx.destination);
    for (const [f, t] of [[110, 0], [165, 0.25]] as const) {
      const o = ctx.createOscillator(); o.type = "sine"; o.frequency.value = f; o.connect(g); o.start(ctx.currentTime + t); o.stop(ctx.currentTime + 1.7);
    }
    setTimeout(() => void ctx.close().catch(() => {}), 2000);
  } catch { /* sem áudio: segue em silêncio */ }
}

/** Ruas decorativas e a rota (um traçado com curvas de 90°, como quarteirões) até o pino. Coordenadas em viewBox 360×640. */
const STREETS = "M0 470H360 M0 300H360 M0 140H360 M70 0V640 M190 0V640 M300 0V640";
const ROUTE = "M70 600V470Q70 450 90 450H170Q190 450 190 430V320Q190 300 210 300H280Q300 300 300 280V176";

const leaveEnter = () => { document.documentElement.classList.add("rota-enter"); setTimeout(() => document.documentElement.classList.remove("rota-enter"), 600); };

export function Abertura({ store, reducedMotion, now, onDone, appName = "Rota Santos" }: Props) {
  const st = store === undefined ? defaultStore() : store;
  const [mode] = useState<IntroMode>(() => decideIntro({ store: st, reducedMotion: reducedMotion ?? prefersReduced(), now }));
  const [phase, setPhase] = useState<Phase>(mode === "none" ? "done" : mode === "short" ? "s2" : "s1-in");
  const [live, setLive] = useState(mode === "none" ? "" : "Carregando rota");
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);
  const finished = useRef(false);
  const doneCb = useRef(onDone);
  doneCb.current = onDone;

  const clear = () => { timers.current.forEach(clearTimeout); timers.current = []; };
  const later = (ms: number, fn: () => void) => { timers.current.push(setTimeout(fn, ms)); };

  const finish = useCallback(() => {
    if (finished.current) return; // idempotente: pular + fim natural não duplicam
    finished.current = true;
    clear();
    setPhase("done");
    setLive(dataReady() ? "Pronto" : "Carregando dados");
    leaveEnter();
    requestAnimationFrame(() => { (document.getElementById("main-content") ?? document.querySelector<HTMLElement>("[data-main]"))?.focus?.({ preventScroll: true }); });
    doneCb.current?.();
  }, []);

  const handoff = useCallback(() => {
    if (finished.current) return;
    clear();
    setPhase("handoff");
    later(TIMING.handoff, finish);
  }, [finish]);

  const skip = useCallback(() => { if (!finished.current) handoff(); }, [handoff]);

  useEffect(() => {
    if (mode === "none") { finished.current = true; leaveEnter(); doneCb.current?.(); return; }
    markShown(st, now);
    const afterS2 = () => {
      if (dataReady()) return handoff();
      setPhase("wait"); // dados ainda não chegaram: mantém o fundo do app (nunca congela no pino); o skeleton aparece por baixo
      const h = () => handoff();
      window.addEventListener("rota:data-ready", h, { once: true });
      later(TIMING.waitCap, () => { window.removeEventListener("rota:data-ready", h); handoff(); });
    };
    if (mode === "reduced") {
      // cartão estático com fade curto (~800 ms no total), sem movimento
      later(250, () => setPhase("s1-hold"));
      later(550, () => setPhase("s1-out"));
      later(TIMING.reduced, handoff);
    } else if (mode === "short") {
      later(TIMING.routeShort, afterS2);
    } else {
      if (introSound(st)) chime();
      later(TIMING.fadeIn, () => setPhase("s1-hold"));
      later(TIMING.fadeIn + TIMING.hold, () => setPhase("s1-out"));
      later(TIMING.fadeIn + TIMING.hold + TIMING.fadeOut, () => setPhase("s2"));
      later(TIMING.fadeIn + TIMING.hold + TIMING.fadeOut + TIMING.route, afterS2);
    }
    return clear;
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // a transição só começa depois de pintar o estado inicial (senão o navegador já nasce no estado final)
  const [armed, setArmed] = useState(false);
  useEffect(() => { const id = requestAnimationFrame(() => requestAnimationFrame(() => setArmed(true))); return () => cancelAnimationFrame(id); }, []);

  useEffect(() => {
    const k = (e: KeyboardEvent) => { if (e.key === "Escape" || e.key === "Enter" || e.key === " ") skip(); };
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [skip]);

  if (phase === "done") return <div className="ab-sr" role="status" aria-live="polite">{live}</div>;
  const [first, ...rest] = appName.split(" ");
  return (
    <div className="ab" data-testid="abertura" data-mode={mode} data-phase={armed ? phase : "pre"} onPointerDown={skip}>
      <div className="ab-sr" role="status" aria-live="polite">{live}</div>
      <div className="ab-s1" aria-hidden="true">
        <div className="ab-title">
          <span style={{ display: "block" }}>PANZICA</span> <span style={{ display: "block" }}>PRODUCTIONS</span>
          <span className="ab-beam" />
        </div>
      </div>
      <div className="ab-s2" aria-hidden="true">
        <svg className="ab-map" viewBox="0 0 360 640" preserveAspectRatio="xMidYMid slice" focusable="false">
          <path className="ab-streets" d={STREETS} />
          <path className="ab-route" d={ROUTE} pathLength={100} />
          <g transform="translate(300 176)">
            <g className="ab-pin">
              <path d="M0 0C-10-14-16-22-16-32A16 16 0 1 1 16-32C16-22 10-14 0 0Z" fill="#7c3aed" stroke="#fff" strokeWidth="3" strokeLinejoin="round" />
              <circle cx="0" cy="-32" r="6" fill="#fff" />
            </g>
          </g>
        </svg>
        <div className="ab-brand">
          <svg className="ab-logo" viewBox="0 0 120 120" aria-hidden="true">
            <defs><linearGradient id="abg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stopColor="#C4B5FD" /><stop offset="1" stopColor="#7C3AED" /></linearGradient></defs>
            <circle cx="60" cy="60" r="44" fill="none" stroke="url(#abg)" strokeWidth="5" />
            <path d="M50.5 84V38H66a14 14 0 0 1 0 28H50.5" fill="none" stroke="#fff" strokeWidth="9" strokeLinecap="round" strokeLinejoin="round" />
            <circle cx="88" cy="92" r="4" fill="#8B5CF6" />
          </svg>
          <div className="ab-appname">{first} <b>{rest.join(" ")}</b></div>
        </div>
        <div className="ab-wait">Carregando suas paradas…</div>
      </div>
    </div>
  );
}
