"""Motores de roteamento com perfil PEDESTRIAN/FOOT.

InternalEngine (padrão): malha de pedestres construída do OSM (pacote
`roteamento`), sem sentidos únicos de automóveis, sem prioridade a ciclovias,
com trechos pedaláveis x conduzir a pé e sinalização de escadas/barreiras/
acessos privados. Matriz por Dijkstra multi-origem (scipy).

ValhallaEngine (alternativo): costing "pedestrian" de um servidor Valhalla
próprio. Não distingue trechos pedaláveis de trechos a pé; o tempo usa a
velocidade operacional informada como walking_speed.
"""

from __future__ import annotations

import hashlib
import json
import math
import pickle
import threading
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable

import numpy as np
import requests

from roteamento.config import TravelProfile
from roteamento.network import Network, build_network, haversine
from roteamento.osm_data import OsmData, fetch_osm_api_tiles, fetch_overpass, load_osm_file
from roteamento.router import Router, SnapError

from ...core.config import Settings

NETWORK_BUILD_VERSION = "pedestrian-v1"


@dataclass
class SnapInfo:
    ok: bool
    snap_lat: float | None = None
    snap_lon: float | None = None
    distance_m: float | None = None
    error: str | None = None
    flags: list = field(default_factory=list)
    confidence: str | None = None
    nearest_any_m: float | None = None


@dataclass
class Leg:
    distance_m: float
    time_s: float
    features: list[dict]
    by_mode_m: dict[str, float] = field(default_factory=dict)
    flags_m: dict[str, float] = field(default_factory=dict)


class MatrixSession:
    """Resultado da matriz + capacidade de reconstruir a geometria dos trechos."""

    time_s: np.ndarray
    dist_m: np.ndarray
    snaps: list[SnapInfo]
    engine: str
    network_version: str | None
    compute_ms: int

    def leg(self, i: int, j: int) -> Leg:
        raise NotImplementedError


class RoutingEngine:
    name = "base"

    def matrix(self, points: list[tuple[float, float]], profile: TravelProfile,
               max_snap_m: float) -> MatrixSession:
        raise NotImplementedError

    def network_version(self) -> str | None:
        return None


# ===================================================================== interno


def profile_hash(profile: TravelProfile) -> str:
    return hashlib.sha256(json.dumps(profile.to_dict(), sort_keys=True).encode()).hexdigest()[:16]


class InternalSession(MatrixSession):
    def __init__(self, router: Router, points, max_snap_m, network_version):
        t0 = time.perf_counter()
        self.engine = "internal-osm-pedestrian"
        self.network_version = network_version
        self.snaps = []
        snaps_ok = []
        self.index_map: dict[int, int] = {}
        # o ponto 0 é a ORIGEM: ela elege a malha operacional (nós alcançáveis a partir dela)
        reach = None
        for i, (lat, lon) in enumerate(points):
            try:
                if i == 0:
                    s, reach = router.snap_origin(lat, lon, max_snap_m)
                else:
                    s = router.snap(lat, lon, max_snap_m, reach)
                self.index_map[i] = len(snaps_ok)
                snaps_ok.append(s)
                self.snaps.append(SnapInfo(True, s.snap_lat, s.snap_lon, round(s.distance_m, 1),
                                           flags=list(s.flags), confidence=s.confidence,
                                           nearest_any_m=s.nearest_any_m))
            except SnapError as exc:
                self.snaps.append(SnapInfo(False, error=str(exc)))
        k = len(points)
        self.time_s = np.full((k, k), np.inf)
        self.dist_m = np.full((k, k), np.inf)
        self.solver = router.solver(snaps_ok) if snaps_ok else None
        if self.solver:
            T, D = self.solver.matrices()
            ids = sorted(self.index_map)
            sub = [self.index_map[i] for i in ids]
            self.time_s[np.ix_(ids, ids)] = T[np.ix_(sub, sub)]
            self.dist_m[np.ix_(ids, ids)] = D[np.ix_(sub, sub)]
        self.compute_ms = int((time.perf_counter() - t0) * 1000)

    def leg(self, i: int, j: int) -> Leg:
        si, sj = self.index_map[i], self.index_map[j]
        arcs = self.solver.path_arcs(si, sj)
        if arcs is None:
            raise ValueError("Trecho sem caminho válido na malha.")
        feats: list[dict] = []
        by_mode: dict[str, float] = {}
        flags_m: dict[str, float] = {}
        dist = tm = 0.0
        cur = None
        for a in arcs:
            info = self.solver.arc_info(a)
            t = self.solver.arc_time(a)
            m = float(self.solver.length[a])
            dist += m
            tm += t
            by_mode[info["mode"]] = by_mode.get(info["mode"], 0.0) + m
            for f in info["flags"]:
                flags_m[f] = flags_m.get(f, 0.0) + m
            key = (info["mode"], tuple(info["flags"]))
            c = self.solver.arc_coords(a)
            if cur is not None and cur["_key"] == key:
                cur["geometry"]["coordinates"].append([round(c[1][0], 7), round(c[1][1], 7)])
                cur["properties"]["distance_m"] += m
                cur["properties"]["time_s"] += t
                if info["name"] and info["name"] not in cur["properties"]["streets"]:
                    cur["properties"]["streets"].append(info["name"])
            else:
                cur = {"type": "Feature", "_key": key,
                       "geometry": {"type": "LineString",
                                    "coordinates": [[round(x, 7), round(y, 7)] for x, y in c]},
                       "properties": {"kind": "path", "mode": info["mode"], "flags": info["flags"],
                                      "distance_m": m, "time_s": t,
                                      "streets": [info["name"]] if info["name"] else []}}
                feats.append(cur)
        for f in feats:
            f.pop("_key")
            f["properties"]["distance_m"] = round(f["properties"]["distance_m"], 1)
            f["properties"]["time_s"] = round(f["properties"]["time_s"], 1)
        return Leg(dist, tm, feats, by_mode, flags_m)


OsmLoader = Callable[[tuple[float, float, float, float]], OsmData]


class InternalEngine(RoutingEngine):
    name = "internal"

    def __init__(self, settings: Settings, loader: OsmLoader | None = None,
                 network: Network | None = None):
        self.s = settings
        self.loader = loader
        self._net = network
        self._version: str | None = None
        self._routers: dict[str, Router] = {}
        self._lock = threading.Lock()

    def _default_loader(self) -> OsmLoader:
        src = self.s.osm_source
        if src == "overpass":
            def load(b):
                try:
                    return fetch_overpass(b)
                except RuntimeError:
                    return fetch_osm_api_tiles(b)  # alternativa documentada
            return load
        if src == "osmapi":
            return fetch_osm_api_tiles
        path = self.s.osm_pbf_path if src == "pbf" else self.s.osm_json_path
        if not path:
            raise RuntimeError(f"OSM_SOURCE={src} exige o caminho do arquivo.")
        return lambda b: load_osm_file(path, b)

    def _cache_file(self) -> Path:
        key = f"{NETWORK_BUILD_VERSION}|{self.s.osm_source}|{self.s.operation_bbox}|{self.s.osm_pbf_path}|{self.s.osm_json_path}"
        h = hashlib.sha256(key.encode()).hexdigest()[:16]
        return Path(self.s.data_dir) / "networks" / f"network-{h}.pkl"

    def network(self) -> Network:
        with self._lock:
            if self._net is None:
                path = self._cache_file()
                if self.loader is None and path.exists():
                    blob = path.read_bytes()
                    self._net = pickle.loads(blob)
                else:
                    osm = (self.loader or self._default_loader())(self.s.bbox)
                    self._net = build_network(osm, cross_areas=True)
                    if self.loader is None:
                        path.parent.mkdir(parents=True, exist_ok=True)
                        blob = pickle.dumps(self._net)
                        path.write_bytes(blob)
            if self._version is None:
                n = self._net
                sig = f"{NETWORK_BUILD_VERSION}|{n.n_nodes}|{n.n_edges}|{sum(n.osm_id[:: max(1, n.n_nodes // 1000)])}"
                self._version = hashlib.sha256(sig.encode()).hexdigest()[:16]
            return self._net

    def refresh(self) -> str:
        with self._lock:
            self._net = None
            self._version = None
            self._routers.clear()
            p = self._cache_file()
            if p.exists():
                p.unlink()
        self.network()
        return self._version

    def network_version(self) -> str | None:
        self.network()
        return self._version

    def router(self, profile: TravelProfile) -> Router:
        net = self.network()
        h = profile_hash(profile)
        with self._lock:
            r = self._routers.get(h)
            if r is None:
                r = Router(net, profile)
                self._routers[h] = r
                while len(self._routers) > 4:
                    self._routers.pop(next(iter(self._routers)))
            return r

    def matrix(self, points, profile, max_snap_m) -> MatrixSession:
        return InternalSession(self.router(profile), points, max_snap_m, self.network_version())

    def stats(self) -> dict:
        net = self.network()
        return {"nodes": net.n_nodes, "edges": net.n_edges, "version": self._version,
                "bbox": self.s.operation_bbox, "source": self.s.osm_source}


# ===================================================================== Valhalla


def decode_polyline6(s: str) -> list[list[float]]:
    coords, idx, lat, lon = [], 0, 0, 0
    while idx < len(s):
        for which in (0, 1):
            shift = result = 0
            while True:
                b = ord(s[idx]) - 63
                idx += 1
                result |= (b & 0x1F) << shift
                shift += 5
                if b < 0x20:
                    break
            d = ~(result >> 1) if result & 1 else result >> 1
            if which == 0:
                lat += d
            else:
                lon += d
        coords.append([lon / 1e6, lat / 1e6])
    return coords


class ValhallaSession(MatrixSession):
    def __init__(self, eng: "ValhallaEngine", points, profile, max_snap_m):
        t0 = time.perf_counter()
        self.eng, self.points, self.profile = eng, points, profile
        self.engine = "valhalla-pedestrian"
        self.network_version = eng.network_version()
        self.snaps = eng.locate(points, max_snap_m)
        k = len(points)
        self.time_s = np.full((k, k), np.inf)
        self.dist_m = np.full((k, k), np.inf)
        ok = [i for i, s in enumerate(self.snaps) if s.ok]
        chunk = 50
        for a in range(0, len(ok), chunk):
            for b in range(0, len(ok), chunk):
                src, dst = ok[a:a + chunk], ok[b:b + chunk]
                res = eng.post("sources_to_targets", {
                    "sources": [{"lat": points[i][0], "lon": points[i][1]} for i in src],
                    "targets": [{"lat": points[j][0], "lon": points[j][1]} for j in dst],
                    **eng.costing(profile), "units": "kilometers",
                })
                for r, row in enumerate(res["sources_to_targets"]):
                    for c, cell in enumerate(row):
                        if cell.get("time") is not None and cell.get("distance") is not None:
                            self.time_s[src[r], dst[c]] = cell["time"]
                            self.dist_m[src[r], dst[c]] = cell["distance"] * 1000
        self.compute_ms = int((time.perf_counter() - t0) * 1000)

    def leg(self, i: int, j: int) -> Leg:
        a, b = self.points[i], self.points[j]
        res = self.eng.post("route", {
            "locations": [{"lat": a[0], "lon": a[1]}, {"lat": b[0], "lon": b[1]}],
            **self.eng.costing(self.profile), "units": "kilometers"})
        leg = res["trip"]["legs"][0]
        coords = decode_polyline6(leg["shape"])
        d = leg["summary"]["length"] * 1000
        t = leg["summary"]["time"]
        feat = {"type": "Feature", "geometry": {"type": "LineString", "coordinates": coords},
                "properties": {"kind": "path", "mode": "ride", "flags": ["modo_nao_distinguido_valhalla"],
                               "distance_m": round(d, 1), "time_s": round(t, 1), "streets": []}}
        return Leg(d, t, [feat], {"ride": d}, {})


class ValhallaEngine(RoutingEngine):
    name = "valhalla"

    def __init__(self, settings: Settings, session: requests.Session | None = None):
        self.s = settings
        self.http = session or requests.Session()

    def post(self, endpoint: str, body: dict) -> dict:
        r = self.http.post(f"{self.s.valhalla_url.rstrip('/')}/{endpoint}", json=body, timeout=120)
        if r.status_code >= 400:
            raise RuntimeError(f"Valhalla {endpoint}: HTTP {r.status_code} {r.text[:200]}")
        return r.json()

    def costing(self, profile: TravelProfile) -> dict:
        opts = {"walking_speed": min(max(profile.ride_speed_kmh, 0.5), 25.0)}
        if profile.steps_policy == "forbid":
            opts["step_penalty"] = 1e5
        elif profile.steps_policy == "penalize":
            opts["step_penalty"] = profile.steps_penalty_s
        if profile.private_policy == "forbid":
            opts["private_access_penalty"] = 1e5
        return {"costing": "pedestrian", "costing_options": {"pedestrian": opts}}

    def locate(self, points, max_snap_m) -> list[SnapInfo]:
        out = []
        for a in range(0, len(points), 100):
            chunk = points[a:a + 100]
            res = self.post("locate", {"locations": [{"lat": p[0], "lon": p[1]} for p in chunk],
                                       "costing": "pedestrian", "verbose": False})
            for p, item in zip(chunk, res):
                edges = item.get("edges") or []
                if not edges:
                    out.append(SnapInfo(False, error="Sem via de pedestre próxima."))
                    continue
                e = edges[0]
                lat, lon = e.get("correlated_lat"), e.get("correlated_lon")
                d = haversine(p[0], p[1], lat, lon) if lat is not None else None
                if d is not None and d > max_snap_m:
                    out.append(SnapInfo(False, lat, lon, round(d, 1),
                                        f"Ponto a {d:.0f} m da via mais próxima."))
                else:
                    out.append(SnapInfo(True, lat, lon, round(d, 1) if d is not None else None))
        return out

    def network_version(self) -> str | None:
        try:
            r = self.http.get(f"{self.s.valhalla_url.rstrip('/')}/status", timeout=10)
            return str(r.json().get("tileset_last_modified", "unknown"))
        except Exception:
            return "unknown"

    def matrix(self, points, profile, max_snap_m) -> MatrixSession:
        return ValhallaSession(self, points, profile, max_snap_m)


_engine: RoutingEngine | None = None
_engine_lock = threading.Lock()


def get_engine(settings: Settings) -> RoutingEngine:
    global _engine
    with _engine_lock:
        if _engine is None:
            _engine = ValhallaEngine(settings) if settings.routing_engine == "valhalla" else InternalEngine(settings)
        return _engine


def set_engine(engine: RoutingEngine | None) -> None:
    """Usado em testes para injetar uma malha sintética."""
    global _engine
    with _engine_lock:
        _engine = engine


__all__ = ["get_engine", "set_engine", "InternalEngine", "ValhallaEngine", "decode_polyline6",
           "MatrixSession", "Leg", "SnapInfo", "profile_hash", "math"]
