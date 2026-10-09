import { MapPin, Save } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { Settings } from "../core/db";
import { queryFor, search } from "../core/geocode";
import { normalizeAddress, parseAddressLine } from "../core/normalize";
import { backupJson, getSettings, restoreJson, saveSettings, shareFile } from "../core/service";
import { Button } from "../ui/button";
import { Alert, Card, Input, Label, Select, Spinner } from "../ui/misc";
import RouteMap from "../ui/RouteMap";
import { PRECISION_LABEL } from "../ui/utils";

export function SettingsPage() {
  const [s, setS] = useState<Settings | null>(null);
  const [pin, setPin] = useState<{ lat: number; lon: number } | null>(null);
  const [cands, setCands] = useState<{ lat: number; lon: number; label: string }[]>([]);
  const [msg, setMsg] = useState<{ kind: "ok" | "error" | "warn" | "info"; text: string } | null>(null);

  useEffect(() => {
    getSettings().then((x) => { setS(x); if (x.start) setPin({ lat: x.start.lat, lon: x.start.lon }); });
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
      await restoreJson(await f.text());
      setMsg({ kind: "ok", text: "Backup restaurado." });
    } catch (e) {
      setMsg({ kind: "error", text: (e as Error).message });
    }
  }

  const num = (k: keyof Settings) => (e: React.ChangeEvent<HTMLInputElement>) => setS({ ...s!, [k]: +e.target.value });

  return (
    <div className="space-y-3">
      {msg && <Alert kind={msg.kind}>{msg.text}</Alert>}
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
        <div><Label htmlFor="ride">Pedalando (km/h)</Label><Input id="ride" type="number" step="0.5" value={s.profile.ride_speed_kmh} onChange={(e) => setS({ ...s, profile: { ...s.profile, ride_speed_kmh: +e.target.value } })} /></div>
        <div><Label htmlFor="walk">A pé c/ bicicleta (km/h)</Label><Input id="walk" type="number" step="0.5" value={s.profile.walk_speed_kmh} onChange={(e) => setS({ ...s, profile: { ...s.profile, walk_speed_kmh: +e.target.value } })} /></div>
        <div className="col-span-2"><Label htmlFor="mail">E-mail de contato p/ o Nominatim (recomendado)</Label><Input id="mail" type="email" value={s.nominatimEmail} onChange={(e) => setS({ ...s, nominatimEmail: e.target.value })} /></div>
        <div><Label htmlFor="rm">Rota padrão</Label>
          <Select id="rm" value={s.routeMode} onChange={(e) => setS({ ...s, routeMode: e.target.value as any })}><option value="open">Aberta</option><option value="circular">Circular</option></Select></div>
        <div className="flex items-end"><Button onClick={save}><Save className="h-4 w-4" /> Salvar</Button></div>
      </Card>
      <Card className="space-y-2">
        <div className="font-semibold">Backup (os dados ficam só neste celular)</div>
        <Button variant="secondary" onClick={async () => shareFile(`rota-santos-backup-${new Date().toISOString().slice(0, 10)}.json`, await backupJson(), "application/json")}>Exportar backup</Button>
        <label className="block text-sm">Restaurar backup: <input type="file" accept=".json,application/json" onChange={(e) => e.target.files?.[0] && restore(e.target.files[0])} /></label>
      </Card>
      <p className="px-1 text-xs muted">Malha de pedestres e mapa: © colaboradores do OpenStreetMap (ODbL) · mapa-base OpenFreeMap · endereços: Nominatim (1 consulta/s). Tempos e distâncias são estimativas.</p>
    </div>
  );
}
