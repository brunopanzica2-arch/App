import { useEffect, useState } from "react";
import { DEFAULT_NAV, type NavPrefs } from "../core/db";
import { getNavPrefs, saveSettings } from "../core/service";
import { nav } from "../native/rotaNav";
import { loadOfflineStyle, packStatus } from "../ui/offlineMap";
import { Button } from "../ui/button";
import { Alert, Card } from "../ui/misc";

/** Voz, GPS e tela de bloqueio. Nada aqui pede localização em segundo plano. */
export function NavPrefsCard() {
  const [p, setP] = useState<NavPrefs>(DEFAULT_NAV);
  const [info, setInfo] = useState<string>("");
  const [pack, setPack] = useState<string>("verificando…");
  useEffect(() => { void loadOfflineStyle().then(() => setPack(packStatus.ok && packStatus.info ? `Santos · ${packStatus.info.compilacao} · ${packStatus.info.tiles} tiles · zoom até ${packStatus.info.zoom_max} · SHA-256 ${packStatus.info.sha256.slice(0, 12)}… ${packStatus.reason}` : `INDISPONÍVEL — ${packStatus.reason}. O mapa tenta a fonte online; sem internet só rota e paradas aparecem.`)); }, []);
  useEffect(() => { void getNavPrefs().then(setP); void nav.status().then((s) => setInfo(`${s.backend || "—"} · GPS ${s.gpsEnabled ? "ligado" : "desligado"}${s.sdk ? ` · Android API ${s.sdk}` : ""}`)); }, []);
  const set = async (patch: Partial<NavPrefs>) => { const n = { ...p, ...patch }; setP(n); await saveSettings({ nav: n }); await nav.configure(n); };
  const Chk = ({ k, label, hint }: { k: keyof NavPrefs; label: string; hint?: string }) => (
    <label className="flex items-start gap-3 py-1"><input type="checkbox" className="mt-1 h-5 w-5" checked={!!p[k]} onChange={(e) => set({ [k]: e.target.checked } as any)} />
      <span><span className="block">{label}</span>{hint && <span className="block text-xs muted">{hint}</span>}</span></label>
  );
  return (
    <Card className="space-y-2" data-testid="nav-prefs">
      <div className="font-semibold">Navegação, voz e localização</div>
      <Chk k="speech" label="Instruções por voz (pt-BR)" />
      <Chk k="detailed" label="Instruções detalhadas" hint="Desligado: só avisa a curva próxima e a chegada." />
      <Chk k="preciseGps" label="GPS de alta precisão (1 s)" hint="Desligado = economia de bateria (3 s / 3 m)." />
      <Chk k="camera3d" label="Câmera 3D ao navegar" />
      <Chk k="lockscreenManeuver" label="Mostrar a instrução na tela de bloqueio" hint="Padrão: só “Navegação ativa”. Ligado, a notificação mostra rua e número na tela bloqueada." />
      <Chk k="showWhenLocked" label="Abrir o mapa sobre a tela de bloqueio" hint="Só quando você toca em “Abrir mapa” na notificação." />
      <div className="grid grid-cols-2 gap-2 text-sm">
        <label>Velocidade da voz<input type="range" min={0.7} max={1.5} step={0.1} value={p.rate} onChange={(e) => set({ rate: +e.target.value })} className="w-full" aria-label="Velocidade da voz" /></label>
        <label>Volume<input type="range" min={0.3} max={1} step={0.1} value={p.volume} onChange={(e) => set({ volume: +e.target.value })} className="w-full" aria-label="Volume da voz" /></label>
      </div>
      <Button variant="secondary" onClick={() => nav.speak("Em cinquenta metros, vire à direita na Rua Itororó.")}>Testar voz</Button>
      <Alert kind={packStatus.ok === false ? "warn" : "info"}><b>Mapa offline:</b> {pack}</Alert>
      <Alert kind="info">Localização: {info || "…"}. O app usa a localização só enquanto navega (serviço em primeiro plano com notificação). Não pede “localização o tempo todo”.</Alert>
    </Card>
  );
}
