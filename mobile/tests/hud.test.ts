import { describe, expect, it } from "vitest";
import { hudText, precisionNote } from "../src/core/hud";
import { aheadFrom } from "../src/ui/useNavigation";

describe("HUD", () => {
  it("texto 'Em 90 m, vire à direita na Rua X' vem da manobra real", () => {
    expect(hudText("right", "Rua Braz Cubas", 92)).toEqual({ head: "Em 90 m", body: "Vire à direita na Rua Braz Cubas" });
    expect(hudText("uturn", "", 15)).toEqual({ head: "Em 20 m", body: "Faça o retorno" });
    expect(hudText("left", "Rua A", 1250).head).toBe("Em 1,3 km");
  });
  it("não afirma proximidade do número quando só a rua é conhecida", () => {
    expect(precisionNote("entrance")).toBeNull();
    expect(precisionNote("interpolated")).toMatch(/próximo ao número/);
    expect(precisionNote("street")).toMatch(/Só a rua/);
  });
  it("trecho restante parte do progresso e termina no fim da rota", () => {
    const r = { lat: [0, 0.001, 0.002], lon: [0, 0, 0], maneuvers: [], stops: [], length: 222 };
    const a = aheadFrom(r as any, 150);
    expect(a[0]).toEqual([0, 0.001]);
    expect(a.at(-1)).toEqual([0, 0.002]);
  });
});
