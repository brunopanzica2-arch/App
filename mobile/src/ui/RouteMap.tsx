
import * as maplibregl from "maplibre-gl";
import type { GeoJSONSource, Map as MLMap } from "maplibre-gl";
import { useEffect, useRef } from "react";

// O worker do MapLibre é servido de /public (copiado no postinstall): o bundler
// do Next não resolve o import.meta.url usado pela biblioteca para achá-lo.
maplibregl.setWorkerUrl(new URL("maplibre-gl-worker.mjs", document.baseURI).href);

const STYLE = "https://tiles.openfreemap.org/styles/liberty";
const SANTOS: [number, number] = [-46.333, -23.962];

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
  focus?: { lat: number; lon: number } | null;
  className?: string;
};

export default function RouteMap({ stops = [], route, start, candidates = [], pin, onPinMove, onStopClick, me, focus, className }: Props) {
  const el = useRef<HTMLDivElement>(null);
  const map = useRef<MLMap | null>(null);
  const ready = useRef(false);
  const pinMarker = useRef<maplibregl.Marker | null>(null);
  const extraMarkers = useRef<maplibregl.Marker[]>([]);
  const fitted = useRef("");
  const clickRef = useRef(onStopClick);
  clickRef.current = onStopClick;

  useEffect(() => {
    if (!el.current) return;
    const m = new maplibregl.Map({ container: el.current, style: STYLE, center: SANTOS, zoom: 13, attributionControl: { compact: true } });
    m.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-right");
    m.on("load", () => {
      m.addSource("route", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
      m.addSource("stops", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
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
      m.on("click", "stops-circle", (e: any) => {
        const id = e.features?.[0]?.properties?.id;
        if (id) clickRef.current?.(String(id));
      });
      m.on("mouseenter", "stops-circle", () => (m.getCanvas().style.cursor = "pointer"));
      m.on("mouseleave", "stops-circle", () => (m.getCanvas().style.cursor = ""));
      ready.current = true;
      m.fire("data-ready" as any);
    });
    map.current = m;
    return () => {
      ready.current = false;
      m.remove();
    };
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
    if (me) mk(me.lat, me.lon, `<div style="width:16px;height:16px;border-radius:999px;background:#2563eb;border:3px solid #fff;box-shadow:0 0 0 6px #2563eb44"></div>`, "Sua localização");
  }, [start, candidates, me]);

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

  return <div ref={el} className={className ?? "h-[60vh] w-full rounded-2xl overflow-hidden"} role="application" aria-label="Mapa da rota" />;
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
