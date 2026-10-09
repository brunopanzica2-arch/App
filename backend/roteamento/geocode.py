"""Geocodificação de endereços (Nominatim/OSM) com cache e limite de 1 req/s."""

from __future__ import annotations

import json
import os
import re
import threading
import time
from dataclasses import dataclass

import requests

from .osm_data import CACHE_DIR, USER_AGENT

NOMINATIM_URL = os.environ.get(
    "NOMINATIM_URL", "https://nominatim.openstreetmap.org/search"
)
_LATLON = re.compile(r"^\s*(-?\d+(?:\.\d+)?)\s*[,; ]\s*(-?\d+(?:\.\d+)?)\s*$")
_lock = threading.Lock()
_last = [0.0]


@dataclass
class GeoResult:
    query: str
    lat: float
    lon: float
    label: str
    # False quando o provedor só achou a rua (sem o número): posição aproximada.
    exact: bool


def parse_latlon(text: str) -> tuple[float, float] | None:
    m = _LATLON.match(text)
    if not m:
        return None
    lat, lon = float(m.group(1)), float(m.group(2))
    if -90 <= lat <= 90 and -180 <= lon <= 180:
        return lat, lon
    return None


def _cache_file():
    return CACHE_DIR / "geocode.json"


def _load_cache() -> dict:
    try:
        return json.loads(_cache_file().read_text())
    except Exception:
        return {}


def geocode(query: str, city_hint: str = "Santos, SP, Brasil") -> GeoResult:
    ll = parse_latlon(query)
    if ll:
        return GeoResult(query, ll[0], ll[1], f"{ll[0]:.6f}, {ll[1]:.6f}", True)

    q = query.replace("/SP", ", SP")
    if city_hint and "santos" not in q.lower() and "," not in q:
        q = f"{q}, {city_hint}"
    cache = _load_cache()
    if q in cache:
        return GeoResult(**cache[q])

    with _lock:
        wait = 1.05 - (time.time() - _last[0])
        if wait > 0:
            time.sleep(wait)
        r = requests.get(
            NOMINATIM_URL,
            params={"q": q, "format": "jsonv2", "limit": 1, "addressdetails": 1,
                    "countrycodes": "br"},
            headers={"User-Agent": USER_AGENT}, timeout=30,
        )
        _last[0] = time.time()
    r.raise_for_status()
    results = r.json()
    if not results:
        raise LookupError(f"Endereço não encontrado: {query}")
    best = results[0]
    has_number = bool(re.search(r"\b\d+\b", query.split(",")[1] if "," in query else ""))
    exact = (not has_number) or bool(best.get("address", {}).get("house_number"))
    res = GeoResult(query, float(best["lat"]), float(best["lon"]),
                    best.get("display_name", q), exact)
    cache[q] = res.__dict__
    try:
        _cache_file().parent.mkdir(parents=True, exist_ok=True)
        _cache_file().write_text(json.dumps(cache))
    except OSError:
        pass
    return res
