from __future__ import annotations

import logging

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from .api import auth, batches, routes
from .core.config import get_settings

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")

app = FastAPI(title="Roteirização de correspondências — Santos/SP",
              description="Perfil de roteamento pedestrian/foot; operação com bicicleta.",
              version="1.0.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=[o.strip() for o in get_settings().cors_origins.split(",") if o.strip()],
    allow_credentials=True, allow_methods=["*"], allow_headers=["*"],
)
app.include_router(auth.router)
app.include_router(batches.router)
app.include_router(routes.router)


@app.get("/api/health")
def health():
    s = get_settings()
    return {"status": "ok", "routing_engine": s.routing_engine, "routing_profile": "pedestrian/foot",
            "geocoder": s.geocoder, "jobs": "rq" if s.redis_url else "thread"}
