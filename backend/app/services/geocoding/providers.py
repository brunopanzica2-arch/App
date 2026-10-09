"""Provedores de geocodificação.

- NominatimProvider: OSM Nominatim (instância própria recomendada em produção;
  o servidor público tem limite de 1 req/s e proíbe uso massivo).
- MockProvider: SOMENTE testes/benchmarks — gera coordenadas sintéticas
  determinísticas; nunca usar em produção (o nome da fonte fica "mock").

A consulta enviada contém apenas logradouro, número, cidade, UF e CEP —
nunca o nome do destinatário nem o complemento.
"""

from __future__ import annotations

import hashlib
import threading
import time
from dataclasses import dataclass, field

import requests

from ...core.config import Settings
from ..normalize import norm_token_text


@dataclass
class Candidate:
    lat: float
    lon: float
    label: str
    # exact | interpolated | street | neighborhood | not_found
    precision: str
    confidence: float
    road: str | None = None
    house_number: str | None = None
    city: str | None = None
    neighborhood: str | None = None
    postcode: str | None = None
    provider_ref: str | None = None
    raw_type: str | None = None

    def to_dict(self) -> dict:
        return dict(self.__dict__)


class ProviderError(RuntimeError):
    pass


class QuotaExceeded(ProviderError):
    pass


class Provider:
    name = "base"

    def search(self, query: dict) -> list[Candidate]:
        raise NotImplementedError


def classify_nominatim(item: dict, wanted_number: str | None) -> Candidate:
    addr = item.get("address", {})
    cat, typ = item.get("category") or item.get("class"), item.get("type")
    hn = addr.get("house_number")
    road = addr.get("road") or addr.get("pedestrian") or addr.get("footway")
    city = addr.get("city") or addr.get("town") or addr.get("municipality")
    nb = addr.get("suburb") or addr.get("neighbourhood") or addr.get("quarter")
    addresstype = item.get("addresstype")
    if hn and wanted_number and norm_token_text(hn).split("-")[0] == norm_token_text(wanted_number):
        # Interpolações do Nominatim vêm de linhas (osm_type "way") do tipo house.
        if item.get("osm_type") == "way" and typ == "house":
            precision, conf = "interpolated", 0.7
        else:
            precision, conf = "exact", 0.9
    elif hn and wanted_number:
        precision, conf = "street", 0.4  # número diferente do pedido
    elif cat == "highway" or addresstype in ("road", "street"):
        precision, conf = "street", 0.5
    elif addresstype in ("suburb", "neighbourhood", "quarter", "city_district") or cat == "place":
        precision, conf = "neighborhood", 0.2
    elif hn:
        precision, conf = "exact", 0.8
    else:
        precision, conf = "street", 0.3
    return Candidate(
        lat=float(item["lat"]), lon=float(item["lon"]), label=item.get("display_name", ""),
        precision=precision, confidence=conf, road=road, house_number=hn, city=city,
        neighborhood=nb, postcode=addr.get("postcode"),
        provider_ref=f"{item.get('osm_type')}/{item.get('osm_id')}", raw_type=f"{cat}/{typ}",
    )


class NominatimProvider(Provider):
    name = "nominatim"

    def __init__(self, settings: Settings, session: requests.Session | None = None):
        self.s = settings
        self.http = session or requests.Session()
        self._lock = threading.Lock()
        self._last = 0.0

    def _throttle(self):
        with self._lock:
            wait = self.s.geocoder_min_interval_s - (time.monotonic() - self._last)
            if wait > 0:
                time.sleep(wait)
            self._last = time.monotonic()

    def search(self, query: dict) -> list[Candidate]:
        params = {**query, "format": "jsonv2", "addressdetails": 1, "limit": 5,
                  "countrycodes": "br", "accept-language": "pt-BR"}
        if self.s.nominatim_email:
            params["email"] = self.s.nominatim_email
        headers = {"User-Agent": "roteirizacao-santos/1.0"}
        delay = 1.0
        last: Exception | None = None
        for attempt in range(self.s.geocoder_max_retries + 1):
            self._throttle()
            try:
                r = self.http.get(f"{self.s.nominatim_url.rstrip('/')}/search", params=params,
                                  headers=headers, timeout=20)
                if r.status_code == 429 or r.status_code >= 500:
                    raise ProviderError(f"HTTP {r.status_code}")
                r.raise_for_status()
                return [classify_nominatim(it, _wanted_number(query)) for it in r.json()]
            except (requests.RequestException, ProviderError, ValueError) as exc:
                last = exc
                if attempt < self.s.geocoder_max_retries:
                    time.sleep(delay)
                    delay *= 2
        raise ProviderError(f"Nominatim indisponível: {last}")


def _wanted_number(query: dict) -> str | None:
    street = query.get("street", "")
    first = street.split(" ", 1)[0]
    return first if first[:1].isdigit() else None


@dataclass
class MockProvider(Provider):
    """Coordenadas sintéticas (TESTES). Ruas viram eixos dentro de Santos."""

    name: str = "mock"
    bbox: tuple[float, float, float, float] = (-23.975, -46.345, -23.950, -46.310)
    not_found_words: tuple[str, ...] = ("INEXISTENTE",)
    ambiguous_words: tuple[str, ...] = ("AMBIGUA",)
    calls: list[dict] = field(default_factory=list)

    def search(self, query: dict) -> list[Candidate]:
        self.calls.append(query)
        street = norm_token_text(query.get("street", ""))
        if any(w in street for w in self.not_found_words):
            return []
        parts = street.split(" ", 1)
        number = parts[0] if parts[0][:1].isdigit() else None
        name = parts[1] if number and len(parts) > 1 else street
        h = int(hashlib.sha1(name.encode()).hexdigest(), 16)
        s, w, n, e = self.bbox
        horizontal = h % 2 == 0
        base = (h >> 8) % 1000 / 1000
        pos = min(int("".join(c for c in (number or "0") if c.isdigit()) or 0), 2000) / 2000
        if horizontal:
            lat, lon = s + base * (n - s), w + pos * (e - w)
        else:
            lat, lon = s + pos * (n - s), w + base * (e - w)
        cand = Candidate(lat, lon, f"{query.get('street')} (sintético)",
                         "exact" if number else "street", 0.9 if number else 0.5,
                         road=name, house_number=number, city=query.get("city"))
        if any(w in street for w in self.ambiguous_words):
            other = Candidate(lat + 0.01, lon + 0.01, "candidato alternativo (sintético)",
                              "exact", 0.85, road=name + " II", house_number=number,
                              city=query.get("city"))
            return [cand, other]
        return [cand]


def build_provider(settings: Settings) -> Provider:
    if settings.geocoder == "mock":
        return MockProvider()
    return NominatimProvider(settings)
