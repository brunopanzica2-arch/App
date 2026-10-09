"use client";

import { MapPin, Save } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { AppShell } from "@/components/AppShell";
import { RouteMapLazy } from "@/components/Map";
import { Button } from "@/components/ui/button";
import { Alert, Card, Input, Label, Select } from "@/components/ui/misc";
import { api, getUser } from "@/lib/api";
import { PRECISION_LABEL } from "@/lib/utils";

export default function SettingsPage() {
  const [s, setS] = useState<any>(null);
  const [geo, setGeo] = useState<any>(null);
  const [pin, setPin] = useState<{ lat: number; lon: number } | null>(null);
  const [msg, setMsg] = useState<{ kind: "ok" | "error" | "warn" | "info"; text: string } | null>(null);
  const [net, setNet] = useState<any>(null);
  const user = typeof window !== "undefined" ? getUser() : null;
  const canEdit = user?.role !== "courier";

  useEffect(() => {
    api("/api/settings").then((x) => { setS(x); if (x.start) setPin({ lat: x.start.lat, lon: x.start.lon }); });
    if (canEdit) api("/api/admin/network").then(setNet).catch(() => {});
  }, [canEdit]);

  async function geocodeStart() {
    try {
      const g = await api("/api/settings/start/geocode", { method: "POST" });
      setGeo(g);
      if (g.candidates[0]) setPin({ lat: g.candidates[0].lat, lon: g.candidates[0].lon });
      const best = g.candidates[0];
      setMsg(best ? { kind: best.precision === "exact" ? "info" : "warn", text: `Resultado: ${PRECISION_LABEL[best.precision]}. ${best.precision !== "exact" ? "O número não foi confirmado pelo provedor — arraste o pino até a entrada do imóvel." : ""}` } : { kind: "error", text: "Endereço não localizado; posicione o pino manualmente." });
      if (!best) setPin({ lat: -23.948, lon: -46.34 });
    } catch (e: any) {
      setMsg({ kind: "error", text: e.message });
    }
  }

  async function confirmStart() {
    if (!pin) return;
    const r = await api("/api/settings/start", { method: "PUT", json: { label: s.start_address, ...pin } });
    setS({ ...s, start: r });
    setMsg({ kind: "ok", text: "Ponto de partida confirmado." });
  }

  async function save() {
    const r = await api("/api/settings", { method: "PUT", json: { ride_speed_kmh: +s.ride_speed_kmh, walk_speed_kmh: +s.walk_speed_kmh, service_time_s: +s.service_time_s, per_letter_service_s: +s.per_letter_service_s, route_mode: s.route_mode } });
    setS({ ...s, ...r });
    setMsg({ kind: "ok", text: "Configurações salvas." });
  }

  const candidates = useMemo(() => (geo?.candidates || []).map((c: any) => ({ lat: c.lat, lon: c.lon, label: c.label })), [geo]);
  if (!s) return <AppShell title="Ajustes">…</AppShell>;
  const set = (k: string) => (e: any) => setS({ ...s, [k]: e.target.value });

  return (
    <AppShell title="Ajustes">
      {msg && <div className="mb-3"><Alert kind={msg.kind}>{msg.text}</Alert></div>}
      <Card className="mb-4 space-y-3">
        <div className="font-semibold">Ponto de partida</div>
        <div className="text-sm">{s.start_address} — {s.start?.confirmed ? <b className="text-done">confirmado ({s.start.lat.toFixed(6)}, {s.start.lon.toFixed(6)})</b> : <b className="text-problem">não confirmado</b>}</div>
        {canEdit && <Button variant="secondary" onClick={geocodeStart}><MapPin className="h-4 w-4" /> Geocodificar endereço padrão</Button>}
        <RouteMapLazy className="h-[45vh] w-full overflow-hidden rounded-2xl" candidates={candidates} pin={pin} onPinMove={canEdit ? (lat, lon) => setPin({ lat, lon }) : undefined} />
        {canEdit && pin && <Button onClick={confirmStart}>Confirmar posição do pino como ponto de partida</Button>}
      </Card>
      <Card className="mb-4 grid gap-3 md:grid-cols-2">
        <div className="md:col-span-2 font-semibold">Operação (bicicleta sobre rede de pedestres)</div>
        <div><Label htmlFor="ride">Velocidade média pedalando (km/h)</Label><Input id="ride" type="number" step="0.5" value={s.ride_speed_kmh} onChange={set("ride_speed_kmh")} disabled={!canEdit} /></div>
        <div><Label htmlFor="walk">Velocidade conduzindo a pé (km/h)</Label><Input id="walk" type="number" step="0.5" value={s.walk_speed_kmh} onChange={set("walk_speed_kmh")} disabled={!canEdit} /></div>
        <div><Label htmlFor="svc">Atendimento por parada (s)</Label><Input id="svc" type="number" value={s.service_time_s} onChange={set("service_time_s")} disabled={!canEdit} /></div>
        <div><Label htmlFor="svc2">Adicional por carta extra (s)</Label><Input id="svc2" type="number" value={s.per_letter_service_s} onChange={set("per_letter_service_s")} disabled={!canEdit} /></div>
        <div><Label htmlFor="mode">Tipo de rota padrão</Label>
          <Select id="mode" value={s.route_mode} onChange={set("route_mode")} disabled={!canEdit}>
            <option value="open">Aberta</option><option value="circular">Circular</option>
          </Select></div>
        {canEdit && <div className="flex items-end"><Button onClick={save}><Save className="h-4 w-4" /> Salvar</Button></div>}
      </Card>
      {net && (
        <Card className="text-sm">
          <div className="font-semibold">Malha de roteamento</div>
          <div>Motor: {net.engine} · versão {net.version} · {net.nodes ?? "?"} nós · {net.edges ?? "?"} trechos · fonte {net.source}</div>
          <div className="muted">Perfil pedestrian/foot. Dados © colaboradores do OpenStreetMap (ODbL).</div>
        </Card>
      )}
    </AppShell>
  );
}
