import { AlertTriangle, MapPinned, Route as RouteIcon, Upload } from "lucide-react";
import type { Nav } from "../App";
import { db } from "../core/db";
import { getSettings, stopsOf, TERMINAL } from "../core/service";
import { Button } from "../ui/button";
import { useAsync, useCurrentBatch } from "../ui/hooks";
import { Alert, Card, Progress, Select, Spinner, Stat } from "../ui/misc";
import { fmtDist, fmtTime } from "../ui/utils";

export function Dashboard({ nav }: { nav: Nav }) {
  const [batchId, setBatchId] = useCurrentBatch();
  const [batches] = useAsync(() => db.batches.orderBy("createdAt").reverse().toArray(), []);
  const [settings] = useAsync(getSettings, []);
  const [data] = useAsync(async () => {
    if (!batchId) return null;
    const { stops, unlocated, letters, addresses } = await stopsOf(batchId);
    const routes = (await db.routes.where("batchId").equals(batchId).toArray()).sort((a, b) => b.version - a.version);
    const route = routes.find((r) => r.status === "active") || routes[0];
    return { stops, unlocated, letters, addresses, route };
  }, [batchId]);

  if (!batches) return <Spinner />;
  if (!batches.length)
    return (
      <Card className="space-y-3 text-center">
        <p>Comece importando as correspondências do dia (CSV, XLSX ou texto colado).</p>
        {!settings?.start?.confirmed && <Alert kind="warn">Antes de calcular rotas, confirme o ponto de partida em Ajustes.</Alert>}
        <Button size="lg" onClick={() => nav("/importar")}><Upload className="h-5 w-5" /> IMPORTAR E PLANEJAR</Button>
      </Card>
    );

  const total = data?.letters.length ?? 0;
  const done = data?.letters.filter((l) => TERMINAL.includes(l.status)).length ?? 0;
  const route = data?.route;
  const statusByKey = new Map(data?.stops.map((s) => [s.key, s.status]));
  const remaining = route?.stops.filter((s) => !["completed", "problem"].includes(statusByKey.get(s.key) || "")) ?? [];
  const review = data?.addresses.filter((a) => a.needsReview).length ?? 0;

  return (
    <div className="space-y-3">
      <Select aria-label="Lote" value={batchId ?? ""} onChange={(e) => setBatchId(e.target.value)}>
        {batches.map((b) => <option key={b.id} value={b.id}>{b.date} · {b.reference} ({b.report.inserted} cartas)</option>)}
      </Select>
      {!settings?.start?.confirmed && <Alert kind="warn">Ponto de partida não confirmado — vá em Ajustes.</Alert>}
      {!data ? <Spinner /> : (
        <>
          <Card className="p-3 text-center">
            <div className="text-2xl font-extrabold">{total} cartas / {data.stops.length + new Set(data.unlocated.map((l) => l.addressKey)).size} imóveis / {new Set(data.letters.map((l) => l.neighborhood).filter(Boolean)).size} bairros</div>
            <div className="text-xs muted">{data.stops.length} paradas localizadas · {data.unlocated.length} carta(s) aguardando localização</div>
          </Card>
          <button onClick={() => nav(`/enderecos/${batchId}`)} className="card w-full p-3 text-left">
            <div className="text-xs font-semibold uppercase muted">Endereços a conferir</div>
            <div className="text-xl font-bold">{review + new Set(data.unlocated.map((l) => l.addressKey)).size} pendência(s)</div>
            <div className="text-xs muted">{data.addresses.filter((a) => a.precision === "test").length} posição(ões) de TESTE · {data.addresses.filter((a) => a.precision === "manual").length} confirmada(s) no mapa</div>
          </button>
          <div className="grid grid-cols-2 gap-3">
            <Stat label="Cartas" value={total} hint={`${data.letters.filter((l) => l.status === "delivered").length} entregues`} />
            <Stat label="Paradas" value={data.stops.length} hint="imóveis agrupados" />
            <Stat label="Distância restante" value={route ? fmtDist(remaining.reduce((a, s) => a + s.legDistance, 0)) : "—"} hint="estimativa" />
            <Stat label="Tempo restante" value={route ? fmtTime(remaining.reduce((a, s) => a + s.legTime, 0)) : "—"} hint="deslocamento" />
          </div>
          <Card>
            <div className="mb-2 flex justify-between text-sm"><span>Progresso</span><b>{done}/{total}</b></div>
            <Progress value={total ? done / total : 0} />
          </Card>
          {(review > 0 || data.unlocated.length > 0) && (
            <Alert kind="warn"><AlertTriangle className="mr-1 inline h-4 w-4" />{review} endereço(s) para revisar · {data.unlocated.length} carta(s) sem localização.</Alert>
          )}
          <div className="grid gap-2">
            <Button variant="secondary" size="lg" onClick={() => nav(`/enderecos/${batchId}`)}><MapPinned className="h-5 w-5" /> Validar endereços</Button>
            <Button variant="secondary" size="lg" onClick={() => nav(`/planejar/${batchId}`)}><RouteIcon className="h-5 w-5" /> Planejar rota</Button>
            <Button size="lg" onClick={() => nav(route ? `/rota/${route.id}` : `/planejar/${batchId}`)}>Abrir jornada</Button>
          </div>
        </>
      )}
    </div>
  );
}
