import { MapPin, Save } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { Settings } from "../core/db";
import { queryFor, search } from "../core/geocode";
import { normalizeAddress, parseAddressLine } from "../core/normalize";
import { backupJson, getSettings, restoreJson, saveSettings, shareFile, undoRestore, verifyIntegrity } from "../core/service";
import { quotaUsed } from "../core/geocode";
import { collectDiagnostics } from "../core/diagnostics";
import { usageReport } from "../core/geoqueue";
import { Button } from "../ui/button";
import { Alert, Card, Input, Label, Select, Spinner } from "../ui/misc";
import RouteMap from "../ui/RouteMap";
import { NavPrefsCard } from "./NavPrefsCard";
import { PRECISION_LABEL } from "../ui/utils";

export function SettingsPage() {
  const [s, setS] = useState<Settings | null>(null);
  const [pin, setPin] = useState<{ lat: number; lon: number } | null>(null);
  const [cands, setCands] = useState<{ lat: number; lon: number; label: string }[]>([]);
  const [msg, setMsg] = useState<{ kind: "ok" | "error" | "warn" | "info"; text: string } | null>(null);
  const [pwd, setPwd] = useState("");
  const [mode, setMode] = useState<"merge" | "replace">("merge");
  const [usage, setUsage] = useState<Awaited<ReturnType<typeof usageReport>> | null>(null);

  useEffect(() => {
    getSettings().then((x) => { setS(x); if (x.start) setPin({ lat: x.start.lat, lon: x.start.lon }); usageReport(x.geocoder?.costPerQueryBRL).then(setUsage); });
  }, []);
  const candidates = useMemo(() => cands, [cands]);
  if (!s) return <Spinner />;

  async function geocodeStart() {
    try {
      const p = parseAddressLine(s!.startAddress);
      const na = normalizeAddress(p.street, p.number, p.neighborhood, p.city, p.cep);
      const res = await search(queryFor(na), s!.nominatimEmail);
      setCands(res.map((c) => ({ lat: c.lat, lon: c.lon, label: c.label })));
      if (res[0]) {
        setPin({ lat: res[0].lat, lon: res[0].lon });
        setMsg({ kind: res[0].precision === "exact" ? "info" : "warn", text: `Resultado: ${PRECISION_LABEL[res[0].precision]}. ${res[0].precision !== "exact" ? "O número não foi confirmado — arraste o pino até a entrada do imóvel." : "Confira e confirme."}` });
      } else {
        setPin({ lat: -23.948, lon: -46.3406 });
        setMsg({ kind: "error", text: "Endereço não localizado; posicione o pino manualmente." });
      }
    } catch (e) {
      setMsg({ kind: "error", text: `Sem conexão com o serviço de endereços: ${(e as Error).message}` });
    }
  }

  async function confirmStart() {
    const start = { label: s!.startAddress, lat: pin!.lat, lon: pin!.lon, confirmed: true };
    await saveSettings({ start });
    setS({ ...s!, start });
    setMsg({ kind: "ok", text: "Ponto de partida confirmado." });
  }

  async function save() {
    await saveSettings(s!);
    setMsg({ kind: "ok", text: "Configurações salvas." });
  }

  async function restore(f: File) {
    try {
      if (mode === "replace" && !confirm("Substituir TODOS os dados atuais pelo backup? (um instantâneo do estado atual é guardado e pode ser desfeito)")) return;
      const r = await restoreJson(await f.text(), { password: pwd || undefined, mode });
      const problems = await verifyIntegrity();
      setMsg({ kind: problems.length ? "warn" : "ok", text: `Backup restaurado: ${r.batches} lote(s), ${r.letters} carta(s), ${r.events} registro(s).${problems.length ? " Problemas: " + problems.join(" ") : " Integridade verificada."}` });
    } catch (e) {
      setMsg({ kind: "error", text: (e as Error).message });
    }
  }

  const num = (k: keyof Settings) => (e: React.ChangeEvent<HTMLInputElement>) => setS({ ...s!, [k]: +e.target.value });

  return (
    <div className="space-y-3">
      {msg && <Alert kind={msg.kind}>{msg.text}</Alert>}
      <NavPrefsCard />
      <Card className="space-y-3">
        <div className="font-semibold">Ponto de partida</div>
        <Input aria-label="Endereço de partida" value={s.startAddress} onChange={(e) => setS({ ...s, startAddress: e.target.value })} />
        <div className="text-sm">{s.start?.confirmed ? <b className="text-done">Confirmado ({s.start.lat.toFixed(6)}, {s.start.lon.toFixed(6)})</b> : <b className="text-problem">Não confirmado</b>}</div>
        <Button variant="secondary" onClick={geocodeStart}><MapPin className="h-4 w-4" /> Localizar endereço</Button>
        <RouteMap className="h-[40vh] w-full overflow-hidden rounded-2xl" candidates={candidates} pin={pin} onPinMove={(lat, lon) => setPin({ lat, lon })} />
        {pin && <Button onClick={confirmStart}>Confirmar o pino como ponto de partida</Button>}
      </Card>
      <Card className="grid grid-cols-2 gap-3">
        <div className="col-span-2 font-semibold">Operação</div>
        <div><Label htmlFor="svc">Atendimento por parada (s)</Label><Input id="svc" type="number" value={s.serviceTime} onChange={num("serviceTime")} /></div>
        <div><Label htmlFor="svc2">+ por carta extra (s)</Label><Input id="svc2" type="number" value={s.perLetterService} onChange={num("perLetterService")} /></div>
        <div><Label htmlFor="walk">Velocidade de caminhada (km/h)</Label><Input id="walk" type="number" step="0.5" value={s.profile.walk_speed_kmh} onChange={(e) => setS({ ...s, profile: { ...s.profile, walk_speed_kmh: +e.target.value } })} /></div>
        <div className="col-span-2"><Label htmlFor="approx">Endereços aproximados (só a rua / interpolados)</Label>
          <Select id="approx" value={s.approxPolicy ?? "include"} onChange={(e) => setS({ ...s, approxPolicy: e.target.value as "include" | "block" })}>
            <option value="include">Incluir na rota, sinalizados como aproximados</option>
            <option value="block">Só rotear depois de confirmar no mapa</option>
          </Select></div>
        <div className="col-span-2 font-semibold">Geocodificação em lote</div>
        <div className="col-span-2 text-xs muted">
          O Nominatim público (padrão) serve só para consultas pontuais: no máximo 30 endereços por execução e a cota diária abaixo.
          Para centenas de endereços, informe uma instância própria ou contratada compatível com a busca do Nominatim.
          Só o endereço é enviado, nunca o nome do destinatário. A chave fica só neste aparelho e não entra no backup.
        </div>
        <div className="col-span-2"><Label htmlFor="gurl">URL de busca do provedor (vazio = Nominatim público)</Label>
          <Input id="gurl" type="url" inputMode="url" placeholder="https://geocoder.minha-empresa.com.br/search" value={s.geocoder?.baseUrl ?? ""}
            onChange={(e) => setS({ ...s, geocoder: e.target.value ? { ...s.geocoder, baseUrl: e.target.value } : null })} /></div>
        {s.geocoder && <>
          <div><Label htmlFor="gkey">Chave de acesso (opcional)</Label>
            <Input id="gkey" type="password" autoComplete="off" value={s.geocoder.apiKey ?? ""} onChange={(e) => setS({ ...s, geocoder: { ...s.geocoder!, apiKey: e.target.value || undefined } })} /></div>
          <div><Label htmlFor="gcost">Preço por consulta (R$, opcional)</Label>
            <Input id="gcost" type="number" step="0.0001" value={s.geocoder.costPerQueryBRL ?? ""} onChange={(e) => setS({ ...s, geocoder: { ...s.geocoder!, costPerQueryBRL: e.target.value ? +e.target.value : undefined } })} /></div>
        </>}
        {usage && usage.length > 0 && <div className="col-span-2 text-xs" data-testid="geo-usage">
          Consumo: {usage.slice(0, 5).map((u) => `${u.date} ${u.provider}: ${u.queries} consulta(s)${u.errors ? `, ${u.errors} erro(s)` : ""}${u.costBRL != null ? `, R$ ${u.costBRL.toFixed(2)}` : ""}`).join(" · ")}
        </div>}
        <div className="col-span-2"><Label htmlFor="quota">Cota diária de consultas ao Nominatim público (usadas hoje: {quotaUsed()})</Label>
          <Input id="quota" type="number" value={s.geocodeDailyQuota ?? 250} onChange={num("geocodeDailyQuota")} /></div>
        <div className="col-span-2"><Label htmlFor="mail">E-mail de contato p/ o Nominatim (recomendado)</Label><Input id="mail" type="email" value={s.nominatimEmail} onChange={(e) => setS({ ...s, nominatimEmail: e.target.value })} /></div>
        <div><Label htmlFor="rm">Rota padrão</Label>
          <Select id="rm" value={s.routeMode} onChange={(e) => setS({ ...s, routeMode: e.target.value as any })}><option value="open">Aberta</option><option value="circular">Circular</option></Select></div>
        <div className="flex items-end"><Button onClick={save}><Save className="h-4 w-4" /> Salvar</Button></div>
      </Card>
      <Card className="space-y-2">
        <div className="font-semibold">Backup (os dados ficam só neste celular)</div>
        <p className="text-xs muted">O arquivo contém nomes e endereços. Use uma senha: ele é cifrado (AES-256) e só abre com ela.</p>
        <Input type="password" aria-label="Senha do backup" placeholder="Senha do backup (recomendado)" value={pwd} onChange={(e) => setPwd(e.target.value)} />
        <Button variant="secondary" onClick={async () => shareFile(`rota-santos-backup-${new Date().toISOString().slice(0, 10)}${pwd ? "-cifrado" : ""}.json`, await backupJson(pwd || undefined), "application/json")}>Exportar backup{pwd ? " cifrado" : " (sem senha)"}</Button>
        <div className="grid grid-cols-2 gap-2">
          <Select aria-label="Modo de restauração" value={mode} onChange={(e) => setMode(e.target.value as any)}>
            <option value="merge">Mesclar com os dados atuais</option><option value="replace">Substituir tudo</option>
          </Select>
          <Button variant="ghost" size="sm" onClick={async () => { try { await undoRestore(); setMsg({ kind: "ok", text: "Restauração desfeita." }); } catch (e) { setMsg({ kind: "error", text: (e as Error).message }); } }}>Desfazer última restauração</Button>
        </div>
        <label className="block text-sm">Restaurar backup: <input type="file" accept=".json,application/json" onChange={(e) => e.target.files?.[0] && restore(e.target.files[0])} /></label>
        <Button variant="secondary" onClick={async () => {
            const d = await collectDiagnostics();
            await shareFile(`diagnostico-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify(d, null, 1), "application/json");
            setMsg({ kind: "info", text: "Diagnóstico gerado (sem nomes nem endereços): tempos de cálculo, memória e versões." });
          }}>Exportar diagnóstico de desempenho</Button>
          <Button variant="ghost" size="sm" onClick={async () => { const p = await verifyIntegrity(); setMsg({ kind: p.length ? "warn" : "ok", text: p.length ? p.join(" ") : "Integridade OK: nenhuma carta perdida." }); }}>Verificar integridade dos dados</Button>
      </Card>
      <p className="px-1 text-xs muted">Malha de pedestres e mapa: © colaboradores do OpenStreetMap (ODbL) · mapa-base OpenFreeMap · endereços: Nominatim (1 consulta/s). Tempos e distâncias são estimativas.</p>
    </div>
  );
}
