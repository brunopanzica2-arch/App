"""Planejamento e reotimização de rotas (versões preservadas)."""

from __future__ import annotations

import hashlib
import json
import time
import uuid
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np
from geoalchemy2.elements import WKTElement
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from roteamento.config import TravelProfile

from ..core.config import Settings
from ..models import (
    Address, Correspondence, DeliveryEvent, Route, RouteMatrixMetadata, RouteStop, Stop,
    StopCorrespondence,
)
from .optimization import cost as objective_cost
from .optimization import evaluate, feasibility, solve, validate
from .routing.engines import RoutingEngine, profile_hash

ROUTABLE_CORR = ("pending", "in_route")


class PlanError(ValueError):
    pass


@dataclass
class PlanParams:
    start_lat: float
    start_lon: float
    start_label: str
    route_mode: str = "open"            # open | circular | fixed_end
    end_lat: float | None = None
    end_lon: float | None = None
    end_label: str | None = None
    strategy: str = "global"            # global | sectors
    service_time_s: float = 45.0
    per_letter_service_s: float = 10.0  # adicional por carta extra na mesma parada
    time_limit_s: int = 20
    max_snap_m: float = 150.0
    snap_review_m: float = 30.0         # acima disso a posição vai para revisão (alerta C)
    fixed_next_stop_ids: list[uuid.UUID] = field(default_factory=list)
    include_postponed: bool = False
    profile: TravelProfile = field(default_factory=TravelProfile)


def _remaining_stops(db: Session, org_id, batch_id, include_postponed: bool):
    statuses = list(ROUTABLE_CORR) + (["postponed"] if include_postponed else [])
    rows = db.execute(
        select(Stop, func.count(Correspondence.id))
        .join(StopCorrespondence, StopCorrespondence.stop_id == Stop.id)
        .join(Correspondence, Correspondence.id == StopCorrespondence.correspondence_id)
        .where(Stop.batch_id == batch_id, Stop.org_id == org_id, Stop.excluded.is_(False),
               Correspondence.status.in_(statuses), Correspondence.excluded.is_(False))
        .group_by(Stop.id)
    ).all()
    return [(s, int(n)) for s, n in rows]


def _matrix_cache_path(settings: Settings, key: str) -> Path:
    return Path(settings.data_dir) / "matrices" / f"{key}.npz"


def _validate_fixed(db: Session, batch_id, fixed: list[uuid.UUID], remaining_ids: set) -> None:
    """Paradas fixadas precisam existir no lote, estar pendentes e não se repetir (alerta L)."""
    if len(set(fixed)) != len(fixed):
        raise PlanError("Parada fixa duplicada na lista de próximas paradas.")
    for sid in fixed:
        if sid in remaining_ids:
            continue
        s = db.get(Stop, sid)
        if s is None or s.batch_id != batch_id:
            raise PlanError(f"Parada fixa inexistente neste lote: {sid}.")
        if s.excluded:
            raise PlanError(f"Parada fixa {sid} está excluída do roteiro: {s.exclusion_reason}.")
        raise PlanError(f"Parada fixa {sid} não tem cartas pendentes (status '{s.status}').")


def plan(db: Session, settings: Settings, engine: RoutingEngine, org_id: uuid.UUID,
         batch_id: uuid.UUID, params: PlanParams, user_id: uuid.UUID | None = None,
         reason: str = "plan") -> Route:
    timings: dict[str, int] = {}
    t_all = time.perf_counter()
    if params.route_mode == "fixed_end" and params.end_lat is None:
        raise PlanError("Destino final obrigatório para rota com destino fixo.")
    stops_n = _remaining_stops(db, org_id, batch_id, params.include_postponed)
    if not stops_n:
        raise PlanError("Não há paradas pendentes para roteirizar neste lote.")
    stops = [s for s, _ in stops_n]
    letters = {s.id: n for s, n in stops_n}
    _validate_fixed(db, batch_id, list(params.fixed_next_stop_ids), {s.id for s in stops})
    addresses = {a.id: a for a in db.scalars(select(Address).where(
        Address.id.in_([s.address_id for s in stops])))}

    points = [(params.start_lat, params.start_lon)] + [(s.lat, s.lon) for s in stops]
    end_idx = None
    if params.route_mode == "fixed_end":
        points.append((params.end_lat, params.end_lon))
        end_idx = len(points) - 1

    # ---------------- matriz (rede de pedestres; malha eleita a partir da ORIGEM)
    t0 = time.perf_counter()
    session = engine.matrix(points, params.profile, params.max_snap_m)
    timings["matrix_ms"] = int((time.perf_counter() - t0) * 1000)
    warnings: list[str] = []
    excluded: list[dict] = []
    if not session.snaps[0].ok:
        raise PlanError(f"Ponto de partida fora da malha: {session.snaps[0].error}")
    if "origem_em_trecho_isolado" in (session.snaps[0].flags or []):
        warnings.append("A origem está num trecho que alcança pouca malha; confira o pino de partida.")
    if end_idx is not None and not session.snaps[end_idx].ok:
        raise PlanError(f"Destino final fora da malha: {session.snaps[end_idx].error}")
    T, D = session.time_s, session.dist_m
    circular = params.route_mode == "circular"
    walk_mps = params.profile.walk_mps()
    snap_review: list[dict] = []
    access_s: dict[int, float] = {}
    candidates_idx = []
    for i, s in enumerate(stops, start=1):
        snap = session.snaps[i]
        a = addresses[s.address_id]
        if not snap.ok:
            excluded.append({"stop_id": str(s.id), "address": a.normalized_text, "reason": snap.error})
            continue
        candidates_idx.append(i)
        dist = snap.distance_m or 0.0
        # ida e volta a pé entre a via e o ponto do imóvel (alerta C): entra no ETA como atendimento
        access_s[i] = 2.0 * dist / walk_mps
        if dist > params.snap_review_m or snap.flags:
            snap_review.append({"stop_id": str(s.id), "address": a.normalized_text, "distance_m": round(dist, 1),
                                "confidence": snap.confidence, "flags": list(snap.flags)})

    # ---------------- factibilidade (alerta A): só uma sequência sem pares impossíveis
    end_for_feas = 0 if circular else end_idx
    feas = feasibility(T, 0, candidates_idx, end_for_feas)
    by_idx = {i: stops[i - 1] for i in candidates_idx}
    for i, why in feas.excluded.items():
        excluded.append({"stop_id": str(by_idx[i].id), "address": addresses[by_idx[i].address_id].normalized_text,
                         "reason": why})
    ok_idx = feas.kept
    if not ok_idx:
        raise PlanError("Nenhuma parada alcançável pela malha de pedestres a partir da origem.")
    ok_set = set(ok_idx)
    unreachable_pairs = int(np.sum(~np.isfinite(T[np.ix_(candidates_idx, candidates_idx)])))
    for e in excluded:
        warnings.append(f"Parada excluída — {e['address']}: {e['reason']}")
    for r in snap_review:
        warnings.append(f"{r['address']}: revisar posição (snap {r['distance_m']:.0f} m, confiança {r['confidence']}"
                        + (f", {', '.join(r['flags'])}" if r["flags"] else "") + ").")

    # ---------------- cache da matriz (arquivo .npz + metadados)
    pts_hash = hashlib.sha256(json.dumps([[round(a, 6), round(b, 6)] for a, b in points]).encode()).hexdigest()[:32]
    p_hash = profile_hash(params.profile)
    key = f"{session.engine}-{session.network_version}-{p_hash}-{pts_hash}"
    path = _matrix_cache_path(settings, key)
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        np.savez_compressed(path, T=T, D=D)
        storage = str(path)
    except OSError:
        storage = None

    # ---------------- prefixo fixo + otimização
    idx_of = {s.id: i for i, s in enumerate(stops, start=1)}
    fixed = [idx_of[sid] for sid in params.fixed_next_stop_ids]
    bad_fixed = [i for i in fixed if i not in ok_set]
    if bad_fixed:
        raise PlanError("Parada fixa sem caminho de pedestre viável: "
                        + ", ".join(addresses[stops[i - 1].address_id].normalized_text for i in bad_fixed))
    free = [i for i in ok_idx if i not in fixed]
    svc = {}
    for i in ok_idx:
        s = stops[i - 1]
        base = s.service_time_s if s.service_time_s is not None else (
            params.service_time_s + params.per_letter_service_s * max(letters[s.id] - 1, 0))
        svc[i] = base + access_s.get(i, 0.0)
    prio = {i: stops[i - 1].priority for i in ok_idx if stops[i - 1].priority > 0}
    nb = {i: (addresses[stops[i - 1].address_id].neighborhood or "?").upper() for i in ok_idx}
    sector = nb if params.strategy == "sectors" else None
    start_for_solver = fixed[-1] if fixed else 0
    end_for_solver = 0 if circular else end_idx
    # linhas de base para comparação (ordem importada, alfabética, agrupada por bairro)
    first_row = {s.id: r for s, r in db.execute(
        select(Stop, func.min(Correspondence.row_number))
        .join(StopCorrespondence, StopCorrespondence.stop_id == Stop.id)
        .join(Correspondence, Correspondence.id == StopCorrespondence.correspondence_id)
        .where(Stop.batch_id == batch_id).group_by(Stop.id)).all()}
    text = {i: addresses[stops[i - 1].address_id].normalized_text for i in free}
    baselines = {
        "ordem_importada": sorted(free, key=lambda i: first_row.get(stops[i - 1].id, 0)),
        "alfabetica": sorted(free, key=lambda i: text[i]),
        "bairro_agrupado": sorted(free, key=lambda i: (nb[i], text[i])),
    }
    t0 = time.perf_counter()
    try:
        result = solve(T, D, start_for_solver, free, end_for_solver, svc, prio, sector,
                       time_limit_s=params.time_limit_s, baselines=baselines, comp_rank=feas.comp_rank)
    except RuntimeError as exc:
        raise PlanError(str(exc)) from exc
    timings["solve_ms"] = int((time.perf_counter() - t0) * 1000)
    order = fixed + result.order
    problems = validate(order, T, 0, ok_idx, end_for_solver)
    if problems:  # nunca declarar sucesso com rota impossível (E2E-18)
        raise PlanError("Rota inválida: " + "; ".join(problems))
    seq = [0] + order + ([0] if circular else ([end_idx] if end_idx is not None else []))

    # ---------------- geometria real dos trechos escolhidos
    t0 = time.perf_counter()
    features: list[dict] = []
    route_stops: list[RouteStop] = []
    by_mode: dict[str, float] = {}
    flags: dict[str, float] = {}
    clock = travel = dist = service_total = access_total = 0.0
    lines = []
    for leg_no, (a, b) in enumerate(zip(seq, seq[1:]), start=1):
        leg = session.leg(a, b)
        for f in leg.features:
            f["properties"]["leg"] = leg_no
            features.append(f)
            lines.append(f["geometry"]["coordinates"])
        for k, v in leg.by_mode_m.items():
            by_mode[k] = by_mode.get(k, 0.0) + v
        for k, v in leg.flags_m.items():
            flags[k] = flags.get(k, 0.0) + v
        clock += leg.time_s
        travel += leg.time_s
        dist += leg.distance_m
        if 1 <= b <= len(stops) and b in ok_set:
            s = stops[b - 1]
            sn = session.snaps[b]
            route_stops.append(RouteStop(
                stop_id=s.id, sequence=len(route_stops) + 1, eta_s=round(clock, 1),
                leg_distance_m=round(leg.distance_m, 1), leg_time_s=round(leg.time_s, 1),
                snap_lat=sn.snap_lat, snap_lon=sn.snap_lon, snap_distance_m=sn.distance_m,
                locked=b in fixed, status_at_plan=s.status,
            ))
            clock += svc[b]
            service_total += svc[b] - access_s.get(b, 0.0)
            access_total += access_s.get(b, 0.0)
    timings["geometry_ms"] = int((time.perf_counter() - t0) * 1000)
    # ETA acumulado == objetivo avaliado (alerta E)
    t_eval, _ = evaluate(order, T, D, 0, end_for_solver, svc)
    if abs(t_eval - clock) > 1.0 + 1e-3 * clock:
        raise PlanError(f"Inconsistência interna: ETA {clock:.1f} s x avaliação {t_eval:.1f} s.")
    # decomposição do tempo (V3 §7.1): o ETA é tempo FÍSICO; penalidades só existem no objetivo do solver
    gen_obj, _ = objective_cost(order, T, D, 0, end_for_solver, svc, prio, sector)
    pen_prio = objective_cost(order, T, D, 0, end_for_solver, svc, prio, None)[0] - t_eval
    pen_sector = objective_cost(order, T, D, 0, end_for_solver, svc, None, sector)[0] - t_eval
    time_breakdown = {
        "travel_s": round(travel, 1), "service_s": round(service_total, 1), "access_s": round(access_total, 1),
        "estimated_duration_s": round(clock, 1), "priority_penalty_s": round(pen_prio, 1),
        "sector_penalty_s": round(pen_sector, 1), "generalized_objective_s": round(gen_obj, 1),
        "identity": "estimated_duration = travel + service + access; generalized_objective = estimated_duration + penalties",
    }
    for f, m in flags.items():
        if f in ("escada", "acesso_privado", "barreira", "portao_privado", "proibido_pedalar", "travessia_de_praca"):
            warnings.append(f"Trecho sinalizado no percurso: {f.replace('_', ' ')} ({m:.0f} m). Verifique no local.")

    # ---------------- versão
    prev = db.scalar(select(Route).where(Route.batch_id == batch_id).order_by(Route.version.desc()).limit(1))
    version = (prev.version + 1) if prev else 1
    diff = {}
    if prev:
        old = [str(rs.stop_id) for rs in prev.stops]
        new = [str(rs.stop_id) for rs in route_stops]
        diff = {"previous_version": prev.version, "reason": reason,
                "removed": [x for x in old if x not in new], "added": [x for x in new if x not in old],
                "order_changed": [x for x in new if x in old and new.index(x) != old.index(x)]}
    timings["total_ms"] = int((time.perf_counter() - t_all) * 1000)
    n_letters = sum(letters[stops[i - 1].id] for i in order)
    status = "partial" if excluded else "complete"
    route = Route(
        org_id=org_id, batch_id=batch_id, version=version, parent_route_id=prev.id if prev else None,
        status="planned", route_mode=params.route_mode, strategy=params.strategy,
        start_label=params.start_label, start_lat=params.start_lat, start_lon=params.start_lon,
        end_label=params.end_label, end_lat=params.end_lat, end_lon=params.end_lon,
        profile=params.profile.to_dict() | {"service_time_s": params.service_time_s,
                                            "per_letter_service_s": params.per_letter_service_s},
        engine=session.engine, network_version=session.network_version,
        total_time_s=round(clock, 1), travel_time_s=round(travel, 1),
        service_time_s=round(service_total, 1), total_distance_m=round(dist, 1),
        metrics={"timings_ms": timings, "stops": len(route_stops), "correspondences": n_letters,
                 "status": status, "feasible": True,
                 "pending_stops_total": len(stops), "excluded_stops": excluded,
                 "access_time_s": round(access_total, 1), "time_breakdown": time_breakdown, "snap_review": snap_review,
                 "distance_by_mode_m": {k: round(v, 1) for k, v in by_mode.items()},
                 "flagged_distance_m": {k: round(v, 1) for k, v in flags.items()},
                 "chosen_strategy": result.best.strategy, "objective": [round(result.best.cost_s, 1),
                                                                        round(result.best.distance_m, 1)],
                 "objective_rule": "lexicográfico: factibilidade > cobertura > tempo+penalidades > distância",
                 "matrix_points": len(points), "unreachable_pairs": unreachable_pairs, "estimates_note":
                     "Tempos e distâncias são ESTIMATIVAS pela malha OSM; não verificados em campo."},
        candidates=[c.to_dict() for c in result.candidates],
        geojson={"type": "FeatureCollection", "features": features},
        geom=WKTElement("MULTILINESTRING(" + ",".join(
            "(" + ",".join(f"{x} {y}" for x, y in ln) + ")" for ln in lines if len(ln) >= 2) + ")", srid=4326)
        if any(len(ln) >= 2 for ln in lines) else None,
        warnings=warnings, diff=diff, created_by=user_id,
    )
    route.stops = route_stops
    db.add(route)
    db.flush()
    db.add(RouteMatrixMetadata(
        org_id=org_id, route_id=route.id, engine=session.engine, network_version=session.network_version,
        profile_hash=p_hash, points_hash=pts_hash, n_points=len(points),
        unreachable_pairs=unreachable_pairs, compute_ms=session.compute_ms, storage_path=storage))
    db.flush()
    return route


def activate(db: Session, route: Route) -> Route:
    others = db.scalars(select(Route).where(Route.batch_id == route.batch_id, Route.id != route.id,
                                            Route.status.in_(["active", "planned"])))
    for r in others:
        if r.status == "active" or r.version < route.version:
            r.status = "superseded"
    route.status = "active"
    stop_ids = [rs.stop_id for rs in route.stops]
    corrs = db.scalars(select(Correspondence).join(
        StopCorrespondence, StopCorrespondence.correspondence_id == Correspondence.id)
        .where(StopCorrespondence.stop_id.in_(stop_ids), Correspondence.status == "pending"))
    for c in corrs:
        c.status = "in_route"
    db.flush()
    return route


def last_completed_point(db: Session, route: Route) -> tuple[float, float, str] | None:
    """Última parada com evento registrado na rota (para recálculo)."""
    ev = db.scalar(select(DeliveryEvent).where(DeliveryEvent.route_id == route.id,
                                               DeliveryEvent.stop_id.is_not(None))
                   .order_by(DeliveryEvent.occurred_at.desc()).limit(1))
    if not ev:
        return None
    s = db.get(Stop, ev.stop_id)
    a = db.get(Address, s.address_id)
    return s.lat, s.lon, f"Última parada atendida: {a.normalized_text}"
