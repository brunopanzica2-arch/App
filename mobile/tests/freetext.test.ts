import { describe, expect, it } from "vitest";
import { parseFreeAddress as p } from "../src/core/freetext";

describe("texto livre de endereço (sem separador, sem cabeçalho)", () => {
  it.each([
    ["Rua Joaquim Távora 480", { street: "Rua Joaquim Távora", number: "480" }],
    ["R. Joaquim Távora, 480, Vila Belmiro", { street: "R. Joaquim Távora", number: "480", neighborhood: "Vila Belmiro" }],
    ["Praça Visconde de Mauá 11", { street: "Praça Visconde de Mauá", number: "11" }],
    ["Rua 7 de Setembro 120", { street: "Rua 7 de Setembro", number: "120" }],
    ["Av. Ana Costa 100 apto 3 Gonzaga Santos SP", { street: "Av. Ana Costa", number: "100", complement: "apto 3", neighborhood: "Gonzaga", city: "Santos", state: "SP" }],
    ["avenida conselheiro nébias 300", { street: "avenida conselheiro nébias", number: "300" }],
    ["Rua Itororó nº 118 Centro", { street: "Rua Itororó", number: "118", neighborhood: "Centro" }],
    ["1) Rua Amador Bueno 25", { street: "Rua Amador Bueno", number: "25" }],
    ["Rua Braz Cubas, 20 - Centro - Santos/SP, 11010-000", { street: "Rua Braz Cubas", number: "20", neighborhood: "Centro", cep: "11010-000" }],
    ["Rua Cidade de Toledo 15A casa 2 fundos", { street: "Rua Cidade de Toledo", number: "15A", complement: "casa 2, fundos" }],
    ["Avenida Nove de Julho 80", { street: "Avenida Nove de Julho", number: "80" }],
    ["Rua XV de Novembro 90", { street: "Rua XV de Novembro", number: "90" }],
  ] as const)("%s", (line, want) => {
    const r = p(line);
    for (const [k, v] of Object.entries(want)) expect((r as any)[k], `${k} em "${line}"`).toBe(v);
  });

  it("sem número não inventa número", () => {
    const r = p("Rua Joaquim Távora");
    expect(r.number).toBeNull();
    expect(r.street).toBe("Rua Joaquim Távora");
    expect(r.notes.join(" ")).toMatch(/Número não informado/);
  });
  it("bairro desconhecido é inferido e sinalizado, nunca silencioso", () => {
    const r = p("Rua Fictícia 10 Jardim Alvorada");
    expect(r.number).toBe("10");
    expect(r.neighborhood).toBe("Jardim Alvorada");
    expect(r.notes.join(" ")).toMatch(/Bairro inferido/);
  });
  it("confiança do parse é maior com tipo de logradouro e número", () => {
    expect(p("Rua Joaquim Távora 480").confidence).toBeGreaterThan(p("Joaquim Távora").confidence);
  });
});
