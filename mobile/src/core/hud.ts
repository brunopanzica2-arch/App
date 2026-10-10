/** Texto do HUD (mesmas regras da fala nativa): sempre derivado da manobra real da rota, nunca gerado por modelo. */
export function hudText(kind: string, street: string, dist: number): { head: string; body: string } {
  const d = dist < 0 ? "" : dist >= 1000 ? `${(dist / 1000).toFixed(1).replace(".", ",")} km` : `${Math.max(10, Math.round(dist / 10) * 10)} m`;
  const where = street ? ` na ${street}` : "";
  const verb: Record<string, string> = {
    left: "Vire à esquerda", right: "Vire à direita", slight_left: "Mantenha-se à esquerda", slight_right: "Mantenha-se à direita",
    sharp_left: "Curva fechada à esquerda", sharp_right: "Curva fechada à direita", uturn: "Faça o retorno", straight: "Continue em frente", depart: "Siga em frente",
  };
  return { head: d ? `Em ${d}` : "Agora", body: `${verb[kind] ?? "Continue em frente"}${where}` };
}

export function precisionNote(code: string): string | null {
  switch (code) {
    case "entrance": case "pin": case "verified": return null;
    case "interpolated": return "Posição aproximada: próximo ao número. Confira o endereço.";
    default: return "Só a rua foi localizada. Procure o número no local.";
  }
}
