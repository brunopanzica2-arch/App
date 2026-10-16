import { describe, expect, it } from "vitest";
import { explodeMultiAddressText } from "../src/core/freetext";

const LISTA = `rua Júlio conceição, números :
365

Rua cunha Moreira, números :
197, 200

Avenida senador Feijó, números :
768, 811

Avenida Washington Luiz, números :
224, 193, 239,

Rua Barão de Paranapiacaba, números :
138, 87, 42, 36,

Avenida conselheiro nebias, números :
532,

Rua doutor Leôncio de Rezende filho, números :
46

Avenida conselheiro Rodrigues, números :
415, 484,

Rua pérsio Queiroz filho, números :
160, 159, 130,

Rua Luís de Camões, números :
212, 198,

Rua cunha Moreira, números :
56,

Rua doutor Guedes coelho, números :
94, 90, 81, 37, 20,

Avenida conselheiro nebias 444`;

describe("lista no formato 'Rua X, números: …'", () => {
  const lines = explodeMultiAddressText(LISTA).text.split("\n").filter((l) => l.trim());
  it("gera um endereço por número, exatamente na ordem escrita", () => {
    expect(lines).toHaveLength(28);
    expect(lines.slice(0, 6)).toEqual(["rua Júlio conceição 365", "Rua cunha Moreira 197", "Rua cunha Moreira 200", "Avenida senador Feijó 768", "Avenida senador Feijó 811", "Avenida Washington Luiz 224"]);
    expect(lines.slice(6, 9)).toEqual(["Avenida Washington Luiz 193", "Avenida Washington Luiz 239", "Rua Barão de Paranapiacaba 138"]);
    expect(lines.at(-1)).toBe("Avenida conselheiro nebias 444");
    expect(lines.at(-2)).toBe("Rua doutor Guedes coelho 20");
  });
  it("mesma rua repetida mais adiante (Cunha Moreira) continua como parada própria, na posição escrita", () => {
    expect(lines.indexOf("Rua cunha Moreira 56")).toBeGreaterThan(lines.indexOf("Rua cunha Moreira 200"));
  });
  it("'Rua X 197, 200' numa linha só também abre", () => {
    expect(explodeMultiAddressText("rua cunha Moreira 197, 200").text.split("\n")).toEqual(["rua cunha Moreira 197", "rua cunha Moreira 200"]);
  });
  it("não mexe em endereço normal", () => {
    expect(explodeMultiAddressText("Rua A 53").extra).toBe(0);
  });
});
