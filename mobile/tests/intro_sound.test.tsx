// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Abertura } from "../src/intro/Abertura";
import { setIntroSound, type Store, TIMING } from "../src/intro/policy";
import { __resetReady } from "../src/intro/ready";
import { SOUND_TIMES, scheduleIntroSound } from "../src/intro/sound";

const mem = (): Store => { const m = new Map<string, string>(); return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => void m.set(k, v) }; };

/** Contexto de áudio falso: registra início/parada de osciladores e fontes. */
function fakeCtx() {
  const starts: number[] = [];
  const param = () => ({ value: 0, setValueAtTime() {}, linearRampToValueAtTime() {}, exponentialRampToValueAtTime() {}, cancelScheduledValues() {} });
  const node = (extra = {}) => ({ connect: (n: unknown) => n, ...extra });
  const ctx = {
    currentTime: 0, sampleRate: 8000, destination: node(),
    createGain: () => node({ gain: param() }),
    createDynamicsCompressor: () => node({ threshold: param(), ratio: param(), attack: param(), release: param() }),
    createOscillator: () => node({ frequency: param(), type: "sine", start: (t: number) => starts.push(t), stop() {} }),
    createBiquadFilter: () => node({ frequency: param(), Q: param(), type: "bandpass" }),
    createBuffer: (_c: number, len: number) => ({ getChannelData: () => new Float32Array(len) }),
    createBufferSource: () => node({ start: (t: number) => starts.push(t), buffer: null }),
  };
  return { ctx: ctx as unknown as BaseAudioContext, starts };
}

describe("som da abertura", () => {
  it("agenda os sons nos instantes da animação, em ordem e dentro da duração total", () => {
    const { ctx, starts } = fakeCtx();
    const { end } = scheduleIntroSound(ctx, { start: 0 });
    expect(starts.length).toBeGreaterThan(20);
    expect(Math.min(...starts)).toBeCloseTo(SOUND_TIMES.whoosh, 3);
    expect(starts).toContainEqual(expect.closeTo(SOUND_TIMES.hit, 3));
    expect(starts).toContainEqual(expect.closeTo(SOUND_TIMES.pin, 3));
    expect(Math.max(...starts)).toBeLessThan(end);
    expect(end).toBe(SOUND_TIMES.end);
  });
  it("pino cai depois do fim da cena 1 e antes do fim da cena 2", () => {
    const scene1 = (TIMING.fadeIn + TIMING.hold + TIMING.fadeOut) / 1000;
    expect(SOUND_TIMES.route).toBeGreaterThanOrEqual(scene1);
    expect(SOUND_TIMES.pin).toBeLessThan(scene1 + TIMING.route / 1000);
  });
  it("se o app abre tarde, sons já passados não são agendados", () => {
    const a = fakeCtx(); scheduleIntroSound(a.ctx, { start: 0 });
    const b = fakeCtx(); (b.ctx as unknown as { currentTime: number }).currentTime = 2.5; scheduleIntroSound(b.ctx, { start: 0 });
    expect(b.starts.length).toBeLessThan(a.starts.length);
  });
});

describe("Abertura + som", () => {
  let created = 0, closed = 0;
  beforeEach(() => {
    vi.useFakeTimers(); __resetReady(); created = 0; closed = 0;
    document.body.innerHTML = '<div id="main-content" tabindex="-1"></div>';
    class AC {
      constructor() { created++; Object.assign(this, fakeCtx().ctx); }
      resume() { return Promise.resolve(); }
      close() { closed++; return Promise.resolve(); }
    }
    vi.stubGlobal("AudioContext", AC);
    (window as unknown as { AudioContext: unknown }).AudioContext = AC;
  });
  afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); });

  it("liga por padrão: toca uma vez ao abrir; tocar na tela desvanece e fecha o áudio", () => {
    render(<Abertura store={mem()} reducedMotion={false} />);
    expect(created).toBe(1);
    act(() => { fireEvent.pointerDown(screen.getByTestId("abertura")); vi.advanceTimersByTime(600); });
    expect(closed).toBeGreaterThanOrEqual(1);
  });
  it("desligado em Ajustes: nenhum áudio é criado", () => {
    const s = mem(); setIntroSound(s, false);
    render(<Abertura store={s} reducedMotion={false} />);
    expect(created).toBe(0);
  });
  it("reduced motion: sem som", () => {
    render(<Abertura store={mem()} reducedMotion />);
    expect(created).toBe(0);
  });
});
