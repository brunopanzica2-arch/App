"use client";
import dynamic from "next/dynamic";

export const RouteMapLazy = dynamic(() => import("./RouteMap"), {
  ssr: false,
  loading: () => <div className="grid h-[60vh] place-items-center rounded-2xl card muted">Carregando mapa…</div>,
});
export { MapLegend, COLORS } from "./RouteMap";
