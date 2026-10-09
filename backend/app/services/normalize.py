"""Normalização de endereços brasileiros (sem apagar o texto original).

A chave de deduplicação (`address_key`) só iguala endereços cujo tipo de
logradouro, nome normalizado, número e município coincidem exatamente:
ruas com nomes parecidos NÃO são consideradas iguais.
"""

from __future__ import annotations

import re
import unicodedata
from dataclasses import dataclass, field

STREET_TYPES = {
    "R": "RUA", "RUA": "RUA", "AV": "AVENIDA", "AVE": "AVENIDA", "AVN": "AVENIDA",
    "AVENIDA": "AVENIDA", "PC": "PRACA", "PCA": "PRACA", "PRACA": "PRACA",
    "TV": "TRAVESSA", "TRV": "TRAVESSA", "TRAV": "TRAVESSA", "TRAVESSA": "TRAVESSA",
    "AL": "ALAMEDA", "ALAMEDA": "ALAMEDA", "EST": "ESTRADA", "ESTR": "ESTRADA",
    "ESTRADA": "ESTRADA", "ROD": "RODOVIA", "RODOVIA": "RODOVIA", "LG": "LARGO",
    "LGO": "LARGO", "LARGO": "LARGO", "VD": "VIADUTO", "VIADUTO": "VIADUTO",
    "PQ": "PARQUE", "PRQ": "PARQUE", "PARQUE": "PARQUE", "VL": "VILA", "VILA": "VILA",
    "PASSAGEM": "PASSAGEM", "PSG": "PASSAGEM", "BC": "BECO", "BECO": "BECO",
    "LADEIRA": "LADEIRA", "LD": "LADEIRA", "CJ": "CONJUNTO", "CONJUNTO": "CONJUNTO",
    "PRAIA": "PRAIA", "PCT": "PRACETA", "PRACETA": "PRACETA", "VIELA": "VIELA",
    "VLA": "VIELA", "CAMINHO": "CAMINHO", "SERVIDAO": "SERVIDAO",
}
TITLES = {
    "DR": "DOUTOR", "DRA": "DOUTORA", "PROF": "PROFESSOR", "PROFA": "PROFESSORA",
    "CEL": "CORONEL", "GAL": "GENERAL", "GEN": "GENERAL", "MAL": "MARECHAL",
    "ENG": "ENGENHEIRO", "PRES": "PRESIDENTE", "STA": "SANTA", "STO": "SANTO",
    "CONS": "CONSELHEIRO", "CONSELH": "CONSELHEIRO", "VISC": "VISCONDE",
    "BRIG": "BRIGADEIRO", "DES": "DESEMBARGADOR", "MIN": "MINISTRO", "SEN": "SENADOR",
    "DEP": "DEPUTADO", "ALM": "ALMIRANTE", "CAP": "CAPITAO", "TEN": "TENENTE",
    "CMTE": "COMANDANTE", "COM": "COMENDADOR", "MONS": "MONSENHOR", "PE": "PADRE",
    "SGTO": "SARGENTO", "BAR": "BARAO", "VER": "VEREADOR", "GOV": "GOVERNADOR",
    "N": "NOSSA", "NSA": "NOSSA", "SRA": "SENHORA", "SR": "SENHOR",
}
CEP_RE = re.compile(r"\b(\d{5})-?(\d{3})\b")
NUMBER_RE = re.compile(r"^\s*(\d{1,6})\s*([A-Za-z]?)\b")
SN_RE = re.compile(r"^\s*(S\s*/?\s*N|SN|SEM\s+N[UÚ]MERO)\s*$", re.I)


def strip_accents(s: str) -> str:
    return "".join(c for c in unicodedata.normalize("NFKD", s) if not unicodedata.combining(c))


def clean_spaces(s: str | None) -> str:
    return re.sub(r"\s+", " ", (s or "").replace(" ", " ")).strip()


def norm_token_text(s: str | None) -> str:
    """Maiúsculas, sem acentos, sem pontuação, espaços simples."""
    s = strip_accents(clean_spaces(s)).upper()
    s = re.sub(r"[^\w\s/-]", " ", s)
    return clean_spaces(s)


def normalize_cep(raw: str | None) -> tuple[str | None, str | None]:
    if not raw or not clean_spaces(raw):
        return None, None
    digits = re.sub(r"\D", "", raw)
    if len(digits) != 8:
        return None, f"CEP inválido: {raw!r}"
    return f"{digits[:5]}-{digits[5:]}", None


def normalize_number(raw: str | None) -> tuple[str | None, str | None]:
    if raw is None or not clean_spaces(str(raw)):
        return None, "Número ausente"
    raw = clean_spaces(str(raw))
    if raw.endswith(".0") and raw[:-2].isdigit():  # planilhas: 480.0
        raw = raw[:-2]
    if SN_RE.match(raw):
        return None, "Sem número (S/N)"
    m = NUMBER_RE.match(raw)
    if not m:
        return None, f"Número não reconhecido: {raw!r}"
    return (m.group(1).lstrip("0") or "0") + m.group(2).upper(), None


def split_street(raw: str | None) -> tuple[str | None, str]:
    """Separa tipo de logradouro e nome normalizado (sem acentos, títulos expandidos)."""
    tokens = norm_token_text(raw).replace("/", " ").split()
    if not tokens:
        return None, ""
    stype = None
    first = tokens[0].rstrip(".")
    if first in STREET_TYPES and len(tokens) > 1:
        stype = STREET_TYPES[first]
        tokens = tokens[1:]
    out = []
    for i, t in enumerate(tokens):
        # títulos só são expandidos quando não são a última palavra do nome
        out.append(TITLES.get(t, t) if i < len(tokens) - 1 else t)
    return stype, " ".join(out)


def pretty(s: str) -> str:
    small = {"DE", "DA", "DO", "DAS", "DOS", "E"}
    return " ".join(w.lower() if w in small and i else w.capitalize() for i, w in enumerate(s.split()))


@dataclass
class NormalizedAddress:
    street_type: str | None
    street_name: str            # normalizado (chave)
    number: str | None
    neighborhood: str | None
    city: str
    state: str
    cep: str | None
    original_text: str
    issues: list[str] = field(default_factory=list)
    errors: list[str] = field(default_factory=list)

    @property
    def key(self) -> str:
        return "|".join([
            self.street_type or "", self.street_name, self.number or "S/N",
            norm_token_text(self.city), self.state,
        ])

    @property
    def display(self) -> str:
        street = " ".join(x for x in [pretty(self.street_type or ""), pretty(self.street_name)] if x)
        parts = [street + (f", {self.number}" if self.number else ", S/N")]
        if self.neighborhood:
            parts.append(pretty(norm_token_text(self.neighborhood)))
        parts.append(f"{pretty(norm_token_text(self.city))}/{self.state}")
        if self.cep:
            parts.append(self.cep)
        return " - ".join(parts)

    def geocode_query(self) -> dict:
        """Consulta estruturada SEM dados do destinatário e SEM complemento."""
        street = " ".join(x for x in [pretty(self.street_type or ""), pretty(self.street_name)] if x)
        q = {"street": f"{self.number} {street}" if self.number else street,
             "city": pretty(norm_token_text(self.city)), "state": self.state,
             "country": "Brasil"}
        if self.cep:
            q["postalcode"] = self.cep
        return q


def normalize_address(street: str | None, number: str | None, neighborhood: str | None = None,
                      city: str | None = None, cep: str | None = None,
                      default_city: str = "Santos", default_state: str = "SP") -> NormalizedAddress:
    original = " | ".join(clean_spaces(str(x)) for x in [street, number, neighborhood, city, cep] if x)
    errors: list[str] = []
    issues: list[str] = []
    stype, sname = split_street(street)
    if not sname:
        errors.append("Logradouro ausente")
    num, num_issue = normalize_number(number)
    if num_issue:
        issues.append(num_issue)
    cep_n, cep_issue = normalize_cep(cep)
    if cep_issue:
        issues.append(cep_issue)
    city_raw = clean_spaces(city) or default_city
    state = default_state
    m = re.match(r"^(.*?)\s*[/-]\s*([A-Za-z]{2})$", city_raw)
    if m:
        city_raw, state = m.group(1), m.group(2).upper()
    if norm_token_text(city_raw) != norm_token_text(default_city):
        issues.append(f"Município diferente do padrão: {city_raw}")
    return NormalizedAddress(
        street_type=stype, street_name=sname, number=num,
        neighborhood=clean_spaces(neighborhood) or None, city=city_raw, state=state,
        cep=cep_n, original_text=original, issues=issues, errors=errors,
    )


ADDRESS_LINE_RE = re.compile(
    r"^(?P<street>[^,]+?)\s*,\s*(?P<number>(?:\d+\s*[A-Za-z]?|S\s*/?\s*N))\b\s*(?P<rest>.*)$", re.I
)


def parse_address_line(line: str) -> dict:
    """Divide um endereço em texto livre: 'Rua X, 480, ap 12 - Bairro, Santos/SP, 11075-301'."""
    line = clean_spaces(line)
    out: dict = {"street": None, "number": None, "complement": None,
                 "neighborhood": None, "city": None, "cep": None}
    m = CEP_RE.search(line)
    if m:
        out["cep"] = m.group(0)
        line = clean_spaces(line[: m.start()] + line[m.end():]).strip(" ,-")
    m = ADDRESS_LINE_RE.match(line)
    if not m:
        out["street"] = line or None
        return out
    out["street"], out["number"] = m.group("street"), m.group("number")
    rest = [clean_spaces(p) for p in re.split(r"\s*[,;]\s*|\s+-\s+", m.group("rest")) if clean_spaces(p)]
    city_idx = None
    for i, p in enumerate(rest):
        if re.search(r"/\s*[A-Za-z]{2}$", p) or norm_token_text(p) == "SANTOS":
            city_idx = i
    if city_idx is not None:
        out["city"] = rest[city_idx]
        rest = rest[:city_idx] + rest[city_idx + 1:]
    comp_words = re.compile(r"^(AP|APTO|APT|APARTAMENTO|BL|BLOCO|CASA|FUNDOS|SALA|CJ|LOJA|ANDAR|TORRE)\b", re.I)
    comps = [p for p in rest if comp_words.match(strip_accents(p))]
    others = [p for p in rest if p not in comps]
    out["complement"] = ", ".join(comps) or None
    out["neighborhood"] = others[-1] if others else None
    if len(others) > 1:
        out["complement"] = ", ".join(filter(None, [out["complement"], *others[:-1]]))
    return out
