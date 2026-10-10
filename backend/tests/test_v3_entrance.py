"""V3 §4 (backend): portaria separada da posição do endereço; histórico e reversão; hierarquia de confiança."""
from .synthetic import S, W
from .test_flow_api import upload


def _first_stop(client, h):
    _, r = upload(client, h)
    bid = r.json()["batch"]["id"]
    stops = client.get(f"/api/batches/{bid}/stops", headers=h).json()
    s = next(x for x in stops if x["address"]["normalized_text"].startswith("Rua Alfa, 100"))
    return bid, s["address"]["id"]


def test_entrance_is_separate_from_address_position_and_reversible(client, auth):
    h = auth["dispatcher"]
    bid, aid = _first_stop(client, h)
    a0 = client.get(f"/api/batches/{bid}/addresses", headers=h).json()
    a0 = next(x for x in a0 if x["id"] == aid)
    assert a0["entrance"] is None and a0["trust"]["level"] in (3, 5)

    # 1) pino confirmado: nível 2, não é portaria
    r = client.post(f"/api/addresses/{aid}/confirm", json={"lat": S + 0.0001, "lon": W + 0.0001}, headers=h)
    assert r.status_code == 200 and r.json()["trust"]["code"] == "pin"
    # 2) portaria confirmada: nível 1; posição postal preservada
    r = client.put(f"/api/addresses/{aid}/entrance", json={"lat": S + 0.0002, "lon": W + 0.0002, "note": "portão azul"}, headers=h)
    a = r.json()
    assert r.status_code == 200 and a["trust"]["code"] == "entrance" and a["entrance"]["note"] == "portão azul"
    assert (a["lat"], a["lon"]) == (S + 0.0001, W + 0.0001)
    # as paradas passam a usar a portaria como ponto de rota
    stop = next(s for s in client.get(f"/api/batches/{bid}/stops", headers=h).json() if s["address"]["id"] == aid)
    assert (stop["lat"], stop["lon"]) == (S + 0.0002, W + 0.0002)
    # 3) reverter: volta ao pino; reverter de novo: volta ao geocodificado
    a = client.post(f"/api/addresses/{aid}/revert", headers=h).json()
    assert a["entrance"] is None and a["trust"]["code"] == "pin"
    a = client.post(f"/api/addresses/{aid}/revert", headers=h).json()
    assert (a["lat"], a["lon"]) == (a0["lat"], a0["lon"]) and a["precision"] == a0["precision"]
    assert client.post(f"/api/addresses/{aid}/revert", headers=h).status_code == 409
    assert client.get(f"/api/addresses/{aid}/history", headers=h).json() == []


def test_invalid_coordinates_and_invalidate(client, auth):
    h = auth["dispatcher"]
    bid, aid = _first_stop(client, h)
    assert client.put(f"/api/addresses/{aid}/entrance", json={"lat": 95, "lon": 0}, headers=h).status_code == 422
    client.put(f"/api/addresses/{aid}/entrance", json={"lat": S, "lon": W}, headers=h)
    a = client.post(f"/api/addresses/{aid}/invalidate", headers=h).json()
    assert a["entrance"] is None and a["needs_review"] is True and a["confirmed_at"] is None
    assert a["trust"]["approximate"] is True or a["trust"]["level"] <= 3  # volta para revisão, coordenada mantida
    assert client.delete(f"/api/addresses/{aid}/entrance", headers=h).status_code == 200


def test_entrance_requires_authentication(client):
    r = client.put("/api/addresses/00000000-0000-0000-0000-000000000000/entrance", json={"lat": 0, "lon": 0})
    assert r.status_code in (401, 403)
