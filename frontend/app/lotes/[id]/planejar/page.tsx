"use client";

import { Play, Zap } from "lucide-react";
import { useParams, useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import { AppShell } from "@/components/AppShell";
import { MapLegend, RouteMapLazy } from "@/components/Map";
import { Button } from "@/components/ui/button";
import { Alert, Card, Input, Label, Progress, Select, Stat } from "@/components/ui/misc";
import { api, waitJob } from "@/lib/api";
import { fmtDist, fmtTime } from "@/lib/utils";

export default function PlanPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const [settings, setSettings] = useState<any>(null);
  const [routes, setRoutes] = useState<any[]>([]);
  const [selected, setSelected] = useState<any>(null);
  const [busy, setBusy] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [opt, setOpt] = useState({
    route_mode: "open", strategy: "global", ride_speed_kmh: 15, walk_speed_kmh: 4.5,
    service_time_s: 45, per_letter_service_s: 10, time_limit_s: 20,
    steps_policy: "penalize", private_policy: "penalize", barrier_policy: "penalize", sidewalk_mode: "walk",
    end_label: "", end_lat: "", end_lon: "",
  });

  const loadRoutes = useCallback(async () => {
    const rs = await api(`/api/batches/${id}/routes`);
    setRoutes(rs);
    if (rs[0]) setSelected(await api(`/api/routes/${rs[0].id}`));
  }, [id]);

  useEffect(() => {
    api("/api/settings").then((s) => {
      setSettings(s);
      setOpt((o) => ({ ...o, ride_speed_kmh: s.ride_speed_kmh, walk_speed_kmh: s.walk_speed_kmh, service_time_s: s.service_time_s, per_letter_service_s: s.per_letter_service_s, route_mode: s.route_mode || "open" }));
    });
    void loadRoutes();
  }, [loadRoutes]);

  async function run() {
    setError(null);
    setBusy(0);
    try {
      const body: any = {
        route_mode: opt.route_mode, strategy: opt.strategy, service_time_s: +opt.service_time_s,
        per_letter_service_s: +opt.per_letter_service_s, time_limit_s: +opt.time_limit_s,
        profile: {
          ride_speed_kmh: +opt.ride_speed_kmh, walk_speed_kmh: +opt.walk_speed_kmh, sidewalk_mode: opt.sidewalk_mode,
          steps_policy: opt.steps_policy, private_policy: opt.private_policy, barrier_policy: opt.barrier_policy,
        },
      };
      if (opt.route_mode === "fixed_end") body.end = { label: opt.end_label || "Destino", lat: +opt.end_lat, lon: +opt.end_lon };
      const r = await api(`/api/batches/${id}/routes`, { method: "POST", json: body });
      await waitJob(r.job.id, setBusy);
      await loadRoutes();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(null);
    }
  }

  async function activate() {
    await api(`/api/routes/${selected.id}/activate`, { method: "POST" });
    router.push(`/rota/${selected.id}`);
  }

  const stops = useMemo(() => (selected?.stops || []).map((s: any) => ({
    id: s.id, lat: s.lat, lon: s.lon, seq: s.sequence, status: s.status,
    uncertain: !["exact", "manual", "interpolated"].includes(s.address.precision),
  })), [selected]);

  const set = (k: string) => (e: any) => setOpt({ ...opt, [k]: e.target.value });

  return (
    <AppShell title="Planejamento da rota" wide>
      {settings && !settings.start?.confirmed && (
        <div className="mb-3"><Alert kind="warn">Ponto de partida ainda não confirmado. Confirme “{settings.start_address}” em Ajustes antes de calcular.</Alert></div>
      )}
      <div className="grid gap-4 xl:grid-cols-[400px_1fr]">
        <Card className="space-y-3">
          <div className="font-semibold">Parâmetros</div>
          <Alert kind="info">Rede de cálculo: <b>pedestre (foot)</b> — sem sentidos únicos de automóveis e sem priorizar ciclovias. Tempo pela velocidade operacional da bicicleta.</Alert>
          <div className="grid grid-cols-2 gap-3">
            <div><Label htmlFor="mode">Tipo de rota</Label>
              <Select id="mode" value={opt.route_mode} onChange={set("route_mode")}>
                <option value="open">Aberta (padrão)</option><option value="circular">Circular (volta à base)</option><option value="fixed_end">Destino final fixo</option>
              </Select></div>
            <div><Label htmlFor="strat">Estratégia</Label>
              <Select id="strat" value={opt.strategy} onChange={set("strategy")}>
                <option value="global">Global (ignora bairros)</option><option value="sectors">Por setores (bairros)</option>
              </Select></div>
            <div><Label htmlFor="ride">Velocidade pedalando (km/h)</Label><Input id="ride" type="number" step="0.5" value={opt.ride_speed_kmh} onChange={set("ride_speed_kmh")} /></div>
            <div><Label htmlFor="walk">Conduzindo a pé (km/h)</Label><Input id="walk" type="number" step="0.5" value={opt.walk_speed_kmh} onChange={set("walk_speed_kmh")} /></div>
            <div><Label htmlFor="svc">Atendimento por parada (s)</Label><Input id="svc" type="number" value={opt.service_time_s} onChange={set("service_time_s")} /></div>
            <div><Label htmlFor="svc2">+ por carta extra (s)</Label><Input id="svc2" type="number" value={opt.per_letter_service_s} onChange={set("per_letter_service_s")} /></div>
            <div><Label htmlFor="sidewalk">Calçadas</Label>
              <Select id="sidewalk" value={opt.sidewalk_mode} onChange={set("sidewalk_mode")}>
                <option value="walk">Conduzir a pé</option><option value="ride">Pedalável</option>
              </Select></div>
            <div><Label htmlFor="tl">Tempo de cálculo (s)</Label><Input id="tl" type="number" value={opt.time_limit_s} onChange={set("time_limit_s")} /></div>
            {(["steps_policy", "private_policy", "barrier_policy"] as const).map((k) => (
              <div key={k}><Label htmlFor={k}>{{ steps_policy: "Escadas", private_policy: "Acessos privados", barrier_policy: "Barreiras" }[k]}</Label>
                <Select id={k} value={opt[k]} onChange={set(k)}>
                  <option value="allow">Permitir (sinalizar)</option><option value="penalize">Penalizar</option><option value="forbid">Evitar</option>
                </Select></div>
            ))}
          </div>
          {opt.route_mode === "fixed_end" && (
            <div className="grid grid-cols-3 gap-2">
              <Input placeholder="Destino" value={opt.end_label} onChange={set("end_label")} />
              <Input placeholder="Latitude" value={opt.end_lat} onChange={set("end_lat")} />
              <Input placeholder="Longitude" value={opt.end_lon} onChange={set("end_lon")} />
            </div>
          )}
          {error && <Alert kind="error">{error}</Alert>}
          {busy !== null ? (
            <div><div className="mb-1 text-sm">Calculando matriz de pedestres e otimizando…</div><Progress value={busy || 0.05} /></div>
          ) : (
            <Button size="lg" className="w-full" onClick={run}><Zap className="h-5 w-5" /> Calcular rota</Button>
          )}
          {routes.length > 0 && (
            <div>
              <div className="mb-1 mt-3 font-semibold">Versões</div>
              <div className="space-y-1">
                {routes.map((r) => (
                  <button key={r.id} onClick={async () => setSelected(await api(`/api/routes/${r.id}`))} className={`card w-full p-2 text-left text-sm ${selected?.id === r.id ? "!border-brand" : ""}`}>
                    v{r.version} · {r.status} · {fmtDist(r.total_distance_m)} · {fmtTime(r.total_time_s)} · {r.metrics.stops} paradas · {r.route_mode}/{r.strategy}
                  </button>
                ))}
              </div>
            </div>
          )}
        </Card>
        <div className="space-y-3">
          <RouteMapLazy className="h-[60vh] w-full overflow-hidden rounded-2xl" stops={stops} route={selected?.geojson} start={selected?.start} />
          <MapLegend />
          {selected && (
            <>
              <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
                <Stat label="Distância" value={fmtDist(selected.total_distance_m)} hint="estimada (rede de pedestres)" />
                <Stat label="Tempo total" value={fmtTime(selected.total_time_s)} hint={`deslocamento ${fmtTime(selected.travel_time_s)}`} />
                <Stat label="Paradas" value={selected.metrics.stops} hint={`${selected.metrics.correspondences} cartas`} />
                <Stat label="Cálculo" value={`${((selected.metrics.timings_ms.total_ms || 0) / 1000).toFixed(1)} s`} hint={`matriz ${(selected.metrics.timings_ms.matrix_ms / 1000).toFixed(1)} s`} />
              </div>
              <Card>
                <div className="mb-2 font-semibold">Comparação de soluções candidatas</div>
                <table className="w-full text-sm">
                  <thead><tr className="muted text-left"><th>Estratégia</th><th>Tempo</th><th>Distância</th><th>Cálculo</th></tr></thead>
                  <tbody>{selected.candidates.map((c: any) => (
                    <tr key={c.strategy} className={c.strategy === selected.metrics.chosen_strategy ? "font-bold text-brand" : ""}>
                      <td>{c.strategy}</td><td>{fmtTime(c.time_s)}</td><td>{fmtDist(c.distance_m)}</td><td>{c.solve_ms} ms</td>
                    </tr>))}</tbody>
                </table>
                <p className="mt-2 text-xs muted">O OR-Tools busca uma boa solução dentro do tempo limite; não há garantia de ótimo global. {selected.metrics.estimates_note}</p>
              </Card>
              {selected.warnings.length > 0 && <Alert kind="warn"><ul className="list-disc pl-4">{selected.warnings.map((w: string, i: number) => <li key={i}>{w}</li>)}</ul></Alert>}
              <Button size="lg" onClick={activate} disabled={selected.status === "active"}><Play className="h-5 w-5" /> {selected.status === "active" ? "Rota ativa" : "Ativar e iniciar jornada"}</Button>
            </>
          )}
        </div>
      </div>
    </AppShell>
  );
}
