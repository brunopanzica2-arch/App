import { describe, expect, it } from "vitest";
import { normalizeAddress } from "../src/core/normalize";

describe("endereço exibido mantém acentos; chave continua sem acento", () => {
  it("Rua Joaquim Távora / Praça / Avenida Senador Feijó", () => {
    expect(normalizeAddress("R. Joaquim Távora", "480", "Vila Belmiro").display).toBe("Rua Joaquim Távora, 480 - Vila Belmiro - Santos/SP");
    expect(normalizeAddress("Praça Visconde de Mauá", "11").display.split(" - ")[0]).toBe("Praça Visconde de Mauá, 11");
    expect(normalizeAddress("Av. Senador Feijó", "104", "Vila Nova").display.split(" - ")[0]).toBe("Avenida Senador Feijó, 104");
    expect(normalizeAddress("Rua Dr. Cesário Bastos", "5").display.split(" - ")[0]).toBe("Rua Doutor Cesário Bastos, 5");
  });
  it("a chave de deduplicação independe de acento e caixa", () => {
    const a = normalizeAddress("Rua Joaquim Távora", "480"), b = normalizeAddress("RUA JOAQUIM TAVORA", "480");
    expect(a.key).toBe(b.key);
  });
});
