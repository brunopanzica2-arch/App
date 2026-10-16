import { useCallback, useEffect, useRef, useState } from "react";
import "./abertura.css";
import { dataReady } from "./ready";
import { decideIntro, introSound, type IntroMode, markShown, type Store, TIMING } from "./policy";
import { type IntroSoundHandle, playIntroSound } from "./sound";

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

/** Ruas decorativas e a rota (um traçado com curvas de 90°, como quarteirões) até o pino. Coordenadas em viewBox 360×640. */
const STREETS = "M0 470H360 M0 300H360 M0 140H360 M70 0V640 M190 0V640 M300 0V640";
const ROUTE = "M70 600V470Q70 450 90 450H170Q190 450 190 430V320Q190 300 210 300H280Q300 300 300 280V176";

const leaveEnter = () => { document.documentElement.classList.add("rota-enter"); setTimeout(() => document.documentElement.classList.remove("rota-enter"), 600); };

export function Abertura({ store, reducedMotion, now, onDone, appName = "Rota Santos" }: Props) {
  const st = store === undefined ? defaultStore() : store;
  const [mode] = useState<IntroMode>(() => decideIntro({ store: st, reducedMotion: reducedMotion ?? prefersReduced(), now }));
  // cartão do estúdio ESTÁTICO do index.html (pinta antes do JS): se existir, a cena 1 é dele e o React só assume na cena 2
  const [pre] = useState(() => mode === "full" && typeof document !== "undefined" && document.documentElement.classList.contains("ab-pre-on") && !!document.getElementById("ab-pre"));
  const [phase, setPhase] = useState<Phase>(mode === "none" ? "done" : pre ? "s1-hold" : "s1-in");
  const [live, setLive] = useState(mode === "none" ? "" : "Carregando rota");
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);
  const finished = useRef(false);
  const sound = useRef<IntroSoundHandle | null>(null);
  const mountT = useRef(typeof performance !== "undefined" ? performance.now() : 0);
  const dotRef = useRef<SVGAnimateMotionElement | null>(null);
  const doneCb = useRef(onDone);
  doneCb.current = onDone;

  const clear = () => { timers.current.forEach(clearTimeout); timers.current = []; };
  const later = (ms: number, fn: () => void) => { timers.current.push(setTimeout(fn, ms)); };

  const dropPre = (fast = false) => {
    const el = document.getElementById("ab-pre");
    if (!el) return;
    if (!fast) return el.remove();
    el.classList.add("skip"); // some em fade curto em vez de cortar
    setTimeout(() => el.remove(), 300);
  };

  const finish = useCallback(() => {
    if (finished.current) return; // idempotente: pular + fim natural não duplicam
    finished.current = true;
    clear();
    sound.current?.stop(); // se acabou antes do fim do som (pulou / dados rápidos), desvanece em vez de cortar
    dropPre();
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

  const skip = useCallback(() => { if (!finished.current) { dropPre(true); handoff(); } }, [handoff]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (mode === "none") { finished.current = true; leaveEnter(); doneCb.current?.(); return; }
    markShown(st, now);
    if (introSound(st) && mode === "full") {
      // som sincronizado com o relógio da animação: t=0 é o início da página (cartão estático) ou a montagem
      const t0 = (window as any).__abPreT0 as number | undefined;
      sound.current = playIntroSound(Math.max(0, performance.now() - (pre && t0 != null ? t0 : mountT.current)));
    }
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
    } else {
      const scene1 = TIMING.fadeIn + TIMING.hold + TIMING.fadeOut;
      if (pre) {
        // a cena 1 já está tocando no HTML estático desde o carregamento da página: o React só espera o que falta dela
        const left = Math.max(0, scene1 - (performance.now() - ((window as any).__abPreT0 ?? 0)));
        later(left, () => { dropPre(); setPhase("s2"); });
        later(left + TIMING.route, afterS2);
        return clear;
      }
      later(TIMING.fadeIn, () => setPhase("s1-hold"));
      later(TIMING.fadeIn + TIMING.hold, () => setPhase("s1-out"));
      later(TIMING.fadeIn + TIMING.hold + TIMING.fadeOut, () => setPhase("s2"));
      later(TIMING.fadeIn + TIMING.hold + TIMING.fadeOut + TIMING.route, afterS2);
    }
    return clear;
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { // o ponto do entregador percorre a rota junto com o traço (SMIL; sem suporte = só o traço)
    if (phase === "s2") { try { dotRef.current?.beginElement?.(); } catch { /* sem SMIL */ } }
  }, [phase]);

  // a transição só começa depois de pintar o estado inicial (senão o navegador já nasce no estado final)
  const [armed, setArmed] = useState(false);
  useEffect(() => { const id = requestAnimationFrame(() => requestAnimationFrame(() => setArmed(true))); return () => cancelAnimationFrame(id); }, []);

  useEffect(() => {
    const k = (e: KeyboardEvent) => { if (e.key === "Escape" || e.key === "Enter" || e.key === " ") skip(); };
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [skip]);

  if (phase === "done") return <div className="ab-sr" role="status" aria-live="polite">{live}</div>;
  const [first] = appName.split(" ");
  return (
    <div className="ab" data-testid="abertura" data-mode={mode} data-phase={armed ? phase : "pre"} onPointerDown={skip}>
      <div className="ab-sr" role="status" aria-live="polite">{live}</div>
      {!pre && <div className="ab-s1" aria-hidden="true">
        <div className="ab-title">
          <span style={{ display: "block" }}>PANZICA</span> <span style={{ display: "block" }}>PRODUCTIONS</span>
        </div>
      </div>}
      <div className="ab-s2" aria-hidden="true">
        <svg className="ab-map" viewBox="0 0 360 640" preserveAspectRatio="xMidYMid slice" focusable="false">
          <path className="ab-streets" d={STREETS} />
          <path className="ab-route" d={ROUTE} pathLength={100} />
          <circle className="ab-dot" r="7" fill="#fff">
            <animateMotion ref={dotRef} dur="1.4s" begin="indefinite" fill="freeze" path={ROUTE} calcMode="spline" keyTimes="0;1" keySplines="0.16 1 0.3 1" />
          </circle>
          <g transform="translate(300 176)">
            <ellipse className="ab-ripple" cx="0" cy="0" rx="14" ry="5" />
            <ellipse className="ab-ripple r2" cx="0" cy="0" rx="14" ry="5" />
            <g className="ab-pin">
              <path d="M0 0C-10-14-16-22-16-32A16 16 0 1 1 16-32C16-22 10-14 0 0Z" fill="#7c3aed" stroke="#fff" strokeWidth="3" strokeLinejoin="round" />
              <circle cx="0" cy="-32" r="6" fill="#fff" />
            </g>
          </g>
        </svg>
        <div className="ab-brand">
          <svg className="ab-logo" viewBox="0 0 120 120" aria-hidden="true">
            <defs><linearGradient id="abg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stopColor="#C4B5FD" /><stop offset="1" stopColor="#7C3AED" /></linearGradient></defs>
            <circle className="ab-ring" cx="60" cy="60" r="44" pathLength={100} fill="none" stroke="url(#abg)" strokeWidth="5" />
            <path className="ab-p" pathLength={100} d="M50.5 84V38H66a14 14 0 0 1 0 28H50.5" fill="none" stroke="#fff" strokeWidth="9" strokeLinecap="round" strokeLinejoin="round" />
            <circle cx="88" cy="92" r="4" fill="#8B5CF6" />
          </svg>
          <div className="ab-appname" role="text" aria-label={appName}>
            {[...appName].map((ch, i) => <span key={i} aria-hidden="true" className={i > first.length ? "b" : undefined} style={{ ["--i" as string]: i }}>{ch === " " ? "\u00a0" : ch}</span>)}
          </div>
        </div>
        <div className="ab-wait">Carregando suas paradas…</div>
      </div>
    </div>
  );
}
