"""Adaptadores externos com HTTP SIMULADO (mocks claramente identificados).
Testes reais com internet ficam em test_live_network.py (marcador `network`)."""

import numpy as np
import pytest

from app.core.config import Settings
from app.services.geocoding.providers import NominatimProvider, ProviderError, classify_nominatim
from app.services.routing.engines import ValhallaEngine, decode_polyline6
from roteamento.config import TravelProfile


class FakeResp:
    def __init__(self, status, payload):
        self.status_code = status
        self._p = payload
        self.text = str(payload)

    def json(self):
        return self._p

    def raise_for_status(self):
        if self.status_code >= 400:
            import requests
            raise requests.HTTPError(str(self.status_code))


class FakeSession:
    def __init__(self, responses):
        self.responses = list(responses)
        self.calls = []

    def get(self, url, params=None, headers=None, timeout=None):
        self.calls.append(("GET", url, params))
        return self.responses.pop(0)

    def post(self, url, json=None, timeout=None):
        self.calls.append(("POST", url, json))
        return self.responses.pop(0)


HOUSE = {"lat": "-23.948", "lon": "-46.3406", "category": "place", "type": "house", "osm_type": "node",
         "osm_id": 1, "display_name": "480, Rua Joaquim Távora, Santos",
         "address": {"house_number": "480", "road": "Rua Joaquim Távora", "city": "Santos", "postcode": "11075-301"}}
ROAD = {"lat": "-23.948", "lon": "-46.3406", "category": "highway", "type": "residential", "osm_type": "way",
        "osm_id": 2, "addresstype": "road", "display_name": "Rua Joaquim Távora, Santos",
        "address": {"road": "Rua Joaquim Távora", "city": "Santos"}}
INTERP = {**HOUSE, "osm_type": "way"}
SUBURB = {"lat": "-23.95", "lon": "-46.33", "category": "boundary", "type": "administrative",
          "addresstype": "suburb", "osm_type": "relation", "osm_id": 3, "display_name": "Marapé", "address": {}}


def test_precision_classification():
    assert classify_nominatim(HOUSE, "480").precision == "exact"
    assert classify_nominatim(INTERP, "480").precision == "interpolated"
    assert classify_nominatim(ROAD, "480").precision == "street"     # centro de rua ≠ número confirmado
    assert classify_nominatim(SUBURB, "480").precision == "neighborhood"
    assert classify_nominatim({**HOUSE, "address": {**HOUSE["address"], "house_number": "482"}}, "480").precision == "street"


def test_nominatim_retry_with_backoff(monkeypatch):
    monkeypatch.setattr("time.sleep", lambda s: None)
    s = Settings(geocoder_min_interval_s=0, geocoder_max_retries=2)
    fake = FakeSession([FakeResp(500, {}), FakeResp(429, {}), FakeResp(200, [HOUSE])])
    p = NominatimProvider(s, fake)
    res = p.search({"street": "480 Rua Joaquim Távora", "city": "Santos", "state": "SP", "country": "Brasil"})
    assert res[0].precision == "exact" and len(fake.calls) == 3
    params = fake.calls[0][2]
    assert "Pessoa" not in str(params) and params["street"] == "480 Rua Joaquim Távora"


def test_nominatim_gives_up(monkeypatch):
    monkeypatch.setattr("time.sleep", lambda s: None)
    p = NominatimProvider(Settings(geocoder_min_interval_s=0, geocoder_max_retries=1),
                          FakeSession([FakeResp(503, {}), FakeResp(503, {})]))
    with pytest.raises(ProviderError):
        p.search({"street": "1 Rua X", "city": "Santos"})


def test_polyline6_decoding():
    # "_izlhA~rlgdF_{geC~ywl@_kwzCn`{nI" -> exemplo do formato polyline com precisão 6
    pts = decode_polyline6("_izlhA~rlgdF_{geC~ywl@_kwzCn`{nI")
    assert pts[0] == pytest.approx([-120.2, 38.5])
    assert pts[-1] == pytest.approx([-126.453, 43.252])


def test_valhalla_adapter_uses_pedestrian_costing():
    s = Settings(valhalla_url="http://valhalla.test")
    locate = [{"edges": [{"correlated_lat": -23.948, "correlated_lon": -46.3406}]},
              {"edges": [{"correlated_lat": -23.9512, "correlated_lon": -46.3389}]}]
    matrix = {"sources_to_targets": [[{"time": 0, "distance": 0}, {"time": 100, "distance": 0.4}],
                                     [{"time": 110, "distance": 0.42}, {"time": 0, "distance": 0}]]}
    route = {"trip": {"legs": [{"shape": "_izlhA~rlgdF_{geC~ywl@", "summary": {"length": 0.4, "time": 100}}]}}
    fake = FakeSession([FakeResp(200, {"tileset_last_modified": 123}), FakeResp(200, locate),
                        FakeResp(200, matrix), FakeResp(200, route)])
    eng = ValhallaEngine(s, fake)
    sess = eng.matrix([(-23.948, -46.3406), (-23.9512, -46.3389)], TravelProfile(ride_speed_kmh=14), 150)
    assert sess.time_s[0, 1] == 100 and sess.dist_m[1, 0] == pytest.approx(420)
    body = fake.calls[2][2]
    assert body["costing"] == "pedestrian"
    assert body["costing_options"]["pedestrian"]["walking_speed"] == 14
    leg = sess.leg(0, 1)
    assert leg.features[0]["geometry"]["type"] == "LineString"
    assert np.isfinite(sess.time_s).all()
