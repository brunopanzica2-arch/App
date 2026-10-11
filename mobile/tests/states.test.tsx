// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ErrorBoundary, OfflineBanner, StepProgress, StopListSkeleton, StopSkeleton } from "../src/ui/states";

beforeEach(() => vi.useFakeTimers());
afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); });

describe("Skeleton de parada", () => {
  it("só aparece depois de ~300 ms (sem piscada)", () => {
    render(<StopSkeleton />);
    expect(screen.getByTestId("stop-skeleton")).toHaveStyle({ visibility: "hidden" });
    act(() => { vi.advanceTimersByTime(300); });
    expect(screen.getByTestId("stop-skeleton")).toHaveStyle({ visibility: "visible" });
  });
  it("lista com 6 cartões no formato real e anúncio de carregamento", () => {
    render(<StopListSkeleton />);
    expect(screen.getAllByTestId("stop-skeleton")).toHaveLength(6);
    expect(screen.getByRole("status", { name: "Carregando paradas" })).toBeInTheDocument();
  });
});

describe("Banner offline", () => {
  it("online: nada", () => { render(<OfflineBanner online />); expect(screen.queryByTestId("offline-banner")).toBeNull(); });
  it("sem internet: banner honesto (o app continua salvo no aparelho)", () => {
    render(<OfflineBanner online={false} />);
    expect(screen.getByTestId("offline-banner")).toHaveTextContent(/Sem internet/);
    expect(screen.getByTestId("offline-banner")).toHaveTextContent(/salvo neste aparelho/);
  });
  it("reage a eventos online/offline", () => {
    Object.defineProperty(navigator, "onLine", { value: true, configurable: true });
    render(<OfflineBanner />);
    expect(screen.queryByTestId("offline-banner")).toBeNull();
    act(() => { window.dispatchEvent(new Event("offline")); });
    expect(screen.getByTestId("offline-banner")).toBeInTheDocument();
    act(() => { window.dispatchEvent(new Event("online")); });
    expect(screen.queryByTestId("offline-banner")).toBeNull();
  });
});

describe("Progresso por etapas", () => {
  const steps = [
    { label: "Importadas 187 cartas", state: "done" as const },
    { label: "Localizando endereços", detail: "124/187", state: "active" as const },
    { label: "Calcular a melhor rota", state: "todo" as const },
  ];
  it("mostra etapas reais e barra determinada com contagem", () => {
    render(<StepProgress title="Preparando suas entregas" steps={steps} done={124} total={187} />);
    expect(screen.getByText(/Localizando endereços 124\/187/)).toBeInTheDocument();
    expect(screen.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "66");
    expect(screen.getByText(/Localizando endereços/).closest("li")).toHaveAttribute("aria-current", "step");
  });
  it("sem contagem: barra indeterminada (sem valor falso)", () => {
    render(<StepProgress title="Calculando rota" steps={steps} />);
    expect(screen.getByRole("progressbar")).not.toHaveAttribute("aria-valuenow");
  });
  it("Cancelar chama o callback", () => {
    const onCancel = vi.fn();
    render(<StepProgress title="x" steps={steps} onCancel={onCancel} />);
    fireEvent.click(screen.getByRole("button", { name: "Cancelar" }));
    expect(onCancel).toHaveBeenCalledOnce();
  });
});

describe("Error Boundary", () => {
  function Bomb({ boom }: { boom: boolean }) { if (boom) throw new Error("falha técnica secreta"); return <p>tela ok</p>; }
  function Harness() {
    const [boom, setBoom] = useState(true);
    return <ErrorBoundary onRetry={() => setBoom(false)}><Bomb boom={boom} /></ErrorBoundary>;
  }
  it("erro: mensagem simples em português, sem detalhe técnico, e 'Tentar de novo' recupera", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    render(<Harness />);
    expect(screen.getByRole("alert")).toHaveTextContent("Algo deu errado");
    expect(screen.getByRole("alert")).not.toHaveTextContent("secreta");
    expect(screen.getByRole("alert")).toHaveTextContent(/continuam salvas/);
    fireEvent.click(screen.getByRole("button", { name: "Tentar de novo" }));
    expect(screen.getByText("tela ok")).toBeInTheDocument();
  });
});
