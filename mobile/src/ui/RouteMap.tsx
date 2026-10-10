
import * as maplibregl from "maplibre-gl";
import type { GeoJSONSource, Map as MLMap } from "maplibre-gl";
import { useEffect, useRef, useState } from "react";
import { loadOfflineStyle } from "./offlineMap";

// O worker do MapLibre é servido de /public (copiado no postinstall): o bundler
// do Next não resolve o import.meta.url usado pela biblioteca para achá-lo.
maplibregl.setWorkerUrl(new URL("maplibre-gl-worker.mjs", document.baseURI).href);

const STYLE = "https://tiles.openfreemap.org/styles/liberty";
/** Estilo de contingência SEM internet: fundo liso + fonte local para os números das paradas.
 * O roteamento é offline; o mapa-base (ruas desenhadas) depende de internet. */
const fallbackStyle = (): any => ({
  version: 8,
  glyphs: new URL("fonts/{fontstack}/{range}.pbf", document.baseURI).href.replace("%7Bfontstack%7D", "{fontstack}").replace("%7Brange%7D", "{range}"),
  sources: {},
  layers: [{ id: "bg", type: "background", paint: { "background-color": "#e8edf3" } }],
});
const SANTOS: [number, number] = [-46.333, -23.962];

function meFeatures(f: { lat: number; lon: number; accuracy?: number }) {
  const out: any[] = [{ type: "Feature", properties: { k: "dot" }, geometry: { type: "Point", coordinates: [f.lon, f.lat] } }];
  const r = Math.min(f.accuracy ?? 0, 150);
  if (r > 3) { // círculo de precisão (aproximação com 32 vértices)
    const ring: [number, number][] = [];
    for (let i = 0; i <= 32; i++) {
      const a = (i / 32) * 2 * Math.PI;
      ring.push([f.lon + (r * Math.cos(a)) / (111320 * Math.cos((f.lat * Math.PI) / 180)), f.lat + (r * Math.sin(a)) / 110540]);
    }
    out.push({ type: "Feature", properties: { k: "acc" }, geometry: { type: "Polygon", coordinates: [ring] } });
  }
  return out;
}

export const COLORS = {
  route: "#7c3aed",
  walk: "#a855f7",
  next: "#2563eb",
  completed: "#16a34a",
  uncertain: "#eab308",
  problem: "#dc2626",
  postponed: "#6b7280",
  pending: "#ffffff",
};

export type MapStop = {
  id: string;
  lat: number;
  lon: number;
  seq?: number | null;
  status: string; // pending | partial | completed | postponed | problem
  uncertain?: boolean;
  isNext?: boolean;
};

export function stopColor(s: MapStop) {
  if (s.isNext) return COLORS.next;
  if (s.status === "completed") return COLORS.completed;
  if (s.status === "problem") return COLORS.problem;
  if (s.status === "postponed") return COLORS.postponed;
  if (s.uncertain) return COLORS.uncertain;
  return COLORS.pending;
}

type Props = {
  stops?: MapStop[];
  route?: any; // GeoJSON FeatureCollection
  start?: { lat: number; lon: number; label?: string } | null;
  candidates?: { lat: number; lon: number; label: string }[];
  pin?: { lat: number; lon: number } | null; // marcador arrastável (correção)
  onPinMove?: (lat: number, lon: number) => void;
  onStopClick?: (id: string) => void;
  me?: { lat: number; lon: number } | null;
  /** posição ao vivo (fonte GeoJSON; sem marcador React por tick) */
  fix?: { lat: number; lon: number; accuracy?: number; bearing?: number } | null;
  /** câmera: off = livre; "2d" = segue a posição; "3d" = segue com inclinação e rumo */
  follow?: "off" | "2d" | "3d";
  /** trecho restante da rota [lon,lat][] (linha roxa viva) */
  ahead?: [number, number][] | null;
  /** o usuário arrastou/zoomou o mapa: desliga o seguimento */
  onUserMove?: () => void;
  /** px livres embaixo (painel) para o ponto de seguimento não ficar atrás dele */
  bottomPad?: number;
  focus?: { lat: number; lon: number } | null;
  className?: string;
  onBaseMap?: (status: "online" | "offline" | "pack") => void;
};

export default function RouteMap({ stops = [], route, start, candidates = [], pin, onPinMove, onStopClick, me, fix, follow = "off", ahead, onUserMove, bottomPad = 0, focus, className, onBaseMap }: Props) {
  const [offline, setOffline] = useState(false);
  const applyRef = useRef<(() => void) | null>(null);
  const el = useRef<HTMLDivElement>(null);
  const map = useRef<MLMap | null>(null);
  const ready = useRef(false);
  const pinMarker = useRef<maplibregl.Marker | null>(null);
  const extraMarkers = useRef<maplibregl.Marker[]>([]);
  const fitted = useRef("");
  const clickRef = useRef(onStopClick);
  clickRef.current = onStopClick;
  const moveRef = useRef(onUserMove);
  moveRef.current = onUserMove;
  const followRef = useRef(follow);
  followRef.current = follow;
  const aheadRef = useRef(ahead);
  aheadRef.current = ahead;
  const fixRef = useRef(fix ?? (me ? { ...me } : null));
  fixRef.current = fix ?? (me ? { ...me } : null);

  const pushLive = () => {
    const m = map.current;
    if (!m || !ready.current) return;
    const f = fixRef.current;
    (m.getSource("me") as GeoJSONSource | undefined)?.setData({ type: "FeatureCollection", features: f ? meFeatures(f) : [] });
    (m.getSource("ahead") as GeoJSONSource | undefined)?.setData(aheadRef.current && aheadRef.current.length > 1
      ? { type: "FeatureCollection", features: [{ type: "Feature", properties: {}, geometry: { type: "LineString", coordinates: aheadRef.current } }] }
      : { type: "FeatureCollection", features: [] });
  };

  useEffect(() => {
    if (!el.current) return;
    let disposed = false, cleanup = () => {};
    // 1º pacote offline de Santos (sem rede); 2º estilo online; 3º fundo liso (ver toFallback)
    loadOfflineStyle().then((pack) => {
      if (disposed || !el.current) return;
      cleanup = createMap(pack);
    });
    return () => { disposed = true; cleanup(); };
    function createMap(pack: Awaited<ReturnType<typeof loadOfflineStyle>>) {
    const m = new maplibregl.Map({ container: el.current!, style: pack ? pack.style : STYLE, center: SANTOS, zoom: 13, attributionControl: { compact: true } });
    m.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-right");
    let usingFallback = false, handlers = false;
    const toFallback = () => {
      if (usingFallback) return;
      usingFallback = true;
      ready.current = false;
      setOffline(true);
      onBaseMap?.("offline");
      m.setStyle(fallbackStyle());
    };
    const timer = setTimeout(() => { if (!m.isStyleLoaded()) toFallback(); }, pack ? 3000 : 10000);
    m.on("error", (e: any) => {
      console.warn("[mapa] erro:", String(e?.error?.message || e?.message || e).slice(0, 200));
      // estilo/ fontes do mapa-base inacessíveis (sem internet): mantém rota e paradas visíveis
      if (!m.isStyleLoaded() || /style|Failed to fetch|NetworkError/i.test(String(e?.error?.message || ""))) toFallback();
    });
    m.on("style.load", () => {
      clearTimeout(timer);
      if (!usingFallback) onBaseMap?.(pack ? "pack" : "online");
      m.addSource("route", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
      m.addSource("stops", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
      m.addSource("ahead", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
      m.addSource("me", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
      m.addLayer({
        id: "route-casing", type: "line", source: "route", filter: ["==", ["get", "kind"], "path"],
        paint: { "line-color": "#ffffff", "line-width": 8, "line-opacity": 0.8 },
        layout: { "line-cap": "round", "line-join": "round" },
      });
      m.addLayer({
        id: "route-line", type: "line", source: "route",
        filter: ["all", ["==", ["get", "kind"], "path"], ["==", ["get", "mode"], "ride"]],
        paint: { "line-color": COLORS.route, "line-width": 5 },
        layout: { "line-cap": "round", "line-join": "round" },
      });
      m.addLayer({
        id: "route-walk", type: "line", source: "route",
        filter: ["all", ["==", ["get", "kind"], "path"], ["!=", ["get", "mode"], "ride"]],
        paint: { "line-color": COLORS.walk, "line-width": 5, "line-dasharray": [1.2, 1.2] },
      });
      m.addLayer({
        id: "route-flags", type: "line", source: "route",
        filter: ["all", ["==", ["get", "kind"], "path"], ["any",
          ["in", "escada", ["get", "flags"]], ["in", "acesso_privado", ["get", "flags"]],
          ["in", "barreira", ["get", "flags"]], ["in", "portao_privado", ["get", "flags"]]]],
        paint: { "line-color": COLORS.problem, "line-width": 3, "line-dasharray": [0.5, 1] },
      });
      // linha viva estilo navegação: halo, contorno escuro e núcleo roxo sobre as ruas (trecho restante)
      m.addLayer({ id: "ahead-glow", type: "line", source: "ahead", paint: { "line-color": "#c084fc", "line-width": 18, "line-blur": 10, "line-opacity": 0.55 }, layout: { "line-cap": "round", "line-join": "round" } });
      m.addLayer({ id: "ahead-casing", type: "line", source: "ahead", paint: { "line-color": "#2e1065", "line-width": 11 }, layout: { "line-cap": "round", "line-join": "round" } });
      m.addLayer({ id: "ahead-line", type: "line", source: "ahead", paint: { "line-color": "#a855f7", "line-width": 7 }, layout: { "line-cap": "round", "line-join": "round" } });
      m.addLayer({
        id: "stops-circle", type: "circle", source: "stops",
        paint: {
          "circle-radius": ["case", ["get", "isNext"], 15, 12],
          "circle-color": ["get", "color"],
          "circle-stroke-color": ["case", ["==", ["get", "color"], COLORS.pending], COLORS.route, "#ffffff"],
          "circle-stroke-width": 2.5,
        },
      });
      m.addLayer({
        id: "stops-label", type: "symbol", source: "stops",
        layout: { "text-field": ["to-string", ["coalesce", ["get", "seq"], "•"]], "text-size": 12, "text-font": ["Noto Sans Bold"], "text-allow-overlap": true },
        paint: { "text-color": ["case", ["==", ["get", "color"], COLORS.pending], COLORS.route, ["==", ["get", "color"], COLORS.uncertain], "#111827", "#ffffff"] },
      });
      m.addLayer({ id: "me-acc", type: "fill", source: "me", filter: ["==", ["get", "k"], "acc"], paint: { "fill-color": "#2563eb", "fill-opacity": 0.12 } });
      m.addLayer({ id: "me-dot", type: "circle", source: "me", filter: ["==", ["get", "k"], "dot"], paint: { "circle-radius": 8, "circle-color": "#2563eb", "circle-stroke-color": "#ffffff", "circle-stroke-width": 3 } });
      if (!handlers) {
        handlers = true;
        // gesto do usuário (arrastar/zoom/rotação) desliga o seguimento; movimento programático não tem originalEvent
        m.on("dragstart", () => moveRef.current?.());
        m.on("zoomstart", (e: any) => { if (e.originalEvent) moveRef.current?.(); });
        m.on("rotatestart", (e: any) => { if (e.originalEvent) moveRef.current?.(); });
        m.on("click", "stops-circle", (e: any) => {
          const id = e.features?.[0]?.properties?.id;
          if (id) clickRef.current?.(String(id));
        });
        m.on("mouseenter", "stops-circle", () => (m.getCanvas().style.cursor = "pointer"));
        m.on("mouseleave", "stops-circle", () => (m.getCanvas().style.cursor = ""));
      }
      ready.current = true;
      applyRef.current?.();
      pushLive();
      m.fire("data-ready" as any);
    });
    map.current = m;
    return () => {
      ready.current = false;
      m.remove();
    };
    }
  }, []);

  // dados
  useEffect(() => {
    const m = map.current;
    if (!m) return;
    const apply = () => {
      (m.getSource("route") as GeoJSONSource)?.setData(route || { type: "FeatureCollection", features: [] });
      (m.getSource("stops") as GeoJSONSource)?.setData({
        type: "FeatureCollection",
        features: stops.map((s) => ({
          type: "Feature",
          geometry: { type: "Point", coordinates: [s.lon, s.lat] },
          properties: { id: s.id, seq: s.seq ?? null, color: stopColor(s), isNext: !!s.isNext },
        })),
      });
      const key = `${stops.length}:${route?.features?.length ?? 0}:${start?.lat}`;
      if (fitted.current !== key && (stops.length || start)) {
        fitted.current = key;
        const b = new maplibregl.LngLatBounds();
        stops.forEach((s) => b.extend([s.lon, s.lat]));
        if (start) b.extend([start.lon, start.lat]);
        candidates.forEach((c) => b.extend([c.lon, c.lat]));
        if (pin) b.extend([pin.lon, pin.lat]);
        if (!b.isEmpty()) m.fitBounds(b, { padding: 60, maxZoom: 17, duration: 0 });
      }
    };
    applyRef.current = () => { fitted.current = ""; apply(); };
    if (ready.current) apply();
    else m.once("data-ready" as any, apply);
  }, [stops, route, start, candidates, pin]);

  // marcadores auxiliares (origem, candidatos, localização)
  useEffect(() => {
    const m = map.current;
    if (!m) return;
    extraMarkers.current.forEach((mk) => mk.remove());
    extraMarkers.current = [];
    const mk = (lat: number, lon: number, html: string, title: string) => {
      const d = document.createElement("div");
      d.innerHTML = html;
      d.title = title;
      d.setAttribute("aria-label", title);
      extraMarkers.current.push(new maplibregl.Marker({ element: d }).setLngLat([lon, lat]).addTo(m));
    };
    if (start) mk(start.lat, start.lon, `<div style="background:#111827;color:#fff;border-radius:8px;padding:2px 6px;font-weight:700;font-size:12px">INÍCIO</div>`, start.label || "Início");
    candidates.forEach((c, i) => mk(c.lat, c.lon, `<div style="background:#eab308;color:#111;border-radius:999px;width:22px;height:22px;display:grid;place-items:center;font-weight:800;font-size:11px;border:2px solid #fff">${String.fromCharCode(65 + i)}</div>`, c.label));
  }, [start, candidates]);

  // posição ao vivo + trecho restante + câmera de seguimento (só atualiza fontes GeoJSON e a câmera)
  useEffect(() => {
    pushLive();
    const m = map.current, f = fixRef.current;
    if (!m || !ready.current || !f || follow === "off") return;
    const moving = (f.bearing ?? -1) >= 0;
    m.easeTo({
      center: [f.lon, f.lat],
      zoom: follow === "3d" ? 18 : Math.max(m.getZoom(), 17),
      pitch: follow === "3d" ? 60 : 0,
      bearing: follow === "3d" && moving ? f.bearing! : follow === "3d" ? m.getBearing() : 0,
      padding: { top: follow === "3d" ? 140 : 0, bottom: bottomPad, left: 0, right: 0 },
      duration: 900, essential: true,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fix, me, ahead, follow, bottomPad]);

  useEffect(() => {
    const m = map.current;
    if (!m || follow !== "off" || !ready.current) return;
    m.easeTo({ pitch: 0, bearing: 0, padding: { top: 0, bottom: 0, left: 0, right: 0 }, duration: 400 });
  }, [follow]);

  // pino arrastável
  useEffect(() => {
    const m = map.current;
    if (!m) return;
    pinMarker.current?.remove();
    pinMarker.current = null;
    if (pin) {
      const mk = new maplibregl.Marker({ color: COLORS.route, draggable: !!onPinMove }).setLngLat([pin.lon, pin.lat]).addTo(m);
      mk.on("dragend", () => {
        const p = mk.getLngLat();
        onPinMove?.(p.lat, p.lng);
      });
      pinMarker.current = mk;
    }
  }, [pin, onPinMove]);

  useEffect(() => {
    if (focus && map.current) map.current.easeTo({ center: [focus.lon, focus.lat], zoom: Math.max(map.current.getZoom(), 16), duration: 300 });
  }, [focus]);

  return (
    <div className="relative">
      <div ref={el} className={className ?? "h-[60vh] w-full rounded-2xl overflow-hidden"} role="application" aria-label="Mapa da rota" />
      {offline && (
        <div role="status" className="pointer-events-none absolute bottom-8 left-2 right-2 rounded-lg bg-amber-100 px-2 py-1 text-xs font-semibold text-amber-900">
          Mapa-base indisponível (sem internet). Rota e paradas continuam visíveis; o desenho das ruas volta com a conexão.
        </div>
      )}
    </div>
  );
}

export function MapLegend() {
  const items = [
    [COLORS.route, "Percurso pedalável"],
    [COLORS.walk, "Conduzir a bicicleta a pé (tracejado)"],
    [COLORS.next, "Próxima parada"],
    [COLORS.completed, "Concluída"],
    [COLORS.uncertain, "Endereço incerto"],
    [COLORS.problem, "Problema / trecho sinalizado"],
    [COLORS.postponed, "Adiada"],
  ];
  return (
    <ul className="flex flex-wrap gap-x-4 gap-y-1 text-xs" aria-label="Legenda do mapa">
      {items.map(([c, l]) => (
        <li key={l} className="flex items-center gap-1.5">
          <span className="inline-block h-3 w-3 rounded-full border border-black/10" style={{ background: c }} /> {l}
        </li>
      ))}
    </ul>
  );
}
