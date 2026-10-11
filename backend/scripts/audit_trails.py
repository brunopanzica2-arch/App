"""Auditoria de trilhas/caminhos não urbanos da malha de Santos (2.3).

Lista cada "rede contínua de trilha" (path/track/bridleway, ou footway/cycleway sem pavimento ou com dica de trilha) com: via OSM (id),
tags relevantes, comprimento contínuo, coordenadas e a razão pela qual o app a veda/penaliza. Saída em JSON e Markdown.
Uso: python -m scripts.audit_trails ../docs/evidencias-rotas
"""
from __future__ import annotations

import json
import sys
from collections import defaultdict
from pathlib import Path

from app.core.config import get_settings
from app.services.routing.engines import InternalEngine
from roteamento.osm_data import fetch_osm_api_tiles
from scripts.export_mobile_graph import trail_runs

KEYS = ["highway", "surface", "access", "foot", "bicycle", "name", "lit", "sac_scale", "trail_visibility", "tracktype", "smoothness",
        "incline", "informal", "bridge", "tunnel", "sidewalk", "footway", "tourism", "leisure", "landuse", "natural"]


def main(out_dir: Path) -> None:
    s = get_settings()
    net = InternalEngine(s).network()
    osm = fetch_osm_api_tiles(s.bbox)  # cache local; só leitura das tags
    tr = trail_runs(net)
    ways: dict[int, dict] = {}
    for e, t in enumerate(tr):
        if not t:
            continue
        w = net.eway[e]
        d = ways.setdefault(w, {"osm_way": w, "meters": 0.0, "run_m": 0, "coords": []})
        d["meters"] += float(net.elen[e])
        d["run_m"] = max(d["run_m"], t * 10)
        d["coords"].append([[net.lat[net.ea[e]], net.lon[net.ea[e]]], [net.lat[net.eb[e]], net.lon[net.eb[e]]]])
    rows = []
    for w, d in ways.items():
        tags = osm.ways.get(w, ([], {}))[1]
        d["tags"] = {k: tags[k] for k in KEYS if k in tags}
        d["meters"] = round(d["meters"], 1)
        t = d["tags"]
        private = t.get("access") == "private" or t.get("foot") == "private"
        named_ok = bool(t.get("name")) and not (t.get("sac_scale") or t.get("trail_visibility") or t.get("tracktype")) and t.get("surface") not in (
            "dirt", "ground", "grass", "gravel", "sand", "mud", "earth", "compacted", "unpaved", "fine_gravel")
        if private:
            d["acao"] = "VEDADA: acesso privado (access/foot=private)"
        elif named_ok:
            d["acao"] = "CAUTELA (×2,5): via nomeada mapeada como caminho, não verificada"
        elif d["run_m"] >= 150:
            d["acao"] = "VEDADA no perfil urbano (trilha contínua ≥150 m)"
        else:
            d["acao"] = "PENALIZADA (×6) e marcada como trilha/não verificada"
        d["center"] = d["coords"][len(d["coords"]) // 2][0]
        del d["coords"]
        rows.append(d)
    rows.sort(key=lambda r: -r["run_m"])
    out_dir.mkdir(parents=True, exist_ok=True)
    (out_dir / "trilhas_santos.json").write_text(json.dumps(rows, ensure_ascii=False, indent=1))
    by_cls = defaultdict(int)
    for r in rows:
        by_cls[r["tags"].get("highway", "?")] += 1
    md = ["# Trilhas / caminhos não urbanos na malha de Santos (OSM)", "",
          f"Redes contínuas auditadas: **{len(rows)}** vias OSM. Por classe: {dict(by_cls)}.", "",
          "| Via OSM | classe | piso | acesso | nome | contínuo (m) | ação | centro (lat, lon) |", "|---|---|---|---|---|---|---|---|"]
    for r in rows[:60]:
        t = r["tags"]
        md.append(f"| {r['osm_way']} | {t.get('highway','?')} | {t.get('surface','(não informado)')} | {t.get('access','—')} | {t.get('name','(sem nome)')} | {r['run_m']} | {r['acao']} | {r['center'][0]:.5f}, {r['center'][1]:.5f} |")
    (out_dir / "trilhas_santos.md").write_text("\n".join(md) + "\n")
    print(len(rows), "vias;", sum(1 for r in rows if r["acao"].startswith("VEDADA")), "vedadas")


if __name__ == "__main__":
    main(Path(sys.argv[1] if len(sys.argv) > 1 else "../docs/evidencias-rotas"))
