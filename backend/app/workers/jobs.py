"""Tarefas em background (geocodificação de lote, planejamento).

Com REDIS_URL: fila RQ (processo `rq worker roteirizacao`).
Sem Redis: executor em thread no próprio processo da API (desenvolvimento).
O estado fica na tabela `jobs`, consultado pela interface.
"""

from __future__ import annotations

import traceback
import uuid
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone

from ..core.config import get_settings
from ..core.db import SessionLocal
from ..models import Job

_pool = ThreadPoolExecutor(max_workers=2, thread_name_prefix="jobs")
QUEUE = "roteirizacao"


def create_job(db, org_id, kind: str, params: dict) -> Job:
    job = Job(org_id=org_id, kind=kind, params=params, status="queued")
    db.add(job)
    db.commit()
    return job


def enqueue(job: Job) -> None:
    s = get_settings()
    if s.jobs_inline:
        run_job(str(job.id))
    elif s.redis_url:
        from redis import Redis
        from rq import Queue

        Queue(QUEUE, connection=Redis.from_url(s.redis_url)).enqueue(
            run_job, str(job.id), job_timeout=3600)
    else:
        _pool.submit(run_job, str(job.id))


def run_job(job_id: str) -> None:
    from . import tasks

    db = SessionLocal()
    try:
        job = db.get(Job, uuid.UUID(job_id))
        if job is None:
            return
        job.status = "running"
        job.timings = {"started_at": datetime.now(timezone.utc).isoformat()}
        db.commit()

        def progress(p: float):
            job.progress = round(p, 4)
            db.commit()

        fn = getattr(tasks, f"task_{job.kind}")
        result = fn(db, job, progress)
        job = db.get(Job, uuid.UUID(job_id))
        job.status, job.result, job.progress = "done", result or {}, 1.0
        job.timings = {**job.timings, "finished_at": datetime.now(timezone.utc).isoformat()}
        db.commit()
    except Exception as exc:  # registra e mantém o trabalho já persistido
        db.rollback()
        job = db.get(Job, uuid.UUID(job_id))
        if job:
            job.status = "failed"
            job.error = f"{exc}\n{traceback.format_exc(limit=3)}"
            db.commit()
    finally:
        db.close()
