from __future__ import annotations

import uuid

from fastapi import HTTPException
from sqlalchemy.orm import Session

from ..models import Address, Correspondence, DeliveryBatch, Route, Stop, User
from ..services.locations import is_stale, trust_of


def get_owned(db: Session, model, obj_id: uuid.UUID, user: User):
    obj = db.get(model, obj_id)
    if obj is None or getattr(obj, "org_id", None) != user.org_id:
        raise HTTPException(404, "Registro não encontrado.")
    return obj


def mask_name(name: str | None) -> str | None:
    if not name:
        return None
    parts = name.split()
    return " ".join(p[0] + "•" * (len(p) - 1) for p in parts)


def corr_out(c: Correspondence, user: User) -> dict:
    return {
        "id": str(c.id), "batch_id": str(c.batch_id), "row_number": c.row_number,
        "external_id": c.external_id,
        "recipient": c.recipient if user.can_view_recipients else mask_name(c.recipient),
        "recipient_visible": user.can_view_recipients,
        "street": c.street, "number": c.number, "complement": c.complement,
        "neighborhood": c.neighborhood, "city": c.city, "cep": c.cep, "notes": c.notes,
        "status": c.status, "validation_errors": c.validation_errors,
        "excluded": c.excluded, "exclusion_reason": c.exclusion_reason,
        "address_id": str(c.address_id) if c.address_id else None,
    }


def address_out(a: Address) -> dict:
    return {
        "id": str(a.id), "normalized_text": a.normalized_text, "original_text": a.original_text,
        "street_type": a.street_type, "street_name": a.street_name, "number": a.number,
        "neighborhood": a.neighborhood, "city": a.city, "state": a.state, "cep": a.cep,
        "lat": a.lat, "lon": a.lon, "precision": a.precision, "confidence": a.confidence,
        "source": a.source, "needs_review": a.needs_review, "review_reason": a.review_reason,
        "candidates": a.candidates, "geocode_query": a.geocode_query,
        "verified_at": a.verified_at.isoformat() if a.verified_at else None,
        "confirmed_at": a.confirmed_at.isoformat() if a.confirmed_at else None,
        "entrance": ({"lat": a.entrance_lat, "lon": a.entrance_lon, "note": a.entrance_note,
                      "confirmed_at": a.entrance_confirmed_at.isoformat() if a.entrance_confirmed_at else None}
                     if a.entrance_lat is not None else None),
        "trust": trust_of(a), "stale_confirmation": is_stale(a),
    }


def batch_out(b: DeliveryBatch) -> dict:
    return {
        "id": str(b.id), "reference": b.reference, "service_date": b.service_date.isoformat(),
        "source_type": b.source_type, "original_filename": b.original_filename, "status": b.status,
        "row_count": b.row_count, "error_count": b.error_count, "import_report": b.import_report,
        "column_mapping": b.column_mapping, "created_at": b.created_at.isoformat(),
    }


def route_summary(r: Route) -> dict:
    return {
        "id": str(r.id), "batch_id": str(r.batch_id), "version": r.version, "status": r.status,
        "route_mode": r.route_mode, "strategy": r.strategy, "engine": r.engine,
        "network_version": r.network_version, "total_time_s": r.total_time_s,
        "travel_time_s": r.travel_time_s, "service_time_s": r.service_time_s,
        "total_distance_m": r.total_distance_m, "metrics": r.metrics, "candidates": r.candidates,
        "warnings": r.warnings, "diff": r.diff, "profile": r.profile,
        "start": {"label": r.start_label, "lat": r.start_lat, "lon": r.start_lon},
        "end": {"label": r.end_label, "lat": r.end_lat, "lon": r.end_lon} if r.end_lat is not None else None,
        "parent_route_id": str(r.parent_route_id) if r.parent_route_id else None,
        "created_at": r.created_at.isoformat(),
    }


__all__ = ["get_owned", "corr_out", "address_out", "batch_out", "route_summary", "Stop"]
