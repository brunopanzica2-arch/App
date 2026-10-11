import { describe, expect, it } from "vitest";
import { decideIntro, introSkip, introSound, KEY_LAST, KEY_SKIP, localDay, markShown, setIntroSkip, setIntroSound, type Store } from "../src/intro/policy";

const mem = (): Store & { m: Map<string, string> } => { const m = new Map<string, string>(); return { m, getItem: (k) => m.get(k) ?? null, setItem: (k, v) => void m.set(k, v) }; };
const day = (d: string) => new Date(`${d}T12:00:00`);

describe("política da abertura", () => {
  it("instalação nova / primeira do dia: completa", () => {
    expect(decideIntro({ store: mem(), reducedMotion: false, now: day("2026-10-11") })).toBe("full");
  });
  it("segunda abertura do mesmo dia: só cena 2 encurtada", () => {
    const s = mem();
    markShown(s, day("2026-10-11"));
    expect(decideIntro({ store: s, reducedMotion: false, now: day("2026-10-11") })).toBe("short");
  });
  it("no dia seguinte volta a completa", () => {
    const s = mem();
    markShown(s, day("2026-10-11"));
    expect(decideIntro({ store: s, reducedMotion: false, now: day("2026-10-12") })).toBe("full");
  });
  it("'Pular abertura' tem prioridade sobre tudo", () => {
    const s = mem();
    setIntroSkip(s, true);
    expect(introSkip(s)).toBe(true);
    expect(decideIntro({ store: s, reducedMotion: true })).toBe("none");
    setIntroSkip(s, false);
    expect(decideIntro({ store: s, reducedMotion: false, now: day("2026-10-11") })).toBe("full");
  });
  it("reduced motion: cartão estático (modo próprio), mesmo na primeira do dia", () => {
    expect(decideIntro({ store: mem(), reducedMotion: true })).toBe("reduced");
  });
  it("armazenamento indisponível não quebra: abertura completa", () => {
    const broken: Store = { getItem() { throw new Error("blocked"); }, setItem() { throw new Error("blocked"); } };
    expect(decideIntro({ store: broken, reducedMotion: false })).toBe("full");
    expect(() => markShown(broken)).not.toThrow();
    expect(decideIntro({ store: null, reducedMotion: false })).toBe("full");
  });
  it("som: desligado por padrão e persistente", () => {
    const s = mem();
    expect(introSound(s)).toBe(false);
    setIntroSound(s, true);
    expect(introSound(s)).toBe(true);
  });
  it("dia local usa a data local (não UTC)", () => {
    expect(localDay(new Date(2026, 9, 11, 23, 30))).toBe("2026-10-11");
    expect(KEY_LAST && KEY_SKIP).toBeTruthy();
  });
});
