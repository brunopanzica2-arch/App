import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { mapRows, prepareText } from "../src/core/importer";

/** Escala do PARSE/normalização/consolidação de endereços (sem rede). Não mede geocodificação. Números medidos neste ambiente (Node, sem navegador). */
const base = readFileSync(new URL("../../test-data/cenario_300_cartas_centro_paqueta_vila_nova.csv", import.meta.url), "utf8").replace(/^﻿/, "").trim().split(/\r?\n/).slice(1)
  .map((l) => l.split(";")).map((c) => `${c[2]} ${c[3]}, ${c[5]}`);

describe("importação em escala (parse + normalização + consolidação)", () => {
  const out: Record<string, unknown>[] = [];
  for (const n of [1, 10, 28, 211, 300, 500, 1000]) {
    it(`${n} linhas`, () => {
      const lines = Array.from({ length: n }, (_, i) => base[i % base.length]);
      const text = lines.join("\n");
      const t0 = performance.now();
      const p = prepareText(text);
      const rows = mapRows(p.table, p.mapping);
      const ms = performance.now() - t0;
      const ok = rows.filter((r) => !r.errors.length);
      const keys = new Set(ok.map((r) => r.key));
      expect(rows.length).toBe(n);
      expect(ok.length).toBe(n);
      expect(keys.size).toBeLessThanOrEqual(Math.min(n, new Set(base).size));
      out.push({ linhas: n, lidas: rows.length, validas: ok.length, enderecosUnicos: keys.size, ms: Math.round(ms) });
      if (n === 1000) {
        mkdirSync(new URL("../../docs/evidencias-rotas/", import.meta.url), { recursive: true });
        writeFileSync(new URL("../../docs/evidencias-rotas/importacao_escala.json", import.meta.url), JSON.stringify({ nota: "Parse+normalização+consolidação, sem rede e sem geocodificação. Node, mesma máquina da suíte.", resultados: out }, null, 1));
      }
    });
  }
});
