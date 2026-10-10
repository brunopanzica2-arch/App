"""Consolidação de cartas em paradas físicas.

Uma parada = um endereço confirmado/localizado (mesma chave normalizada:
logradouro + número + município). Complementos diferentes (aptos, salas)
ficam na mesma parada, cada carta preservada. Imóveis vizinhos NÃO são
agrupados por proximidade.
"""

from __future__ import annotations

import uuid

from sqlalchemy import delete, select
from sqlalchemy.orm import Session

from ..models import Address, Correspondence, Stop, StopCorrespondence
from .geocoding.service import ROUTABLE, point
from .locations import route_point

TERMINAL = {"delivered", "not_delivered", "returned", "address_not_found"}
PROBLEM = {"not_delivered", "address_not_found", "returned"}


def derive_stop_status(statuses: list[str]) -> str:
    if not statuses:
        return "pending"
    if all(s in TERMINAL for s in statuses):
        return "problem" if any(s in PROBLEM for s in statuses) else "completed"
    if all(s in TERMINAL or s == "postponed" for s in statuses):
        return "postponed"
    if any(s in TERMINAL or s == "postponed" for s in statuses):
        return "partial"
    return "pending"


def consolidate(db: Session, org_id: uuid.UUID, batch_id: uuid.UUID,
                include_street_level: bool = True) -> dict:
    allowed = set(ROUTABLE) if include_street_level else set(ROUTABLE) - {"street"}
    rows = db.execute(
        select(Correspondence, Address)
        .join(Address, Correspondence.address_id == Address.id, isouter=True)
        .where(Correspondence.batch_id == batch_id, Correspondence.org_id == org_id)
    ).all()
    existing = {s.address_id: s for s in db.scalars(select(Stop).where(Stop.batch_id == batch_id))}
    groups: dict[uuid.UUID, list[Correspondence]] = {}
    unlocated = []
    excluded = 0
    for c, a in rows:
        if c.excluded:
            excluded += 1
            continue
        if a is None or a.lat is None or a.precision not in allowed:
            unlocated.append(c)
            continue
        groups.setdefault(a.id, []).append(c)

    addrs = {a.id: a for _, a in rows if a is not None}
    # recria vínculos (idempotente) preservando paradas existentes e seus IDs
    stop_ids = [s.id for s in existing.values()]
    if stop_ids:
        db.execute(delete(StopCorrespondence).where(StopCorrespondence.stop_id.in_(stop_ids)))
    stops = []
    for addr_id, items in groups.items():
        a = addrs[addr_id]
        s = existing.pop(addr_id, None)
        if s is None:
            s = Stop(org_id=org_id, batch_id=batch_id, address_id=addr_id, lat=a.lat, lon=a.lon)
            db.add(s)
        rp = route_point(a)  # portaria confirmada, se houver; senão a posição do endereço
        s.lat, s.lon, s.geom = rp[0], rp[1], point(*rp)
        s.excluded = False
        db.flush()
        db.add_all(StopCorrespondence(stop_id=s.id, correspondence_id=c.id) for c in items)
        s.status = derive_stop_status([c.status for c in items])
        stops.append(s)
    for s in existing.values():  # endereço deixou de ser roteável
        s.excluded, s.exclusion_reason = True, "Sem cartas localizadas neste endereço."
    db.flush()
    return {
        "correspondences": len(rows),
        "excluded": excluded,
        "stops": len(stops),
        "unique_properties": len(groups),
        "unlocated": len(unlocated),
        "unlocated_ids": [str(c.id) for c in unlocated],
        "max_per_stop": max((len(v) for v in groups.values()), default=0),
    }


def refresh_stop_status(db: Session, stop_id: uuid.UUID) -> str:
    statuses = list(db.scalars(
        select(Correspondence.status).join(StopCorrespondence,
                                           StopCorrespondence.correspondence_id == Correspondence.id)
        .where(StopCorrespondence.stop_id == stop_id)))
    st = derive_stop_status(statuses)
    s = db.get(Stop, stop_id)
    if s:
        s.status = st
    return st
