"""Converte as saídas brutas do ADB em um JSON de medição. Só extrai o que está nas saídas; o que não achar vira null."""
from __future__ import annotations

import argparse
import hashlib
import json
import re
import statistics
from datetime import datetime, timezone
from pathlib import Path


def total_pss_kb(text: str) -> int | None:
    # "TOTAL PSS:   123456" (Android recente) ou linha "TOTAL   123456   ..." (formato antigo)
    m = re.search(r"TOTAL PSS:\s+(\d+)", text) or re.search(r"^\s*TOTAL\s+(\d+)\s", text, re.M)
    return int(m.group(1)) if m else None


def janky(text: str) -> dict:
    total = re.search(r"Total frames rendered:\s*(\d+)", text)
    jk = re.search(r"Janky frames:\s*(\d+)\s*\(([\d.]+)%\)", text)
    p90 = re.search(r"90th percentile:\s*(\d+)ms", text)
    p99 = re.search(r"99th percentile:\s*(\d+)ms", text)
    return {"frames": int(total.group(1)) if total else None, "janky": int(jk.group(1)) if jk else None,
            "janky_pct": float(jk.group(2)) if jk else None, "p90_ms": int(p90.group(1)) if p90 else None,
            "p99_ms": int(p99.group(1)) if p99 else None}


def crashes(logcat: str) -> dict:
    return {"anr": len(re.findall(r"ANR in br\.santos\.rota", logcat)),
            "fatal": len(re.findall(r"FATAL EXCEPTION", logcat)),
            "oom": len(re.findall(r"OutOfMemory|lowmemorykiller.*br\.santos\.rota", logcat))}


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--model"); ap.add_argument("--android"); ap.add_argument("--sdk"); ap.add_argument("--ram-kb")
    ap.add_argument("--webview", default=""); ap.add_argument("--apk")
    ap.add_argument("--cold", nargs="+", default=[])
    ap.add_argument("--meminfo"); ap.add_argument("--meminfo-after"); ap.add_argument("--gfxinfo"); ap.add_argument("--logcat")
    ap.add_argument("--out", required=True)
    a = ap.parse_args()
    cold = [int(x) for x in a.cold if x.strip().isdigit()]
    read = lambda p: Path(p).read_text(errors="replace") if p and Path(p).exists() else ""  # noqa: E731
    apk = Path(a.apk)
    out = {
        "medido_em": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "aparelho": {"modelo": a.model, "android": a.android, "sdk": a.sdk, "ram_kb": int(a.ram_kb) if a.ram_kb and a.ram_kb.isdigit() else None,
                     "webview": a.webview.strip()},
        "apk": {"arquivo": apk.name, "sha256": hashlib.sha256(apk.read_bytes()).hexdigest() if apk.exists() else None},
        "partida_a_frio_ms": {"amostras": cold, "mediana": statistics.median(cold) if cold else None, "max": max(cold) if cold else None},
        "memoria_pss_kb": {"ocioso": total_pss_kb(read(a.meminfo)), "apos_uso": total_pss_kb(read(a.meminfo_after))},
        "quadros": janky(read(a.gfxinfo)),
        "falhas": crashes(read(a.logcat)),
        "nota": "Valores lidos do aparelho via ADB. Bateria/autonomia exigem teste longo: ver o .battery bruto e docs/TESTE_FISICO_ANDROID.md.",
    }
    Path(a.out).write_text(json.dumps(out, ensure_ascii=False, indent=1))


if __name__ == "__main__":
    main()
