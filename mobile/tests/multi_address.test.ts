import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { splitMultiAddress } from "../src/core/freetext";
import { mapRows, prepareText } from "../src/core/importer";

const NUMS = ["53", "78", "197", "8", "95", "35", "21", "94", "1", "278", "234", "15", "37", "5", "85", "117", "12", "42"];
const BLOB = "rua João eboli 53, avenida conselheiro nebias 78, rua doutor cochrane 197, rua tiro naval 8, avenida nebias 95, rua sete de setembro 35, rua cerquinho 21, rua são Paulo 94, rua doutor cesario Bastos 1, rua Antonio bento 278, rua antonio bento 234, rua silveira lobo 15, rua são Paulo 37, rua Joaquim Nabuco 5, rua general camara 85, rua professor Manuel de Abreu 117, rua capitão Adolfo Millon 12, rua pastor narciso de Andrade 42";
const nums = (t: string) => { const p = prepareText(t); return mapRows(p.table, p.mapping).map((r) => r.values.number); };

describe("vários endereços na mesma linha (o defeito de 'não identifica o número')", () => {
  it("a mensagem do usuário colada numa linha só: 18 endereços com os 18 números", () => {
    expect(nums(BLOB)).toEqual(NUMS);
  });
  it.each([["ponto e vírgula", BLOB.split(", ").join("; ")], ["barra vertical", BLOB.split(", ").join(" | ")], ["só espaço entre número e Rua", BLOB.split(", ").join(" ")],
    ["numerada na mesma linha", BLOB.split(", ").map((s, i) => `${i + 1}) ${s}`).join(" ")], ["uma por linha", BLOB.split(", ").join("\n")], ["com Santos/SP", BLOB.split(", ").map((s) => `${s}, Santos/SP`).join("; ")]])("%s", (_n, t) => {
    expect(nums(t)).toEqual(NUMS);
  });
  it("avisa quantos endereços foram separados", () => {
    expect(prepareText(BLOB).warnings.join(" ")).toMatch(/Separei 18 endereços/);
  });
  it("não corta nomes que contêm palavra de via: 'Rua da Praça 15', 'Avenida Rua X'", () => {
    expect(splitMultiAddress("Rua da Praça 15, Santos")).toHaveLength(1);
    expect(splitMultiAddress("Rua Travessa Nova 20 Centro")).toHaveLength(1);
    expect(splitMultiAddress("Rua A 10, Rua B 20")).toEqual(["Rua A 10", "Rua B 20"]);
    expect(splitMultiAddress("Praça da Sé 5 Largo do Rosário 9")).toEqual(["Praça da Sé 5", "Largo do Rosário 9"]);
  });
  it("não mexe em linha única nem em planilha com cabeçalho (CSV da lista de 18 e do cenário de 300)", () => {
    const csv = readFileSync(new URL("../../listas/entregas_santos_18.csv", import.meta.url), "utf8");
    const p = prepareText(csv);
    expect(mapRows(p.table, p.mapping)).toHaveLength(18);
    expect(p.warnings.join(" ")).not.toMatch(/Separei/);
    const big = readFileSync(new URL("../../test-data/cenario_300_cartas_centro_paqueta_vila_nova.csv", import.meta.url), "utf8");
    expect(mapRows(prepareText(big).table, prepareText(big).mapping)).toHaveLength(300);
    expect(nums("Rua Itororó, 118, Centro, Santos/SP")).toEqual(["118"]);
  });
});
