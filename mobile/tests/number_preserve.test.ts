import { describe, expect, it } from "vitest";
import { normalizeAddress, normalizeNumber } from "../src/core/normalize";

describe("número do endereço nunca vira S/N quando informado", () => {
  it.each([
    ["480", "480"], ["nº 480", "480"], ["n 480", "480"], ["N. 480", "480"], ["número 480", "480"],
    ["#480", "480"], ["1.234", "1234"], ["480A", "480A"], [480, "480"],
  ])("%s → %s", (raw, out) => {
    expect(normalizeNumber(raw as string | number)[0]).toBe(out);
  });

  it("S/N explícito continua sendo S/N", () => {
    expect(normalizeNumber("S/N")[0]).toBeNull();
    expect(normalizeAddress("Rua Alexandre Herculano", "S/N").display).toContain("S/N");
  });

  it("número ilegível é exibido como pedido, 'não confirmado', nunca S/N", () => {
    const a = normalizeAddress("Rua Alexandre Herculano", "lote 12-B");
    expect(a.display).not.toContain("S/N");
    expect(a.display).toContain("número não confirmado");
  });

  it("número válido aparece no display", () => {
    expect(normalizeAddress("Rua Alexandre Herculano", "nº 480").display).toContain(", 480");
  });
});
