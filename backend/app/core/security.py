"""Autenticação (JWT + bcrypt), autorização por papel/organização e rate limit."""

from __future__ import annotations

import threading
import time
import uuid
from datetime import datetime, timedelta, timezone

import bcrypt
import jwt
from fastapi import Depends, HTTPException, Request, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from sqlalchemy.orm import Session

from ..models import User
from .config import get_settings
from .db import get_db

ROLES = ("admin", "dispatcher", "courier")
_bearer = HTTPBearer(auto_error=False)


def hash_password(password: str) -> str:
    return bcrypt.hashpw(password.encode(), bcrypt.gensalt(rounds=12)).decode()


def verify_password(password: str, hashed: str) -> bool:
    try:
        return bcrypt.checkpw(password.encode(), hashed.encode())
    except ValueError:
        return False


def create_token(user: User) -> str:
    s = get_settings()
    payload = {
        "sub": str(user.id),
        "org": str(user.org_id),
        "role": user.role,
        "exp": datetime.now(timezone.utc) + timedelta(minutes=s.jwt_expire_minutes),
        "iat": datetime.now(timezone.utc),
    }
    return jwt.encode(payload, s.jwt_secret, algorithm="HS256")


def current_user(
    creds: HTTPAuthorizationCredentials | None = Depends(_bearer),
    db: Session = Depends(get_db),
) -> User:
    if creds is None:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Autenticação necessária.")
    try:
        payload = jwt.decode(creds.credentials, get_settings().jwt_secret, algorithms=["HS256"])
        user_id = uuid.UUID(payload["sub"])
    except (jwt.PyJWTError, KeyError, ValueError):
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Token inválido ou expirado.")
    user = db.get(User, user_id)
    if user is None or not user.active:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Usuário inativo.")
    return user


def require_role(*roles: str):
    def dep(user: User = Depends(current_user)) -> User:
        if user.role not in roles:
            raise HTTPException(status.HTTP_403_FORBIDDEN, "Permissão insuficiente.")
        return user

    return dep


# ----------------------------------------------------------- rate limiting


class RateLimiter:
    """Janela deslizante em memória por chave (IP/usuário). Para várias
    instâncias, troque por implementação em Redis."""

    def __init__(self):
        self._hits: dict[str, list[float]] = {}
        self._lock = threading.Lock()

    def hit(self, key: str, limit: int, window_s: float = 60.0) -> bool:
        t = time.monotonic()
        with self._lock:
            hits = [h for h in self._hits.get(key, []) if t - h < window_s]
            ok = len(hits) < limit
            if ok:
                hits.append(t)
            self._hits[key] = hits
            return ok

    def reset(self) -> None:
        with self._lock:
            self._hits.clear()


limiter = RateLimiter()


def rate_limit(name: str, limit: int | None = None):
    def dep(request: Request):
        lim = limit or get_settings().rate_limit_per_minute
        ip = request.client.host if request.client else "?"
        if not limiter.hit(f"{name}:{ip}", lim):
            raise HTTPException(status.HTTP_429_TOO_MANY_REQUESTS, "Muitas requisições; tente em instantes.")

    return dep
