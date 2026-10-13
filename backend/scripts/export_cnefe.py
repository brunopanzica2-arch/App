"""Exporta o CNEFE (IBGE, Censo 2022) de um município para a base offline de endereços do app (RSA1).

Fonte (dados abertos do IBGE, citar a fonte):
  https://ftp.ibge.gov.br/Cadastro_Nacional_de_Enderecos_para_Fins_Estatisticos/Censo_Demografico_2022/Arquivos_CNEFE/CSV/Municipio/35_SP/3548500_SANTOS.zip

Uso:  python backend/scripts/export_cnefe.py 3548500_SANTOS.zip mobile/public/santos-enderecos.bin

Formato RSA1 (little-endian), por logradouro ordenado por (chave) e por registro ordenado por (número, sufixo):
  "RSA1", u32 n_streets, u32 n_records, u32 n_loc, u32 json_len
  u32 street_start[n_streets+1]
  u32 num[n]  i32 lat_e6[n]  i32 lon_e6[n]  u16 loc[n]  u8 suf[n] (0=nenhum, 1..26=A..Z)  u8 lvl_cnt[n] (bits 7-6 nível 1..3, bits 5-0 nº de unidades, máx. 63)
  json: {"streets":[{"k": chave normalizada, "t": tipo, "n": nome com título}], "loc":[bairros], ...}
Um registro = (logradouro, número, sufixo, bairro). Várias unidades (apartamentos) no mesmo número/bairro viram UM ponto (média dos pontos do melhor nível).
Nível de coordenada (NV_GEO_COORD do IBGE): 1 = ponto do endereço; 2 = face da quadra (aproximado); 3+ = pior.
"""
from __future__ import annotations

import csv
import hashlib
import io
import json
import re
import struct
import sys
import unicodedata
import zipfile
from collections import defaultdict
from pathlib import Path

UNITS = ["zero", "um", "dois", "tres", "quatro", "cinco", "seis", "sete", "oito", "nove", "dez", "onze", "doze", "treze", "quatorze", "quinze", "dezesseis", "dezessete", "dezoito", "dezenove"]
TENS = {20: "vinte", 30: "trinta", 40: "quarenta", 50: "cinquenta", 60: "sessenta", 70: "setenta", 80: "oitenta", 90: "noventa"}


def num2words_pt(n: int) -> str:
    """1..99 por extenso (mesma regra do app, src/core/cnefe.ts). Acima disso devolve os dígitos."""
    if n < 20:
        return UNITS[n]
    if n < 100:
        t, u = (n // 10) * 10, n % 10
        return TENS[t] if u == 0 else f"{TENS[t]} e {UNITS[u]}"
    return str(n)


def strip(s: str) -> str:
    return unicodedata.normalize("NFKD", s or "").encode("ascii", "ignore").decode()


def key_of(text: str) -> str:
    """UPPER sem acento, só letras/dígitos; dígitos de 1..99 viram palavras ("7" → "SETE", "28" → "VINTE E OITO")."""
    toks = re.sub(r"[^A-Z0-9 ]", " ", strip(text).upper()).split()
    out: list[str] = []
    for t in toks:
        if t.isdigit() and 1 <= int(t) <= 99:
            out.extend(num2words_pt(int(t)).upper().split())
        else:
            out.append(t)
    return " ".join(out)


def main(src: str, dst: str) -> None:
    p = Path(src)
    raw = zipfile.ZipFile(p).read(next(n for n in zipfile.ZipFile(p).namelist() if n.lower().endswith(".csv"))) if p.suffix == ".zip" else p.read_bytes()
    sha_src = hashlib.sha256(Path(src).read_bytes()).hexdigest()
    rd = csv.DictReader(io.StringIO(raw.decode("utf-8", errors="replace"), newline=""), delimiter=";")
    streets: dict[str, dict] = {}
    locs: dict[str, int] = {}
    pts: dict[tuple, list] = defaultdict(list)  # (street_key, num, suf, loc) -> [(lat, lon, lvl)]  (um registro POR BAIRRO: o mesmo nome de rua/número existe em bairros diferentes)
    total = skipped = 0
    for r in rd:
        total += 1
        try:
            num = int((r["NUM_ENDERECO"] or "0").strip() or 0)
            lat, lon = float(r["LATITUDE"]), float(r["LONGITUDE"])
        except ValueError:
            skipped += 1
            continue
        if num <= 0 or not (-24.1 < lat < -23.7 and -46.5 < lon < -46.2):
            skipped += 1
            continue
        tipo, titulo, nome = (r["NOM_TIPO_SEGLOGR"] or "").strip(), (r["NOM_TITULO_SEGLOGR"] or "").strip(), (r["NOM_SEGLOGR"] or "").strip()
        if not nome:
            skipped += 1
            continue
        k = key_of(f"{tipo} {titulo} {nome}")
        streets.setdefault(k, {"k": k, "t": tipo, "n": " ".join(x for x in (titulo, nome) if x)})
        mod = (r.get("DSC_MODIFICADOR") or "").strip().upper()
        suf = ord(mod) - 64 if len(mod) == 1 and "A" <= mod <= "Z" else 0
        loc = (r["DSC_LOCALIDADE"] or "").strip()
        li = locs.setdefault(loc, len(locs))
        try:
            lvl = max(1, min(3, int(r["NV_GEO_COORD"] or 3)))
        except ValueError:
            lvl = 3
        pts[(k, num, suf, li)].append((lat, lon, lvl))
    order = sorted(streets)
    sidx = {k: i for i, k in enumerate(order)}
    recs = sorted(pts, key=lambda x: (sidx[x[0]], x[1], x[2], x[3]))
    start = [0] * (len(order) + 1)
    num_a, lat_a, lon_a, loc_a, suf_a, lc_a = [], [], [], [], [], []
    cur = -1
    for i, (k, num, suf, li) in enumerate(recs):
        si = sidx[k]
        while cur < si:
            cur += 1
            start[cur] = i
        g = pts[(k, num, suf, li)]
        best = min(x[2] for x in g)
        sel = [x for x in g if x[2] == best]
        lat = sum(x[0] for x in sel) / len(sel)
        lon = sum(x[1] for x in sel) / len(sel)
        num_a.append(num); lat_a.append(round(lat * 1e6)); lon_a.append(round(lon * 1e6)); loc_a.append(li); suf_a.append(suf)
        lc_a.append((best << 6) | min(63, len(g)))
    while cur < len(order):
        cur += 1
        start[cur] = len(recs)
    meta = {
        "streets": [streets[k] for k in order], "loc": list(locs),
        "fonte": "IBGE, Censo Demográfico 2022, Cadastro Nacional de Endereços para Fins Estatísticos (CNEFE)",
        "url": "https://ftp.ibge.gov.br/Cadastro_Nacional_de_Enderecos_para_Fins_Estatisticos/Censo_Demografico_2022/Arquivos_CNEFE/CSV/Municipio/35_SP/3548500_SANTOS.zip",
        "municipio": "Santos/SP (3548500)", "linhas_csv": total, "descartadas": skipped, "registros": len(recs), "logradouros": len(order), "sha256_zip": sha_src,
        "aviso": "Pontos do CNEFE são para fins estatísticos: nível 1 = ponto do endereço, nível 2 = face da quadra. Confirme a porta em campo.",
    }
    blob = json.dumps(meta, ensure_ascii=False, separators=(",", ":")).encode()
    out = bytearray(b"RSA1" + struct.pack("<IIII", len(order), len(recs), len(locs), len(blob)))
    out += struct.pack(f"<{len(start)}I", *start)
    out += struct.pack(f"<{len(recs)}I", *num_a) + struct.pack(f"<{len(recs)}i", *lat_a) + struct.pack(f"<{len(recs)}i", *lon_a)
    out += struct.pack(f"<{len(recs)}H", *loc_a) + bytes(suf_a) + bytes(lc_a) + blob
    Path(dst).write_bytes(out)
    info = {k: meta[k] for k in ("fonte", "url", "municipio", "linhas_csv", "descartadas", "registros", "logradouros", "sha256_zip", "aviso")}
    info["bytes"] = len(out)
    info["sha256_bin"] = hashlib.sha256(out).hexdigest()
    Path(dst).with_suffix(".json").write_text(json.dumps(info, ensure_ascii=False, indent=1), encoding="utf-8")
    print(json.dumps(info, ensure_ascii=False, indent=1))


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
