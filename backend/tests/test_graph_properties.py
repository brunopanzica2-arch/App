"""Seção 4 da auditoria V2: grafo, matemática e geometria (grafos mínimos + referência NetworkX)."""

from __future__ import annotations

import math
import random

import networkx as nx
import numpy as np
import pytest

from app.services.optimization import feasibility, solve, validate
from roteamento.config import TravelProfile
from roteamento.network import build_network, haversine
from roteamento.osm_data import OsmData
from roteamento.router import Router

D = 0.001


def osm(nodes, ways, node_tags=None):
    d = OsmData()
    d.nodes = dict(nodes)
    d.ways = {i + 1: (r, t) for i, (r, t) in enumerate(ways)}
    d.node_tags = node_tags or {}
    return d


def router(net, **p):
    return Router(net, TravelProfile(sidewalk_mode="ride", **p))


# ---------------------------------------------------------------- 1, 2: paradas virtuais


@pytest.mark.parametrize("k", [2, 3, 5, 10])
def test_many_virtual_stops_on_same_edge_mixed_order(k):
    net = build_network(osm({1: (0, 0), 2: (0, 10 * D)}, [([1, 2], {"highway": "residential"})]))
    r = router(net)
    rnd = random.Random(k)
    ts = [rnd.uniform(0.02, 0.98) for _ in range(k)]
    pts = [(0.0, 0.0)] + [(0.0, t * 10 * D) for t in ts]
    s = r.solver([r.snap(a, b, 50) for a, b in pts])
    T, Dm = s.matrices()
    for i in range(1, k + 1):
        for j in range(1, k + 1):
            exp = abs(ts[i - 1] - ts[j - 1]) * haversine(0, 0, 0, 10 * D)
            assert Dm[i, j] == pytest.approx(exp, abs=0.05)
    # leg() bate com a matriz em cada par
    for i in range(k + 1):
        for j in range(k + 1):
            arcs = s.path_arcs(i, j)
            assert sum(float(s.length[a]) for a in arcs) == pytest.approx(Dm[i, j], abs=1e-6)


def test_point_exactly_on_node_and_near_ends():
    net = build_network(osm({1: (0, 0), 2: (0, D), 3: (D, D)},
                            [([1, 2, 3], {"highway": "residential"})]))
    r = router(net)
    for lat, lon in [(0, D), (0, 1e-9), (0, D - 1e-9), (D, D)]:
        sn = r.snap(lat, lon, 20)
        assert sn.distance_m < 0.01
    s = r.solver([r.snap(0, 0, 5), r.snap(0, D, 5), r.snap(D, D, 5)])
    T, Dm = s.matrices()
    assert Dm[0, 2] == pytest.approx(2 * haversine(0, 0, 0, D), rel=1e-3)


# ---------------------------------------------------------------- 4, 5: cruzamentos sem nó, ponte


def test_crossing_without_shared_node_is_not_a_connection():
    """Ponte (layer=1) cruza a rua de baixo sem nó em comum: não há ligação entre elas."""
    nodes = {1: (0, -D), 2: (0, D), 3: (-D, 0), 4: (D, 0)}
    ways = [([1, 2], {"highway": "residential", "name": "baixo"}),
            ([3, 4], {"highway": "residential", "bridge": "yes", "layer": "1", "name": "ponte"})]
    r = router(build_network(osm(nodes, ways)))
    o, reach = r.snap_origin(0, -D, 10)
    assert reach.sum() == 2  # só a própria rua de baixo
    with pytest.raises(Exception):
        r.snap(D, 0, 10, reach)


def test_parallel_streets_close_but_unconnected_are_flagged():
    nodes = {1: (0, 0), 2: (0, 4 * D), 3: (0.00018, 0), 4: (0.00018, 4 * D)}  # ~20 m
    ways = [([1, 2], {"highway": "residential"}), ([3, 4], {"highway": "residential"})]
    r = router(build_network(osm(nodes, ways)))
    _, reach = r.snap_origin(0, 0, 10)
    sn = r.snap(0.00025, 2 * D, 60, reach)  # mais perto da rua desconectada
    assert "via_mais_proxima_desconectada" in sn.flags and "acesso_cruza_outra_via" in sn.flags


# ---------------------------------------------------------------- 6-9: sentidos, escadas, barreiras


def test_car_oneway_both_directions_foot_oneway_respected():
    nodes = {1: (0, 0), 2: (0, D), 3: (D, D), 4: (D, 0)}
    ways = [([1, 2], {"highway": "residential", "oneway": "yes"}),
            ([2, 3], {"highway": "footway", "oneway:foot": "yes", "bicycle": "yes"}),
            ([3, 4, 1], {"highway": "residential"})]
    r = router(build_network(osm(nodes, ways)))
    s = r.solver([r.snap(0, 0, 5), r.snap(0, D, 5), r.snap(D, D, 5)])
    T, Dm = s.matrices()
    assert Dm[1, 0] == pytest.approx(haversine(0, 0, 0, D), rel=1e-3)  # contramão de carro: ok
    assert Dm[2, 1] > Dm[1, 2] * 2  # pedestre não volta pela passagem de mão única


@pytest.mark.parametrize("policy,uses", [("allow", True), ("penalize", None), ("forbid", False)])
def test_steps_policies(policy, uses):
    nodes = {1: (0, 0), 2: (0, D), 3: (D, D), 4: (D, 0)}
    ways = [([1, 2], {"highway": "steps"}), ([2, 3, 4, 1], {"highway": "residential"})]
    r = router(build_network(osm(nodes, ways)), steps_policy=policy, ride_speed_kmh=1, steps_speed_factor=1)
    s = r.solver([r.snap(0, 0, 5), r.snap(0, D, 5)])
    s.matrices()
    used = any(s.arc_info(a)["mode"] == "steps" for a in s.path_arcs(0, 1))
    if uses is not None:
        assert used is uses


def test_wall_and_locked_gate_block():
    nodes = {1: (0, 0), 2: (0, D), 3: (0, 2 * D), 4: (D, 0), 5: (D, 2 * D)}
    ways = [([1, 2, 3], {"highway": "footway", "bicycle": "yes"}), ([1, 4, 5, 3], {"highway": "residential"})]
    for tags in ({"barrier": "wall"}, {"barrier": "gate", "locked": "yes"}):
        r = router(build_network(osm(nodes, ways, {2: tags})))
        s = r.solver([r.snap(0, 0, 5), r.snap(0, 2 * D, 5)])
        T, Dm = s.matrices()
        assert Dm[0, 1] > 3 * haversine(0, 0, 0, D)  # contorna pelo quarteirão


# ---------------------------------------------------------------- 12, 13: matriz x referência


def random_osm(seed, n=25):
    rnd = random.Random(seed)
    nodes = {i: (rnd.uniform(0, 5 * D), rnd.uniform(0, 5 * D)) for i in range(1, n + 1)}
    ways = []
    for i in range(1, n + 1):
        for j in rnd.sample(range(1, n + 1), 2):
            if i != j:
                tags = {"highway": rnd.choice(["residential", "footway", "path"]), "bicycle": "yes"}
                if rnd.random() < 0.3:
                    tags["oneway:foot"] = "yes"
                ways.append(([i, j], tags))
    return osm(nodes, ways)


@pytest.mark.parametrize("seed", range(6))
def test_matrix_matches_networkx_reference(seed):
    net = build_network(random_osm(seed))
    r = router(net)
    G = nx.DiGraph()
    for e in range(net.n_edges):
        a, b = net.ea[e], net.eb[e]
        w = float(r.w_fwd[e]), float(r.w_bwd[e])
        if net.efwd[e]:
            G.add_edge(a, b, w=min(w[0], G.get_edge_data(a, b, {"w": math.inf})["w"]))
        if net.ebwd[e]:
            G.add_edge(b, a, w=min(w[1], G.get_edge_data(b, a, {"w": math.inf})["w"]))
    nodes = list(range(min(8, net.n_nodes)))
    snaps = [r.snap(net.lat[v], net.lon[v], 1) for v in nodes]
    s = r.solver(snaps)
    T, Dm = s.matrices()
    k = len(nodes)
    assert np.all(np.diag(T) == 0) and np.all(T[np.isfinite(T)] >= 0) and np.all(Dm[np.isfinite(Dm)] >= 0)
    for i in range(k):
        src = snaps[i].node
        ref = nx.single_source_dijkstra_path_length(G, src, weight="w")
        for j in range(k):
            tgt = snaps[j].node
            if tgt in ref:
                assert T[i, j] == pytest.approx(ref[tgt], rel=1e-6, abs=1e-6)
            else:
                assert not math.isfinite(T[i, j])


# ---------------------------------------------------------------- 15, 17: propriedades da rota


def asym(seed, n, p_inf=0.0):
    rng = np.random.default_rng(seed)
    P = rng.uniform(0, 3000, size=(n, 2))
    Dm = np.linalg.norm(P[:, None] - P[None, :], axis=2) * rng.uniform(1.0, 1.6, size=(n, n))
    np.fill_diagonal(Dm, 0)
    T = Dm / 4.2
    if p_inf:
        mask = rng.random((n, n)) < p_inf
        np.fill_diagonal(mask, False)
        mask[0, :] = False
        T[mask] = np.inf
        Dm[mask] = np.inf
    return T, Dm


@pytest.mark.parametrize("n,p_inf,mode", [(20, 0.0, "open"), (40, 0.05, "open"), (40, 0.05, "circular"),
                                          (150, 0.0, "open"), (60, 0.2, "open")])
def test_route_validity_properties(n, p_inf, mode):
    T, Dm = asym(n, n, p_inf)
    stops = list(range(1, n))
    end = 0 if mode == "circular" else None
    f = feasibility(T, 0, stops, end)
    assert len(f.kept) + len(f.excluded) == len(stops)  # nenhuma parada some sem motivo
    res = solve(T, Dm, 0, f.kept, end, time_limit_s=2, comp_rank=f.comp_rank)
    assert validate(res.order, T, 0, f.kept, end) == []
    assert res.best.feasible


def test_reproducible_with_same_inputs():
    T, Dm = asym(7, 30)
    a = solve(T, Dm, 0, list(range(1, 30)), time_limit_s=1, strategies=["path_cheapest_arc"])
    b = solve(T, Dm, 0, list(range(1, 30)), time_limit_s=1, strategies=["path_cheapest_arc"])
    assert a.best.time_s == pytest.approx(b.best.time_s, rel=0.01)


# ---------------------------------------------------------------- 16: polígonos de praça


def test_degenerate_and_concave_areas_do_not_create_shortcuts():
    # anel com nós repetidos e área nula: nenhuma travessia criada
    nodes = {1: (0, 0), 2: (0, D), 3: (0, 2 * D), 9: (-D, 0), 8: (-D, 2 * D)}
    ways = [([1, 2, 3, 2, 1], {"highway": "pedestrian", "area": "yes"}),
            ([9, 1], {"highway": "residential"}), ([3, 8], {"highway": "residential"})]
    net = build_network(osm(nodes, ways))
    assert not any(f & 4 for f in net.eflags)
