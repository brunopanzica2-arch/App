/**
 * Ponte para a navegação nativa (plugin Android "RotaNav"). No navegador/E2E há um substituto: geolocalização do
 * navegador + speechSynthesis (pt-BR). O substituto NÃO roda com a tela apagada: só o app Android tem serviço em primeiro plano.
 */
import { Capacitor, registerPlugin, type PluginListenerHandle } from "@capacitor/core";
import type { NavRoute } from "../core/navroute";

export interface NavFix { lat: number; lon: number; accuracy: number; speed: number; bearing: number; time: number; provider: string; mock: boolean }
export interface NavState { progress: number; total: number; accuracy: number; speed: number; lateral: number; offRoute: boolean; lowAccuracy: boolean; paused: boolean;
  nextKind: string; nextStreet: string; nextDist: number; stopKey: string; stopSeq: number; stopDist: number; stopsLeft: number }
export type NavEventName = "location" | "navState" | "instruction" | "nearStop" | "offRoute" | "backOnRoute" | "routeEnd" | "navigation" | "tts" | "locationError";
export interface Perms { location: string; notifications: string; microphone: string; backgroundLocation: string }
export interface VoiceCfg { speech: boolean; detailed: boolean; preciseGps: boolean; lockscreenManeuver: boolean; rate: number; volume: number }

interface Plugin {
  checkPermissions(): Promise<Perms>;
  requestNavPermissions(): Promise<Perms>;
  requestMicrophone(): Promise<Perms>;
  status(): Promise<any>;
  configure(c: VoiceCfg): Promise<void>;
  startNavigation(r: NavRoute & { stopIndex: number }): Promise<{ backend: string }>;
  updateRoute(r: NavRoute & { stopIndex: number }): Promise<void>;
  advanceStop(): Promise<void>;
  jumpToStop(a: { index: number }): Promise<void>;
  pause(): Promise<void>; resume(): Promise<void>; repeat(): Promise<void>;
  stopNavigation(): Promise<void>;
  speak(a: { text: string }): Promise<void>;
  startLocation(a: { preciseGps: boolean }): Promise<{ backend: string }>;
  stopLocation(): Promise<void>;
  drain(): Promise<{ events: any[] }>;
  setShowWhenLocked(a: { enabled: boolean }): Promise<void>;
  keepScreenOn(a: { enabled: boolean }): Promise<void>;
  listenOnce(): Promise<{ text: string }>;
  addListener(name: string, fn: (d: any) => void): Promise<PluginListenerHandle>;
}

export const isNative = () => Capacitor.isNativePlatform();
const native = registerPlugin<Plugin>("RotaNav");

type Handler = (name: NavEventName, data: any) => void;
const handlers = new Set<Handler>();
const emit = (n: NavEventName, d: any) => handlers.forEach((h) => h(n, d));
const NAMES: NavEventName[] = ["location", "navState", "instruction", "nearStop", "offRoute", "backOnRoute", "routeEnd", "navigation", "tts", "locationError"];
let attached = false;
async function attach() {
  if (attached || !isNative()) return;
  attached = true;
  for (const n of NAMES) await native.addListener(n, (d) => emit(n, d));
}

/** Eventos acumulados com a tela apagada (WebView suspenso) são entregues ao voltar. */
export async function drainEvents() {
  if (!isNative()) return;
  const { events } = await native.drain();
  for (const e of events) emit(e._event, e);
}

export function onNavEvent(h: Handler): () => void {
  handlers.add(h);
  void attach();
  return () => { handlers.delete(h); };
}

// ------------------------------------------------------------------ substituto web
let watchId: number | null = null;
let webRoute: NavRoute | null = null;
let webCfg: VoiceCfg = { speech: true, detailed: true, preciseGps: true, lockscreenManeuver: false, rate: 1, volume: 1 };
function webSpeak(text: string) {
  if (!webCfg.speech || typeof speechSynthesis === "undefined") return;
  speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(text);
  u.lang = "pt-BR"; u.rate = webCfg.rate; u.volume = webCfg.volume;
  speechSynthesis.speak(u);
}
function webStartLocation() {
  if (watchId != null || !("geolocation" in navigator)) return;
  watchId = navigator.geolocation.watchPosition(
    (p) => emit("location", { lat: p.coords.latitude, lon: p.coords.longitude, accuracy: p.coords.accuracy, speed: p.coords.speed ?? -1, bearing: p.coords.heading ?? -1, time: p.timestamp, provider: "browser", mock: false }),
    (e) => emit("locationError", { message: e.message }),
    { enableHighAccuracy: webCfg.preciseGps, maximumAge: 1000, timeout: 20000 });
}

export const nav = {
  isNative,
  async permissions(): Promise<Perms> {
    if (isNative()) return native.checkPermissions();
    return { location: "prompt", notifications: "granted", microphone: "prompt", backgroundLocation: "not-requested" };
  },
  /** Localização "enquanto usa o app" + notificações. NÃO pede localização em segundo plano. */
  async requestPermissions(): Promise<Perms> {
    if (isNative()) return native.requestNavPermissions();
    return nav.permissions();
  },
  async requestMicrophone(): Promise<Perms> { return isNative() ? native.requestMicrophone() : nav.permissions(); },
  async status() { return isNative() ? native.status() : { navigating: !!webRoute, paused: false, backend: "browser", playServices: false, gpsEnabled: "geolocation" in navigator, sdk: 0, permissions: await nav.permissions() }; },
  async configure(c: Partial<VoiceCfg>) {
    webCfg = { ...webCfg, ...c };
    if (isNative()) await native.configure(webCfg);
  },
  async startLocation(): Promise<string> {
    await attach();
    if (isNative()) return (await native.startLocation({ preciseGps: webCfg.preciseGps })).backend;
    webStartLocation();
    return "browser";
  },
  async stopLocation() {
    if (isNative()) return native.stopLocation();
    if (watchId != null) { navigator.geolocation.clearWatch(watchId); watchId = null; }
  },
  async start(route: NavRoute, stopIndex = 0): Promise<string> {
    await attach();
    await nav.configure({});
    if (isNative()) return (await native.startNavigation({ ...route, stopIndex })).backend;
    webRoute = route;
    webStartLocation();
    emit("navigation", { status: "started", stops: route.stops.length, meters: route.length });
    return "browser";
  },
  async updateRoute(route: NavRoute, stopIndex: number) {
    if (isNative()) return native.updateRoute({ ...route, stopIndex });
    webRoute = route;
  },
  async advanceStop() { if (isNative()) await native.advanceStop(); },
  async jumpToStop(index: number) { if (isNative()) await native.jumpToStop({ index }); },
  async pause() { if (isNative()) await native.pause(); else emit("navigation", { status: "paused" }); },
  async resume() { if (isNative()) await native.resume(); else emit("navigation", { status: "resumed" }); },
  async repeat() { if (isNative()) await native.repeat(); },
  async stop() {
    if (isNative()) await native.stopNavigation();
    else { webRoute = null; await nav.stopLocation(); if (typeof speechSynthesis !== "undefined") speechSynthesis.cancel(); emit("navigation", { status: "stopped" }); }
  },
  async speak(text: string) { if (isNative()) await native.speak({ text }); else webSpeak(text); },
  async showWhenLocked(enabled: boolean) { if (isNative()) await native.setShowWhenLocked({ enabled }); },
  async keepScreenOn(enabled: boolean) { if (isNative()) await native.keepScreenOn({ enabled }); },
  /** Reconhecimento de voz só com o toque no microfone. */
  async listenOnce(): Promise<string> {
    if (isNative()) return (await native.listenOnce()).text;
    throw new Error("Comandos de voz exigem o app Android.");
  },
};

/** Comandos reconhecidos (pt-BR). "Marcar entregue" nunca executa direto: exige confirmação na tela. */
export type VoiceCommand = "repeat" | "next" | "remaining" | "skip" | "pause" | "resume" | "deliver" | "unknown";
export function parseVoiceCommand(text: string): VoiceCommand {
  const t = text.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").trim();
  if (/\brepet/.test(t)) return "repeat";
  if (/\bproxima\b/.test(t) && /entrega|parada|/.test(t)) return "next";
  if (/quanto falta|falta quanto|restante/.test(t)) return "remaining";
  if (/\bpular\b|\bpula\b/.test(t)) return "skip";
  if (/\bpausar\b|\bpausa\b/.test(t)) return "pause";
  if (/\bretomar\b|\bcontinuar\b/.test(t)) return "resume";
  if (/\bmarcar entreg|\bentregue\b/.test(t)) return "deliver";
  return "unknown";
}
