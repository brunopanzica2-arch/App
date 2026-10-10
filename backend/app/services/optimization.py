"""Sequenciamento com OR-Tools — rota aberta (padrão), circular ou destino fixo.

Critério LEXICOGRÁFICO explícito (auditoria V2, alerta E):
  1. FACTIBILIDADE: nenhuma sequência com par sem caminho é aceita (`feasibility`, `validate`);
  2. COBERTURA: todas as paradas factíveis entram (as demais saem com motivo, rota "partial");
  3. TEMPO: deslocamento + atendimento (+ penalidades configuradas, em segundos de custo);
  4. DISTÂNCIA: só desempata. No OR-Tools: custo = tempo_ms * W + metros, com W = 10^6
     (rotas < 1.000 km), ou seja, 1 ms sempre vale mais que qualquer distância.
Na rota aberta o arco até o fim fictício carrega o atendimento da última parada, de modo que o
objetivo do solver, `evaluate()` e o ETA do planner somam exatamente as mesmas parcelas.
Não há garantia de ótimo global.
"""

from __future__ import annotations

import math
import time
from dataclasses import dataclass, field

import numpy as np
from ortools.constraint_solver import pywrapcp, routing_enums_pb2

MS = 1000
W = 10**6                     # peso lexicográfico do tempo (ms) sobre a distância (m)
UNREACH = 10**15              # arco impossível (só para o solver; a saída é validada)
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
    time_s: float                 # tempo real estimado (deslocamento + atendimento)
    distance_m: float
    cost_s: float                 # tempo + penalidades (prioridade/setor) — critério 3
    feasible: bool
    solve_ms: int
    solver_objective: int | None = None

    @property
    def objective(self) -> tuple[float, float]:
        return (self.cost_s, self.distance_m)

    def to_dict(self) -> dict:
        return {"strategy": self.strategy, "time_s": round(self.time_s, 1), "distance_m": round(self.distance_m, 1),
                "cost_s": round(self.cost_s, 1), "feasible": self.feasible, "solve_ms": self.solve_ms}


@dataclass
class SolveResult:
    order: list[int]
    best: Candidate
    candidates: list[Candidate] = field(default_factory=list)


@dataclass
class Feasibility:
    kept: list[int]                       # paradas que formam uma sequência possível
    excluded: dict[int, str]              # parada -> motivo
    comp_rank: dict[int, int]             # ordem topológica obrigatória entre componentes
    exact: bool = True                    # True: cobertura máxima provada (matriz fechada ou DP exato)
    method: str = "scc_chain"             # scc_chain | exact_dp


def evaluate(order, T, D, start, end, service) -> tuple[float, float]:
    seq = [start, *order] + ([end] if end is not None else [])
    t = sum(T[a, b] for a, b in zip(seq, seq[1:])) + sum(service.get(i, 0.0) for i in order)
    d = sum(D[a, b] for a, b in zip(seq, seq[1:]))
    return float(t), float(d)


def cost(order, T, D, start, end, service, priority=None, sector=None) -> tuple[float, float]:
    """(tempo + penalidades em s, distância em m) — mesma função usada para escolher candidatos."""
    t, d = evaluate(order, T, D, start, end, service)
    pen = 0.0
    if priority:
        clock, prev = 0.0, start
        for i in order:
            clock += T[prev, i]
            pen += priority.get(i, 0) * clock
            clock += service.get(i, 0.0)
            prev = i
    if sector:
        seq = [start, *order]
        pen += SECTOR_SWITCH_S * sum(1 for a, b in zip(seq[1:], seq[2:]) if sector.get(a) != sector.get(b))
    return t + pen, d


def validate(order, T, start, stops, end) -> list[str]:
    """Propriedades de rota válida. Lista vazia = válida."""
    problems = []
    if sorted(order) != sorted(stops):
        problems.append("paradas faltando ou repetidas")
    if len(set(order)) != len(order):
        problems.append("parada visitada mais de uma vez")
    seq = [start, *order] + ([end] if end is not None else [])
    bad = [(a, b) for a, b in zip(seq, seq[1:]) if not math.isfinite(T[a, b])]
    if bad:
        problems.append(f"{len(bad)} trecho(s) sem caminho na malha: {bad[:3]}")
    return problems


def _scc(nodes: list[int], reach) -> list[list[int]]:
    """Componentes fortemente conexas (Tarjan iterativo) da relação de alcance entre paradas."""
    index, low, on, stack, out = {}, {}, set(), [], []
    counter = [0]
    for root in nodes:
        if root in index:
            continue
        work = [(root, iter(nodes))]
        index[root] = low[root] = counter[0]
        counter[0] += 1
        stack.append(root)
        on.add(root)
        while work:
            v, it = work[-1]
            advanced = False
            for w in it:
                if w == v or not reach(v, w):
                    continue
                if w not in index:
                    index[w] = low[w] = counter[0]
                    counter[0] += 1
                    stack.append(w)
                    on.add(w)
                    work.append((w, iter(nodes)))
                    advanced = True
                    break
                if w in on:
                    low[v] = min(low[v], index[w])
            if advanced:
                continue
            work.pop()
            if work:
                low[work[-1][0]] = min(low[work[-1][0]], low[v])
            if low[v] == index[v]:
                comp = []
                while True:
                    w = stack.pop()
                    on.discard(w)
                    comp.append(w)
                    if w == v:
                        break
                out.append(comp)
    return out


EXACT_DP_MAX = 16


def is_closed(T: np.ndarray, nodes: list[int], tol: float = 1e-6) -> bool:
    """T[a,c] <= T[a,b] + T[b,c] para todo trio de `nodes` (matriz de caminhos mínimos é sempre fechada)."""
    idx = np.array(nodes)
    S = T[np.ix_(idx, idx)]
    with np.errstate(invalid="ignore"):
        for k in range(len(idx)):
            if np.any(S > S[:, [k]] + S[[k], :] + tol):
                return False
    return True


def _exact_cover(T, start, cand, end):
    """DP exato (máscaras): maior subconjunto de `cand` numa sequência de arcos finitos. Devolve a ordem testemunha."""
    m = len(cand)
    fin = lambda a, b: math.isfinite(T[a, b])  # noqa: E731
    parent: dict[tuple[int, int], tuple[int, int] | None] = {}
    for i in range(m):
        if fin(start, cand[i]):
            parent[(1 << i, i)] = None
    best, best_key = 0, None
    for mask in range(1, 1 << m):
        for last in range(m):
            if (mask, last) not in parent:
                continue
            if (end is None or fin(cand[last], end)) and bin(mask).count("1") > best:
                best, best_key = bin(mask).count("1"), (mask, last)
            for nx in range(m):
                if not mask >> nx & 1 and fin(cand[last], cand[nx]) and (mask | 1 << nx, nx) not in parent:
                    parent[(mask | 1 << nx, nx)] = (mask, last)
    order, key = [], best_key
    while key is not None:
        order.append(cand[key[1]])
        key = parent[key]
    return order[::-1]


def feasibility(T: np.ndarray, start: int, stops: list[int], end: int | None) -> Feasibility:
    """Escolhe o MAIOR conjunto de paradas visitáveis numa única sequência.

    O alcance na malha é transitivo, então uma sequência existe sse as componentes fortemente
    conexas das paradas formam uma cadeia. Mantém-se o caminho de maior número de paradas no
    DAG de componentes; as demais saem com motivo explícito (nunca silenciosamente).
    """
    fin = lambda a, b: math.isfinite(T[a, b])  # noqa: E731
    excluded: dict[int, str] = {}
    cand = []
    for i in stops:
        if not fin(start, i):
            excluded[i] = "Sem caminho de pedestre a partir da origem."
        elif end is not None and not fin(i, end):
            excluded[i] = ("Sem caminho de volta à origem (circular)." if end == start
                           else "Sem caminho até o destino final.")
        else:
            cand.append(i)
    nodes = [start, *cand] + ([end] if end is not None and end != start else [])
    if cand and not is_closed(T, nodes):
        # Matriz que NÃO é de caminhos mínimos: a cadeia de SCCs deixa de ser exata (e até de ser segura).
        if len(cand) <= EXACT_DP_MAX:
            order = _exact_cover(T, start, cand, end)
            for v in cand:
                if v not in order:
                    excluded[v] = "Fora da maior sequência visitável (busca exata, matriz sem fecho transitivo)."
            return Feasibility(kept=order, excluded=excluded, comp_rank={v: r for r, v in enumerate(order)},
                               exact=True, method="exact_dp")
        # grande demais para busca exata: cadeia de SCCs + garantia posterior pelo validate() do chamador
        chain = _chain(T, cand, fin)
        for v in cand:
            if v not in chain.comp_rank:
                excluded[v] = "Sem caminho de pedestre que permita visitá-la na mesma sequência das demais."
        return Feasibility(kept=chain.kept, excluded=excluded, comp_rank=chain.comp_rank, exact=False, method="scc_chain")
    chain = _chain(T, cand, fin)
    for v in cand:
        if v not in chain.comp_rank:
            excluded[v] = ("Sem caminho de pedestre que permita visitá-la na mesma sequência das demais "
                           "(trecho de sentido único ou sem saída).")
    return Feasibility(kept=chain.kept, excluded=excluded, comp_rank=chain.comp_rank)


def _chain(T, cand, fin) -> Feasibility:
    comps = _scc(cand, fin)
    cid = {v: k for k, c in enumerate(comps) for v in c}
    nc = len(comps)
    succ = [set() for _ in range(nc)]
    for a in cand:
        for b in cand:
            if cid[a] != cid[b] and fin(a, b):
                succ[cid[a]].add(cid[b])
    # Tarjan devolve as componentes em ordem topológica reversa
    best = [0] * nc
    nxt = [-1] * nc
    for k in range(nc):                      # sumidouros primeiro
        best[k] = len(comps[k])
        for s in succ[k]:
            if best[s] + len(comps[k]) > best[k]:
                best[k] = best[s] + len(comps[k])
                nxt[k] = s
    kept: list[int] = []
    rank: dict[int, int] = {}
    if nc:
        k = max(range(nc), key=lambda c: (best[c], -c))
        r = 0
        while k != -1:
            for v in comps[k]:
                rank[v] = r
            kept.extend(comps[k])
            r += 1
            k = nxt[k]
    return Feasibility(kept=kept, excluded={}, comp_rank=rank)


def repair(order: list[int], rank: dict[int, int]) -> list[int]:
    """Reordena respeitando a ordem obrigatória entre componentes (estável dentro de cada uma)."""
    return sorted(order, key=lambda v: rank.get(v, 0))


def nearest_neighbor(T, start, stops) -> list[int]:
    left, cur, out = set(stops), start, []
    while left:
        nxt = min(left, key=lambda j: T[cur, j])
        out.append(nxt)
        left.remove(nxt)
        cur = nxt
    return out


def _tour_cost(x: np.ndarray, A: np.ndarray) -> int:
    return int(A[x[:-1], x[1:]].sum())


def _best_move(x: np.ndarray, A: np.ndarray):
    """Melhor movimento (2-opt ou Or-opt 1..3) em custos ASSIMÉTRICOS, avaliado em O(n²) vetorizado.
    `x` = [início, paradas..., fim]. Devolve (delta, nova_sequência) ou None."""
    n = len(x) - 2
    if n < 3:
        return None
    best = (0, None)
    F = np.concatenate(([0], np.cumsum(A[x[:-1], x[1:]])))
    R = np.concatenate(([0], np.cumsum(A[x[1:], x[:-1]])))
    i = np.arange(1, n)[:, None]
    j = np.arange(2, n + 1)[None, :]
    old = A[x[i - 1], x[i]] + (F[j] - F[i]) + A[x[j], x[j + 1]]
    new = A[x[i - 1], x[j]] + (R[j] - R[i]) + A[x[i], x[j + 1]]
    delta = np.where(j > i, new - old, 0)
    k = int(np.argmin(delta))
    if delta.flat[k] < best[0]:
        ii, jj = divmod(k, delta.shape[1])
        ii, jj = ii + 1, jj + 2
        best = (int(delta.flat[k]), np.concatenate((x[:ii], x[ii:jj + 1][::-1], x[jj + 1:])))
    for L in (1, 2, 3):
        if n < L + 1:
            break
        i = np.arange(1, n - L + 2)[:, None]               # início do bloco
        p = np.arange(1, n + 2)[None, :]                   # inserir entre x[p-1] e x[p]
        a, f, l, b = x[i - 1], x[i], x[i + L - 1], x[i + L]
        rem = A[a, f] + A[l, b] - A[a, b]
        ins = A[x[p - 1], f] + A[l, x[p]] - A[x[p - 1], x[p]]
        valid = (p < i) | (p > i + L)
        d = np.where(valid, ins - rem, 0)
        k = int(np.argmin(d))
        if d.flat[k] < best[0]:
            ii, pp = divmod(k, d.shape[1])
            ii, pp = ii + 1, pp + 1
            block = x[ii:ii + L]
            rest = np.concatenate((x[:ii], x[ii + L:]))
            pos = pp - L if pp > ii else pp
            best = (int(d.flat[k]), np.concatenate((rest[:pos], block, rest[pos:])))
    return best if best[1] is not None else None


def _local_search(x: np.ndarray, A: np.ndarray, deadline: float) -> np.ndarray:
    while time.perf_counter() < deadline:
        mv = _best_move(x, A)
        if mv is None or mv[0] >= 0:
            break
        x = mv[1]
    return x


def _ils(x: np.ndarray, A: np.ndarray, budget_s: float, seed: int = 12345) -> np.ndarray:
    """Busca local iterada (double-bridge) sobre a matriz de arcos do OR-Tools, para partida a quente do solver."""
    deadline = time.perf_counter() + budget_s
    rnd = np.random.default_rng(seed)
    best = _local_search(x, A, deadline)
    best_c = _tour_cost(best, A)
    cur, cur_c = best, best_c
    n = len(x) - 2
    while n >= 8 and time.perf_counter() < deadline:
        q = max(1, n // 4)
        a = 1 + int(rnd.integers(0, q)); b = a + 1 + int(rnd.integers(0, q)); c = b + 1 + int(rnd.integers(0, q))
        if c >= n:
            continue
        mid = cur[1:n + 1]
        pert = np.concatenate(([cur[0]], mid[:a - 1 + 0], mid[c - 1:], mid[b - 1:c - 1], mid[a - 1:b - 1], [cur[-1]]))
        if len(pert) != len(cur):
            continue
        cand = _local_search(pert, A, deadline)
        cc = _tour_cost(cand, A)
        if cc < cur_c:
            cur, cur_c = cand, cc
            if cc < best_c:
                best, best_c = cand, cc
    return best


def solve(T: np.ndarray, D: np.ndarray, start: int, stops: list[int], end: int | None = None,
          service_s: dict[int, float] | None = None, priority: dict[int, int] | None = None,
          sector: dict[int, str] | None = None, time_limit_s: float = 10,
          strategies: list[str] | None = None, baselines: dict[str, list[int]] | None = None,
          comp_rank: dict[int, int] | None = None) -> SolveResult:
    """Ordem das `stops` (índices da matriz). `end=None` => rota aberta; `end=start` => circular.

    As `stops` devem ser factíveis entre si (ver `feasibility`); toda saída é validada.
    """
    svc = {i: float((service_s or {}).get(i, 0.0)) for i in stops}
    prio = {i: p for i, p in (priority or {}).items() if p > 0}
    if not stops:
        c = Candidate("trivial", [], 0.0, 0.0, 0.0, True, 0)
        return SolveResult([], c, [c])
    rank = comp_rank or {}
    ev_end = end  # None = aberta

    cands: list[Candidate] = []

    def add(name, order, t0, solver_objective=None):
        order = list(order)
        ok = not validate(order, T, start, stops, ev_end)
        if not ok and rank:
            order = repair(order, rank)
            ok = not validate(order, T, start, stops, ev_end)
            name += "+reparo"
        t, d = evaluate(order, T, D, start, ev_end, svc)
        c, _ = cost(order, T, D, start, ev_end, svc, prio, sector)
        cands.append(Candidate(name, order, t, d, c, ok, int((time.perf_counter() - t0) * 1000), solver_objective))

    t0 = time.perf_counter()
    add("nearest_neighbor_baseline", nearest_neighbor(T, start, stops), t0)
    for name, order in (baselines or {}).items():
        if sorted(order) == sorted(stops):
            add(f"baseline:{name}", order, time.perf_counter())

    # ---- OR-Tools
    nodes = [start, *stops]
    if end is None:
        nodes.append(-1)
        end_idx = len(nodes) - 1
    elif end == start:
        end_idx = 0
    else:
        nodes.append(end)
        end_idx = len(nodes) - 1
    n = len(nodes)
    travel = np.zeros((n, n), dtype=np.int64)
    arc = np.zeros((n, n), dtype=np.int64)
    for a in range(n):
        u = nodes[a]
        for b in range(n):
            if a == b:
                continue
            v = nodes[b]
            if u == -1:
                travel[a, b] = arc[a, b] = UNREACH
                continue
            s_ms = int(round(svc.get(u, 0.0) * MS))
            if v == -1:                       # fim livre: só o atendimento da última parada
                travel[a, b] = s_ms
                arc[a, b] = s_ms * W
                continue
            t, d = T[u, v], D[u, v]
            if not (math.isfinite(t) and math.isfinite(d)):
                travel[a, b] = arc[a, b] = UNREACH
                continue
            t_ms = int(round(t * MS)) + s_ms
            extra = int(SECTOR_SWITCH_S * MS) if sector and sector.get(u) is not None and v in sector \
                and u != start and sector.get(u) != sector.get(v) else 0
            travel[a, b] = t_ms
            arc[a, b] = (t_ms + extra) * W + int(round(d))
    travel_l, arc_l = travel.tolist(), arc.tolist()
    names = strategies or (["path_cheapest_arc", "local_cheapest_insertion", "christofides"]
                           if len(stops) > 3 else ["path_cheapest_arc"])
    warm = strategies is None and len(stops) >= 8
    per = max(1.0, (time_limit_s * (0.4 if warm else 1.0)) / len(names))
    for name in names:
        t0 = time.perf_counter()
        manager = pywrapcp.RoutingIndexManager(n, 1, [0], [end_idx])
        routing = pywrapcp.RoutingModel(manager)
        cb = routing.RegisterTransitCallback(lambda i, j, m=manager: arc_l[m.IndexToNode(i)][m.IndexToNode(j)])
        routing.SetArcCostEvaluatorOfAllVehicles(cb)
        if prio:
            tcb = routing.RegisterTransitCallback(lambda i, j, m=manager: travel_l[m.IndexToNode(i)][m.IndexToNode(j)])
            routing.AddDimension(tcb, 0, 10**13, True, "Time")
            dim = routing.GetDimensionOrDie("Time")
            for pos, node in enumerate(nodes):
                if 1 <= pos <= len(stops) and prio.get(node):
                    # cumul = chegada + atendimentos anteriores (ms); custo na escala do objetivo
                    dim.SetCumulVarSoftUpperBound(manager.NodeToIndex(pos), 0, prio[node] * W)
        params = pywrapcp.DefaultRoutingSearchParameters()
        params.first_solution_strategy = STRATEGIES[name]
        params.local_search_metaheuristic = (routing_enums_pb2.LocalSearchMetaheuristic.AUTOMATIC if len(stops) <= 3
                                             else routing_enums_pb2.LocalSearchMetaheuristic.GUIDED_LOCAL_SEARCH)
        params.time_limit.FromMilliseconds(int(per * 1000))
        sol = routing.SolveWithParameters(params)
        if sol is None:
            continue
        order, idx = [], routing.Start(0)
        while not routing.IsEnd(idx):
            node = manager.IndexToNode(idx)
            if 1 <= node <= len(stops):
                order.append(nodes[node])
            idx = sol.Value(routing.NextVar(idx))
        add(name, order, t0, int(sol.ObjectiveValue()))

    # ---- partida a quente: busca local iterada (2-opt/Or-opt assimétricos) sobre os MESMOS arcos do OR-Tools,
    #      e depois Guided Local Search do OR-Tools a partir dessa solução (ReadAssignmentFromRoutes).
    feas0 = [c for c in cands if c.feasible]
    if warm and feas0:
        seed_order = min(feas0, key=lambda c: (round(c.cost_s, 3), round(c.distance_m, 3))).order
        pos = {node: k for k, node in enumerate(nodes)}
        A = arc
        x0 = np.array([0, *[pos[v] for v in seed_order], end_idx], dtype=np.int64)
        t0 = time.perf_counter()
        xi = _ils(x0, A, time_limit_s * 0.25)
        order_i = [nodes[k] for k in xi[1:-1]]
        add("ils_python", order_i, t0)
        t0 = time.perf_counter()
        manager = pywrapcp.RoutingIndexManager(n, 1, [0], [end_idx])
        routing = pywrapcp.RoutingModel(manager)
        cb = routing.RegisterTransitCallback(lambda i, j, m=manager: arc_l[m.IndexToNode(i)][m.IndexToNode(j)])
        routing.SetArcCostEvaluatorOfAllVehicles(cb)
        if prio:
            tcb = routing.RegisterTransitCallback(lambda i, j, m=manager: travel_l[m.IndexToNode(i)][m.IndexToNode(j)])
            routing.AddDimension(tcb, 0, 10**13, True, "Time")
            dim = routing.GetDimensionOrDie("Time")
            for p_, node in enumerate(nodes):
                if 1 <= p_ <= len(stops) and prio.get(node):
                    dim.SetCumulVarSoftUpperBound(manager.NodeToIndex(p_), 0, prio[node] * W)
        params = pywrapcp.DefaultRoutingSearchParameters()
        params.local_search_metaheuristic = routing_enums_pb2.LocalSearchMetaheuristic.GUIDED_LOCAL_SEARCH
        params.time_limit.FromMilliseconds(int(time_limit_s * 0.35 * 1000))
        routing.CloseModelWithParameters(params)
        init = routing.ReadAssignmentFromRoutes([[int(k) for k in xi[1:-1]]], True)
        sol = routing.SolveFromAssignmentWithParameters(init, params) if init is not None else None
        if sol is not None:
            order, idx = [], routing.Start(0)
            while not routing.IsEnd(idx):
                node = manager.IndexToNode(idx)
                if 1 <= node <= len(stops):
                    order.append(nodes[node])
                idx = sol.Value(routing.NextVar(idx))
            add("ils_python+guided_local_search", order, t0, int(sol.ObjectiveValue()))

    feasible = [c for c in cands if c.feasible]
    if not feasible:
        raise RuntimeError("Nenhuma sequência factível encontrada (há pares sem caminho na malha).")
    best = min(feasible, key=lambda c: (round(c.cost_s, 3), round(c.distance_m, 3)))
    return SolveResult(best.order, best, cands)
