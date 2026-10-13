import {
  ArrowUp, CornerUpLeft, CornerUpRight, Crosshair, Download, Info, ListChecks, Mic, Navigation, Pause, Play, Repeat, Search, SkipForward, Square, Undo2, Upload, Volume2, VolumeX, X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Nav } from "../App";
import { confirmEntrance, routePoint } from "../core/address";
import { refineByAnchors } from "../core/anchors";
import { type DayStats, db, type Letter, type Route } from "../core/db";
import { setUserBias } from "../core/geocode";
import { hudText, precisionNote } from "../core/hud";
import { getDayStats, recordOutcome, type Reward, revertOutcome, chime } from "../core/progress";
import { deriveView, endSession, finishRoute, resumeSession } from "../core/session";
import { assessRoute } from "../core/safety";
import { type AddressHit, searchDeliveries, type SearchResult } from "../core/search";
import { addLetterFromHit, previewRouteTo } from "../core/searchActions";
import { searchService, setSearchUser } from "../core/searchRuntime";
import type { PlanResult } from "../core/plan";
import { cancelPlan, getNavPrefs, getSettings, quickPlan, recordEvent, reportSegment, resumableSession, saveSettings, type StopView, stopsOf, TERMINAL, undoLastEvent } from "../core/service";
import { nav as navApi, parseVoiceCommand } from "../native/rotaNav";
import { Button } from "../ui/button";
import { useCurrentBatch } from "../ui/hooks";
import { Alert, Badge } from "../ui/misc";
import { OfflineBanner, StepProgress, StopListSkeleton } from "../ui/states";
import { signalDataReady } from "../intro/ready";
import RouteMap, { type MapState } from "../ui/RouteMap";
import { CompletionCard, EndedCard, RewardToast } from "../ui/GameUi";
import { useNavigation } from "../ui/useNavigation";
import { cn, fmtDist, fmtTime, REASON_LABEL } from "../ui/utils";

type Follow = "off" | "2d" | "3d";
const ICON: Record<string, any> = { left: CornerUpLeft, sharp_left: CornerUpLeft, slight_left: CornerUpLeft, right: CornerUpRight, sharp_right: CornerUpRight, slight_right: CornerUpRight };

export function MapHome({ nav, focusKey }: { nav: Nav; focusKey?: string }) {
  const [batchId, setBatchId, batchResolved] = useCurrentBatch();
  const [data, setData] = useState<Awaited<ReturnType<typeof stopsOf>> | null>(null);
  const [route, setRoute] = useState<Route | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [sel, setSel] = useState<string | null>(focusKey ?? null);
  const [follow, setFollow] = useState<Follow>("off");
  const [detail, setDetail] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [prog, setProg] = useState<{ stage: string; p: number } | null>(null);
  const [toast, setToast] = useState<{ text: string; undo?: boolean } | null>(null);
  const [reasonOpen, setReasonOpen] = useState(false);
  const [resume, setResume] = useState<{ stops: number; letters: number } | null>(null);
  const [speech, setSpeech] = useState(true);
  const [searchOpen, setSearchOpen] = useState(false);
  const [q, setQ] = useState("");
  const [confirmDeliver, setConfirmDeliver] = useState<string | null>(null);
  const [guardOpen, setGuardOpen] = useState(false);
  const [tab, setTab] = useState<"addr" | "mine">("addr");
  const [addrRes, setAddrRes] = useState<SearchResult | null>(null);
  const [searching, setSearching] = useState(false);
  const [found, setFound] = useState<AddressHit | null>(null);
  const [preview, setPreview] = useState<PlanResult | null>(null);
  const [fixing, setFixing] = useState(false);
  const [baseMap, setBaseMap] = useState<string | null>(null);
  const [mapState, setMapState] = useState<MapState>("init");
  const [sheetMode, setSheetMode] = useState<"normal" | "compact">("compact");
  const [sheetH, setSheetH] = useState(180);
  const sheetRef = useRef<HTMLElement>(null);
  const centered = useRef(false);
  const [endedId, setEndedId] = useState<string | null>(null);
  const [stats, setStats] = useState<DayStats | null>(null);
  const [lastFix, setLastFix] = useState<{ lat: number; lon: number } | null>(null);
  const [reward, setReward] = useState<Reward | null>(null);
  const lastOutcome = useRef<{ kind: "delivered" | "not_delivered" | "skipped"; letters: number } | null>(null);
  const rewardTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const returnTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const prevFollow = useRef<Follow>("3d");

  useEffect(() => { if (loaded) signalDataReady(); }, [loaded]);
  const reload = useCallback(async () => {
    if (!batchResolved) return; // ainda lendo o cache: continua no skeleton (sem piscar "Nenhuma entrega")
    if (!batchId) { setLoaded(true); setStats(await getDayStats()); return; }
    const d = await stopsOf(batchId);
    const rs = (await db.routes.where("batchId").equals(batchId).toArray()).sort((a, b) => b.version - a.version);
    setData(d);
    setRoute(rs.find((r) => r.status === "active") ?? null);
    const st = await getSettings();
    setEndedId(st.endedRouteId ?? null);
    setLastFix(st.lastFix ? { lat: st.lastFix.lat, lon: st.lastFix.lon } : null);
    if (st.lastFix) setUserBias({ lat: st.lastFix.lat, lon: st.lastFix.lon });
    setStats(await getDayStats());
    setLoaded(true);
  }, [batchId, batchResolved]);
  useEffect(() => { void reload(); }, [reload]);
  useEffect(() => { void resumableSession().then((r) => setResume(r ? { stops: r.stops, letters: r.letters } : null)); getNavPrefs().then((p) => setSpeech(p.speech)); }, [batchId]);
  useEffect(() => { if (focusKey) setSel(focusKey); }, [focusKey]);

  const N = useNavigation(() => void reload());
  const { ui } = N;
  const navigating = ui.active;
  const navigatingRef = useRef(false);
  navigatingRef.current = navigating;

  // GPS automático ao entrar no mapa; retoma ao voltar do segundo plano (permissão pode ter mudado)
  useEffect(() => {
    void N.attach().then((att) => { if (!att) void N.locate({ ask: true }); });
    const vis = () => { if (document.visibilityState === "visible" && !navigatingRef.current) void N.locate(); };
    document.addEventListener("visibilitychange", vis);
    return () => { document.removeEventListener("visibilitychange", vis); if (!navigatingRef.current) void navApi.stopLocation(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // primeiro fix válido: centraliza e passa a seguir (o gesto do usuário desliga)
  useEffect(() => { if (ui.fix && ui.gps === "ok" && !centered.current && !sel && !navigating) { centered.current = true; setFollow("2d"); } }, [ui.fix, ui.gps, sel, navigating]);
  // altura real do painel: controles e atribuição do mapa ficam acima dele
  useEffect(() => {
    const el = sheetRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setSheetH(Math.round(el.getBoundingClientRect().height)));
    ro.observe(el);
    return () => ro.disconnect();
  }, [loaded]);

  const byKey = useMemo(() => new Map(data?.stops.map((s) => [s.key, s]) ?? []), [data]);
  const items = useMemo(() => (route?.stops ?? []).map((rs) => ({ rs, stop: byKey.get(rs.key)! })).filter((x) => x.stop), [route, byKey]);
  const open = (st: { status: string }) => ["pending", "partial"].includes(st.status);
  const nextIdx = items.findIndex((x) => open(x.stop));
  const next = nextIdx >= 0 ? items[nextIdx] : null;
  const current = (sel ? items.find((x) => x.rs.key === sel) : null) ?? next;
  const pendingLetters = (data?.letters ?? []).filter((l) => !TERMINAL.includes(l.status) && l.status !== "postponed" && !l.excluded).length;
  const doneLetters = (data?.letters ?? []).filter((l) => TERMINAL.includes(l.status)).length;
  const stopsDone = items.filter((x) => !open(x.stop)).length;

  const openStopsN = items.filter((x) => open(x.stop)).length;
  const view = deriveView({ letters: data?.letters.filter((l) => !l.excluded).length ?? 0, pendingLetters, routeId: route?.id ?? null, openStops: openStopsN, navActive: navigating, paused: ui.paused, endedRouteId: endedId });
  const outsideLetters = (data?.letters ?? []).filter((l) => !l.excluded && !TERMINAL.includes(l.status) && (l.status === "postponed" || !l.addressKey || (data?.unlocated ?? []).some((u) => u.id === l.id))).length;

  // Estado visual = função do estado lógico: só desenha o que a fase permite (rota concluída/encerrada NÃO fica no mapa)
  const mapStops = useMemo(() => {
    if (view.showRoute) return items.map((x) => ({
      id: x.rs.key, lat: routePoint(x.stop.address)!.lat, lon: routePoint(x.stop.address)!.lon, seq: x.rs.seq, status: x.stop.status,
      uncertain: x.stop.uncertain, isNext: x.rs.key === next?.rs.key,
    }));
    if (view.showStopPins) return (data?.stops ?? []).map((s) => ({ id: s.key, lat: routePoint(s.address)!.lat, lon: routePoint(s.address)!.lon, seq: null, status: s.status, uncertain: s.uncertain, isNext: false }));
    return [];
  }, [items, next, view.showRoute, view.showStopPins, data]);

  // seguir a posição ao iniciar; gesto do usuário desliga
  useEffect(() => { if (navigating) setSheetMode("compact"); }, [navigating]);
  useEffect(() => { if (navigating) getNavPrefs().then((p) => setFollow(p.camera3d ? "3d" : "2d")); else setFollow("off"); }, [navigating]);

  // rota concluída com navegação ainda ligada: encerra serviço, câmera e instruções (limpeza centralizada)
  useEffect(() => { if (view.phase === "completed" && navigating) void N.stop(); }, [view.phase, navigating]); // eslint-disable-line react-hooks/exhaustive-deps
  // posição atual alimenta o desempate de endereços e a "última posição conhecida" (persistida no máximo a cada 20 s)
  const lastSaved = useRef(0);
  useEffect(() => {
    const f = ui.fix;
    if (!f || ui.gps !== "ok") return;
    setUserBias({ lat: f.lat, lon: f.lon });
    if (Date.now() - lastSaved.current > 20_000) { lastSaved.current = Date.now(); void saveSettings({ lastFix: { lat: f.lat, lon: f.lon, accuracy: f.accuracy, at: f.time } }); }
  }, [ui.fix, ui.gps]);
  // gesto no mapa durante a navegação: câmera livre; volta ao modo de navegação sozinha depois de 8 s
  const onUserMove = useCallback(() => {
    setFollow((f) => { if (f !== "off") prevFollow.current = f; return "off"; });
    clearTimeout(returnTimer.current);
    if (navigatingRef.current) returnTimer.current = setTimeout(() => { if (navigatingRef.current) setFollow(prevFollow.current); }, 8000);
  }, []);

  const [kw, setKw] = useState(0);
  useEffect(() => { const h = () => setKw(Math.round(window.innerHeight - (window.visualViewport?.height ?? window.innerHeight))); window.visualViewport?.addEventListener("resize", h); return () => window.visualViewport?.removeEventListener("resize", h); }, []);

  async function doPlan() {
    if (!batchId) return;
    setBusy("Calculando rota…");
    try {
      // origem: GPS atual (fix recente) se houver; senão o ponto de partida confirmado em Ajustes
      let here: { lat: number; lon: number } | null = null;
      try { const f = await N.awaitFirstFix(ui.gps === "ok" ? 1000 : 6000); here = { lat: f.lat, lon: f.lon }; } catch { /* sem GPS: usa a partida salva */ }
      await quickPlan(batchId, here, (st, p) => setProg({ stage: st, p }));
      await reload();
    } catch (e) { setToast({ text: (e as Error).message }); }
    setBusy(null); setProg(null);
  }

  async function mark(ls: Letter[], status: Letter["status"], reason: string | null = null) {
    if (!route || !ls.length) return;
    const stopTotal = items.length;
    const stopIndex = (current?.rs.seq ?? stopsDone + 1);
    for (const l of ls) await recordEvent(l.id, status, route.id, reason);
    const kind = status === "delivered" ? "delivered" : status === "postponed" ? "skipped" : "not_delivered";
    lastOutcome.current = { kind, letters: ls.length };
    const remainingLetters = Math.max(0, pendingLetters - (kind === "skipped" ? 0 : ls.length));
    const r = await recordOutcome(kind, ls.length, { remainingLetters, remainingStops: Math.max(0, openStopsN - 1), stopIndex, stopTotal });
    if (r) {
      setToast(null); setReward(r);
      clearTimeout(rewardTimer.current); rewardTimer.current = setTimeout(() => setReward(null), 4500);
      if ((await getNavPrefs()).sound) chime();
    } else setToast({ text: `${ls.length} carta(s): ${kind === "skipped" ? "adiada" : "não entregue"}.`, undo: true });
    await reload();
    if (navigating) await N.advance();
    setSel(null);
    setDetail(false);
  }

  async function undo() {
    if (!batchId) return;
    setReward(null);
    const ev = await undoLastEvent(batchId);
    if (ev && lastOutcome.current) { await revertOutcome(lastOutcome.current.kind, lastOutcome.current.letters); lastOutcome.current = null; }
    setToast({ text: ev ? "Última ação desfeita." : "Nada para desfazer." });
    await reload();
  }

  /** Encerrar: para GPS/voz/serviço, limpa câmera e instruções e tira a rota do mapa (sem apagar cartas). */
  async function endNav() {
    if (!route) return;
    if (openStopsN > 0 && !window.confirm(`Encerrar a navegação? ${openStopsN} parada(s) pendente(s) continuam salvas e você pode retomar a rota.`)) return;
    await N.stop();
    await endSession(route.id);
    setFollow("off"); setSel(null); setReward(null); setDetail(false);
    await reload();
    void N.locate();
  }
  async function resumeRoute() { if (!route) return; await resumeSession(); await reload(); await N.start(route); }
  async function replan() { await resumeSession(); await saveSettings({ endedRouteId: null }); if (route) await db.routes.update(route.id, { status: "superseded" }); await reload(); await doPlan(); }
  async function clearFinished() { if (route) await finishRoute(route.id); setFollow("off"); setSel(null); await reload(); void N.locate(); }

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

  const hits = useMemo(() => (data ? searchDeliveries(data.letters, q) : []), [q, data]);

  // busca de endereços: debounce 300 ms, cancela a anterior; Nominatim público só consulta no botão/Enter (política de uso)
  useEffect(() => {
    if (!searchOpen || tab !== "addr") return;
    setSearchUser(ui.fix ? { lat: ui.fix.lat, lon: ui.fix.lon } : lastFix);
    if (q.trim().length < 2) { setAddrRes(null); setSearching(false); return; }
    setSearching(true);
    const t = setTimeout(() => { void searchService.query(q).then((r) => { setAddrRes(r); setSearching(false); }); }, 300);
    return () => { clearTimeout(t); searchService.cancel(); };
  }, [q, tab, searchOpen]); // eslint-disable-line react-hooks/exhaustive-deps
  async function submitSearch() {
    setSearching(true);
    const r = await searchService.query(q, { submit: true });
    setAddrRes(r); setSearching(false);
  }
  function pickHit(h: AddressHit) { setFound(h); setPreview(null); setFixing(false); setSearchOpen(false); setFollow("off"); }
  async function routeToFound() {
    if (!found) return;
    const here = ui.fix ? { lat: ui.fix.lat, lon: ui.fix.lon } : lastFix ?? (await getSettings()).start;
    if (!here) { setToast({ text: "Sem posição de partida: aguarde o GPS ou defina a partida em Ajustes." }); return; }
    setBusy("Calculando rota a pé…");
    try { setPreview(await previewRouteTo({ lat: found.lat, lon: found.lon, label: found.title }, here)); }
    catch (e) { setToast({ text: (e as Error).message || "Não foi possível confirmar um trajeto urbano seguro até este destino." }); }
    setBusy(null);
  }
  async function addFound() {
    if (!found) return;
    const r = await addLetterFromHit(found, batchId);
    setFound(null); setPreview(null); setFixing(false);
    setToast({ text: `Carta adicionada: ${found.title}. ${found.numberConfirmed ? "" : "Posição aproximada — confirme na tela de endereços."}` });
    if (r.batchId !== batchId) setBatchId(r.batchId); else await reload();
  }

  // guarda de segurança: "Rota revisada" só quando trajeto e destinos satisfazem os critérios (core/safety.ts)
  const guard = useMemo(() => route ? assessRoute(route.metrics?.quality, items.filter((x) => open(x.stop)).map((x) => ({ approximate: x.stop.trust.approximate, code: x.stop.trust.code }))) : null, [route, items]); // eslint-disable-line react-hooks/exhaustive-deps

  async function startGuarded() {
    if (!route) return;
    if (guard?.needsConfirm) { setGuardOpen(true); return; }
    await N.start(route);
  }
  /** "Reportar problema neste trecho": grava o trecho mais próximo da posição atual, evita-o e recalcula (limite local de 40). */
  async function reportHere() {
    if (!route) return;
    const pos = ui.fix ? { lat: ui.fix.lat, lon: ui.fix.lon } : lastFix;
    if (!pos) { setToast({ text: "Sem posição para localizar o trecho. Aguarde o GPS." }); return; }
    const r = await reportSegment(route, pos, null);
    if (!r) { setToast({ text: "Não encontrei um trecho da rota perto de você." }); return; }
    setToast({ text: `Trecho reportado: ${r.street || "sem nome"} (${Math.round(r.meters)} m). Recalculando sem ele…` });
    if (navigating) await N.stop();
    await replan();
  }

  if (!loaded) return (
    <div className="fixed inset-x-0 top-0 grid content-end bg-[var(--bg)] p-3" style={{ bottom: "calc(3.5rem + env(safe-area-inset-bottom))" }} data-testid="home-loading">
      <StopListSkeleton count={4} />
    </div>
  );

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
    <div className="fixed inset-x-0 top-0 z-0" style={{ bottom: "calc(3.5rem + env(safe-area-inset-bottom))", paddingTop: "env(safe-area-inset-top)", ["--sheet-h" as any]: `${sheetH}px` }} data-testid="map-home"
      data-map-state={mapState} data-gps-state={ui.gps} data-nav={navigating ? "on" : "off"} data-phase={view.phase} data-follow={follow} data-route={view.showRoute ? "on" : "off"} data-fix={ui.fix ? `${ui.fix.lat.toFixed(5)},${ui.fix.lon.toFixed(5)}` : ""}>
      <RouteMap className="absolute inset-0 h-full w-full" stops={mapStops} route={preview ? { type: "FeatureCollection", features: preview.features } : view.showRoute ? route?.geojson : null} start={view.showRoute ? route?.start : null}
        pin={found && fixing ? { lat: found.lat, lon: found.lon } : null} onPinMove={(lat, lon) => setFound((f) => f && { ...f, lat, lon, precision: "street", numberConfirmed: false, source: "malha", note: "Posição ajustada por você neste aparelho (não confirmada no local)." })} fix={ui.fix} lastKnown={ui.fix ? null : lastFix} follow={view.navUi || !navigating ? follow : "off"}
        ahead={view.navUi ? ui.ahead : null} immersive={view.navUi} speed={ui.fix?.speed ?? -1} turnDist={ui.state?.nextDist ?? -1} onUserMove={onUserMove} bottomPad={sheetH + 16} onBaseMap={setBaseMap} onMapState={(st) => setMapState(st)}
        onStopClick={(k) => { setSel(k); setFollow("off"); }} focus={found ? { lat: found.lat, lon: found.lon } : sel && selectedPoint && follow === "off" ? selectedPoint : null} />

      {/* resultado da busca de endereço: marcador + cartão de ações */}
      {found && (
        <div className="pointer-events-auto absolute inset-x-2 z-20 rounded-2xl border border-app bg-[var(--card)] p-3 shadow-xl" style={{ bottom: sheetH + 12 }} data-testid="found-card">
          <div className="flex items-start gap-2">
            <div className="min-w-0 flex-1">
              <div className="text-lg font-extrabold leading-tight">{found.title}</div>
              <div className="text-sm muted">{found.subtitle}</div>
              <div className="mt-1"><Badge color={found.numberConfirmed ? "#16a34a" : "#b45309"}>{found.numberConfirmed ? "Número localizado" : found.numberAsked ? "Número não confirmado" : "Rua"}</Badge></div>
              <p className="mt-1 text-xs muted">{found.note}</p>
              {preview && <p className="mt-1 text-sm font-semibold" data-testid="preview-info">{fmtDist(preview.totalDistance)} · {fmtTime(preview.totalTime)} a pé (estimativa){preview.quality && !preview.quality.reviewed ? " — Trechos não verificados — revisar antes de seguir" : ""}</p>}
            </div>
            <button aria-label="Fechar resultado" onClick={() => { setFound(null); setPreview(null); setFixing(false); }}><X className="h-5 w-5" /></button>
          </div>
          <div className="mt-2 grid grid-cols-2 gap-2">
            <Button size="md" onClick={() => void addFound()}>Adicionar carta</Button>
            <Button size="md" variant="secondary" onClick={() => void routeToFound()}><Navigation className="h-4 w-4" /> Traçar rota até aqui</Button>
            <Button size="md" variant="secondary" onClick={() => setFollow("off")}>Ver no mapa</Button>
            <Button size="md" variant={fixing ? "primary" : "secondary"} onClick={() => setFixing((v) => !v)}>{fixing ? "Pronto" : "Corrigir posição"}</Button>
          </div>
        </div>
      )}

      {/* topo: HUD de manobra ou busca */}
      <div className="pointer-events-none absolute inset-x-0 top-0 p-2" style={{ paddingTop: "calc(env(safe-area-inset-top) + 0.5rem)" }}>
        {view.navUi && hud ? (
          <div className="pointer-events-auto flex items-center gap-3 rounded-2xl bg-[#2e1065] p-3 text-white shadow-xl" role="status" aria-live="polite" data-testid="hud">
            <HudIcon className="h-12 w-12 shrink-0" aria-hidden />
            <div className="min-w-0">
              <div className="text-2xl font-extrabold leading-tight">{hud.head}</div>
              <div className="text-base leading-snug">{hud.body}</div>
            </div>
          </div>
        ) : !view.navUi && (
          <div className="pointer-events-auto flex gap-2">
            <button onClick={() => setSearchOpen(true)} className="card flex min-w-0 flex-1 items-center gap-2 px-3 py-3 text-left shadow-lg" aria-label="Buscar endereço ou entrega">
              <Search className="h-5 w-5 shrink-0" /> <span className="muted truncate">Buscar em Santos…</span>
            </button>
            <Button variant="secondary" size="lg" className="shrink-0" onClick={() => nav("/importar")} aria-label="Importar lista"><Upload className="h-5 w-5" /> Importar</Button>
          </div>
        )}
        <div className="pointer-events-auto mt-2 overflow-hidden rounded-xl"><OfflineBanner /></div>
        <GpsChip ui={ui} onRetry={() => void N.locate({ ask: true })} />
        {navigating && ui.rerouting && <div className="pointer-events-auto mt-2 rounded-xl bg-amber-100 p-2 text-sm font-semibold text-amber-900" role="status">Recalculando a rota…</div>}
        {navigating && ui.offRoute && !ui.rerouting && <div className="pointer-events-auto mt-2 rounded-xl bg-amber-100 p-2 text-sm font-semibold text-amber-900" role="status">Você saiu da rota.</div>}
        {navigating && st?.lowAccuracy && <div className="pointer-events-auto mt-2 rounded-xl bg-amber-100 p-2 text-sm font-semibold text-amber-900" role="status">Sinal de GPS fraco — as instruções podem atrasar.</div>}
        {ui.error && <div className="pointer-events-auto mt-2"><Alert kind="error">{ui.error}</Alert></div>}
        {baseMap === "offline" && !navigating && <div className="mt-2 text-xs"><Badge color="#b45309">Mapa-base indisponível</Badge></div>}
      </div>

      {/* controles flutuantes */}
      <div className="absolute right-2 flex flex-col gap-2" style={{ bottom: sheetH + 12 }}>
        <Fab label={follow === "off" ? "Centralizar em mim" : follow === "3d" ? "Câmera 3D (tocar para 2D)" : "Câmera 2D (tocar para 3D)"}
          onClick={() => { if (!ui.fix && !navigating) void N.locate(); setFollow(follow === "off" ? "3d" : follow === "3d" ? "2d" : "3d"); }} active={follow !== "off"}>
          <Crosshair className="h-6 w-6" />
        </Fab>
        {navigating && (<>
          <Fab label="Repetir instrução" onClick={() => void N.repeat()}><Repeat className="h-6 w-6" /></Fab>
          <Fab label={speech ? "Silenciar voz" : "Ativar voz"} onClick={async () => { const p = await getNavPrefs(); const v = !speech; setSpeech(v); await saveSettings({ nav: { ...p, speech: v } }); await navApi.configure({ speech: v }); }}>
            {speech ? <Volume2 className="h-6 w-6" /> : <VolumeX className="h-6 w-6" />}
          </Fab>
          <Fab label="Comando de voz" onClick={voice}><Mic className="h-6 w-6" /></Fab>
        </>)}
      </div>

      {reward && <RewardToast reward={reward} onUndo={() => void undo()} onClose={() => setReward(null)} top={navigating ? "calc(env(safe-area-inset-top) + 9rem)" : "calc(env(safe-area-inset-top) + 7rem)"} />}
      {toast && (
        <div role="status" className="absolute inset-x-2 z-30 flex items-center gap-2 rounded-xl bg-neutral-900 p-3 text-sm text-white shadow-xl" style={{ top: navigating ? "calc(env(safe-area-inset-top) + 9.5rem)" : "calc(env(safe-area-inset-top) + 7rem)" }}>
          <span className="flex-1">{toast.text}</span>
          {toast.undo && <button className="font-bold underline" onClick={() => { setToast(null); void undo(); }}>Desfazer</button>}
          <button aria-label="Fechar aviso" onClick={() => setToast(null)}><X className="h-5 w-5" /></button>
        </div>
      )}

      {/* painel inferior */}
      <section ref={sheetRef} className="absolute inset-x-0 bottom-0 max-h-[70%] overflow-y-auto rounded-t-3xl border-t border-app bg-[var(--card)] p-3 shadow-[0_-8px_24px_rgba(0,0,0,.18)]" aria-label="Entrega atual" data-testid="sheet">
        <button onClick={() => setSheetMode(sheetMode === "compact" ? "normal" : "compact")} aria-label={sheetMode === "compact" ? "Expandir painel" : "Recolher painel"} aria-expanded={sheetMode !== "compact"}
          className="mx-auto mb-1 grid h-6 w-24 place-items-center"><span className="h-1.5 w-10 rounded-full bg-neutral-400" aria-hidden /></button>
        {busy && (() => {
          const order = ["matriz", "otimização", "geometria"], at = prog ? Math.max(0, order.indexOf(prog.stage)) : 0;
          const names = ["Calculando distâncias a pé", "Otimizando a ordem das paradas", "Desenhando o trajeto"];
          return (
            <div className="mb-2"><StepProgress title={busy} onCancel={() => cancelPlan()} done={at === 0 && prog ? Math.round(prog.p * 100) : undefined} total={at === 0 && prog ? 100 : undefined}
              hint={at === 1 ? "A otimização usa até ~10 s." : undefined}
              steps={names.map((label, i) => ({ label, state: i < at ? "done" as const : i === at ? "active" as const : "todo" as const }))} /></div>
          );
        })()}

        {view.phase === "empty" ? (
          <div className="space-y-3 text-center" data-testid="state-empty">
            <div className="text-lg font-bold">Nenhuma entrega ainda</div>
            <p className="text-sm muted">Cole os endereços ou importe a planilha. Sem separador, sem cabeçalho.</p>
            <Button size="lg" className="w-full" onClick={() => nav("/importar")}><Upload className="h-5 w-5" /> Importar lista</Button>
          </div>
        ) : view.phase === "unplanned" ? (
          <div className="space-y-3" data-testid="state-unplanned">
            {sheetMode !== "compact" ? <Counters letters={data?.letters.length ?? 0} stops={data!.stops.length} unlocated={unlocated} done={doneLetters} pending={pendingLetters} />
              : <div data-testid="counters" className="text-center text-sm muted">{data!.letters.length} cartas · {data!.stops.length} paradas · {unlocated} não loc. · {doneLetters} concluídas · {pendingLetters} pendentes</div>}
            {unlocated > 0 && <Alert kind="warn">{unlocated} carta(s) sem localização ficam fora da rota até você localizar ou corrigir o endereço.</Alert>}
            <Button size="lg" className="w-full" onClick={doPlan} disabled={!!busy || (data?.stops.length ?? 0) === 0}>Calcular rota</Button>
            <div className="grid grid-cols-2 gap-2">
              <Button variant="secondary" onClick={() => nav(`/enderecos/${batchId}`)}>Localizar / corrigir</Button>
              <Button variant="secondary" onClick={() => nav("/importar")}><Upload className="h-4 w-4" /> Importar mais</Button>
            </div>
          </div>
        ) : view.phase === "completed" ? (
          <CompletionCard stats={stats ?? { date: "", delivered: doneLetters, notDelivered: 0, skipped: 0, streak: 0, bestStreak: 0, xp: 0, startedAt: 0, lastAt: 0, activeMs: 0 }} outside={outsideLetters} hasRoute={!!route}
            onClear={() => void clearFinished()} onHistory={() => nav("/relatorios")} onImport={() => nav("/importar")}
            onPlanRest={outsideLetters > 0 && (data?.stops.length ?? 0) > 0 ? () => void clearFinished().then(() => doPlan()) : null} />
        ) : view.phase === "ended" ? (
          <EndedCard stopsLeft={openStopsN} lettersLeft={pendingLetters} onResume={() => void resumeRoute()} onReplan={() => void replan()} onFinish={() => void clearFinished()} />
        ) : (
          <div className="space-y-3" data-testid="state-live">
            {resume && view.phase === "planned" && (
              <button className="w-full rounded-xl border-2 border-brand p-3 text-left" onClick={() => route && N.start(route)} data-testid="resume">
                <span className="block text-xs font-semibold uppercase text-brand">Sessão interrompida</span>
                <span className="text-lg font-bold">Retomar {resume.letters} entrega(s) em {resume.stops} parada(s)</span>
              </button>
            )}
            {sheetMode !== "compact" ? <Counters letters={data?.letters.length ?? 0} stops={data?.stops.length ?? 0} unlocated={unlocated} done={doneLetters} pending={pendingLetters} />
              : <div data-testid="counters" className="text-center text-sm muted">{data?.letters.length ?? 0} cartas · {data?.stops.length ?? 0} paradas · {unlocated} não loc. · {doneLetters} concluídas · {pendingLetters} pendentes</div>}
            {cur ? (
              <>
                <div>
                  <div className="text-xs font-semibold uppercase text-next">{current && current.rs.key === next?.rs.key ? "Próxima parada" : "Parada selecionada"} · {current!.rs.seq} de {items.length}</div>
                  <div className="text-2xl font-extrabold leading-tight" data-testid="cur-addr">{curAddr}</div>
                  <div className="flex flex-wrap items-center gap-1 text-sm muted">
                    {cur.address.neighborhood ?? ""} · {curLetters.length} carta(s)
                    {navigating && st && st.stopKey === current!.rs.key && st.stopDist >= 0 && <b> · a {fmtDist(st.stopDist)}</b>}
                  </div>
                  {sheetMode !== "compact" && <div className="mt-1 flex flex-wrap gap-1"><Badge color={cur.trust.approximate ? "#b45309" : "#16a34a"}>{cur.trust.label}</Badge></div>}
                  {note && <p className="mt-1 text-sm text-amber-700" role="note">{note}</p>}
                  {cur.address.source?.startsWith("estimado") && cur.address.reason && <p className="mt-1 text-sm text-amber-700" role="note" data-testid="estimated-note">{cur.address.reason}</p>}
                </div>
                {navigating && ui.nearStopKey === current!.rs.key && ui.nearStopText && (
                  <Alert kind="ok">{ui.nearStopText}</Alert>
                )}
                <div className={cn("grid gap-2", sheetMode === "compact" ? "grid-cols-3" : "grid-cols-2")}>
                  <Button variant="success" size="lg" className="h-16 whitespace-normal px-2 text-base leading-tight" disabled={!curLetters.length}
                    onClick={() => curLetters.length > 1 ? setConfirmDeliver(current!.rs.key) : mark(curLetters, "delivered")}>
                    {curLetters.length > 1 ? `Entregar todas (${curLetters.length})` : "Entregue"}
                  </Button>
                  <Button variant="danger" size="lg" className="h-16 whitespace-normal px-2 text-base leading-tight" disabled={!curLetters.length} onClick={() => setReasonOpen(true)}>Não consegui</Button>
                  <Button variant="secondary" size="lg" className={cn("whitespace-normal px-2 text-base", sheetMode === "compact" ? "h-16" : "h-14")} disabled={!curLetters.length} onClick={() => mark(curLetters, "postponed")}><SkipForward className="h-5 w-5" /> Pular</Button>
                  {sheetMode !== "compact" && <Button variant="secondary" size="lg" className="h-14 whitespace-normal" onClick={() => setDetail(!detail)}><Info className="h-5 w-5" /> Detalhes</Button>}
                </div>
                {detail && <Details stop={cur} onMark={(l, s) => mark([l], s)} nav={nav} batchId={batchId!} reload={reload} fix={ui.fix} onToast={(text) => setToast({ text })} />}
              </>
            ) : null}
            <div className="grid grid-cols-2 gap-2">
              {!navigating ? (
                <>
                  {guard && view.canStart && (
                    <div className="col-span-2" data-testid="route-guard" data-level={guard.level}>
                      <Badge color={guard.level === "reviewed" ? "#16a34a" : "#b45309"}>{guard.label}</Badge>
                      {guard.level !== "reviewed" && <ul className="mt-1 list-disc pl-5 text-xs muted">{guard.reasons.slice(0, 3).map((r) => <li key={r}>{r}</li>)}</ul>}
                    </div>
                  )}
                  <Button size="lg" className="col-span-2" onClick={() => void startGuarded()} disabled={!view.canStart || !next}><Navigation className="h-5 w-5" /> Iniciar navegação</Button>
                </>
              ) : (<>
                {ui.paused ? <Button variant="secondary" onClick={N.resume}><Play className="h-5 w-5" /> Retomar</Button> : <Button variant="secondary" onClick={N.pause}><Pause className="h-5 w-5" /> Pausar</Button>}
                <Button variant="secondary" onClick={() => void endNav()}><Square className="h-5 w-5" /> Encerrar</Button>
                <Button variant="ghost" className="col-span-2" onClick={() => void reportHere()} data-testid="report-segment">Reportar problema neste trecho</Button>
              </>)}
              {sheetMode !== "compact" && <>
              <Button variant="ghost" onClick={undo}><Undo2 className="h-5 w-5" /> Desfazer</Button>
              <Button variant="ghost" onClick={() => nav("/entregas")}><ListChecks className="h-5 w-5" /> Entregas</Button></>}
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
      {guardOpen && guard && (
        <Modal title={guard.label} onClose={() => setGuardOpen(false)}>
          <ul className="mb-3 list-disc pl-5 text-sm">{guard.reasons.map((r) => <li key={r}>{r}</li>)}</ul>
          <p className="mb-3 text-sm muted">Confira o trajeto no mapa antes de seguir. Se algum trecho parecer trilha, escadaria ou área privada, não siga por ele.</p>
          <div className="grid gap-2">
            <Button size="lg" onClick={() => { setGuardOpen(false); setDetail(false); }}>Revisar no mapa</Button>
            <Button variant="secondary" size="lg" onClick={() => { setGuardOpen(false); if (route) void N.start(route); }}>Iniciar mesmo assim</Button>
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
        <Modal title="Busca de endereços e entregas" onClose={() => setSearchOpen(false)}>
          <div role="tablist" className="mb-2 grid grid-cols-2 gap-1 rounded-xl bg-black/5 p-1">
            {([["addr", "Endereços"], ["mine", `Minhas entregas${hits.length ? ` (${hits.length})` : ""}`]] as const).map(([k, label]) => (
              <button key={k} role="tab" aria-selected={tab === k} onClick={() => setTab(k)} className={cn("rounded-lg py-2 text-sm font-semibold", tab === k && "bg-[var(--card)] shadow")}>{label}</button>
            ))}
          </div>
          <form onSubmit={(e) => { e.preventDefault(); if (tab === "addr") void submitSearch(); }} className="mb-2 flex gap-2">
            <input autoFocus aria-label="Buscar" value={q} onChange={(e) => setQ(e.target.value)} enterKeyHint="search"
              placeholder={tab === "addr" ? "Rua e número em Santos…" : "Rua, número, código, destinatário…"} className="w-full rounded-xl border border-app bg-transparent p-3" />
            {tab === "addr" && <Button type="submit" variant="secondary" aria-label="Buscar endereço"><Search className="h-5 w-5" /></Button>}
          </form>
          {tab === "addr" ? (
            <ul className="max-h-[50vh] overflow-y-auto" data-testid="addr-results">
              {searching && <li className="py-2 text-sm muted">Buscando…</li>}
              {addrRes?.hits.map((h) => (
                <li key={h.id}><button className="w-full border-b border-app py-3 text-left" onClick={() => pickHit(h)}>
                  <b className="block">{h.title}</b>
                  <span className="text-sm muted">{h.subtitle}</span>
                  <span className="block text-xs text-amber-700">{h.numberConfirmed ? "Número localizado" : h.numberAsked ? "Número não confirmado — ponto aproximado na rua" : "Rua"}</span>
                </button></li>
              ))}
              {addrRes?.message && <li className="py-2 text-sm text-amber-700" role="status">{addrRes.message}</li>}
              {addrRes?.state === "ok" && !addrRes.fromRemote && <li className="py-2 text-xs muted">Ruas do mapa offline. Toque na lupa para consultar números no provedor.</li>}
              {q.trim().length >= 2 && !searching && addrRes && !addrRes.hits.length && !addrRes.message && <li className="py-3 muted">Nenhum endereço encontrado em Santos.</li>}
            </ul>
          ) : (
            <ul className="max-h-[50vh] overflow-y-auto">
              {hits.map((h) => (
                <li key={h.key}><button className="w-full border-b border-app py-3 text-left" onClick={() => { setSel(h.key); setSearchOpen(false); setQ(""); }}>
                  <b className="block">{h.line}</b><span className="text-sm muted">{h.sub}</span></button></li>
              ))}
              {q.trim() && !hits.length && <li className="py-3 muted">Nada encontrado nas suas entregas.</li>}
            </ul>
          )}
        </Modal>
      )}
    </div>
  );
}

function GpsChip({ ui, onRetry }: { ui: ReturnType<typeof useNavigation>["ui"]; onRetry: () => void }) {
  const age = ui.fix ? Math.max(0, Math.round((Date.now() - ui.fix.time) / 1000)) : null;
  const m: Record<string, [string, string, boolean]> = {
    idle: ["GPS inativo", "#6b7280", false],
    needs_permission: ["Permitir localização", "#b45309", true],
    asking: ["Pedindo permissão…", "#2563eb", false],
    denied: ["Localização negada — ative em Ajustes do Android › Apps › Rota Santos › Permissões", "#dc2626", false],
    disabled: ["GPS desligado — ative a localização do aparelho", "#dc2626", true],
    searching: [`Procurando GPS…${ui.gpsMsg ? " " + ui.gpsMsg : ""}`, "#2563eb", false],
    ok: [`GPS ±${Math.round(ui.fix?.accuracy ?? 0)} m${age != null && age > 3 ? ` · há ${age} s` : ""}`, "#15803d", false],
    stale: [`Sinal de GPS antigo${age != null ? ` (${age} s)` : ""}`, "#b45309", true],
    error: [`GPS com erro: ${ui.gpsMsg}`, "#dc2626", true],
  };
  const [text, color, retry] = m[ui.gps] ?? m.idle;
  return (
    <div className="pointer-events-auto mt-2 flex items-center gap-2" data-testid="gps-chip" data-state={ui.gps}>
      <span className="inline-flex max-w-full items-center gap-2 rounded-full bg-[var(--card)] px-3 py-1 text-sm font-semibold shadow-md" style={{ color }}>
        <span className="h-2.5 w-2.5 rounded-full" style={{ background: color }} aria-hidden /> <span className="break-words">{text}</span>
      </span>
      {retry && <button className="rounded-full bg-brand px-3 py-1 text-sm font-semibold text-white" onClick={onRetry}>Tentar</button>}
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

function Details({ stop, onMark, nav, batchId, reload, fix, onToast }: { stop: StopView; onMark: (l: Letter, s: Letter["status"]) => void; nav: Nav; batchId: string; reload: () => void; fix: { lat: number; lon: number; accuracy?: number } | null; onToast: (t: string) => void }) {
  /** Marca a porta com o GPS (só com precisão ≤ 30 m). Vira posição confirmada e âncora para estimar os números vizinhos. */
  async function markDoor() {
    if (!fix) return onToast("Sem posição do GPS ainda. Aguarde o ponto azul aparecer.");
    if ((fix.accuracy ?? 999) > 30) return onToast(`GPS impreciso (±${Math.round(fix.accuracy ?? 0)} m). Chegue mais perto da porta ou aguarde melhorar (precisa de ≤ 30 m).`);
    await confirmEntrance(stop.key, fix.lat, fix.lon, `marcada com GPS no local (±${Math.round(fix.accuracy ?? 0)} m)`, "gps");
    const r = await refineByAnchors();
    onToast(`Porta marcada: ${stop.address.display.split(" - ")[0]}.${r.refined ? ` ${r.refined} número(s) vizinho(s) estimado(s) a partir dela.` : ""}`);
    reload();
  }
  return (
    <div className="space-y-2 rounded-xl border border-app p-2" data-testid="details">
      {stop.letters.map((l) => (
        <div key={l.id} className="flex items-center gap-2 text-sm">
          <span className="flex-1"><b>{l.externalId || `linha ${l.row}`}</b>{l.complement ? ` · ${l.complement}` : ""}{l.recipient ? ` · ${l.recipient}` : ""}<br /><span className="muted">{l.status}</span></span>
          {!TERMINAL.includes(l.status) && <Button size="sm" variant="success" onClick={() => onMark(l, "delivered")}>Entregue</Button>}
        </div>
      ))}
      <div className="grid grid-cols-1 gap-2 pt-1">
        <Button variant="success" className="whitespace-normal" onClick={() => void markDoor()} data-testid="mark-door"><Crosshair className="h-4 w-4" /> Marcar a porta aqui (GPS)</Button>
        <Button variant="secondary" className="whitespace-normal" onClick={() => nav(`/enderecos/${batchId}`)}><Download className="h-4 w-4" /> Corrigir endereço / ajustar portaria</Button>
      </div>
    </div>
  );
}
