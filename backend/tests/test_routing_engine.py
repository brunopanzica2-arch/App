"""Motor pedestre sobre malha SINTÉTICA."""

import numpy as np
import pytest

from roteamento.config import TravelProfile
from roteamento.network import Network, build_network, classify_barrier, classify_way, haversine
from roteamento.osm_data import OsmData
from roteamento.router import Router, SnapError

from .synthetic import STEP, S, W, grid_osm, island_point


def pt(r, c):
    return (S + r * STEP, W + c * STEP)


@pytest.fixture(scope="module")
def net():
    return build_network(grid_osm())


def solver(net, points, **prof):
    r = Router(net, TravelProfile(**prof))
    return r, r.solver([r.snap(a, b, 150) for a, b in points])


def test_car_oneway_does_not_restrict_pedestrian_profile(net):
    _, s = solver(net, [pt(1, 2), pt(1, 9)])  # rua 1 é mão única p/ carros
    T, D = s.matrices()
    assert np.isfinite(T).all()
    assert D[0, 1] == pytest.approx(D[1, 0], rel=1e-6)
    assert D[1, 0] == pytest.approx(haversine(*pt(1, 2), *pt(1, 9)), rel=0.01)
    arcs = s.path_arcs(1, 0)
    assert any("contramao_veiculos" in s.arc_info(a)["flags"] for a in arcs)


def test_oneway_foot_is_respected():
    d = OsmData(nodes={1: (0, 0), 2: (0, 0.001), 3: (0.001, 0.001), 4: (0.001, 0)})
    d.ways = {1: ([1, 2], {"highway": "footway", "oneway:foot": "yes", "bicycle": "yes"}),
              2: ([2, 3, 4, 1], {"highway": "residential"})}
    n = build_network(d)
    r = Router(n, TravelProfile())
    s = r.solver([r.snap(0, 0, 50), r.snap(0, 0.001, 50)])
    T, D = s.matrices()
    assert D[0, 1] == pytest.approx(haversine(0, 0, 0, 0.001), rel=1e-3)
    assert D[1, 0] > 2.5 * D[0, 1]  # volta obrigatoriamente pelo contorno


def test_ride_speed_used_not_walking_speed(net):
    _, s = solver(net, [pt(2, 1), pt(2, 8)], ride_speed_kmh=18)
    T, D = s.matrices()
    assert T[0, 1] == pytest.approx(D[0, 1] / (18 / 3.6), rel=1e-3)


def test_cycleway_not_prioritized(net):
    # ciclovia paralela à rua 5 com o mesmo comprimento: não ganha bônus
    _, s = solver(net, [pt(5, 0), pt(5, 20)])
    arcs = s.path_arcs(0, 1)
    T, D = s.matrices()
    assert T[0, 1] == pytest.approx(D[0, 1] / (15 / 3.6), rel=1e-3)
    assert {s.arc_info(a)["mode"] for a in arcs} == {"ride"}


def test_steps_flagged_and_policies(net):
    a, b = pt(2, 2), pt(3, 3)
    # (velocidades artificiais só para forçar o uso da escada neste teste)
    _, s = solver(net, [a, b], steps_policy="allow", steps_penalty_s=0, ride_speed_kmh=1,
                  steps_speed_factor=1)
    arcs = s.path_arcs(0, 1)
    assert any(s.arc_info(x)["mode"] == "steps" for x in arcs)
    assert any("escada" in s.arc_info(x)["flags"] for x in arcs)
    _, s2 = solver(net, [a, b], steps_policy="forbid")
    assert not any(s2.arc_info(x)["mode"] == "steps" for x in s2.path_arcs(0, 1))


def test_private_access_policy(net):
    a, b = pt(4, 4), pt(5, 5)
    _, s = solver(net, [a, b], private_policy="allow")
    assert any("acesso_privado" in s.arc_info(x)["flags"] for x in s.path_arcs(0, 1))
    _, s2 = solver(net, [a, b], private_policy="forbid")
    assert not any("acesso_privado" in s2.arc_info(x)["flags"] for x in s2.path_arcs(0, 1))


def test_walls_block_and_cycle_barriers_flagged(net):
    assert classify_barrier({"barrier": "wall"}) == "block"
    assert classify_barrier({"barrier": "cycle_barrier"}) == "barrier"
    assert classify_barrier({"barrier": "gate", "access": "private"}) == "private"
    assert classify_barrier({"barrier": "gate", "locked": "yes"}) == "block"
    _, s = solver(net, [pt(8, 8), pt(9, 9)])
    D = s.matrices()[1]
    assert D[0, 1] > 1.3 * haversine(*pt(8, 8), *pt(9, 9))  # contorna o muro
    _, s = solver(net, [pt(6, 6), pt(7, 7)], barrier_policy="allow", sidewalk_mode="ride")
    assert any("barreira" in s.arc_info(x)["flags"] for x in s.path_arcs(0, 1))


def test_sidewalk_is_walk_mode_by_default():
    assert classify_way({"highway": "footway"}).flags & 8
    assert classify_way({"highway": "footway", "bicycle": "yes"}).flags == 0
    assert classify_way({"highway": "motorway"}) is None
    assert classify_way({"highway": "residential", "access": "no"}) is None
    assert classify_way({"highway": "construction"}) is None


def test_disconnected_island_is_not_snapped(net):
    r = Router(net, TravelProfile())
    with pytest.raises(SnapError):
        r.snap(*island_point(), 150)


def test_geometry_follows_real_edges(net):
    _, s = solver(net, [pt(0, 0), pt(10, 15)])
    arcs = s.path_arcs(0, 1)
    edges = {(round(net.lat[a], 7), round(net.lon[a], 7), round(net.lat[b], 7), round(net.lon[b], 7))
             for a, b in zip(net.ea, net.eb)}
    for x in arcs:
        (lo1, la1), (lo2, la2) = s.arc_coords(x)
        k1 = (round(la1, 7), round(lo1, 7), round(la2, 7), round(lo2, 7))
        k2 = (round(la2, 7), round(lo2, 7), round(la1, 7), round(lo1, 7))
        assert k1 in edges or k2 in edges or int(s.src[x]) >= net.n_nodes or int(s.dst[x]) >= net.n_nodes
    D = s.matrices()[1]
    assert D[0, 1] >= haversine(*pt(0, 0), *pt(10, 15))


def test_pedestrian_area_crossing_only_inside_polygon():
    # praça quadrada com 4 acessos; diagonal atravessa a área (permitido)
    d = OsmData(nodes={1: (0, 0), 2: (0, 0.001), 3: (0.001, 0.001), 4: (0.001, 0),
                       11: (-0.0005, 0), 13: (0.0015, 0.001)})
    d.ways = {1: ([1, 2, 3, 4, 1], {"highway": "pedestrian", "area": "yes"}),
              2: ([11, 1], {"highway": "residential"}), 3: ([3, 13], {"highway": "residential"})}
    n = build_network(d)
    assert any(f & 4 for f in n.eflags)  # aresta de travessia de praça
    r = Router(n, TravelProfile())
    s = r.solver([r.snap(-0.0005, 0, 10), r.snap(0.0015, 0.001, 10)])
    D = s.matrices()[1]
    assert D[0, 1] < haversine(0, 0, 0, 0.001) * 2 + 120
    # área côncava (em L): a ligação que sairia do polígono não é criada
    d2 = OsmData(nodes={1: (0, 0), 2: (0, 0.002), 3: (0.001, 0.002), 4: (0.001, 0.001),
                        5: (0.002, 0.001), 6: (0.002, 0), 21: (-0.001, 0.002), 25: (0.003, 0.001)})
    d2.ways = {1: ([1, 2, 3, 4, 5, 6, 1], {"highway": "pedestrian", "area": "yes"}),
               2: ([2, 21], {"highway": "residential"}), 3: ([5, 25], {"highway": "residential"})}
    n2 = build_network(d2)
    crossings = [(n2.osm_id[a], n2.osm_id[b]) for a, b, f in zip(n2.ea, n2.eb, n2.eflags) if f & 4]
    assert (2, 5) not in crossings and (5, 2) not in crossings


def test_matrix_matches_path_reconstruction(net):
    pts = [pt(1, 1), pt(7, 3), pt(12, 20), pt(20, 5), pt(15, 30)]
    _, s = solver(net, pts)
    T, D = s.matrices(chunk=2)
    for i in range(len(pts)):
        for j in range(len(pts)):
            arcs = s.path_arcs(i, j)
            assert sum(s.arc_time(a) for a in arcs) == pytest.approx(T[i, j], abs=1e-6)
            assert sum(float(s.length[a]) for a in arcs) == pytest.approx(D[i, j], abs=1e-6)


def test_snap_distance_reported(net):
    r = Router(net, TravelProfile())
    lat, lon = pt(3, 3)
    sn = r.snap(lat + 0.0003, lon + 0.00045, 150)
    assert 20 < sn.distance_m < 60
    assert isinstance(net, Network)
