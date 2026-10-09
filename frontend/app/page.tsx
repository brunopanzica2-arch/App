"use client";

import { AlertTriangle, MapPinned, Route as RouteIcon, Upload } from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";
import { AppShell, useCurrentBatch } from "@/components/AppShell";
import { Button } from "@/components/ui/button";
import { Alert, Card, Progress, Select, Spinner, Stat } from "@/components/ui/misc";
import { api } from "@/lib/api";
import { fmtDist, fmtTime } from "@/lib/utils";

export default function Dashboard() {
  const [batchId, setBatchId] = useCurrentBatch();
  const [batches, setBatches] = useState<any[] | null>(null);
  const [batch, setBatch] = useState<any>(null);
  const [route, setRoute] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api("/api/batches").then((b) => {
      setBatches(b);
      if (!localStorage.getItem("rota.batch") && b[0]) setBatchId(b[0].id);
    }).catch((e) => setError(e.message));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!batchId) return;
    setBatch(null);
    setRoute(null);
    api(`/api/batches/${batchId}`).then(setBatch).catch((e) => setError(e.message));
    api(`/api/batches/${batchId}/routes`).then(async (rs: any[]) => {
      const active = rs.find((r) => r.status === "active") || rs[0];
      if (active) setRoute(await api(`/api/routes/${active.id}`));
    }).catch(() => {});
  }, [batchId]);

  const total = batch?.correspondences ?? 0;
  const done = batch ? ["delivered", "not_delivered", "returned", "address_not_found"].reduce((a, k) => a + (batch.status_counts[k] || 0), 0) : 0;
  const remaining = route?.stops?.filter((s: any) => !["completed", "problem"].includes(s.status)) ?? [];
  const remDist = remaining.reduce((a: number, s: any) => a + s.leg_distance_m, 0);
  const remTime = remaining.reduce((a: number, s: any) => a + s.leg_time_s, 0);

  return (
    <AppShell title="Painel">
      {error && <Alert kind="error">{error}</Alert>}
      <div className="mb-4 flex flex-wrap items-end gap-2">
        <div className="min-w-60 flex-1">
          <label htmlFor="batch" className="mb-1 block text-sm muted">Lote / jornada</label>
          <Select id="batch" value={batchId ?? ""} onChange={(e) => setBatchId(e.target.value)}>
            {!batches?.length && <option value="">Nenhum lote importado</option>}
            {batches?.map((b) => (
              <option key={b.id} value={b.id}>{b.service_date} · {b.reference} ({b.row_count} cartas)</option>
            ))}
          </Select>
        </div>
        <Link href="/importar"><Button variant="secondary"><Upload className="h-4 w-4" /> Importar</Button></Link>
      </div>

      {!batches && <Spinner />}
      {batches && !batches.length && (
        <Card className="text-center">
          <p className="mb-3">Comece importando as correspondências do dia (CSV, XLSX ou texto).</p>
          <Link href="/importar"><Button size="lg"><Upload className="h-5 w-5" /> Importar cartas</Button></Link>
        </Card>
      )}

      {batch && (
        <>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            <Stat label="Cartas" value={total} hint={`${batch.status_counts.delivered || 0} entregues`} />
            <Stat label="Paradas físicas" value={batch.stops} hint="imóveis agrupados" />
            <Stat label="Distância restante" value={route ? fmtDist(remDist) : "—"} hint="estimativa da rota" />
            <Stat label="Tempo restante" value={route ? fmtTime(remTime) : "—"} hint="deslocamento estimado" />
          </div>
          <Card className="mt-3">
            <div className="mb-2 flex justify-between text-sm"><span>Progresso</span><span className="font-semibold">{done}/{total}</span></div>
            <Progress value={total ? done / total : 0} />
          </Card>
          {batch.last_job && batch.last_job.status !== "done" && (
            <div className="mt-3"><Alert kind={batch.last_job.status === "failed" ? "error" : "info"}>
              Tarefa {batch.last_job.kind}: {batch.last_job.status} {Math.round(batch.last_job.progress * 100)}% {batch.last_job.error || ""}
            </Alert></div>
          )}
          {(batch.needs_review > 0 || batch.without_address > 0) && (
            <div className="mt-3"><Alert kind="warn">
              <AlertTriangle className="mr-1 inline h-4 w-4" />
              {batch.needs_review} endereço(s) precisam de revisão · {batch.without_address} carta(s) sem endereço válido.
            </Alert></div>
          )}
          <div className="mt-4 grid gap-3 md:grid-cols-3">
            <Link href={`/lotes/${batch.id}/enderecos`}><Button variant="secondary" size="lg" className="w-full"><MapPinned className="h-5 w-5" /> Validar endereços</Button></Link>
            <Link href={`/lotes/${batch.id}/planejar`}><Button variant="secondary" size="lg" className="w-full"><RouteIcon className="h-5 w-5" /> Planejar rota</Button></Link>
            <Link href={route ? `/rota/${route.id}` : `/lotes/${batch.id}/planejar`}><Button size="lg" className="w-full">Abrir jornada</Button></Link>
          </div>
          <Card className="mt-4 text-sm">
            <div className="mb-2 font-semibold">Precisão da geocodificação</div>
            <div className="flex flex-wrap gap-3">
              {Object.entries(batch.precision_counts || {}).map(([k, v]) => <span key={k}>{k}: <b>{String(v)}</b></span>)}
            </div>
          </Card>
        </>
      )}
    </AppShell>
  );
}
