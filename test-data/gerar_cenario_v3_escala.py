"""Cenário de ESCALA (V3 §8-B/E2E-19): 1000 cartas FICTÍCIAS em 500 endereços sintéticos de Centro/Paquetá/Vila Nova.

- ruas: as mesmas do cenário de 300 cartas (nomes de vias do OSM por bairro); NÚMEROS e destinatários são inventados;
- posições TESTE: os 500 nós OSM do benchmark c1000_500 (benchmarks/c1000_500.json), sobre as vias — NÃO são portas;
- determinístico (semente fixa). Saída: v3/cenario_1000_cartas_500_paradas.csv e v3/posicoes_teste_1000.csv
"""
import csv
import json
import random
from collections import defaultdict
from pathlib import Path

HERE = Path(__file__).resolve().parent
OUT = HERE / "v3"
OUT.mkdir(exist_ok=True)
rnd = random.Random(20261010)

letters = list(csv.DictReader((HERE / "cenario_300_cartas_centro_paqueta_vila_nova.csv").read_text(encoding="utf-8-sig").splitlines(), delimiter=";"))
streets = defaultdict(set)
for r in letters:
    streets[r["bairro"]].add(r["logradouro"])
streets = {b: sorted(s) for b, s in streets.items()}
pts = json.loads((HERE / "benchmarks" / "c1000_500.json").read_text())["stops"]

used = set()
rows, pos = [], []
n = 0
for k, p in enumerate(pts):
    b = p["bairro"]
    while True:
        st = rnd.choice(streets[b])
        num = rnd.randint(1, 1900)
        if (st, num) not in used:
            used.add((st, num))
            break
    pos.append([f"V{k + 1:04d}", b, st, num, f"{p['p'][0]:.7f}", f"{p['p'][1]:.7f}"])
    for c in range(p["cartas"]):
        n += 1
        rows.append([f"V3L{n:05d}", f"Pessoa Teste {n:05d}", st, num, f"apto {c + 1}" if p["cartas"] > 1 else "", b, "Santos", "", "FICTÍCIA"])
HEAD = ["identificador", "destinatario", "logradouro", "numero", "complemento", "bairro", "municipio", "cep", "observacoes"]
with open(OUT / "cenario_1000_cartas_500_paradas.csv", "w", newline="", encoding="utf-8-sig") as f:
    w = csv.writer(f, delimiter=";", lineterminator="\r\n")
    w.writerow(HEAD)
    w.writerows(rows)
with open(OUT / "posicoes_teste_1000.csv", "w", newline="", encoding="utf-8-sig") as f:
    w = csv.writer(f, delimiter=";", lineterminator="\r\n")
    w.writerow(["chave", "bairro", "logradouro", "numero", "lat", "lon", "aviso"])
    for r in pos:
        w.writerow(r + ["POSICAO TESTE (nó OSM sobre a via); NAO representa a porta do numero"])
print(len(rows), "cartas;", len(pos), "endereços")
