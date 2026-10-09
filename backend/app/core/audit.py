"""Trilha de auditoria. Nunca registrar nomes de destinatários."""

from __future__ import annotations

import uuid

from sqlalchemy.orm import Session

from ..models import AuditLog

FORBIDDEN_KEYS = {"recipient", "destinatario", "raw_row"}


def audit(db: Session, org_id: uuid.UUID | None, user_id: uuid.UUID | None, action: str,
          entity: str, entity_id: str | uuid.UUID | None = None, details: dict | None = None,
          ip: str | None = None) -> None:
    safe = {k: v for k, v in (details or {}).items() if k not in FORBIDDEN_KEYS}
    db.add(AuditLog(org_id=org_id, user_id=user_id, action=action, entity=entity,
                    entity_id=str(entity_id) if entity_id else None, details=safe, ip=ip))
