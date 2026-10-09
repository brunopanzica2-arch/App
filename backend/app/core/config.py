"""Configuração via variáveis de ambiente (nunca segredos no código)."""

from __future__ import annotations

from functools import lru_cache
from typing import Literal

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    environment: Literal["development", "test", "production"] = "development"
    database_url: str = "postgresql+psycopg://rota:rota@localhost:5432/rota"
    redis_url: str | None = None  # sem Redis: tarefas em thread no próprio processo
    jobs_inline: bool = False     # testes: executa a tarefa na própria requisição

    jwt_secret: str = Field("dev-only-change-me", min_length=16)
    jwt_expire_minutes: int = 12 * 60
    cors_origins: str = "http://localhost:3000"

    # Ponto de partida padrão (geocodificado e confirmado pelo usuário).
    default_start_address: str = "Rua Joaquim Távora, 480, Santos/SP"
    default_city: str = "Santos"
    default_state: str = "SP"

    # Geocodificação
    geocoder: Literal["nominatim", "mock"] = "nominatim"
    nominatim_url: str = "https://nominatim.openstreetmap.org"
    nominatim_email: str | None = None
    geocoder_min_interval_s: float = 1.05  # política do Nominatim público: 1 req/s
    geocoder_max_retries: int = 3
    geocoder_daily_quota: int = 5000
    geocode_cache_days: int = 180

    # Roteamento
    routing_engine: Literal["internal", "valhalla"] = "internal"
    valhalla_url: str = "http://localhost:8002"
    osm_source: Literal["overpass", "osmapi", "pbf", "file"] = "overpass"
    osm_pbf_path: str | None = None
    osm_json_path: str | None = None
    # (sul, oeste, norte, leste) — porção insular de Santos + margem
    operation_bbox: str = "-24.0050,-46.4150,-23.9150,-46.2950"
    data_dir: str = "./data"

    # Otimização
    default_ride_speed_kmh: float = 15.0
    default_walk_speed_kmh: float = 4.5
    default_service_time_s: float = 45.0
    solver_time_limit_s: int = 20

    # LGPD
    retention_days: int = 365
    rate_limit_per_minute: int = 120

    @property
    def bbox(self) -> tuple[float, float, float, float]:
        s, w, n, e = (float(x) for x in self.operation_bbox.split(","))
        return (s, w, n, e)


@lru_cache
def get_settings() -> Settings:
    return Settings()
