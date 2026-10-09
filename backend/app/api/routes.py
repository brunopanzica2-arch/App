from __future__ import annotations

import uuid
from datetime import date, datetime, timedelta, timezone

from fastapi import APIRouter, Depends, HTTPException, Query, Response
from pydantic import BaseModel, Field
from sqlalchemy import select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from roteamento.config import TravelProfile

from ..core.audit import audit
from ..core.config import get_settings
from ..core.db import get_db
from ..core.security import current_user, require_role
from ..models import (
    Address, AuditLog, Correspondence, DeliveryBatch, Organization, Route, Stop, StopCorrespondence,
    SyncEvent, User,
)
from ..services import reports
from ..services.events import EventError, record_event
from ..services.planner import PlanError, PlanParams, activate, last_completed_point, plan
from ..services.routing.engines import get_engine
from ..workers.jobs import create_job, enqueue
from .auth import org_settings
from .batches import job_out, stop_out
from .deps import corr_out, get_owned, route_summary

router = APIRouter(prefix="/api", tags=["rotas"])
dispatcher = require_role("admin", "dispatcher")


class ProfileIn(BaseModel):
    ride_speed_kmh: float = Field(15.0, gt=0, le=60)
    walk_speed_kmh: float = Field(4.5, gt=0, le=15)
    steps_speed_factor: float = Field(0.5, gt=0, le=1)
    sidewalk_mode: str = Field("walk", pattern="^(walk|ride)$")
    steps_policy: str = Field("penalize", pattern="^(allow|penalize|forbid)$")
    steps_penalty_s: float = Field(30.0, ge=0)
    private_policy: str = Field("penalize", pattern="^(allow|penalize|forbid)$")
    private_penalty_s: float = Field(120.0, ge=0)
    barrier_policy: str = Field("penalize", pattern="^(allow|penalize|forbid)$")
    barrier_penalty_s: float = Field(20.0, ge=0)
    contraflow_factor: float = Field(1.0, ge=1, le=5)
    cross_pedestrian_areas: bool = True


class PointIn(BaseModel):
    label: str
    lat: float = Field(ge=-90, le=90)
    lon: float = Field(ge=-180, le=180)


class PlanIn(BaseModel):
    start: PointIn | None = None          # padrão: ponto inicial confirmado da organização
    route_mode: str = Field("open", pattern="^(open|circular|fixed_end)$")
    end: PointIn | None = None
    strategy: str = Field("global", pattern="^(global|sectors)$")
    service_time_s: float | None = Field(None, ge=0, le=3600)
    per_letter_service_s: float | None = Field(None, ge=0, le=600)
    time_limit_s: int = Field(20, ge=1, le=300)
    max_snap_m: float = Field(150, gt=0, le=1000)
    fixed_next_stop_ids: list[uuid.UUID] = []
    include_postponed: bool = False
    profile: ProfileIn | None = None
    run_async: bool = True


def _params(db, user, body: PlanIn, start: PointIn | None) -> dict:
    org = org_settings(db.get(Organization, user.org_id))
    if start is None:
        st = org.get("start")
        if not st or not st.get("confirmed"):
            raise HTTPException(409, "Confirme o ponto de partida (Configurações) antes de roteirizar.")
        start = PointIn(label=st["label"], lat=st["lat"], lon=st["lon"])
    if body.route_mode == "fixed_end" and body.end is None:
        raise HTTPException(422, "Informe o destino final.")
    prof = body.profile.model_dump() if body.profile else (
        TravelProfile(ride_speed_kmh=org["ride_speed_kmh"], walk_speed_kmh=org["walk_speed_kmh"]).to_dict()
        | (org.get("profile") or {}))
    return {
        "start_lat": start.lat, "start_lon": start.lon, "start_label": start.label,
        "route_mode": body.route_mode,
        "end_lat": body.end.lat if body.end else None, "end_lon": body.end.lon if body.end else None,
        "end_label": body.end.label if body.end else None, "strategy": body.strategy,
        "service_time_s": body.service_time_s if body.service_time_s is not None else org["service_time_s"],
        "per_letter_service_s": body.per_letter_service_s if body.per_letter_service_s is not None
        else org["per_letter_service_s"],
        "time_limit_s": body.time_limit_s, "max_snap_m": body.max_snap_m,
        "fixed_next_stop_ids": [str(x) for x in body.fixed_next_stop_ids],
        "include_postponed": body.include_postponed, "profile": prof,
    }


def _run_plan(db, user, batch_id, p: dict, run_async: bool, reason: str):
    if run_async:
        job = create_job(db, user.org_id, "plan_route", p | {"batch_id": str(batch_id), "user_id": str(user.id),
                                                             "reason": reason})
        enqueue(job)
        return {"job": job_out(job)}
    q = dict(p)
    profile = TravelProfile(**q.pop("profile"))
    fixed = [uuid.UUID(x) for x in q.pop("fixed_next_stop_ids")]
    try:
        route = plan(db, get_settings(), get_engine(get_settings()), user.org_id, batch_id,
                     PlanParams(**q, profile=profile, fixed_next_stop_ids=fixed), user.id, reason)
    except PlanError as exc:
        db.rollback()
        raise HTTPException(422, str(exc))
    audit(db, user.org_id, user.id, "plan_route", "route", route.id, {"version": route.version, "reason": reason})
    db.commit()
    return {"route": route_summary(route)}


@router.post("/batches/{batch_id}/routes", status_code=202)
def plan_batch(batch_id: uuid.UUID, body: PlanIn, db: Session = Depends(get_db), user: User = Depends(dispatcher)):
    get_owned(db, DeliveryBatch, batch_id, user)
    return _run_plan(db, user, batch_id, _params(db, user, body, body.start), body.run_async, "plan")


@router.get("/batches/{batch_id}/routes")
def list_routes(batch_id: uuid.UUID, db: Session = Depends(get_db), user: User = Depends(current_user)):
    get_owned(db, DeliveryBatch, batch_id, user)
    return [route_summary(r) for r in db.scalars(
        select(Route).where(Route.batch_id == batch_id).order_by(Route.version.desc()))]


@router.get("/routes/{route_id}")
def get_route(route_id: uuid.UUID, db: Session = Depends(get_db), user: User = Depends(current_user)):
    r = get_owned(db, Route, route_id, user)
    stop_ids = [rs.stop_id for rs in r.stops]
    stops = {s.id: s for s in db.scalars(select(Stop).where(Stop.id.in_(stop_ids)))}
    addrs = {a.id: a for a in db.scalars(select(Address).where(Address.id.in_([s.address_id for s in stops.values()])))}
    corrs: dict = {}
    for sid, c in db.execute(select(StopCorrespondence.stop_id, Correspondence)
                             .join(Correspondence, Correspondence.id == StopCorrespondence.correspondence_id)
                             .where(StopCorrespondence.stop_id.in_(stop_ids))).all():
        corrs.setdefault(sid, []).append(corr_out(c, user))
    items = []
    for rs in r.stops:
        s = stops[rs.stop_id]
        items.append({"sequence": rs.sequence, "eta_s": rs.eta_s, "leg_distance_m": rs.leg_distance_m,
                      "leg_time_s": rs.leg_time_s, "snap_distance_m": rs.snap_distance_m, "locked": rs.locked,
                      "status_at_plan": rs.status_at_plan,
                      **stop_out(s, addrs[s.address_id], corrs.get(s.id, []))})
    return {**route_summary(r), "stops": items, "geojson": r.geojson}


@router.post("/routes/{route_id}/activate")
def activate_route(route_id: uuid.UUID, db: Session = Depends(get_db),
                   user: User = Depends(require_role("admin", "dispatcher", "courier"))):
    r = get_owned(db, Route, route_id, user)
    activate(db, r)
    audit(db, user.org_id, user.id, "activate_route", "route", r.id, {"version": r.version})
    db.commit()
    return route_summary(r)


class ReoptIn(BaseModel):
    origin: str = Field("last_completed", pattern="^(last_completed|current_location|start)$")
    lat: float | None = None
    lon: float | None = None
    location_consent: bool = False
    fixed_next_stop_ids: list[uuid.UUID] = []
    include_postponed: bool = False
    time_limit_s: int = Field(15, ge=1, le=300)
    run_async: bool = True


@router.post("/routes/{route_id}/reoptimize", status_code=202)
def reoptimize(route_id: uuid.UUID, body: ReoptIn, db: Session = Depends(get_db),
               user: User = Depends(require_role("admin", "dispatcher", "courier"))):
    """Recalcula somente as paradas restantes; versões anteriores são preservadas."""
    r = get_owned(db, Route, route_id, user)
    if body.origin == "current_location":
        if not body.location_consent or body.lat is None or body.lon is None:
            raise HTTPException(422, "Localização atual exige consentimento e coordenadas.")
        start = PointIn(label="Localização atual (informada pelo aparelho)", lat=body.lat, lon=body.lon)
    elif body.origin == "last_completed":
        lc = last_completed_point(db, r)
        start = PointIn(label=lc[2], lat=lc[0], lon=lc[1]) if lc else PointIn(
            label=r.start_label, lat=r.start_lat, lon=r.start_lon)
    else:
        start = PointIn(label=r.start_label, lat=r.start_lat, lon=r.start_lon)
    prof = r.profile.copy()
    svc = prof.pop("service_time_s", None)
    per = prof.pop("per_letter_service_s", None)
    body_plan = PlanIn(start=start, route_mode=r.route_mode,
                       end=PointIn(label=r.end_label or "Destino", lat=r.end_lat, lon=r.end_lon) if r.end_lat is not None else None,
                       strategy=r.strategy, service_time_s=svc, per_letter_service_s=per,
                       time_limit_s=body.time_limit_s, fixed_next_stop_ids=body.fixed_next_stop_ids,
                       include_postponed=body.include_postponed, profile=ProfileIn(**prof))
    if r.route_mode == "circular":
        # o retorno é à base original, não ao ponto atual
        body_plan.route_mode = "fixed_end"
        body_plan.end = PointIn(label=r.start_label, lat=r.start_lat, lon=r.start_lon)
    p = _params(db, user, body_plan, start)
    return _run_plan(db, user, r.batch_id, p, body.run_async, f"reoptimize:{body.origin}")


@router.post("/routes/{route_id}/finish")
def finish_route(route_id: uuid.UUID, db: Session = Depends(get_db), user: User = Depends(current_user)):
    r = get_owned(db, Route, route_id, user)
    r.status = "finished"
    audit(db, user.org_id, user.id, "finish_route", "route", r.id, {})
    db.commit()
    return route_summary(r)


# ------------------------------------------------------------ relatórios


@router.get("/batches/{batch_id}/report")
def batch_report(batch_id: uuid.UUID, db: Session = Depends(get_db), user: User = Depends(current_user)):
    get_owned(db, DeliveryBatch, batch_id, user)
    return reports.batch_report(db, user.org_id, batch_id)


@router.get("/batches/{batch_id}/export")
def export(batch_id: uuid.UUID, format: str = Query("csv", pattern="^(csv|xlsx)$"),
           db: Session = Depends(get_db), user: User = Depends(current_user)):
    b = get_owned(db, DeliveryBatch, batch_id, user)
    headers, rows = reports.export_rows(db, user.org_id, batch_id, user.can_view_recipients)
    audit(db, user.org_id, user.id, "export", "delivery_batch", b.id, {"format": format})
    db.commit()
    name = f"lote-{b.service_date.isoformat()}-{b.reference}".replace(" ", "_")
    if format == "csv":
        return Response(reports.to_csv(headers, rows), media_type="text/csv; charset=utf-8",
                        headers={"Content-Disposition": f'attachment; filename="{name}.csv"'})
    return Response(reports.to_xlsx(headers, rows),
                    media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                    headers={"Content-Disposition": f'attachment; filename="{name}.xlsx"'})


@router.get("/reports/history")
def report_history(start: date | None = None, end: date | None = None,
                   group: str = Query("day", pattern="^(day|week|month)$"),
                   db: Session = Depends(get_db), user: User = Depends(current_user)):
    end = end or date.today()
    start = start or end - timedelta(days=60)
    return reports.history(db, user.org_id, start, end, group)


# ------------------------------------------------------------ sincronização offline


class SyncItem(BaseModel):
    client_event_id: str = Field(max_length=80)
    kind: str = Field(pattern="^(delivery_event)$")
    correspondence_id: uuid.UUID
    status: str
    reason: str | None = None
    notes: str | None = Field(None, max_length=1000)
    occurred_at: str
    route_id: uuid.UUID | None = None


class SyncIn(BaseModel):
    client_id: str = Field(max_length=80)
    events: list[SyncItem] = Field(max_length=1000)


@router.post("/sync")
def sync(body: SyncIn, db: Session = Depends(get_db), user: User = Depends(current_user)):
    """Aplica a fila offline. Idempotente por client_event_id. Conflito: um evento
    mais antigo que o último registrado entra no histórico, mas não muda o status."""
    out = []
    for it in sorted(body.events, key=lambda e: e.occurred_at):
        prev = db.scalar(select(SyncEvent).where(SyncEvent.user_id == user.id,
                                                 SyncEvent.client_event_id == it.client_event_id))
        if prev:
            out.append({"client_event_id": it.client_event_id, "status": prev.status, "result": prev.result,
                        "duplicate": True})
            continue
        try:
            try:
                res = record_event(db, user, it.correspondence_id, it.status, it.reason, it.notes,
                                   datetime.fromisoformat(it.occurred_at), it.client_event_id, it.route_id,
                                   source="offline")
                c = db.get(Correspondence, it.correspondence_id)
                status = "conflict" if res.conflict else "applied"
                result = {"event_id": str(res.event.id), "server_status": c.status}
            except (EventError, ValueError) as exc:
                db.rollback()
                status, result = "rejected", {"error": str(exc)}
            db.add(SyncEvent(org_id=user.org_id, user_id=user.id, client_id=body.client_id,
                             client_event_id=it.client_event_id, kind=it.kind,
                             payload=it.model_dump(mode="json"), status=status, result=result))
            db.commit()
        except IntegrityError:
            # envio concorrente do mesmo evento: outro pedido já o registrou (idempotente)
            db.rollback()
            prev = db.scalar(select(SyncEvent).where(SyncEvent.user_id == user.id,
                                                     SyncEvent.client_event_id == it.client_event_id))
            out.append({"client_event_id": it.client_event_id, "status": prev.status if prev else "applied",
                        "result": prev.result if prev else {}, "duplicate": True})
            continue
        out.append({"client_event_id": it.client_event_id, "status": status, "result": result, "duplicate": False})
    return {"results": out, "server_time": datetime.now(timezone.utc).isoformat()}


# ------------------------------------------------------------ administração / LGPD


@router.get("/admin/network")
def network_info(user: User = Depends(require_role("admin", "dispatcher"))):
    eng = get_engine(get_settings())
    info = {"engine": eng.name, "version": eng.network_version()}
    if hasattr(eng, "stats"):
        info |= eng.stats()
    return info


@router.post("/admin/retention/run")
def run_retention(db: Session = Depends(get_db), user: User = Depends(require_role("admin"))):
    """Anonimiza dados pessoais de lotes mais antigos que RETENTION_DAYS."""
    limit = date.today() - timedelta(days=get_settings().retention_days)
    ids = list(db.scalars(select(DeliveryBatch.id).where(DeliveryBatch.org_id == user.org_id,
                                                         DeliveryBatch.service_date < limit)))
    n = 0
    if ids:
        n = db.execute(update(Correspondence).where(Correspondence.batch_id.in_(ids))
                       .values(recipient=None, raw_row={})).rowcount
        db.execute(update(DeliveryBatch).where(DeliveryBatch.id.in_(ids)).values(original_content=None))
    audit(db, user.org_id, user.id, "retention", "organization", user.org_id, {"batches": len(ids), "rows": n})
    db.commit()
    return {"batches": len(ids), "anonymized_correspondences": n, "before": limit.isoformat()}


@router.delete("/batches/{batch_id}/personal-data")
def erase_batch_personal_data(batch_id: uuid.UUID, db: Session = Depends(get_db),
                              user: User = Depends(require_role("admin"))):
    b = get_owned(db, DeliveryBatch, batch_id, user)
    n = db.execute(update(Correspondence).where(Correspondence.batch_id == b.id)
                   .values(recipient=None, raw_row={})).rowcount
    b.original_content = None
    audit(db, user.org_id, user.id, "erase_personal_data", "delivery_batch", b.id, {"rows": n})
    db.commit()
    return {"anonymized_correspondences": n}


@router.get("/audit")
def audit_log(limit: int = Query(100, le=500), db: Session = Depends(get_db),
              user: User = Depends(require_role("admin"))):
    rows = db.scalars(select(AuditLog).where(AuditLog.org_id == user.org_id)
                      .order_by(AuditLog.created_at.desc()).limit(limit))
    return [{"action": a.action, "entity": a.entity, "entity_id": a.entity_id, "details": a.details,
             "user_id": str(a.user_id) if a.user_id else None, "created_at": a.created_at.isoformat()} for a in rows]
