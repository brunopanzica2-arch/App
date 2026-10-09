"""Malha de circulação de pedestres construída a partir do OSM.

Regras (seção 10):
- perfil a pé: ruas, calçadas, praças, travessas, passagens e caminhos;
- sentido único de automóveis NÃO restringe (só fica sinalizado como contramão);
- só restrições reais de pedestre (oneway:foot, foot:forward/backward=no) limitam
  o sentido;
- acessos fechados (access=no, foot=no, barreiras intransponíveis) ficam fora;
- escadas, acessos privados e barreiras ficam SINALIZADOS e recebem a política
  configurada pelo usuário (permitir / penalizar / proibir);
- nenhuma conexão é inventada: arestas existem apenas entre nós consecutivos de
  uma via OSM, ou dentro de áreas de pedestres (praças) entre dois acessos reais
  da área, quando o segmento fica inteiramente dentro do polígono.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field

from .osm_data import OsmData

# --------------------------------------------------------------- constantes

F_STEPS = 1        # escada: bicicleta carregada
F_PRIVATE = 2      # acesso privado
F_AREA = 4         # travessia de praça/área de pedestres
F_SIDEWALK = 8     # calçada/área de pedestre sem permissão explícita p/ bicicleta
F_DISMOUNT = 16    # bicicleta proibida/desmontar (bicycle=no|dismount)

N_BARRIER = 1      # barreira que exige levantar/conduzir a bicicleta
N_PRIVATE = 2      # portão/acesso privado

FLAG_NAMES = {
    F_STEPS: "escada",
    F_PRIVATE: "acesso_privado",
    F_AREA: "travessia_de_praca",
    F_SIDEWALK: "calcada",
    F_DISMOUNT: "proibido_pedalar",
}

ROADS = {
    "trunk", "trunk_link", "primary", "primary_link", "secondary", "secondary_link",
    "tertiary", "tertiary_link", "unclassified", "residential", "living_street",
    "service", "road", "track",
}
PEDESTRIAN = {"footway", "pedestrian", "crossing"}
PATHS = {"path", "cycleway", "bridleway"}
FOOT_ONLY_IF_ALLOWED = {"motorway", "motorway_link", "corridor", "busway"}

YES = {"yes", "designated", "permissive", "official"}
CLOSED = {"no"}
PRIVATE = {"private"}

BARRIER_PASSABLE = {
    "bollard", "block", "lift_gate", "chain", "height_restrictor", "border_control",
    "toll_booth", "entrance", "kerb", "rope", "sump_buster", "bump_gate", "log",
    "jersey_barrier", "planter", "gate", "swing_gate", "sliding_gate", "hampshire_gate",
    "wicket_gate", "spikes", "bar",
}
BARRIER_DISMOUNT = {
    "cycle_barrier", "stile", "kissing_gate", "turnstile", "motorcycle_barrier",
    "horse_stile", "step", "steps",
}
BARRIER_BLOCKING = {
    "full-height_turnstile", "wall", "fence", "hedge", "ditch", "retaining_wall",
    "city_wall", "guard_rail", "handrail", "debris", "yes_wall", "cable_barrier",
}


@dataclass
class WayInfo:
    fwd: bool = True
    bwd: bool = True
    flags: int = 0
    car_oneway: int = 0          # 1 = mão única no sentido da via, -1 = contrário
    area: bool = False


def classify_way(tags: dict[str, str]) -> WayInfo | None:
    """Decide se a via pertence à malha de pedestres e como é tratada."""
    hw = tags.get("highway", "")
    foot = tags.get("foot", "")
    bicycle = tags.get("bicycle", "")
    access = tags.get("access", "")

    if hw == "steps":
        pass
    elif hw in ROADS or hw in PEDESTRIAN or hw in PATHS:
        pass
    elif hw in FOOT_ONLY_IF_ALLOWED:
        if foot not in YES:
            return None
    else:
        return None  # construction, proposed, platform, elevator, ...

    if tags.get("area") == "yes" and hw not in ("pedestrian", "footway", "path"):
        return None  # áreas de estacionamento/serviço não são caminhos
    if tags.get("indoor") == "yes" or tags.get("disused") == "yes":
        return None

    # foot=no fecha para pedestre; ainda pode servir à bicicleta se permitida.
    if foot in CLOSED and bicycle not in YES:
        return None
    if access in CLOSED and foot not in YES and bicycle not in YES:
        return None

    info = WayInfo()
    if (access in PRIVATE and foot not in YES) or foot in PRIVATE:
        info.flags |= F_PRIVATE

    # Classificação pedalável x conduzir a pé.
    if hw == "steps":
        info.flags |= F_STEPS
    elif bicycle in ("no", "dismount", "use_sidepath"):
        info.flags |= F_DISMOUNT
    elif bicycle in YES or bicycle == "destination":
        pass
    elif hw in PEDESTRIAN:
        info.flags |= F_SIDEWALK

    # Sentido: apenas restrições de PEDESTRE.
    of = tags.get("oneway:foot", "")
    if of in ("yes", "1", "true"):
        info.bwd = False
    elif of == "-1":
        info.fwd = False
    if tags.get("foot:forward") == "no":
        info.fwd = False
    if tags.get("foot:backward") == "no":
        info.bwd = False
    if not info.fwd and not info.bwd:
        return None

    # Mão única de veículos: só informativo (contramão).
    if hw not in PEDESTRIAN and hw != "steps":
        ow = tags.get("oneway", "")
        if tags.get("junction") in ("roundabout", "circular") and ow == "":
            ow = "yes"
        if tags.get("oneway:bicycle") == "no" or tags.get("cycleway") == "opposite":
            ow = ""
        if ow in ("yes", "1", "true"):
            info.car_oneway = 1
        elif ow == "-1":
            info.car_oneway = -1

    if tags.get("area") == "yes":
        info.area = True
    return info


def classify_barrier(tags: dict[str, str]) -> str | None:
    """None (livre), 'block' (intransponível/fechado), 'private' ou 'barrier'."""
    barrier = tags.get("barrier")
    access = tags.get("access", "")
    foot = tags.get("foot", "")
    bicycle = tags.get("bicycle", "")
    if not barrier:
        if access in CLOSED and foot not in YES:
            return "block"
        return None
    if foot in CLOSED or (access in CLOSED and foot not in YES):
        return "block"
    if tags.get("locked") == "yes" and foot not in YES:
        return "block"
    if barrier in BARRIER_BLOCKING:
        return "block"
    if (access in PRIVATE and foot not in YES) or foot in PRIVATE:
        return "private"
    if barrier in BARRIER_DISMOUNT and bicycle not in YES:
        return "barrier"
    if bicycle in ("no", "dismount"):
        return "barrier"
    return None


# --------------------------------------------------------------- geometria

EARTH_R = 6_371_008.8


def haversine(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp, dl = p2 - p1, math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * EARTH_R * math.asin(math.sqrt(a))


def _seg_intersect(p1, p2, q1, q2) -> bool:
    """Interseção própria (cruzamento) entre os segmentos p1p2 e q1q2."""
    def orient(a, b, c):
        v = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])
        return 0 if abs(v) < 1e-18 else (1 if v > 0 else -1)

    o1, o2 = orient(p1, p2, q1), orient(p1, p2, q2)
    o3, o4 = orient(q1, q2, p1), orient(q1, q2, p2)
    return o1 * o2 < 0 and o3 * o4 < 0


def _point_in_poly(pt, poly) -> bool:
    x, y = pt
    inside = False
    n = len(poly)
    for i in range(n):
        x1, y1 = poly[i]
        x2, y2 = poly[(i + 1) % n]
        if (y1 > y) != (y2 > y):
            xin = x1 + (y - y1) * (x2 - x1) / (y2 - y1)
            if xin > x:
                inside = not inside
    return inside


# --------------------------------------------------------------- malha


@dataclass
class Network:
    """Grafo não direcionado com permissões de sentido por aresta."""

    lat: list[float] = field(default_factory=list)
    lon: list[float] = field(default_factory=list)
    osm_id: list[int] = field(default_factory=list)
    node_flags: list[int] = field(default_factory=list)
    node_blocked: list[bool] = field(default_factory=list)

    ea: list[int] = field(default_factory=list)
    eb: list[int] = field(default_factory=list)
    elen: list[float] = field(default_factory=list)
    eflags: list[int] = field(default_factory=list)
    efwd: list[bool] = field(default_factory=list)
    ebwd: list[bool] = field(default_factory=list)
    # contramão (veículos) em cada sentido
    ecf_fwd: list[bool] = field(default_factory=list)
    ecf_bwd: list[bool] = field(default_factory=list)
    # fração do comprimento da via (para distribuir penalidade por via)
    eshare: list[float] = field(default_factory=list)
    ename: list[str] = field(default_factory=list)
    eway: list[int] = field(default_factory=list)

    _index: dict[int, int] = field(default_factory=dict, repr=False)

    @property
    def n_nodes(self) -> int:
        return len(self.lat)

    @property
    def n_edges(self) -> int:
        return len(self.ea)

    def _node(self, osm: OsmData, nid: int) -> int:
        idx = self._index.get(nid)
        if idx is None:
            idx = len(self.lat)
            self._index[nid] = idx
            lat, lon = osm.nodes[nid]
            self.lat.append(lat)
            self.lon.append(lon)
            self.osm_id.append(nid)
            kind = classify_barrier(osm.node_tags.get(nid, {}))
            self.node_blocked.append(kind == "block")
            self.node_flags.append(
                N_BARRIER if kind == "barrier" else N_PRIVATE if kind == "private" else 0
            )
        return idx

    def add_edge(self, a, b, length, flags, fwd, bwd, cf_fwd, cf_bwd, share, name, way):
        self.ea.append(a)
        self.eb.append(b)
        self.elen.append(length)
        self.eflags.append(flags)
        self.efwd.append(fwd)
        self.ebwd.append(bwd)
        self.ecf_fwd.append(cf_fwd)
        self.ecf_bwd.append(cf_bwd)
        self.eshare.append(share)
        self.ename.append(name)
        self.eway.append(way)


def build_network(osm: OsmData, cross_areas: bool = True) -> Network:
    net = Network()
    usable: list[tuple[int, list[int], dict, WayInfo]] = []
    membership: dict[int, int] = {}
    for wid, (refs, tags) in osm.ways.items():
        info = classify_way(tags)
        if info is None:
            continue
        refs = [r for r in refs if r in osm.nodes]
        if len(refs) < 2:
            continue
        usable.append((wid, refs, tags, info))
        for r in set(refs):
            membership[r] = membership.get(r, 0) + 1

    for wid, refs, tags, info in usable:
        coords = [osm.nodes[r] for r in refs]
        seg_lens = [
            haversine(*coords[i], *coords[i + 1]) for i in range(len(coords) - 1)
        ]
        total = sum(seg_lens) or 1.0
        name = tags.get("name") or tags.get("ref") or ""
        cf_fwd = info.car_oneway == -1
        cf_bwd = info.car_oneway == 1
        for i, length in enumerate(seg_lens):
            if length < 0.01:
                continue
            a = net._node(osm, refs[i])
            b = net._node(osm, refs[i + 1])
            net.add_edge(
                a, b, length, info.flags, info.fwd, info.bwd, cf_fwd, cf_bwd,
                length / total, name, wid,
            )
        if cross_areas and info.area and refs[0] == refs[-1]:
            _add_area_crossings(net, osm, wid, refs, tags, info, membership)
    return net


def _add_area_crossings(net, osm, wid, refs, tags, info, membership,
                        max_entries: int = 60, max_len: float = 300.0) -> None:
    """Liga, em linha reta, acessos reais de uma praça/área de pedestres.

    Só cria o segmento se ele não cruzar a borda do polígono e o ponto médio
    estiver dentro da área — ou seja, apenas caminhos que existem fisicamente
    dentro da área aberta.
    """
    ring = refs[:-1]
    if len(ring) < 3:
        return
    lat0 = sum(osm.nodes[r][0] for r in ring) / len(ring)
    kx = math.cos(math.radians(lat0))
    poly = [(osm.nodes[r][1] * kx, osm.nodes[r][0]) for r in ring]
    entries = [i for i, r in enumerate(ring) if membership.get(r, 0) > 1]
    if len(entries) < 2 or len(entries) > max_entries:
        return
    name = tags.get("name") or ""
    n = len(ring)
    for ai in range(len(entries)):
        for bi in range(ai + 1, len(entries)):
            i, j = entries[ai], entries[bi]
            if abs(i - j) == 1 or abs(i - j) == n - 1:
                continue  # já ligados pela borda
            p, q = poly[i], poly[j]
            mid = ((p[0] + q[0]) / 2, (p[1] + q[1]) / 2)
            if not _point_in_poly(mid, poly):
                continue
            crosses = False
            for k in range(n):
                k2 = (k + 1) % n
                if k in (i, j) or k2 in (i, j):
                    continue
                if _seg_intersect(p, q, poly[k], poly[k2]):
                    crosses = True
                    break
            if crosses:
                continue
            la, lo = osm.nodes[ring[i]]
            lb, lob = osm.nodes[ring[j]]
            length = haversine(la, lo, lb, lob)
            if length > max_len or length < 0.01:
                continue
            net.add_edge(
                net._node(osm, ring[i]), net._node(osm, ring[j]), length,
                info.flags | F_AREA, True, True, False, False, 1.0, name, wid,
            )
