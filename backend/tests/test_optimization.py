import numpy as np
import pytest

from app.services.optimization import evaluate, nearest_neighbor, solve


def line_matrix(xs):
    x = np.array(xs, dtype=float)
    D = np.abs(x[:, None] - x[None, :])
    return D / 4.0, D  # 4 m/s


def test_five_stops_same_street_visited_continuously():
    # origem em 0; entregas embaralhadas ao longo da mesma rua
    xs = [0, 300, 100, 500, 200, 400]
    T, D = line_matrix(xs)
    res = solve(T, D, 0, [1, 2, 3, 4, 5], time_limit_s=2)
    assert [xs[i] for i in res.order] == [100, 200, 300, 400, 500]


def test_open_route_does_not_return_and_circular_does():
    xs = [0, 100, 200, 300]
    T, D = line_matrix(xs)
    open_ = solve(T, D, 0, [1, 2, 3], time_limit_s=1)
    t, d = evaluate(open_.order, T, D, 0, None, {})
    assert d == pytest.approx(300)
    circ = solve(T, D, 0, [1, 2, 3], end=0, time_limit_s=1)
    t, d = evaluate(circ.order, T, D, 0, 0, {})
    assert d == pytest.approx(600)


def test_fixed_end():
    xs = [0, 100, 200, 300, 50]
    T, D = line_matrix(xs)
    res = solve(T, D, 0, [1, 2, 3], end=4, time_limit_s=1)
    t, d = evaluate(res.order, T, D, 0, 4, {})
    assert d == pytest.approx(300 + 250)


def test_ignores_neighborhood_boundaries_by_default():
    # parada de outro "bairro" a poucos metros deve entrar na sequência natural
    xs = [0, 100, 110, 400]
    T, D = line_matrix(xs)
    # modo global (padrão): bairros (1,3)=A e 2=B não interferem na sequência
    res = solve(T, D, 0, [1, 2, 3], time_limit_s=1)
    assert res.order == [1, 2, 3]


def test_sectors_mode_groups_neighborhoods():
    xs = [0, 100, 110, 120, 130]
    T, D = line_matrix(xs)
    sector = {1: "A", 2: "B", 3: "A", 4: "B"}
    res = solve(T, D, 0, [1, 2, 3, 4], sector=sector, time_limit_s=2)
    labels = [sector[i] for i in res.order]
    assert labels in (["A", "A", "B", "B"], ["B", "B", "A", "A"])


def test_priority_moves_stop_earlier():
    xs = [0, 100, 200, 300, -400]
    T, D = line_matrix(xs)
    assert solve(T, D, 0, [1, 2, 3, 4], time_limit_s=1).order[-1] == 4
    res = solve(T, D, 0, [1, 2, 3, 4], priority={4: 5}, time_limit_s=2)
    assert res.order.index(4) == 0


def test_candidates_compared_and_not_worse_than_baseline():
    rng = np.random.default_rng(1)
    P = rng.uniform(0, 3000, size=(40, 2))
    D = np.linalg.norm(P[:, None] - P[None, :], axis=2) * 1.3
    T = D / 4.2
    res = solve(T, D, 0, list(range(1, 40)), time_limit_s=3)
    nn = nearest_neighbor(T, 0, list(range(1, 40)))
    t_nn, _ = evaluate(nn, T, D, 0, None, {})
    assert res.best.time_s <= t_nn + 1e-6
    assert {c.strategy for c in res.candidates} >= {"nearest_neighbor_baseline", "path_cheapest_arc"}
    assert sorted(res.order) == list(range(1, 40))


def test_service_time_counted():
    xs = [0, 100, 200]
    T, D = line_matrix(xs)
    res = solve(T, D, 0, [1, 2], service_s={1: 60, 2: 60}, time_limit_s=1)
    assert res.best.time_s == pytest.approx(200 / 4 + 120)
