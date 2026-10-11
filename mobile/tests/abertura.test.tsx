// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Abertura } from "../src/intro/Abertura";
import { KEY_LAST, type Store, TIMING } from "../src/intro/policy";
import { __resetReady, signalDataReady } from "../src/intro/ready";

const mem = (init: Record<string, string> = {}): Store & { m: Map<string, string> } => { const m = new Map(Object.entries(init)); return { m, getItem: (k) => m.get(k) ?? null, setItem: (k, v) => void m.set(k, v) }; };
const phase = () => screen.queryByTestId("abertura")?.getAttribute("data-phase") ?? "none";
const adv = (ms: number) => act(() => { vi.advanceTimersByTime(ms); });
const SCENE1 = TIMING.fadeIn + TIMING.hold + TIMING.fadeOut;

beforeEach(() => { vi.useFakeTimers(); __resetReady(); document.body.innerHTML = '<div id="main-content" tabindex="-1"></div>'; });
afterEach(() => { cleanup(); vi.useRealTimers(); });

describe("Abertura", () => {
  it("1ª do dia: cena 1 (estúdio) → cena 2 (rota/pino) → app, na ordem e com os tempos pedidos", () => {
    const onDone = vi.fn();
    render(<Abertura store={mem()} reducedMotion={false} onDone={onDone} />);
    expect(screen.getByTestId("abertura")).toHaveAttribute("data-mode", "full");
    expect(screen.getByText("PANZICA")).toBeInTheDocument();
    expect(screen.getByText("PRODUCTIONS")).toBeInTheDocument();
    adv(20); // 2 quadros para armar a transição
    expect(["s1-in", "pre"]).toContain(phase());
    adv(TIMING.fadeIn);
    expect(phase()).toBe("s1-hold");
    adv(TIMING.hold);
    expect(phase()).toBe("s1-out");
    adv(TIMING.fadeOut);
    expect(phase()).toBe("s2");
    expect(SCENE1).toBeGreaterThanOrEqual(2000); expect(SCENE1).toBeLessThanOrEqual(2500);
    signalDataReady();
    adv(TIMING.route);
    expect(phase()).toBe("handoff");
    adv(TIMING.handoff);
    expect(phase()).toBe("none");
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it("anuncia 'Carregando rota' em aria-live e esconde a animação dos leitores de tela", () => {
    render(<Abertura store={mem()} reducedMotion={false} />);
    expect(screen.getByRole("status")).toHaveTextContent("Carregando rota");
    const root = screen.getByTestId("abertura");
    expect(root.querySelector(".ab-s1")).toHaveAttribute("aria-hidden", "true");
    expect(root.querySelector(".ab-s2")).toHaveAttribute("aria-hidden", "true");
  });

  it("tocar na tela pula a abertura a qualquer momento (e é idempotente)", () => {
    const onDone = vi.fn();
    render(<Abertura store={mem()} reducedMotion={false} onDone={onDone} />);
    adv(300);
    fireEvent.pointerDown(screen.getByTestId("abertura"));
    expect(phase()).toBe("handoff");
    fireEvent.pointerDown(screen.getByTestId("abertura")); // 2º toque não duplica
    adv(TIMING.handoff);
    adv(5000);
    expect(onDone).toHaveBeenCalledTimes(1);
    expect(phase()).toBe("none");
  });

  it("Escape também pula (teclado)", () => {
    render(<Abertura store={mem()} reducedMotion={false} />);
    adv(50);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(phase()).toBe("handoff");
  });

  it("2ª abertura do dia: só a cena 2 encurtada, sem cartão do estúdio", () => {
    const s = mem();
    const day = new Date(2026, 9, 11, 9, 0);
    render(<Abertura store={s} reducedMotion={false} now={day} />);
    expect(s.m.get(KEY_LAST)).toBe("2026-10-11"); // marcou a abertura do dia
    cleanup();
    __resetReady(); signalDataReady();
    render(<Abertura store={s} reducedMotion={false} now={day} />);
    const el = screen.getByTestId("abertura");
    expect(el).toHaveAttribute("data-mode", "short");
    adv(50);
    expect(phase()).toBe("s2");
    adv(TIMING.routeShort);
    expect(phase()).toBe("handoff");
    adv(TIMING.handoff);
    expect(phase()).toBe("none");
  });

  it("'Pular abertura' ligado: não renderiza nada e já entrega o app", () => {
    const onDone = vi.fn();
    render(<Abertura store={mem({ "rota.intro.skip": "1" })} reducedMotion={false} onDone={onDone} />);
    expect(screen.queryByTestId("abertura")).not.toBeInTheDocument();
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it("reduced motion: cartão estático com fade curto (~800 ms), sem a cena da rota", () => {
    const onDone = vi.fn();
    render(<Abertura store={mem()} reducedMotion onDone={onDone} />);
    expect(screen.getByTestId("abertura")).toHaveAttribute("data-mode", "reduced");
    adv(TIMING.reduced - 10);
    expect(onDone).not.toHaveBeenCalled();
    adv(10 + TIMING.handoff);
    expect(onDone).toHaveBeenCalledTimes(1);
    expect(TIMING.reduced).toBeLessThanOrEqual(800);
  });

  it("dados ainda não prontos: espera com o fundo do app (nunca congela no pino) e entra quando chegam", () => {
    const onDone = vi.fn();
    render(<Abertura store={mem()} reducedMotion={false} onDone={onDone} />);
    adv(SCENE1 + TIMING.route);
    expect(phase()).toBe("wait");
    expect(onDone).not.toHaveBeenCalled();
    act(() => signalDataReady());
    expect(phase()).toBe("handoff");
    adv(TIMING.handoff);
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it("dados que nunca chegam: sai pelo limite de espera (o skeleton assume)", () => {
    const onDone = vi.fn();
    render(<Abertura store={mem()} reducedMotion={false} onDone={onDone} />);
    adv(SCENE1 + TIMING.route + TIMING.waitCap + TIMING.handoff + 50);
    expect(onDone).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("status")).toHaveTextContent("Carregando dados");
  });

  it("ao terminar, o foco vai para o conteúdo principal", () => {
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => setTimeout(() => cb(0), 0) as unknown as number);
    render(<Abertura store={mem({ "rota.intro.skip": "0" })} reducedMotion={false} />);
    signalDataReady();
    fireEvent.pointerDown(screen.getByTestId("abertura"));
    adv(TIMING.handoff + 50);
    expect(document.activeElement?.id).toBe("main-content");
    vi.unstubAllGlobals();
  });
});
