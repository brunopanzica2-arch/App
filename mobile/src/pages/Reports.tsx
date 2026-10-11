import { StopListSkeleton } from "../ui/states";
import { Download } from "lucide-react";
import { exportRows, report, shareFile } from "../core/service";
import { Button } from "../ui/button";
import { useAsync, useCurrentBatch } from "../ui/hooks";
import { Card, Stat } from "../ui/misc";
import { REASON_LABEL, STATUS_LABEL, fmtDist, fmtTime } from "../ui/utils";

export function ReportsPage() {
  const [batchId] = useCurrentBatch();
  const [rep] = useAsync(async () => (batchId ? report(batchId) : null), [batchId]);

  async function exportCsv() {
    const { headers, rows } = await exportRows(batchId!);
    const esc = (v: unknown) => `"${String(v ?? "").replace(/"/g, '""')}"`;
    const csv = "﻿" + [headers, ...rows].map((r) => r.map(esc).join(";")).join("\n");
    await shareFile(`relatorio-${batchId!.slice(0, 8)}.csv`, csv, "text/csv");
  }
  async function exportXlsx() {
    const { headers, rows } = await exportRows(batchId!);
    const { default: writeXlsxFile } = await import("write-excel-file/browser");
    const data = [headers.map((h) => ({ value: h, fontWeight: "bold" as const })), ...rows.map((r) => r.map((v) => ({ value: v as any })))];
    const blob = await writeXlsxFile(data as any).toBlob();
    await shareFile(`relatorio-${batchId!.slice(0, 8)}.xlsx`, blob, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  }

  if (!batchId) return <Card>Nenhum lote importado.</Card>;
  if (!rep) return <StopListSkeleton />;
  const delivered = rep.counts.delivered || 0;
  const r = rep.route;
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-3">
        <Stat label="Cartas" value={rep.letters} />
        <Stat label="Paradas" value={rep.stops} />
        <Stat label="Entregues" value={delivered} hint={`${rep.letters ? ((delivered / rep.letters) * 100).toFixed(1) : 0}%`} />
        <Stat label="Ocorrências" value={(rep.counts.not_delivered || 0) + (rep.counts.returned || 0) + (rep.counts.address_not_found || 0)} />
      </div>
      <Card className="text-sm">
        <div className="font-semibold">Planejado (estimativa)</div>
        {r ? <ul className="mt-1">
          <li>Distância: <b>{fmtDist(r.totalDistance)}</b></li>
          <li>Deslocamento: <b>{fmtTime(r.travelTime)}</b> · atendimento: <b>{fmtTime(r.serviceTime)}</b> · acesso às portas: <b>{fmtTime(r.metrics?.accessTime ?? 0)}</b></li>
          <li>Total: <b>{fmtTime(r.totalTime)}</b> (versão {r.version})</li>
        </ul> : <p className="muted">Sem rota.</p>}
        <div className="mt-3 font-semibold">Registrado</div>
        <ul className="mt-1">
          <li>Registros: <b>{rep.events}</b></li>
          <li>Entre o 1º e o último registro: <b>{rep.elapsed != null ? fmtTime(rep.elapsed) : "—"}</b></li>
          <li>Distância percorrida: <b>não medida</b> (sem rastreamento GPS)</li>
        </ul>
      </Card>
      <Card className="text-sm">
        <div className="mb-1 font-semibold">Status</div>
        {Object.entries(rep.counts).map(([k, v]) => <div key={k} className="flex justify-between"><span>{STATUS_LABEL[k] || k}</span><b>{v}</b></div>)}
        <div className="mb-1 mt-3 font-semibold">Motivos</div>
        {Object.keys(rep.reasons).length === 0 ? <div className="muted">Nenhum.</div> : Object.entries(rep.reasons).map(([k, v]) => <div key={k} className="flex justify-between"><span>{REASON_LABEL[k] || k}</span><b>{v}</b></div>)}
        <div className="mb-1 mt-3 font-semibold">Por bairro</div>
        {Object.entries(rep.neighborhoods).map(([k, v]) => <div key={k} className="flex justify-between"><span>{k}</span><b>{v.delivered}/{v.total}</b></div>)}
      </Card>
      <div className="grid grid-cols-2 gap-2">
        <Button variant="secondary" onClick={exportCsv}><Download className="h-4 w-4" /> CSV</Button>
        <Button variant="secondary" onClick={exportXlsx}><Download className="h-4 w-4" /> XLSX</Button>
      </div>
    </div>
  );
}
