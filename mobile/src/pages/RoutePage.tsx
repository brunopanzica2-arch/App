import { routePoint } from "../core/address";
import { ChevronDown, ChevronUp, Crosshair, ExternalLink, ListOrdered, Pin, RotateCcw, Search, SkipForward, Undo2, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { Nav } from "../App";
import { db, type Letter, type LetterStatus } from "../core/db";
import {
  activateRoute, cancelPlan, lastServedPoint, planBatch, recordEvent, stopsOf, TERMINAL, undoLastEvent,
} from "../core/service";
import { Button } from "../ui/button";
import { useAsync, useCurrentBatch } from "../ui/hooks";
import { Alert, Badge, Card, Input, Select, Spinner } from "../ui/misc";
import RouteMap, { MapLegend } from "../ui/RouteMap";
import { PRECISION_LABEL, REASON_LABEL, STATUS_LABEL, STOP_STATUS_LABEL, fmtDist, fmtTime } from "../ui/utils";

/** GPS com limite próprio: sem resposta (permissão pendente/negada, sem sinal) => erro em 15 s. */
function getPosition(): Promise<GeolocationPosition> {
  return new Promise((ok, fail) => {
    if (!("geolocation" in navigator)) return fail(new Error("GPS não disponível neste aparelho"));
    const t = setTimeout(() => fail(new Error("sem resposta do GPS em 15 s")), 15000);
    navigator.geolocation.getCurrentPosition((p) => { clearTimeout(t); ok(p); }, (e) => { clearTimeout(t); fail(new Error(e.message || "permissão negada")); },
      { enableHighAccuracy: true, timeout: 15000 });
  });
}

const CONF_COLOR: Record<string, string> = { alta: "#16a34a", boa: "#16a34a", media: "#b45309", baixa: "#dc2626" };

export function RoutePage({ routeId, nav }: { routeId?: string; nav: Nav }) {
  const [batchId] = useCurrentBatch();
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
  const [query, setQuery] = useState("");
  const [me, setMe] = useState<{ lat: number; lon: number } | null>(null);
  const [baseMap, setBaseMap] = useState<"online" | "offline" | null>(null);
  const [msg, setMsg] = useState<{ kind: "ok" | "error" | "info" | "warn"; text: string } | null>(null);
  const [reason, setReason] = useState("ausente");
  const [busy, setBusy] = useState<string | null>(null);
  const [saving, setSaving] = useState<Record<string, LetterStatus>>({}); // atualização otimista

  const byKey = useMemo(() => new Map(stopsData?.stops.map((s) => [s.key, s]) ?? []), [stopsData]);
  const items = useMemo(() => (route?.stops || []).map((rs) => ({ ...rs, stop: byKey.get(rs.key) })).filter((x) => x.stop), [route, byKey]);
  const next = items.find((x) => ["pending", "partial"].includes(x.stop!.status));
  const sel = items.find((x) => x.key === (selKey ?? next?.key));
  const following = sel ? items[items.indexOf(sel) + 1] : null;
  const mapStops = useMemo(() => items.map((x) => ({
    id: x.key, lat: routePoint(x.stop!.address)!.lat, lon: routePoint(x.stop!.address)!.lon, seq: x.seq, status: x.stop!.status,
    uncertain: x.stop!.uncertain || x.confidence === "baixa", isNext: x.key === next?.key,
  })), [items, next]);
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return items;
    return items.filter((x) => [x.stop!.address.display, x.stop!.address.neighborhood, ...x.stop!.letters.flatMap((l) => [l.externalId, l.recipient, l.complement])]
      .some((v) => (v || "").toLowerCase().includes(q)));
  }, [items, query]);

  if (!routeId) return <Card>Nenhuma rota calculada para o lote atual. <Button className="mt-2" onClick={() => nav("/")}>Ir ao painel</Button></Card>;
  if (!route || !stopsData) return <Spinner />;

  const letters = stopsData.letters;
  const pendingLetters = letters.filter((l) => !TERMINAL.includes(l.status) && l.status !== "postponed").length;
  const doneStops = items.filter((x) => ["completed", "problem"].includes(x.stop!.status)).length;
  const remaining = items.filter((x) => !["completed", "problem"].includes(x.stop!.status));
  const remDist = remaining.reduce((a, x) => a + x.legDistance, 0);
  const remTime = remaining.reduce((a, x) => a + x.legTime, 0);
  const partial = route.metrics.status === "partial";

  async function mark(l: Letter, status: LetterStatus) {
    if (saving[l.id]) return; // evita toque duplo enquanto grava
    setSaving((s) => ({ ...s, [l.id]: status }));
    try {
      await recordEvent(l.id, status, route!.id, ["not_delivered", "returned", "address_not_found"].includes(status) ? reason : null);
      setMsg({ kind: "ok", text: `${l.externalId || "Carta"}: ${STATUS_LABEL[status]}. Use "Desfazer" se foi engano.` });
    } catch (e) {
      setMsg({ kind: "error", text: `Não foi possível gravar: ${(e as Error).message}` });
    }
    reload();
    setTimeout(() => setSaving((s) => { const n = { ...s }; delete n[l.id]; return n; }), 400);
  }

  async function bulk(status: LetterStatus, label: string) {
    const ls = sel!.stop!.letters.filter((l) => !TERMINAL.includes(l.status));
    if (!ls.length) return;
    if (!confirm(`${label}: aplicar a ${ls.length} carta(s) de ${sel!.stop!.address.display.split(" - ")[0]}?`)) return;
    for (const l of ls) await recordEvent(l.id, status, route!.id, ["returned", "not_delivered"].includes(status) ? reason : null);
    setMsg({ kind: "ok", text: `${ls.length} carta(s): ${STATUS_LABEL[status]}.` });
    reload();
  }

  async function undo() {
    const ev = await undoLastEvent(route!.batchId);
    setMsg(ev ? { kind: "info", text: `Desfeito: ${STATUS_LABEL[ev.status]} (volta para ${STATUS_LABEL[ev.previousStatus]}).` } : { kind: "info", text: "Nada para desfazer." });
    reload();
  }

  async function reoptimize(origin: "last" | "here", fixedFirst?: string[]) {
    try {
      let start = await lastServedPoint(route!);
      if (origin === "here") {
        if (!confirm("Usar sua localização atual como origem do recálculo? Ela fica só no aparelho.")) return;
        try {
          const pos = await getPosition();
          start = { label: "Localização atual", lat: pos.coords.latitude, lon: pos.coords.longitude };
        } catch (e) {
          // GPS negado/indisponível: segue da última parada concluída
          setMsg({ kind: "warn", text: `GPS indisponível (${(e as Error).message}). Recalculando a partir da última parada atendida.` });
        }
      }
      start ??= route!.start;
      setBusy("Recalculando paradas restantes…");
      const mode = route!.params.mode as any;
      const opts = (st: { label: string; lat: number; lon: number }) => ({
        mode: mode === "circular" ? "fixed_end" : mode, strategy: route!.params.strategy as any, start: st,
        end: mode === "circular" ? route!.start : route!.end, timeLimitMs: 8000, reason: `reotimização:${origin}`, fixedFirst,
      });
      const prog = (st: string, p: number) => setBusy(`${st} ${Math.round(p * 100)}%`);
      let r;
      try {
        r = await planBatch(route!.batchId, opts(start), prog);
      } catch (e) {
        if (origin !== "here" || !/fora da malha/.test((e as Error).message)) throw e;
        // posição do GPS desviada/fora da malha de Santos: segue da última parada atendida
        const fallback = (await lastServedPoint(route!)) ?? route!.start;
        setMsg({ kind: "warn", text: `Sua posição está fora da malha de pedestres (${(e as Error).message}). Recalculado a partir de: ${fallback.label}.` });
        r = await planBatch(route!.batchId, opts(fallback), prog);
      }
      await activateRoute(r);
      setBusy(null);
      nav(`/rota/${r.id}`);
    } catch (e) {
      setBusy(null);
      setMsg({ kind: "error", text: (e as Error).message });
    }
  }

  function locate() {
    getPosition().then(
      (p) => setMe({ lat: p.coords.latitude, lon: p.coords.longitude }),
      (e) => setMsg({ kind: "warn", text: `GPS indisponível: ${e.message}. O app continua funcionando sem localização.` }),
    );
  }

  const navUrl = sel ? `https://www.google.com/maps/dir/?api=1&destination=${routePoint(sel.stop!.address)!.lat},${routePoint(sel.stop!.address)!.lon}&travelmode=bicycling` : "#";
  const addr = (x: typeof items[number]) => x.stop!.address.display.split(" - ")[0];

  return (
    <div className="space-y-2">
      {/* indicadores sempre visíveis */}
      <div className="flex flex-wrap gap-1 text-[11px]">
        <Badge color="#16a34a">Rota calculada no aparelho · v{route.version}</Badge>
        <Badge color={baseMap === "offline" ? "#b45309" : "#16a34a"}>Mapa-base {baseMap === "offline" ? "offline" : "online"}</Badge>
        <Badge color={partial ? "#dc2626" : "#16a34a"}>{partial ? "ROTA PARCIAL" : "Rota completa"}</Badge>
        {stopsData.unlocated.length > 0 && <Badge color="#dc2626">{stopsData.unlocated.length} carta(s) sem localização</Badge>}
      </div>
      {partial && (
        <Alert kind="error">ROTA PARCIAL: {route.metrics.notRoutedLetters ?? 0} carta(s) pendente(s) fora do roteiro
          ({route.metrics.excluded?.length ?? 0} parada(s) sem caminho viável/posição inválida, {stopsData.unlocated.length} sem localização). Elas não estão no tempo nem na distância.</Alert>
      )}
      {next && (
        <Card className="border-next p-3">
          <div className="text-xs font-semibold uppercase text-next">Próxima parada · {next.seq} de {items.length}</div>
          <div className="text-2xl font-extrabold leading-tight">{addr(next)}</div>
          <div className="text-sm muted">{next.stop!.address.neighborhood ?? ""} · {next.stop!.letters.filter((l) => !TERMINAL.includes(l.status)).length} carta(s) pendente(s)</div>
        </Card>
      )}
      <div className="grid grid-cols-2 gap-2 text-center text-xs">
        <Card className="p-2"><b className="text-base">{letters.length - pendingLetters}/{letters.length}</b><div>cartas tratadas ({Math.round(((letters.length - pendingLetters) / Math.max(letters.length, 1)) * 100)}%)</div></Card>
        <Card className="p-2"><b className="text-base">{doneStops}/{items.length}</b><div>paradas concluídas ({Math.round((doneStops / Math.max(items.length, 1)) * 100)}%)</div></Card>
        <Card className="p-2"><b className="text-base">{fmtDist(remDist)}</b><div>restante de {fmtDist(route.totalDistance)}</div></Card>
        <Card className="p-2"><b className="text-base">{fmtTime(remTime)}</b><div>deslocamento restante (estimativa ±20%)</div></Card>
      </div>
      {msg && <Alert kind={msg.kind}>{msg.text}</Alert>}
      {busy && <Alert kind="info">{busy} <button className="ml-2 underline" onClick={() => { cancelPlan(); setBusy(null); }}>Cancelar</button></Alert>}

      <div className="relative">
        <RouteMap className="h-[55dvh] w-full overflow-hidden rounded-2xl" stops={mapStops} route={route.geojson} start={route.start} me={me}
          onBaseMap={setBaseMap} onStopClick={(k) => { setSelKey(k); setOpen(true); }} focus={sel ? { lat: routePoint(sel.stop!.address)!.lat, lon: routePoint(sel.stop!.address)!.lon } : null} />
        <div className="absolute left-2 top-2 flex gap-2">
          <Button size="sm" variant="secondary" onClick={() => setList(!list)} aria-label="Lista de paradas"><ListOrdered className="h-4 w-4" /> Lista</Button>
          <Button size="sm" variant="secondary" aria-label="Minha localização" onClick={locate}><Crosshair className="h-4 w-4" /></Button>
          <Button size="sm" variant="secondary" aria-label="Desfazer última ação" onClick={undo}><Undo2 className="h-4 w-4" /></Button>
        </div>
      </div>

      {list && (
        <Card className="p-2">
          <div className="mb-2 flex items-center gap-2">
            <Search className="h-4 w-4" />
            <Input aria-label="Buscar parada" placeholder="Rua, número, código, bairro…" value={query} onChange={(e) => setQuery(e.target.value)} />
            <button aria-label="Fechar lista" onClick={() => setList(false)}><X className="h-5 w-5" /></button>
          </div>
          <ol className="max-h-[50vh] divide-y divide-[var(--border)] overflow-y-auto text-sm">
            {filtered.map((x) => (
              <li key={x.key} className="flex items-center gap-2 py-2">
                <button onClick={() => { setSelKey(x.key); setList(false); setOpen(true); }} className="flex flex-1 items-center gap-2 text-left">
                  <b className="w-8 text-right">{x.seq}</b>
                  <span className="flex-1">
                    <span className="block font-semibold">{addr(x)}</span>
                    <span className="text-xs muted">{x.stop!.address.neighborhood ?? ""} · {x.stop!.letters.length} carta(s) · {STOP_STATUS_LABEL[x.stop!.status]}
                      {x.stop!.letters.length > 1 ? " · agrupadas: mesmo logradouro e número" : ""}</span>
                  </span>
                </button>
                {["pending", "partial"].includes(x.stop!.status) && x.key !== next?.key && (
                  <Button size="sm" variant="ghost" aria-label="Fixar como próxima" onClick={() => reoptimize("last", [x.key])}><Pin className="h-4 w-4" /></Button>
                )}
              </li>
            ))}
          </ol>
        </Card>
      )}

      {sel && (
        <section className="card shadow-xl" aria-label="Parada selecionada">
          <button onClick={() => setOpen(!open)} className="flex w-full items-center gap-2 p-3 text-left">
            <span className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-next text-lg font-bold text-white">{sel.seq}</span>
            <span className="flex-1">
              <span className="block text-lg font-bold leading-tight">{addr(sel)}</span>
              <span className="text-xs muted">{sel.stop!.address.neighborhood ?? ""} · {sel.stop!.letters.length} carta(s) · {STOP_STATUS_LABEL[sel.stop!.status]}{sel.key === next?.key ? " · próxima" : ""}</span>
            </span>
            {open ? <ChevronDown /> : <ChevronUp />}
          </button>
          {open && (
            <div className="space-y-3 border-t border-app p-3">
              <div className="flex flex-wrap gap-2 text-xs">
                <Badge color={["exact", "manual"].includes(sel.stop!.address.precision) ? "#16a34a" : "#b45309"}>{PRECISION_LABEL[sel.stop!.address.precision]}</Badge>
                <Badge color={CONF_COLOR[sel.confidence || "alta"]}>Posição na via: {Math.round(sel.snapDistance)} m ({sel.confidence ?? "—"})</Badge>
                {(sel.flags || []).includes("acesso_cruza_outra_via") && <Badge color="#dc2626">Acesso cruza outra via — confira o lado</Badge>}
                {(sel.flags || []).includes("via_mais_proxima_desconectada") && <Badge color="#dc2626">Via mais próxima não conectada</Badge>}
                {following && <Badge color="#7c3aed">Próximo: {fmtDist(following.legDistance)} · {fmtTime(following.legTime)}</Badge>}
              </div>
              {sel.stop!.letters.map((l0) => { const l = saving[l0.id] ? { ...l0, status: saving[l0.id] } : l0; return (
                <div key={l.id} className="rounded-xl border border-app p-2" data-letter={l.id} data-status={l.status}>
                  <div className="flex items-center justify-between gap-2 text-sm">
                    <span><b>{l.externalId || `linha ${l.row}`}</b>{l.complement ? ` · ${l.complement}` : ""}{l.recipient ? ` · ${l.recipient}` : ""}</span>
                    <Badge color={l.status === "delivered" ? "#16a34a" : TERMINAL.includes(l.status) ? "#dc2626" : l.status === "postponed" ? "#6b7280" : "#7c3aed"}>{STATUS_LABEL[l.status]}</Badge>
                  </div>
                  {l.notes && <div className="text-xs muted">Obs.: {l.notes}</div>}
                  <div className="mt-2 grid grid-cols-2 gap-2">
                    <Button variant="success" disabled={!!saving[l.id] || l.status === "delivered"} onClick={() => mark(l, "delivered")}>Entregue</Button>
                    <Button variant="danger" disabled={!!saving[l.id]} onClick={() => mark(l, "not_delivered")}>Não entregue</Button>
                    <Button variant="secondary" size="sm" onClick={() => mark(l, "postponed")}>Adiar</Button>
                    <Button variant="secondary" size="sm" onClick={() => mark(l, "address_not_found")}>Endereço errado</Button>
                  </div>
                </div>
              ); })}
              <div className="grid grid-cols-2 gap-2">
                <Select aria-label="Motivo da ocorrência" value={reason} onChange={(e) => setReason(e.target.value)}>
                  {Object.entries(REASON_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                </Select>
                <Button variant="secondary" size="sm" onClick={() => bulk("returned", "Devolver pendentes")}>Devolver pendentes</Button>
                <Button variant="secondary" size="sm" onClick={() => bulk("postponed", "Pular este endereço (adiar)")}><SkipForward className="h-4 w-4" /> Pular endereço</Button>
                {following && <Button variant="secondary" size="sm" onClick={() => setSelKey(following.key)}>Próxima parada →</Button>}
              </div>
              <a href={navUrl} target="_blank" rel="noreferrer" className="flex items-center gap-2 text-sm font-semibold text-next"><ExternalLink className="h-4 w-4" /> Navegação externa (Google Maps, bicicleta)</a>
              <p className="text-xs muted">A navegação externa usa o perfil de bicicleta do Google (respeita mãos de direção) — pode diferir do caminho de pedestre calculado aqui.</p>
            </div>
          )}
        </section>
      )}
      <div className="grid gap-2">
        <Button variant="secondary" onClick={() => reoptimize("last")} disabled={!!busy}><RotateCcw className="h-4 w-4" /> Recalcular a partir da última parada</Button>
        <Button variant="secondary" onClick={() => reoptimize("here")} disabled={!!busy}><Crosshair className="h-4 w-4" /> Recalcular da minha localização</Button>
      </div>
      <MapLegend />
      {route.warnings.length > 0 && <Card className="text-sm"><b>Avisos do cálculo</b><ul className="list-disc pl-5">{route.warnings.map((w, i) => <li key={i}>{w}</li>)}</ul></Card>}
    </div>
  );
}
