#!/usr/bin/env bash
# Medição REAL em aparelho Android (ADB). NÃO foi executado nesta auditoria (não havia aparelho).
# Uso:  scripts/adb/bench_device.sh rota-santos-1.1.0-DEBUG.apk [serial]
# Saída: device-results/<modelo>-<data>.json  (cada número é lido do aparelho; nada é estimado)
set -euo pipefail
APK="${1:?informe o caminho do APK}"
SERIAL="${2:-}"
PKG="br.santos.rota"
ADB=(adb ${SERIAL:+-s "$SERIAL"})
OUT_DIR="$(dirname "$0")/../../device-results"
mkdir -p "$OUT_DIR"

"${ADB[@]}" get-state >/dev/null || { echo "Nenhum aparelho autorizado (adb devices)."; exit 1; }
MODEL="$("${ADB[@]}" shell getprop ro.product.model | tr -d '\r' | tr ' ' '_')"
ANDROID="$("${ADB[@]}" shell getprop ro.build.version.release | tr -d '\r')"
SDK="$("${ADB[@]}" shell getprop ro.build.version.sdk | tr -d '\r')"
RAM_KB="$("${ADB[@]}" shell grep MemTotal /proc/meminfo | tr -d '\r' | awk '{print $2}')"
WEBVIEW="$("${ADB[@]}" shell dumpsys webviewupdate | tr -d '\r' | grep -m1 -i 'Current WebView package' || true)"
STAMP="$(date +%Y%m%d-%H%M%S)"
RAW="$OUT_DIR/$MODEL-$STAMP.raw"
: > "$RAW"

echo "== instalando $APK em $MODEL (Android $ANDROID)"
"${ADB[@]}" install -r "$APK" >/dev/null
"${ADB[@]}" shell pm clear "$PKG" >/dev/null
"${ADB[@]}" shell dumpsys batterystats --reset >/dev/null || true
"${ADB[@]}" logcat -c

cold=()
for i in 1 2 3 4 5; do
  "${ADB[@]}" shell am force-stop "$PKG"
  sleep 2
  out="$("${ADB[@]}" shell am start -W -n "$PKG/.MainActivity" | tr -d '\r')"
  echo "--- partida a frio $i" >> "$RAW"; echo "$out" >> "$RAW"
  cold+=("$(echo "$out" | awk '/TotalTime:/ {print $2}')")
  sleep 4
done

# memória com o app aberto e ocioso
"${ADB[@]}" shell dumpsys meminfo "$PKG" | tr -d '\r' > "$RAW.meminfo"
# quadros: reinicia contadores, o operador usa o app (rolar lista/mapa) e roda de novo com --gfx
"${ADB[@]}" shell dumpsys gfxinfo "$PKG" reset >/dev/null || true

cat <<MSG

>> Agora, no aparelho: importe o CSV de 300 cartas (ver docs/TESTE_FISICO_ANDROID.md), calcule a rota,
   role a lista e o mapa por ~30 s. Depois pressione ENTER aqui para coletar quadros/ANR/memória.
MSG
read -r _
"${ADB[@]}" shell dumpsys gfxinfo "$PKG" | tr -d '\r' > "$RAW.gfxinfo"
"${ADB[@]}" shell dumpsys meminfo "$PKG" | tr -d '\r' > "$RAW.meminfo.after"
"${ADB[@]}" shell dumpsys batterystats "$PKG" | tr -d '\r' > "$RAW.battery" || true
"${ADB[@]}" logcat -d -b crash,main -v time | tr -d '\r' > "$RAW.logcat"

python3 "$(dirname "$0")/parse_adb.py" \
  --model "$MODEL" --android "$ANDROID" --sdk "$SDK" --ram-kb "$RAM_KB" --webview "$WEBVIEW" --apk "$APK" \
  --cold "${cold[@]}" --meminfo "$RAW.meminfo" --meminfo-after "$RAW.meminfo.after" --gfxinfo "$RAW.gfxinfo" \
  --logcat "$RAW.logcat" --out "$OUT_DIR/$MODEL-$STAMP.json"
echo "Resultado: $OUT_DIR/$MODEL-$STAMP.json (brutos em $RAW*)"
