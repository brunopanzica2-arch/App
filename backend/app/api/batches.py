from __future__ import annotations

import json
import uuid
from datetime import date

from fastapi import APIRouter, Depends, File, Form, HTTPException, Query, UploadFile
from pydantic import BaseModel, Field
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from ..core.audit import audit
from ..core.config import get_settings
from ..core.db import get_db
from ..core.security import current_user, rate_limit, require_role
from ..models import (
    Address, Correspondence, DeliveryBatch, DeliveryEvent, Job, Stop, StopCorrespondence, User,
)
from ..services import importer
from ..services.consolidation import consolidate
from ..services.events import REASONS, EventError, record_event
from ..services.geocoding.providers import ProviderError
from ..services.geocoding.service import Geocoder
from ..services.normalize import normalize_address
from ..workers.jobs import create_job, enqueue
from ..workers.tasks import provider
from .deps import address_out, batch_out, corr_out, get_owned

router = APIRouter(prefix="/api", tags=["lotes"])
dispatcher = require_role("admin", "dispatcher")


async def _table(file: UploadFile | None, text: str | None, options: dict) -> tuple[importer.ParsedTable, str, str | None]:
    try:
        if file is not None:
            content = await file.read(importer.MAX_UPLOAD_BYTES + 1)
            t = importer.parse_upload(content, file.filename or "", options)
            st = "xlsx" if (file.filename or "").lower().endswith(".xlsx") else "csv"
            return t, st, file.filename
        if text:
            return importer.parse_delimited(text, options.get("delimiter"), options.get("has_header", True)), "text", None
    except importer.ImportError_ as exc:
        raise HTTPException(422, str(exc))
    except (UnicodeDecodeError, ValueError) as exc:
        raise HTTPException(422, f"Arquivo inválido: {exc}")
    raise HTTPException(422, "Envie um arquivo ou texto.")


@router.post("/imports/preview", dependencies=[Depends(rate_limit("import", 60))])
async def import_preview(file: UploadFile | None = File(None), text: str | None = Form(None),
                         options: str = Form("{}"), mapping: str | None = Form(None),
                         user: User = Depends(dispatcher)):
    opts = json.loads(options or "{}")
    table, st, fname = await _table(file, text, opts)
    try:
        return {"source_type": st, "filename": fname,
                **importer.preview(table, json.loads(mapping) if mapping else None)}
    except importer.ImportError_ as exc:
        raise HTTPException(422, str(exc))


@router.post("/imports/commit", status_code=201, dependencies=[Depends(rate_limit("import", 60))])
async def import_commit(file: UploadFile | None = File(None), text: str | None = Form(None),
                        options: str = Form("{}"), mapping: str = Form(...), reference: str = Form(...),
                        service_date: date = Form(...), allow_same_file: bool = Form(False),
                        auto_geocode: bool = Form(True),
                        db: Session = Depends(get_db), user: User = Depends(dispatcher)):
    opts = json.loads(options or "{}")
    table, st, fname = await _table(file, text, opts)
    try:
        batch = importer.commit_import(db, user.org_id, user.id, table, json.loads(mapping), st,
                                       reference, service_date, fname, opts, allow_same_file)
    except importer.ImportError_ as exc:
        db.rollback()
        raise HTTPException(409 if "já foi importado" in str(exc) else 422, str(exc))
    audit(db, user.org_id, user.id, "import", "delivery_batch", batch.id,
          {"rows": batch.row_count, "errors": batch.error_count, "source": st})
    db.commit()
    job = None
    if auto_geocode:
        job = create_job(db, user.org_id, "geocode_batch", {"batch_id": str(batch.id)})
        enqueue(job)
    return {"batch": batch_out(batch), "job_id": str(job.id) if job else None}


class ManualEntry(BaseModel):
    external_id: str | None = None
    recipient: str | None = None
    street: str
    number: str | None = None
    complement: str | None = None
    neighborhood: str | None = None
    city: str | None = None
    cep: str | None = None
    notes: str | None = None


class ManualIn(BaseModel):
    reference: str
    service_date: date
    entries: list[ManualEntry] = Field(min_length=1, max_length=2000)
    batch_id: uuid.UUID | None = None  # adicionar cartas a um lote existente


@router.post("/imports/manual", status_code=201)
def import_manual(body: ManualIn, db: Session = Depends(get_db), user: User = Depends(dispatcher)):
    table = importer.manual_table([e.model_dump() for e in body.entries])
    mapping = {f: (f if f in table.headers else None) for f in importer.FIELDS}
    if body.batch_id:
        batch = get_owned(db, DeliveryBatch, body.batch_id, user)
        rows = importer.map_rows(table, mapping)
        start = (db.scalar(select(func.max(Correspondence.row_number)).where(
            Correspondence.batch_id == batch.id)) or 0) + 1
        for k, r in enumerate(rows):
            db.add(Correspondence(
                org_id=user.org_id, batch_id=batch.id, row_number=start + k,
                external_id=r.values.get("external_id"), raw_row=r.raw, recipient=r.values.get("recipient"),
                street=r.values.get("street"), number=r.values.get("number"),
                complement=r.values.get("complement"), neighborhood=r.values.get("neighborhood"),
                city=r.values.get("city"), cep=r.values.get("cep"), notes=r.values.get("notes"),
                validation_errors=[{"level": "error", "msg": e} for e in r.errors]
                + [{"level": "warning", "msg": w} for w in r.warnings]))
        batch.row_count += len(rows)
    else:
        batch = importer.commit_import(db, user.org_id, user.id, table, mapping, "manual",
                                       body.reference, body.service_date, None, {})
    audit(db, user.org_id, user.id, "manual_entry", "delivery_batch", batch.id, {"rows": len(body.entries)})
    db.commit()
    return {"batch": batch_out(batch)}


@router.get("/batches")
def list_batches(db: Session = Depends(get_db), user: User = Depends(current_user),
                 limit: int = Query(50, le=200), offset: int = 0):
    q = (select(DeliveryBatch).where(DeliveryBatch.org_id == user.org_id)
         .order_by(DeliveryBatch.service_date.desc(), DeliveryBatch.created_at.desc()).limit(limit).offset(offset))
    return [batch_out(b) for b in db.scalars(q)]


@router.get("/batches/{batch_id}")
def get_batch(batch_id: uuid.UUID, db: Session = Depends(get_db), user: User = Depends(current_user)):
    b = get_owned(db, DeliveryBatch, batch_id, user)
    counts = dict(db.execute(select(Correspondence.status, func.count())
                             .where(Correspondence.batch_id == b.id).group_by(Correspondence.status)).all())
    prec = dict(db.execute(
        select(Address.precision, func.count(func.distinct(Address.id)))
        .join(Correspondence, Correspondence.address_id == Address.id)
        .where(Correspondence.batch_id == b.id).group_by(Address.precision)).all())
    review = db.scalar(select(func.count(func.distinct(Address.id))).join(
        Correspondence, Correspondence.address_id == Address.id).where(
        Correspondence.batch_id == b.id, Address.needs_review.is_(True))) or 0
    no_addr = db.scalar(select(func.count()).select_from(Correspondence).where(
        Correspondence.batch_id == b.id, Correspondence.address_id.is_(None))) or 0
    stops = db.scalar(select(func.count()).select_from(Stop).where(Stop.batch_id == b.id, Stop.excluded.is_(False))) or 0
    stop_status = dict(db.execute(select(Stop.status, func.count()).where(
        Stop.batch_id == b.id, Stop.excluded.is_(False)).group_by(Stop.status)).all())
    last_job = db.scalar(select(Job).where(Job.org_id == user.org_id, Job.params["batch_id"].as_string() == str(b.id))
                         .order_by(Job.created_at.desc()).limit(1))
    return {**batch_out(b), "status_counts": counts, "precision_counts": prec, "needs_review": review,
            "without_address": no_addr, "stops": stops, "stop_status": stop_status,
            "correspondences": sum(counts.values()),
            "last_job": job_out(last_job) if last_job else None}


@router.get("/batches/{batch_id}/correspondences")
def list_corr(batch_id: uuid.UUID, status: str | None = None, problems: bool = False,
              limit: int = Query(200, le=2000), offset: int = 0,
              db: Session = Depends(get_db), user: User = Depends(current_user)):
    get_owned(db, DeliveryBatch, batch_id, user)
    q = select(Correspondence).where(Correspondence.batch_id == batch_id)
    if status:
        q = q.where(Correspondence.status == status)
    if problems:
        q = q.where((Correspondence.address_id.is_(None)) | (func.jsonb_array_length(Correspondence.validation_errors) > 0))
    total = db.scalar(select(func.count()).select_from(q.subquery()))
    rows = db.scalars(q.order_by(Correspondence.row_number).limit(limit).offset(offset))
    return {"total": total, "items": [corr_out(c, user) for c in rows]}


class CorrPatch(BaseModel):
    street: str | None = None
    number: str | None = None
    complement: str | None = None
    neighborhood: str | None = None
    cep: str | None = None
    notes: str | None = None
    excluded: bool | None = None
    exclusion_reason: str | None = None


@router.patch("/correspondences/{corr_id}")
def patch_corr(corr_id: uuid.UUID, body: CorrPatch, db: Session = Depends(get_db),
               user: User = Depends(dispatcher)):
    c = get_owned(db, Correspondence, corr_id, user)
    data = body.model_dump(exclude_unset=True)
    if data.get("excluded") and not data.get("exclusion_reason"):
        raise HTTPException(422, "Exclusão exige justificativa.")
    addr_changed = any(k in data for k in ("street", "number", "neighborhood", "cep"))
    for k, v in data.items():
        setattr(c, k, v)
    if addr_changed:
        na = normalize_address(c.street, c.number, c.neighborhood, c.city, c.cep)
        c.validation_errors = [{"level": "error", "msg": e} for e in na.errors] + \
                              [{"level": "warning", "msg": w} for w in na.issues]
        c.address_id = None  # será geocodificado novamente
    audit(db, user.org_id, user.id, "edit_correspondence", "correspondence", c.id,
          {k: v for k, v in data.items() if k != "notes"})
    db.commit()
    return corr_out(c, user)


# ------------------------------------------------------------ geocodificação


def job_out(j: Job) -> dict:
    return {"id": str(j.id), "kind": j.kind, "status": j.status, "progress": j.progress,
            "result": j.result, "error": (j.error or "").split("\n")[0] or None,
            "created_at": j.created_at.isoformat(), "timings": j.timings}


@router.post("/batches/{batch_id}/geocode", status_code=202)
def start_geocode(batch_id: uuid.UUID, include_street_level: bool = True, db: Session = Depends(get_db),
                  user: User = Depends(dispatcher)):
    get_owned(db, DeliveryBatch, batch_id, user)
    job = create_job(db, user.org_id, "geocode_batch",
                     {"batch_id": str(batch_id), "include_street_level": include_street_level})
    enqueue(job)
    return job_out(job)


@router.get("/jobs/{job_id}")
def get_job(job_id: uuid.UUID, db: Session = Depends(get_db), user: User = Depends(current_user)):
    return job_out(get_owned(db, Job, job_id, user))


@router.post("/batches/{batch_id}/consolidate")
def run_consolidate(batch_id: uuid.UUID, include_street_level: bool = True, db: Session = Depends(get_db),
                    user: User = Depends(dispatcher)):
    get_owned(db, DeliveryBatch, batch_id, user)
    res = consolidate(db, user.org_id, batch_id, include_street_level)
    db.commit()
    return res


@router.get("/batches/{batch_id}/addresses")
def batch_addresses(batch_id: uuid.UUID, needs_review: bool | None = None, db: Session = Depends(get_db),
                    user: User = Depends(current_user)):
    get_owned(db, DeliveryBatch, batch_id, user)
    q = (select(Address, func.count(Correspondence.id)).join(Correspondence, Correspondence.address_id == Address.id)
         .where(Correspondence.batch_id == batch_id).group_by(Address.id).order_by(Address.normalized_text))
    if needs_review is not None:
        q = q.where(Address.needs_review.is_(needs_review))
    return [address_out(a) | {"correspondences": n} for a, n in db.execute(q).all()]


class ConfirmIn(BaseModel):
    lat: float = Field(ge=-90, le=90)
    lon: float = Field(ge=-180, le=180)


@router.post("/addresses/{address_id}/confirm")
def confirm_address(address_id: uuid.UUID, body: ConfirmIn, db: Session = Depends(get_db),
                    user: User = Depends(require_role("admin", "dispatcher", "courier"))):
    a = get_owned(db, Address, address_id, user)
    old = {"lat": a.lat, "lon": a.lon, "precision": a.precision}
    Geocoder(db, get_settings(), provider()).confirm(a, body.lat, body.lon, user.id)
    # reflete nas paradas que usam este endereço
    for s in db.scalars(select(Stop).where(Stop.address_id == a.id)):
        s.lat, s.lon = a.lat, a.lon
        s.geom = a.geom
    audit(db, user.org_id, user.id, "confirm_address", "address", a.id, {"before": old, "after": body.model_dump()})
    db.commit()
    return address_out(a)


@router.post("/addresses/{address_id}/regeocode", dependencies=[Depends(rate_limit("geocode", 30))])
def regeocode(address_id: uuid.UUID, db: Session = Depends(get_db), user: User = Depends(dispatcher)):
    a = get_owned(db, Address, address_id, user)
    na = normalize_address(a.street_name if not a.street_type else f"{a.street_type} {a.street_name}",
                           a.number, a.neighborhood, a.city, a.cep)
    try:
        Geocoder(db, get_settings(), provider()).resolve(a, na, force=True)
    except ProviderError as exc:
        raise HTTPException(502, str(exc))
    db.commit()
    return address_out(a)


# ------------------------------------------------------------ paradas


@router.get("/batches/{batch_id}/stops")
def list_stops(batch_id: uuid.UUID, db: Session = Depends(get_db), user: User = Depends(current_user)):
    get_owned(db, DeliveryBatch, batch_id, user)
    stops = list(db.scalars(select(Stop).where(Stop.batch_id == batch_id)))
    addrs = {a.id: a for a in db.scalars(select(Address).where(Address.id.in_([s.address_id for s in stops])))}
    links = db.execute(select(StopCorrespondence.stop_id, Correspondence)
                       .join(Correspondence, Correspondence.id == StopCorrespondence.correspondence_id)
                       .where(StopCorrespondence.stop_id.in_([s.id for s in stops]))).all()
    by_stop: dict = {}
    for sid, c in links:
        by_stop.setdefault(sid, []).append(corr_out(c, user))
    return [stop_out(s, addrs[s.address_id], by_stop.get(s.id, [])) for s in stops]


def stop_out(s: Stop, a: Address, corrs: list[dict]) -> dict:
    return {"id": str(s.id), "lat": s.lat, "lon": s.lon, "status": s.status, "priority": s.priority,
            "service_time_s": s.service_time_s, "excluded": s.excluded, "exclusion_reason": s.exclusion_reason,
            "address": address_out(a), "correspondences": corrs,
            "letters": len(corrs), "pending": sum(1 for c in corrs if c["status"] in ("pending", "in_route"))}


class StopPatch(BaseModel):
    priority: int | None = Field(None, ge=0, le=5)
    service_time_s: float | None = Field(None, ge=0, le=3600)
    excluded: bool | None = None
    exclusion_reason: str | None = None


@router.patch("/stops/{stop_id}")
def patch_stop(stop_id: uuid.UUID, body: StopPatch, db: Session = Depends(get_db), user: User = Depends(dispatcher)):
    s = get_owned(db, Stop, stop_id, user)
    data = body.model_dump(exclude_unset=True)
    if data.get("excluded") and not data.get("exclusion_reason"):
        raise HTTPException(422, "Exclusão exige justificativa.")
    for k, v in data.items():
        setattr(s, k, v)
    audit(db, user.org_id, user.id, "edit_stop", "stop", s.id, data)
    db.commit()
    return {"id": str(s.id), **data}


# ------------------------------------------------------------ eventos


class EventIn(BaseModel):
    status: str
    reason: str | None = None
    notes: str | None = Field(None, max_length=1000)
    occurred_at: str | None = None
    client_event_id: str | None = Field(None, max_length=80)
    route_id: uuid.UUID | None = None
    corrects_event_id: uuid.UUID | None = None


def event_out(e: DeliveryEvent) -> dict:
    return {"id": str(e.id), "correspondence_id": str(e.correspondence_id), "status": e.status,
            "previous_status": e.previous_status, "reason": e.reason, "notes": e.notes,
            "occurred_at": e.occurred_at.isoformat(), "received_at": e.received_at.isoformat(),
            "user_id": str(e.user_id), "source": e.source,
            "corrects_event_id": str(e.corrects_event_id) if e.corrects_event_id else None}


@router.post("/correspondences/{corr_id}/events", status_code=201)
def post_event(corr_id: uuid.UUID, body: EventIn, db: Session = Depends(get_db), user: User = Depends(current_user)):
    from datetime import datetime

    try:
        occurred = datetime.fromisoformat(body.occurred_at) if body.occurred_at else None
        res = record_event(db, user, corr_id, body.status, body.reason, body.notes, occurred,
                           body.client_event_id, body.route_id, body.corrects_event_id)
    except (EventError, ValueError) as exc:
        db.rollback()
        raise HTTPException(422, str(exc))
    db.commit()
    c = db.get(Correspondence, corr_id)
    return {"event": event_out(res.event), "applied": res.applied, "duplicate": res.duplicate,
            "conflict": res.conflict, "correspondence": corr_out(c, user)}


@router.get("/correspondences/{corr_id}/events")
def list_events(corr_id: uuid.UUID, db: Session = Depends(get_db), user: User = Depends(current_user)):
    get_owned(db, Correspondence, corr_id, user)
    return [event_out(e) for e in db.scalars(select(DeliveryEvent).where(
        DeliveryEvent.correspondence_id == corr_id).order_by(DeliveryEvent.occurred_at))]


@router.get("/meta/reasons")
def reasons():
    return list(REASONS)
