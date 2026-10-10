"""Testa só o PARSER com trechos de exemplo no formato do Android (valores inventados para o teste; NÃO são medições)."""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from parse_adb import crashes, janky, total_pss_kb  # noqa: E402


def test_pss_new_and_old_format():
    assert total_pss_kb("           TOTAL PSS:   180224            TOTAL RSS:   300000") == 180224
    assert total_pss_kb("      TOTAL   123456    100000     2000     0   200000   190000   10000   5000") == 123456
    assert total_pss_kb("sem dados") is None


def test_gfxinfo():
    t = "Total frames rendered: 1200\nJanky frames: 96 (8.00%)\n90th percentile: 17ms\n99th percentile: 48ms\n"
    assert janky(t) == {"frames": 1200, "janky": 96, "janky_pct": 8.0, "p90_ms": 17, "p99_ms": 48}
    assert janky("")["frames"] is None


def test_crashes():
    log = "E/AndroidRuntime: FATAL EXCEPTION: main\nE/ActivityManager: ANR in br.santos.rota (br.santos.rota/.MainActivity)\n"
    assert crashes(log) == {"anr": 1, "fatal": 1, "oom": 0}
