"""Cenário B: rota REAL na malha OSM de pedestres — origem + 150 POSIÇÕES TESTE em
Centro, Paquetá e Vila Nova (test-data/posicoes_teste_osm.csv).

As posições são nós OSM sobre as vias; NÃO são as portas dos números do CSV.
A origem é um PONTO TESTE: o centro da Rua Joaquim Távora devolvido pelo Nominatim
(o nº 480 não foi localizado pelo provedor e não foi validado em campo).

Saídas em test-data/resultados/:
  rota_150_<modo>.geojson   linhas do percurso + 150 pontos numerados (rotulados TESTE)
  itinerario_150_<modo>.csv sequência, chave, bairro, cartas, ETA, trechos, snap
  resumo_150.json           métricas, candidatos, tempos de cálculo
  paridade_150.json         pontos + matriz do backend para comparar com o app (TS)
Uso: cd backend && python -m scripts.cenario_150_real --time-limit 30
"""

from __future__ import annotations

import argparse
import csv
import json
import time
from collections import Counter, defaultdict
from pathlib import Path

import numpy as np

from app.core.config import get_settings
from app.services.optimization import evaluate, feasibility, solve, validate
from app.services.routing.engines import InternalEngine
from roteamento.config import TravelProfile

ROOT = Path(__file__).resolve().parents[2]
TD = ROOT / "test-data"
OUT = TD / "resultados"
ORIGIN = (-23.9480025, -46.3406209)
ORIGIN_LABEL = ("PONTO TESTE — centro da Rua Joaquim Távora retornado pelo Nominatim; "
                "nº 480 NÃO localizado pelo provedor nem validado em campo")
SERVICE_BASE_S, PER_LETTER_S = 45.0, 10.0


def load():
    pos = list(csv.DictReader((TD / "posicoes_teste_osm.csv").read_text(encoding="utf-8-sig").splitlines(), delimiter=";"))
    letters = list(csv.DictReader((TD / "cenario_300_cartas_centro_paqueta_vila_nova.csv").read_text(encoding="utf-8-sig").splitlines(), delimiter=";"))
    per_key = Counter((r["logradouro"], r["numero"]) for r in letters)
    for p in pos:
        p["cartas"] = per_key[(p["logradouro"], p["numero"])]
    return pos, letters


def run(mode: str, time_limit: int, eng: InternalEngine, pos, prof: TravelProfile):
    pts = [ORIGIN] + [(float(p["lat"]), float(p["lon"])) for p in pos]
    t0 = time.perf_counter()
    sess = eng.matrix(pts, prof, 150)
    t_matrix = time.perf_counter() - t0
    T, D = sess.time_s, sess.dist_m
    ok = [i for i in range(1, len(pts)) if sess.snaps[i].ok]
    snap_fail = {i: sess.snaps[i].error for i in range(1, len(pts)) if not sess.snaps[i].ok}
    end = 0 if mode == "circular" else None
    f = feasibility(T, 0, ok, end)
    walk = prof.walk_mps()
    svc = {i: SERVICE_BASE_S + PER_LETTER_S * max(pos[i - 1]["cartas"] - 1, 0) + 2 * sess.snaps[i].distance_m / walk
           for i in f.kept}
    nb = {i: pos[i - 1]["bairro"] for i in f.kept}
    base_import = sorted(f.kept, key=lambda i: int(pos[i - 1]["chave"][1:]))
    baselines = {"ordem_importada": base_import,
                 "alfabetica": sorted(f.kept, key=lambda i: (pos[i - 1]["logradouro"], int(pos[i - 1]["numero"]))),
                 "bairro_agrupado": sorted(f.kept, key=lambda i: (nb[i], pos[i - 1]["logradouro"], int(pos[i - 1]["numero"])))}
    t0 = time.perf_counter()
    res = solve(T, D, 0, f.kept, end, svc, time_limit_s=time_limit, baselines=baselines, comp_rank=f.comp_rank)
    t_solve = time.perf_counter() - t0
    assert validate(res.order, T, 0, f.kept, end) == []
    seq = [0, *res.order] + ([0] if end == 0 else [])
    t0 = time.perf_counter()
    feats, rows, clock, travel, dist = [], [], 0.0, 0.0, 0.0
    by_nb = defaultdict(lambda: {"paradas": 0, "cartas": 0})
    for k, (a, b) in enumerate(zip(seq, seq[1:]), start=1):
        leg = sess.leg(a, b)
        for ft in leg.features:
            ft["properties"]["leg"] = k
            feats.append(ft)
        clock += leg.time_s
        travel += leg.time_s
        dist += leg.distance_m
        if b != 0:
            p = pos[b - 1]
            sn = sess.snaps[b]
            rows.append({"seq": len(rows) + 1, "chave": p["chave"], "bairro": p["bairro"], "logradouro": p["logradouro"],
                         "numero_sintetico": p["numero"], "cartas": p["cartas"], "eta_min": round(clock / 60, 1),
                         "trecho_m": round(leg.distance_m, 1), "trecho_s": round(leg.time_s, 1),
                         "snap_m": round(sn.distance_m, 1), "confianca": sn.confidence, "flags": "|".join(sn.flags),
                         "lat_teste": p["lat"], "lon_teste": p["lon"]})
            feats.append({"type": "Feature", "geometry": {"type": "Point", "coordinates": [float(p["lon"]), float(p["lat"])]},
                          "properties": {"kind": "stop", "seq": len(rows), "chave": p["chave"], "bairro": p["bairro"],
                                         "aviso": "POSIÇÃO TESTE — não é a porta"}})
            by_nb[p["bairro"]]["paradas"] += 1
            by_nb[p["bairro"]]["cartas"] += p["cartas"]
            clock += svc[b]
    t_geom = time.perf_counter() - t0
    feats.append({"type": "Feature", "geometry": {"type": "Point", "coordinates": [ORIGIN[1], ORIGIN[0]]},
                  "properties": {"kind": "origin", "label": ORIGIN_LABEL}})
    t_eval, d_eval = evaluate(res.order, T, D, 0, end, svc)
    OUT.mkdir(parents=True, exist_ok=True)
    (OUT / f"rota_150_{mode}.geojson").write_text(json.dumps({"type": "FeatureCollection", "features": feats,
                                                               "aviso": "Pontos de TESTE sintéticos sobre a malha OSM; origem TESTE."}, ensure_ascii=False))
    with open(OUT / f"itinerario_150_{mode}.csv", "w", newline="", encoding="utf-8") as fh:
        w = csv.DictWriter(fh, fieldnames=list(rows[0].keys()), delimiter=";")
        w.writeheader()
        w.writerows(rows)
    summary = {
        "modo": mode, "paradas_entrada": len(pos), "paradas_roteadas": len(res.order),
        "excluidas_snap": {pos[i - 1]["chave"]: m for i, m in snap_fail.items()},
        "excluidas_factibilidade": {pos[i - 1]["chave"]: m for i, m in f.excluded.items()},
        "cartas_roteadas": sum(pos[i - 1]["cartas"] for i in res.order),
        "distancia_km": round(dist / 1000, 3), "tempo_total_min": round(clock / 60, 1),
        "tempo_viagem_min": round(travel / 60, 1), "tempo_servico_min": round((clock - travel) / 60, 1),
        "tempo_acesso_min": round(sum(2 * sess.snaps[i].distance_m / walk for i in res.order) / 60, 1),
        "eta_igual_avaliacao": abs(t_eval - clock) < 1.0,
        "por_bairro": dict(by_nb),
        "snap": {"max_m": round(max(sess.snaps[i].distance_m for i in ok), 1),
                 "revisar_>30m_ou_flags": sum(1 for i in ok if sess.snaps[i].distance_m > 30 or sess.snaps[i].flags),
                 "confianca": dict(Counter(sess.snaps[i].confidence for i in ok))},
        "melhor_estrategia": res.best.strategy,
        "candidatos": [c.to_dict() for c in res.candidates],
        "tempos_calculo_s": {"matriz": round(t_matrix, 2), "solver": round(t_solve, 2), "geometria": round(t_geom, 2)},
        "malha": {"versao": sess.network_version, "nos": eng.network().n_nodes, "arestas": eng.network().n_edges},
        "perfil": prof.to_dict(), "atendimento": {"base_s": SERVICE_BASE_S, "por_carta_extra_s": PER_LETTER_S,
                                                   "acesso": "2 x distância do snap / velocidade a pé"},
        "aviso": "Estimativas sobre posições TESTE; não são tempos reais de entrega.",
    }
    parity = {"points": pts, "T": np.where(np.isfinite(T), np.round(T, 3), -1).tolist(),
              "D": np.where(np.isfinite(D), np.round(D, 2), -1).tolist(),
              "snap": [{"ok": s.ok, "d": s.distance_m, "flags": s.flags, "conf": s.confidence} for s in sess.snaps],
              "service": {str(k): v for k, v in svc.items()}, "kept": f.kept, "end": end,
              "backend_time_s": t_eval, "backend_dist_m": d_eval, "mode": mode}
    return summary, parity


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--time-limit", type=int, default=30)
    a = ap.parse_args()
    pos, _ = load()
    eng = InternalEngine(get_settings())
    prof = TravelProfile(ride_speed_kmh=15)
    out = {}
    for mode in ("open", "circular"):
        s, par = run(mode, a.time_limit, eng, pos, prof)
        out[mode] = s
        (OUT / f"paridade_150_{mode}.json").write_text(json.dumps(par))
        print(json.dumps({k: v for k, v in s.items() if k not in ("candidatos", "perfil")}, ensure_ascii=False, indent=1))
    (OUT / "resumo_150.json").write_text(json.dumps(out, ensure_ascii=False, indent=1))


if __name__ == "__main__":
    main()
