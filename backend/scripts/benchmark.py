"""Benchmark reproduzível do fluxo (importação -> geocodificação MOCK -> paradas ->
matriz -> OR-Tools -> geometria) com cartas SINTÉTICAS.

Uso:
  python -m scripts.benchmark --sizes 100 300 500 1000 --network real --time-limit 20
  --network synthetic : malha em grade sintética (sem internet)
  --network real      : malha OSM real da área operacional (cache em DATA_DIR)

Para a malha real, as coordenadas dos imóveis são sorteadas sobre nós reais da
malha (simulando endereços já confirmados) — o geocodificador NÃO é exercitado
nesse modo. Resultados são gravados em ../docs/benchmarks.md (anexa).
"""

from __future__ import annotations

import argparse
import os
import platform
import random
import subprocess
import time
import uuid
from datetime import date, datetime, timezone

from sqlalchemy import select

from app.core.config import get_settings
from app.core.db import SessionLocal
from app.models import Address, Organization
from app.services import importer
from app.services.consolidation import consolidate
from app.services.geocoding.providers import MockProvider
from app.services.geocoding.service import geocode_batch, point
from app.services.planner import PlanParams, plan
from app.services.routing.engines import InternalEngine
from roteamento.config import TravelProfile


def hw() -> str:
    cpu = "?"
    try:
        cpu = next(l.split(":", 1)[1].strip() for l in open("/proc/cpuinfo") if l.startswith("model name"))
    except Exception:
        pass
    mem = "?"
    try:
        mem = f"{int(next(l.split()[1] for l in open('/proc/meminfo') if l.startswith('MemTotal'))) / 1e6:.1f} GB"
    except Exception:
        pass
    return f"{platform.platform()} · CPU {cpu} · {os.cpu_count()} vCPU · RAM {mem} · Python {platform.python_version()}"


def run(size: int, network: str, time_limit: int, letters_per_property: float = 2.0) -> dict:
    s = get_settings()
    db = SessionLocal()
    org = Organization(name=f"bench-{uuid.uuid4().hex[:6]}", settings={})
    db.add(org)
    db.commit()
    rng = random.Random(size)
    n_props = max(1, int(size / letters_per_property))
    if network == "synthetic":
        import sys
        sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
        from roteamento.network import build_network
        from tests.synthetic import grid_osm
        engine = InternalEngine(s, network=build_network(grid_osm()))
    else:
        engine = InternalEngine(s)
    net = engine.network()

    lines = ["identificador;logradouro;numero;bairro"]
    props = [(f"Rua Benchmark {i % 40}", str(10 + (i // 40) * 7 + rng.randint(0, 5) * 2)) for i in range(n_props)]
    for k in range(size):
        st, num = props[k % n_props] if k < n_props else rng.choice(props)
        lines.append(f"B{size}-{k:05d};{st};{num};Bairro {hash(st) % 7}")
    t = {}
    t0 = time.perf_counter()
    table = importer.parse_delimited("\n".join(lines))
    batch = importer.commit_import(db, org.id, None, table, importer.suggest_mapping(table.headers), "csv",
                                   f"bench {size}", date.today(), None, {}, allow_same_file=True)
    db.commit()
    t["import_ms"] = int((time.perf_counter() - t0) * 1000)

    t0 = time.perf_counter()
    stats = geocode_batch(db, s, MockProvider(), org.id, batch.id)
    t["geocode_mock_ms"] = int((time.perf_counter() - t0) * 1000)
    if network == "real":
        # coordenadas sobre nós reais da malha (endereços "já confirmados")
        idx = rng.sample(range(net.n_nodes), k=min(net.n_nodes, stats["addresses"]))
        for a, i in zip(db.scalars(select(Address).where(Address.org_id == org.id)), idx):
            a.lat, a.lon = net.lat[i], net.lon[i]
            a.geom = point(a.lat, a.lon)
            a.precision, a.source = "manual", "benchmark-sintetico"
        db.commit()
    t0 = time.perf_counter()
    cons = consolidate(db, org.id, batch.id)
    db.commit()
    t["consolidate_ms"] = int((time.perf_counter() - t0) * 1000)

    # real: centro da Rua Joaquim Távora retornado pelo Nominatim (aproximado; só para benchmark)
    lat0, lon0 = (-23.9480025, -46.3406209) if network == "real" else (-23.9755, -46.3455)
    params = PlanParams(start_lat=lat0, start_lon=lon0, start_label="benchmark", time_limit_s=time_limit,
                        profile=TravelProfile(ride_speed_kmh=15))
    t0 = time.perf_counter()
    route = plan(db, s, engine, org.id, batch.id, params)
    db.commit()
    t["plan_total_ms"] = int((time.perf_counter() - t0) * 1000)
    t.update({k: v for k, v in route.metrics["timings_ms"].items()})
    res = {
        "letters": size, "stops": cons["stops"], "network": network, "nodes": net.n_nodes, "edges": net.n_edges,
        "distance_km": round(route.total_distance_m / 1000, 2), "time_h": round(route.total_time_s / 3600, 2),
        "excluded": len(route.metrics["excluded_stops"]), "strategy": route.metrics["chosen_strategy"],
        "candidates": route.candidates, **t,
    }
    db.close()
    return res


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--sizes", nargs="+", type=int, default=[100, 300, 500, 1000])
    ap.add_argument("--network", choices=["synthetic", "real"], default="synthetic")
    ap.add_argument("--time-limit", type=int, default=20)
    ap.add_argument("--out", default=os.path.join(os.path.dirname(__file__), "..", "..", "docs", "benchmarks.md"))
    a = ap.parse_args()
    rows = [run(n, a.network, a.time_limit) for n in a.sizes]
    commit = subprocess.run(["git", "rev-parse", "--short", "HEAD"], capture_output=True, text=True).stdout.strip()
    out = [f"\n## Execução {datetime.now(timezone.utc).isoformat(timespec='seconds')} (commit {commit})\n",
           f"- Hardware: {hw()}", f"- Malha: {a.network} ({rows[0]['nodes']} nós, {rows[0]['edges']} trechos)",
           f"- Limite do solver: {a.time_limit} s · geocodificação: MOCK (sintética) · cartas sintéticas\n",
           "| Cartas | Paradas | Excluídas | Import (ms) | Geocod. mock (ms) | Consolid. (ms) | Matriz (ms) | Solver (ms) | Geometria (ms) | Distância (km) | Tempo est. (h) | Melhor estratégia |",
           "|---|---|---|---|---|---|---|---|---|---|---|---|"]
    for r in rows:
        out.append(f"| {r['letters']} | {r['stops']} | {r['excluded']} | {r['import_ms']} | {r['geocode_mock_ms']} | {r['consolidate_ms']} | "
                   f"{r['matrix_ms']} | {r['solve_ms']} | {r['geometry_ms']} | {r['distance_km']} | {r['time_h']} | {r['strategy']} |")
    out.append("\nComparação de candidatos (tempo estimado em h / distância km):\n")
    for r in rows:
        cs = ", ".join(f"{c['strategy']}: {c['time_s'] / 3600:.2f} h / {c['distance_m'] / 1000:.1f} km" for c in r["candidates"])
        out.append(f"- {r['letters']} cartas: {cs}")
    text = "\n".join(out) + "\n"
    print(text)
    os.makedirs(os.path.dirname(a.out), exist_ok=True)
    with open(a.out, "a", encoding="utf-8") as fh:
        fh.write(text)


if __name__ == "__main__":
    main()
