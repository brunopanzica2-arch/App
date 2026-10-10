"""Gerador DETERMINÍSTICO das fixtures de teste (Centro, Paquetá e Vila Nova — Santos/SP).

Saídas (nesta pasta):
  cenario_300_cartas_centro_paqueta_vila_nova.csv  300 cartas fictícias, 150 chaves de imóvel
  casos_adversariais_30.csv                         30 linhas adversariais (parser/normalização/segurança)
  posicoes_teste_osm.csv                            150 POSIÇÕES TESTE (nós OSM reais) — NÃO são portas
  manifesto_testes.json                             contagens esperadas, hashes e avisos

Regras:
- Logradouros: nomes REAIS de vias do OSM cujo traçado está dentro do polígono OSM do bairro
  (bairros_osm.geojson, obtido do Nominatim). Os NÚMEROS de porta são SINTÉTICOS e NÃO foram
  verificados: não use este arquivo para afirmar que uma porta existe.
- Destinatários, identificadores e observações são FICTÍCIOS.
- Posições TESTE: nós da malha de pedestres OSM sobre a própria via, dentro do bairro, ordenados ao
  longo da via conforme o número sintético. Servem só para testar roteamento na malha real.

Uso:  cd backend && python ../test-data/gerar_casos.py
"""

from __future__ import annotations

import csv
import hashlib
import io
import json
import random
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent / "backend"))

SEED = 20261009
GEN_VERSION = "2.0"

# multiplicidade por bairro: (chaves com 4 cartas, chaves com 1 carta, chaves com 2 cartas)
PLAN = {
    "Centro": (4, 8, 48),      # 60 chaves, 120 cartas
    "Paquetá": (4, 7, 39),     # 50 chaves, 101 cartas
    "Vila Nova": (2, 5, 33),   # 40 chaves,  79 cartas
}
STREETS_PER_NB = {"Centro": 12, "Paquetá": 10, "Vila Nova": 9}
FIRST = ["Ana", "Bruno", "Carla", "Diego", "Elisa", "Fábio", "Gabriela", "Heitor", "Íris", "João", "Kátia",
         "Lucas", "Marina", "Nélson", "Olívia", "Paulo", "Quitéria", "Rafael", "Sílvia", "Tiago", "Úrsula",
         "Vítor", "Wanda", "Xavier", "Yara", "Zeca"]
LAST = ["Abreu", "Barbosa", "Cardoso", "Duarte", "Esteves", "Fagundes", "Galvão", "Henriques", "Jardim",
        "Leal", "Macedo", "Nogueira", "Otero", "Pacheco", "Queiroz", "Rezende", "Siqueira", "Toledo",
        "Valadares", "Xisto"]
HEADER = ["identificador", "destinatario", "logradouro", "numero", "complemento", "bairro", "municipio",
          "cep", "observacoes"]


def point_in_poly(lon, lat, rings) -> bool:
    inside = False
    for ring in rings:  # anel externo + buracos (par-ímpar)
        n = len(ring)
        for i in range(n):
            x1, y1 = ring[i]
            x2, y2 = ring[(i + 1) % n]
            if (y1 > lat) != (y2 > lat) and lon < x1 + (lat - y1) * (x2 - x1) / (y2 - y1):
                inside = not inside
    return inside


def polygons():
    gj = json.loads((HERE / "bairros_osm.geojson").read_text())
    out = {}
    for f in gj["features"]:
        g = f["geometry"]
        polys = [g["coordinates"]] if g["type"] == "Polygon" else g["coordinates"]
        out[f["properties"]["bairro"]] = polys
    return out


def inside(polys, lat, lon) -> bool:
    return any(point_in_poly(lon, lat, p) for p in polys)


def load_network():
    from app.core.config import get_settings
    from app.services.routing.engines import InternalEngine

    return InternalEngine(get_settings()).network()


def street_nodes(net, polys):
    """nome da via -> {bairro: [nós da via dentro do bairro, em ordem de percurso]}."""
    from roteamento.network import F_AREA

    by_name: dict[str, dict[str, list[int]]] = {}
    for e in range(net.n_edges):
        name = net.ename[e]
        if not name or net.eflags[e] & F_AREA:
            continue
        for v in (net.ea[e], net.eb[e]):
            for nb, p in polys.items():
                if inside(p, net.lat[v], net.lon[v]):
                    lst = by_name.setdefault(name, {}).setdefault(nb, [])
                    if v not in lst:
                        lst.append(v)
    return by_name


def order_along(net, nodes):
    """Ordena os nós pela projeção no eixo principal da via (aprox. ordem de numeração)."""
    import math

    lat0 = sum(net.lat[v] for v in nodes) / len(nodes)
    kx = math.cos(math.radians(lat0))
    xs = [(net.lon[v] * kx, net.lat[v]) for v in nodes]
    mx = sum(x for x, _ in xs) / len(xs)
    my = sum(y for _, y in xs) / len(xs)
    sxx = sum((x - mx) ** 2 for x, _ in xs)
    syy = sum((y - my) ** 2 for _, y in xs)
    sxy = sum((x - mx) * (y - my) for x, y in xs)
    ang = 0.5 * math.atan2(2 * sxy, sxx - syy)
    proj = [((x - mx) * math.cos(ang) + (y - my) * math.sin(ang), v) for (x, y), v in zip(xs, nodes)]
    return [v for _, v in sorted(proj)]


def main():
    rng = random.Random(SEED)
    polys = polygons()
    net = load_network()
    by_name = street_nodes(net, polys)
    used_nodes: set[int] = set()
    used_numbers: set[tuple[str, int]] = set()  # (via, número) único: a mesma via cruza bairros

    rows = []
    positions = []
    key_seq = 0
    letter_seq = 0
    stats = {}
    for nb, (n4, n1, n2) in PLAN.items():
        # vias com mais nós dentro do bairro (vias longas => muitos números na mesma rua)
        cands = sorted(((len(v[nb]), name) for name, v in by_name.items() if nb in v and len(v[nb]) >= 6),
                       reverse=True)
        streets = [name for _, name in cands[: STREETS_PER_NB[nb]]]
        mult = [4] * n4 + [1] * n1 + [2] * n2
        rng.shuffle(mult)
        keys_per_street = [0] * len(streets)
        for i in range(len(mult)):
            # concentração desigual: as 3 primeiras vias recebem mais imóveis
            keys_per_street[(i * 7) % len(streets) if i % 4 else (i // 4) % 3] += 1
        k = 0
        nb_letters = 0
        for s_idx, street in enumerate(streets):
            n_keys = keys_per_street[s_idx]
            if not n_keys:
                continue
            nodes = [v for v in order_along(net, by_name[street][nb]) if v not in used_nodes]
            if len(nodes) < n_keys:
                nodes = order_along(net, by_name[street][nb])
            step = max(1, len(nodes) // n_keys)
            picks = [nodes[min(i * step + step // 2, len(nodes) - 1)] for i in range(n_keys)]
            base = rng.randrange(10, 120, 2)
            for j in range(n_keys):
                key_seq += 1
                # números sintéticos crescentes ao longo da via, alternando par/ímpar
                number = base + j * rng.choice([12, 18, 24, 30]) + (j % 2)
                while (street, number) in used_numbers:
                    number += 2
                used_numbers.add((street, number))
                m = mult[k]
                k += 1
                v = picks[j]
                used_nodes.add(v)
                positions.append({
                    "chave": f"K{key_seq:03d}", "bairro": nb, "logradouro": street, "numero": number,
                    "lat": round(net.lat[v], 7), "lon": round(net.lon[v], 7), "osm_node": net.osm_id[v],
                    "aviso": "POSICAO TESTE (no OSM sobre a via); NAO representa a porta do numero",
                })
                building = rng.random() < 0.5
                for c in range(m):
                    letter_seq += 1
                    comp = ""
                    if m > 1 and building:
                        comp = f"apto {rng.randint(1, 12)}{rng.randint(1, 4)}"
                    elif m > 1 and c > 0:
                        comp = rng.choice(["fundos", "casa 2", "loja", ""])
                    name = f"{rng.choice(FIRST)} {rng.choice(LAST)} {rng.choice(LAST)}"
                    obs = rng.choice(["", "", "", "portaria 24h", "interfone com defeito", "deixar com zelador"])
                    rows.append([f"STS{letter_seq:05d}", name, street, str(number), comp, nb, "Santos", "", obs])
                    nb_letters += 1
        stats[nb] = {"chaves": k, "cartas": nb_letters, "vias": len([1 for x in keys_per_street if x])}

    # embaralha as linhas (a ordem do CSV não deve influenciar a rota)
    rng.shuffle(rows)

    def write_csv(path: Path, header, data, bom=True):
        buf = io.StringIO()
        w = csv.writer(buf, delimiter=";", lineterminator="\r\n", quoting=csv.QUOTE_MINIMAL)
        w.writerow(header)
        w.writerows(data)
        path.write_bytes(("﻿" if bom else "").encode() + buf.getvalue().encode("utf-8"))

    write_csv(HERE / "cenario_300_cartas_centro_paqueta_vila_nova.csv", HEADER, rows)
    write_csv(HERE / "posicoes_teste_osm.csv", list(positions[0].keys()), [list(p.values()) for p in positions])

    # ---------------- casos adversariais (30 linhas) com expectativa por linha
    some = positions[0]
    adv = [
        ("ADV01", "Ana Teste", some["logradouro"], "100", "bloco A\napto 12", "Centro", "Santos", "", "complemento com QUEBRA DE LINHA", "ok"),
        ("ADV02", "Bruno; Teste", some["logradouro"], "102", "sala 3; fundos", "Centro", "Santos", "", "ponto-e-vírgula entre aspas", "ok"),
        ("ADV03", 'Carla "Cacá" Teste', some["logradouro"], "104", "", "Centro", "Santos", "", 'aspas duplas escapadas ""', "ok"),
        ("ADV04", "Diego Teste", "", "10", "", "Centro", "Santos", "", "sem logradouro", "erro"),
        ("ADV05", "Elisa Teste", some["logradouro"], "S/N", "", "Centro", "Santos", "", "sem número", "alerta"),
        ("ADV06", "Fábio Teste", some["logradouro"], "106A", "", "Centro", "Santos", "", "número com letra", "ok"),
        ("ADV07", "Gabriela Teste", some["logradouro"], "108.0", "", "Centro", "Santos", "", "número vindo de planilha (108.0)", "ok"),
        ("ADV08", "Heitor Teste", some["logradouro"], "0110", "", "Centro", "Santos", "", "número com zero à esquerda", "ok"),
        ("ADV09", "Íris Teste", some["logradouro"], "112", "", "Centro", "Santos", "1101", "CEP inválido", "alerta"),
        ("ADV10", "João Teste", some["logradouro"], "114", "", "Centro", "São Vicente/SP", "", "outro município", "alerta"),
        ("ADV11", "Kátia Teste", "R. " + some["logradouro"].split(" ", 1)[-1], "116", "", "Centro", "Santos", "", "abreviação R.", "ok"),
        ("ADV12", "Lucas Teste", some["logradouro"].upper(), "116", "apto 2", "Centro", "Santos", "", "MAIÚSCULAS: mesma chave do ADV11", "ok"),
        ("ADV13", "Marina Teste", some["logradouro"], "118", "", "Vila Nova", "Santos", "", "bairro informado possivelmente errado", "ok"),
        ("ADV14", "Nélson Teste", some["logradouro"], "120", "", "Centro", "Santos", "", '=HYPERLINK("http://x","clique")', "ok"),
        ("ADV15", "<script>alert(1)</script>", some["logradouro"], "122", "", "Centro", "Santos", "", "<img src=x onerror=alert(1)>", "ok"),
        ("ADV16", "Olívia Teste", "  " + some["logradouro"] + "  ", "  124 ", "", " Centro ", "Santos", "", "espaços extras", "ok"),
        ("ADV17", "Paulo Teste", some["logradouro"].replace(" ", " ", 1), "126", "", "Centro", "Santos", "", "NBSP", "ok"),
        ("ADV18", "Quitéria Teste", some["logradouro"], "128", "", "Centro", "Santos", "", "+5511999999999", "ok"),
        ("ADV19", "Rafael Teste", some["logradouro"], "130", "", "Centro", "Santos", "", "-2+3", "ok"),
        ("ADV20", "Sílvia Teste", some["logradouro"], "132", "", "Centro", "Santos", "", "@SUM(A1)", "ok"),
        ("STS00001", "Tiago Teste", some["logradouro"], "134", "", "Centro", "Santos", "", "ID repetido do cenário principal", "duplicado_se_mesmo_banco"),
        ("ADV22", "Úrsula Teste", some["logradouro"], "136", "", "Centro", "Santos", "", "", "ok"),
        ("ADV22", "Úrsula Teste", some["logradouro"], "136", "", "Centro", "Santos", "", "ID repetido no próprio arquivo", "duplicado"),
        ("ADV24", "Vítor Teste 🚲", some["logradouro"], "138", "", "Centro", "Santos", "", "emoji", "ok"),
        ("ADV25", "Wanda Teste", "Av. Cons. Nébias", "140", "", "Vila Nova", "Santos", "", "abreviações de tipo e título", "ok"),
        ("ADV26", "Xavier Teste", "Avenida Conselheiro Nébias", "140", "", "Paquetá", "Santos", "", "mesma chave do ADV25 com bairro diferente", "ok"),
        ("ADV27", "Yara Teste", "Rua Conselheiro Nébias", "140", "", "Vila Nova", "Santos", "", "tipo diferente (Rua x Avenida): chave diferente", "ok"),
        ("ADV28", "Zeca Teste", some["logradouro"], "142-144", "", "Centro", "Santos", "", "faixa de números", "ok"),
        ("ADV29", "Ana Teste", some["logradouro"], "146", "", "Centro", "Santos", "", "observação longa " + "x" * 400, "ok"),
        ("ADV30", "Bruno Teste", some["logradouro"], "abc", "", "Centro", "Santos", "", "número inválido", "alerta"),
    ]
    write_csv(HERE / "casos_adversariais_30.csv", HEADER, [list(a[:9]) for a in adv])

    def sha(p):
        return hashlib.sha256((HERE / p).read_bytes()).hexdigest()

    from collections import Counter
    mult_count = Counter()
    per_key = Counter((r[2], r[3]) for r in rows)
    for v in per_key.values():
        mult_count[v] += 1
    manifest = {
        "gerador": "gerar_casos.py", "versao": GEN_VERSION, "seed": SEED,
        "fonte_vias": "OpenStreetMap (ODbL) — nomes de vias da malha de pedestres; polígonos de bairro via Nominatim",
        "aviso": "Números de porta SINTÉTICOS e NÃO verificados. Destinatários e IDs fictícios. "
                 "Posições TESTE não representam portas.",
        "cenario_300": {
            "arquivo": "cenario_300_cartas_centro_paqueta_vila_nova.csv", "sha256": sha("cenario_300_cartas_centro_paqueta_vila_nova.csv"),
            "cartas": len(rows), "ids_distintos": len({r[0] for r in rows}), "chaves_imovel": len(per_key),
            "por_bairro": stats, "multiplicidade": {str(k): v for k, v in sorted(mult_count.items())},
            "codificacao": "UTF-8 com BOM", "delimitador": ";", "fim_de_linha": "CRLF",
        },
        "posicoes_teste": {"arquivo": "posicoes_teste_osm.csv", "sha256": sha("posicoes_teste_osm.csv"), "quantidade": len(positions)},
        "adversariais": {
            "arquivo": "casos_adversariais_30.csv", "sha256": sha("casos_adversariais_30.csv"), "linhas_de_dados": len(adv),
            "expectativa": [{"id": a[0], "caso": a[8][:60], "esperado": a[9]} for a in adv],
            "esperado_importacao_isolada": {"registros_lidos": 30, "inseridas": 29, "duplicadas_no_arquivo": 1,
                                             "com_erro": 1},
        },
    }
    (HERE / "manifesto_testes.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=1))
    print(json.dumps({k: v for k, v in manifest["cenario_300"].items() if k != "sha256"}, ensure_ascii=False, indent=1))


if __name__ == "__main__":
    main()
