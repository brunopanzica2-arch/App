import { describe, expect, it } from "vitest";
import { applyOutcome, levelOf } from "../src/core/progress";
import { deriveView, type ViewInput } from "../src/core/session";

const base: ViewInput = { letters: 10, pendingLetters: 10, routeId: "R", openStops: 5, navActive: false, paused: false, endedRouteId: null };

describe("fase da sessão (fonte única do estado visual)", () => {
  it("sem cartas / sem rota / rota planejada", () => {
    expect(deriveView({ ...base, letters: 0, pendingLetters: 0, routeId: null }).phase).toBe("empty");
    const un = deriveView({ ...base, routeId: null });
    expect(un).toMatchObject({ phase: "unplanned", showRoute: false, showStopPins: true, canPlan: true, canStart: false });
    expect(deriveView(base)).toMatchObject({ phase: "planned", showRoute: true, canStart: true, navUi: false });
  });
  it("navegando e pausado mostram rota e câmera de navegação", () => {
    expect(deriveView({ ...base, navActive: true })).toMatchObject({ phase: "navigating", showRoute: true, navUi: true, canStart: false });
    expect(deriveView({ ...base, navActive: true, paused: true }).phase).toBe("paused");
  });
  it("ao concluir (0 paradas abertas) a rota NÃO é mais desenhada e não há 'Iniciar navegação', mesmo com navegação ainda ativa", () => {
    const v = deriveView({ ...base, openStops: 0, pendingLetters: 2, navActive: true });
    expect(v).toMatchObject({ phase: "completed", showRoute: false, canStart: false, navUi: false });
  });
  it("encerrar manualmente apaga a rota do mapa e oferece retomar, nunca 'Iniciar'", () => {
    const v = deriveView({ ...base, endedRouteId: "R" });
    expect(v).toMatchObject({ phase: "ended", showRoute: false, canStart: false, canResume: true, navUi: false });
    // encerrada outra rota: não afeta a atual
    expect(deriveView({ ...base, endedRouteId: "OUTRA" }).phase).toBe("planned");
  });
  it("lote inteiro tratado sem rota ativa = concluído", () => {
    expect(deriveView({ ...base, routeId: null, pendingLetters: 0 }).phase).toBe("completed");
  });
});

describe("progresso e recompensa", () => {
  const ctx = { remainingLetters: 17, remainingStops: 12, stopIndex: 4, stopTotal: 22 };
  const z = { date: "2026-10-11", delivered: 0, notDelivered: 0, skipped: 0, streak: 0, bestStreak: 0, xp: 0, startedAt: 0, lastAt: 0, activeMs: 0 };
  it("entrega gera XP, sequência e texto curto", () => {
    const r = applyOutcome(z, "delivered", 1, ctx, 1000);
    expect(r.reward).toMatchObject({ xp: 10, streak: 1, remainingLetters: 17 });
    expect(r.reward!.subtitle).toBe("Restam 17 cartas · Parada 4 de 22");
  });
  it("bônus de sequência a partir da 3ª e falha/pulo zeram a sequência", () => {
    let s = z;
    for (let i = 0; i < 3; i++) s = applyOutcome(s, "delivered", 1, ctx, 1000 + i).stats;
    expect(s.streak).toBe(3);
    expect(s.xp).toBe(10 + 10 + 15);
    s = applyOutcome(s, "skipped", 1, ctx, 2000).stats;
    expect(s.streak).toBe(0);
    expect(s.bestStreak).toBe(3);
  });
  it("não-entrega e pulo não geram recompensa", () => {
    expect(applyOutcome(z, "not_delivered", 2, ctx).reward).toBeNull();
    expect(applyOutcome(z, "skipped", 1, ctx).reward).toBeNull();
  });
  it("nível cresce com XP", () => {
    expect(levelOf(0).level).toBe(1);
    expect(levelOf(100).level).toBe(2);
    expect(levelOf(5000).level).toBeGreaterThan(5);
  });
});
