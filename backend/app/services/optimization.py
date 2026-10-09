"""OR-Tools: TSP aberto (padrão) / circular / destino fixo com tempo de serviço.

Custo = tempo (ms: deslocamento + atendimento) + distância (1 por metro, desempate).
Suporta: paradas prioritárias (limite superior suave no tempo de chegada),
modo por setores (penalidade ao trocar de bairro), comparação de estratégias
iniciais e linha de base "vizinho mais próximo". Não garante ótimo global.
"""

from __future__ import annotations

import math
import time
from dataclasses import dataclass, field

import numpy as np
from ortools.constraint_solver import pywrapcp, routing_enums_pb2

MS = 1000
UNREACH = 10**11
SECTOR_SWITCH_S = 300.0
FS = routing_enums_pb2.FirstSolutionStrategy
STRATEGIES = {
    "path_cheapest_arc": FS.PATH_CHEAPEST_ARC,
    "local_cheapest_insertion": FS.LOCAL_CHEAPEST_INSERTION,
    "christofides": FS.CHRISTOFIDES,
    "savings": FS.SAVINGS,
}


@dataclass
class Candidate:
    strategy: str
    order: list[int]
    objective: int
    time_s: float
    distance_m: float
    solve_ms: int

    def to_dict(self) -> dict:
        return {"strategy": self.strategy, "objective": self.objective, "time_s": round(self.time_s, 1),
                "distance_m": round(self.distance_m, 1), "solve_ms": self.solve_ms}


@dataclass
class SolveResult:
    order: list[int]
    best: Candidate
    candidates: list[Candidate] = field(default_factory=list)


def evaluate(order, T, D, start, end, service) -> tuple[float, float]:
    seq = [start, *order] + ([end] if end is not None else [])
    t = sum(T[a, b] for a, b in zip(seq, seq[1:])) + sum(service.get(i, 0.0) for i in order)
    d = sum(D[a, b] for a, b in zip(seq, seq[1:]))
    return float(t), float(d)


def nearest_neighbor(T, start, stops) -> list[int]:
    left, cur, out = set(stops), start, []
    while left:
        nxt = min(left, key=lambda j: T[cur, j])
        out.append(nxt)
        left.remove(nxt)
        cur = nxt
    return out


def solve(T: np.ndarray, D: np.ndarray, start: int, stops: list[int], end: int | None = None,
          service_s: dict[int, float] | None = None, priority: dict[int, int] | None = None,
          sector: dict[int, str] | None = None, time_limit_s: float = 10,
          strategies: list[str] | None = None) -> SolveResult:
    """Retorna a ordem das `stops` (índices da matriz). `end=None` => rota aberta;
    `end=start` => circular."""
    service_s = service_s or {}
    svc = {i: float(service_s.get(i, 0.0)) for i in stops}
    if not stops:
        c = Candidate("trivial", [], 0, 0.0, 0.0, 0)
        return SolveResult([], c, [c])
    for i in stops:
        if not (math.isfinite(T[start, i]) and math.isfinite(T[i, start] if end == start else 0)):
            raise ValueError(f"Parada {i} inalcançável a partir da origem.")

    nodes = [start, *stops]
    free_end = end is None
    if free_end:
        nodes.append(-1)
        end_idx = len(nodes) - 1
    elif end == start:
        end_idx = 0
    else:
        nodes.append(end)
        end_idx = len(nodes) - 1
    n = len(nodes)

    travel = np.zeros((n, n), dtype=np.int64)
    arc_cost = np.zeros((n, n), dtype=np.int64)
    for a in range(n):
        for b in range(n):
            if a == b:
                continue
            u, v = nodes[a], nodes[b]
            if v == -1:
                continue
            if u == -1:
                travel[a, b] = arc_cost[a, b] = UNREACH
                continue
            t, d = T[u, v], D[u, v]
            if not (math.isfinite(t) and math.isfinite(d)):
                travel[a, b] = arc_cost[a, b] = UNREACH
                continue
            travel[a, b] = int(round((t + svc.get(u, 0.0)) * MS))
            extra = 0
            if sector and u in sector and v in sector and sector[u] != sector[v]:
                extra = int(SECTOR_SWITCH_S * MS)
            arc_cost[a, b] = travel[a, b] + int(round(d)) + extra
    travel_l = travel.tolist()
    cost_l = arc_cost.tolist()

    names = strategies or (["path_cheapest_arc", "local_cheapest_insertion", "christofides"]
                           if len(stops) > 3 else ["path_cheapest_arc"])
    per = max(1.0, time_limit_s / len(names))
    cands: list[Candidate] = []

    nn = nearest_neighbor(T, start, stops)
    t_nn, d_nn = evaluate(nn, T, D, start, None if free_end else end, svc)
    cands.append(Candidate("nearest_neighbor_baseline", nn, -1, t_nn, d_nn, 0))

    for name in names:
        t0 = time.perf_counter()
        manager = pywrapcp.RoutingIndexManager(n, 1, [0], [end_idx])
        routing = pywrapcp.RoutingModel(manager)
        cost_cb = routing.RegisterTransitCallback(
            lambda i, j: cost_l[manager.IndexToNode(i)][manager.IndexToNode(j)])
        routing.SetArcCostEvaluatorOfAllVehicles(cost_cb)
        if priority and any(priority.get(i, 0) > 0 for i in stops):
            time_cb = routing.RegisterTransitCallback(
                lambda i, j: travel_l[manager.IndexToNode(i)][manager.IndexToNode(j)])
            routing.AddDimension(time_cb, 0, 10**12, True, "Time")
            dim = routing.GetDimensionOrDie("Time")
            for pos, node in enumerate(nodes):
                p = priority.get(node, 0) if 1 <= pos <= len(stops) else 0
                if p > 0:
                    # cada segundo de atraso custa p segundos extras
                    dim.SetCumulVarSoftUpperBound(manager.NodeToIndex(pos), 0, p)
        params = pywrapcp.DefaultRoutingSearchParameters()
        params.first_solution_strategy = STRATEGIES[name]
        params.local_search_metaheuristic = routing_enums_pb2.LocalSearchMetaheuristic.GUIDED_LOCAL_SEARCH
        params.time_limit.FromMilliseconds(int(per * 1000))
        if len(stops) <= 3:
            params.local_search_metaheuristic = routing_enums_pb2.LocalSearchMetaheuristic.AUTOMATIC
        sol = routing.SolveWithParameters(params)
        ms = int((time.perf_counter() - t0) * 1000)
        if sol is None:
            continue
        order = []
        idx = routing.Start(0)
        while not routing.IsEnd(idx):
            node = manager.IndexToNode(idx)
            if 1 <= node <= len(stops):
                order.append(nodes[node])
            idx = sol.Value(routing.NextVar(idx))
        t, d = evaluate(order, T, D, start, None if free_end else end, svc)
        cands.append(Candidate(name, order, int(sol.ObjectiveValue()), t, d, ms))

    solved = [c for c in cands if c.objective >= 0]
    if not solved:
        raise RuntimeError("OR-Tools não encontrou solução.")
    best = min(solved, key=lambda c: c.objective)
    return SolveResult(best.order, best, cands)
