"""Auditoria V2: reprodução dos alertas (A, B, C, D, E, H, L) com grafos mínimos.

Cada teste foi escrito ANTES da correção e falhava na versão 42d7976 (ver docs/AUDITORIA_V2.md).
"""

from __future__ import annotations

import uuid
from datetime import date

import numpy as np
import pytest

from app.core.config import get_settings
from app.models import Address, Correspondence, DeliveryBatch, Stop
from app.services import importer
from app.services.consolidation import consolidate
from app.services.geocoding.service import point
from app.services.optimization import evaluate, solve
from app.services.planner import PlanError, PlanParams, plan
from app.services.reports import to_csv, to_xlsx
from app.services.routing.engines import InternalEngine
from roteamento.config import TravelProfile
from roteamento.network import build_network
from roteamento.osm_data import OsmData

D = 0.001  # ~111 m


def osm(nodes: dict, ways: list) -> OsmData:
    d = OsmData()
    d.nodes = {k: v for k, v in nodes.items()}
    d.ways = {i + 1: (refs, tags) for i, (refs, tags) in enumerate(ways)}
    return d


def street(**extra):
    return {"highway": "residential", **extra}


def make_batch(db, org_id, pts: list[tuple[float, float, str]]):
    """Lote com 1 carta por ponto, endereço confirmado manualmente nas coordenadas dadas."""
    b = DeliveryBatch(org_id=org_id, reference=f"t-{uuid.uuid4().hex[:6]}", service_date=date.today(),
                      source_type="manual", status="ready")
    db.add(b)
    db.flush()
    for i, (lat, lon, label) in enumerate(pts):
        key = f"RUA|TESTE {uuid.uuid4().hex[:8]}|{i}|SANTOS|SP"
        a = Address(org_id=org_id, normalized_key=key, original_text=label, normalized_text=label,
                    street_name="TESTE", number=str(i), city="Santos", state="SP", lat=lat, lon=lon,
                    geom=point(lat, lon), precision="manual", confidence=1.0)
        db.add(a)
        db.flush()
        db.add(Correspondence(org_id=org_id, batch_id=b.id, row_number=i + 2, street="Teste", number=str(i),
                              status="pending", address_id=a.id))
    db.flush()
    consolidate(db, org_id, b.id)
    db.commit()
    return b


def run_plan(db, org_id, batch, net, start, **kw):
    eng = InternalEngine(get_settings(), network=net)
    params = PlanParams(start_lat=start[0], start_lon=start[1], start_label="TESTE", time_limit_s=1,
                        service_time_s=0, per_letter_service_s=0, profile=TravelProfile(sidewalk_mode="ride"), **kw)
    return plan(db, get_settings(), eng, org_id, batch.id, params)


# ----------------------------------------------------------------- [A] par impossível


def dead_end_net():
    """S <-> A (rua de mão dupla). S -> B e S -> C: passagens de pedestre de sentido único que
    terminam em becos (B e C não alcançam nada). Visitar B e C na mesma rota aberta é impossível."""
    nodes = {1: (0, 0), 2: (0, 3 * D), 3: (2 * D, 0), 4: (-2 * D, 0)}
    ways = [([1, 2], street()),
            ([1, 3], {"highway": "footway", "oneway:foot": "yes", "bicycle": "yes"}),
            ([1, 4], {"highway": "footway", "oneway:foot": "yes", "bicycle": "yes"})]
    return build_network(osm(nodes, ways))


def test_A_infeasible_pair_yields_partial_route_not_crash(db, org):
    o, _ = org
    net = dead_end_net()
    b = make_batch(db, o.id, [(0, 2 * D, "A"), (2 * D, 0, "B"), (-2 * D, 0, "C")])
    route = run_plan(db, o.id, b, net, (0, 0.0001))
    # B e C são alcançáveis a partir da origem, mas não um a partir do outro
    assert route.metrics["status"] == "partial"
    assert len(route.metrics["excluded_stops"]) == 1
    assert "sem caminho" in route.metrics["excluded_stops"][0]["reason"].lower()
    assert len(route.stops) == 2
    assert route.metrics["feasible"] is True


def test_A_solver_never_returns_impossible_arc():
    from app.services.optimization import feasibility

    inf = np.inf
    # 2 é um beco: alcançável de 0 e de 1, mas não alcança ninguém
    T = np.array([[0, 10, 10, 10], [10, 0, 5, 5], [inf, inf, 0, inf], [10, 5, inf, 0]], dtype=float)
    f = feasibility(T, 0, [1, 2, 3], None)
    assert sorted(f.kept) == [1, 2, 3] and not f.excluded
    res = solve(T, T.copy(), 0, f.kept, time_limit_s=1, comp_rank=f.comp_rank)
    seq = [0, *res.order]
    assert all(np.isfinite(T[a, b]) for a, b in zip(seq, seq[1:]))
    assert res.order[-1] == 2  # o beco só pode ser a última parada


# ----------------------------------------------------------------- [B] componente da origem


def two_islands_net():
    """Duas malhas sem ligação: grande (5x5) a oeste e pequena (3x3) a leste, separadas ~2 km."""
    nodes, ways, nid = {}, [], 1
    for (ox, n) in ((0.0, 5), (0.02, 3)):
        ids = {}
        for r in range(n):
            for c in range(n):
                ids[r, c] = nid
                nodes[nid] = (r * D, ox + c * D)
                nid += 1
        for r in range(n):
            ways.append(([ids[r, c] for c in range(n)], street()))
        for c in range(n):
            ways.append(([ids[r, c] for r in range(n)], street()))
    return build_network(osm(nodes, ways))


def test_B_origin_in_smaller_component_routes_there(db, org):
    o, _ = org
    net = two_islands_net()
    b = make_batch(db, o.id, [(D, 0.02 + D, "P1"), (2 * D, 0.02 + 2 * D, "P2")])
    route = run_plan(db, o.id, b, net, (0, 0.02))
    assert len(route.stops) == 2
    assert route.total_distance_m < 1000  # não "salta" para a malha maior


def test_B_stop_in_other_component_is_excluded_with_reason(db, org):
    o, _ = org
    net = two_islands_net()
    b = make_batch(db, o.id, [(D, 0.02 + D, "mesma ilha"), (D, D, "outra ilha")])
    route = run_plan(db, o.id, b, net, (0, 0.02))
    assert len(route.stops) == 1
    assert route.metrics["status"] == "partial"
    assert route.metrics["excluded_stops"][0]["address"] == "outra ilha"


# ----------------------------------------------------------------- [C] snapping/acesso


def test_C_access_crossing_other_street_is_flagged(db, org):
    """Ponto a 10 m de uma rua NÃO conectada à origem; a rua conectada fica a 45 m e o acesso
    em linha reta atravessa a outra rua. Deve ir para revisão com motivo explícito."""
    o, _ = org
    nodes = {1: (0, 0), 2: (0, 4 * D), 3: (0.0004, 0), 4: (0.0004, 4 * D)}
    ways = [([1, 2], street(name="Conectada")), ([3, 4], street(name="Isolada"))]
    net = build_network(osm(nodes, ways))
    b = make_batch(db, o.id, [(0.0005, 2 * D, "atrás da rua isolada")])
    route = run_plan(db, o.id, b, net, (0, 0.0001))
    rs = route.stops[0]
    assert rs.snap_distance_m > 40
    flags = route.metrics["snap_review"][0]["flags"]
    assert "acesso_cruza_outra_via" in flags and "via_mais_proxima_desconectada" in flags


def test_C_access_time_included_in_eta(db, org):
    o, _ = org
    net = two_islands_net()
    b = make_batch(db, o.id, [(D + 0.0002, D + 0.0005, "~22 m da via")])
    route = run_plan(db, o.id, b, net, (0, 0.0001))
    acc = route.metrics["access_time_s"]
    assert acc > 0 and route.service_time_s == pytest.approx(0, abs=0.5)  # V3: acesso não é mais somado ao serviço
    assert route.total_time_s == pytest.approx(route.travel_time_s + route.service_time_s + acc, abs=1.0)


# ----------------------------------------------------------------- [D] CSV RFC 4180


def test_D_csv_quoted_newline_is_one_record():
    text = '﻿id;rua;numero;complemento\r\nX1;Rua A;10;"bloco A\r\napto 2"\r\nX2;Rua B;20;"a;b ""c"""\r\n'
    t = importer.parse_delimited(text)
    assert t.headers == ["id", "rua", "numero", "complemento"]
    assert len(t.rows) == 2
    assert t.rows[0][3] == "bloco A\napto 2"
    assert t.rows[1][3] == 'a;b "c"'


def test_D_adversarial_fixture_counts():
    from pathlib import Path

    raw = (Path(__file__).resolve().parents[2] / "test-data" / "casos_adversariais_30.csv").read_bytes()
    t = importer.parse_upload(raw, "casos_adversariais_30.csv", {})
    rows = importer.map_rows(t, importer.suggest_mapping(t.headers))
    assert len(rows) == 30
    assert sum(1 for r in rows if r.errors) == 1


# ----------------------------------------------------------------- [E] objetivo


@pytest.mark.parametrize("mode", ["open", "circular", "fixed"])
def test_E_objective_equals_evaluated_time(mode):
    rng = np.random.default_rng(3)
    P = rng.uniform(0, 2000, size=(12, 2))
    Dm = np.linalg.norm(P[:, None] - P[None, :], axis=2) * 1.3
    T = Dm / 4.0
    svc = {i: float(rng.integers(10, 300)) for i in range(1, 11)}
    end = {"open": None, "circular": 0, "fixed": 11}[mode]
    res = solve(T, Dm, 0, list(range(1, 11)), end=end, service_s=svc, time_limit_s=1)
    t, d = evaluate(res.order, T, Dm, 0, end, svc)
    assert res.best.time_s == pytest.approx(t)
    # o objetivo interno do OR-Tools soma as MESMAS parcelas (tempo em ms * 10^6 + metros)
    ors = [c for c in res.candidates if c.solver_objective is not None]
    assert ors
    for c in ors:
        tc, dc = evaluate(c.order, T, Dm, 0, end, svc)
        assert abs(c.solver_objective // 10**6 - tc * 1000) <= len(c.order) + 2
        assert abs(c.solver_objective % 10**6 - dc) <= len(c.order) + 2


# ----------------------------------------------------------------- [H] injeção em planilha


def test_H_csv_xlsx_formula_injection_neutralized():
    headers = ["id", "obs"]
    rows = [["1", '=HYPERLINK("http://x")'], ["2", "+55 11"], ["3", "-2+3"], ["4", "@SUM(A1)"], ["5", "\tabc"], ["6", "normal"]]
    text = to_csv(headers, rows).decode("utf-8-sig")
    for bad in ('=HYPERLINK', '+55', '-2+3', '@SUM'):
        assert f";{bad}" not in text and f"\n{bad}" not in text
    assert "'=HYPERLINK" in text and ";'+55 11" in text and "normal" in text
    from openpyxl import load_workbook
    import io

    ws = load_workbook(io.BytesIO(to_xlsx(headers, rows))).active
    cells = ws["B"][1:]
    assert all(c.data_type == "s" for c in cells)  # nenhum vira fórmula
    assert cells[0].value == "'=HYPERLINK(\"http://x\")" and cells[5].value == "normal"


# ----------------------------------------------------------------- [L] prefixo fixo


def test_L_invalid_fixed_ids_are_rejected(db, org):
    o, _ = org
    net = two_islands_net()
    b = make_batch(db, o.id, [(D, D, "P1"), (2 * D, 2 * D, "P2")])
    stop_ids = [s.id for s in db.query(Stop).filter(Stop.batch_id == b.id)]
    with pytest.raises(PlanError, match="inexistente"):
        run_plan(db, o.id, b, net, (0, 0.0001), fixed_next_stop_ids=[uuid.uuid4()])
    with pytest.raises(PlanError, match="duplicad"):
        run_plan(db, o.id, b, net, (0, 0.0001), fixed_next_stop_ids=[stop_ids[0], stop_ids[0]])
    route = run_plan(db, o.id, b, net, (0, 0.0001), fixed_next_stop_ids=[stop_ids[1]])
    assert route.stops[0].stop_id == stop_ids[1] and route.stops[0].locked


# ----------------------------------------------------------------- [G] chave de endereço


def test_G_address_key_ignores_neighborhood_and_complement_but_not_street_type():
    from pathlib import Path

    raw = (Path(__file__).resolve().parents[2] / "test-data" / "casos_adversariais_30.csv").read_bytes()
    t = importer.parse_upload(raw, "casos_adversariais_30.csv", {})
    k = {r.values["external_id"]: r.address_key for r in importer.map_rows(t, importer.suggest_mapping(t.headers))}
    assert k["ADV11"] == k["ADV12"]  # "R." x "RUA" maiúsculo, complemento diferente: mesma entrada
    assert k["ADV25"] == k["ADV26"]  # Av. Cons. Nébias (Vila Nova) x Avenida Conselheiro Nébias (Paquetá)
    assert k["ADV25"] != k["ADV27"]  # Avenida x Rua: logradouros diferentes
    assert k["ADV07"].split("|")[2] == "108" and k["ADV08"].split("|")[2] == "110"
    assert k["ADV10"] != k["ADV09"].replace("|112|", "|114|")  # outro município nunca colapsa com Santos
