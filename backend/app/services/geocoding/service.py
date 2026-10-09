"""Resolução de endereços: cache próprio de imóveis confirmados -> cache de
consultas -> provedor externo. Mantém precisão, confiança, fonte e revisão."""

from __future__ import annotations

import hashlib
import json
import uuid
from datetime import datetime, timedelta, timezone
from typing import Callable

from geoalchemy2.elements import WKTElement
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from ...core.config import Settings
from ...models import Address, Correspondence, GeocodingCache
from ..normalize import NormalizedAddress, norm_token_text, normalize_address
from .providers import Candidate, Provider, ProviderError, QuotaExceeded

GOOD = ("exact", "interpolated", "manual")
ROUTABLE = ("exact", "interpolated", "manual", "street")


def point(lat: float, lon: float) -> WKTElement:
    return WKTElement(f"POINT({lon} {lat})", srid=4326)


def _qhash(provider: str, q: dict) -> str:
    return hashlib.sha256((provider + json.dumps(q, sort_keys=True)).encode()).hexdigest()


def _same_road(cand: Candidate, na: NormalizedAddress) -> bool:
    if not cand.road:
        return False
    a = set(norm_token_text(cand.road).split()) - {"RUA", "AVENIDA", "DE", "DA", "DO", "DOS", "DAS", "PRACA", "TRAVESSA"}
    b = set(na.street_name.split()) - {"DE", "DA", "DO", "DOS", "DAS"}
    if not b:
        return False
    return len(a & b) / len(b) >= 0.6


class Geocoder:
    def __init__(self, db: Session, settings: Settings, provider: Provider):
        self.db = db
        self.s = settings
        self.p = provider

    # -------------------------------------------------- quota e cache

    def _quota_used_today(self) -> int:
        start = datetime.now(timezone.utc).replace(hour=0, minute=0, second=0, microsecond=0)
        return self.db.scalar(select(func.count()).select_from(GeocodingCache).where(
            GeocodingCache.provider == self.p.name, GeocodingCache.created_at >= start)) or 0

    def search(self, query: dict) -> tuple[list[Candidate], bool]:
        """Retorna candidatos e se vieram do cache. Deduplica consultas."""
        h = _qhash(self.p.name, query)
        row = self.db.scalar(select(GeocodingCache).where(
            GeocodingCache.provider == self.p.name, GeocodingCache.query_hash == h))
        now = datetime.now(timezone.utc)
        if row and row.expires_at > now:
            return [Candidate(**c) for c in row.response], True
        if self._quota_used_today() >= self.s.geocoder_daily_quota:
            raise QuotaExceeded("Cota diária de geocodificação atingida.")
        cands = self.p.search(query)
        payload = [c.to_dict() for c in cands]
        if row:
            row.response, row.created_at = payload, now
            row.expires_at = now + timedelta(days=self.s.geocode_cache_days)
        else:
            self.db.add(GeocodingCache(provider=self.p.name, query_hash=h,
                                       query=json.dumps(query, ensure_ascii=False), response=payload,
                                       expires_at=now + timedelta(days=self.s.geocode_cache_days)))
        self.db.flush()
        return cands, False

    # -------------------------------------------------- endereços

    def get_or_create_address(self, org_id: uuid.UUID, na: NormalizedAddress) -> Address:
        addr = self.db.scalar(select(Address).where(Address.org_id == org_id,
                                                    Address.normalized_key == na.key))
        if addr:
            return addr
        addr = Address(
            org_id=org_id, normalized_key=na.key, original_text=na.original_text,
            normalized_text=na.display, street_type=na.street_type, street_name=na.street_name,
            number=na.number, neighborhood=na.neighborhood, city=na.city, state=na.state,
            cep=na.cep, precision="pending",
        )
        self.db.add(addr)
        self.db.flush()
        return addr

    def resolve(self, addr: Address, na: NormalizedAddress, force: bool = False) -> Address:
        if not force and (addr.confirmed_at is not None or addr.precision in GOOD):
            return addr  # imóvel já confirmado: reaproveita sem nova consulta
        query = na.geocode_query()
        addr.geocode_query = json.dumps(query, ensure_ascii=False)
        cands, _ = self.search(query)
        if not cands and na.cep:
            q2 = {k: v for k, v in query.items() if k != "postalcode"}
            cands, _ = self.search(q2)
        if not cands and na.number:
            # tenta a rua (sem número) — resultado será marcado como aproximado
            q3 = {**{k: v for k, v in query.items() if k != "postalcode"},
                  "street": query["street"].split(" ", 1)[1] if " " in query["street"] else query["street"]}
            cands, _ = self.search(q3)
        now = datetime.now(timezone.utc)
        addr.verified_at = now
        addr.source = self.p.name
        addr.candidates = [c.to_dict() for c in cands[:5]]
        if not cands:
            addr.precision, addr.confidence = "not_found", 0.0
            addr.lat = addr.lon = None
            addr.geom = None
            addr.needs_review, addr.review_reason = True, "Endereço não localizado pelo provedor."
            return addr
        city_ok = [c for c in cands if not c.city or norm_token_text(c.city) == norm_token_text(na.city)]
        pool = city_ok or cands
        best = max(pool, key=lambda c: (c.precision in GOOD, c.confidence))
        reasons = []
        conf = best.confidence
        if not city_ok:
            reasons.append("Resultado fora do município informado.")
            conf *= 0.3
        if not _same_road(best, na):
            reasons.append(f"Logradouro retornado ('{best.road}') difere do informado.")
            conf *= 0.5
        distinct = {(round(c.lat, 3), round(c.lon, 3)) for c in pool if c.precision in GOOD}
        if len(distinct) > 1:
            reasons.append(f"{len(distinct)} candidatos distintos (endereço ambíguo).")
            conf *= 0.6
        if best.precision == "street":
            reasons.append("Número não localizado: ponto aproximado na rua.")
        if best.precision == "neighborhood":
            reasons.append("Somente o bairro foi localizado.")
        if na.cep and best.postcode and best.postcode.replace("-", "") != na.cep.replace("-", ""):
            reasons.append(f"CEP retornado ({best.postcode}) difere do informado.")
            conf *= 0.8
        addr.lat, addr.lon = best.lat, best.lon
        addr.geom = point(best.lat, best.lon)
        addr.precision = best.precision
        addr.confidence = round(conf, 3)
        addr.provider_ref = best.provider_ref
        addr.needs_review = bool(reasons) or best.precision not in GOOD
        addr.review_reason = " ".join(reasons) or None
        return addr

    def confirm(self, addr: Address, lat: float, lon: float, user_id: uuid.UUID) -> Address:
        addr.lat, addr.lon = lat, lon
        addr.geom = point(lat, lon)
        addr.precision, addr.confidence = "manual", 1.0
        addr.source = "manual"
        addr.needs_review, addr.review_reason = False, None
        addr.confirmed_by, addr.confirmed_at = user_id, datetime.now(timezone.utc)
        return addr


def geocode_batch(db: Session, settings: Settings, provider: Provider, org_id: uuid.UUID,
                  batch_id: uuid.UUID, progress: Callable[[float], None] | None = None,
                  default_city: str = "Santos") -> dict:
    """Normaliza e geocodifica todas as cartas do lote (uma consulta por imóvel)."""
    g = Geocoder(db, settings, provider)
    corrs = list(db.scalars(select(Correspondence).where(
        Correspondence.batch_id == batch_id, Correspondence.org_id == org_id)))
    by_key: dict[str, tuple[NormalizedAddress, list[Correspondence]]] = {}
    skipped = 0
    for c in corrs:
        na = normalize_address(c.street, c.number, c.neighborhood, c.city, c.cep, default_city)
        if na.errors:
            skipped += 1
            continue
        by_key.setdefault(na.key, (na, []))[1].append(c)
    stats = {"addresses": len(by_key), "correspondences": len(corrs), "invalid": skipped,
             "precision": {}, "errors": [], "provider_calls_failed": 0}
    for i, (key, (na, items)) in enumerate(by_key.items()):
        addr = g.get_or_create_address(org_id, na)
        try:
            g.resolve(addr, na)
        except QuotaExceeded as exc:
            stats["errors"].append(str(exc))
            break
        except ProviderError as exc:
            stats["provider_calls_failed"] += 1
            stats["errors"].append(f"{na.display}: {exc}")
        for c in items:
            c.address_id = addr.id
        stats["precision"][addr.precision] = stats["precision"].get(addr.precision, 0) + 1
        db.commit()  # progresso persistido: falha posterior não perde o trabalho
        if progress:
            progress((i + 1) / max(len(by_key), 1))
    return stats
