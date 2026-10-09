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
from .optimization import solve
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
    addresses = {a.id: a for a in db.scalars(select(Address).where(
        Address.id.in_([s.address_id for s in stops])))}

    points = [(params.start_lat, params.start_lon)] + [(s.lat, s.lon) for s in stops]
    end_idx = None
    if params.route_mode == "fixed_end":
        points.append((params.end_lat, params.end_lon))
        end_idx = len(points) - 1

    # ---------------- matriz (rede de pedestres)
    t0 = time.perf_counter()
    session = engine.matrix(points, params.profile, params.max_snap_m)
    timings["matrix_ms"] = int((time.perf_counter() - t0) * 1000)
    warnings: list[str] = []
    excluded: list[dict] = []
    if not session.snaps[0].ok:
        raise PlanError(f"Ponto de partida fora da malha: {session.snaps[0].error}")
    if end_idx is not None and not session.snaps[end_idx].ok:
        raise PlanError(f"Destino final fora da malha: {session.snaps[end_idx].error}")
    T, D = session.time_s, session.dist_m
    circular = params.route_mode == "circular"
    candidates_idx = []
    for i, s in enumerate(stops, start=1):
        snap = session.snaps[i]
        a = addresses[s.address_id]
        if not snap.ok:
            excluded.append({"stop_id": str(s.id), "address": a.normalized_text, "reason": snap.error})
            continue
        unreachable = not np.isfinite(T[0, i]) or (circular and not np.isfinite(T[i, 0])) or \
            (end_idx is not None and not np.isfinite(T[i, end_idx]))
        if unreachable:
            excluded.append({"stop_id": str(s.id), "address": a.normalized_text,
                             "reason": "Sem caminho de pedestre conectado a partir da origem."})
            continue
        if snap.distance_m is not None and snap.distance_m > 60:
            warnings.append(f"{a.normalized_text}: ponto a {snap.distance_m:.0f} m da via mais próxima (snap).")
        candidates_idx.append(i)
    ok_set = set(candidates_idx)
    unreachable_pairs = int(np.sum(~np.isfinite(T[np.ix_(candidates_idx, candidates_idx)])))
    if unreachable_pairs:
        warnings.append(f"Matriz incompleta: {unreachable_pairs} pares sem caminho.")
    for e in excluded:
        warnings.append(f"Parada excluída — {e['address']}: {e['reason']}")
    if not candidates_idx:
        raise PlanError("Nenhuma parada alcançável pela malha de pedestres.")

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

    # ---------------- sequência fixa + otimização
    idx_of = {s.id: i for i, s in enumerate(stops, start=1)}
    fixed = [idx_of[sid] for sid in params.fixed_next_stop_ids if sid in idx_of and idx_of[sid] in ok_set]
    free = [i for i in candidates_idx if i not in fixed]
    svc = {i: params.service_time_s + params.per_letter_service_s * max(letters[stops[i - 1].id] - 1, 0)
           for i in candidates_idx}
    for i in candidates_idx:
        s = stops[i - 1]
        if s.service_time_s is not None:
            svc[i] = s.service_time_s
    prio = {i: stops[i - 1].priority for i in candidates_idx if stops[i - 1].priority > 0}
    sector = None
    if params.strategy == "sectors":
        sector = {i: (addresses[stops[i - 1].address_id].neighborhood or "?").upper() for i in candidates_idx}
    start_for_solver = fixed[-1] if fixed else 0
    end_for_solver = 0 if circular else end_idx
    t0 = time.perf_counter()
    result = solve(T, D, start_for_solver, free, end_for_solver, svc, prio, sector,
                   time_limit_s=params.time_limit_s)
    timings["solve_ms"] = int((time.perf_counter() - t0) * 1000)
    order = fixed + result.order
    seq = [0] + order + ([0] if circular else ([end_idx] if end_idx is not None else []))

    # ---------------- geometria real dos trechos escolhidos
    t0 = time.perf_counter()
    features: list[dict] = []
    route_stops: list[RouteStop] = []
    by_mode: dict[str, float] = {}
    flags: dict[str, float] = {}
    clock = travel = dist = service_total = 0.0
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
            service_total += svc[b]
    timings["geometry_ms"] = int((time.perf_counter() - t0) * 1000)
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
                 "excluded_stops": excluded, "distance_by_mode_m": {k: round(v, 1) for k, v in by_mode.items()},
                 "flagged_distance_m": {k: round(v, 1) for k, v in flags.items()},
                 "chosen_strategy": result.best.strategy, "objective": result.best.objective,
                 "matrix_points": len(points), "estimates_note":
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
