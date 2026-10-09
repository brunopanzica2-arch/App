"""Gera matrizes REAIS (malha de Santos) + solução OR-Tools para validar o otimizador do app."""
import json
import random
import sys

import numpy as np

from app.core.config import get_settings
from app.services.optimization import evaluate, solve
from app.services.routing.engines import InternalEngine
from roteamento.config import TravelProfile

out = sys.argv[1]
eng = InternalEngine(get_settings())
net = eng.network()
r = eng.router(TravelProfile())
rng = random.Random(7)
cases = []
# região central (Gonzaga/Boqueirão/Embaré/Vila Belmiro): ~3 x 3 km
for k, mode in ((40, "open"), (120, "open"), (60, "circular")):
    pts = [(-23.9480025, -46.3406209)]
    while len(pts) < k + 1:
        lat, lon = rng.uniform(-23.975, -23.948), rng.uniform(-46.345, -46.315)
        try:
            r.snap(lat, lon, 60)
            pts.append((lat, lon))
        except Exception:
            pass
    sess = eng.matrix(pts, TravelProfile(), 150)
    T, D = sess.time_s, sess.dist_m
    stops = list(range(1, k + 1))
    end = 0 if mode == "circular" else None
    res = solve(T, D, 0, stops, end, {i: 45 for i in stops}, time_limit_s=15)
    t, d = evaluate(res.order, T, D, 0, end, {i: 45 for i in stops})
    cases.append({"name": f"santos-{k}-{mode}", "points": pts, "T": np.round(T, 3).tolist(),
                  "D": np.round(D, 2).tolist(), "end": end, "ortools": {"time_s": t, "distance_m": d,
                  "strategy": res.best.strategy, "order": res.order}})
    print(cases[-1]["name"], round(t), round(d))
json.dump(cases, open(out, "w"))
