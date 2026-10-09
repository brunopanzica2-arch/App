"use client";

import { FileSpreadsheet, ClipboardPaste, PencilLine } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { AppShell } from "@/components/AppShell";
import { Button } from "@/components/ui/button";
import { Alert, Card, Input, Label, Progress, Select } from "@/components/ui/misc";
import { api, waitJob } from "@/lib/api";
import { cn } from "@/lib/utils";

const FIELDS: [string, string][] = [
  ["external_id", "Identificador"], ["recipient", "Destinatário"], ["street", "Logradouro"], ["number", "Número"],
  ["complement", "Complemento"], ["neighborhood", "Bairro"], ["city", "Município"], ["cep", "CEP"],
  ["notes", "Observações"], ["full_address", "Endereço completo (texto livre)"],
];

type Mode = "file" | "text" | "manual";

export default function ImportPage() {
  const router = useRouter();
  const [mode, setMode] = useState<Mode>("file");
  const [file, setFile] = useState<File | null>(null);
  const [text, setText] = useState("");
  const [delimiter, setDelimiter] = useState("auto");
  const [hasHeader, setHasHeader] = useState(true);
  const [preview, setPreview] = useState<any>(null);
  const [mapping, setMapping] = useState<Record<string, string | null>>({});
  const [reference, setReference] = useState(`Lote ${new Date().toLocaleDateString("pt-BR")}`);
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<number | null>(null);
  const [result, setResult] = useState<any>(null);
  const [manual, setManual] = useState({ street: "", number: "", complement: "", neighborhood: "", cep: "", external_id: "", recipient: "" });

  function form(extra: Record<string, string> = {}) {
    const fd = new FormData();
    if (mode === "file" && file) fd.append("file", file);
    if (mode === "text") fd.append("text", text);
    fd.append("options", JSON.stringify({ delimiter, has_header: hasHeader }));
    Object.entries(extra).forEach(([k, v]) => fd.append(k, v));
    return fd;
  }

  async function doPreview(m?: Record<string, string | null>) {
    setBusy(true);
    setError(null);
    try {
      const extra: Record<string, string> = m ? { mapping: JSON.stringify(m) } : {};
      const p = await api("/api/imports/preview", { method: "POST", body: form(extra) });
      setPreview(p);
      setMapping(p.mapping);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  async function commit(allowSame = false) {
    setBusy(true);
    setError(null);
    try {
      const r = await api("/api/imports/commit", {
        method: "POST",
        body: form({ mapping: JSON.stringify(mapping), reference, service_date: date, allow_same_file: String(allowSame) }),
      });
      localStorage.setItem("rota.batch", r.batch.id);
      setResult(r.batch);
      if (r.job_id) {
        setProgress(0);
        const j = await waitJob(r.job_id, setProgress);
        setResult({ ...r.batch, geocode: j.result });
      }
    } catch (e: any) {
      if (e.status === 409 && confirm(`${e.message}\n\nImportar mesmo assim?`)) return commit(true);
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  async function addManual() {
    setBusy(true);
    setError(null);
    try {
      const batchId = localStorage.getItem("rota.batch");
      const r = await api("/api/imports/manual", {
        method: "POST",
        json: { reference, service_date: date, entries: [manual], batch_id: result?.id ?? undefined },
      });
      setResult(r.batch);
      localStorage.setItem("rota.batch", r.batch.id);
      setManual({ ...manual, number: "", complement: "", external_id: "", recipient: "" });
      void batchId;
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <AppShell title="Importar correspondências">
      <div className="mb-4 grid grid-cols-3 gap-2" role="tablist">
        {([["file", "Arquivo", FileSpreadsheet], ["text", "Colar texto", ClipboardPaste], ["manual", "Manual", PencilLine]] as const).map(([k, l, I]) => (
          <button key={k} role="tab" aria-selected={mode === k} onClick={() => { setMode(k); setPreview(null); }}
            className={cn("card flex flex-col items-center gap-1 py-3 font-semibold", mode === k && "!border-brand text-brand")}>
            <I className="h-6 w-6" /> {l}
          </button>
        ))}
      </div>

      <Card className="mb-4 grid gap-3 md:grid-cols-2">
        <div><Label htmlFor="ref">Referência do lote</Label><Input id="ref" value={reference} onChange={(e) => setReference(e.target.value)} /></div>
        <div><Label htmlFor="date">Data da jornada</Label><Input id="date" type="date" value={date} onChange={(e) => setDate(e.target.value)} /></div>
      </Card>

      {mode !== "manual" && (
        <Card className="mb-4 space-y-3">
          {mode === "file" ? (
            <div>
              <Label htmlFor="file">Arquivo CSV ou XLSX (até 10 MB)</Label>
              <input id="file" type="file" accept=".csv,.txt,.tsv,.xlsx" onChange={(e) => setFile(e.target.files?.[0] ?? null)} className="block w-full text-sm" />
            </div>
          ) : (
            <div>
              <Label htmlFor="text">Cole as linhas (planilha copiada ou um endereço por linha)</Label>
              <textarea id="text" rows={8} value={text} onChange={(e) => setText(e.target.value)} className="w-full rounded-xl border border-app bg-transparent p-3 font-mono text-sm" />
            </div>
          )}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label htmlFor="delim">Separador</Label>
              <Select id="delim" value={delimiter} onChange={(e) => setDelimiter(e.target.value)}>
                <option value="auto">Detectar</option><option value=";">Ponto e vírgula (;)</option>
                <option value=",">Vírgula (,)</option><option value={"\t"}>Tabulação</option><option value="|">Barra (|)</option>
              </Select>
            </div>
            <label className="flex items-end gap-2 pb-2"><input type="checkbox" checked={hasHeader} onChange={(e) => setHasHeader(e.target.checked)} className="h-5 w-5" /> Primeira linha é cabeçalho</label>
          </div>
          <Button onClick={() => doPreview()} disabled={busy || (mode === "file" ? !file : !text.trim())}>Pré-visualizar</Button>
        </Card>
      )}

      {mode === "manual" && (
        <Card className="mb-4 grid gap-3 md:grid-cols-3">
          {(["street", "number", "complement", "neighborhood", "cep", "external_id", "recipient"] as const).map((k) => (
            <div key={k}><Label htmlFor={k}>{FIELDS.find((f) => f[0] === k)?.[1]}</Label>
              <Input id={k} value={manual[k]} onChange={(e) => setManual({ ...manual, [k]: e.target.value })} /></div>
          ))}
          <div className="flex items-end"><Button onClick={addManual} disabled={busy || !manual.street}>Adicionar carta</Button></div>
          <p className="text-xs muted md:col-span-3">Cartas manuais entram no lote atual da tela; depois rode a geocodificação em “Validar endereços”.</p>
        </Card>
      )}

      {error && <div className="mb-4"><Alert kind="error">{error}</Alert></div>}

      {preview && !result && (
        <Card className="mb-4 space-y-4">
          <div className="font-semibold">Mapeamento de colunas</div>
          <div className="grid gap-3 md:grid-cols-3">
            {FIELDS.map(([k, l]) => (
              <div key={k}>
                <Label htmlFor={`m-${k}`}>{l}</Label>
                <Select id={`m-${k}`} value={mapping[k] ?? ""} onChange={(e) => setMapping({ ...mapping, [k]: e.target.value || null })}>
                  <option value="">— não usar —</option>
                  {preview.headers.map((h: string) => <option key={h} value={h}>{h}</option>)}
                </Select>
              </div>
            ))}
          </div>
          <Button variant="secondary" onClick={() => doPreview(mapping)} disabled={busy}>Atualizar prévia</Button>
          <div className="grid grid-cols-2 gap-2 text-sm md:grid-cols-4">
            <div>Linhas: <b>{preview.total_rows}</b></div>
            <div>Com erro: <b className="text-problem">{preview.error_rows}</b></div>
            <div>Com alerta: <b>{preview.warning_rows}</b></div>
            <div>Imóveis únicos: <b>{preview.unique_addresses}</b></div>
          </div>
          {preview.duplicate_ids_in_file.length > 0 && (
            <Alert kind="warn">Identificadores repetidos no arquivo (serão registrados como duplicados, não importados 2x): {preview.duplicate_ids_in_file.join(", ")}</Alert>
          )}
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead><tr className="muted"><th className="p-1">Linha</th><th>Logradouro</th><th>Nº</th><th>Compl.</th><th>Bairro</th><th>CEP</th><th>Validação</th></tr></thead>
              <tbody>
                {preview.rows.map((r: any) => (
                  <tr key={r.row_number} className="border-t border-app">
                    <td className="p-1">{r.row_number}</td><td>{r.values.street}</td><td>{r.values.number}</td>
                    <td>{r.values.complement}</td><td>{r.values.neighborhood}</td><td>{r.values.cep}</td>
                    <td className="text-xs">{r.errors.map((e: string) => <div key={e} className="text-problem">{e}</div>)}{r.warnings.map((w: string) => <div key={w} className="text-amber-600">{w}</div>)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="mt-1 text-xs muted">Prévia das primeiras {preview.rows.length} linhas. Nomes de destinatários não são exibidos na prévia.</p>
          </div>
          <Button size="lg" onClick={() => commit()} disabled={busy}>Confirmar importação e geocodificar</Button>
        </Card>
      )}

      {result && (
        <Card className="space-y-3">
          <div className="text-lg font-bold">Lote importado: {result.reference}</div>
          <div className="text-sm">Inseridas: <b>{result.import_report?.inserted}</b> · com erro: <b>{result.import_report?.with_errors?.length ?? 0}</b> · duplicadas: <b>{result.import_report?.duplicates?.length ?? 0}</b></div>
          {progress !== null && !result.geocode && (<div><div className="mb-1 text-sm">Geocodificando (1 consulta por imóvel)…</div><Progress value={progress} /></div>)}
          {result.geocode && (
            <Alert kind="ok">Geocodificação concluída: {result.geocode.addresses} imóveis · {result.geocode.consolidation?.stops} paradas · {result.geocode.consolidation?.unlocated} cartas sem localização.</Alert>
          )}
          <div className="flex gap-2">
            <Button onClick={() => router.push(`/lotes/${result.id}/enderecos`)}>Revisar endereços</Button>
            <Button variant="secondary" onClick={() => router.push(`/lotes/${result.id}/planejar`)}>Planejar rota</Button>
          </div>
        </Card>
      )}
    </AppShell>
  );
}
