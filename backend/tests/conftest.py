"""Fixtures. Requer PostgreSQL+PostGIS (TEST_DATABASE_URL). Sem internet:
geocodificador MOCK e malha OSM SINTÉTICA (claramente identificados)."""

from __future__ import annotations

import os
import tempfile

os.environ.setdefault("TEST_DATABASE_URL", "postgresql+psycopg://rota:rota@localhost:5432/rota_test")
os.environ["DATABASE_URL"] = os.environ["TEST_DATABASE_URL"]
os.environ["GEOCODER"] = "mock"
os.environ["JOBS_INLINE"] = "true"
os.environ["REDIS_URL"] = ""
os.environ["ENVIRONMENT"] = "test"
os.environ["JWT_SECRET"] = "test-secret-0123456789"
os.environ["DATA_DIR"] = tempfile.mkdtemp(prefix="rota-test-")
os.environ["GEOCODER_DAILY_QUOTA"] = "100000"

import pytest  # noqa: E402
from alembic import command  # noqa: E402
from alembic.config import Config  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402
from sqlalchemy import text  # noqa: E402

from app.core.config import get_settings  # noqa: E402
from app.core.db import SessionLocal, engine, reset_engine  # noqa: E402
from app.core.security import hash_password, limiter  # noqa: E402
from app.models import Organization, User  # noqa: E402
from app.services.geocoding.providers import MockProvider  # noqa: E402
from app.services.routing.engines import InternalEngine, set_engine  # noqa: E402
from app.workers.tasks import set_provider  # noqa: E402
from roteamento.network import build_network  # noqa: E402

from .synthetic import grid_osm  # noqa: E402

HERE = os.path.dirname(os.path.dirname(__file__))
PASSWORD = "senha-segura-123"


@pytest.fixture(scope="session", autouse=True)
def database():
    get_settings.cache_clear()
    reset_engine()
    with engine().begin() as conn:
        conn.execute(text("DROP SCHEMA public CASCADE; CREATE SCHEMA public;"))
    cfg = Config(os.path.join(HERE, "alembic.ini"))
    cfg.set_main_option("script_location", os.path.join(HERE, "alembic"))
    command.upgrade(cfg, "head")
    yield
    reset_engine()


@pytest.fixture(scope="session")
def network():
    return build_network(grid_osm())


@pytest.fixture(autouse=True)
def services(network):
    set_engine(InternalEngine(get_settings(), network=network))
    set_provider(MockProvider())
    limiter.reset()
    yield
    set_engine(None)


@pytest.fixture
def db():
    s = SessionLocal()
    yield s
    s.close()


@pytest.fixture
def org(db):
    import uuid

    o = Organization(name=f"Org {uuid.uuid4().hex[:6]}", settings={})
    db.add(o)
    db.flush()
    users = {}
    for role, can in (("admin", True), ("dispatcher", True), ("courier", False)):
        u = User(org_id=o.id, email=f"{role}-{uuid.uuid4().hex[:6]}@exemplo.test", name=role.title(),
                 password_hash=hash_password(PASSWORD), role=role, can_view_recipients=can)
        db.add(u)
        users[role] = u
    db.commit()
    return o, users


@pytest.fixture
def client():
    from app.main import app

    return TestClient(app)


def login(client, user) -> dict:
    r = client.post("/api/auth/login", json={"email": user.email, "password": PASSWORD})
    assert r.status_code == 200, r.text
    return {"Authorization": f"Bearer {r.json()['access_token']}"}


@pytest.fixture
def auth(client, org):
    _, users = org
    return {role: login(client, u) for role, u in users.items()}
