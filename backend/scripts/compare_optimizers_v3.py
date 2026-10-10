"""V3 §7.2: OR-Tools (backend) em MATRIZ e OBJETIVO idênticos aos do app. Mesmo T, D, serviço e função de avaliação.
Entrada: test-data/resultados/paridade_150_open.json (matriz real 151x151 do backend, posições TESTE).
Saída: test-data/v3/comparacao_backend.json. Uso: cd backend && python -m scripts.compare_optimizers_v3
"""
from __future__ import annotations

import hashlib
import json
import time
from pathlib import Path

import numpy as np

from app.services.optimization import cost, evaluate, solve, validate

ROOT = Path(__file__).resolve().parents[2]
SRC = ROOT / "test-data" / "resultados" / "paridade_150_open.json"
OUT = ROOT / "test-data" / "v3" / "comparacao_backend.json"


def main() -> None:
    raw = SRC.read_bytes()
    P = json.loads(raw)
    T = np.array(P["T"], float)
    T[T < 0] = np.inf
    D = np.array(P["D"], float)
    D[D < 0] = np.inf
    svc = {int(k): v for k, v in P["service"].items()}
    stops = P["kept"]
    rows = []
    for limit in (5, 15, 60):
        t0 = time.perf_counter()
        r = solve(T, D, 0, stops, None, svc, time_limit_s=limit)
        wall = time.perf_counter() - t0
        assert validate(r.order, T, 0, stops, None) == []
        t, d = evaluate(r.order, T, D, 0, None, svc)
        g, _ = cost(r.order, T, D, 0, None, svc)
        rows.append({"limite_s": limit, "tempo_s": round(t, 2), "tempo_min": round(t / 60, 2), "km": round(d / 1000, 3), "objetivo_s": round(g, 2),
                     "estrategia": r.best.strategy, "execucao_s": round(wall, 1),
                     "candidatos": {c.strategy: round(c.time_s, 1) for c in r.candidates}})
        print(rows[-1])
    out = {"entrada": SRC.name, "entrada_sha256": hashlib.sha256(raw).hexdigest(), "paradas": len(stops),
           "objetivo": "tempo físico (viagem + serviço + acesso), sem penalidades (não há prioridade nem setor neste cenário)",
           "ortools": rows, "aviso": "OR-Tools com limite de tempo NÃO garante ótimo global."}
    OUT.write_text(json.dumps(out, ensure_ascii=False, indent=1))


if __name__ == "__main__":
    main()
