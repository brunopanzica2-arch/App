from __future__ import annotations

from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, EmailStr, Field
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..core.audit import audit
from ..core.config import get_settings
from ..core.db import get_db
from ..core.security import (
    create_token, current_user, hash_password, rate_limit, require_role, verify_password,
)
from ..models import Organization, User
from ..services.geocoding.providers import ProviderError
from ..workers.tasks import provider

router = APIRouter(prefix="/api", tags=["auth"])


class LoginIn(BaseModel):
    email: str
    password: str


def user_out(u: User) -> dict:
    return {"id": str(u.id), "email": u.email, "name": u.name, "role": u.role,
            "org_id": str(u.org_id), "can_view_recipients": u.can_view_recipients}


@router.post("/auth/login", dependencies=[Depends(rate_limit("login", 10))])
def login(body: LoginIn, request: Request, db: Session = Depends(get_db)):
    user = db.scalar(select(User).where(User.email == body.email.strip().lower()))
    if user is None or not user.active or not verify_password(body.password, user.password_hash):
        audit(db, None, None, "login_failed", "user", None, {"email_domain": body.email.split("@")[-1]},
              request.client.host if request.client else None)
        db.commit()
        raise HTTPException(401, "E-mail ou senha inválidos.")
    audit(db, user.org_id, user.id, "login", "user", user.id, {}, request.client.host if request.client else None)
    db.commit()
    return {"access_token": create_token(user), "token_type": "bearer", "user": user_out(user)}


@router.get("/auth/me")
def me(user: User = Depends(current_user)):
    return user_out(user)


class UserIn(BaseModel):
    email: EmailStr
    name: str = Field(min_length=1, max_length=200)
    password: str = Field(min_length=10)
    role: str = Field(pattern="^(admin|dispatcher|courier)$")
    can_view_recipients: bool = False


@router.post("/users", status_code=201)
def create_user(body: UserIn, db: Session = Depends(get_db), admin: User = Depends(require_role("admin"))):
    if db.scalar(select(User).where(User.email == body.email.lower())):
        raise HTTPException(409, "E-mail já cadastrado.")
    u = User(org_id=admin.org_id, email=body.email.lower(), name=body.name,
             password_hash=hash_password(body.password), role=body.role,
             can_view_recipients=body.can_view_recipients)
    db.add(u)
    db.flush()
    audit(db, admin.org_id, admin.id, "create_user", "user", u.id, {"role": body.role})
    db.commit()
    return user_out(u)


@router.get("/users")
def list_users(db: Session = Depends(get_db), admin: User = Depends(require_role("admin"))):
    return [user_out(u) for u in db.scalars(select(User).where(User.org_id == admin.org_id))]


# ------------------------------------------------------------ configurações


class StartIn(BaseModel):
    label: str
    lat: float = Field(ge=-90, le=90)
    lon: float = Field(ge=-180, le=180)


class SettingsIn(BaseModel):
    ride_speed_kmh: float | None = Field(None, gt=0, le=60)
    walk_speed_kmh: float | None = Field(None, gt=0, le=15)
    service_time_s: float | None = Field(None, ge=0, le=3600)
    per_letter_service_s: float | None = Field(None, ge=0, le=600)
    route_mode: str | None = Field(None, pattern="^(open|circular|fixed_end)$")
    profile: dict | None = None


def org_settings(org: Organization) -> dict:
    s = get_settings()
    base = {
        "start": None, "start_address": s.default_start_address,
        "ride_speed_kmh": s.default_ride_speed_kmh, "walk_speed_kmh": s.default_walk_speed_kmh,
        "service_time_s": s.default_service_time_s, "per_letter_service_s": 10.0,
        "route_mode": "open", "profile": {},
    }
    return base | (org.settings or {})


@router.get("/settings")
def get_org_settings(db: Session = Depends(get_db), user: User = Depends(current_user)):
    return org_settings(db.get(Organization, user.org_id))


@router.put("/settings")
def put_settings(body: SettingsIn, db: Session = Depends(get_db),
                 user: User = Depends(require_role("admin", "dispatcher"))):
    org = db.get(Organization, user.org_id)
    org.settings = org_settings(org) | {k: v for k, v in body.model_dump().items() if v is not None}
    audit(db, org.id, user.id, "update_settings", "organization", org.id, body.model_dump(exclude_none=True))
    db.commit()
    return org.settings


@router.post("/settings/start/geocode")
def geocode_start(db: Session = Depends(get_db), user: User = Depends(require_role("admin", "dispatcher"))):
    """Geocodifica o ponto inicial padrão e devolve candidatos — NÃO confirma."""
    from ..services.geocoding.service import Geocoder
    from ..services.normalize import parse_address_line, normalize_address

    s = get_settings()
    parts = parse_address_line(s.default_start_address)
    na = normalize_address(parts["street"], parts["number"], parts["neighborhood"], parts["city"], parts["cep"])
    try:
        cands, cached = Geocoder(db, s, provider()).search(na.geocode_query())
    except ProviderError as exc:
        raise HTTPException(502, str(exc))
    db.commit()
    return {"address": s.default_start_address, "query": na.geocode_query(), "cached": cached,
            "candidates": [c.to_dict() for c in cands],
            "note": "Confirme a posição exata do imóvel no mapa antes de usar."}


@router.put("/settings/start")
def confirm_start(body: StartIn, db: Session = Depends(get_db),
                  user: User = Depends(require_role("admin", "dispatcher"))):
    org = db.get(Organization, user.org_id)
    org.settings = org_settings(org) | {"start": {
        "label": body.label, "lat": body.lat, "lon": body.lon, "confirmed": True,
        "confirmed_by": str(user.id), "confirmed_at": datetime.now(timezone.utc).isoformat()}}
    audit(db, org.id, user.id, "confirm_start", "organization", org.id, {"lat": body.lat, "lon": body.lon})
    db.commit()
    return org.settings["start"]
