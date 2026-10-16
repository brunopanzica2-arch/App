import { describe, expect, it } from "vitest";
import { parseVoiceCommand } from "../src/native/rotaNav";

describe("comandos de voz (pt-BR) como o reconhecedor do Android devolve", () => {
  it.each([
    ["repetir", "repeat"], ["Repete", "repeat"], ["repita a instrução", "repeat"], ["pode repetir", "repeat"],
    ["próxima entrega", "next"], ["próximo", "next"], ["qual a próxima", "next"], ["de novo", "repeat"], ["próxima parada", "next"], ["Próxima", "next"],
    ["quanto falta", "remaining"], ["falta quanto", "remaining"], ["quanto falta para terminar", "remaining"],
    ["pular", "skip"], ["pula essa", "skip"], ["pular entrega", "skip"],
    ["pausar", "pause"], ["pausa a navegação", "pause"], ["retomar", "resume"], ["continuar", "resume"],
    ["marcar entregue", "deliver"], ["entregue", "deliver"], ["marcar entrega", "deliver"],
  ])("%j → %s", (frase, cmd) => { expect(parseVoiceCommand(frase)).toBe(cmd); });

  it("frases fora do vocabulário NÃO disparam ação", () => {
    for (const f of ["", "bom dia", "qual é o endereço", "abrir o mapa", "oi"]) expect(parseVoiceCommand(f)).toBe("unknown");
  });
  it("'entregue' só PEDE confirmação (a tela confirma); nunca marca sozinho — ver MapHome.voice()", () => {
    expect(parseVoiceCommand("entregue")).toBe("deliver");
  });
});
