"""Exporta a malha de pedestres (mesma do backend) para o app móvel offline.

Formato binário little-endian (santos-graph.bin):
  cabeçalho: magic "RSG1", u32 n_nodes, u32 n_edges, u32 n_names
  nós:   i32 lat_e7[n], i32 lon_e7[n], u8 node_flags[n] (bit0 barreira, bit1 privado, bit7 bloqueado)
  arestas: u32 a[m], u32 b[m], f32 length_m[m], u8 flags[m],
           u8 dir[m] (bit0 fwd, bit1 bwd, bit2 contramão fwd, bit3 contramão bwd),
           f32 share[m], u32 name_idx[m]
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
        fh.write(b"RSG1")
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
        fh.write(names_blob)
    return {"nodes": n, "edges": m, "names": len(names), "bytes": out.stat().st_size}


if __name__ == "__main__":
    out = Path(sys.argv[1] if len(sys.argv) > 1 else "../mobile/public/santos-graph.bin")
    out.parent.mkdir(parents=True, exist_ok=True)
    eng = InternalEngine(get_settings())
    info = export(eng.network(), out)
    meta = {**info, "version": eng.network_version(), "bbox": get_settings().operation_bbox,
            "source": "OpenStreetMap (ODbL) — malha de pedestres"}
    out.with_suffix(".json").write_text(json.dumps(meta, ensure_ascii=False, indent=1))
    print(meta)
