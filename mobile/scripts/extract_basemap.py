"""Extrai o mapa-base OFFLINE de Santos (PMTiles) de uma compilação diária do Protomaps (dados © OpenStreetMap, ODbL).

Lê só os tiles necessários da compilação remota por requisições HTTP Range (sem baixar o planeta, ~120 GB) e grava
`public/map/santos.pmtiles` + `public/map/santos.pmtiles.json` (fonte, data, recorte, hash, tamanho, licença).

Uso:  python scripts/extract_basemap.py [--date AAAAMMDD] [--maxzoom 15] [--bbox minlon,minlat,maxlon,maxlat]
Requer: pip install pmtiles
Termos: dados OSM (ODbL) exigem atribuição "© OpenStreetMap contributors" (já no estilo). O servidor build.protomaps.com
é para desenvolvimento: este script baixa UMA vez; o app NÃO consulta o servidor.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import math
import sys
import urllib.request
from datetime import date, timedelta
from pathlib import Path

from pmtiles.reader import Reader
from pmtiles.tile import Compression, TileType, deserialize_header, zxy_to_tileid
from pmtiles.writer import write

OUT = Path(__file__).resolve().parents[1] / "public" / "map"
DEFAULT_BBOX = (-46.415, -24.005, -46.295, -23.915)  # = recorte da malha de pedestres embutida


def tile_xy(lon: float, lat: float, z: int) -> tuple[int, int]:
    n = 2**z
    x = int((lon + 180) / 360 * n)
    y = int((1 - math.asinh(math.tan(math.radians(lat))) / math.pi) / 2 * n)
    return min(max(x, 0), n - 1), min(max(y, 0), n - 1)


def remote(url: str):
    cache: dict[tuple[int, int], bytes] = {}
    calls = [0]

    def get_bytes(offset: int, length: int) -> bytes:
        k = (offset, length)
        if k not in cache:
            req = urllib.request.Request(url, headers={"Range": f"bytes={offset}-{offset + length - 1}",
                                                       "User-Agent": "RotaSantos-basemap-extract/1.0"})
            with urllib.request.urlopen(req, timeout=60) as r:
                cache[k] = r.read()
            calls[0] += 1
        return cache[k]

    return get_bytes, calls


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--date")
    ap.add_argument("--maxzoom", type=int, default=15)
    ap.add_argument("--bbox", default=",".join(map(str, DEFAULT_BBOX)))
    a = ap.parse_args()
    minlon, minlat, maxlon, maxlat = map(float, a.bbox.split(","))
    d = date.fromisoformat(a.date[:4] + "-" + a.date[4:6] + "-" + a.date[6:]) if a.date else date.today()
    src = None
    for back in range(0, 6):  # compilação do dia pode ainda não existir
        day = (d - timedelta(days=back)).strftime("%Y%m%d")
        url = f"https://build.protomaps.com/{day}.pmtiles"
        try:
            gb, calls = remote(url)
            h = deserialize_header(gb(0, 127))
            src = (day, url, gb, calls, h)
            break
        except Exception as exc:  # noqa: BLE001
            print(f"{day}: indisponível ({exc})", file=sys.stderr)
    if not src:
        print("Nenhuma compilação do Protomaps acessível.", file=sys.stderr)
        return 1
    day, url, gb, calls, h = src
    assert h["tile_type"] == TileType.MVT and h["tile_compression"] == Compression.GZIP
    r = Reader(gb)
    meta = r.metadata()
    n = 0
    OUT.mkdir(parents=True, exist_ok=True)
    target = OUT / "santos.pmtiles"
    with write(str(target)) as w:
        tiles = []
        for z in range(0, a.maxzoom + 1):
            x0, y1 = tile_xy(minlon, minlat, z)
            x1, y0 = tile_xy(maxlon, maxlat, z)
            for x in range(x0, x1 + 1):
                for y in range(y0, y1 + 1):
                    tiles.append((zxy_to_tileid(z, x, y), z, x, y))
        for tid, z, x, y in sorted(tiles):
            data = r.get(z, x, y)
            if data:
                w.write_tile(tid, data)
                n += 1
        header = {
            "version": 3, "tile_type": TileType.MVT, "tile_compression": Compression.GZIP,
            "min_lon_e7": int(minlon * 1e7), "min_lat_e7": int(minlat * 1e7),
            "max_lon_e7": int(maxlon * 1e7), "max_lat_e7": int(maxlat * 1e7),
            "center_zoom": 13, "center_lon_e7": int((minlon + maxlon) / 2 * 1e7), "center_lat_e7": int((minlat + maxlat) / 2 * 1e7),
        }
        meta["rota_santos"] = {"extracted_from": url, "build_date": day, "bbox": [minlon, minlat, maxlon, maxlat], "maxzoom": a.maxzoom}
        w.finalize(header, meta)
    blob = target.read_bytes()
    info = {
        "arquivo": "santos.pmtiles", "bytes": len(blob), "sha256": hashlib.sha256(blob).hexdigest(), "tiles": n,
        "fonte": url, "compilacao": day, "recorte_bbox": [minlon, minlat, maxlon, maxlat], "zoom_max": a.maxzoom,
        "extraido_em": date.today().isoformat(), "requisicoes_http": calls[0],
        "atribuicao": "© OpenStreetMap contributors (ODbL) · compilação Protomaps",
        "licenca": "ODbL 1.0 (dados OSM). Esquema/estilo: Protomaps basemaps (BSD-3-Clause).",
        "atualizacao": "Rode este script de novo (a malha de ruas muda pouco); compare o sha256 e publique nova versão do app.",
    }
    (OUT / "santos.pmtiles.json").write_text(json.dumps(info, ensure_ascii=False, indent=1))
    print(json.dumps(info, ensure_ascii=False, indent=1))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
