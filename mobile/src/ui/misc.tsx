import * as React from "react";
import { cn } from "./utils";

export function Card({ className, ...p }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("card p-4", className)} {...p} />;
}

export function Badge({ className, color, ...p }: React.HTMLAttributes<HTMLSpanElement> & { color?: string }) {
  return (
    <span
      className={cn("tint inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-semibold", className)}
      style={color ? ({ "--tint": color } as React.CSSProperties) : undefined}
      {...p}
    />
  );
}

export const Input = React.forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(
  ({ className, ...p }, ref) => (
    <input
      ref={ref}
      className={cn("h-11 w-full rounded-xl border border-app bg-transparent px-3 outline-none focus:border-brand", className)}
      {...p}
    />
  ),
);
Input.displayName = "Input";

export function Select({ className, ...p }: React.SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select
      className={cn("h-11 w-full rounded-xl border border-app bg-[var(--card)] px-3 outline-none focus:border-brand", className)}
      {...p}
    />
  );
}

export function Label({ className, ...p }: React.LabelHTMLAttributes<HTMLLabelElement>) {
  return <label className={cn("mb-1 block text-sm font-medium muted", className)} {...p} />;
}

export function Stat({ label, value, hint }: { label: string; value: React.ReactNode; hint?: string }) {
  return (
    <Card className="p-3">
      <div className="text-xs uppercase tracking-wide muted">{label}</div>
      <div className="mt-1 text-2xl font-bold">{value}</div>
      {hint && <div className="text-xs muted">{hint}</div>}
    </Card>
  );
}

export function Spinner({ label = "Carregando…" }: { label?: string }) {
  return (
    <div role="status" className="flex items-center gap-2 muted">
      <span className="h-4 w-4 animate-spin rounded-full border-2 border-brand border-t-transparent" />
      {label}
    </div>
  );
}

export function Alert({ kind = "info", children }: { kind?: "info" | "warn" | "error" | "ok"; children: React.ReactNode }) {
  const c = { info: "#2563eb", warn: "#b45309", error: "#dc2626", ok: "#16a34a" }[kind];
  return (
    <div role={kind === "error" ? "alert" : "status"} className="tint tint-box rounded-xl border px-3 py-2 text-sm" style={{ "--tint": c } as React.CSSProperties}>
      {children}
    </div>
  );
}

export function Progress({ value, label = "Progresso" }: { value: number; label?: string }) {
  return (
    <div className="h-2 w-full overflow-hidden rounded-full bg-black/10 dark:bg-white/10" role="progressbar" aria-label={label} aria-valuenow={Math.round(value * 100)} aria-valuemin={0} aria-valuemax={100}>
      <div className="h-full bg-brand" style={{ width: `${Math.min(100, Math.max(0, value * 100))}%` }} />
    </div>
  );
}
