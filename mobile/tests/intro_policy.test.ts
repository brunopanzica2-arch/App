import { readFileSync } from "node:fs";
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

describe("script inline do index.html = mesma regra de decideIntro('full')", () => {
  const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
  const code = html.match(/<script>\s*\/\/ Mesma regra[\s\S]*?<\/script>/)![0].replace(/<\/?script>/g, "");
  const run = (store: Store, reduced: boolean, now: Date) => {
    const cls = new Set<string>();
    const RealDate = Date;
    const fakeDate = class extends RealDate { constructor() { super(now.getTime()); } } as unknown as DateConstructor;
    const win: any = {};
    new Function("document", "localStorage", "matchMedia", "performance", "window", "Date", code)(
      { documentElement: { classList: { add: (c: string) => cls.add(c) } } }, store, () => ({ matches: reduced }), { now: () => 5 }, win, fakeDate);
    return cls.has("ab-pre-on");
  };
  it.each([
    ["instalação nova", {}, false, true],
    ["já abriu hoje", { "rota.intro.last": "2026-10-11" }, false, false],
    ["abriu ontem", { "rota.intro.last": "2026-10-10" }, false, true],
    ["pular ligado", { "rota.intro.skip": "1" }, false, false],
    ["reduzir animações", {}, true, false],
  ])("%s", (_n, init, reduced, expected) => {
    const m = new Map(Object.entries(init as Record<string, string>));
    const store: Store = { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => void m.set(k, v) };
    const now = new Date(2026, 9, 11, 10, 0);
    expect(run(store, reduced as boolean, now)).toBe(expected);
    expect(decideIntro({ store, reducedMotion: reduced as boolean, now }) === "full").toBe(expected);
  });
});
