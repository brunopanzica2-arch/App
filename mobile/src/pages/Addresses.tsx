import { CheckCircle2, RefreshCw } from "lucide-react";
import { useMemo, useState } from "react";
import { type Address, db } from "../core/db";
import { confirmAddress, resolve } from "../core/geocode";
import { normalizeAddress } from "../core/normalize";
import { geocodeBatch, getSettings, importPositions, stopsOf } from "../core/service";
import { Button } from "../ui/button";
import { useAsync } from "../ui/hooks";
import { Alert, Badge, Card, Progress, Select, Spinner } from "../ui/misc";
import RouteMap from "../ui/RouteMap";
import { PRECISION_LABEL } from "../ui/utils";

const PCOLOR: Record<string, string> = { test: "#b45309", exact: "#16a34a", manual: "#16a34a", interpolated: "#2563eb", street: "#b45309", neighborhood: "#dc2626", not_found: "#dc2626", pending: "#6b7280" };

export function AddressesPage({ batchId }: { batchId: string }) {
  const [filter, setFilter] = useState<"review" | "all">("review");
  const [data, reload] = useAsync(() => stopsOf(batchId), [batchId]);
  const [sel, setSel] = useState<Address | null>(null);
  const [pin, setPin] = useState<{ lat: number; lon: number } | null>(null);
  const [msg, setMsg] = useState<{ kind: "ok" | "error" | "info"; text: string } | null>(null);
  const [progress, setProgress] = useState<number | null>(null);

  const counts = useMemo(() => {
    const m = new Map<string, number>();
    data?.letters.forEach((l) => l.addressKey && m.set(l.addressKey, (m.get(l.addressKey) || 0) + 1));
    return m;
  }, [data]);
  // chaves ainda sem consulta aparecem como "Aguardando" (nunca somem da revisão)
  const pendingKeys = useMemo(() => {
    const have = new Set((data?.addresses || []).map((a) => a.key));
    const out = new Map<string, Address>();
    for (const l of data?.letters || []) {
      if (!l.addressKey || have.has(l.addressKey) || out.has(l.addressKey)) continue;
      const na = normalizeAddress(l.street, l.number, l.neighborhood, l.city, l.cep);
      out.set(l.addressKey, { key: na.key, display: na.display, original: na.original, street: na.street, number: na.number,
        neighborhood: na.neighborhood, city: na.city, cep: na.cep, lat: null, lon: null, precision: "pending", confidence: 0,
        source: null, candidates: [], needsReview: true, reason: "Ainda não localizado.", verifiedAt: null, confirmedAt: null });
    }
    return [...out.values()];
  }, [data]);
  const list = [...(data?.addresses || []), ...pendingKeys].filter((a) => filter === "all" || a.needsReview).sort((a, b) => a.display.localeCompare(b.display));
  const noAddr = data?.letters.filter((l) => !l.addressKey && !l.excluded) ?? [];
  const candidates = useMemo(() => (sel?.candidates || []).map((c) => ({ lat: c.lat, lon: c.lon, label: `${c.label} (${PRECISION_LABEL[c.precision]})` })), [sel]);

  async function geocodeAll() {
    setProgress(0);
    const r = await geocodeBatch(batchId, (d, t) => setProgress(d / t));
    setProgress(null);
    setMsg({ kind: r.errors.length ? "error" : "ok", text: `${r.addresses} imóveis verificados${r.errors.length ? ` · ${r.errors.length} falha(s): ${r.errors[0]}` : ""}` });
    reload();
  }

  async function retry(a: Address) {
    const s = await getSettings();
    const l = data!.letters.find((x) => x.addressKey === a.key)!;
    const na = normalizeAddress(l.street, l.number, l.neighborhood, l.city, l.cep);
    try {
      const r = await resolve(na, s.nominatimEmail, true);
      setSel(r);
      if (r.lat != null) setPin({ lat: r.lat, lon: r.lon! });
      reload();
    } catch (e) {
      setMsg({ kind: "error", text: (e as Error).message });
    }
  }

  async function confirm() {
    if (!sel || !pin) return;
    if (sel.precision === "pending") await db.addresses.put({ ...sel, lat: pin.lat, lon: pin.lon });
    await confirmAddress(sel.key, pin.lat, pin.lon);
    setMsg({ kind: "ok", text: `Posição confirmada: ${sel.display}. Fica salva para as próximas jornadas.` });
    setSel(null);
    reload();
  }

  if (!data) return <Spinner />;
  return (
    <div className="space-y-3">
      <div className="flex gap-2">
        <Select value={filter} onChange={(e) => setFilter(e.target.value as any)} aria-label="Filtro">
          <option value="review">Precisam de revisão</option>
          <option value="all">Todos</option>
        </Select>
        <Button variant="secondary" onClick={geocodeAll} disabled={progress !== null}><RefreshCw className="h-4 w-4" /> Localizar</Button>
      </div>
      <label className="block text-sm">
        Importar coordenadas (CSV: logradouro;numero;lat;lon[;aviso]):{" "}
        <input type="file" accept=".csv,.txt" aria-label="Importar coordenadas" onChange={async (e) => {
          const f = e.target.files?.[0];
          if (!f) return;
          try {
            const r = await importPositions(await f.text());
            setMsg({ kind: "ok", text: `Coordenadas: ${r.matched} atualizadas, ${r.created} novas, ${r.invalid} inválidas.` });
            reload();
          } catch (err) { setMsg({ kind: "error", text: (err as Error).message }); }
        }} />
      </label>
      {progress !== null && <Progress value={progress} />}
      {msg && <Alert kind={msg.kind}>{msg.text}</Alert>}
      {noAddr.length > 0 && <Alert kind="warn">{noAddr.length} carta(s) sem logradouro válido (linhas {noAddr.map((l) => l.row).join(", ")}). Corrija na planilha ou cadastre manualmente.</Alert>}
      <RouteMap className="h-[45vh] w-full overflow-hidden rounded-2xl" candidates={candidates} pin={pin} onPinMove={(lat, lon) => setPin({ lat, lon })} />
      {sel && (
        <Card className="space-y-2">
          <div className="font-semibold">{sel.display}</div>
          <div className="text-xs muted">Original: {sel.original}</div>
          {candidates.length > 1 && <div className="text-xs">{candidates.map((c, i) => <div key={i}>{String.fromCharCode(65 + i)} — {c.label}</div>)}</div>}
          <Alert kind="info">Arraste o pino roxo até a entrada do imóvel e confirme.</Alert>
          <div className="grid grid-cols-2 gap-2">
            <Button onClick={confirm}><CheckCircle2 className="h-5 w-5" /> Confirmar</Button>
            <Button variant="secondary" onClick={() => retry(sel)}>Consultar de novo</Button>
          </div>
        </Card>
      )}
      <div className="space-y-2">
        {list.length === 0 && <Card>Nenhum endereço {filter === "review" ? "pendente de revisão" : ""}.</Card>}
        {list.map((a) => (
          <button key={a.key} onClick={() => { setSel(a); setPin(a.lat != null ? { lat: a.lat, lon: a.lon! } : { lat: -23.962, lon: -46.333 }); window.scrollTo({ top: 0, behavior: "smooth" }); }}
            className={`card w-full p-3 text-left ${sel?.key === a.key ? "!border-brand" : ""}`}>
            <div className="font-semibold">{a.display}</div>
            <div className="mt-1 flex flex-wrap items-center gap-2 text-xs">
              <Badge color={PCOLOR[a.precision]}>{PRECISION_LABEL[a.precision]}</Badge>
              <span className="muted">confiança {Math.round(a.confidence * 100)}% · {counts.get(a.key) || 0} carta(s)</span>
            </div>
            {a.reason && <div className="mt-1 text-xs text-amber-700 dark:text-amber-400">{a.reason}</div>}
          </button>
        ))}
      </div>
    </div>
  );
}
