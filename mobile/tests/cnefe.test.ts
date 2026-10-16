import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import { type CnefeDb, keyOf, lookupCnefe, num2wordsPt, parseCnefe } from "../src/core/cnefe";

let db: CnefeDb;
beforeAll(() => { const b = readFileSync(new URL("../public/santos-enderecos.bin", import.meta.url)); db = parseCnefe(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer); });

// exatamente como o usuário digitou (sem acento, abreviações, caixa)
const LISTA: [string, string][] = [
  ["rua João eboli", "53"], ["avenida conselheiro nebias", "78"], ["rua doutor cochrane", "197"], ["rua tiro naval", "8"], ["avenida nebias", "95"],
  ["rua sete de setembro", "35"], ["rua cerquinho", "21"], ["rua são Paulo", "94"], ["rua doutor cesario Bastos", "1"], ["rua Antonio bento", "278"],
  ["rua antonio bento", "234"], ["rua silveira lobo", "15"], ["rua são Paulo", "37"], ["rua Joaquim Nabuco", "5"], ["rua general camara", "85"],
  ["rua professor Manuel de Abreu", "117"], ["rua capitão Adolfo Millon", "12"],
];

describe("base IBGE/CNEFE de Santos", () => {
  it("carrega: ≥ 50 mil números e ≥ 1.000 logradouros, com fonte citada", () => {
    expect(db.num.length).toBeGreaterThan(50000);
    expect(db.streets.length).toBeGreaterThan(1000);
    expect(db.meta.fonte).toMatch(/IBGE/);
  });
  it.each(LISTA)("%s %s → número localizado (ponto do endereço ou face da quadra)", (street, number) => {
    const r = lookupCnefe(db, { street, number });
    expect(["exact", "face"], r.reason).toContain(r.kind);
    expect(r.lat).toBeLessThan(-23.9); expect(r.lat).toBeGreaterThan(-24.05);
    expect(r.lon).toBeLessThan(-46.2); expect(r.lon).toBeGreaterThan(-46.45);
  });
  it("completa o nome oficial: 'avenida nebias' → Avenida Conselheiro Nébias (avisa que ajustou)", () => {
    const r = lookupCnefe(db, { street: "avenida nebias", number: "95" });
    expect(r.street).toMatch(/Conselheiro Nebias/i);
    expect(r.nameAdjusted).toBe(true);
    expect(lookupCnefe(db, { street: "avenida conselheiro nebias", number: "78" }).nameAdjusted).toBe(false);
  });
  it("prefere o nome IGUAL ao parecido: 'Antonio Bento' ≠ 'Antonio Bento de Amorim'; 'São Paulo' ≠ 'São Vicente de Paulo'", () => {
    expect(lookupCnefe(db, { street: "rua antonio bento", number: "278" }).street).toMatch(/Antonio Bento$/i);
    expect(lookupCnefe(db, { street: "rua são paulo", number: "94" }).street).toMatch(/Sao Paulo$/i);
  });
  it("'Pastor Narciso de Andrade 42': não existe com esse título — NÃO aceita sozinho, pede confirmação", () => {
    const r = lookupCnefe(db, { street: "rua pastor narciso de Andrade", number: "42" });
    expect(["ambiguous", "street", "none"]).toContain(r.kind);
    if (r.kind === "ambiguous") expect(r.reason).toMatch(/Confirme|confirme/);
  });
  it("número que não existe: estima entre vizinhos da mesma rua ou diz que só a rua existe (nunca inventa porta)", () => {
    const r = lookupCnefe(db, { street: "avenida conselheiro nebias", number: "79" });
    expect(["estimated", "exact", "face"]).toContain(r.kind);
    const far = lookupCnefe(db, { street: "rua tiro naval", number: "99999" });
    expect(far.kind).toBe("street");
    expect(far.lat).toBeUndefined();
  });
  it("rua inexistente: none", () => { expect(lookupCnefe(db, { street: "rua Zzxqw Pplmk", number: "10" }).kind).toBe("none"); });
  it("erro de digitação ('Nebas') acha a rua mas NUNCA é aceito sozinho: pede confirmação", () => {
    const r = lookupCnefe(db, { street: "avenida conselheiro nebas", number: "78" });
    expect(r.kind).toBe("ambiguous");
    expect(r.street).toMatch(/Nebias/i);
  });
  it("nome parecido de OUTRA rua ('Bobos' ~ 'Villa Lobos') não vira ponto com número", () => {
    const r = lookupCnefe(db, { street: "rua dos Bobos", number: "134" });
    expect(["exact", "face", "estimated"]).not.toContain(r.kind);
    expect(r.lat).toBeUndefined();
  });
  it("dígitos x palavras: 'Rua 7 de Setembro' = 'Rua Sete de Setembro'", () => {
    const a = lookupCnefe(db, { street: "rua 7 de setembro", number: "35" }), b = lookupCnefe(db, { street: "rua sete de setembro", number: "35" });
    expect(a.lat).toBe(b.lat);
    expect(keyOf("Rua 28 de Setembro")).toBe("RUA VINTE E OITO DE SETEMBRO");
    expect(num2wordsPt(31)).toBe("trinta e um");
  });
  it("sufixo: '480A' cai no número base quando a letra não existe", () => {
    const r = lookupCnefe(db, { street: "avenida conselheiro nebias", number: "78A" });
    expect(["exact", "face"]).toContain(r.kind);
  });
  it("desempenho: 2.000 consultas em < 1,5 s", () => {
    const t = performance.now();
    for (let i = 0; i < 2000; i++) lookupCnefe(db, LISTA[i % LISTA.length].length ? { street: LISTA[i % LISTA.length][0], number: LISTA[i % LISTA.length][1] } : { street: "x", number: "1" });
    expect(performance.now() - t).toBeLessThan(1500);
  });

  it("ruas/bairros homônimos (ex.: 'Rua Um' em vários bairros): NÃO faz média; pede o bairro e, com o bairro, resolve", () => {
    // acha um (rua, nº) real que existe em 2+ bairros a mais de 300 m
    let found: { street: string; num: number; locs: string[] } | null = null;
    for (let s = 0; s < db.streets.length && !found; s++) {
      const m = new Map<number, number[]>();
      for (let i = db.start[s]; i < db.start[s + 1]; i++) if (db.suf[i] === 0) (m.get(db.num[i]) ?? m.set(db.num[i], []).get(db.num[i])!).push(i); // só sem sufixo (480A ≠ 480)
      for (const [num, idxs] of m) {
        if (idxs.length < 2) continue;
        const far = idxs.some((a) => idxs.some((b) => Math.hypot(db.lat[a] - db.lat[b], db.lon[a] - db.lon[b]) > 3000)); // ~300 m em 1e-6 grau ≈ 2.700 unidades
        if (far) { found = { street: `${db.streets[s].t.toLowerCase()} ${db.streets[s].n.toLowerCase()}`, num, locs: idxs.map((i) => db.localities[db.loc[i]]) }; break; }
      }
    }
    expect(found, "a base deve conter homônimos").not.toBeNull();
    const r = lookupCnefe(db, { street: found!.street, number: String(found!.num) });
    expect(r.kind).toBe("ambiguous");
    expect(r.lat).toBeUndefined();
    expect(r.candidates.length).toBeGreaterThanOrEqual(2);
    const r2 = lookupCnefe(db, { street: found!.street, number: String(found!.num), neighborhood: found!.locs[0] });
    expect(["exact", "face"]).toContain(r2.kind);
    expect(r2.locality).toBe(found!.locs[0]);
  });
  it("a média de bairros diferentes não existe mais: nenhum registro tem coordenada fora de Santos", () => {
    let bad = 0;
    for (let i = 0; i < db.num.length; i++) if (db.lat[i] / 1e6 > -23.7 || db.lat[i] / 1e6 < -24.1 || db.lon[i] / 1e6 > -46.2 || db.lon[i] / 1e6 < -46.5) bad++;
    expect(bad).toBe(0);
  });

  it("grafias equivalentes (Luiz/Luis, Anna/Ana, Glycerio/Glicerio, Arthur/Artur, Adolpho/Adolfo) casam com o nome do IBGE", () => {
    const casos: [string, string, RegExp][] = [
      ["avenida doutor claudio luis da costa", "50", /Claudio/i], ["avenida general francisco glycerio", "121", /Glicerio/i],
      ["rua doutor arthur porchat de assis", "14", /Artur Porchat/i], ["avenida ana costa", "464", /Anna Costa/i], ["rua doutor adolpho assis", "10", /Adolpho Assis/i],
    ];
    for (const [rua, n, re] of casos) { const r = lookupCnefe(db, { street: rua, number: n }); expect(r.street, `${rua} ${n}: ${r.reason}`).toMatch(re); }
  });
  it("título a mais no digitado ('Rua Doutor Oswaldo Cruz' × 'Rua Oswaldo Cruz') acha o número na rua certa, com aviso de nome", () => {
    const r = lookupCnefe(db, { street: "rua oswaldo cruz", number: "319" });
    expect(["exact", "face"]).toContain(r.kind);
    expect(r.street).toMatch(/Doutor Oswaldo Cruz/i);
    expect(r.nameAdjusted).toBe(true);
  });
  it("algarismos romanos NÃO se confundem: 'Dom Pedro I' ≠ 'Dom Pedro II'", () => {
    const a = lookupCnefe(db, { street: "rua dom pedro i", number: "50" }), b = lookupCnefe(db, { street: "rua dom pedro ii", number: "50" });
    if (a.street) expect(a.street).not.toMatch(/Pedro Ii$/i);
    if (b.street) expect(b.street).toMatch(/Pedro Ii$/i);
  });
  it("tipo diferente não é aceito sozinho ('Rua Pastor X' × 'Praça X') — já coberto; e 'Rua São Paulo' nunca vira 'São Vicente de Paulo'", () => {
    const r = lookupCnefe(db, { street: "rua sao paulo", number: "999999" });
    expect(r.street ?? "").not.toMatch(/Vicente/i);
  });
});
