import { Component, type ErrorInfo, type ReactNode, useEffect, useState } from "react";

/** Skeleton no formato real do cartão de parada (número, endereço, bairro, selo). Só aparece depois de `delay` ms, para não piscar. */
export function StopSkeleton({ delay = 300 }: { delay?: number }) {
  const [show, setShow] = useState(delay <= 0);
  useEffect(() => { if (delay <= 0) return; const t = setTimeout(() => setShow(true), delay); return () => clearTimeout(t); }, [delay]);
  return (
    <div className="card flex items-center gap-3 p-3" data-testid="stop-skeleton" aria-hidden="true" style={{ visibility: show ? "visible" : "hidden" }}>
      <span className="sk h-10 w-10 shrink-0 rounded-full" />
      <span className="grid flex-1 gap-2">
        <span className="sk h-5 w-4/5 rounded" />
        <span className="sk h-3.5 w-3/5 rounded" />
      </span>
      <span className="sk h-6 w-14 rounded-full" />
    </div>
  );
}

/** Lista de skeletons (6 por padrão). O contêiner anuncia "Carregando paradas" para leitor de tela. */
export function StopListSkeleton({ count = 6, delay = 300 }: { count?: number; delay?: number }) {
  return (
    <div className="grid gap-2" role="status" aria-live="polite" aria-label="Carregando paradas" data-testid="stop-list-skeleton">
      {Array.from({ length: count }, (_, i) => <StopSkeleton key={i} delay={delay} />)}
    </div>
  );
}

/** Banner discreto de conexão. O app é local-first: marcar entregas e importar continuam funcionando; só consultas de endereço/mapa online esperam. */
export function OfflineBanner({ online: forced }: { online?: boolean }) {
  const [online, setOnline] = useState(() => forced ?? (typeof navigator === "undefined" || navigator.onLine !== false));
  useEffect(() => {
    if (forced !== undefined) { setOnline(forced); return; }
    const on = () => setOnline(true), off = () => setOnline(false);
    window.addEventListener("online", on); window.addEventListener("offline", off);
    return () => { window.removeEventListener("online", on); window.removeEventListener("offline", off); };
  }, [forced]);
  if (online) return null;
  return (
    <div role="status" aria-live="polite" data-testid="offline-banner"
      className="pointer-events-auto flex items-center gap-2 bg-amber-100 px-3 py-2 text-sm font-semibold text-amber-900">
      <span aria-hidden="true">●</span>
      <span>Sem internet · tudo continua salvo neste aparelho. Buscas de endereço retomam quando voltar.</span>
    </div>
  );
}

export interface Step { label: string; state: "done" | "active" | "todo"; detail?: string }

/** Progresso por etapas REAIS. Barra determinada só quando há contagem (done/total); senão, indeterminada com o texto da etapa. */
export function StepProgress({ title, steps, done, total, onCancel, hint }: { title: string; steps: Step[]; done?: number; total?: number; onCancel?: () => void; hint?: string }) {
  const determinate = typeof done === "number" && typeof total === "number" && total > 0;
  const pct = determinate ? Math.min(100, Math.round((done! / total!) * 100)) : null;
  return (
    <div className="card p-4" role="status" aria-live="polite" data-testid="step-progress">
      <div className="mb-2 text-lg font-bold">{title}</div>
      <ol className="mb-3 grid gap-1 text-sm">
        {steps.map((s, i) => (
          <li key={i} className={s.state === "todo" ? "muted" : "font-semibold"} aria-current={s.state === "active" ? "step" : undefined}>
            <span aria-hidden="true">{s.state === "done" ? "✓" : s.state === "active" ? "●" : "○"} </span>
            {s.label}{s.detail ? ` ${s.detail}` : ""}
          </li>
        ))}
      </ol>
      <div className="h-2 overflow-hidden rounded-full bg-black/10" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct ?? undefined} aria-label={title}>
        <div className={pct === null ? "sk-indet h-full w-1/3 rounded-full bg-[var(--color-brand)]" : "h-full rounded-full bg-[var(--color-brand)]"} style={pct === null ? undefined : { width: `${pct}%`, transition: "width .2s linear" }} />
      </div>
      {hint && <div className="mt-2 text-xs muted">{hint}</div>}
      {onCancel && <button type="button" onClick={onCancel} className="mt-3 h-12 w-full rounded-xl border border-app font-semibold">Cancelar</button>}
    </div>
  );
}

/** Error Boundary: nunca tela branca. Mensagem simples em português + "Tentar de novo"; detalhes técnicos só no console. Os dados locais não são apagados. */
export class ErrorBoundary extends Component<{ children: ReactNode; onRetry?: () => void; area?: string }, { err: Error | null }> {
  state = { err: null as Error | null };
  static getDerivedStateFromError(err: Error) { return { err }; }
  componentDidCatch(err: Error, info: ErrorInfo) { console.error(`[ErrorBoundary${this.props.area ? ":" + this.props.area : ""}]`, err, info.componentStack); }
  retry = () => { this.setState({ err: null }); this.props.onRetry?.(); };
  render() {
    if (!this.state.err) return this.props.children;
    return (
      <div role="alert" className="mx-auto grid max-w-md gap-3 p-6 text-center" data-testid="error-boundary">
        <h2 className="text-xl font-bold">Algo deu errado</h2>
        <p className="muted">Não foi possível abrir esta tela. Suas cartas e entregas continuam salvas neste aparelho.</p>
        <button type="button" onClick={this.retry} className="h-14 rounded-xl bg-[var(--color-brand)] px-5 text-lg font-semibold text-white">Tentar de novo</button>
        <button type="button" onClick={() => location.reload()} className="h-12 rounded-xl border border-app font-semibold">Recarregar o app</button>
      </div>
    );
  }
}
