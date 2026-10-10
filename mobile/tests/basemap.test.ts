/** Integridade do pacote de mapa-base offline e do perfil legado. */
import "fake-indexeddb/auto";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { db } from "../src/core/db";
import { DEFAULT_PROFILE } from "../src/core/router";
import { getSettings } from "../src/core/service";

describe("pacote de mapa offline (public/map)", () => {
  const info = JSON.parse(readFileSync(new URL("../public/map/santos.pmtiles.json", import.meta.url), "utf8"));
  const buf = readFileSync(new URL("../public/map/santos.pmtiles", import.meta.url));
  it("tamanho e SHA-256 batem com o manifesto; é PMTiles v3 vetorial", () => {
    expect(buf.length).toBe(info.bytes);
    expect(createHash("sha256").update(buf).digest("hex")).toBe(info.sha256);
    expect(buf.subarray(0, 7).toString()).toBe("PMTiles");
    expect(buf[7]).toBe(3);
  });
  it("manifesto traz fonte, data, recorte, atribuição ODbL e política de atualização", () => {
    expect(info.fonte).toMatch(/^https:\/\/build\.protomaps\.com\/\d{8}\.pmtiles$/);
    expect(info.compilacao).toMatch(/^\d{8}$/);
    expect(info.recorte_bbox).toHaveLength(4);
    expect(info.atribuicao).toMatch(/OpenStreetMap/);
    expect(info.licenca).toMatch(/ODbL/);
    expect(info.atualizacao).toBeTruthy();
  });
});

describe("configurações legadas", () => {
  it("perfil salvo sem campos novos é completado com os padrões", async () => {
    await db.settings.put({ key: "main", profile: { ride_speed_kmh: 18 } } as never);
    const s = await getSettings();
    expect(s.profile.ride_speed_kmh).toBe(18);
    expect(s.profile).toEqual({ ...DEFAULT_PROFILE, ride_speed_kmh: 18 });
  });
});
