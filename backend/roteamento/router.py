"""Cálculo de caminhos e matrizes de deslocamento sobre a malha de pedestres."""

from __future__ import annotations

import math
from dataclasses import dataclass, field

import numpy as np
from scipy.sparse import csr_matrix
from scipy.sparse.csgraph import breadth_first_order, connected_components, dijkstra

from .config import TravelProfile
from .network import (
    F_AREA, F_DISMOUNT, F_PRIVATE, F_SIDEWALK, F_STEPS, FLAG_NAMES,
    N_BARRIER, N_PRIVATE, Network,
)

M_PER_DEG = 111_320.0
# Desempate dentro do Dijkstra: entre caminhos de mesmo tempo, o mais curto.
DIST_TIEBREAK = 1e-5


def edge_mode(flags: int, profile: TravelProfile) -> str:
    """'ride' (pedalável), 'walk' (conduzir a pé) ou 'steps' (carregar)."""
    if flags & F_STEPS:
        return "steps"
    if flags & F_DISMOUNT:
        return "walk"
    if flags & F_SIDEWALK:
        return profile.sidewalk_mode
    return "ride"


@dataclass
class Snap:
    lat: float
    lon: float
    edge: int
    t: float            # posição ao longo da aresta (0 = ea, 1 = eb)
    snap_lat: float
    snap_lon: float
    distance_m: float
    node: int = -1      # nó do grafo da consulta (preenchido em RouteSolver)
    # evidências do snapping (auditoria V2 — alerta C)
    flags: list[str] = field(default_factory=list)
    nearest_any_m: float | None = None   # via mais próxima, conectada ou não à origem
    confidence: str = "alta"             # alta (<=15 m) | boa (<=30) | media (<=60) | baixa

SNAP_LEVELS = ((15.0, "alta"), (30.0, "boa"), (60.0, "media"))


def snap_confidence(d: float) -> str:
    for lim, name in SNAP_LEVELS:
        if d <= lim:
            return name
    return "baixa"


class SnapError(ValueError):
    pass


def _seg_cross(p1, p2, q1, q2) -> bool:
    def o(a, b, c):
        v = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])
        return 0 if abs(v) < 1e-9 else (1 if v > 0 else -1)

    return o(p1, p2, q1) * o(p1, p2, q2) < 0 and o(q1, q2, p1) * o(q1, q2, p2) < 0


class Router:
    """Aplica o perfil de deslocamento à malha e responde consultas."""

    def __init__(self, net: Network, profile: TravelProfile):
        profile.validate()
        self.net = net
        self.profile = profile
        n, m = net.n_nodes, net.n_edges
        self.lat0 = (sum(net.lat) / n) if n else 0.0
        self.kx = math.cos(math.radians(self.lat0))
        self.x = np.array(net.lon) * self.kx * M_PER_DEG
        self.y = np.array(net.lat) * M_PER_DEG

        # ---- nós
        node_ok = np.ones(n, dtype=bool)
        node_pen = np.zeros(n)
        for i in range(n):
            if net.node_blocked[i]:
                node_ok[i] = False
                continue
            f = net.node_flags[i]
            for flag, policy, pen in (
                (N_BARRIER, profile.barrier_policy, profile.barrier_penalty_s),
                (N_PRIVATE, profile.private_policy, profile.private_penalty_s),
            ):
                if f & flag:
                    if policy == "forbid":
                        node_ok[i] = False
                    elif policy == "penalize":
                        node_pen[i] += pen
        self.node_ok = node_ok
        self.node_pen = node_pen

        # ---- arestas
        ride, walk = profile.ride_mps(), profile.walk_mps()
        steps_speed = walk * profile.steps_speed_factor
        speed = {"ride": ride, "walk": walk, "steps": steps_speed}
        self.edge_ok = np.zeros(m, dtype=bool)
        self.edge_mode: list[str] = [""] * m
        self.edge_time = np.zeros(m)     # sem penalidades nem contramão
        self.edge_pen = np.zeros(m)      # penalidade (s) da aresta inteira
        for e in range(m):
            f = net.eflags[e]
            ok = node_ok[net.ea[e]] and node_ok[net.eb[e]]
            pen = 0.0
            if f & F_STEPS:
                if profile.steps_policy == "forbid":
                    ok = False
                elif profile.steps_policy == "penalize":
                    pen += profile.steps_penalty_s * net.eshare[e]
            if f & F_PRIVATE:
                if profile.private_policy == "forbid":
                    ok = False
                elif profile.private_policy == "penalize":
                    pen += profile.private_penalty_s * net.eshare[e]
            mode = edge_mode(f, profile)
            self.edge_ok[e] = ok
            self.edge_mode[e] = mode
            self.edge_time[e] = net.elen[e] / speed[mode]
            self.edge_pen[e] = pen
        cf = profile.contraflow_factor
        self.elen = np.array(net.elen)
        self.w_fwd = self.edge_time * np.where(net.ecf_fwd, cf, 1.0) + self.edge_pen
        self.w_bwd = self.edge_time * np.where(net.ecf_bwd, cf, 1.0) + self.edge_pen

        # ---- conectividade (diagnóstico). A malha operacional NÃO é mais "a maior
        # componente": ela é eleita a partir da ORIGEM (ver reach_from / snap_origin).
        src, dst, _, _ = self._base_arcs()
        self._g = csr_matrix((np.ones(len(src)), (src, dst)), shape=(n, n)) if len(src) else csr_matrix((n, n))
        self._gT = self._g.T.tocsr()
        if len(src):
            _, labels = connected_components(self._g, directed=True, connection="strong")
            self.comp = labels
            self.comp_size = np.bincount(labels)
        else:
            self.comp = np.zeros(n, dtype=int)
            self.comp_size = np.array([n])
        self._build_index()

    # ------------------------------------------------------------ arcos

    def _base_arcs(self):
        net = self.net
        src, dst, eid, fwd = [], [], [], []
        for e in np.nonzero(self.edge_ok)[0]:
            a, b = net.ea[e], net.eb[e]
            if net.efwd[e]:
                src.append(a); dst.append(b); eid.append(e); fwd.append(True)
            if net.ebwd[e]:
                src.append(b); dst.append(a); eid.append(e); fwd.append(False)
        return (np.array(src, dtype=np.int64), np.array(dst, dtype=np.int64),
                np.array(eid, dtype=np.int64), np.array(fwd, dtype=bool))

    # ------------------------------------------------------------ snapping

    CELL = 100.0

    def _build_index(self) -> None:
        self.grid: dict[tuple[int, int], list[int]] = {}
        net = self.net
        for e in np.nonzero(self.edge_ok)[0]:
            a, b = net.ea[e], net.eb[e]
            x0, x1 = sorted((self.x[a], self.x[b]))
            y0, y1 = sorted((self.y[a], self.y[b]))
            for cx in range(int(x0 // self.CELL), int(x1 // self.CELL) + 1):
                for cy in range(int(y0 // self.CELL), int(y1 // self.CELL) + 1):
                    self.grid.setdefault((cx, cy), []).append(int(e))

    # ------------------------------------------------------------ alcance

    def reach_from(self, nodes) -> np.ndarray:
        """Máscara dos nós alcançáveis a partir de `nodes` respeitando sentidos de pedestre."""
        mask = np.zeros(self.net.n_nodes, dtype=bool)
        for v in nodes:
            if not mask[v]:
                mask[breadth_first_order(self._g, int(v), directed=True, return_predecessors=False)] = True
        return mask

    def reach_to(self, nodes) -> np.ndarray:
        """Máscara dos nós que alcançam `nodes`."""
        mask = np.zeros(self.net.n_nodes, dtype=bool)
        for v in nodes:
            if not mask[v]:
                mask[breadth_first_order(self._gT, int(v), directed=True, return_predecessors=False)] = True
        return mask

    def exit_nodes(self, e: int) -> list[int]:
        """Nós para onde se pode seguir a partir de um ponto no meio da aresta e."""
        net = self.net
        return ([net.eb[e]] if net.efwd[e] else []) + ([net.ea[e]] if net.ebwd[e] else [])

    def edge_reachable(self, e: int, reach: np.ndarray) -> bool:
        """Um ponto no meio da aresta e é alcançável se entramos por uma ponta permitida."""
        net = self.net
        return bool((net.efwd[e] and reach[net.ea[e]]) or (net.ebwd[e] and reach[net.eb[e]]))

    # ------------------------------------------------------------ snapping

    def _candidates(self, px: float, py: float, max_dist: float) -> list[tuple[float, int, float]]:
        cx, cy = int(px // self.CELL), int(py // self.CELL)
        rings = int(max_dist // self.CELL) + 1
        out: list[tuple[float, int, float]] = []
        seen: set[int] = set()
        for i in range(cx - rings, cx + rings + 1):
            for j in range(cy - rings, cy + rings + 1):
                for e in self.grid.get((i, j), ()):
                    if e in seen:
                        continue
                    seen.add(e)
                    d, t = self._project(e, px, py)
                    if d <= max_dist:
                        out.append((d, e, t))
        out.sort()
        return out

    def _crosses_other_edge(self, e: int, px: float, py: float, qx: float, qy: float) -> bool:
        """O acesso em linha reta ponto->via atravessa outra via (lado oposto, canal, quadra)?"""
        net = self.net
        x0, x1 = sorted((px, qx))
        y0, y1 = sorted((py, qy))
        ends = {net.ea[e], net.eb[e]}
        seen: set[int] = set()
        for i in range(int(x0 // self.CELL), int(x1 // self.CELL) + 1):
            for j in range(int(y0 // self.CELL), int(y1 // self.CELL) + 1):
                for f in self.grid.get((i, j), ()):
                    if f == e or f in seen:
                        continue
                    seen.add(f)
                    a, b = net.ea[f], net.eb[f]
                    if a in ends or b in ends:
                        continue
                    if _seg_cross((px, py), (qx, qy), (self.x[a], self.y[a]), (self.x[b], self.y[b])):
                        return True
        return False

    def _make_snap(self, lat, lon, d, e, t, px, py, nearest_any) -> Snap:
        a, b = self.net.ea[e], self.net.eb[e]
        sl = self.net.lat[a] + t * (self.net.lat[b] - self.net.lat[a])
        so = self.net.lon[a] + t * (self.net.lon[b] - self.net.lon[a])
        qx, qy = self.x[a] + t * (self.x[b] - self.x[a]), self.y[a] + t * (self.y[b] - self.y[a])
        flags = []
        if d > 1.0 and self._crosses_other_edge(e, px, py, qx, qy):
            flags.append("acesso_cruza_outra_via")
        if nearest_any is not None and nearest_any + 10.0 < d:
            flags.append("via_mais_proxima_desconectada")
        conf = snap_confidence(d)
        if flags and conf in ("alta", "boa"):
            conf = "media"
        return Snap(lat, lon, e, t, sl, so, d, flags=flags, nearest_any_m=nearest_any, confidence=conf)

    def snap(self, lat: float, lon: float, max_dist: float, reach: np.ndarray | None = None) -> Snap:
        """Projeta o ponto no trecho real mais próximo (sem criar ligações novas).

        Com `reach` (nós alcançáveis a partir da origem), só aceita trechos onde o ponto é
        alcançável; se a via mais próxima não for, isso fica registrado em `flags`.
        """
        px, py = lon * self.kx * M_PER_DEG, lat * M_PER_DEG
        cands = self._candidates(px, py, max_dist)
        if not cands:
            raise SnapError(f"Ponto ({lat:.6f}, {lon:.6f}) está a mais de {max_dist:.0f} m "
                            "da malha de circulação acessível.")
        nearest_any = cands[0][0]
        for d, e, t in cands:
            if reach is None or self.edge_reachable(e, reach):
                return self._make_snap(lat, lon, d, e, t, px, py, nearest_any)
        raise SnapError(f"Há vias a {nearest_any:.0f} m, mas nenhuma conectada à origem por caminho "
                        "de pedestre num raio de {:.0f} m.".format(max_dist))

    def snap_origin(self, lat: float, lon: float, max_dist: float, slack_m: float = 30.0) -> tuple[Snap, np.ndarray]:
        """Elege a malha operacional a partir da ORIGEM: entre os trechos até `slack_m` além do
        mais próximo, escolhe o que alcança mais nós (evita prender a origem num beco de mão
        única) e devolve a máscara de alcance."""
        px, py = lon * self.kx * M_PER_DEG, lat * M_PER_DEG
        cands = self._candidates(px, py, max_dist)
        if not cands:
            raise SnapError(f"Origem ({lat:.6f}, {lon:.6f}) está a mais de {max_dist:.0f} m da malha.")
        best = None
        for d, e, t in cands:
            if d > cands[0][0] + slack_m:
                break
            reach = self.reach_from(self.exit_nodes(e))
            size = int(reach.sum())
            if best is None or size > best[0]:
                best = (size, d, e, t, reach)
        size, d, e, t, reach = best
        sn = self._make_snap(lat, lon, d, e, t, px, py, cands[0][0])
        # o próprio trecho da origem é alcançável a partir dela
        reach[self.net.ea[e]] |= bool(self.net.ebwd[e])
        reach[self.net.eb[e]] |= bool(self.net.efwd[e])
        if size < 0.01 * self.net.n_nodes:
            sn.flags.append("origem_em_trecho_isolado")
        return sn, reach

    def _project(self, e: int, px: float, py: float) -> tuple[float, float]:
        a, b = self.net.ea[e], self.net.eb[e]
        ax, ay, bx, by = self.x[a], self.y[a], self.x[b], self.y[b]
        dx, dy = bx - ax, by - ay
        L2 = dx * dx + dy * dy
        t = 0.0 if L2 == 0 else max(0.0, min(1.0, ((px - ax) * dx + (py - ay) * dy) / L2))
        qx, qy = ax + t * dx, ay + t * dy
        return math.hypot(px - qx, py - qy), t

    # ------------------------------------------------------------ consultas

    def solver(self, snaps: list[Snap]) -> "RouteSolver":
        return RouteSolver(self, snaps)


@dataclass
class Arc:
    edge: int
    forward: bool
    f0: float   # fração inicial (no sentido da aresta original)
    f1: float


class RouteSolver:
    """Grafo da consulta (malha + nós virtuais nas paradas) e matrizes."""

    def __init__(self, router: Router, snaps: list[Snap]):
        self.r = router
        net = router.net
        n = net.n_nodes
        src, dst, eid, fwd = router._base_arcs()
        f0 = np.where(fwd, 0.0, 1.0)
        f1 = np.where(fwd, 1.0, 0.0)

        # nós virtuais: divide cada aresta onde há parada projetada
        extra_src, extra_dst, extra_e, extra_f0, extra_f1 = [], [], [], [], []
        by_edge: dict[int, list[Snap]] = {}
        for s in snaps:
            if s.t <= 1e-6:
                s.node = net.ea[s.edge]
            elif s.t >= 1 - 1e-6:
                s.node = net.eb[s.edge]
            else:
                by_edge.setdefault(s.edge, []).append(s)
        next_node = n
        self.virtual_pos: list[tuple[float, float]] = []
        for e, group in by_edge.items():
            ts = sorted({round(s.t, 9) for s in group})
            ids = []
            for t in ts:
                ids.append(next_node)
                a, b = net.ea[e], net.eb[e]
                self.virtual_pos.append((
                    net.lat[a] + t * (net.lat[b] - net.lat[a]),
                    net.lon[a] + t * (net.lon[b] - net.lon[a]),
                ))
                next_node += 1
            for s in group:
                s.node = ids[ts.index(round(s.t, 9))]
            chain = [net.ea[e]] + ids + [net.eb[e]]
            fr = [0.0] + ts + [1.0]
            for k in range(len(chain) - 1):
                if net.efwd[e]:
                    extra_src.append(chain[k]); extra_dst.append(chain[k + 1])
                    extra_e.append(e); extra_f0.append(fr[k]); extra_f1.append(fr[k + 1])
                if net.ebwd[e]:
                    extra_src.append(chain[k + 1]); extra_dst.append(chain[k])
                    extra_e.append(e); extra_f0.append(fr[k + 1]); extra_f1.append(fr[k])
        self.n = next_node
        self.snaps = snaps

        src = np.concatenate([src, np.array(extra_src, dtype=np.int64)])
        dst = np.concatenate([dst, np.array(extra_dst, dtype=np.int64)])
        eid = np.concatenate([eid, np.array(extra_e, dtype=np.int64)])
        f0 = np.concatenate([f0, np.array(extra_f0, dtype=float)])
        f1 = np.concatenate([f1, np.array(extra_f1, dtype=float)])

        # pesos
        node_pen = np.concatenate([router.node_pen, np.zeros(self.n - n)])
        frac = np.abs(f1 - f0)
        w = np.where(f1 > f0, router.w_fwd[eid], router.w_bwd[eid]) * frac
        length = router.elen[eid] * frac
        w = w + node_pen[dst] + DIST_TIEBREAK * length + 1e-9

        # remove arcos paralelos mantendo o de menor peso
        order = np.lexsort((w, dst, src))
        src, dst, w = src[order], dst[order], w[order]
        eid, f0, f1, length = eid[order], f0[order], f1[order], length[order]
        keep = np.ones(len(src), dtype=bool)
        keep[1:] = (src[1:] != src[:-1]) | (dst[1:] != dst[:-1])
        self.src, self.dst, self.w = src[keep], dst[keep], w[keep]
        self.eid, self.f0, self.f1 = eid[keep], f0[keep], f1[keep]
        self.length = length[keep]
        self.arc_index = {
            (int(u), int(v)): i for i, (u, v) in enumerate(zip(self.src, self.dst))
        }
        self.graph = csr_matrix((self.w, (self.src, self.dst)), shape=(self.n, self.n))
        # chave ordenada (src*n + dst) para localizar arcos vetorialmente
        self.keys = self.src * self.n + self.dst
        self.time = self.w - DIST_TIEBREAK * self.length - 1e-9
        self._trees: dict[int, tuple[np.ndarray, np.ndarray]] = {}

    def node_latlon(self, v: int) -> tuple[float, float]:
        n = self.r.net.n_nodes
        if v < n:
            return self.r.net.lat[v], self.r.net.lon[v]
        return self.virtual_pos[v - n]

    def _pred_row(self, i: int) -> tuple[np.ndarray, np.ndarray]:
        """Árvore de caminhos mais rápidos a partir da parada i (com cache)."""
        if i not in self._trees:
            dist, pred = dijkstra(
                self.graph, directed=True, indices=[self.snaps[i].node],
                return_predecessors=True,
            )
            self._trees[i] = (dist[0], pred[0])
        return self._trees[i]

    def path_arcs(self, i: int, j: int) -> list[int] | None:
        """Arcos do caminho mais rápido da parada i à parada j."""
        s, t = self.snaps[i].node, self.snaps[j].node
        if s == t:
            return []
        dist, pred = self._pred_row(i)
        if not np.isfinite(dist[t]):
            return None
        nodes = [t]
        while nodes[-1] != s:
            p = pred[nodes[-1]]
            if p < 0:
                return None
            nodes.append(int(p))
        nodes.reverse()
        return [self.arc_index[(nodes[k], nodes[k + 1])] for k in range(len(nodes) - 1)]

    def arc_time(self, a: int) -> float:
        """Tempo (s) do arco, com penalidades, sem o termo de desempate."""
        return float(self.time[a])

    def matrices(self, chunk: int = 32) -> tuple[np.ndarray, np.ndarray]:
        """Matrizes de tempo (s) e distância (m) entre todas as paradas.

        Dijkstra multi-origem em blocos; tempo e distância ao longo da árvore
        de caminhos mais rápidos são acumulados por "pointer jumping"
        (O(N log profundidade) vetorizado), sem reconstruir cada par.
        """
        k = len(self.snaps)
        n = self.n
        targets = np.array([s.node for s in self.snaps], dtype=np.int64)
        T = np.full((k, k), np.inf)
        D = np.full((k, k), np.inf)
        ar = np.arange(n, dtype=np.int64)
        for c0 in range(0, k, chunk):
            idx = list(range(c0, min(k, c0 + chunk)))
            dist, pred = dijkstra(
                self.graph, directed=True, indices=targets[idx],
                return_predecessors=True,
            )
            for r, i in enumerate(idx):
                p = pred[r].astype(np.int64)
                valid = p >= 0
                te = np.zeros(n)
                le = np.zeros(n)
                ai = np.searchsorted(self.keys, p[valid] * n + ar[valid])
                te[valid] = self.time[ai]
                le[valid] = self.length[ai]
                P = np.where(valid, p, ar)
                while True:
                    PP = P[P]
                    if np.array_equal(PP, P):
                        break
                    te = te + te[P]
                    le = le + le[P]
                    P = PP
                reach = np.isfinite(dist[r, targets])
                T[i, reach] = te[targets][reach]
                D[i, reach] = le[targets][reach]
                T[i, i] = D[i, i] = 0.0
        return T, D

    # ------------------------------------------------------------ geometria

    def arc_info(self, a: int) -> dict:
        e = int(self.eid[a])
        net = self.r.net
        fw = self.f1[a] > self.f0[a]
        flags = net.eflags[e]
        names = [FLAG_NAMES[f] for f in FLAG_NAMES if flags & f]
        if (net.ecf_fwd[e] if fw else net.ecf_bwd[e]):
            names.append("contramao_veiculos")
        v = int(self.dst[a])
        if v < net.n_nodes:
            nf = net.node_flags[v]
            if nf & N_BARRIER:
                names.append("barreira")
            if nf & N_PRIVATE:
                names.append("portao_privado")
        return {
            "mode": self.r.edge_mode[e],
            "flags": names,
            "name": net.ename[e],
        }

    def arc_coords(self, a: int) -> list[tuple[float, float]]:
        """Coordenadas [lon, lat] do arco (GeoJSON)."""
        u, v = int(self.src[a]), int(self.dst[a])
        (la, lo), (lb, lob) = self.node_latlon(u), self.node_latlon(v)
        return [(lo, la), (lob, lb)]


__all__ = ["Router", "RouteSolver", "Snap", "SnapError", "edge_mode", "F_AREA"]
