"""Testes que EXIGEM INTERNET (serviços públicos reais). Executar com:
    RUN_NETWORK_TESTS=1 pytest -m network
Usam os servidores públicos apenas para validação pontual — não para produção."""

import os

import pytest

from app.core.config import Settings
from app.services.geocoding.providers import NominatimProvider
from roteamento.config import TravelProfile
from roteamento.network import build_network
from roteamento.osm_data import fetch_osm_api_tiles
from roteamento.router import Router

pytestmark = [
    pytest.mark.network,
    pytest.mark.skipif(os.environ.get("RUN_NETWORK_TESTS") != "1", reason="requer internet (RUN_NETWORK_TESTS=1)"),
]


def test_nominatim_start_address_is_not_claimed_exact_without_number():
    p = NominatimProvider(Settings())
    res = p.search({"street": "480 Rua Joaquim Távora", "city": "Santos", "state": "SP", "country": "Brasil"})
    assert res, "Nominatim não retornou resultados"
    best = res[0]
    assert best.city == "Santos"
    # se o OSM não tiver o número 480, o resultado deve ser marcado como aproximado
    if not best.house_number:
        assert best.precision in ("street", "neighborhood")


def test_real_osm_pedestrian_matrix_around_start():
    bbox = (-23.954, -46.346, -23.944, -46.334)
    net = build_network(fetch_osm_api_tiles(bbox))
    assert net.n_edges > 500
    r = Router(net, TravelProfile(ride_speed_kmh=15))
    pts = [(-23.9480025, -46.3406209), (-23.9512, -46.3389), (-23.9470, -46.3400)]
    s = r.solver([r.snap(a, b, 150) for a, b in pts])
    T, D = s.matrices()
    assert (T[T > 0] < 3600).all()
    from roteamento.network import haversine
    for i in range(3):
        for j in range(3):
            if i != j:
                assert D[i, j] >= haversine(*pts[i], *pts[j]) * 0.95  # rede, não linha reta
