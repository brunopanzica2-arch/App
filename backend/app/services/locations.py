"""Posição do endereço × portaria (entrada) × ponto na malha (V3 §4). Espelha mobile/src/core/address.ts.

Hierarquia de confiança (1 = mais confiável):
 1 portaria confirmada · 2 pino confirmado · 3 número na fonte · 4 interpolado (aproximado)
 5 só a rua (não confirmado) · 6 bairro / não localizado (nunca roteado)
"""
from __future__ import annotations

import math
import uuid
from datetime import datetime, timezone

from sqlalchemy.orm import Session

from ..models import Address, AddressLocationHistory, Stop
from .geocoding.service import point

STALE_DAYS = 365


def trust_of(a: Address) -> dict:
    if a.entrance_lat is not None:
        return {"level": 1, "code": "entrance", "label": "Portaria confirmada", "approximate": False}
    table = {
        "manual": (2, "pin", "Pino confirmado (não é portaria)", False),
        "exact": (3, "verified", "Número localizado na fonte", False),
        "test": (3, "test", "Posição de TESTE", True),
        "interpolated": (4, "interpolated", "Interpolado — aproximado", True),
        "street": (5, "street", "Só a rua — não confirmado", True),
    }
    lvl, code, label, approx = table.get(a.precision, (6, "unlocated", "Não localizado", True))
    return {"level": lvl, "code": code, "label": label, "approximate": approx}


def route_point(a: Address) -> tuple[float, float] | None:
    if a.entrance_lat is not None:
        return a.entrance_lat, a.entrance_lon
    if a.lat is not None:
        return a.lat, a.lon
    return None


def is_stale(a: Address, days: int = STALE_DAYS, now: datetime | None = None) -> bool:
    now = now or datetime.now(timezone.utc)
    return bool(a.confirmed_at and (now - a.confirmed_at).days > days)


def _snapshot(a: Address) -> dict:
    return {
        "lat": a.lat, "lon": a.lon, "precision": a.precision, "confidence": a.confidence, "source": a.source,
        "needs_review": a.needs_review, "review_reason": a.review_reason,
        "confirmed_by": str(a.confirmed_by) if a.confirmed_by else None,
        "confirmed_at": a.confirmed_at.isoformat() if a.confirmed_at else None,
        "entrance_lat": a.entrance_lat, "entrance_lon": a.entrance_lon, "entrance_note": a.entrance_note,
        "entrance_confirmed_by": str(a.entrance_confirmed_by) if a.entrance_confirmed_by else None,
        "entrance_confirmed_at": a.entrance_confirmed_at.isoformat() if a.entrance_confirmed_at else None,
    }


def _check(lat: float, lon: float) -> None:
    if not (math.isfinite(lat) and math.isfinite(lon)) or abs(lat) > 90 or abs(lon) > 180:
        raise ValueError("Coordenada inválida.")


def record(db: Session, a: Address, action: str, user_id: uuid.UUID | None) -> None:
    db.add(AddressLocationHistory(org_id=a.org_id, address_id=a.id, user_id=user_id, action=action, before=_snapshot(a)))
    db.flush()


def sync_stops(db: Session, a: Address) -> None:
    """Paradas que usam o endereço passam a usar o ponto de rota atual (portaria, se houver)."""
    pt = route_point(a)
    if pt is None:
        return
    for s in db.query(Stop).filter(Stop.address_id == a.id):
        s.lat, s.lon, s.geom = pt[0], pt[1], point(*pt)


def confirm_pin(db: Session, a: Address, lat: float, lon: float, user_id: uuid.UUID | None) -> Address:
    _check(lat, lon)
    record(db, a, "confirm_pin", user_id)
    a.lat, a.lon, a.geom = lat, lon, point(lat, lon)
    a.precision, a.confidence, a.source = "manual", 1.0, "manual"
    a.needs_review, a.review_reason = False, None
    a.confirmed_by, a.confirmed_at = user_id, datetime.now(timezone.utc)
    sync_stops(db, a)
    return a


def confirm_entrance(db: Session, a: Address, lat: float, lon: float, note: str | None,
                     user_id: uuid.UUID | None) -> Address:
    _check(lat, lon)
    record(db, a, "set_entrance", user_id)
    now = datetime.now(timezone.utc)
    a.entrance_lat, a.entrance_lon, a.entrance_note = lat, lon, (note or None)
    a.entrance_confirmed_by, a.entrance_confirmed_at = user_id, now
    a.needs_review, a.review_reason = False, None
    a.confirmed_by, a.confirmed_at = user_id, now
    if a.lat is None:  # sem posição postal anterior: a própria portaria serve de referência
        a.lat, a.lon, a.geom = lat, lon, point(lat, lon)
        a.precision, a.confidence, a.source = "manual", 1.0, "manual"
    sync_stops(db, a)
    return a


def clear_entrance(db: Session, a: Address, user_id: uuid.UUID | None) -> Address:
    record(db, a, "clear_entrance", user_id)
    a.entrance_lat = a.entrance_lon = a.entrance_note = None
    a.entrance_confirmed_by = a.entrance_confirmed_at = None
    sync_stops(db, a)
    return a


def invalidate(db: Session, a: Address, user_id: uuid.UUID | None) -> Address:
    record(db, a, "invalidate", user_id)
    a.entrance_lat = a.entrance_lon = a.entrance_note = None
    a.entrance_confirmed_by = a.entrance_confirmed_at = None
    a.confirmed_by = a.confirmed_at = None
    a.needs_review, a.review_reason = True, "Confirmação invalidada: confira de novo no mapa."
    if a.precision == "manual":
        a.precision, a.confidence = "street", 0.3
    sync_stops(db, a)
    return a


def revert_last(db: Session, a: Address) -> Address:
    h = (db.query(AddressLocationHistory).filter(AddressLocationHistory.address_id == a.id)
         .order_by(AddressLocationHistory.created_at.desc(), AddressLocationHistory.id.desc()).first())
    if h is None:
        raise ValueError("Nada para reverter.")
    b = h.before
    a.lat, a.lon = b["lat"], b["lon"]
    a.geom = point(a.lat, a.lon) if a.lat is not None else None
    a.precision, a.confidence, a.source = b["precision"], b["confidence"], b["source"]
    a.needs_review, a.review_reason = b["needs_review"], b["review_reason"]
    a.confirmed_by = uuid.UUID(b["confirmed_by"]) if b["confirmed_by"] else None
    a.confirmed_at = datetime.fromisoformat(b["confirmed_at"]) if b["confirmed_at"] else None
    a.entrance_lat, a.entrance_lon, a.entrance_note = b["entrance_lat"], b["entrance_lon"], b["entrance_note"]
    a.entrance_confirmed_by = uuid.UUID(b["entrance_confirmed_by"]) if b["entrance_confirmed_by"] else None
    a.entrance_confirmed_at = (datetime.fromisoformat(b["entrance_confirmed_at"])
                               if b["entrance_confirmed_at"] else None)
    db.delete(h)
    db.flush()
    sync_stops(db, a)
    return a
