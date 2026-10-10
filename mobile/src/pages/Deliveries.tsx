import { Search, Trash2, Upload } from "lucide-react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useMemo, useRef, useState } from "react";
import type { Nav } from "../App";
import { db } from "../core/db";
import { batchUndoSummary, diagnoseLegacy, reprocessLegacy, stopsOf, TERMINAL, undoBatch } from "../core/service";
import { Button } from "../ui/button";
import { useAsync, useCurrentBatch } from "../ui/hooks";
import { Alert, Badge, Card, Input, Select, Spinner } from "../ui/misc";
import { STOP_STATUS_LABEL } from "../ui/utils";

type Filter = "todas" | "pendentes" | "concluidas" | "nao_localizadas";

/** Aba "Entregas": lista de paradas (cartas ≠ endereços ≠ paradas), busca global, filtros e gestão de lotes. */
export function DeliveriesPage({ nav }: { nav: Nav }) {
  const [batchId, setBatchId] = useCurrentBatch();
  const [batches, reloadBatches] = useAsync(() => db.batches.orderBy("createdAt").reverse().toArray(), []);
  const [data, reload] = useAsync(async () => {
    if (!batchId) return null;
    const d = await stopsOf(batchId);
    const rs = (await db.routes.where("batchId").equals(batchId).toArray()).sort((a, b) => b.version - a.version);
    const route = rs.find((r) => r.status === "active") ?? null;
    return { ...d, route };
  }, [batchId]);
  const [legacy, reloadLegacy] = useAsync(async () => (batchId ? diagnoseLegacy(batchId) : null), [batchId]);
  const [q, setQ] = useState("");
  const [filter, setFilter] = useState<Filter>("todas");
  const [msg, setMsg] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  const rows = useMemo(() => {
    if (!data) return [];
    const seq = new Map(data.route?.stops.map((s) => [s.key, s.seq]) ?? []);
    const out = data.stops.map((s) => ({
      key: s.key, seq: seq.get(s.key) ?? null, title: s.address.display.split(" - ")[0], sub: s.address.neighborhood ?? "", letters: s.letters.length, status: s.status,
      hay: [s.address.display, ...s.letters.flatMap((l) => [l.externalId, l.recipient, l.complement])].join(" ").toLowerCase(), located: true,
      open: ["pending", "partial"].includes(s.status), trust: s.trust.label,
    }));
    const un = new Map<string, typeof out[number]>();
    for (const l of data.unlocated) {
      const k = l.addressKey ?? `row${l.row}`;
      const cur = un.get(k);
      if (cur) cur.letters++;
      else un.set(k, { key: k, seq: null, title: [l.street, l.number].filter(Boolean).join(", ") || `linha ${l.row}`, sub: l.neighborhood ?? "", letters: 1, status: "pending",
        hay: [l.street, l.number, l.neighborhood, l.externalId, l.recipient].join(" ").toLowerCase(), located: false, open: true, trust: "Não localizado" });
    }
    out.push(...un.values());
    out.sort((a, b) => (a.seq ?? 1e9) - (b.seq ?? 1e9));
    const t = q.trim().toLowerCase();
    return out.filter((r) => (!t || r.hay.includes(t)) && (filter === "todas" || (filter === "pendentes" ? r.open && r.located : filter === "concluidas" ? !r.open : !r.located)));
  }, [data, q, filter]);
  const virt = useVirtualizer({ count: rows.length, getScrollElement: () => ref.current, estimateSize: () => 68, overscan: 8 });

  async function removeBatch() {
    if (!batchId) return;
    const sum = { ...(await batchUndoSummary(batchId)), reference: (await db.batches.get(batchId))?.reference ?? "" };
    if (!confirm(`Desfazer a importação “${sum.reference}”?\n\nSerão removidas ${sum.letters} carta(s) e ${sum.events} registro(s) de entrega DESTE lote. Outros lotes não são afetados. Um instantâneo é guardado antes (Ajustes → Desfazer última restauração).`)) return;
    await undoBatch(batchId);
    setMsg(`Importação “${sum.reference}” desfeita.`);
    reloadBatches();
    reload();
    const next = await db.batches.orderBy("createdAt").reverse().first();
    if (next) setBatchId(next.id);
  }

  if (!batches) return <Spinner />;
  const total = data?.letters.length ?? 0;
  const done = data?.letters.filter((l) => TERMINAL.includes(l.status)).length ?? 0;

  return (
    <div className="space-y-3">
      <div className="flex gap-2">
        <Select aria-label="Lote" value={batchId ?? ""} onChange={(e) => setBatchId(e.target.value)} className="flex-1">
          {batches.map((b) => <option key={b.id} value={b.id}>{b.date} · {b.reference} ({b.report.inserted})</option>)}
        </Select>
        <Button onClick={() => nav("/importar")}><Upload className="h-5 w-5" /> Importar</Button>
      </div>
      {msg && <Alert kind="ok">{msg}</Alert>}
      {legacy && legacy.issues.length > 0 && (
        <Alert kind="warn">
          <b>{legacy.issues.length} carta(s) com cadastro inválido</b> (ex.: logradouro “{legacy.issues[0].street}”): {legacy.issues[0].reason}. Elas não entram na rota e nada foi apagado.
          <div className="mt-2"><Button size="sm" variant="secondary" onClick={async () => {
            const r = await reprocessLegacy(batchId!);
            setMsg(`Reprocessadas ${r.fixed} carta(s) a partir da linha original; ${r.remaining} ainda precisam de correção manual${r.skippedNoRaw ? ` (${r.skippedNoRaw} sem linha original guardada)` : ""}. Use “Validar / corrigir endereços” para localizar.`);
            reload(); reloadLegacy();
          }}>Reprocessar a partir da linha original</Button></div>
        </Alert>
      )}
      {!batches.length && <Card className="text-center">Nenhum lote importado. Toque em Importar.</Card>}
      {data && (
        <>
          <Card className="grid grid-cols-5 gap-1 p-2 text-center text-xs" data-testid="deliveries-counters">
            <div><b className="block text-lg">{total}</b>cartas</div>
            <div><b className="block text-lg">{data.stops.length}</b>paradas</div>
            <div><b className="block text-lg">{new Set(data.unlocated.map((l) => l.addressKey ?? l.row)).size}</b>não loc.</div>
            <div><b className="block text-lg">{done}</b>concluídas</div>
            <div><b className="block text-lg">{total - done}</b>pendentes</div>
          </Card>
          <div className="flex items-center gap-2"><Search className="h-5 w-5" /><Input aria-label="Buscar entrega" placeholder="Rua, número, código, destinatário…" value={q} onChange={(e) => setQ(e.target.value)} /></div>
          <div className="flex flex-wrap gap-2" role="group" aria-label="Filtro">
            {([["todas", "Todas"], ["pendentes", "Pendentes"], ["concluidas", "Concluídas"], ["nao_localizadas", "Não localizadas"]] as const).map(([k, l]) => (
              <Button key={k} size="sm" variant={filter === k ? "primary" : "secondary"} aria-pressed={filter === k} onClick={() => setFilter(k)}>{l}</Button>
            ))}
          </div>
          <div ref={ref} className="max-h-[55dvh] overflow-y-auto" tabIndex={0} role="region" aria-label="Lista de paradas" data-testid="stop-list">
            <ol className="relative" style={{ height: virt.getTotalSize() }} aria-label={`${rows.length} paradas`}>
              {virt.getVirtualItems().map((v) => {
                const r = rows[v.index];
                return (
                  <li key={r.key} className="absolute left-0 top-0 w-full border-b border-app" style={{ transform: `translateY(${v.start}px)` }} data-index={v.index} ref={virt.measureElement}>
                    <button className="flex w-full items-center gap-3 py-2 text-left" onClick={() => (r.located ? nav(`/?stop=${encodeURIComponent(r.key)}`) : nav(`/enderecos/${batchId}`))}>
                      <b className="w-9 text-right">{r.seq ?? "—"}</b>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate font-semibold">{r.title}</span>
                        <span className="block text-xs muted">{r.sub} · {r.letters} carta(s) · {r.located ? STOP_STATUS_LABEL[r.status] : "NÃO LOCALIZADA"}</span>
                      </span>
                      {!r.located && <Badge color="#dc2626">corrigir</Badge>}
                    </button>
                  </li>
                );
              })}
            </ol>
          </div>
          <div className="grid gap-2">
            <Button variant="secondary" onClick={() => nav(`/enderecos/${batchId}`)}>Validar / corrigir endereços</Button>
            <Button variant="secondary" onClick={() => nav(`/planejar/${batchId}`)}>Planejamento avançado</Button>
            <Button variant="ghost" onClick={removeBatch}><Trash2 className="h-5 w-5" /> Desfazer esta importação</Button>
          </div>
        </>
      )}
    </div>
  );
}
