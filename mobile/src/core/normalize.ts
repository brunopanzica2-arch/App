/** Normalização de endereços (porta de backend/app/services/normalize.py). */

const STREET_TYPES: Record<string, string> = {
  R: "RUA", RUA: "RUA", AV: "AVENIDA", AVE: "AVENIDA", AVN: "AVENIDA", AVENIDA: "AVENIDA",
  PC: "PRACA", PCA: "PRACA", PRACA: "PRACA", TV: "TRAVESSA", TRV: "TRAVESSA", TRAV: "TRAVESSA",
  TRAVESSA: "TRAVESSA", AL: "ALAMEDA", ALAMEDA: "ALAMEDA", EST: "ESTRADA", ESTR: "ESTRADA",
  ESTRADA: "ESTRADA", ROD: "RODOVIA", RODOVIA: "RODOVIA", LG: "LARGO", LGO: "LARGO", LARGO: "LARGO",
  VD: "VIADUTO", VIADUTO: "VIADUTO", PQ: "PARQUE", PRQ: "PARQUE", PARQUE: "PARQUE", VL: "VILA",
  VILA: "VILA", PASSAGEM: "PASSAGEM", PSG: "PASSAGEM", BC: "BECO", BECO: "BECO", LADEIRA: "LADEIRA",
  LD: "LADEIRA", CJ: "CONJUNTO", CONJUNTO: "CONJUNTO", PRAIA: "PRAIA", PCT: "PRACETA",
  PRACETA: "PRACETA", VIELA: "VIELA", VLA: "VIELA", CAMINHO: "CAMINHO", SERVIDAO: "SERVIDAO",
};
const TITLES: Record<string, string> = {
  DR: "DOUTOR", DRA: "DOUTORA", PROF: "PROFESSOR", PROFA: "PROFESSORA", CEL: "CORONEL", GAL: "GENERAL",
  GEN: "GENERAL", MAL: "MARECHAL", ENG: "ENGENHEIRO", PRES: "PRESIDENTE", STA: "SANTA", STO: "SANTO",
  CONS: "CONSELHEIRO", CONSELH: "CONSELHEIRO", VISC: "VISCONDE", BRIG: "BRIGADEIRO", DES: "DESEMBARGADOR",
  MIN: "MINISTRO", SEN: "SENADOR", DEP: "DEPUTADO", ALM: "ALMIRANTE", CAP: "CAPITAO", TEN: "TENENTE",
  CMTE: "COMANDANTE", COM: "COMENDADOR", MONS: "MONSENHOR", PE: "PADRE", SGTO: "SARGENTO", BAR: "BARAO",
  VER: "VEREADOR", GOV: "GOVERNADOR", N: "NOSSA", NSA: "NOSSA", SRA: "SENHORA", SR: "SENHOR",
};

export const stripAccents = (s: string) => s.normalize("NFKD").replace(/[̀-ͯ]/g, "");
export const clean = (s?: string | null) => (s ?? "").replace(/ /g, " ").replace(/\s+/g, " ").trim();
export const normText = (s?: string | null) =>
  clean(stripAccents(clean(s)).toUpperCase().replace(/[^\w\s/-]/g, " "));

export function normalizeCep(raw?: string | null): [string | null, string | null] {
  if (!clean(raw)) return [null, null];
  const d = (raw ?? "").replace(/\D/g, "");
  if (d.length !== 8) return [null, `CEP inválido: ${raw}`];
  return [`${d.slice(0, 5)}-${d.slice(5)}`, null];
}

export function normalizeNumber(raw?: string | number | null): [string | null, string | null] {
  let s = clean(raw == null ? "" : String(raw));
  if (!s) return [null, "Número ausente"];
  if (/^\d+\.0$/.test(s)) s = s.slice(0, -2);
  if (/^(S\s*\/?\s*N|SN|SEM\s+N[UÚ]MERO)$/i.test(s)) return [null, "Sem número (S/N)"];
  const m = s.match(/^\s*(\d{1,6})\s*([A-Za-z]?)\b/);
  if (!m) return [null, `Número não reconhecido: ${s}`];
  return [(m[1].replace(/^0+/, "") || "0") + m[2].toUpperCase(), null];
}

export function splitStreet(raw?: string | null): [string | null, string] {
  let tokens = normText(raw).replace(/\//g, " ").split(" ").filter(Boolean);
  if (!tokens.length) return [null, ""];
  let type: string | null = null;
  const first = tokens[0].replace(/\.$/, "");
  if (STREET_TYPES[first] && tokens.length > 1) {
    type = STREET_TYPES[first];
    tokens = tokens.slice(1);
  }
  return [type, tokens.map((t, i) => (i < tokens.length - 1 ? TITLES[t] ?? t : t)).join(" ")];
}

export const pretty = (s: string) =>
  s.split(" ").filter(Boolean).map((w, i) => (["DE", "DA", "DO", "DAS", "DOS", "E"].includes(w) && i ? w.toLowerCase() : w[0] + w.slice(1).toLowerCase())).join(" ");

export interface NormalizedAddress {
  type: string | null;
  name: string;
  number: string | null;
  neighborhood: string | null;
  city: string;
  state: string;
  cep: string | null;
  original: string;
  issues: string[];
  errors: string[];
  key: string;
  display: string;
  street: string; // "Rua Fulano" (para consulta)
}

export function normalizeAddress(street?: string | null, number?: string | null, neighborhood?: string | null,
  city?: string | null, cep?: string | null, defaultCity = "Santos", defaultState = "SP"): NormalizedAddress {
  const original = [street, number, neighborhood, city, cep].map((x) => clean(x == null ? "" : String(x))).filter(Boolean).join(" | ");
  const errors: string[] = [];
  const issues: string[] = [];
  const [type, name] = splitStreet(street);
  if (!name) errors.push("Logradouro ausente");
  else if (/^\d+$/.test(name) && !type) errors.push("Logradouro é só um número: coluna deslocada ou mapeamento errado?");
  const [num, ni] = normalizeNumber(number);
  if (ni) issues.push(ni);
  const [cepN, ci] = normalizeCep(cep);
  if (ci) issues.push(ci);
  let cityRaw = clean(city) || defaultCity;
  let state = defaultState;
  const m = cityRaw.match(/^(.*?)\s*[/-]\s*([A-Za-z]{2})$/);
  if (m) {
    cityRaw = m[1];
    state = m[2].toUpperCase();
  }
  if (normText(cityRaw) !== normText(defaultCity)) issues.push(`Município diferente do padrão: ${cityRaw}`);
  const streetPretty = [type ? pretty(type) : "", pretty(name)].filter(Boolean).join(" ");
  const nb = clean(neighborhood) || null;
  const display = [streetPretty + (num ? `, ${num}` : ", S/N"), nb ? pretty(normText(nb)) : null,
    `${pretty(normText(cityRaw))}/${state}`, cepN].filter(Boolean).join(" - ");
  return {
    type, name, number: num, neighborhood: nb, city: cityRaw, state, cep: cepN, original, issues, errors,
    key: [type ?? "", name, num ?? "S/N", normText(cityRaw), state].join("|"),
    display, street: streetPretty,
  };
}

/** "Rua X, 480, apto 12 - Bairro, Santos/SP, 11075-301" */
export function parseAddressLine(line: string) {
  line = clean(line);
  const out: Record<string, string | null> = { street: null, number: null, complement: null, neighborhood: null, city: null, cep: null };
  const cm = line.match(/\b(\d{5})-?(\d{3})\b/);
  if (cm) {
    out.cep = cm[0];
    line = clean(line.replace(cm[0], "")).replace(/^[ ,-]+|[ ,-]+$/g, "");
  }
  const m = line.match(/^([^,]+?)\s*,\s*((?:\d+\s*[A-Za-z]?)|S\s*\/?\s*N)\b\s*(.*)$/i);
  if (!m) {
    out.street = line || null;
    return out;
  }
  out.street = m[1];
  out.number = m[2];
  let rest = m[3].split(/\s*[,;]\s*|\s+-\s+/).map(clean).filter(Boolean);
  let cityIdx = -1;
  rest.forEach((p, i) => {
    if (/\/\s*[A-Za-z]{2}$/.test(p) || normText(p) === "SANTOS") cityIdx = i;
  });
  if (cityIdx >= 0) {
    out.city = rest[cityIdx];
    rest = rest.filter((_, i) => i !== cityIdx);
  }
  const compRe = /^(AP|APTO|APT|APARTAMENTO|BL|BLOCO|CASA|FUNDOS|SALA|CJ|LOJA|ANDAR|TORRE)\b/i;
  const comps = rest.filter((p) => compRe.test(stripAccents(p)));
  const others = rest.filter((p) => !comps.includes(p));
  out.complement = comps.join(", ") || null;
  out.neighborhood = others.at(-1) ?? null;
  if (others.length > 1) out.complement = [out.complement, ...others.slice(0, -1)].filter(Boolean).join(", ");
  return out;
}
