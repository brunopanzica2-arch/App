"""Relatórios: estimativas (planejado) separadas de registros (eventos reais)."""

from __future__ import annotations

import csv
import io
import uuid
from datetime import date, timedelta

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from ..models import Address, Correspondence, DeliveryBatch, DeliveryEvent, Route, Stop


def batch_report(db: Session, org_id: uuid.UUID, batch_id: uuid.UUID) -> dict:
    batch = db.get(DeliveryBatch, batch_id)
    if batch is None or batch.org_id != org_id:
        raise LookupError("Lote não encontrado.")
    status_counts = dict(db.execute(
        select(Correspondence.status, func.count()).where(Correspondence.batch_id == batch_id)
        .group_by(Correspondence.status)).all())
    total = sum(status_counts.values())
    delivered = status_counts.get("delivered", 0)
    stops = db.scalar(select(func.count()).select_from(Stop).where(Stop.batch_id == batch_id,
                                                                   Stop.excluded.is_(False))) or 0
    props = db.scalar(select(func.count(func.distinct(Correspondence.address_id)))
                      .where(Correspondence.batch_id == batch_id)) or 0
    route = db.scalar(select(Route).where(Route.batch_id == batch_id, Route.status.in_(["active", "finished"]))
                      .order_by(Route.version.desc()).limit(1)) or db.scalar(
        select(Route).where(Route.batch_id == batch_id).order_by(Route.version.desc()).limit(1))
    first_route = db.scalar(select(Route).where(Route.batch_id == batch_id).order_by(Route.version).limit(1))
    ev = db.execute(select(func.min(DeliveryEvent.occurred_at), func.max(DeliveryEvent.occurred_at),
                           func.count()).join(Correspondence, Correspondence.id == DeliveryEvent.correspondence_id)
                    .where(Correspondence.batch_id == batch_id)).one()
    reasons = dict(db.execute(
        select(DeliveryEvent.reason, func.count()).join(Correspondence, Correspondence.id == DeliveryEvent.correspondence_id)
        .where(Correspondence.batch_id == batch_id, DeliveryEvent.reason.is_not(None))
        .group_by(DeliveryEvent.reason)).all())
    nb_col = func.coalesce(Address.neighborhood, Correspondence.neighborhood, "(sem bairro)").label("nb")
    by_nb = db.execute(
        select(nb_col, Correspondence.status, func.count())
        .join(Address, Address.id == Correspondence.address_id, isouter=True)
        .where(Correspondence.batch_id == batch_id).group_by(nb_col, Correspondence.status)).all()
    neighborhoods: dict[str, dict] = {}
    for nb, st, n in by_nb:
        d = neighborhoods.setdefault(nb, {"total": 0})
        d[st] = d.get(st, 0) + n
        d["total"] += n
    recorded_s = (ev[1] - ev[0]).total_seconds() if ev[0] and ev[1] else None
    return {
        "batch": {"id": str(batch.id), "reference": batch.reference, "service_date": batch.service_date.isoformat(),
                  "status": batch.status},
        "correspondences": total,
        "status_counts": status_counts,
        "delivered": delivered,
        "completion_rate": round(delivered / total, 4) if total else 0.0,
        "stops": stops,
        "unique_properties": props,
        "planned": None if not route else {
            "route_version": route.version, "engine": route.engine,
            "distance_m": route.total_distance_m, "travel_time_s": route.travel_time_s,
            "service_time_s": route.service_time_s, "total_time_s": route.total_time_s,
            "note": "Estimativa calculada pela malha de pedestres; não é medição.",
        },
        "first_plan": None if not first_route else {
            "version": first_route.version, "distance_m": first_route.total_distance_m,
            "total_time_s": first_route.total_time_s},
        "recorded": {
            "events": ev[2], "first_event_at": ev[0].isoformat() if ev[0] else None,
            "last_event_at": ev[1].isoformat() if ev[1] else None,
            "elapsed_between_first_and_last_event_s": recorded_s,
            "distance_travelled_m": None,
            "note": "Sem rastreamento de GPS: a distância realmente percorrida não é medida.",
        },
        "planned_vs_recorded_s": (recorded_s - route.total_time_s) if (recorded_s and route) else None,
        "occurrences_by_reason": reasons,
        "by_neighborhood": neighborhoods,
    }


def history(db: Session, org_id: uuid.UUID, start: date, end: date, group: str = "day") -> list[dict]:
    trunc = {"day": "day", "week": "week", "month": "month"}[group]
    rows = db.execute(
        select(func.date_trunc(trunc, DeliveryBatch.service_date).label("p"), Correspondence.status, func.count())
        .join(Correspondence, Correspondence.batch_id == DeliveryBatch.id)
        .where(DeliveryBatch.org_id == org_id, DeliveryBatch.service_date >= start,
               DeliveryBatch.service_date <= end)
        .group_by("p", Correspondence.status).order_by("p")).all()
    out: dict[str, dict] = {}
    for p, st, n in rows:
        d = out.setdefault(p.date().isoformat(), {"period": p.date().isoformat(), "total": 0})
        d[st] = n
        d["total"] += n
    for d in out.values():
        d["completion_rate"] = round(d.get("delivered", 0) / d["total"], 4) if d["total"] else 0
    return list(out.values())


def export_rows(db: Session, org_id: uuid.UUID, batch_id: uuid.UUID, with_recipients: bool) -> tuple[list[str], list[list]]:
    headers = ["identificador", "linha", "logradouro", "numero", "complemento", "bairro", "cep",
               "status", "precisao_geocodificacao", "endereco_normalizado", "parada_sequencia"]
    if with_recipients:
        headers.insert(1, "destinatario")
    route = db.scalar(select(Route).where(Route.batch_id == batch_id).order_by(Route.version.desc()).limit(1))
    seq = {rs.stop_id: rs.sequence for rs in (route.stops if route else [])}
    from ..models import StopCorrespondence
    q = (select(Correspondence, Address, StopCorrespondence.stop_id)
         .join(Address, Address.id == Correspondence.address_id, isouter=True)
         .join(StopCorrespondence, StopCorrespondence.correspondence_id == Correspondence.id, isouter=True)
         .where(Correspondence.batch_id == batch_id, Correspondence.org_id == org_id)
         .order_by(Correspondence.row_number))
    rows = []
    for c, a, sid in db.execute(q).all():
        r = [c.external_id, c.row_number, c.street, c.number, c.complement, c.neighborhood, c.cep,
             c.status, a.precision if a else "pendente", a.normalized_text if a else "", seq.get(sid)]
        if with_recipients:
            r.insert(1, c.recipient)
        rows.append(r)
    return headers, rows


def to_csv(headers, rows) -> bytes:
    buf = io.StringIO()
    w = csv.writer(buf, delimiter=";")
    w.writerow(headers)
    w.writerows(rows)
    return buf.getvalue().encode("utf-8-sig")


def to_xlsx(headers, rows) -> bytes:
    from openpyxl import Workbook

    wb = Workbook()
    ws = wb.active
    ws.title = "Correspondencias"
    ws.append(headers)
    for r in rows:
        ws.append(r)
    buf = io.BytesIO()
    wb.save(buf)
    return buf.getvalue()


__all__ = ["batch_report", "history", "export_rows", "to_csv", "to_xlsx", "timedelta"]
