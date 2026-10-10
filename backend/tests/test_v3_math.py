"""V3 §7.3: a factibilidade (Tarjan + cadeia no DAG) maximiza a cobertura? Comparação com busca exata."""
import math
import random

import numpy as np
import pytest

from app.services.optimization import feasibility, solve, validate


def floyd(adj):
    n = len(adj)
    d = [row[:] for row in adj]
    for k in range(n):
        for i in range(n):
            for j in range(n):
                if d[i][k] + d[k][j] < d[i][j]:
                    d[i][j] = d[i][k] + d[k][j]
    return np.array(d, dtype=float)


def random_digraph(rng, n, p):
    adj = [[math.inf] * n for _ in range(n)]
    for i in range(n):
        adj[i][i] = 0.0
        for j in range(n):
            if i != j and rng.random() < p:
                adj[i][j] = float(rng.randint(1, 9))
    return adj


def exact_max_cover(T, start, stops, end):
    """Maior subconjunto visitável numa única sequência (arcos finitos): DP exato sobre máscaras."""
    m = len(stops)
    fin = lambda a, b: math.isfinite(T[a, b])  # noqa: E731
    ok = [[False] * m for _ in range(1 << m)]
    for i in range(m):
        ok[1 << i][i] = fin(start, stops[i])
    best = 0
    for mask in range(1, 1 << m):
        for last in range(m):
            if not ok[mask][last]:
                continue
            if end is None or fin(stops[last], end):
                best = max(best, bin(mask).count("1"))
            for nx in range(m):
                if not mask >> nx & 1 and fin(stops[last], stops[nx]):
                    ok[mask | 1 << nx][nx] = True
    return best


@pytest.mark.parametrize("mode", ["open", "circular"])
def test_feasibility_is_optimal_on_shortest_path_matrices(mode):
    """Matrizes de caminho mínimo (como as do motor real) são transitivas: a cadeia é exata."""
    rng = random.Random(7)
    checked = 0
    for _ in range(80):
        n = rng.randint(5, 9)
        T = floyd(random_digraph(rng, n, rng.choice([0.15, 0.25, 0.4])))
        stops = list(range(1, min(n, 8)))
        end = 0 if mode == "circular" else None
        f = feasibility(T, 0, stops, end)
        opt = exact_max_cover(T, 0, [s for s in stops if math.isfinite(T[0, s]) and (end is None or math.isfinite(T[s, 0]))], end)
        assert len(f.kept) == opt, (T.tolist(), f.kept, opt)
        # a saída do solver é uma sequência válida de todas as mantidas
        if f.kept and checked % 10 == 0:
            res = solve(T, T.copy(), 0, f.kept, end, time_limit_s=0.1, strategies=["path_cheapest_arc"], comp_rank=f.comp_rank)
            assert validate(res.order, T, 0, f.kept, end) == []
        checked += 1
    assert checked == 80


def test_non_closed_matrices_use_exact_search_and_are_never_unsafe():
    """Antes (V2), em matriz sem fecho transitivo o conjunto mantido podia NÃO ser visitável (kept > ótimo).
    Agora: detecta a falta de fecho e usa busca exata; a cobertura é a ótima e há sequência-testemunha."""
    rng = random.Random(5)
    for p in (0.12, 0.2, 0.3):
        for it in range(300):
            n = rng.randint(5, 9)
            T = np.array(random_digraph(rng, n, p), dtype=float)
            stops = list(range(1, n))
            f = feasibility(T, 0, stops, None)
            reach = [s for s in stops if math.isfinite(T[0, s])]
            opt = exact_max_cover(T, 0, reach, None)
            assert len(f.kept) == opt, (p, it, f.kept, opt)
            assert validate(f.kept, T, 0, f.kept, None) == [] if f.method == "exact_dp" else True


@pytest.mark.parametrize("seed", range(6))
def test_engine_matrices_are_metric_closed_so_the_scc_chain_is_exact(seed):
    """A prova de exatidão da cadeia exige fecho transitivo; matrizes do motor real (Dijkstra) o têm,
    inclusive com paradas virtuais no meio de arestas e arestas de sentido único para pedestre."""
    from app.services.optimization import is_closed
    from roteamento.network import build_network
    from tests.test_graph_properties import random_osm, router

    net = build_network(random_osm(seed))
    r = router(net)
    rnd = random.Random(seed)
    pts = []
    for _ in range(9):
        e = rnd.randrange(net.n_edges)
        t = rnd.uniform(0.1, 0.9)
        a, b = net.ea[e], net.eb[e]
        pts.append((net.lat[a] + t * (net.lat[b] - net.lat[a]), net.lon[a] + t * (net.lon[b] - net.lon[a])))
    snaps = [r.snap(la, lo, 5) for la, lo in pts]
    T, _ = r.solver(snaps).matrices()
    assert is_closed(T, list(range(len(snaps))), tol=1e-6)


def test_real_santos_150_matrix_is_closed():
    import json
    from pathlib import Path

    from app.services.optimization import is_closed

    f = Path(__file__).resolve().parents[2] / "test-data" / "resultados" / "paridade_150_open.json"
    if not f.exists():
        pytest.skip("fixture ausente")
    P = json.loads(f.read_text())
    T = np.array(P["T"], dtype=float)
    T[T < 0] = np.inf
    assert is_closed(T, list(range(len(T))), tol=0.01)  # matriz gravada com 3 casas decimais


def test_time_breakdown_separates_physical_time_from_penalties(db, org):
    """V3 §7.1: ETA = deslocamento + serviço + acesso; penalidade de prioridade só existe no objetivo generalizado."""
    from sqlalchemy import select

    from app.core.config import get_settings
    from app.models import Stop
    from app.services.planner import PlanParams, plan
    from app.services.routing.engines import InternalEngine
    from roteamento.config import TravelProfile
    from tests.test_audit_v2 import D, make_batch, two_islands_net

    o, _ = org
    net = two_islands_net()
    pts = [(0.0, i * D, f"p{i}") for i in range(1, 5)] + [(2 * D, 3 * D + 0.0002, "p5 (afastado da via)")]
    b = make_batch(db, o.id, pts)
    stops = db.scalars(select(Stop).where(Stop.batch_id == b.id)).all()
    for st in stops[:2]:
        st.priority = 2
    db.commit()
    eng = InternalEngine(get_settings(), network=net)
    params = PlanParams(start_lat=0.0, start_lon=0.0001, start_label="TESTE", time_limit_s=1, service_time_s=45,
                        per_letter_service_s=10, profile=TravelProfile(sidewalk_mode="ride"))
    route = plan(db, get_settings(), eng, o.id, b.id, params)
    tb = route.metrics["time_breakdown"]
    assert tb["estimated_duration_s"] == pytest.approx(tb["travel_s"] + tb["service_s"] + tb["access_s"], abs=0.5)
    assert tb["estimated_duration_s"] == pytest.approx(route.total_time_s, abs=0.5)
    assert tb["service_s"] == pytest.approx(45 * 5, abs=0.5)
    assert tb["priority_penalty_s"] > 0 and tb["sector_penalty_s"] == 0
    assert tb["generalized_objective_s"] == pytest.approx(tb["estimated_duration_s"] + tb["priority_penalty_s"], abs=0.5)
    assert route.total_time_s < tb["generalized_objective_s"]  # penalidade nunca vaza para o ETA


# ---------------------------------------------------------------- busca local do backend (partida a quente)

def test_best_move_delta_matches_real_cost_change_on_asymmetric_costs():
    from app.services.optimization import _best_move, _ils, _tour_cost

    rng = np.random.default_rng(3)
    checked = improved = 0
    for _ in range(300):
        n = int(rng.integers(5, 13))
        A = rng.integers(1, 1000, size=(n + 2, n + 2)).astype(np.int64)
        if rng.random() < 0.5:
            A[rng.integers(0, n + 2), rng.integers(0, n + 2)] = 10**15  # arco impossível
        x = np.array([0, *rng.permutation(np.arange(1, n + 1)), n + 1], dtype=np.int64)
        mv = _best_move(x, A)
        if mv is None:
            continue
        d, y = mv
        assert sorted(y[1:-1]) == list(range(1, n + 1)) and y[0] == 0 and y[-1] == n + 1  # permutação preservada
        assert _tour_cost(y, A) - _tour_cost(x, A) == d, "delta incremental difere do custo real"
        checked += 1
        improved += d < 0
    assert checked > 100 and improved > 30
    # ILS nunca piora e preserva a permutação
    n = 30
    A = rng.integers(1, 500, size=(n + 2, n + 2)).astype(np.int64)
    x = np.array([0, *rng.permutation(np.arange(1, n + 1)), n + 1], dtype=np.int64)
    y = _ils(x, A, 0.4)
    assert sorted(y[1:-1]) == list(range(1, n + 1)) and _tour_cost(y, A) <= _tour_cost(x, A)


@pytest.mark.parametrize("mode", ["open", "circular"])
def test_solve_with_warm_start_returns_valid_better_or_equal_route(mode):
    rng = random.Random(21)
    n = 14
    T = floyd(random_digraph(rng, n, 0.5))
    stops = [i for i in range(1, n) if math.isfinite(T[0, i]) and math.isfinite(T[i, 0])]
    f = feasibility(T, 0, stops, 0 if mode == "circular" else None)
    assert len(f.kept) >= 8
    end = 0 if mode == "circular" else None
    res = solve(T, T.copy(), 0, f.kept, end, {i: 20.0 for i in f.kept}, time_limit_s=2, comp_rank=f.comp_rank)
    assert validate(res.order, T, 0, f.kept, end) == []
    names = {c.strategy for c in res.candidates}
    assert "ils_python" in names
    best_other = min(c.cost_s for c in res.candidates if c.feasible and not c.strategy.startswith("ils_python"))
    assert res.best.cost_s <= best_other + 1e-6
