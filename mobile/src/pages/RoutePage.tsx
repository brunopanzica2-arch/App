import { ChevronDown, ChevronUp, Crosshair, ExternalLink, ListOrdered, RotateCcw } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { Nav } from "../App";
import { db, type LetterStatus } from "../core/db";
import { activateRoute, getSettings, lastServedPoint, planBatch, recordEvent, stopsOf, TERMINAL } from "../core/service";
import { Button } from "../ui/button";
import { useAsync, useCurrentBatch } from "../ui/hooks";
import { Alert, Badge, Card, Select, Spinner } from "../ui/misc";
import RouteMap, { MapLegend } from "../ui/RouteMap";
import { PRECISION_LABEL, REASON_LABEL, STATUS_LABEL, STOP_STATUS_LABEL, fmtDist, fmtTime } from "../ui/utils";

export function RoutePage({ routeId, nav }: { routeId?: string; nav: Nav }) {
  const [batchId] = useCurrentBatch();
  // sem id: abre a rota ativa do lote atual
  useEffect(() => {
    if (routeId || !batchId) return;
    db.routes.where("batchId").equals(batchId).toArray().then((rs) => {
      const r = rs.find((x) => x.status === "active") || rs.sort((a, b) => b.version - a.version)[0];
      if (r) nav(`/rota/${r.id}`);
    });
  }, [routeId, batchId, nav]);

  const [route] = useAsync(async () => (routeId ? (await db.routes.get(routeId)) ?? null : null), [routeId]);
  const [stopsData, reload] = useAsync(async () => (route ? stopsOf(route.batchId) : null), [route?.id]);
  const [selKey, setSelKey] = useState<string | null>(null);
  const [open, setOpen] = useState(true);
  const [list, setList] = useState(false);
  const [me, setMe] = useState<{ lat: number; lon: number } | null>(null);
  const [msg, setMsg] = useState<{ kind: "ok" | "error" | "info"; text: string } | null>(null);
  const [reason, setReason] = useState("ausente");
  const [busy, setBusy] = useState<string | null>(null);

  const byKey = useMemo(() => new Map(stopsData?.stops.map((s) => [s.key, s]) ?? []), [stopsData]);
  const items = useMemo(() => (route?.stops || []).map((rs) => ({ ...rs, stop: byKey.get(rs.key) })).filter((x) => x.stop), [route, byKey]);
  const next = items.find((x) => ["pending", "partial"].includes(x.stop!.status));
  const sel = items.find((x) => x.key === (selKey ?? next?.key));
  const following = sel ? items[items.indexOf(sel) + 1] : null;
  const mapStops = useMemo(() => items.map((x) => ({ id: x.key, lat: x.stop!.address.lat!, lon: x.stop!.address.lon!, seq: x.seq, status: x.stop!.status, uncertain: x.stop!.uncertain, isNext: x.key === next?.key })), [items, next]);

  if (!routeId) return <Card>Nenhuma rota calculada para o lote atual. <Button className="mt-2" onClick={() => nav("/")}>Ir ao painel</Button></Card>;
  if (!route || !stopsData) return <Spinner />;

  async function mark(letterId: string, status: LetterStatus) {
    await recordEvent(letterId, status, route!.id, ["not_delivered", "returned", "address_not_found"].includes(status) ? reason : null);
    setMsg({ kind: "ok", text: `${STATUS_LABEL[status]} registrada.` });
    reload();
  }

  async function reoptimize(origin: "last" | "here") {
    try {
      let start = await lastServedPoint(route!);
      if (origin === "here") {
        if (!confirm("Usar sua localização atual como origem do recálculo? Ela fica só no aparelho.")) return;
        const pos = await new Promise<GeolocationPosition>((ok, err) => navigator.geolocation.getCurrentPosition(ok, err, { enableHighAccuracy: true, timeout: 20000 }));
        start = { label: "Localização atual", lat: pos.coords.latitude, lon: pos.coords.longitude };
      }
      start ??= route!.start;
      const s = await getSettings();
      setBusy("Recalculando paradas restantes…");
      const mode = route!.params.mode as any;
      const r = await planBatch(route!.batchId, {
        mode: mode === "circular" ? "fixed_end" : mode, strategy: route!.params.strategy as any, start,
        end: mode === "circular" ? route!.start : route!.end, timeLimitMs: 8000, reason: `reotimização:${origin}`,
      }, (st, p) => setBusy(`${st} ${Math.round(p * 100)}%`));
      void s;
      await activateRoute(r);
      setBusy(null);
      nav(`/rota/${r.id}`);
    } catch (e) {
      setBusy(null);
      setMsg({ kind: "error", text: (e as Error).message });
    }
  }

  const done = items.filter((x) => ["completed", "problem"].includes(x.stop!.status)).length;
  const navUrl = sel ? `https://www.google.com/maps/dir/?api=1&destination=${sel.stop!.address.lat},${sel.stop!.address.lon}&travelmode=bicycling` : "#";

  return (
    <div className="space-y-2">
      <div className="text-sm muted">Versão {route.version} · {route.status === "active" ? "ativa" : route.status}</div>
      {msg && <Alert kind={msg.kind}>{msg.text}</Alert>}
      {busy && <Alert kind="info">{busy}</Alert>}
      <div className="relative">
        <RouteMap className="h-[calc(100dvh-12rem)] w-full overflow-hidden rounded-2xl" stops={mapStops} route={route.geojson} start={route.start} me={me}
          onStopClick={(k) => { setSelKey(k); setOpen(true); }} focus={sel ? { lat: sel.stop!.address.lat!, lon: sel.stop!.address.lon! } : null} />
        <div className="absolute left-2 top-2 flex gap-2">
          <Button size="sm" variant="secondary" onClick={() => setList(!list)} aria-label="Lista de paradas"><ListOrdered className="h-4 w-4" /> {done}/{items.length}</Button>
          <Button size="sm" variant="secondary" aria-label="Minha localização" onClick={() => navigator.geolocation.getCurrentPosition((p) => setMe({ lat: p.coords.latitude, lon: p.coords.longitude }), (e) => setMsg({ kind: "error", text: e.message }))}><Crosshair className="h-4 w-4" /></Button>
        </div>
        {list && (
          <div className="absolute left-2 top-14 max-h-[60%] w-72 overflow-y-auto card p-2 text-sm">
            {items.map((x) => (
              <button key={x.key} onClick={() => { setSelKey(x.key); setList(false); }} className="flex w-full items-center gap-2 rounded-lg p-1.5 text-left">
                <b className="w-7 text-right">{x.seq}</b><span className="flex-1 truncate">{x.stop!.address.display.split(" - ")[0]}</span>
                <span className="text-xs muted">{STOP_STATUS_LABEL[x.stop!.status]}</span>
              </button>
            ))}
          </div>
        )}
        {sel && (
          <section className="absolute inset-x-2 bottom-2 card shadow-xl" aria-label="Parada selecionada">
            <button onClick={() => setOpen(!open)} className="flex w-full items-center gap-2 p-3 text-left">
              <span className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-next font-bold text-white">{sel.seq}</span>
              <span className="flex-1">
                <span className="block font-bold leading-tight">{sel.stop!.address.display.split(" - ")[0]}</span>
                <span className="text-xs muted">{sel.stop!.address.neighborhood ?? ""} · {sel.stop!.letters.length} carta(s) · {STOP_STATUS_LABEL[sel.stop!.status]}{sel.key === next?.key ? " · próxima" : ""}</span>
              </span>
              {open ? <ChevronDown /> : <ChevronUp />}
            </button>
            {open && (
              <div className="max-h-[45vh] space-y-3 overflow-y-auto border-t border-app p-3">
                <div className="flex flex-wrap gap-2 text-xs">
                  <Badge color={["exact", "manual"].includes(sel.stop!.address.precision) ? "#16a34a" : "#b45309"}>{PRECISION_LABEL[sel.stop!.address.precision]}</Badge>
                  <Badge color="#6b7280">{Math.round(sel.snapDistance)} m até a via</Badge>
                  {following && <Badge color="#7c3aed">Próximo: {fmtDist(following.legDistance)} · {fmtTime(following.legTime)}</Badge>}
                </div>
                {sel.stop!.letters.map((l) => (
                  <div key={l.id} className="rounded-xl border border-app p-2">
                    <div className="flex items-center justify-between gap-2 text-sm">
                      <span><b>{l.externalId || `linha ${l.row}`}</b>{l.complement ? ` · ${l.complement}` : ""}{l.recipient ? ` · ${l.recipient}` : ""}</span>
                      <Badge color={l.status === "delivered" ? "#16a34a" : TERMINAL.includes(l.status) ? "#dc2626" : l.status === "postponed" ? "#6b7280" : "#7c3aed"}>{STATUS_LABEL[l.status]}</Badge>
                    </div>
                    {l.notes && <div className="text-xs muted">Obs.: {l.notes}</div>}
                    <div className="mt-2 grid grid-cols-2 gap-2">
                      <Button variant="success" size="sm" onClick={() => mark(l.id, "delivered")}>Entregue</Button>
                      <Button variant="danger" size="sm" onClick={() => mark(l.id, "not_delivered")}>Não entregue</Button>
                      <Button variant="secondary" size="sm" onClick={() => mark(l.id, "postponed")}>Adiar</Button>
                      <Button variant="secondary" size="sm" onClick={() => mark(l.id, "address_not_found")}>End. não localizado</Button>
                    </div>
                  </div>
                ))}
                <div className="grid grid-cols-2 gap-2">
                  <Select aria-label="Motivo" value={reason} onChange={(e) => setReason(e.target.value)}>
                    {Object.entries(REASON_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                  </Select>
                  <Button variant="secondary" size="sm" onClick={async () => { for (const l of sel.stop!.letters) if (!TERMINAL.includes(l.status)) await recordEvent(l.id, "returned", route.id, reason); reload(); }}>Devolver pendentes</Button>
                </div>
                <a href={navUrl} target="_blank" rel="noreferrer" className="flex items-center gap-2 text-sm font-semibold text-next"><ExternalLink className="h-4 w-4" /> Navegação externa (Google Maps, bicicleta)</a>
                <p className="text-xs muted">A navegação externa usa o perfil de bicicleta do Google (respeita mãos de direção) — pode diferir do caminho de pedestre calculado aqui.</p>
              </div>
            )}
          </section>
        )}
      </div>
      <div className="grid gap-2">
        <Button variant="secondary" onClick={() => reoptimize("last")} disabled={!!busy}><RotateCcw className="h-4 w-4" /> Recalcular a partir da última parada</Button>
        <Button variant="secondary" onClick={() => reoptimize("here")} disabled={!!busy}><Crosshair className="h-4 w-4" /> Recalcular da minha localização</Button>
      </div>
      <MapLegend />
      {route.warnings.length > 0 && <Card className="text-sm"><b>Avisos do cálculo</b><ul className="list-disc pl-5">{route.warnings.map((w, i) => <li key={i}>{w}</li>)}</ul></Card>}
    </div>
  );
}
