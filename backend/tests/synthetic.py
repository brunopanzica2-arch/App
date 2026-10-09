"""Malha OSM SINTÉTICA para testes (não representa as ruas reais de Santos).

Grade de ruas a cada ~100 m cobrindo a caixa do MockProvider, com:
- ruas de mão única para automóveis (devem ser percorríveis nos dois sentidos);
- uma ciclovia (não deve ser priorizada);
- escadaria, via privada e portão com barreira;
- uma "ilha" desconectada (deve ser detectada como inalcançável).
"""

from __future__ import annotations

from roteamento.osm_data import OsmData

S, W, N, E = -23.976, -46.346, -23.949, -46.309
STEP = 0.0009  # ~100 m


def grid_osm() -> OsmData:
    d = OsmData()
    rows = int((N - S) / STEP) + 1
    cols = int((E - W) / STEP) + 1
    nid = lambda r, c: 1_000_000 + r * 1000 + c
    for r in range(rows):
        for c in range(cols):
            d.nodes[nid(r, c)] = (S + r * STEP, W + c * STEP)
    wid = 1
    for r in range(rows):
        tags = {"highway": "residential", "name": f"Rua Sintética {r}"}
        if r % 2 == 1:
            tags["oneway"] = "yes"  # mão única para carros: NÃO deve restringir
        d.ways[wid] = ([nid(r, c) for c in range(cols)], tags)
        wid += 1
    for c in range(cols):
        tags = {"highway": "residential", "name": f"Avenida Sintética {c}"}
        if c % 3 == 0:
            tags["oneway"] = "-1"
        d.ways[wid] = ([nid(r, c) for r in range(rows)], tags)
        wid += 1
    # ciclovia paralela à rua 5 (não deve ser preferida)
    base = 2_000_000
    for c in range(cols):
        d.nodes[base + c] = (S + 5 * STEP + 0.00005, W + c * STEP)
    d.ways[90001] = ([base + c for c in range(cols)], {"highway": "cycleway"})
    # escadaria ligando (2,2) ao meio do quarteirão diagonal
    d.nodes[3_000_001] = (S + 2.5 * STEP, W + 2.5 * STEP)
    d.ways[90002] = ([nid(2, 2), 3_000_001, nid(3, 3)], {"highway": "steps"})
    # via privada
    d.ways[90003] = ([nid(4, 4), nid(5, 5)], {"highway": "service", "access": "private"})
    # portão com cancela de bicicleta (cycle_barrier) num atalho de pedestre
    d.nodes[3_000_002] = (S + 6.5 * STEP, W + 6.5 * STEP)
    d.node_tags[3_000_002] = {"barrier": "cycle_barrier"}
    d.ways[90004] = ([nid(6, 6), 3_000_002, nid(7, 7)], {"highway": "footway"})
    # muro: barreira intransponível — via inutilizável através dele
    d.nodes[3_000_003] = (S + 8.5 * STEP, W + 8.5 * STEP)
    d.node_tags[3_000_003] = {"barrier": "wall"}
    d.ways[90005] = ([nid(8, 8), 3_000_003, nid(9, 9)], {"highway": "footway"})
    # ilha desconectada (ex.: pátio fechado), a ~150 m da grade? -> longe dela
    for k in range(3):
        d.nodes[4_000_000 + k] = (N + 0.01, W + k * STEP)
    d.ways[90006] = ([4_000_000, 4_000_001, 4_000_002], {"highway": "footway"})
    return d


def island_point() -> tuple[float, float]:
    return (N + 0.01, W + STEP)
