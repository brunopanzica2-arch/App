"""Registro de status por correspondência (append-only, idempotente)."""

from __future__ import annotations

import uuid
from dataclasses import dataclass
from datetime import datetime, timezone

from sqlalchemy import select
from sqlalchemy.orm import Session

from ..core.audit import audit
from ..models import Correspondence, DeliveryEvent, StopCorrespondence, User
from .consolidation import refresh_stop_status

STATUSES = ("pending", "in_route", "delivered", "not_delivered", "postponed", "returned",
            "address_not_found")
REASONS = ("ausente", "recusado", "endereco_inexistente", "numero_inexistente", "mudou_se",
           "desconhecido", "acesso_impedido", "area_de_risco", "outro")


class EventError(ValueError):
    pass


@dataclass
class EventResult:
    event: DeliveryEvent
    applied: bool       # alterou o status atual
    duplicate: bool     # client_event_id já recebido (idempotência)
    conflict: bool      # evento mais antigo que o último aplicado


def record_event(db: Session, user: User, correspondence_id: uuid.UUID, status: str,
                 reason: str | None = None, notes: str | None = None,
                 occurred_at: datetime | None = None, client_event_id: str | None = None,
                 route_id: uuid.UUID | None = None, corrects_event_id: uuid.UUID | None = None,
                 source: str = "online") -> EventResult:
    if status not in STATUSES:
        raise EventError(f"Status inválido: {status}")
    if reason and reason not in REASONS:
        raise EventError(f"Motivo inválido: {reason}")
    if status in ("not_delivered", "returned", "address_not_found") and not reason:
        reason = "outro"
    if client_event_id:
        prev = db.scalar(select(DeliveryEvent).where(DeliveryEvent.client_event_id == client_event_id))
        if prev:
            if prev.org_id != user.org_id:
                raise EventError("Identificador de evento já utilizado.")
            return EventResult(prev, False, True, False)
    corr = db.get(Correspondence, correspondence_id)
    if corr is None or corr.org_id != user.org_id:
        raise EventError("Correspondência não encontrada.")
    if corrects_event_id:
        target = db.get(DeliveryEvent, corrects_event_id)
        if target is None or target.correspondence_id != corr.id:
            raise EventError("Evento corrigido inválido.")
    occurred_at = occurred_at or datetime.now(timezone.utc)
    if occurred_at.tzinfo is None:
        occurred_at = occurred_at.replace(tzinfo=timezone.utc)
    latest = db.scalar(select(DeliveryEvent).where(DeliveryEvent.correspondence_id == corr.id)
                       .order_by(DeliveryEvent.occurred_at.desc()).limit(1))
    conflict = latest is not None and latest.occurred_at > occurred_at and not corrects_event_id
    stop_id = db.scalar(select(StopCorrespondence.stop_id).where(
        StopCorrespondence.correspondence_id == corr.id))
    ev = DeliveryEvent(
        org_id=user.org_id, correspondence_id=corr.id, stop_id=stop_id, route_id=route_id,
        user_id=user.id, previous_status=corr.status, status=status, reason=reason, notes=notes,
        corrects_event_id=corrects_event_id, occurred_at=occurred_at,
        client_event_id=client_event_id, source=source,
    )
    db.add(ev)
    applied = not conflict
    if applied:
        corr.status = status
    db.flush()
    if stop_id:
        refresh_stop_status(db, stop_id)
    audit(db, user.org_id, user.id, "correction" if corrects_event_id else "delivery_event",
          "correspondence", corr.id, {"status": status, "reason": reason, "applied": applied,
                                      "conflict": conflict, "source": source})
    return EventResult(ev, applied, False, conflict)
