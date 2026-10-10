"""Modelo de dados.

Correspondência, endereço, parada e rota são entidades separadas:
- correspondence: uma carta (nunca mesclada com outra);
- address: imóvel geocodificado (reaproveitado entre jornadas);
- stop: parada física de um lote (agrupa cartas do mesmo endereço confirmado);
- route / route_stops: versão de sequência otimizada (histórico preservado).
"""

from __future__ import annotations

import uuid
from datetime import date, datetime, timezone

from geoalchemy2 import Geography
from sqlalchemy import (
    JSON, Boolean, Date, DateTime, Float, ForeignKey, Index, Integer, String, Text,
    UniqueConstraint, text,
)
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from .core.db import Base

JSONType = JSON().with_variant(JSONB(), "postgresql")


def now() -> datetime:
    return datetime.now(timezone.utc)


def uid() -> uuid.UUID:
    return uuid.uuid4()


class TimestampMixin:
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now, nullable=False)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=now, onupdate=now, nullable=False
    )


class Organization(Base, TimestampMixin):
    __tablename__ = "organizations"
    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uid)
    name: Mapped[str] = mapped_column(String(200), nullable=False)
    settings: Mapped[dict] = mapped_column(JSONType, default=dict, nullable=False)


class User(Base, TimestampMixin):
    __tablename__ = "users"
    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uid)
    org_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("organizations.id"), index=True, nullable=False)
    email: Mapped[str] = mapped_column(String(320), unique=True, nullable=False)
    name: Mapped[str] = mapped_column(String(200), nullable=False)
    password_hash: Mapped[str] = mapped_column(String(200), nullable=False)
    # admin | dispatcher | courier
    role: Mapped[str] = mapped_column(String(20), nullable=False, default="courier")
    can_view_recipients: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    active: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)


class DeliveryBatch(Base, TimestampMixin):
    __tablename__ = "delivery_batches"
    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uid)
    org_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("organizations.id"), index=True, nullable=False)
    reference: Mapped[str] = mapped_column(String(120), nullable=False)
    service_date: Mapped[date] = mapped_column(Date, nullable=False)
    source_type: Mapped[str] = mapped_column(String(20), nullable=False)  # csv|xlsx|text|manual
    original_filename: Mapped[str | None] = mapped_column(String(300))
    content_sha256: Mapped[str | None] = mapped_column(String(64), index=True)
    # Entrada original preservada (texto bruto; para XLSX, linhas extraídas).
    original_content: Mapped[str | None] = mapped_column(Text)
    options: Mapped[dict] = mapped_column(JSONType, default=dict, nullable=False)
    column_mapping: Mapped[dict] = mapped_column(JSONType, default=dict, nullable=False)
    # draft | importing | imported | geocoding | ready | failed
    status: Mapped[str] = mapped_column(String(20), default="draft", nullable=False)
    row_count: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    error_count: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    import_report: Mapped[dict] = mapped_column(JSONType, default=dict, nullable=False)
    created_by: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("users.id"))


class Address(Base, TimestampMixin):
    __tablename__ = "addresses"
    __table_args__ = (
        UniqueConstraint("org_id", "normalized_key", name="uq_address_key"),
        Index("ix_addresses_geom", "geom", postgresql_using="gist"),
    )
    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uid)
    org_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("organizations.id"), index=True, nullable=False)
    normalized_key: Mapped[str] = mapped_column(String(400), nullable=False)
    original_text: Mapped[str] = mapped_column(Text, nullable=False)
    normalized_text: Mapped[str] = mapped_column(Text, nullable=False)
    street_type: Mapped[str | None] = mapped_column(String(40))
    street_name: Mapped[str] = mapped_column(String(300), nullable=False)
    number: Mapped[str | None] = mapped_column(String(20))
    neighborhood: Mapped[str | None] = mapped_column(String(120))
    city: Mapped[str] = mapped_column(String(120), nullable=False)
    state: Mapped[str] = mapped_column(String(2), nullable=False)
    cep: Mapped[str | None] = mapped_column(String(9))
    geocode_query: Mapped[str | None] = mapped_column(Text)
    lat: Mapped[float | None] = mapped_column(Float)
    lon: Mapped[float | None] = mapped_column(Float)
    geom = mapped_column(Geography("POINT", srid=4326, spatial_index=False), nullable=True)
    # exact | interpolated | street | neighborhood | not_found | manual | pending
    precision: Mapped[str] = mapped_column(String(20), default="pending", nullable=False)
    confidence: Mapped[float] = mapped_column(Float, default=0.0, nullable=False)
    source: Mapped[str | None] = mapped_column(String(40))
    provider_ref: Mapped[str | None] = mapped_column(String(120))
    candidates: Mapped[list] = mapped_column(JSONType, default=list, nullable=False)
    needs_review: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    review_reason: Mapped[str | None] = mapped_column(Text)
    verified_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    confirmed_by: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("users.id"))
    confirmed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    # V3: portaria/entrada confirmada (separada da localização postal lat/lon acima)
    entrance_lat: Mapped[float | None] = mapped_column(Float)
    entrance_lon: Mapped[float | None] = mapped_column(Float)
    entrance_note: Mapped[str | None] = mapped_column(String(200))
    entrance_confirmed_by: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("users.id"))
    entrance_confirmed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class AddressLocationHistory(Base):
    """Histórico de alterações de posição/entrada de um endereço (permite reverter e auditar)."""
    __tablename__ = "address_location_history"
    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uid)
    org_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("organizations.id"), index=True, nullable=False)
    address_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("addresses.id", ondelete="CASCADE"), index=True, nullable=False)
    user_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("users.id"))
    action: Mapped[str] = mapped_column(String(30), nullable=False)  # confirm_pin|set_entrance|clear_entrance|invalidate
    before: Mapped[dict] = mapped_column(JSONType, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now, nullable=False)


class Correspondence(Base, TimestampMixin):
    __tablename__ = "correspondences"
    __table_args__ = (
        Index(
            "uq_corr_external_id", "org_id", "external_id", unique=True,
            postgresql_where=text("external_id IS NOT NULL"),
        ),
    )
    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uid)
    org_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("organizations.id"), index=True, nullable=False)
    batch_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("delivery_batches.id"), index=True, nullable=False)
    row_number: Mapped[int] = mapped_column(Integer, nullable=False)
    external_id: Mapped[str | None] = mapped_column(String(80))
    raw_row: Mapped[dict] = mapped_column(JSONType, default=dict, nullable=False)
    recipient: Mapped[str | None] = mapped_column(String(300))  # dado pessoal
    street: Mapped[str | None] = mapped_column(String(300))
    number: Mapped[str | None] = mapped_column(String(20))
    complement: Mapped[str | None] = mapped_column(String(200))
    neighborhood: Mapped[str | None] = mapped_column(String(120))
    city: Mapped[str | None] = mapped_column(String(120))
    cep: Mapped[str | None] = mapped_column(String(9))
    notes: Mapped[str | None] = mapped_column(Text)
    # pending | in_route | delivered | not_delivered | postponed | returned | address_not_found
    status: Mapped[str] = mapped_column(String(20), default="pending", nullable=False, index=True)
    validation_errors: Mapped[list] = mapped_column(JSONType, default=list, nullable=False)
    excluded: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    exclusion_reason: Mapped[str | None] = mapped_column(Text)
    address_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("addresses.id"), index=True)
    address: Mapped[Address | None] = relationship()


class Stop(Base, TimestampMixin):
    __tablename__ = "stops"
    __table_args__ = (UniqueConstraint("batch_id", "address_id", name="uq_stop_batch_address"),)
    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uid)
    org_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("organizations.id"), index=True, nullable=False)
    batch_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("delivery_batches.id"), index=True, nullable=False)
    address_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("addresses.id"), nullable=False)
    lat: Mapped[float] = mapped_column(Float, nullable=False)
    lon: Mapped[float] = mapped_column(Float, nullable=False)
    geom = mapped_column(Geography("POINT", srid=4326, spatial_index=True), nullable=True)
    service_time_s: Mapped[float | None] = mapped_column(Float)
    priority: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    # Status derivado das cartas: pending | partial | completed | postponed | problem
    status: Mapped[str] = mapped_column(String(20), default="pending", nullable=False)
    excluded: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    exclusion_reason: Mapped[str | None] = mapped_column(Text)
    address: Mapped[Address] = relationship()
    correspondences: Mapped[list[Correspondence]] = relationship(secondary="stop_correspondences")


class StopCorrespondence(Base):
    __tablename__ = "stop_correspondences"
    stop_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("stops.id", ondelete="CASCADE"), primary_key=True)
    correspondence_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("correspondences.id"), primary_key=True, unique=True
    )


class Route(Base, TimestampMixin):
    __tablename__ = "routes"
    __table_args__ = (UniqueConstraint("batch_id", "version", name="uq_route_version"),)
    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uid)
    org_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("organizations.id"), index=True, nullable=False)
    batch_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("delivery_batches.id"), index=True, nullable=False)
    version: Mapped[int] = mapped_column(Integer, nullable=False)
    parent_route_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("routes.id"))
    # planned | active | superseded | finished
    status: Mapped[str] = mapped_column(String(20), default="planned", nullable=False)
    route_mode: Mapped[str] = mapped_column(String(20), nullable=False)
    strategy: Mapped[str] = mapped_column(String(20), default="global", nullable=False)
    start_label: Mapped[str] = mapped_column(Text, nullable=False)
    start_lat: Mapped[float] = mapped_column(Float, nullable=False)
    start_lon: Mapped[float] = mapped_column(Float, nullable=False)
    end_label: Mapped[str | None] = mapped_column(Text)
    end_lat: Mapped[float | None] = mapped_column(Float)
    end_lon: Mapped[float | None] = mapped_column(Float)
    profile: Mapped[dict] = mapped_column(JSONType, default=dict, nullable=False)
    engine: Mapped[str] = mapped_column(String(40), nullable=False)
    network_version: Mapped[str | None] = mapped_column(String(64))
    total_time_s: Mapped[float] = mapped_column(Float, default=0, nullable=False)
    travel_time_s: Mapped[float] = mapped_column(Float, default=0, nullable=False)
    service_time_s: Mapped[float] = mapped_column(Float, default=0, nullable=False)
    total_distance_m: Mapped[float] = mapped_column(Float, default=0, nullable=False)
    metrics: Mapped[dict] = mapped_column(JSONType, default=dict, nullable=False)
    candidates: Mapped[list] = mapped_column(JSONType, default=list, nullable=False)
    geojson: Mapped[dict] = mapped_column(JSONType, default=dict, nullable=False)
    geom = mapped_column(Geography("MULTILINESTRING", srid=4326, spatial_index=False), nullable=True)
    warnings: Mapped[list] = mapped_column(JSONType, default=list, nullable=False)
    diff: Mapped[dict] = mapped_column(JSONType, default=dict, nullable=False)
    created_by: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("users.id"))
    stops: Mapped[list["RouteStop"]] = relationship(order_by="RouteStop.sequence", cascade="all, delete-orphan")


class RouteStop(Base):
    __tablename__ = "route_stops"
    __table_args__ = (UniqueConstraint("route_id", "sequence", name="uq_route_seq"),)
    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uid)
    route_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("routes.id", ondelete="CASCADE"), index=True, nullable=False)
    stop_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("stops.id"), nullable=False)
    sequence: Mapped[int] = mapped_column(Integer, nullable=False)
    eta_s: Mapped[float] = mapped_column(Float, nullable=False)
    leg_distance_m: Mapped[float] = mapped_column(Float, nullable=False)
    leg_time_s: Mapped[float] = mapped_column(Float, nullable=False)
    snap_lat: Mapped[float | None] = mapped_column(Float)
    snap_lon: Mapped[float | None] = mapped_column(Float)
    snap_distance_m: Mapped[float | None] = mapped_column(Float)
    locked: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    # snapshot do status quando a versão foi criada (concluídas ficam preservadas)
    status_at_plan: Mapped[str] = mapped_column(String(20), default="pending", nullable=False)
    stop: Mapped[Stop] = relationship()


class DeliveryEvent(Base):
    __tablename__ = "delivery_events"
    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uid)
    org_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("organizations.id"), index=True, nullable=False)
    correspondence_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("correspondences.id"), index=True, nullable=False)
    stop_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("stops.id"))
    route_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("routes.id"))
    user_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id"), nullable=False)
    previous_status: Mapped[str] = mapped_column(String(20), nullable=False)
    status: Mapped[str] = mapped_column(String(20), nullable=False)
    reason: Mapped[str | None] = mapped_column(String(120))
    notes: Mapped[str | None] = mapped_column(Text)
    # evento de correção aponta para o evento corrigido (trilha de auditoria)
    corrects_event_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("delivery_events.id"))
    occurred_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    received_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now, nullable=False)
    client_event_id: Mapped[str | None] = mapped_column(String(80), unique=True)
    source: Mapped[str] = mapped_column(String(20), default="online", nullable=False)


class GeocodingCache(Base):
    __tablename__ = "geocoding_cache"
    __table_args__ = (UniqueConstraint("provider", "query_hash", name="uq_geocache"),)
    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uid)
    provider: Mapped[str] = mapped_column(String(40), nullable=False)
    query_hash: Mapped[str] = mapped_column(String(64), nullable=False)
    query: Mapped[str] = mapped_column(Text, nullable=False)
    response: Mapped[list] = mapped_column(JSONType, default=list, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now, nullable=False)
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)


class RouteMatrixMetadata(Base):
    __tablename__ = "route_matrix_metadata"
    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uid)
    org_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("organizations.id"), index=True, nullable=False)
    route_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("routes.id"))
    engine: Mapped[str] = mapped_column(String(40), nullable=False)
    network_version: Mapped[str | None] = mapped_column(String(64))
    profile_hash: Mapped[str] = mapped_column(String(64), nullable=False)
    points_hash: Mapped[str] = mapped_column(String(64), index=True, nullable=False)
    n_points: Mapped[int] = mapped_column(Integer, nullable=False)
    unreachable_pairs: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    compute_ms: Mapped[int] = mapped_column(Integer, nullable=False)
    # A matriz em si fica em arquivo .npz (não em um único registro do banco).
    storage_path: Mapped[str | None] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now, nullable=False)


class AuditLog(Base):
    __tablename__ = "audit_logs"
    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uid)
    org_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("organizations.id"), index=True)
    user_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("users.id"))
    action: Mapped[str] = mapped_column(String(80), nullable=False)
    entity: Mapped[str] = mapped_column(String(60), nullable=False)
    entity_id: Mapped[str | None] = mapped_column(String(80))
    details: Mapped[dict] = mapped_column(JSONType, default=dict, nullable=False)
    ip: Mapped[str | None] = mapped_column(String(64))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now, nullable=False, index=True)


class SyncEvent(Base):
    __tablename__ = "sync_events"
    __table_args__ = (UniqueConstraint("user_id", "client_event_id", name="uq_sync_client_event"),)
    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uid)
    org_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("organizations.id"), index=True, nullable=False)
    user_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id"), nullable=False)
    client_id: Mapped[str] = mapped_column(String(80), nullable=False)
    client_event_id: Mapped[str] = mapped_column(String(80), nullable=False)
    kind: Mapped[str] = mapped_column(String(40), nullable=False)
    payload: Mapped[dict] = mapped_column(JSONType, default=dict, nullable=False)
    # applied | conflict | rejected
    status: Mapped[str] = mapped_column(String(20), nullable=False)
    result: Mapped[dict] = mapped_column(JSONType, default=dict, nullable=False)
    received_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now, nullable=False)


class Job(Base, TimestampMixin):
    __tablename__ = "jobs"
    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uid)
    org_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("organizations.id"), index=True, nullable=False)
    kind: Mapped[str] = mapped_column(String(40), nullable=False)
    # queued | running | done | failed
    status: Mapped[str] = mapped_column(String(20), default="queued", nullable=False)
    progress: Mapped[float] = mapped_column(Float, default=0.0, nullable=False)
    params: Mapped[dict] = mapped_column(JSONType, default=dict, nullable=False)
    result: Mapped[dict] = mapped_column(JSONType, default=dict, nullable=False)
    error: Mapped[str | None] = mapped_column(Text)
    timings: Mapped[dict] = mapped_column(JSONType, default=dict, nullable=False)
