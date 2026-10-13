import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { mapRows, prepareText } from "../src/core/importer";

/** Propriedade: N endereços colados com separadores variados (numa linha só) → exatamente N números, na mesma ordem. */
const base = readFileSync(new URL("../../test-data/cenario_300_cartas_centro_paqueta_vila_nova.csv", import.meta.url), "utf8").replace(/^﻿/, "").trim().split(/\r?\n/).slice(1)
  .map((l) => l.split(";")).map((c) => ({ rua: c[2], num: c[3] }));
const SEPS = [", ", "; ", " | ", " e ", " - ", " / ", "  ", ",", "\n"];
let seed = 12345;
const rnd = () => (seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296;

describe("propriedade: N endereços numa linha → N números", () => {
  for (const n of [2, 10, 28, 150, 300]) {
    it(`${n} endereços com separadores misturados`, () => {
      const items = Array.from({ length: n }, (_, i) => base[(i * 7) % base.length]);
      const text = items.map((x, i) => `${x.rua} ${x.num}` + (i < n - 1 ? SEPS[Math.floor(rnd() * SEPS.length)] : "")).join("");
      const p = prepareText(text);
      const got = mapRows(p.table, p.mapping).map((r) => r.values.number);
      expect(got).toEqual(items.map((x) => x.num));
    });
  }
});
