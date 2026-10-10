import {
  ArrowUp, CornerUpLeft, CornerUpRight, Crosshair, Download, Info, ListChecks, Mic, Navigation, Pause, Play, Repeat, Search, SkipForward, Square, Undo2, Upload, Volume2, VolumeX, X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { Nav } from "../App";
import { routePoint } from "../core/address";
import { db, type Letter, type Route } from "../core/db";
import { hudText, precisionNote } from "../core/hud";
import { getNavPrefs, quickPlan, recordEvent, resumableSession, saveSettings, type StopView, stopsOf, TERMINAL, undoLastEvent } from "../core/service";
import { nav as navApi, parseVoiceCommand } from "../native/rotaNav";
import { Button } from "../ui/button";
import { useCurrentBatch } from "../ui/hooks";
import { Alert, Badge, Spinner } from "../ui/misc";
import RouteMap from "../ui/RouteMap";
import { useNavigation } from "../ui/useNavigation";
import { cn, fmtDist, fmtTime, REASON_LABEL } from "../ui/utils";

type Follow = "off" | "2d" | "3d";
const ICON: Record<string, any> = { left: CornerUpLeft, sharp_left: CornerUpLeft, slight_left: CornerUpLeft, right: CornerUpRight, sharp_right: CornerUpRight, slight_right: CornerUpRight };

export function MapHome({ nav, focusKey }: { nav: Nav; focusKey?: string }) {
  const [batchId] = useCurrentBatch();
  const [data, setData] = useState<Awaited<ReturnType<typeof stopsOf>> | null>(null);
  const [route, setRoute] = useState<Route | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [sel, setSel] = useState<string | null>(focusKey ?? null);
  const [follow, setFollow] = useState<Follow>("off");
  const [detail, setDetail] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [toast, setToast] = useState<{ text: string; undo?: boolean } | null>(null);
  const [reasonOpen, setReasonOpen] = useState(false);
  const [resume, setResume] = useState<{ stops: number; letters: number } | null>(null);
  const [speech, setSpeech] = useState(true);
  const [searchOpen, setSearchOpen] = useState(false);
  const [q, setQ] = useState("");
  const [confirmDeliver, setConfirmDeliver] = useState<string | null>(null);
  const [baseMap, setBaseMap] = useState<string | null>(null);

  const reload = useCallback(async () => {
    if (!batchId) { setLoaded(true); return; }
    const d = await stopsOf(batchId);
    const rs = (await db.routes.where("batchId").equals(batchId).toArray()).sort((a, b) => b.version - a.version);
    setData(d);
    setRoute(rs.find((r) => r.status === "active") ?? null);
    setLoaded(true);
  }, [batchId]);
  useEffect(() => { void reload(); }, [reload]);
  useEffect(() => { void resumableSession().then((r) => setResume(r ? { stops: r.stops, letters: r.letters } : null)); getNavPrefs().then((p) => setSpeech(p.speech)); }, [batchId]);
  useEffect(() => { if (focusKey) setSel(focusKey); }, [focusKey]);

  const N = useNavigation(() => void reload());
  const { ui } = N;
  const navigating = ui.active;

  const byKey = useMemo(() => new Map(data?.stops.map((s) => [s.key, s]) ?? []), [data]);
  const items = useMemo(() => (route?.stops ?? []).map((rs) => ({ rs, stop: byKey.get(rs.key)! })).filter((x) => x.stop), [route, byKey]);
  const open = (st: { status: string }) => ["pending", "partial"].includes(st.status);
  const nextIdx = items.findIndex((x) => open(x.stop));
  const next = nextIdx >= 0 ? items[nextIdx] : null;
  const current = (sel ? items.find((x) => x.rs.key === sel) : null) ?? next;
  const pendingLetters = (data?.letters ?? []).filter((l) => !TERMINAL.includes(l.status) && l.status !== "postponed" && !l.excluded).length;
  const doneLetters = (data?.letters ?? []).filter((l) => TERMINAL.includes(l.status)).length;
  const stopsDone = items.filter((x) => !open(x.stop)).length;

  const mapStops = useMemo(() => items.map((x) => ({
    id: x.rs.key, lat: routePoint(x.stop.address)!.lat, lon: routePoint(x.stop.address)!.lon, seq: x.rs.seq, status: x.stop.status,
    uncertain: x.stop.uncertain, isNext: x.rs.key === next?.rs.key,
  })), [items, next]);

  // seguir a posição ao iniciar; gesto do usuário desliga
  useEffect(() => { if (navigating) getNavPrefs().then((p) => setFollow(p.camera3d ? "3d" : "2d")); else setFollow("off"); }, [navigating]);

  const [kw, setKw] = useState(0);
  useEffect(() => { const h = () => setKw(Math.round(window.innerHeight - (window.visualViewport?.height ?? window.innerHeight))); window.visualViewport?.addEventListener("resize", h); return () => window.visualViewport?.removeEventListener("resize", h); }, []);

  async function doPlan() {
    if (!batchId) return;
    setBusy("Calculando rota…");
    try {
      let here: { lat: number; lon: number } | null = null;
      try { const p = await navApi.requestPermissions(); if (p.location === "granted" || !navApi.isNative()) { await N.locate(); here = N.getFix(); } } catch { /* usa o ponto de partida salvo */ }
      await quickPlan(batchId, here, (st, p) => setBusy(`${st} ${Math.round(p * 100)}%`));
      await reload();
    } catch (e) { setToast({ text: (e as Error).message }); }
    setBusy(null);
  }

  async function mark(ls: Letter[], status: Letter["status"], reason: string | null = null) {
    if (!route || !ls.length) return;
    for (const l of ls) await recordEvent(l.id, status, route.id, reason);
    setToast({ text: `${ls.length} carta(s): ${status === "delivered" ? "entregue" : status === "postponed" ? "adiada" : "não entregue"}.`, undo: true });
    await reload();
    if (navigating) await N.advance();
    setSel(null);
    setDetail(false);
  }

  async function undo() {
    if (!batchId) return;
    const ev = await undoLastEvent(batchId);
    setToast({ text: ev ? "Última ação desfeita." : "Nada para desfazer." });
    await reload();
  }

  async function voice() {
    try {
      const perm = await navApi.requestMicrophone();
      if (perm.microphone !== "granted") { setToast({ text: "Permissão do microfone não concedida." }); return; }
      const text = await navApi.listenOnce();
      const c = parseVoiceCommand(text);
      switch (c) {
        case "repeat": return void N.repeat();
        case "next": if (next) setSel(next.rs.key); return void N.advance();
        case "remaining": return void navApi.speak(`Faltam ${items.filter((x) => open(x.stop)).length} paradas e ${pendingLetters} cartas.`);
        case "skip": if (current) return void mark(current.stop.letters.filter((l) => !TERMINAL.includes(l.status)), "postponed");
          break;
        case "pause": return void N.pause();
        case "resume": return void N.resume();
        case "deliver": if (current) { setConfirmDeliver(current.rs.key); void navApi.speak("Confirme a entrega na tela."); } return;
        default: setToast({ text: `Não entendi “${text}”.` });
      }
    } catch (e) { setToast({ text: (e as Error).message }); }
  }

  const hits = useMemo(() => {
    const t = q.trim().toLowerCase();
    if (!t || !data) return [];
    const m = new Map<string, { key: string; line: string; sub: string }>();
    for (const l of data.letters) {
      const hay = [l.street, l.number, l.neighborhood, l.externalId, l.recipient, l.complement].map((v) => (v ?? "").toLowerCase());
      if (!hay.some((v) => v.includes(t)) || !l.addressKey) continue;
      const a = data.addresses.find((x) => x.key === l.addressKey);
      if (a && !m.has(a.key)) m.set(a.key, { key: a.key, line: a.display.split(" - ")[0], sub: `${a.neighborhood ?? ""} · ${l.externalId ?? "carta " + l.row}` });
    }
    return [...m.values()].slice(0, 30);
  }, [q, data]);

  if (!loaded) return <Spinner />;

  const cur = current?.stop;
  const curLetters = cur?.letters.filter((l) => !TERMINAL.includes(l.status) && l.status !== "postponed") ?? [];
  const note = cur ? precisionNote(cur.trust.code) : null;
  const st = ui.state;
  const hud = st && st.nextDist >= 0 ? hudText(st.nextKind, st.nextStreet, st.nextDist) : null;
  const HudIcon = hud ? ICON[st!.nextKind] ?? ArrowUp : ArrowUp;
  const unlocated = data?.unlocated.length ?? 0;
  const curAddr = cur ? cur.address.display.split(" - ")[0] : "";
  const selectedPoint = cur ? routePoint(cur.address) : null;

  return (
    <div className="fixed inset-x-0 top-0 z-0" style={{ bottom: "calc(3.5rem + env(safe-area-inset-bottom))", paddingTop: "env(safe-area-inset-top)" }} data-testid="map-home">
      <RouteMap className="absolute inset-0 h-full w-full" stops={mapStops} route={route?.geojson} start={route?.start} fix={ui.fix} follow={follow}
        ahead={ui.ahead} onUserMove={() => setFollow("off")} bottomPad={navigating ? 260 : 160} onBaseMap={setBaseMap}
        onStopClick={(k) => { setSel(k); setFollow("off"); }} focus={sel && selectedPoint && follow === "off" ? selectedPoint : null} />

      {/* topo: HUD de manobra ou busca */}
      <div className="pointer-events-none absolute inset-x-0 top-0 p-2" style={{ paddingTop: "calc(env(safe-area-inset-top) + 0.5rem)" }}>
        {navigating && hud ? (
          <div className="pointer-events-auto flex items-center gap-3 rounded-2xl bg-[#2e1065] p-3 text-white shadow-xl" role="status" aria-live="polite" data-testid="hud">
            <HudIcon className="h-12 w-12 shrink-0" aria-hidden />
            <div className="min-w-0">
              <div className="text-2xl font-extrabold leading-tight">{hud.head}</div>
              <div className="text-base leading-snug">{hud.body}</div>
            </div>
          </div>
        ) : !navigating && (
          <div className="pointer-events-auto flex gap-2">
            <button onClick={() => setSearchOpen(true)} className="card flex flex-1 items-center gap-2 px-3 py-3 text-left shadow-lg" aria-label="Buscar entrega">
              <Search className="h-5 w-5" /> <span className="muted">Buscar rua, número, código…</span>
            </button>
            <Button variant="secondary" size="lg" onClick={() => nav("/importar")} aria-label="Importar cartas"><Upload className="h-5 w-5" /> Importar</Button>
          </div>
        )}
        {navigating && ui.rerouting && <div className="pointer-events-auto mt-2 rounded-xl bg-amber-100 p-2 text-sm font-semibold text-amber-900" role="status">Recalculando a rota…</div>}
        {navigating && ui.offRoute && !ui.rerouting && <div className="pointer-events-auto mt-2 rounded-xl bg-amber-100 p-2 text-sm font-semibold text-amber-900" role="status">Você saiu da rota.</div>}
        {navigating && st?.lowAccuracy && <div className="pointer-events-auto mt-2 rounded-xl bg-amber-100 p-2 text-sm font-semibold text-amber-900" role="status">Sinal de GPS fraco — as instruções podem atrasar.</div>}
        {ui.error && <div className="pointer-events-auto mt-2"><Alert kind="error">{ui.error}</Alert></div>}
        {baseMap === "offline" && !navigating && <div className="mt-2 text-xs"><Badge color="#b45309">Mapa-base indisponível</Badge></div>}
      </div>

      {/* controles flutuantes */}
      <div className="absolute right-2 flex flex-col gap-2" style={{ bottom: navigating ? "17.5rem" : "11rem" }}>
        <Fab label={follow === "off" ? "Centralizar em mim" : follow === "3d" ? "Câmera 3D (tocar para 2D)" : "Câmera 2D (tocar para 3D)"}
          onClick={() => { if (!ui.fix && !navigating) void N.locate(); setFollow(follow === "off" ? "3d" : follow === "3d" ? "2d" : "3d"); }} active={follow !== "off"}>
          <Crosshair className="h-6 w-6" />{follow !== "off" && <span className="text-[10px] font-bold">{follow.toUpperCase()}</span>}
        </Fab>
        {navigating && (<>
          <Fab label="Repetir instrução" onClick={() => void N.repeat()}><Repeat className="h-6 w-6" /></Fab>
          <Fab label={speech ? "Silenciar voz" : "Ativar voz"} onClick={async () => { const p = await getNavPrefs(); const v = !speech; setSpeech(v); await saveSettings({ nav: { ...p, speech: v } }); await navApi.configure({ speech: v }); }}>
            {speech ? <Volume2 className="h-6 w-6" /> : <VolumeX className="h-6 w-6" />}
          </Fab>
          <Fab label="Comando de voz" onClick={voice}><Mic className="h-6 w-6" /></Fab>
        </>)}
      </div>

      {toast && (
        <div role="status" className="absolute inset-x-2 flex items-center gap-2 rounded-xl bg-neutral-900 p-3 text-sm text-white shadow-xl" style={{ bottom: navigating ? "17rem" : "10rem" }}>
          <span className="flex-1">{toast.text}</span>
          {toast.undo && <button className="font-bold underline" onClick={() => { setToast(null); void undo(); }}>Desfazer</button>}
          <button aria-label="Fechar aviso" onClick={() => setToast(null)}><X className="h-5 w-5" /></button>
        </div>
      )}

      {/* painel inferior */}
      <section className="absolute inset-x-0 bottom-0 max-h-[75%] overflow-y-auto rounded-t-3xl border-t border-app bg-[var(--card)] p-3 shadow-[0_-8px_24px_rgba(0,0,0,.18)]" aria-label="Entrega atual" data-testid="sheet">
        <div className="mx-auto mb-2 h-1.5 w-10 rounded-full bg-neutral-300" aria-hidden />
        {busy && <div className="mb-2"><Spinner label={busy} /></div>}

        {!data || (data.letters.length === 0) ? (
          <div className="space-y-3 text-center">
            <div className="text-lg font-bold">Nenhuma entrega ainda</div>
            <p className="text-sm muted">Importe a planilha ou cole as linhas do dia. O app reconhece as colunas sozinho.</p>
            <Button size="lg" className="w-full" onClick={() => nav("/importar")}><Upload className="h-5 w-5" /> Importar cartas</Button>
          </div>
        ) : !route ? (
          <div className="space-y-3">
            <Counters letters={data.letters.length} stops={data.stops.length} unlocated={unlocated} done={doneLetters} pending={pendingLetters} />
            {unlocated > 0 && <Alert kind="warn">{unlocated} carta(s) sem localização ficam fora da rota até você localizar ou corrigir o endereço.</Alert>}
            <Button size="lg" className="w-full" onClick={doPlan} disabled={!!busy || data.stops.length === 0}>Calcular rota</Button>
            <div className="grid grid-cols-2 gap-2">
              <Button variant="secondary" onClick={() => nav(`/enderecos/${batchId}`)}>Localizar / corrigir endereços</Button>
              <Button variant="secondary" onClick={() => nav("/importar")}><Upload className="h-4 w-4" /> Importar mais</Button>
            </div>
          </div>
        ) : (
          <div className="space-y-3">
            {resume && !navigating && (
              <button className="w-full rounded-xl border-2 border-brand p-3 text-left" onClick={() => route && N.start(route)} data-testid="resume">
                <span className="block text-xs font-semibold uppercase text-brand">Sessão interrompida</span>
                <span className="text-lg font-bold">Retomar {resume.letters} entrega(s) em {resume.stops} parada(s)</span>
              </button>
            )}
            <Counters letters={data.letters.length} stops={data.stops.length} unlocated={unlocated} done={doneLetters} pending={pendingLetters} />
            {cur ? (
              <>
                <div>
                  <div className="text-xs font-semibold uppercase text-next">{current && current.rs.key === next?.rs.key ? "Próxima parada" : "Parada selecionada"} · {current!.rs.seq} de {items.length}</div>
                  <div className="text-2xl font-extrabold leading-tight" data-testid="cur-addr">{curAddr}</div>
                  <div className="flex flex-wrap items-center gap-1 text-sm muted">
                    {cur.address.neighborhood ?? ""} · {curLetters.length} carta(s)
                    {navigating && st && st.stopKey === current!.rs.key && st.stopDist >= 0 && <b> · a {fmtDist(st.stopDist)}</b>}
                  </div>
                  <div className="mt-1 flex flex-wrap gap-1"><Badge color={cur.trust.approximate ? "#b45309" : "#16a34a"}>{cur.trust.label}</Badge></div>
                  {note && <p className="mt-1 text-sm text-amber-700" role="note">{note}</p>}
                </div>
                {navigating && ui.nearStopKey === current!.rs.key && ui.nearStopText && (
                  <Alert kind="ok">{ui.nearStopText}</Alert>
                )}
                <div className="grid grid-cols-2 gap-2">
                  <Button variant="success" size="lg" className="h-16 whitespace-normal text-lg leading-tight" disabled={!curLetters.length}
                    onClick={() => curLetters.length > 1 ? setConfirmDeliver(current!.rs.key) : mark(curLetters, "delivered")}>
                    {curLetters.length > 1 ? `Entregar todas (${curLetters.length})` : "Entregue"}
                  </Button>
                  <Button variant="danger" size="lg" className="h-16 whitespace-normal text-lg leading-tight" disabled={!curLetters.length} onClick={() => setReasonOpen(true)}>Não consegui</Button>
                  <Button variant="secondary" size="lg" className="h-14 whitespace-normal" disabled={!curLetters.length} onClick={() => mark(curLetters, "postponed")}><SkipForward className="h-5 w-5" /> Pular</Button>
                  <Button variant="secondary" size="lg" className="h-14 whitespace-normal" onClick={() => setDetail(!detail)}><Info className="h-5 w-5" /> Detalhes</Button>
                </div>
                {detail && <Details stop={cur} onMark={(l, s) => mark([l], s)} nav={nav} batchId={batchId!} reload={reload} />}
              </>
            ) : (
              <Alert kind="ok">Todas as paradas desta rota foram tratadas. {pendingLetters > 0 ? `${pendingLetters} carta(s) pendente(s) fora da rota.` : "Bom trabalho!"}</Alert>
            )}
            <div className="grid grid-cols-2 gap-2">
              {!navigating ? (
                <Button size="lg" className="col-span-2" onClick={() => route && N.start(route)} disabled={!next}><Navigation className="h-5 w-5" /> Iniciar navegação</Button>
              ) : (<>
                {ui.paused ? <Button variant="secondary" onClick={N.resume}><Play className="h-5 w-5" /> Retomar</Button> : <Button variant="secondary" onClick={N.pause}><Pause className="h-5 w-5" /> Pausar</Button>}
                <Button variant="secondary" onClick={() => void N.stop()}><Square className="h-5 w-5" /> Encerrar</Button>
              </>)}
              <Button variant="ghost" onClick={undo}><Undo2 className="h-5 w-5" /> Desfazer</Button>
              <Button variant="ghost" onClick={() => nav("/entregas")}><ListChecks className="h-5 w-5" /> Todas as entregas</Button>
            </div>
            {navigating && st && <div className="text-center text-xs muted">{fmtDist(st.total - st.progress)} restantes · {st.stopsLeft} parada(s) · GPS ±{Math.round(st.accuracy)} m</div>}
            {route && !navigating && <div className="text-center text-xs muted">{stopsDone}/{items.length} paradas · {fmtDist(route.totalDistance)} · {fmtTime(route.totalTime)} (estimativa)</div>}
          </div>
        )}
      </section>

      {reasonOpen && (
        <Modal title="Por que não conseguiu entregar?" onClose={() => setReasonOpen(false)}>
          <div className="grid gap-2">
            {Object.entries(REASON_LABEL).map(([k, v]) => (
              <Button key={k} variant="secondary" size="lg" className="whitespace-normal" onClick={() => { setReasonOpen(false); void mark(curLetters, "not_delivered", k); }}>{v}</Button>
            ))}
          </div>
        </Modal>
      )}
      {confirmDeliver && (
        <Modal title="Confirmar entrega" onClose={() => setConfirmDeliver(null)}>
          <p className="mb-3">Marcar como <b>entregue</b> as {curLetters.length} carta(s) de {curAddr}?</p>
          <div className="grid gap-2">
            <Button variant="success" size="lg" onClick={() => { setConfirmDeliver(null); void mark(curLetters, "delivered"); }}>Entregar todas</Button>
            <Button variant="secondary" size="lg" onClick={() => { setConfirmDeliver(null); setDetail(true); }}>Escolher uma a uma</Button>
          </div>
        </Modal>
      )}
      {searchOpen && (
        <Modal title="Buscar entrega" onClose={() => setSearchOpen(false)}>
          <input autoFocus aria-label="Buscar" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Rua, número, código, destinatário…"
            className="mb-2 w-full rounded-xl border border-app bg-transparent p-3" />
          <ul className="max-h-[50vh] overflow-y-auto">
            {hits.map((h) => (
              <li key={h.key}><button className="w-full border-b border-app py-3 text-left" onClick={() => { setSel(h.key); setSearchOpen(false); setQ(""); }}>
                <b className="block">{h.line}</b><span className="text-sm muted">{h.sub}</span></button></li>
            ))}
            {q.trim() && !hits.length && <li className="py-3 muted">Nada encontrado.</li>}
          </ul>
        </Modal>
      )}
    </div>
  );
}

function Fab({ children, label, onClick, active }: { children: React.ReactNode; label: string; onClick: () => void; active?: boolean }) {
  return (
    <button onClick={onClick} aria-label={label} title={label}
      className={cn("grid h-14 w-14 place-items-center rounded-full border border-app bg-[var(--card)] shadow-lg", active && "!border-brand text-brand")}>
      <span className="flex flex-col items-center leading-none">{children}</span>
    </button>
  );
}

function Counters(p: { letters: number; stops: number; unlocated: number; done: number; pending: number }) {
  const cells: [string, number][] = [["cartas", p.letters], ["paradas", p.stops], ["não loc.", p.unlocated], ["concluídas", p.done], ["pendentes", p.pending]];
  return (
    <div className="grid grid-cols-5 gap-1 text-center" aria-label="Contadores" data-testid="counters">
      {cells.map(([l, v]) => <div key={l} className="rounded-xl bg-black/5 py-1 dark:bg-white/10"><b className="block text-lg leading-tight">{v}</b><span className="text-[11px] muted">{l}</span></div>)}
    </div>
  );
}

export function Modal({ title, children, onClose }: { title: string; children: React.ReactNode; onClose: () => void }) {
  return (
    <div className="absolute inset-0 z-40 flex items-end bg-black/40" role="dialog" aria-modal="true" aria-label={title}>
      <div className="max-h-[85%] w-full overflow-y-auto rounded-t-3xl bg-[var(--card)] p-4" style={{ paddingBottom: "calc(env(safe-area-inset-bottom) + 1rem)" }}>
        <div className="mb-3 flex items-center gap-2"><h2 className="flex-1 text-lg font-bold">{title}</h2><button onClick={onClose} aria-label="Fechar"><X className="h-6 w-6" /></button></div>
        {children}
      </div>
    </div>
  );
}

function Details({ stop, onMark, nav, batchId }: { stop: StopView; onMark: (l: Letter, s: Letter["status"]) => void; nav: Nav; batchId: string; reload: () => void }) {
  return (
    <div className="space-y-2 rounded-xl border border-app p-2" data-testid="details">
      {stop.letters.map((l) => (
        <div key={l.id} className="flex items-center gap-2 text-sm">
          <span className="flex-1"><b>{l.externalId || `linha ${l.row}`}</b>{l.complement ? ` · ${l.complement}` : ""}{l.recipient ? ` · ${l.recipient}` : ""}<br /><span className="muted">{l.status}</span></span>
          {!TERMINAL.includes(l.status) && <Button size="sm" variant="success" onClick={() => onMark(l, "delivered")}>Entregue</Button>}
        </div>
      ))}
      <div className="grid grid-cols-1 gap-2 pt-1">
        <Button variant="secondary" className="whitespace-normal" onClick={() => nav(`/enderecos/${batchId}`)}><Download className="h-4 w-4" /> Corrigir endereço / ajustar portaria</Button>
      </div>
    </div>
  );
}
