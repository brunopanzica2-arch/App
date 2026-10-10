"""Benchmarks V2 (seção 10 da auditoria) — malha OSM REAL de Santos, posições TESTE em nós OSM
dentro de Centro/Paquetá/Vila Nova (polígonos OSM). Cartas fictícias; NÃO são portas reais.

Cenários (pontos salvos em test-data/benchmarks/<nome>.json para o app rodar os mesmos):
  c300_150   300 cartas / 150 paradas (fixture oficial)
  c300_300   300 cartas / 300 paradas (pior caso: 1 carta por imóvel)
  c500_250   500 cartas / 250 paradas
  c1000_500  1000 cartas / 500 paradas
  meia_rua   metade das cartas numa só via (muitos números) + metade espalhada
  meio_predio metade das cartas num só prédio + 150 em vias próximas
  desconexo  140 paradas na malha + 10 em trechos não alcançáveis da origem
  vizinhos   pares de imóveis a 0–20 m (mesmo trecho) e em ruas opostas
Uso: cd backend && python -m scripts.benchmark_v2 --time-limit 15
"""

from __future__ import annotations

import argparse
import csv
import json
import os
import platform
import random
import resource
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "test-data"))

from app.core.config import get_settings  # noqa: E402
from app.services.optimization import evaluate, feasibility, solve, validate  # noqa: E402
from app.services.routing.engines import InternalEngine  # noqa: E402
from roteamento.config import TravelProfile  # noqa: E402

TD = ROOT / "test-data"
BD = TD / "benchmarks"
ORIGIN = (-23.9480025, -46.3406209)


def polys():
    from gerar_casos import polygons, inside  # type: ignore

    return polygons(), inside


def build_scenarios(net, router):
    P, inside = polys()
    rng = random.Random(42)
    reach = router.snap_origin(*ORIGIN, 150)[1]
    in_area = [v for v in range(net.n_nodes) if reach[v] and any(inside(p, net.lat[v], net.lon[v]) for p in P.values())]
    unreachable = [v for v in range(net.n_nodes) if not reach[v] and any(inside(p, net.lat[v], net.lon[v]) for p in P.values())]
    nb_of = {}
    for v in in_area:
        for name, p in P.items():
            if inside(p, net.lat[v], net.lon[v]):
                nb_of[v] = name
                break
    pt = lambda v: [round(net.lat[v], 7), round(net.lon[v], 7)]  # noqa: E731
    sc = {}
    pos = list(csv.DictReader((TD / "posicoes_teste_osm.csv").read_text(encoding="utf-8-sig").splitlines(), delimiter=";"))
    letters = list(csv.DictReader((TD / "cenario_300_cartas_centro_paqueta_vila_nova.csv").read_text(encoding="utf-8-sig").splitlines(), delimiter=";"))
    from collections import Counter

    cnt = Counter((r["logradouro"], r["numero"]) for r in letters)
    sc["c300_150"] = [{"p": [float(p["lat"]), float(p["lon"])], "cartas": cnt[(p["logradouro"], p["numero"])], "bairro": p["bairro"]} for p in pos]
    for name, n_stops, n_letters in (("c300_300", 300, 300), ("c500_250", 250, 500), ("c1000_500", 500, 1000)):
        vs = rng.sample(in_area, n_stops)
        per = [n_letters // n_stops] * n_stops
        for i in range(n_letters - sum(per)):
            per[i] += 1
        sc[name] = [{"p": pt(v), "cartas": c, "bairro": nb_of[v]} for v, c in zip(vs, per)]
    # metade numa só via: nós da Avenida Conselheiro Nébias dentro da área
    neb = sorted({v for e in range(net.n_edges) if net.ename[e] == "Avenida Conselheiro Nébias"
                  for v in (net.ea[e], net.eb[e]) if v in nb_of})
    street = rng.sample(neb, min(75, len(neb)))
    others = rng.sample([v for v in in_area if v not in set(neb)], 75)
    sc["meia_rua"] = [{"p": pt(v), "cartas": 2, "bairro": nb_of[v]} for v in street + others]
    # metade num só prédio (150 cartas) + 150 em vias próximas (raio ~600 m)
    b = in_area[len(in_area) // 2]
    near = sorted(in_area, key=lambda v: (net.lat[v] - net.lat[b]) ** 2 + (net.lon[v] - net.lon[b]) ** 2)[1:400]
    sc["meio_predio"] = [{"p": pt(b), "cartas": 150, "bairro": nb_of[b]}] + \
        [{"p": pt(v), "cartas": 2, "bairro": nb_of[v]} for v in rng.sample(near, 75)]
    # parcialmente desconexo
    sc["desconexo"] = [{"p": pt(v), "cartas": 2, "bairro": nb_of[v]} for v in rng.sample(in_area, 140)] + \
        [{"p": pt(v), "cartas": 1, "bairro": "?", "isolado": True} for v in rng.sample(unreachable, min(10, len(unreachable)))]
    # vizinhos muito próximos: pontos a 5–20 m no mesmo trecho e em ruas paralelas
    viz = []
    for e in rng.sample([e for e in range(net.n_edges) if net.elen[e] > 40 and net.ea[e] in nb_of], 60):
        a, bb = net.ea[e], net.eb[e]
        for t in (0.3, 0.3 + rng.uniform(5, 20) / net.elen[e]):
            viz.append({"p": [net.lat[a] + t * (net.lat[bb] - net.lat[a]), net.lon[a] + t * (net.lon[bb] - net.lon[a])],
                        "cartas": 2, "bairro": nb_of[a]})
    sc["vizinhos"] = viz
    return sc, {"area_nodes": len(in_area), "unreachable_in_area": len(unreachable)}


def run(name, stops, eng, prof, limit):
    pts = [list(ORIGIN)] + [s["p"] for s in stops]
    rss0 = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
    t0 = time.perf_counter()
    sess = eng.matrix([tuple(p) for p in pts], prof, 150)
    t_m = time.perf_counter() - t0
    ok = [i for i in range(1, len(pts)) if sess.snaps[i].ok]
    f = feasibility(sess.time_s, 0, ok, None)
    svc = {i: 45 + 10 * max(stops[i - 1]["cartas"] - 1, 0) + 2 * sess.snaps[i].distance_m / prof.walk_mps() for i in f.kept}
    t0 = time.perf_counter()
    res = solve(sess.time_s, sess.dist_m, 0, f.kept, None, svc, time_limit_s=limit, comp_rank=f.comp_rank)
    t_s = time.perf_counter() - t0
    assert validate(res.order, sess.time_s, 0, f.kept, None) == []
    t0 = time.perf_counter()
    seq = [0, *res.order]
    dist = sum(sess.leg(a, b).distance_m for a, b in zip(seq, seq[1:]))
    t_g = time.perf_counter() - t0
    tt, dd = evaluate(res.order, sess.time_s, sess.dist_m, 0, None, svc)
    nn = next(c for c in res.candidates if c.strategy == "nearest_neighbor_baseline")
    return {
        "cenario": name, "paradas": len(stops), "cartas": sum(s["cartas"] for s in stops),
        "roteadas": len(res.order), "excluidas_snap": len(stops) - len(ok), "excluidas_factib": len(f.excluded),
        "status": "PARCIAL" if len(res.order) < len(stops) else "completa",
        "matriz_ms": int(t_m * 1000), "solver_ms": int(t_s * 1000), "geometria_ms": int(t_g * 1000),
        "km": round(dd / 1000, 2), "geom_km": round(dist / 1000, 2), "tempo_total_h": round(tt / 3600, 2),
        "ganho_vs_vizinho_mais_proximo_pct": round(100 * (nn.time_s - tt) / nn.time_s, 1),
        "rss_pico_mb": round(max(rss0, resource.getrusage(resource.RUSAGE_SELF).ru_maxrss) / 1024, 1),
        "estrategia": res.best.strategy,
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--time-limit", type=int, default=15)
    ap.add_argument("--only", nargs="*")
    ap.add_argument("--tag", default="", help="sufixo do arquivo de saída (ex.: v3 -> resultados_backend_v3.json); vazio = V2")
    a = ap.parse_args()
    eng = InternalEngine(get_settings())
    prof = TravelProfile(ride_speed_kmh=15)
    t0 = time.perf_counter()
    net = eng.network()
    t_load = time.perf_counter() - t0
    router = eng.router(prof)
    sc, area = build_scenarios(net, router)
    BD.mkdir(parents=True, exist_ok=True)
    for name, stops in sc.items():
        (BD / f"{name}.json").write_text(json.dumps({"origin": ORIGIN, "stops": stops}))
    rows = [run(n, s, eng, prof, a.time_limit) for n, s in sc.items() if not a.only or n in a.only]
    cpu = next((l.split(":", 1)[1].strip() for l in open("/proc/cpuinfo") if l.startswith("model name")), "?")
    meta = {"data": datetime.now(timezone.utc).isoformat(timespec="seconds"),
            "commit": subprocess.run(["git", "rev-parse", "--short", "HEAD"], capture_output=True, text=True).stdout.strip(),
            "hardware": f"{platform.platform()} · {cpu} · {os.cpu_count()} vCPU", "python": platform.python_version(),
            "malha": {"nos": net.n_nodes, "arestas": net.n_edges, "carga_s": round(t_load, 2), **area},
            "limite_solver_s": a.time_limit, "implementacao": "backend (Python + scipy + OR-Tools)"}
    (BD / f"resultados_backend{'_' + a.tag if a.tag else ''}.json").write_text(json.dumps({"meta": meta, "linhas": rows}, ensure_ascii=False, indent=1))
    for r in rows:
        print(r)


if __name__ == "__main__":
    main()
