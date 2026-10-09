"""Orquestração: endereços -> malha OSM -> matriz -> OR-Tools -> percurso no mapa."""

from __future__ import annotations

import math
import threading
from collections import OrderedDict
from dataclasses import dataclass, field
from typing import Callable

import numpy as np

from .config import DEFAULT_START_ADDRESS, OptimizationConfig, TravelProfile
from .geocode import GeoResult, geocode
from .network import Network, build_network
from .optimizer import solve_sequence
from .osm_data import TILE_DEG, OsmData, bbox_around, load_osm
from .router import Router, SnapError


@dataclass
class PointInput:
    address: str | None = None
    lat: float | None = None
    lon: float | None = None
    label: str | None = None


@dataclass
class PlanRequest:
    stops: list[PointInput]
    start: PointInput = field(default_factory=lambda: PointInput(DEFAULT_START_ADDRESS))
    end: PointInput | None = None
    config: OptimizationConfig = field(default_factory=OptimizationConfig)


class PlanningError(ValueError):
    pass


# ------------------------------------------------------------ cache de malhas

_net_cache: "OrderedDict[tuple, Network]" = OrderedDict()
_net_lock = threading.Lock()
OsmLoader = Callable[[tuple], OsmData]


def _grid_bbox(bbox):
    s, w, n, e = bbox
    f = lambda v: math.floor(v / TILE_DEG) * TILE_DEG
    c = lambda v: math.ceil(v / TILE_DEG) * TILE_DEG
    return (round(f(s), 4), round(f(w), 4), round(c(n), 4), round(c(e), 4))


def get_network(bbox, cross_areas: bool, loader: OsmLoader = load_osm) -> Network:
    key = (_grid_bbox(bbox), cross_areas, loader)
    with _net_lock:
        if key in _net_cache:
            _net_cache.move_to_end(key)
            return _net_cache[key]
    # reaproveita uma malha já carregada que cubra o bbox
    with _net_lock:
        for (kb, kc, kl), net in _net_cache.items():
            if kc == cross_areas and kl is loader and _contains(kb, key[0]):
                return net
    net = build_network(loader(key[0]), cross_areas=cross_areas)
    with _net_lock:
        _net_cache[key] = net
        while len(_net_cache) > 4:
            _net_cache.popitem(last=False)
    return net


def _contains(outer, inner) -> bool:
    return (outer[0] <= inner[0] and outer[1] <= inner[1]
            and outer[2] >= inner[2] and outer[3] >= inner[3])


# ------------------------------------------------------------ planejamento


def _resolve(p: PointInput, what: str) -> GeoResult:
    if p.lat is not None and p.lon is not None:
        return GeoResult(p.label or p.address or what, p.lat, p.lon,
                         p.label or p.address or f"{p.lat:.6f}, {p.lon:.6f}", True)
    if not p.address:
        raise PlanningError(f"{what}: informe endereço ou coordenadas.")
    try:
        return geocode(p.address)
    except LookupError as exc:
        raise PlanningError(f"{what}: {exc}") from exc


def plan_route(req: PlanRequest, loader: OsmLoader = load_osm,
               geocoder: Callable[[PointInput, str], GeoResult] = _resolve) -> dict:
    cfg = req.config
    prof: TravelProfile = cfg.profile
    prof.validate()
    if not req.stops:
        raise PlanningError("Informe ao menos uma entrega.")
    if cfg.route_mode not in ("open", "circular", "fixed_end"):
        raise PlanningError("route_mode deve ser open, circular ou fixed_end.")
    if cfg.route_mode == "fixed_end" and req.end is None:
        raise PlanningError("Rota com destino fixo exige o destino final.")

    warnings: list[str] = []
    start = geocoder(req.start, "Ponto de partida")
    stops = [geocoder(s, f"Entrega {i + 1}") for i, s in enumerate(req.stops)]
    end = geocoder(req.end, "Destino final") if cfg.route_mode == "fixed_end" else None
    for g, what in [(start, "Ponto de partida")] + [
        (s, f"Entrega {i + 1}") for i, s in enumerate(stops)
    ] + ([(end, "Destino final")] if end else []):
        if not g.exact:
            warnings.append(
                f"{what}: número não localizado no OpenStreetMap; posição aproximada "
                f"da via ({g.label}). Confira/arraste o marcador no mapa."
            )

    points = [start] + stops + ([end] if end else [])
    bbox = bbox_around([(p.lat, p.lon) for p in points], cfg.bbox_margin_m)
    net = get_network(bbox, prof.cross_pedestrian_areas, loader)
    if net.n_edges == 0:
        raise PlanningError("Nenhuma via de pedestre encontrada na região.")
    router = Router(net, prof)

    snaps = []
    errors = []
    for p, name in zip(points, ["Ponto de partida"] + [f"Entrega {i + 1}" for i in range(len(stops))]
                       + (["Destino final"] if end else [])):
        try:
            snaps.append(router.snap(p.lat, p.lon, cfg.max_snap_m))
        except SnapError as exc:
            errors.append(f"{name}: {exc}")
    if errors:
        raise PlanningError(" ".join(errors))

    solver = router.solver(snaps)
    T, D = solver.matrices()
    k = len(points)
    start_i = 0
    stop_is = list(range(1, 1 + len(stops)))
    end_i = k - 1 if end else None
    if not np.all(np.isfinite(T)):
        bad = [i for i in range(k) if not np.all(np.isfinite(T[i])) or not np.all(np.isfinite(T[:, i]))]
        raise PlanningError(f"Pontos sem caminho válido entre si: {bad}")

    order = solve_sequence(
        T, D, start_i, stop_is, end=end_i, circular=cfg.route_mode == "circular",
        service_time_s=cfg.service_time_s, time_limit_s=cfg.time_limit_s,
    )
    seq = [start_i] + order
    if cfg.route_mode == "circular":
        seq.append(start_i)
    elif end_i is not None:
        seq.append(end_i)

    result = _assemble(solver, points, snaps, seq, stop_is, cfg, warnings)
    # comparação com a ordem informada pelo usuário
    naive = [start_i] + stop_is + ([start_i] if cfg.route_mode == "circular" else [])
    if end_i is not None:
        naive.append(end_i)
    result["summary"]["input_order_time_s"] = float(
        sum(T[a, b] for a, b in zip(naive, naive[1:])) + cfg.service_time_s * len(stops)
    )
    result["summary"]["input_order_distance_m"] = float(
        sum(D[a, b] for a, b in zip(naive, naive[1:]))
    )
    return result


def _assemble(solver, points, snaps, seq, stop_is, cfg, warnings) -> dict:
    features = []
    stops_out = []
    by_mode_m = {"ride": 0.0, "walk": 0.0, "steps": 0.0}
    by_mode_s = {"ride": 0.0, "walk": 0.0, "steps": 0.0}
    flagged: dict[str, float] = {}
    clock = 0.0
    total_m = 0.0
    n_stop = 0

    def stop_record(idx, kind, number):
        p, s = points[idx], snaps[idx]
        return {
            "number": number, "kind": kind, "input_index": idx - 1 if kind == "delivery" else None,
            "label": p.query if p.query else p.label, "resolved": p.label,
            "lat": p.lat, "lon": p.lon, "snap_lat": s.snap_lat, "snap_lon": s.snap_lon,
            "snap_distance_m": round(s.distance_m, 1), "approximate": not p.exact,
        }

    stops_out.append({**stop_record(seq[0], "start", 0), "eta_s": 0.0})
    for leg, (a, b) in enumerate(zip(seq, seq[1:]), start=1):
        arcs = solver.path_arcs(a, b) or []
        leg_m = leg_s = 0.0
        cur = None
        for arc in arcs:
            info = solver.arc_info(arc)
            t = solver.arc_time(arc)
            m = float(solver.length[arc])
            leg_m += m
            leg_s += t
            by_mode_m[info["mode"]] += m
            by_mode_s[info["mode"]] += t
            for f in info["flags"]:
                flagged[f] = flagged.get(f, 0.0) + m
            key = (info["mode"], tuple(info["flags"]))
            coords = solver.arc_coords(arc)
            if cur is not None and cur["_key"] == key:
                cur["geometry"]["coordinates"].append(list(coords[1]))
                cur["properties"]["distance_m"] += m
                cur["properties"]["time_s"] += t
                if info["name"] and info["name"] not in cur["properties"]["streets"]:
                    cur["properties"]["streets"].append(info["name"])
            else:
                cur = {
                    "type": "Feature", "_key": key,
                    "geometry": {"type": "LineString", "coordinates": [list(c) for c in coords]},
                    "properties": {
                        "kind": "path", "leg": leg, "mode": info["mode"],
                        "flags": info["flags"], "distance_m": m, "time_s": t,
                        "streets": [info["name"]] if info["name"] else [],
                    },
                }
                features.append(cur)
        total_m += leg_m
        clock += leg_s
        if b in stop_is:
            n_stop += 1
            rec = stop_record(b, "delivery", n_stop)
            rec.update(eta_s=round(clock, 1), leg_distance_m=round(leg_m, 1),
                       leg_time_s=round(leg_s, 1))
            stops_out.append(rec)
            clock += cfg.service_time_s
        else:
            kind = "end" if leg == len(seq) - 1 else "waypoint"
            rec = stop_record(b, kind, n_stop + 1)
            rec.update(eta_s=round(clock, 1), leg_distance_m=round(leg_m, 1),
                       leg_time_s=round(leg_s, 1))
            stops_out.append(rec)

    for f in features:
        f.pop("_key")
        f["properties"]["distance_m"] = round(f["properties"]["distance_m"], 1)
        f["properties"]["time_s"] = round(f["properties"]["time_s"], 1)
    for s in stops_out:
        # acesso do ponto informado até a malha (porta -> calçada/rua)
        if s["snap_distance_m"] > 1:
            features.append({
                "type": "Feature",
                "geometry": {"type": "LineString", "coordinates": [
                    [s["lon"], s["lat"]], [s["snap_lon"], s["snap_lat"]]]},
                "properties": {"kind": "access", "number": s["number"],
                               "distance_m": s["snap_distance_m"]},
            })
        features.append({
            "type": "Feature",
            "geometry": {"type": "Point", "coordinates": [s["lon"], s["lat"]]},
            "properties": {"kind": s["kind"], "number": s["number"], "label": s["label"]},
        })

    for f, m in flagged.items():
        if f in ("escada", "acesso_privado", "barreira", "portao_privado", "proibido_pedalar"):
            warnings.append(f"Percurso inclui trecho sinalizado: {f} ({m:.0f} m).")

    total_s = clock
    prof = cfg.profile
    return {
        "summary": {
            "total_time_s": round(total_s, 1),
            "travel_time_s": round(total_s - cfg.service_time_s * len(stop_is), 1),
            "service_time_s": cfg.service_time_s * len(stop_is),
            "total_distance_m": round(total_m, 1),
            "distance_by_mode_m": {k: round(v, 1) for k, v in by_mode_m.items()},
            "time_by_mode_s": {k: round(v, 1) for k, v in by_mode_s.items()},
            "flagged_distance_m": {k: round(v, 1) for k, v in flagged.items()},
            "route_mode": cfg.route_mode,
            "routing_profile": "pedestrian/foot",
            "vehicle": "bicycle",
            "ride_speed_kmh": prof.ride_speed_kmh,
            "walk_speed_kmh": prof.walk_speed_kmh,
        },
        "stops": stops_out,
        "geojson": {"type": "FeatureCollection", "features": features},
        "warnings": warnings,
    }
