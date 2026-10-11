// @vitest-environment jsdom
import "fake-indexeddb/auto";
import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { db, type Route } from "../src/core/db";
import { commitImport, parseText, suggestMapping } from "../src/core/importer";
import { saveSettings } from "../src/core/service";
import { __resetReady, dataReady } from "../src/intro/ready";
import { OfflineBanner } from "../src/ui/states";

// o mapa (WebGL) não roda no jsdom: troca por um marcador
vi.mock("../src/ui/RouteMap", () => ({ default: () => <div data-testid="map-stub" />, __esModule: true }));
import { MapHome } from "../src/pages/MapHome";

const CSV = "logradouro;numero;bairro;municipio\nRua Joaquim Távora;480;Vila Belmiro;Santos\nAvenida Ana Costa;100;Gonzaga;Santos\n";
const nav = vi.fn();

async function seed(withRoute: boolean) {
  const t = parseText(CSV);
  const b = await commitImport(t, suggestMapping(t.headers), "Teste", "2026-10-11", "csv");
  await saveSettings({ currentBatch: b.id, start: { label: "T", lat: -23.96, lon: -46.33, confirmed: true } });
  const letters = await db.letters.where("batchId").equals(b.id).toArray();
  const keys = [...new Set(letters.map((l) => l.addressKey!))];
  const addrs = keys.map((key, i) => ({ key, display: `${i ? "Avenida Ana Costa, 100" : "Rua Joaquim Távora, 480"} - Santos/SP`, original: "", street: i ? "Avenida Ana Costa" : "Rua Joaquim Távora", number: i ? "100" : "480",
    neighborhood: i ? "Gonzaga" : "Vila Belmiro", city: "Santos", cep: null, lat: -23.96 - i * 0.002, lon: -46.33, precision: "exact", confidence: 0.9, source: "teste", candidates: [], needsReview: false, reason: null, verifiedAt: null, confirmedAt: null }));
  await db.addresses.bulkPut(addrs as any);
  if (withRoute) {
    const route = { id: "r1", batchId: b.id, version: 1, status: "active", createdAt: new Date().toISOString(), parentId: null, reason: "plan", params: {}, start: { lat: -23.96, lon: -46.33 }, end: null,
      totalTime: 600, travelTime: 400, serviceTime: 200, totalDistance: 1200, metrics: { quality: { reviewed: true, reasons: [] } }, candidates: [], geojson: { type: "FeatureCollection", features: [] },
      stops: addrs.map((a, k) => ({ key: a.key, seq: k + 1, eta: 100 * k, legDistance: 100, legTime: 60, snapDistance: 5, access: 0, confidence: "high", flags: [] })), warnings: [] } as unknown as Route;
    await db.routes.add(route);
  }
}

class RO { observe() {} unobserve() {} disconnect() {} }
(globalThis as any).ResizeObserver = RO;

beforeEach(async () => { await Promise.all(db.tables.map((t) => t.clear())); __resetReady(); nav.mockReset(); Object.defineProperty(navigator, "onLine", { value: true, configurable: true }); });
afterEach(() => cleanup());

describe("estados da tela inicial", () => {
  it("VAZIO (primeira vez): botão grande 'Importar lista' e dados sinalizados como prontos", async () => {
    render(<MapHome nav={nav} />);
    expect(await screen.findByTestId("state-empty")).toBeInTheDocument();
    const btn = within(screen.getByTestId("state-empty")).getByRole("button", { name: /Importar lista/ });
    btn.click();
    expect(nav).toHaveBeenCalledWith("/importar");
    await waitFor(() => expect(dataReady()).toBe(true));
  });

  it("CARREGANDO: skeleton no formato do cartão (nunca spinner de tela cheia) até o cache responder", async () => {
    render(<MapHome nav={nav} />);
    expect(screen.getByTestId("home-loading")).toBeInTheDocument();
    expect(screen.getAllByTestId("stop-skeleton").length).toBeGreaterThan(0);
    await screen.findByTestId("state-empty");
    expect(screen.queryByTestId("home-loading")).toBeNull();
  });

  it("COM ROTA NO CACHE: abre direto na próxima parada, sem tela de espera, e sinaliza dados prontos", async () => {
    await seed(true);
    render(<MapHome nav={nav} />);
    await waitFor(() => expect(screen.getByTestId("cur-addr")).toBeInTheDocument());
    expect(screen.getByTestId("cur-addr").textContent).toMatch(/Joaquim|Ana Costa/);
    expect(screen.queryByTestId("home-loading")).toBeNull();
    expect(screen.queryByTestId("state-empty")).toBeNull();
    await waitFor(() => expect(dataReady()).toBe(true));
  });

  it("OFFLINE: banner honesto e o app continua mostrando as paradas do cache", async () => {
    await seed(true);
    Object.defineProperty(navigator, "onLine", { value: false, configurable: true });
    render(<MapHome nav={nav} />);
    expect(await screen.findByTestId("offline-banner")).toHaveTextContent(/Sem internet/);
    await waitFor(() => expect(screen.getByTestId("cur-addr")).toBeInTheDocument());
  });

  it("volta a ficar online: banner some", async () => {
    render(<OfflineBanner online={false} />);
    expect(screen.getByTestId("offline-banner")).toBeInTheDocument();
    cleanup();
    render(<OfflineBanner online />);
    expect(screen.queryByTestId("offline-banner")).toBeNull();
    await act(async () => {});
  });
});
