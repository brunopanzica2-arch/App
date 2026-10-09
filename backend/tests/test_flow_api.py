"""Fluxo vertical via API: importar -> validar -> geocodificar (MOCK) -> agrupar ->
matriz de pedestres (malha SINTÉTICA) -> otimizar -> rota -> entregas -> recálculo
-> relatório -> sincronização offline. Dados 100% sintéticos."""

import io
import uuid
from datetime import datetime, timedelta, timezone

import pytest
from openpyxl import Workbook

from .synthetic import STEP, S, W

CSV = """identificador;destinatario;logradouro;numero;complemento;bairro;cep;observacoes
OBJ001;Pessoa Teste Um;Rua Alfa;100;apto 1;Centro;11010-000;
OBJ002;Pessoa Teste Dois;R. Alfa;100;apto 2;Centro;11010-000;mesmo prédio, outra carta
OBJ003;Pessoa Teste Tres;Rua Alfa;100;apto 1;Centro;11010-000;mesmo destinatário/endereço, carta distinta
OBJ004;Pessoa Teste Quatro;Rua Beta;250;;Gonzaga;11060-000;
OBJ005;Pessoa Teste Cinco;Avenida Gama;800;;Boqueirão;;
OBJ006;Pessoa Teste Seis;Rua Delta;1200;casa;Embaré;;
OBJ007;Pessoa Teste Sete;Rua Inexistente;5;;Centro;;
OBJ008;Pessoa Teste Oito;;;;Centro;;sem logradouro
OBJ004;Pessoa Teste Quatro;Rua Beta;250;;Gonzaga;11060-000;linha duplicada (mesmo identificador)
OBJ009;Pessoa Teste Nove;Rua Epsilon;S/N;;Centro;;
"""


def upload(client, h, content=CSV, name="lote.csv", ref="Lote teste", **extra):
    pv = client.post("/api/imports/preview", files={"file": (name, content.encode() if isinstance(content, str) else content)},
                     headers=h)
    assert pv.status_code == 200, pv.text
    data = {"mapping": __import__("json").dumps(pv.json()["mapping"]), "reference": ref,
            "service_date": "2026-10-09", **{k: str(v) for k, v in extra.items()}}
    r = client.post("/api/imports/commit", files={"file": (name, content.encode() if isinstance(content, str) else content)},
                    data=data, headers=h)
    return pv.json(), r


def confirm_start(client, h):
    r = client.put("/api/settings/start", json={"label": "Base (teste sintético)", "lat": S + 0.0005, "lon": W + 0.0005},
                   headers=h)
    assert r.status_code == 200


def test_full_flow(client, auth):
    h = auth["dispatcher"]
    preview, r = upload(client, h)
    assert preview["mapping"]["street"] == "logradouro"
    assert preview["mapping"]["external_id"] == "identificador"
    assert preview["duplicate_ids_in_file"] == ["OBJ004"]
    assert "recipient" not in preview["rows"][0]["values"]  # prévia não expõe nomes
    assert r.status_code == 201, r.text
    batch = r.json()["batch"]
    rep = batch["import_report"]
    assert rep["inserted"] == 9            # nenhuma carta distinta descartada
    assert rep["duplicates"][0]["external_id"] == "OBJ004"
    assert any(e["row_number"] == 9 for e in rep["with_errors"])  # sem logradouro: registrada c/ erro
    bid = batch["id"]

    # geocodificação + consolidação (job inline nos testes)
    info = client.get(f"/api/batches/{bid}", headers=h).json()
    assert info["last_job"]["status"] == "done", info["last_job"]
    assert info["precision_counts"].get("not_found") == 1  # Rua Inexistente
    assert info["precision_counts"].get("street") == 1     # S/N => ponto aproximado na rua
    stops = client.get(f"/api/batches/{bid}/stops", headers=h).json()
    by_addr = {s["address"]["normalized_text"].split(" - ")[0]: s for s in stops}
    alfa = by_addr["Rua Alfa, 100"]
    assert alfa["letters"] == 3            # 3 cartas, 1 parada; cartas preservadas
    assert len({c["id"] for c in alfa["correspondences"]}) == 3
    assert len(stops) == 5                 # Alfa, Beta, Gama, Delta, Epsilon(aprox.)
    review = client.get(f"/api/batches/{bid}/addresses?needs_review=true", headers=h).json()
    assert {a["precision"] for a in review} >= {"not_found", "street"}

    # sem ponto de partida confirmado => bloqueia
    r = client.post(f"/api/batches/{bid}/routes", json={"run_async": False}, headers=h)
    assert r.status_code == 409
    confirm_start(client, h)

    r = client.post(f"/api/batches/{bid}/routes", json={"run_async": False, "time_limit_s": 2}, headers=h)
    assert r.status_code == 202, r.text
    route = r.json()["route"]
    assert route["version"] == 1 and route["route_mode"] == "open"
    assert route["engine"] == "internal-osm-pedestrian"
    full = client.get(f"/api/routes/{route['id']}", headers=h).json()
    assert [s["sequence"] for s in full["stops"]] == list(range(1, 6))
    feats = [f for f in full["geojson"]["features"] if f["properties"]["kind"] == "path"]
    assert feats and all(len(f["geometry"]["coordinates"]) >= 2 for f in feats)
    assert full["total_distance_m"] > 0 and full["service_time_s"] > 0
    assert full["metrics"]["timings_ms"]["matrix_ms"] >= 0
    assert any(c["strategy"] == "nearest_neighbor_baseline" for c in full["candidates"])

    # ativa e registra entregas
    assert client.post(f"/api/routes/{route['id']}/activate", headers=h).json()["status"] == "active"
    courier = auth["courier"]
    full = client.get(f"/api/routes/{route['id']}", headers=h).json()
    first = next(s for s in full["stops"] if s["id"] != alfa["id"])
    alfa_stop = next(s for s in full["stops"] if s["id"] == alfa["id"])
    c1, c2, c3 = alfa_stop["correspondences"]
    assert c1["status"] == "in_route"
    for c, st in ((c1, "delivered"), (c2, "not_delivered")):
        r = client.post(f"/api/correspondences/{c['id']}/events",
                        json={"status": st, "reason": "ausente" if st != "delivered" else None,
                              "route_id": route["id"], "client_event_id": f"ev-{c['id']}"}, headers=courier)
        assert r.status_code == 201, r.text
    # idempotência
    r = client.post(f"/api/correspondences/{c1['id']}/events",
                    json={"status": "delivered", "client_event_id": f"ev-{c1['id']}"}, headers=courier)
    assert r.json()["duplicate"] is True
    stops = {s["id"]: s for s in client.get(f"/api/batches/{bid}/stops", headers=h).json()}
    assert stops[alfa["id"]]["status"] == "partial"   # 3 cartas: 2 tratadas, 1 pendente

    # conclui a primeira parada inteira e recalcula a partir dela
    for c in first["correspondences"]:
        if c["status"] in ("pending", "in_route"):
            client.post(f"/api/correspondences/{c['id']}/events",
                        json={"status": "delivered", "route_id": route["id"]}, headers=courier)
    r = client.post(f"/api/routes/{route['id']}/reoptimize",
                    json={"origin": "last_completed", "run_async": False, "time_limit_s": 1}, headers=courier)
    assert r.status_code == 202, r.text
    v2 = r.json()["route"]
    assert v2["version"] == 2 and v2["parent_route_id"] == route["id"]
    assert v2["start"]["label"].startswith("Última parada atendida")
    v2full = client.get(f"/api/routes/{v2['id']}", headers=h).json()
    ids_v2 = {s["id"] for s in v2full["stops"]}
    assert first["id"] not in ids_v2           # concluída não volta ao roteiro
    assert alfa["id"] in ids_v2                # parcial continua (carta pendente)
    versions = client.get(f"/api/batches/{bid}/routes", headers=h).json()
    assert [v["version"] for v in versions] == [2, 1]  # histórico preservado
    events = client.get(f"/api/correspondences/{c1['id']}/events", headers=h).json()
    assert events[0]["status"] == "delivered"

    # localização atual exige consentimento
    r = client.post(f"/api/routes/{v2['id']}/reoptimize", json={"origin": "current_location", "lat": S, "lon": W,
                                                                 "run_async": False}, headers=courier)
    assert r.status_code == 422

    # relatório e exportação
    rep = client.get(f"/api/batches/{bid}/report", headers=h).json()
    assert rep["correspondences"] == 9 and rep["status_counts"]["delivered"] >= 2
    assert rep["recorded"]["distance_travelled_m"] is None  # não inventa distância percorrida
    assert rep["planned"]["note"].startswith("Estimativa")
    csv_resp = client.get(f"/api/batches/{bid}/export?format=csv", headers=courier)
    assert csv_resp.status_code == 200
    text = csv_resp.content.decode("utf-8-sig")
    assert "destinatario" not in text.splitlines()[0] and "Pessoa Teste" not in text  # courier sem permissão
    xlsx = client.get(f"/api/batches/{bid}/export?format=xlsx", headers=h)
    assert xlsx.status_code == 200 and xlsx.content[:2] == b"PK"


def test_offline_sync_idempotent_and_conflicts(client, auth):
    h = auth["dispatcher"]
    _, r = upload(client, h, CSV.replace("OBJ0", "SYN0"), ref="Sync")
    bid = r.json()["batch"]["id"]
    items = client.get(f"/api/batches/{bid}/correspondences", headers=h).json()["items"]
    cid = items[0]["id"]
    now = datetime.now(timezone.utc)
    body = {"client_id": "celular-1", "events": [
        {"client_event_id": "c1-1", "kind": "delivery_event", "correspondence_id": cid, "status": "postponed",
         "occurred_at": (now - timedelta(minutes=5)).isoformat()},
        {"client_event_id": "c1-2", "kind": "delivery_event", "correspondence_id": cid, "status": "delivered",
         "occurred_at": now.isoformat()},
    ]}
    res = client.post("/api/sync", json=body, headers=auth["courier"]).json()["results"]
    assert [x["status"] for x in res] == ["applied", "applied"]
    res = client.post("/api/sync", json=body, headers=auth["courier"]).json()["results"]
    assert all(x["duplicate"] for x in res)
    late = {"client_id": "celular-2", "events": [
        {"client_event_id": "c2-1", "kind": "delivery_event", "correspondence_id": cid, "status": "not_delivered",
         "reason": "ausente", "occurred_at": (now - timedelta(minutes=1)).isoformat()}]}
    res = client.post("/api/sync", json=late, headers=auth["dispatcher"]).json()["results"]
    assert res[0]["status"] == "conflict" and res[0]["result"]["server_status"] == "delivered"
    evs = client.get(f"/api/correspondences/{cid}/events", headers=h).json()
    assert len(evs) == 3  # conflito preservado no histórico


def test_authorization_and_privacy(client, auth, db):
    from app.models import Organization, User
    from app.core.security import hash_password

    h = auth["dispatcher"]
    _, r = upload(client, h, CSV.replace("OBJ0", "PRV0"), ref="Privacidade")
    bid = r.json()["batch"]["id"]
    # entregador não importa
    r2 = client.post("/api/imports/preview", files={"file": ("x.csv", CSV.encode())}, headers=auth["courier"])
    assert r2.status_code == 403
    # nomes mascarados para quem não tem permissão
    items = client.get(f"/api/batches/{bid}/correspondences", headers=auth["courier"]).json()["items"]
    assert all("•" in (i["recipient"] or "•") for i in items)
    items = client.get(f"/api/batches/{bid}/correspondences", headers=h).json()["items"]
    assert any(i["recipient"] == "Pessoa Teste Um" for i in items)
    # outra organização não acessa
    o = Organization(name="Outra", settings={})
    db.add(o)
    db.flush()
    u = User(org_id=o.id, email=f"x-{uuid.uuid4().hex[:5]}@outra.test", name="X",
             password_hash=hash_password("senha-segura-123"), role="admin")
    db.add(u)
    db.commit()
    from .conftest import login
    assert client.get(f"/api/batches/{bid}", headers=login(client, u)).status_code == 404
    assert client.get(f"/api/batches/{bid}").status_code == 401
    # geocodificador nunca recebe o nome do destinatário
    from app.workers.tasks import provider
    sent = " ".join(str(q) for q in provider().calls)
    assert "Pessoa" not in sent
    # auditoria não guarda destinatários
    logs = client.get("/api/audit", headers=auth["admin"]).json()
    assert "Pessoa Teste" not in str(logs)


def test_same_file_twice_requires_confirmation(client, auth):
    h = auth["dispatcher"]
    content = CSV.replace("OBJ0", "DUP0")
    _, r1 = upload(client, h, content, ref="A")
    assert r1.status_code == 201
    _, r2 = upload(client, h, content, ref="B")
    assert r2.status_code == 409


def test_xlsx_and_pasted_text(client, auth):
    h = auth["dispatcher"]
    wb = Workbook()
    ws = wb.active
    ws.append(["Código", "Nome", "Endereço", "Nº", "Bairro"])
    for i in range(5):
        ws.append([f"XL{i}", f"Pessoa {i}", "Rua Zeta", 100 + i, "Centro"])
    buf = io.BytesIO()
    wb.save(buf)
    pv, r = upload(client, h, buf.getvalue(), name="cartas.xlsx", ref="XLSX")
    assert pv["mapping"]["number"] == "Nº" and pv["mapping"]["street"] == "Endereço"
    assert r.status_code == 201 and r.json()["batch"]["import_report"]["inserted"] == 5
    assert r.json()["batch"]["source_type"] == "xlsx"
    text = "Rua Teta, 10 - Centro, Santos/SP\nRua Teta, 12, apto 3 - Centro\nAv. Iota, 55"
    pv = client.post("/api/imports/preview", data={"text": text, "options": '{"has_header": false}'}, headers=h)
    assert pv.status_code == 200, pv.text
    pv = pv.json()
    assert pv["mapping"]["full_address"] == "coluna_1"
    assert pv["rows"][1]["values"]["complement"] == "apto 3"
    assert pv["total_rows"] == 3


def test_large_batch_300_letters(client, auth):
    """300 cartas sintéticas (~150 imóveis) ponta a ponta com malha sintética."""
    h = auth["dispatcher"]
    lines = ["identificador;logradouro;numero;bairro"]
    for i in range(300):
        lines.append(f"BIG{i:04d};Rua Sintetica {i % 15};{(i * 37) % 150 * 10 + 10};Bairro {i % 6}")
    _, r = upload(client, h, "\n".join(lines), ref="300 cartas")
    assert r.status_code == 201
    bid = r.json()["batch"]["id"]
    info = client.get(f"/api/batches/{bid}", headers=h).json()
    assert info["correspondences"] == 300
    confirm_start(client, h)
    r = client.post(f"/api/batches/{bid}/routes", json={"run_async": False, "time_limit_s": 6}, headers=h)
    assert r.status_code == 202, r.text
    route = r.json()["route"]
    assert route["metrics"]["correspondences"] == 300
    assert route["metrics"]["stops"] == info["stops"]
    r2 = client.post(f"/api/batches/{bid}/routes", json={"run_async": False, "time_limit_s": 3,
                                                          "route_mode": "circular", "strategy": "sectors"}, headers=h)
    assert r2.json()["route"]["route_mode"] == "circular"


def test_exclusion_requires_justification(client, auth):
    h = auth["dispatcher"]
    _, r = upload(client, h, CSV.replace("OBJ0", "EXC0"), ref="Exc")
    bid = r.json()["batch"]["id"]
    cid = client.get(f"/api/batches/{bid}/correspondences", headers=h).json()["items"][0]["id"]
    assert client.patch(f"/api/correspondences/{cid}", json={"excluded": True}, headers=h).status_code == 422
    r = client.patch(f"/api/correspondences/{cid}", json={"excluded": True, "exclusion_reason": "cliente retira na agência"},
                     headers=h)
    assert r.status_code == 200 and r.json()["excluded"]


@pytest.mark.parametrize("bad", ["", "x" * 5])
def test_login_rejects_bad_password(client, auth, org, bad):
    _, users = org
    r = client.post("/api/auth/login", json={"email": users["admin"].email, "password": bad})
    assert r.status_code == 401


def test_concurrent_duplicate_sync_is_idempotent(client, auth):
    """Dois envios simultâneos do mesmo evento offline não geram erro nem duplicata."""
    from concurrent.futures import ThreadPoolExecutor

    h = auth["dispatcher"]
    _, r = upload(client, h, CSV.replace("OBJ0", "CON0"), ref="Concorrência")
    bid = r.json()["batch"]["id"]
    cid = client.get(f"/api/batches/{bid}/correspondences", headers=h).json()["items"][0]["id"]
    body = {"client_id": "x", "events": [{"client_event_id": f"same-{cid}", "kind": "delivery_event",
                                          "correspondence_id": cid, "status": "delivered",
                                          "occurred_at": datetime.now(timezone.utc).isoformat()}]}
    with ThreadPoolExecutor(4) as ex:
        resps = list(ex.map(lambda _: client.post("/api/sync", json=body, headers=auth["courier"]), range(4)))
    assert all(x.status_code == 200 for x in resps), [x.text for x in resps]
    evs = client.get(f"/api/correspondences/{cid}/events", headers=h).json()
    assert len(evs) == 1
