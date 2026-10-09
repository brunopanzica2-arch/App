"use client";

import { CheckCircle2, RefreshCw } from "lucide-react";
import { useParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import { AppShell } from "@/components/AppShell";
import { RouteMapLazy } from "@/components/Map";
import { Button } from "@/components/ui/button";
import { Alert, Badge, Card, Progress, Select, Spinner } from "@/components/ui/misc";
import { api, waitJob } from "@/lib/api";
import { PRECISION_LABEL } from "@/lib/utils";

const PCOLOR: Record<string, string> = {
  exact: "#16a34a", manual: "#16a34a", interpolated: "#2563eb", street: "#b45309",
  neighborhood: "#dc2626", not_found: "#dc2626", pending: "#6b7280",
};

export default function AddressReview() {
  const { id } = useParams<{ id: string }>();
  const [filter, setFilter] = useState<"review" | "all">("review");
  const [items, setItems] = useState<any[] | null>(null);
  const [sel, setSel] = useState<any>(null);
  const [pin, setPin] = useState<{ lat: number; lon: number } | null>(null);
  const [msg, setMsg] = useState<{ kind: "ok" | "error" | "info"; text: string } | null>(null);
  const [progress, setProgress] = useState<number | null>(null);

  const load = useCallback(async () => {
    const q = filter === "review" ? "?needs_review=true" : "";
    setItems(await api(`/api/batches/${id}/addresses${q}`));
  }, [id, filter]);

  useEffect(() => { void load(); }, [load]);

  function select(a: any) {
    setSel(a);
    setPin(a.lat != null ? { lat: a.lat, lon: a.lon } : { lat: -23.962, lon: -46.333 });
  }

  async function confirm() {
    if (!sel || !pin) return;
    try {
      const a = await api(`/api/addresses/${sel.id}/confirm`, { method: "POST", json: pin });
      setMsg({ kind: "ok", text: `Posição confirmada: ${a.normalized_text}` });
      setSel(null);
      await api(`/api/batches/${id}/consolidate`, { method: "POST" });
      await load();
    } catch (e: any) {
      setMsg({ kind: "error", text: e.message });
    }
  }

  async function geocodeAll() {
    try {
      setProgress(0);
      const j = await api(`/api/batches/${id}/geocode`, { method: "POST" });
      const r = await waitJob(j.id, setProgress);
      setMsg({ kind: "ok", text: `Geocodificação: ${r.result.addresses} imóveis, ${r.result.consolidation.stops} paradas.` });
      await load();
    } catch (e: any) {
      setMsg({ kind: "error", text: e.message });
    } finally {
      setProgress(null);
    }
  }

  const candidates = useMemo(() => (sel?.candidates || []).map((c: any) => ({ lat: c.lat, lon: c.lon, label: `${c.label} (${PRECISION_LABEL[c.precision] || c.precision})` })), [sel]);

  return (
    <AppShell title="Validação de endereços" wide>
      <div className="mb-3 flex flex-wrap gap-2">
        <Select value={filter} onChange={(e) => setFilter(e.target.value as any)} className="w-auto" aria-label="Filtro">
          <option value="review">Precisam de revisão</option>
          <option value="all">Todos os endereços do lote</option>
        </Select>
        <Button variant="secondary" onClick={geocodeAll} disabled={progress !== null}><RefreshCw className="h-4 w-4" /> Geocodificar pendentes</Button>
      </div>
      {progress !== null && <div className="mb-3"><Progress value={progress} /></div>}
      {msg && <div className="mb-3"><Alert kind={msg.kind}>{msg.text}</Alert></div>}
      <div className="grid gap-4 lg:grid-cols-[minmax(320px,420px)_1fr]">
        <div className="max-h-[75vh] space-y-2 overflow-y-auto pr-1">
          {!items && <Spinner />}
          {items?.length === 0 && <Card>Nenhum endereço {filter === "review" ? "pendente de revisão" : ""}.</Card>}
          {items?.map((a) => (
            <button key={a.id} onClick={() => select(a)} className={`card w-full p-3 text-left ${sel?.id === a.id ? "!border-brand" : ""}`}>
              <div className="font-semibold">{a.normalized_text}</div>
              <div className="mt-1 flex flex-wrap items-center gap-2 text-xs">
                <Badge color={PCOLOR[a.precision]}>{PRECISION_LABEL[a.precision] || a.precision}</Badge>
                <span className="muted">confiança {Math.round(a.confidence * 100)}% · {a.correspondences} carta(s)</span>
              </div>
              {a.review_reason && <div className="mt-1 text-xs text-amber-700 dark:text-amber-400">{a.review_reason}</div>}
            </button>
          ))}
        </div>
        <div>
          <RouteMapLazy className="h-[55vh] w-full overflow-hidden rounded-2xl" candidates={candidates} pin={pin} onPinMove={(lat, lon) => setPin({ lat, lon })} />
          {sel ? (
            <Card className="mt-3 space-y-2">
              <div className="font-semibold">{sel.normalized_text}</div>
              <div className="text-sm muted">Original: {sel.original_text}</div>
              <div className="text-sm">Fonte: {sel.source || "—"} · {PRECISION_LABEL[sel.precision]}</div>
              {candidates.length > 1 && <div className="text-sm">Candidatos no mapa: {candidates.map((c: any, i: number) => <div key={i}>{String.fromCharCode(65 + i)} — {c.label}</div>)}</div>}
              <Alert kind="info">Arraste o pino roxo até a entrada do imóvel e confirme. A correção fica salva para jornadas futuras.</Alert>
              <Button onClick={confirm} size="lg"><CheckCircle2 className="h-5 w-5" /> Confirmar posição</Button>
            </Card>
          ) : <p className="mt-3 text-sm muted">Selecione um endereço para revisar.</p>}
        </div>
      </div>
    </AppShell>
  );
}
