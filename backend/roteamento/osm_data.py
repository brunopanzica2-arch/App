"""Download e leitura de dados reais do OpenStreetMap.

Fonte principal: Overpass API (uma consulta por bbox). Alternativa: API 0.6
do OSM em blocos pequenos (usada quando nenhum servidor Overpass responde).
As respostas são guardadas em cache no disco.
"""

from __future__ import annotations

import hashlib
import json
import math
import os
import time
import xml.etree.ElementTree as ET
from dataclasses import dataclass, field
from pathlib import Path

import requests

USER_AGENT = os.environ.get(
    "ROTEAMENTO_USER_AGENT", "roteamento-entregas/1.0 (pedestrian-routing)"
)
OVERPASS_ENDPOINTS = [
    u.strip()
    for u in os.environ.get(
        "OVERPASS_ENDPOINTS",
        "https://overpass-api.de/api/interpreter,"
        "https://overpass.kumi.systems/api/interpreter,"
        "https://overpass.private.coffee/api/interpreter",
    ).split(",")
    if u.strip()
]
OSM_API_MAP = os.environ.get("OSM_API_MAP", "https://api.openstreetmap.org/api/0.6/map")
CACHE_DIR = Path(os.environ.get("ROTEAMENTO_CACHE", Path.home() / ".cache" / "roteamento"))
# Tamanho (graus) dos blocos usados na API 0.6 (limite de 50 mil nós por pedido).
TILE_DEG = 0.01


@dataclass
class OsmData:
    nodes: dict[int, tuple[float, float]] = field(default_factory=dict)  # id -> (lat, lon)
    node_tags: dict[int, dict[str, str]] = field(default_factory=dict)
    ways: dict[int, tuple[list[int], dict[str, str]]] = field(default_factory=dict)

    def merge(self, other: "OsmData") -> None:
        self.nodes.update(other.nodes)
        self.node_tags.update(other.node_tags)
        self.ways.update(other.ways)


BBox = tuple[float, float, float, float]  # (south, west, north, east)


def bbox_around(points: list[tuple[float, float]], margin_m: float) -> BBox:
    lats = [p[0] for p in points]
    lons = [p[1] for p in points]
    dlat = margin_m / 111_320.0
    mid = math.radians(sum(lats) / len(lats))
    dlon = margin_m / (111_320.0 * max(math.cos(mid), 0.01))
    return (min(lats) - dlat, min(lons) - dlon, max(lats) + dlat, max(lons) + dlon)


# ---------------------------------------------------------------- parsing


def parse_overpass_json(payload: dict) -> OsmData:
    data = OsmData()
    for el in payload.get("elements", []):
        if el["type"] == "node":
            data.nodes[el["id"]] = (el["lat"], el["lon"])
            if el.get("tags"):
                data.node_tags[el["id"]] = el["tags"]
        elif el["type"] == "way":
            tags = el.get("tags", {})
            if "highway" in tags:
                data.ways[el["id"]] = (list(el.get("nodes", [])), tags)
    return data


def parse_osm_xml(text: str | bytes) -> OsmData:
    data = OsmData()
    root = ET.fromstring(text)
    for el in root:
        if el.tag == "node":
            nid = int(el.get("id"))
            data.nodes[nid] = (float(el.get("lat")), float(el.get("lon")))
            tags = {t.get("k"): t.get("v") for t in el.findall("tag")}
            if tags:
                data.node_tags[nid] = tags
        elif el.tag == "way":
            tags = {t.get("k"): t.get("v") for t in el.findall("tag")}
            if "highway" in tags:
                refs = [int(nd.get("ref")) for nd in el.findall("nd")]
                data.ways[int(el.get("id"))] = (refs, tags)
    return data


# ---------------------------------------------------------------- download


def _cache_path(kind: str, key: str) -> Path:
    h = hashlib.sha1(key.encode()).hexdigest()[:16]
    return CACHE_DIR / kind / f"{h}.json"


def _overpass_query(bbox: BBox) -> str:
    s, w, n, e = bbox
    return (
        f"[out:json][timeout:120];"
        f'way["highway"]({s:.6f},{w:.6f},{n:.6f},{e:.6f});'
        f"(._;>;);out body;"
    )


def fetch_overpass(bbox: BBox, timeout: float = 150) -> OsmData:
    query = _overpass_query(bbox)
    last_err: Exception | None = None
    for url in OVERPASS_ENDPOINTS:
        try:
            r = requests.post(
                url, data={"data": query}, timeout=timeout,
                headers={"User-Agent": USER_AGENT},
            )
            r.raise_for_status()
            return parse_overpass_json(r.json())
        except Exception as exc:  # tenta o próximo servidor
            last_err = exc
    raise RuntimeError(f"Nenhum servidor Overpass respondeu: {last_err}")


def fetch_osm_api_tiles(bbox: BBox, timeout: float = 60) -> OsmData:
    s, w, n, e = bbox
    data = OsmData()
    i0, i1 = math.floor(s / TILE_DEG), math.floor(n / TILE_DEG)
    j0, j1 = math.floor(w / TILE_DEG), math.floor(e / TILE_DEG)
    for i in range(i0, i1 + 1):
        for j in range(j0, j1 + 1):
            tb = (i * TILE_DEG, j * TILE_DEG, (i + 1) * TILE_DEG, (j + 1) * TILE_DEG)
            key = f"{tb[0]:.4f},{tb[1]:.4f}"
            path = _cache_path("osmapi", key)
            if path.exists():
                tile = _load_cached(path)
            else:
                r = requests.get(
                    OSM_API_MAP,
                    params={"bbox": f"{tb[1]:.6f},{tb[0]:.6f},{tb[3]:.6f},{tb[2]:.6f}"},
                    timeout=timeout, headers={"User-Agent": USER_AGENT},
                )
                r.raise_for_status()
                tile = parse_osm_xml(r.content)
                _save_cached(path, tile)
                time.sleep(0.5)  # respeita o servidor
            data.merge(tile)
    return data


def _save_cached(path: Path, data: OsmData) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    payload = {
        "nodes": {str(k): v for k, v in data.nodes.items()},
        "node_tags": {str(k): v for k, v in data.node_tags.items()},
        "ways": {str(k): [refs, tags] for k, (refs, tags) in data.ways.items()},
    }
    path.write_text(json.dumps(payload))


def _load_cached(path: Path) -> OsmData:
    payload = json.loads(path.read_text())
    return OsmData(
        nodes={int(k): tuple(v) for k, v in payload["nodes"].items()},
        node_tags={int(k): v for k, v in payload["node_tags"].items()},
        ways={int(k): (v[0], v[1]) for k, v in payload["ways"].items()},
    )


def load_osm(bbox: BBox) -> OsmData:
    """Baixa (ou lê do cache) a malha viária real dentro do bbox."""
    key = ",".join(f"{x:.4f}" for x in bbox)
    path = _cache_path("overpass", key)
    if path.exists():
        return _load_cached(path)
    try:
        data = fetch_overpass(bbox)
        _save_cached(path, data)
        return data
    except RuntimeError:
        return fetch_osm_api_tiles(bbox)


def load_osm_file(path: str, bbox: BBox | None = None) -> OsmData:
    """Lê .osm.pbf/.osm (pyosmium) ou JSON no formato Overpass.

    Para produção, recomenda-se um recorte (osmium extract) da região de Santos
    a partir do extrato da Geofabrik, atualizado periodicamente.
    """
    if path.endswith(".json"):
        with open(path, encoding="utf-8") as fh:
            data = parse_overpass_json(json.load(fh))
    else:
        import osmium  # dependência opcional

        data = OsmData()
        node_ids: set[int] = set()
        for obj in osmium.FileProcessor(path, osmium.osm.WAY):
            tags = dict(obj.tags)
            if "highway" in tags:
                refs = [n.ref for n in obj.nodes]
                data.ways[obj.id] = (refs, tags)
                node_ids.update(refs)
        for obj in osmium.FileProcessor(path, osmium.osm.NODE):
            if obj.id in node_ids:
                data.nodes[obj.id] = (obj.location.lat, obj.location.lon)
                if len(obj.tags):
                    data.node_tags[obj.id] = dict(obj.tags)
    if bbox:
        s, w, n, e = bbox
        keep = {k for k, (la, lo) in data.nodes.items() if s <= la <= n and w <= lo <= e}
        data.ways = {k: v for k, v in data.ways.items() if any(r in keep for r in v[0])}
        used = {r for refs, _ in data.ways.values() for r in refs}
        data.nodes = {k: v for k, v in data.nodes.items() if k in used}
        data.node_tags = {k: v for k, v in data.node_tags.items() if k in used}
    return data
