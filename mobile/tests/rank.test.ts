import { describe, expect, it } from "vitest";
import type { Candidate } from "../src/core/db";
import { inSantosBox, pickBest } from "../src/core/rank";

const cand = (o: Partial<Candidate>): Candidate => ({ lat: -23.96, lon: -46.33, label: "Rua X, Santos", precision: "exact", confidence: 0.9, road: "Rua X", houseNumber: "10", city: "Santos", postcode: null, ...o } as Candidate);
const santos = { city: "Santos" };

describe("escopo Santos/SP e desempate por proximidade", () => {
  it("homônimo em outra cidade perde para Santos mesmo com confiança maior", () => {
    const sp = cand({ city: "São Paulo", lat: -23.55, lon: -46.63, confidence: 0.95 });
    const st = cand({ city: "Santos", confidence: 0.7 });
    const r = pickBest([sp, st], santos)!;
    expect(r.best.c.city).toBe("Santos");
  });
  it("dois pontos em Santos: o mais próximo do usuário vence e a decisão é explicável", () => {
    const perto = cand({ lat: -23.9490, lon: -46.3340, label: "Rua X, Gonzaga, Santos" });
    const longe = cand({ lat: -23.9890, lon: -46.2900, label: "Rua X, Ponta da Praia, Santos" });
    const r = pickBest([longe, perto], { ...santos, user: { lat: -23.9489, lon: -46.3337 } })!;
    expect(r.best.c).toBe(perto);
    expect(r.best.why.join(" ")).toMatch(/de você/);
    expect(r.ranked[0].score - r.ranked[1].score).toBeGreaterThan(0.1);
  });
  it("sem a posição do usuário, bairro coerente desempata", () => {
    const a = cand({ lat: -23.9490, lon: -46.3340, label: "Rua X, Gonzaga, Santos" });
    const b = cand({ lat: -23.9890, lon: -46.2900, label: "Rua X, Ponta da Praia, Santos" });
    expect(pickBest([a, b], { ...santos, neighborhood: "Ponta da Praia" })!.best.c).toBe(b);
  });
  it("ambíguo (dois pontos bons, pontuação parecida) vai para revisão com alternativa", () => {
    const a = cand({ lat: -23.9490, lon: -46.3340 }), b = cand({ lat: -23.9560, lon: -46.3300 });
    const r = pickBest([a, b], santos)!;
    expect(r.ambiguous).toBe(true);
    expect(r.alternative).not.toBeNull();
    expect(r.reason).toMatch(/Dois pontos plausíveis/);
  });
  it("usuário próximo de um dos pontos resolve a ambiguidade sem revisão", () => {
    const a = cand({ lat: -23.9490, lon: -46.3340 }), b = cand({ lat: -23.9890, lon: -46.2900 });
    expect(pickBest([a, b], { ...santos, user: { lat: -23.949, lon: -46.334 } })!.ambiguous).toBe(false);
  });
  it("recorte de Santos", () => {
    expect(inSantosBox(-23.96, -46.33)).toBe(true);
    expect(inSantosBox(-23.55, -46.63)).toBe(false);
  });
});
