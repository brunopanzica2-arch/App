"""Exporta a malha de pedestres (mesma do backend) para o app móvel offline.

Formato binário little-endian (santos-graph.bin), versão RSG2 (adequação urbana, 2.3):
  cabeçalho: magic "RSG2", u32 n_nodes, u32 n_edges, u32 n_names
  nós:   i32 lat_e7[n], i32 lon_e7[n], u8 node_flags[n] (bit0 barreira, bit1 privado, bit7 bloqueado)
  arestas: u32 a[m], u32 b[m], f32 length_m[m], u8 flags[m],
           u8 dir[m] (bit0 fwd, bit1 bwd, bit2 contramão fwd, bit3 contramão bwd),
           f32 share[m], u32 name_idx[m],
           u8 hw[m] (classe da via), u8 surf[m] (0 desconhecido, 1 pavimentado, 2 sem pavimento),
           u8 attr[m] (bit0 lit, bit1 calçada/travessia, bit2 foot designado, bit3 dica de trilha, bit4 ponte/túnel, bit5 incline, bit6 nomeada),
           u8 trail[m] (comprimento CONTÍNUO da trilha a que a aresta pertence, em dezenas de metros, máx. 255; 0 = não é trilha)
  nomes: JSON (utf-8) com a lista de nomes de vias, no fim do arquivo.

Uso: python -m scripts.export_mobile_graph ../mobile/public/santos-graph.bin
"""

from __future__ import annotations

import json
import struct
import sys
from pathlib import Path

import numpy as np

from app.core.config import get_settings
from app.services.routing.engines import InternalEngine


TRAIL_HW = {8, 9, 11}  # path, track, bridleway


def trail_runs(net) -> list[int]:
    """Para cada aresta "tipo trilha" (path/track/bridleway, ou footway/cycleway sem pavimento ou com dica de trilha), o comprimento
    da rede contínua de trilhas a que ela pertence (união de arestas que compartilham nós). Um atalho curto entre ruas fica pequeno;
    uma trilha de morro fica grande."""
    m = net.n_edges
    like = np.zeros(m, dtype=bool)
    for e in range(m):
        hw, surf, attr = net.ehw[e], net.esurf[e], net.eattr[e]
        like[e] = hw in TRAIL_HW or (hw in (5, 10) and (surf == 2 or attr & 8))
    parent = {}

    def find(x):
        while parent.setdefault(x, x) != x:
            parent[x] = parent[parent[x]]
            x = parent[x]
        return x

    for e in np.nonzero(like)[0]:
        ra, rb = find(int(net.ea[e])), find(int(net.eb[e]))
        if ra != rb:
            parent[ra] = rb
    total: dict[int, float] = {}
    for e in np.nonzero(like)[0]:
        r = find(int(net.ea[e]))
        total[r] = total.get(r, 0.0) + float(net.elen[e])
    out = [0] * m
    for e in np.nonzero(like)[0]:
        out[e] = max(1, min(255, int(round(total[find(int(net.ea[e]))] / 10.0))))
    return out


def export(net, out: Path) -> dict:
    names: list[str] = []
    idx: dict[str, int] = {}
    name_ids = []
    for nm in net.ename:
        if nm not in idx:
            idx[nm] = len(names)
            names.append(nm)
        name_ids.append(idx[nm])
    n, m = net.n_nodes, net.n_edges
    nflags = np.array(net.node_flags, dtype=np.uint8) | (np.array(net.node_blocked, dtype=np.uint8) << 7)
    d = (np.array(net.efwd, dtype=np.uint8) | (np.array(net.ebwd, dtype=np.uint8) << 1)
         | (np.array(net.ecf_fwd, dtype=np.uint8) << 2) | (np.array(net.ecf_bwd, dtype=np.uint8) << 3))
    names_blob = json.dumps(names, ensure_ascii=False).encode()
    with open(out, "wb") as fh:
        fh.write(b"RSG2")
        fh.write(struct.pack("<III", n, m, len(names)))
        fh.write(np.round(np.array(net.lat) * 1e7).astype("<i4").tobytes())
        fh.write(np.round(np.array(net.lon) * 1e7).astype("<i4").tobytes())
        fh.write(nflags.tobytes())
        fh.write(np.array(net.ea, dtype="<u4").tobytes())
        fh.write(np.array(net.eb, dtype="<u4").tobytes())
        fh.write(np.array(net.elen, dtype="<f4").tobytes())
        fh.write(np.array(net.eflags, dtype=np.uint8).tobytes())
        fh.write(d.astype(np.uint8).tobytes())
        fh.write(np.array(net.eshare, dtype="<f4").tobytes())
        fh.write(np.array(name_ids, dtype="<u4").tobytes())
        fh.write(np.array(net.ehw, dtype=np.uint8).tobytes())
        fh.write(np.array(net.esurf, dtype=np.uint8).tobytes())
        fh.write(np.array(net.eattr, dtype=np.uint8).tobytes())
        fh.write(np.array(trail_runs(net), dtype=np.uint8).tobytes())
        fh.write(names_blob)
    return {"nodes": n, "edges": m, "names": len(names), "bytes": out.stat().st_size}


if __name__ == "__main__":
    out = Path(sys.argv[1] if len(sys.argv) > 1 else "../mobile/public/santos-graph.bin")
    out.parent.mkdir(parents=True, exist_ok=True)
    eng = InternalEngine(get_settings())
    info = export(eng.network(), out)
    import hashlib
    from datetime import date

    meta = {**info, "version": eng.network_version(), "bbox": get_settings().operation_bbox,
            "sha256": hashlib.sha256(out.read_bytes()).hexdigest(), "exported": date.today().isoformat(),
            "source": "OpenStreetMap (ODbL) — malha de pedestres", "osm_extraction": "API 0.6 do OSM (cache local)"}
    out.with_suffix(".json").write_text(json.dumps(meta, ensure_ascii=False, indent=1))
    print(meta)
