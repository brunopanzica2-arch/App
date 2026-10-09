"use client";

import { ChevronDown, ChevronUp, Crosshair, ExternalLink, ListOrdered, RotateCcw } from "lucide-react";
import { useParams, useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import { AppShell } from "@/components/AppShell";
import { MapLegend, RouteMapLazy } from "@/components/Map";
import { Button } from "@/components/ui/button";
import { Alert, Badge, Card, Select, Spinner } from "@/components/ui/misc";
import { api, getUser } from "@/lib/api";
import { enqueue, loadJourney, saveJourney } from "@/lib/offline";
import { PRECISION_LABEL, REASON_LABEL, STATUS_LABEL, STOP_STATUS_LABEL, fmtDist, fmtTime } from "@/lib/utils";

const TERMINAL = ["delivered", "not_delivered", "returned", "address_not_found"];

function stopStatus(corrs: any[]) {
  const st = corrs.map((c) => c.status);
  if (st.length && st.every((s) => TERMINAL.includes(s))) return st.some((s) => s !== "delivered") ? "problem" : "completed";
  if (st.length && st.every((s) => TERMINAL.includes(s) || s === "postponed")) return "postponed";
  if (st.some((s) => TERMINAL.includes(s) || s === "postponed")) return "partial";
  return "pending";
}

export default function OperationalRoute() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const [route, setRoute] = useState<any>(null);
  const [offlineCopy, setOfflineCopy] = useState<string | null>(null);
  const [selId, setSelId] = useState<string | null>(null);
  const [panelOpen, setPanelOpen] = useState(true);
  const [showList, setShowList] = useState(false);
  const [me, setMe] = useState<{ lat: number; lon: number } | null>(null);
  const [msg, setMsg] = useState<{ kind: "ok" | "error" | "info" | "warn"; text: string } | null>(null);
  const [reason, setReason] = useState("ausente");
  const user = typeof window !== "undefined" ? getUser() : null;

  const load = useCallback(async () => {
    try {
      const r = await api(`/api/routes/${id}`);
      setRoute(r);
      setOfflineCopy(null);
      await saveJourney(id, r);
    } catch (e: any) {
      const cached = await loadJourney(id);
      if (cached) {
        setRoute(cached.data);
        setOfflineCopy(cached.saved_at);
      } else setMsg({ kind: "error", text: e.message });
    }
  }, [id]);

  useEffect(() => { void load(); }, [load]);

  const stops = route?.stops ?? [];
  const next = stops.find((s: any) => ["pending", "partial"].includes(s.status));
  const sel = stops.find((s: any) => s.id === (selId ?? next?.id)) ?? null;
  const idx = sel ? stops.indexOf(sel) : -1;
  const following = idx >= 0 ? stops[idx + 1] : null;

  const mapStops = useMemo(() => stops.map((s: any) => ({
    id: s.id, lat: s.lat, lon: s.lon, seq: s.sequence, status: s.status, isNext: next?.id === s.id,
    uncertain: !["exact", "manual", "interpolated"].includes(s.address.precision),
  })), [stops, next]);

  async function mark(corr: any, status: string) {
    // atualização local imediata + fila offline idempotente
    const r = structuredClone(route);
    for (const s of r.stops) {
      for (const c of s.correspondences) if (c.id === corr.id) c.status = status;
      s.status = stopStatus(s.correspondences);
    }
    setRoute(r);
    await saveJourney(id, r);
    await enqueue({
      correspondence_id: corr.id, status, route_id: id,
      reason: ["not_delivered", "returned", "address_not_found"].includes(status) ? reason : null,
    });
    setMsg({ kind: "ok", text: `${STATUS_LABEL[status]} registrada${navigator.onLine ? "" : " (offline — será enviada depois)"}.` });
  }

  async function reoptimize(origin: "last_completed" | "current_location") {
    setMsg({ kind: "info", text: "Recalculando paradas restantes…" });
    try {
      let body: any = { origin, run_async: false };
      if (origin === "current_location") {
        if (!confirm("Usar sua localização atual como origem do recálculo? A posição é usada só para este cálculo.")) return;
        const pos = await new Promise<GeolocationPosition>((ok, err) => navigator.geolocation.getCurrentPosition(ok, err, { enableHighAccuracy: true, timeout: 15000 }));
        body = { ...body, lat: pos.coords.latitude, lon: pos.coords.longitude, location_consent: true };
      }
      const r = await api(`/api/routes/${id}/reoptimize`, { method: "POST", json: body });
      await api(`/api/routes/${r.route.id}/activate`, { method: "POST" });
      router.push(`/rota/${r.route.id}`);
    } catch (e: any) {
      setMsg({ kind: "error", text: e.message });
    }
  }

  function locate() {
    if (!confirm("Mostrar sua localização no mapa? Ela não é enviada ao servidor.")) return;
    navigator.geolocation.getCurrentPosition((p) => setMe({ lat: p.coords.latitude, lon: p.coords.longitude }), (e) => setMsg({ kind: "error", text: e.message }));
  }

  if (!route) return <AppShell title="Jornada"><Spinner /></AppShell>;

  const done = stops.filter((s: any) => ["completed", "problem"].includes(s.status)).length;
  const navUrl = sel ? `https://www.google.com/maps/dir/?api=1&destination=${sel.lat},${sel.lon}&travelmode=bicycling` : "#";

  return (
    <AppShell title={`Jornada · v${route.version}`} wide>
      {offlineCopy && <div className="mb-2"><Alert kind="warn">Sem conexão: exibindo cópia local salva em {new Date(offlineCopy).toLocaleString("pt-BR")}. Registros ficam na fila.</Alert></div>}
      {route.status !== "active" && <div className="mb-2"><Alert kind="info">Esta versão está “{route.status}”. Rotas superadas são mantidas no histórico.</Alert></div>}
      {msg && <div className="mb-2"><Alert kind={msg.kind}>{msg.text}</Alert></div>}
      <div className="relative">
        <RouteMapLazy className="h-[calc(100dvh-11rem)] w-full overflow-hidden rounded-2xl md:h-[70vh]" stops={mapStops} route={route.geojson} start={route.start} me={me} onStopClick={(sid) => { setSelId(sid); setPanelOpen(true); }} focus={sel ? { lat: sel.lat, lon: sel.lon } : null} />
        <div className="absolute left-2 top-2 flex gap-2">
          <Button size="sm" variant="secondary" onClick={() => setShowList(!showList)} aria-label="Lista de paradas"><ListOrdered className="h-4 w-4" /> {done}/{stops.length}</Button>
          <Button size="sm" variant="secondary" onClick={locate} aria-label="Minha localização"><Crosshair className="h-4 w-4" /></Button>
        </div>
        {showList && (
          <div className="absolute left-2 top-14 max-h-[60%] w-72 overflow-y-auto card p-2 text-sm">
            {stops.map((s: any) => (
              <button key={s.id} onClick={() => { setSelId(s.id); setShowList(false); }} className="flex w-full items-center gap-2 rounded-lg p-1.5 text-left hover:bg-black/5">
                <b className="w-7 text-right">{s.sequence}</b><span className="flex-1 truncate">{s.address.normalized_text.split(" - ")[0]}</span>
                <span className="text-xs muted">{STOP_STATUS_LABEL[s.status]}</span>
              </button>
            ))}
          </div>
        )}
        {sel && (
          <section className="absolute inset-x-2 bottom-2 card shadow-xl md:left-auto md:w-[440px]" aria-label="Parada selecionada">
            <button onClick={() => setPanelOpen(!panelOpen)} className="flex w-full items-center gap-2 p-3 text-left">
              <span className="grid h-9 w-9 place-items-center rounded-full bg-next font-bold text-white">{sel.sequence}</span>
              <span className="flex-1">
                <span className="block font-bold leading-tight">{sel.address.normalized_text.split(" - ")[0]}</span>
                <span className="text-xs muted">{sel.address.neighborhood || ""} · {sel.letters} carta(s) · {STOP_STATUS_LABEL[sel.status]}{sel.id === next?.id ? " · próxima" : ""}</span>
              </span>
              {panelOpen ? <ChevronDown /> : <ChevronUp />}
            </button>
            {panelOpen && (
              <div className="max-h-[45vh] space-y-3 overflow-y-auto border-t border-app p-3">
                <div className="flex flex-wrap gap-2 text-xs">
                  <Badge color={["exact", "manual"].includes(sel.address.precision) ? "#16a34a" : "#b45309"}>{PRECISION_LABEL[sel.address.precision]}</Badge>
                  {sel.snap_distance_m != null && <Badge color="#6b7280">{Math.round(sel.snap_distance_m)} m até a via</Badge>}
                  {following && <Badge color="#7c3aed">Próximo ponto: {fmtDist(following.leg_distance_m)} · {fmtTime(following.leg_time_s)}</Badge>}
                </div>
                {sel.correspondences.map((c: any) => (
                  <div key={c.id} className="rounded-xl border border-app p-2">
                    <div className="flex items-center justify-between gap-2 text-sm">
                      <span><b>{c.external_id || `linha ${c.row_number}`}</b>{c.complement ? ` · ${c.complement}` : ""}{c.recipient_visible && c.recipient ? ` · ${c.recipient}` : ""}</span>
                      <Badge color={c.status === "delivered" ? "#16a34a" : TERMINAL.includes(c.status) ? "#dc2626" : c.status === "postponed" ? "#6b7280" : "#7c3aed"}>{STATUS_LABEL[c.status]}</Badge>
                    </div>
                    {c.notes && <div className="text-xs muted">Obs.: {c.notes}</div>}
                    <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-4">
                      <Button variant="success" size="sm" onClick={() => mark(c, "delivered")}>Entregue</Button>
                      <Button variant="danger" size="sm" onClick={() => mark(c, "not_delivered")}>Não entregue</Button>
                      <Button variant="secondary" size="sm" onClick={() => mark(c, "postponed")}>Adiar</Button>
                      <Button variant="secondary" size="sm" onClick={() => mark(c, "address_not_found")}>End. não localizado</Button>
                    </div>
                  </div>
                ))}
                <div className="grid grid-cols-2 gap-2">
                  <Select aria-label="Motivo da ocorrência" value={reason} onChange={(e) => setReason(e.target.value)}>
                    {Object.entries(REASON_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                  </Select>
                  <Button variant="secondary" size="sm" onClick={() => sel.correspondences.forEach((c: any) => c.status !== "delivered" && mark(c, "returned"))}>Devolver pendentes</Button>
                </div>
                <a href={navUrl} target="_blank" rel="noreferrer" className="flex items-center gap-2 text-sm font-semibold text-next">
                  <ExternalLink className="h-4 w-4" /> Abrir navegação externa (Google Maps, modo bicicleta)
                </a>
                <p className="text-xs muted">Atenção: a navegação externa usa o perfil do aplicativo externo (bicicleta), diferente do perfil pedestre calculado aqui — pode sugerir outro caminho e respeitar mãos de direção.</p>
              </div>
            )}
          </section>
        )}
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Button variant="secondary" onClick={() => reoptimize("last_completed")}><RotateCcw className="h-4 w-4" /> Recalcular a partir da última parada</Button>
        <Button variant="secondary" onClick={() => reoptimize("current_location")}><Crosshair className="h-4 w-4" /> Recalcular da minha localização</Button>
        <Button variant="ghost" onClick={load}>Atualizar</Button>
      </div>
      <div className="mt-2"><MapLegend /></div>
      {route.warnings?.length > 0 && <Card className="mt-3 text-sm"><b>Avisos do cálculo</b><ul className="list-disc pl-5">{route.warnings.map((w: string, i: number) => <li key={i}>{w}</li>)}</ul></Card>}
    </AppShell>
  );
}
