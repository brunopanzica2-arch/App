import { Play, Zap } from "lucide-react";
import { useMemo, useState } from "react";
import type { Nav } from "../App";
import { db, type Route } from "../core/db";
import { activateRoute, getSettings, planBatch, saveSettings, stopsOf } from "../core/service";
import { Button } from "../ui/button";
import { useAsync } from "../ui/hooks";
import { Alert, Card, Input, Label, Progress, Select, Stat } from "../ui/misc";
import RouteMap, { MapLegend } from "../ui/RouteMap";
import { fmtDist, fmtTime } from "../ui/utils";

export function PlanPage({ batchId, nav }: { batchId: string; nav: Nav }) {
  const [settings, reloadSettings] = useAsync(getSettings, []);
  const [routes, reloadRoutes] = useAsync(async () => (await db.routes.where("batchId").equals(batchId).toArray()).sort((a, b) => b.version - a.version), [batchId]);
  const [stops] = useAsync(() => stopsOf(batchId), [batchId]);
  const [selId, setSelId] = useState<string | null>(null);
  const [mode, setMode] = useState<"open" | "circular" | "fixed_end">("open");
  const [strategy, setStrategy] = useState<"global" | "sectors">("global");
  const [limit, setLimit] = useState(10);
  const [end, setEnd] = useState({ lat: "", lon: "" });
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const sel: Route | undefined = routes?.find((r) => r.id === selId) || routes?.[0];

  async function run() {
    if (!settings?.start?.confirmed) return setError("Confirme o ponto de partida em Ajustes.");
    setError(null);
    setBusy("Carregando malha…");
    try {
      const r = await planBatch(batchId, {
        mode, strategy, start: settings.start, timeLimitMs: limit * 1000,
        end: mode === "fixed_end" ? { label: "Destino", lat: +end.lat, lon: +end.lon } : null,
      }, (stage, p) => setBusy(`${stage} ${Math.round(p * 100)}%`));
      setSelId(r.id);
      reloadRoutes();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  const statusByKey = useMemo(() => new Map(stops?.stops.map((s) => [s.key, s]) ?? []), [stops]);
  const mapStops = useMemo(() => (sel?.stops || []).map((s) => {
    const st = statusByKey.get(s.key);
    return { id: s.key, lat: st?.address.lat ?? 0, lon: st?.address.lon ?? 0, seq: s.seq, status: st?.status ?? "pending", uncertain: st?.uncertain };
  }), [sel, statusByKey]);

  const p = settings?.profile;
  const setP = async (k: string, v: any) => { await saveSettings({ profile: { ...settings!.profile, [k]: v } }); reloadSettings(); };

  return (
    <div className="space-y-3">
      {settings && !settings.start?.confirmed && <Alert kind="warn">Confirme o ponto de partida em Ajustes antes de calcular.</Alert>}
      <Card className="space-y-3">
        <Alert kind="info">Cálculo pela <b>rede de pedestres</b> de Santos (sem mão única de carros, sem priorizar ciclovias), feito no próprio celular. Tempo pela velocidade da bicicleta.</Alert>
        <div className="grid grid-cols-2 gap-3">
          <div><Label htmlFor="mode">Rota</Label>
            <Select id="mode" value={mode} onChange={(e) => setMode(e.target.value as any)}>
              <option value="open">Aberta (padrão)</option><option value="circular">Circular</option><option value="fixed_end">Destino fixo</option>
            </Select></div>
          <div><Label htmlFor="strat">Estratégia</Label>
            <Select id="strat" value={strategy} onChange={(e) => setStrategy(e.target.value as any)}>
              <option value="global">Global</option><option value="sectors">Por bairros</option>
            </Select></div>
          {p && <>
            <div><Label htmlFor="ride">Pedalando (km/h)</Label><Input id="ride" type="number" step="0.5" value={p.ride_speed_kmh} onChange={(e) => setP("ride_speed_kmh", +e.target.value)} /></div>
            <div><Label htmlFor="walk">A pé c/ bicicleta (km/h)</Label><Input id="walk" type="number" step="0.5" value={p.walk_speed_kmh} onChange={(e) => setP("walk_speed_kmh", +e.target.value)} /></div>
            <div><Label htmlFor="sw">Calçadas</Label>
              <Select id="sw" value={p.sidewalk_mode} onChange={(e) => setP("sidewalk_mode", e.target.value)}><option value="walk">Conduzir a pé</option><option value="ride">Pedalável</option></Select></div>
            <div><Label htmlFor="tl">Tempo de cálculo (s)</Label><Input id="tl" type="number" value={limit} onChange={(e) => setLimit(+e.target.value)} /></div>
            {(["steps_policy", "private_policy", "barrier_policy"] as const).map((k) => (
              <div key={k}><Label htmlFor={k}>{{ steps_policy: "Escadas", private_policy: "Acessos privados", barrier_policy: "Barreiras" }[k]}</Label>
                <Select id={k} value={p[k]} onChange={(e) => setP(k, e.target.value)}>
                  <option value="allow">Permitir</option><option value="penalize">Penalizar</option><option value="forbid">Evitar</option>
                </Select></div>
            ))}
          </>}
        </div>
        {mode === "fixed_end" && (
          <div className="grid grid-cols-2 gap-2">
            <Input placeholder="Latitude do destino" value={end.lat} onChange={(e) => setEnd({ ...end, lat: e.target.value })} />
            <Input placeholder="Longitude do destino" value={end.lon} onChange={(e) => setEnd({ ...end, lon: e.target.value })} />
          </div>
        )}
        {error && <Alert kind="error">{error}</Alert>}
        {busy ? <div><div className="mb-1 text-sm">Calculando: {busy}</div><Progress value={0.5} /></div>
          : <Button size="lg" className="w-full" onClick={run}><Zap className="h-5 w-5" /> Calcular rota</Button>}
      </Card>

      <RouteMap className="h-[50vh] w-full overflow-hidden rounded-2xl" stops={mapStops} route={sel?.geojson} start={sel?.start ?? settings?.start ?? null} />
      <MapLegend />
      {sel && (
        <>
          <div className="grid grid-cols-2 gap-3">
            <Stat label="Distância" value={fmtDist(sel.totalDistance)} hint="estimada (pedestre)" />
            <Stat label="Tempo total" value={fmtTime(sel.totalTime)} hint={`deslocamento ${fmtTime(sel.travelTime)}`} />
            <Stat label="Paradas" value={sel.metrics.stops} hint={`${sel.metrics.letters} cartas`} />
            <Stat label="Cálculo" value={`${(sel.metrics.timings.total_ms / 1000).toFixed(1)} s`} hint={`matriz ${(sel.metrics.timings.matrix_ms / 1000).toFixed(1)} s`} />
          </div>
          <Card className="text-sm">
            <div className="mb-1 font-semibold">Soluções comparadas</div>
            {sel.candidates.map((c: any) => (
              <div key={c.strategy} className={`flex justify-between ${c.strategy === sel.metrics.strategy ? "font-bold text-brand" : ""}`}>
                <span className="truncate">{c.strategy}</span><span>{fmtTime(c.time_s)} · {fmtDist(c.distance_m)}</span>
              </div>
            ))}
            <p className="mt-2 text-xs muted">Busca local no aparelho; não garante ótimo global. {sel.metrics.note}</p>
          </Card>
          {sel.warnings.length > 0 && <Alert kind="warn"><ul className="list-disc pl-4">{sel.warnings.map((w, i) => <li key={i}>{w}</li>)}</ul></Alert>}
          {routes && routes.length > 1 && (
            <Card className="text-sm"><div className="mb-1 font-semibold">Versões</div>
              {routes.map((r) => <button key={r.id} onClick={() => setSelId(r.id)} className={`block w-full py-1 text-left ${r.id === sel.id ? "text-brand font-bold" : ""}`}>v{r.version} · {r.status} · {fmtDist(r.totalDistance)} · {fmtTime(r.totalTime)}</button>)}
            </Card>
          )}
          <Button size="lg" className="w-full" onClick={async () => { await activateRoute(sel); nav(`/rota/${sel.id}`); }}>
            <Play className="h-5 w-5" /> {sel.status === "active" ? "Abrir jornada" : "Ativar e iniciar jornada"}
          </Button>
        </>
      )}
    </div>
  );
}
