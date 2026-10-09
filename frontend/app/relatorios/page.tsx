"use client";

import { Download } from "lucide-react";
import { useEffect, useState } from "react";
import { AppShell, useCurrentBatch } from "@/components/AppShell";
import { Button } from "@/components/ui/button";
import { Alert, Card, Select, Spinner, Stat } from "@/components/ui/misc";
import { api } from "@/lib/api";
import { STATUS_LABEL, REASON_LABEL, fmtDist, fmtTime } from "@/lib/utils";

export default function Reports() {
  const [batchId] = useCurrentBatch();
  const [rep, setRep] = useState<any>(null);
  const [group, setGroup] = useState("day");
  const [hist, setHist] = useState<any[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (batchId) api(`/api/batches/${batchId}/report`).then(setRep).catch((e) => setError(e.message));
  }, [batchId]);
  useEffect(() => { api(`/api/reports/history?group=${group}`).then(setHist).catch(() => setHist([])); }, [group]);

  async function download(format: "csv" | "xlsx") {
    const blob = await api<Blob>(`/api/batches/${batchId}/export?format=${format}`);
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `relatorio-${rep.batch.service_date}.${format}`;
    a.click();
  }

  return (
    <AppShell title="Relatórios">
      {error && <Alert kind="error">{error}</Alert>}
      {!rep && batchId && <Spinner />}
      {rep && (
        <>
          <div className="mb-2 text-sm muted">{rep.batch.reference} · {rep.batch.service_date}</div>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            <Stat label="Cartas importadas" value={rep.correspondences} />
            <Stat label="Paradas únicas" value={rep.stops} hint={`${rep.unique_properties} imóveis`} />
            <Stat label="Entregues" value={rep.delivered} hint={`taxa ${(rep.completion_rate * 100).toFixed(1)}%`} />
            <Stat label="Não entregues" value={(rep.status_counts.not_delivered || 0) + (rep.status_counts.returned || 0) + (rep.status_counts.address_not_found || 0)} />
          </div>
          <div className="mt-3 grid gap-3 md:grid-cols-2">
            <Card>
              <div className="font-semibold">Planejado (estimativa)</div>
              {rep.planned ? (
                <ul className="mt-2 text-sm">
                  <li>Distância planejada: <b>{fmtDist(rep.planned.distance_m)}</b></li>
                  <li>Deslocamento estimado: <b>{fmtTime(rep.planned.travel_time_s)}</b></li>
                  <li>Tempo de serviço: <b>{fmtTime(rep.planned.service_time_s)}</b></li>
                  <li>Total estimado: <b>{fmtTime(rep.planned.total_time_s)}</b> (versão {rep.planned.route_version})</li>
                </ul>
              ) : <p className="text-sm muted">Sem rota calculada.</p>}
              <p className="mt-2 text-xs muted">{rep.planned?.note}</p>
            </Card>
            <Card>
              <div className="font-semibold">Registrado (eventos reais)</div>
              <ul className="mt-2 text-sm">
                <li>Eventos registrados: <b>{rep.recorded.events}</b></li>
                <li>Tempo entre 1º e último registro: <b>{rep.recorded.elapsed_between_first_and_last_event_s != null ? fmtTime(rep.recorded.elapsed_between_first_and_last_event_s) : "—"}</b></li>
                <li>Diferença registrado − previsto: <b>{rep.planned_vs_recorded_s != null ? fmtTime(rep.planned_vs_recorded_s) : "—"}</b></li>
                <li>Distância percorrida: <b>não medida</b></li>
              </ul>
              <p className="mt-2 text-xs muted">{rep.recorded.note}</p>
            </Card>
          </div>
          <div className="mt-3 grid gap-3 md:grid-cols-2">
            <Card>
              <div className="mb-2 font-semibold">Status</div>
              {Object.entries(rep.status_counts).map(([k, v]) => <div key={k} className="flex justify-between text-sm"><span>{STATUS_LABEL[k] || k}</span><b>{String(v)}</b></div>)}
              <div className="mb-2 mt-3 font-semibold">Ocorrências por motivo</div>
              {Object.keys(rep.occurrences_by_reason).length === 0 && <div className="text-sm muted">Nenhuma.</div>}
              {Object.entries(rep.occurrences_by_reason).map(([k, v]) => <div key={k} className="flex justify-between text-sm"><span>{REASON_LABEL[k] || k}</span><b>{String(v)}</b></div>)}
            </Card>
            <Card>
              <div className="mb-2 font-semibold">Por bairro</div>
              <table className="w-full text-sm"><tbody>
                {Object.entries(rep.by_neighborhood).map(([nb, d]: any) => (
                  <tr key={nb} className="border-t border-app"><td className="py-1">{nb}</td><td className="text-right">{d.delivered || 0}/{d.total}</td></tr>
                ))}
              </tbody></table>
            </Card>
          </div>
          <div className="mt-3 flex gap-2">
            <Button variant="secondary" onClick={() => download("csv")}><Download className="h-4 w-4" /> CSV</Button>
            <Button variant="secondary" onClick={() => download("xlsx")}><Download className="h-4 w-4" /> XLSX</Button>
          </div>
        </>
      )}
      <Card className="mt-4">
        <div className="mb-2 flex items-center justify-between"><div className="font-semibold">Histórico</div>
          <Select className="w-40" value={group} onChange={(e) => setGroup(e.target.value)} aria-label="Agrupar por">
            <option value="day">Diário</option><option value="week">Semanal</option><option value="month">Mensal</option>
          </Select></div>
        {!hist ? <Spinner /> : (
          <table className="w-full text-sm">
            <thead><tr className="muted text-left"><th>Período</th><th>Cartas</th><th>Entregues</th><th>Taxa</th></tr></thead>
            <tbody>{hist.map((h) => <tr key={h.period} className="border-t border-app"><td className="py-1">{h.period}</td><td>{h.total}</td><td>{h.delivered || 0}</td><td>{(h.completion_rate * 100).toFixed(1)}%</td></tr>)}</tbody>
          </table>
        )}
      </Card>
    </AppShell>
  );
}
