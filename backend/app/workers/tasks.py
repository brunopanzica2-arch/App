from __future__ import annotations

import time
import uuid

from roteamento.config import TravelProfile

from ..core.config import get_settings
from ..models import DeliveryBatch
from ..services.consolidation import consolidate
from ..services.geocoding.providers import build_provider
from ..services.geocoding.service import geocode_batch
from ..services.planner import PlanParams, plan
from ..services.routing.engines import get_engine

_provider = None


def provider():
    global _provider
    if _provider is None:
        _provider = build_provider(get_settings())
    return _provider


def set_provider(p) -> None:
    global _provider
    _provider = p


def task_geocode_batch(db, job, progress):
    s = get_settings()
    batch_id = uuid.UUID(job.params["batch_id"])
    batch = db.get(DeliveryBatch, batch_id)
    batch.status = "geocoding"
    db.commit()
    t0 = time.perf_counter()
    stats = geocode_batch(db, s, provider(), job.org_id, batch_id, progress, s.default_city)
    stats["geocode_ms"] = int((time.perf_counter() - t0) * 1000)
    stats["consolidation"] = consolidate(db, job.org_id, batch_id,
                                         job.params.get("include_street_level", True))
    batch = db.get(DeliveryBatch, batch_id)
    batch.status = "ready"
    db.commit()
    return stats


def task_plan_route(db, job, progress):
    p = dict(job.params)
    profile = TravelProfile(**p.pop("profile"))
    fixed = [uuid.UUID(x) for x in p.pop("fixed_next_stop_ids", [])]
    batch_id = uuid.UUID(p.pop("batch_id"))
    user_id = uuid.UUID(p.pop("user_id")) if p.get("user_id") else None
    p.pop("user_id", None)
    reason = p.pop("reason", "plan")
    params = PlanParams(**p, profile=profile, fixed_next_stop_ids=fixed)
    route = plan(db, get_settings(), get_engine(get_settings()), job.org_id, batch_id, params,
                 user_id, reason)
    db.commit()
    return {"route_id": str(route.id), "version": route.version}
