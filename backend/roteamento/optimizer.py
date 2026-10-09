"""Sequenciamento das entregas com OR-Tools.

Objetivo principal: menor tempo total estimado (deslocamento + atendimento).
Objetivo secundário: menor distância (desempate: 1 m pesa como 1 ms).
Rota aberta (padrão), circular (volta ao início) ou com destino final fixo.
"""

from __future__ import annotations

import math

import numpy as np
from ortools.constraint_solver import pywrapcp, routing_enums_pb2

TIME_SCALE = 1000          # custo em milissegundos
DIST_WEIGHT = 1            # +1 por metro (desempate)
UNREACHABLE = 10**12


def solve_sequence(
    time_s: np.ndarray,
    dist_m: np.ndarray,
    start: int,
    stops: list[int],
    end: int | None = None,
    circular: bool = False,
    service_time_s: float = 0.0,
    time_limit_s: int = 5,
) -> list[int]:
    """Retorna a ordem de visita das paradas (índices da matriz).

    `start`/`end`/`stops` são índices nas matrizes. Com `end=None` e
    `circular=False` a rota termina na última entrega (rota aberta).
    """
    if not stops:
        return []
    if circular:
        end = start

    # nós do modelo: [start, *stops, (end?), (fim livre?)]
    nodes = [start] + list(stops)
    end_idx: int
    free_end = end is None
    if free_end:
        nodes.append(-1)                # nó fictício: custo zero para "terminar"
        end_idx = len(nodes) - 1
    elif end == start:
        end_idx = 0
    else:
        nodes.append(end)
        end_idx = len(nodes) - 1

    n = len(nodes)
    service = [0] + [int(round(service_time_s * TIME_SCALE))] * len(stops) + [0] * (n - 1 - len(stops))
    cost = [[0] * n for _ in range(n)]
    for i in range(n):
        for j in range(n):
            if i == j:
                continue
            a, b = nodes[i], nodes[j]
            if b == -1:
                c = 0
            elif a == -1:
                c = UNREACHABLE
            else:
                t, d = time_s[a, b], dist_m[a, b]
                if not (math.isfinite(t) and math.isfinite(d)):
                    c = UNREACHABLE
                else:
                    c = int(round(t * TIME_SCALE)) + int(round(d * DIST_WEIGHT))
            cost[i][j] = c + (service[i] if c < UNREACHABLE else 0)

    manager = pywrapcp.RoutingIndexManager(n, 1, [0], [end_idx])
    routing = pywrapcp.RoutingModel(manager)

    def cb(fi, ti):
        return cost[manager.IndexToNode(fi)][manager.IndexToNode(ti)]

    transit = routing.RegisterTransitCallback(cb)
    routing.SetArcCostEvaluatorOfAllVehicles(transit)

    params = pywrapcp.DefaultRoutingSearchParameters()
    params.first_solution_strategy = routing_enums_pb2.FirstSolutionStrategy.PATH_CHEAPEST_ARC
    params.local_search_metaheuristic = (
        routing_enums_pb2.LocalSearchMetaheuristic.GUIDED_LOCAL_SEARCH
    )
    params.time_limit.FromMilliseconds(int(max(time_limit_s, 1) * 1000))
    # Para poucas paradas, a busca converge rápido; evita esperar o limite.
    if len(stops) <= 3:
        params.local_search_metaheuristic = (
            routing_enums_pb2.LocalSearchMetaheuristic.AUTOMATIC
        )
    solution = routing.SolveWithParameters(params)
    if solution is None:
        raise RuntimeError("OR-Tools não encontrou solução.")

    order = []
    idx = routing.Start(0)
    while not routing.IsEnd(idx):
        node = manager.IndexToNode(idx)
        if 1 <= node <= len(stops):
            order.append(nodes[node])
        idx = solution.Value(routing.NextVar(idx))
    return order
