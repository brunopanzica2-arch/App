import { ClipboardPaste, FileSpreadsheet, PencilLine } from "lucide-react";
import { useState } from "react";
import type { Nav } from "../App";
import { type Batch } from "../core/db";
import { commitImport, DuplicateImportError, FIELDS, type Prepared, prepareFile, prepareText, preview, type Table } from "../core/importer";
import { batchUndoSummary, geocodeBatch, saveSettings, undoBatch } from "../core/service";
import { Button } from "../ui/button";
import { Alert, Card, Input, Label, Progress, Select } from "../ui/misc";
import { cn } from "../ui/utils";

type Mode = "file" | "text" | "manual";

export function ImportPage({ nav }: { nav: Nav }) {
  const [mode, setMode] = useState<Mode>("file");
  const [file, setFile] = useState<File | null>(null);
  const [text, setText] = useState("");
  const [delimiter, setDelimiter] = useState("auto");
  const [hasHeader, setHasHeader] = useState(true);
  const [hasHeaderForced, setHasHeaderForced] = useState(false);
  const [table, setTable] = useState<Table | null>(null);
  const [prep, setPrep] = useState<Prepared | null>(null);
  const [mapping, setMapping] = useState<Record<string, string | null>>({});
  const [reference, setReference] = useState(`Lote ${new Date().toLocaleDateString("pt-BR")}`);
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<[number, number] | null>(null);
  const [result, setResult] = useState<(Batch & { geo?: { addresses: number; errors: string[] } }) | null>(null);
  const [manual, setManual] = useState({ street: "", number: "", complement: "", neighborhood: "", cep: "", external_id: "", recipient: "" });

  async function load() {
    setError(null);
    try {
      const forced = { delimiter: delimiter === "auto" ? undefined : delimiter, hasHeader: hasHeaderForced ? hasHeader : undefined };
      const p = mode === "file" ? await prepareFile(file!, forced) : prepareText(text, forced);
      setPrep(p);
      setTable(p.table);
      setMapping(p.mapping);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function geocode(b: Batch) {
    setProgress([0, 1]);
    const geo = await geocodeBatch(b.id, (d, t) => setProgress([d, t]));
    setResult({ ...b, geo });
    setProgress(null);
  }

  async function commit(allowSame = false) {
    setBusy(true);
    setError(null);
    try {
      const b = await commitImport(table!, mapping, reference, date, mode === "file" ? (/\.xlsx$/i.test(file!.name) ? "xlsx" : "csv") : "text", file?.name, undefined, allowSame, prep?.inferred);
      await saveSettings({ currentBatch: b.id });
      setResult(b);
      // Lotes grandes não disparam centenas de consultas ao serviço público automaticamente.
      const nAddr = preview(table!, mapping).uniqueAddresses;
      if (nAddr <= 20) await geocode(b);
    } catch (e) {
      if (e instanceof DuplicateImportError) {
        setBusy(false);
        if (confirm(`${e.message}\n\nImportar mesmo assim? Cartas com o mesmo identificador NÃO serão duplicadas (ficam no relatório como duplicadas).`)) return commit(true);
        return;
      }
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function addManual() {
    setBusy(true);
    setError(null);
    try {
      const headers = Object.keys(manual);
      const t: Table = { headers, rows: [headers.map((h) => (manual as any)[h])], original: JSON.stringify(manual), hasHeader: false };
      const map = Object.fromEntries(FIELDS.map(([f]) => [f, headers.includes(f) ? f : null]));
      const b = await commitImport(t, map, reference, date, "manual", undefined, result?.id);
      await saveSettings({ currentBatch: b.id });
      setResult(b);
      setManual({ ...manual, number: "", complement: "", external_id: "", recipient: "" });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const pv = table ? (() => { try { return preview(table, mapping); } catch (e) { return { error: (e as Error).message }; } })() : null;

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-3 gap-2" role="tablist">
        {([["file", "Arquivo", FileSpreadsheet], ["text", "Colar texto", ClipboardPaste], ["manual", "Manual", PencilLine]] as const).map(([k, l, I]) => (
          <button key={k} role="tab" aria-selected={mode === k} onClick={() => { setMode(k); setTable(null); }}
            className={cn("card flex flex-col items-center gap-1 py-3 font-semibold", mode === k && "!border-brand text-brand")}>
            <I className="h-6 w-6" /> {l}
          </button>
        ))}
      </div>
      <Card className="grid grid-cols-2 gap-3">
        <div><Label htmlFor="ref">Referência</Label><Input id="ref" value={reference} onChange={(e) => setReference(e.target.value)} /></div>
        <div><Label htmlFor="date">Data</Label><Input id="date" type="date" value={date} onChange={(e) => setDate(e.target.value)} /></div>
      </Card>

      {mode !== "manual" && !result && (
        <Card className="space-y-3">
          {mode === "file" ? (
            <div><Label htmlFor="file">Arquivo CSV ou XLSX</Label>
              <input id="file" type="file" accept=".csv,.txt,.tsv,.xlsx" onChange={(e) => setFile(e.target.files?.[0] ?? null)} className="block w-full text-sm" /></div>
          ) : (
            <div><Label htmlFor="text">Cole as linhas (planilha copiada ou um endereço por linha)</Label>
              <textarea id="text" rows={7} value={text} onChange={(e) => setText(e.target.value)} className="w-full rounded-xl border border-app bg-transparent p-3 font-mono text-sm" /></div>
          )}
          <div className="grid grid-cols-2 gap-3">
            <div><Label htmlFor="delim">Separador</Label>
              <Select id="delim" value={delimiter} onChange={(e) => setDelimiter(e.target.value)}>
                <option value="auto">Detectar</option><option value=";">;</option><option value=",">,</option><option value={"\t"}>Tab</option><option value="|">|</option>
              </Select></div>
            <label className="flex items-end gap-2 pb-2 text-sm"><input type="checkbox" checked={hasHeader} onChange={(e) => { setHasHeader(e.target.checked); setHasHeaderForced(true); }} className="h-5 w-5" /> 1ª linha é cabeçalho (auto)</label>
          </div>
          <Button onClick={load} disabled={mode === "file" ? !file : !text.trim()}>Pré-visualizar</Button>
        </Card>
      )}

      {mode === "manual" && (
        <Card className="grid grid-cols-2 gap-3">
          {(["street", "number", "complement", "neighborhood", "cep", "external_id", "recipient"] as const).map((k) => (
            <div key={k} className={k === "street" ? "col-span-2" : ""}><Label htmlFor={k}>{FIELDS.find((f) => f[0] === k)?.[1]}</Label>
              <Input id={k} value={manual[k]} onChange={(e) => setManual({ ...manual, [k]: e.target.value })} /></div>
          ))}
          <Button className="col-span-2" onClick={addManual} disabled={busy || !manual.street}>Adicionar carta</Button>
          {result && <Button className="col-span-2" variant="secondary" onClick={() => geocode(result)} disabled={!!progress}>Geocodificar cartas adicionadas</Button>}
        </Card>
      )}

      {error && <Alert kind="error">{error}</Alert>}

      {table && pv && !result && (
        <Card className="space-y-3">
          <div className="text-sm" data-testid="inferred">
            Colunas reconhecidas automaticamente{prep ? ` (confiança ${Math.round(prep.inferred.confidence * 100)}%)` : ""}: {FIELDS.filter(([k]) => mapping[k]).map(([, l]) => l).join(", ") || "nenhuma"}.
            {prep?.inferred.hasHeader === false && " Sem cabeçalho."}
          </div>
          {prep?.warnings.map((w) => <Alert key={w} kind="warn">{w}</Alert>)}
          <details><summary className="cursor-pointer font-semibold">Ajustar colunas (opcional)</summary>
          <div className="mt-2 grid grid-cols-2 gap-2">
            {FIELDS.map(([k, l]) => (
              <div key={k}><Label htmlFor={`m-${k}`}>{l}</Label>
                <Select id={`m-${k}`} value={mapping[k] ?? ""} onChange={(e) => setMapping({ ...mapping, [k]: e.target.value || null })}>
                  <option value="">— não usar —</option>
                  {table.headers.map((h) => <option key={h} value={h}>{h}</option>)}
                </Select></div>
            ))}
          </div>
          </details>
          {"error" in pv ? <Alert kind="error">{pv.error}</Alert> : (
            <>
              <div className="grid grid-cols-2 gap-1 text-sm">
                <div>Linhas lidas: <b>{pv.total}</b> <span className="sr-only">Linhas: {pv.total}</span></div><div>Válidas: <b>{pv.total - pv.errorRows}</b></div>
                <div>Precisam de correção: <b className="text-problem">{pv.errorRows}</b></div><div>Ambíguas (alerta): <b>{pv.warningRows}</b></div>
                <div>Imóveis únicos: <b>{pv.uniqueAddresses}</b></div><div>Cartas por imóvel: <b>até {Math.max(1, Math.round(pv.total / Math.max(pv.uniqueAddresses, 1)))}</b></div>
              </div>
              {pv.duplicateIds.length > 0 && <Alert kind="warn">Identificadores repetidos (registrados como duplicados): {pv.duplicateIds.join(", ")}</Alert>}
              <div className="max-h-72 overflow-auto text-xs" tabIndex={0} role="region" aria-label="Prévia das linhas">
                {pv.rows.slice(0, 10).map((r) => (
                  <div key={r.row} className="border-t border-app py-1">
                    <b>{r.row}</b> · {r.values.street}, {r.values.number ?? "S/N"} {r.values.complement ?? ""} · {r.values.neighborhood ?? ""}
                    {r.errors.map((e) => <div key={e} className="text-problem">{e}</div>)}
                    {r.warnings.map((w) => <div key={w} className="text-amber-700">{w}</div>)}
                  </div>
                ))}
              </div>
              <div className="text-xs muted">Prévia das 10 primeiras de {pv.total} linhas.</div>
              <Button size="lg" onClick={() => commit()} disabled={busy}>{pv.errorRows ? `Importar ${pv.total - pv.errorRows} válidas (${pv.errorRows} ficam de fora)` : "Confirmar e localizar endereços"}</Button>
            </>
          )}
        </Card>
      )}

      {result && (
        <Card className="space-y-3">
          <div className="text-lg font-bold">Lote: {result.reference}</div>
          <div className="text-sm">Inseridas: <b>{result.report.inserted}</b> · com erro: <b>{result.report.withErrors.length}</b> · duplicadas: <b>{result.report.duplicates.length}</b></div>
          {progress && (<div><div className="mb-1 text-sm">Localizando endereços ({progress[0]}/{progress[1]}) — 1 por segundo…</div><Progress value={progress[0] / Math.max(progress[1], 1)} /></div>)}
          {!result.geo && !progress && (
            <Alert kind="info">Endereços ainda NÃO localizados. Para lotes grandes, localize em “Revisar endereços” (1 consulta/s ao serviço público, com cota diária) ou importe coordenadas.
              <Button className="mt-2" size="sm" variant="secondary" onClick={() => geocode(result)}>Localizar agora</Button></Alert>
          )}
          {result.geo && <Alert kind={result.geo.errors.length ? "warn" : "ok"}>{result.geo.addresses} imóveis consultados{result.geo.errors.length ? ` · ${result.geo.errors.length} falha(s) de rede (tente de novo em Validar endereços)` : ""}.</Alert>}
          <div className="grid gap-2">
            <Button onClick={() => nav(`/enderecos/${result.id}`)}>Revisar endereços</Button>
            <Button variant="secondary" onClick={() => nav("/")}>Ver no mapa</Button>
            <Button variant="ghost" onClick={async () => {
              const sum = await batchUndoSummary(result.id);
              if (!confirm(`Desfazer esta importação? Serão removidas ${sum.letters} carta(s) deste lote. Outros lotes não são afetados.`)) return;
              await undoBatch(result.id); setResult(null); setTable(null); setPrep(null);
            }}>Desfazer esta importação</Button>
          </div>
        </Card>
      )}
    </div>
  );
}
