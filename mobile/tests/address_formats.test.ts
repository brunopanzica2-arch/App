import { describe, expect, it } from "vitest";
import { mapRows, prepareText } from "../src/core/importer";

/** Formatos reais que entregadores colam (WhatsApp, "nº", marcadores, complemento, conectores, número antes da rua…). Todos os números devem sair. */
const cases: [string, string[]][] = [
  ["R. Joaquim Távora, nº 480 - Vila Belmiro", ["480"]],
  ["Av. Ana Costa 100 apto 12", ["100"]],
  ["Rua Alexandre Herculano 480A", ["480A"]],
  ["Rua 7 de Setembro 35", ["35"]],
  ["Rua Sete de Setembro, 35", ["35"]],
  ["Av. Conselheiro Nébias, 1.234", ["1234"]],
  ["- Rua A 10\n• Rua B 20\n* Rua C 30", ["10", "20", "30"]],
  ["1. Rua A 10\n2. Rua B 20", ["10", "20"]],
  ["João Silva - Rua A, 10", ["10"]],
  ["53 Rua João Éboli", ["53"]],
  ["rua A 10 e rua B 20", ["10", "20"]],
  ["Rua A 10 bloco 2 apto 31, Rua B 20", ["10", "20"]],
  ["Rua A 10\nRua B 20, Rua C 30", ["10", "20", "30"]],
  ["Rua A, 10 - Gonzaga, Santos - SP, Rua B, 20 - Boqueirão, Santos - SP", ["10", "20"]],
  ["Rua A n 10; Rua B n 20", ["10", "20"]],
  ["Rua A número 10, Avenida B número 20", ["10", "20"]],
  ["RUA A 10 / RUA B 20", ["10", "20"]],
  ["Rua A    10,     Rua B   20", ["10", "20"]],
  ["Av Pres Wilson 100, Av Pres Vargas 200", ["100", "200"]],
  ["Praça da República 5, Largo do Rosário 9", ["5", "9"]],
  ["Rua A 10, Santos, Rua B 20, Santos", ["10", "20"]],
  ["Rua A 10 - Rua B 20 - Rua C 30", ["10", "20", "30"]],
  ["Rua Doutor Cochrane,197", ["197"]],
  ["Rua Tiro Naval S/N", ["∅"]],
  ["Rua A 10 casa 2, Rua B 20 fundos", ["10", "20"]],
  ["Alameda A 10, Estrada B 20, Travessa C 30, Viela D 40", ["10", "20", "30", "40"]],
  ["Rua A 10 (portaria), Rua B 20 (apto 3)", ["10", "20"]],
  ["Rua A, 10\nRua B, 20", ["10", "20"]],
  ["rua a 10 rua b 20 rua c 30", ["10", "20", "30"]],
  ["R. Xavier 10, R. Silva 20", ["10", "20"]],
];

describe("formatos de endereço colados: todos os números são identificados", () => {
  it.each(cases)("%j", (text, want) => {
    const p = prepareText(text);
    const got = mapRows(p.table, p.mapping).map((r) => (r.values.number ?? "∅") as string);
    expect(got).toEqual(want);
  });
});
