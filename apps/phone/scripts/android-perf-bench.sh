#!/usr/bin/env bash
# Runs the Android cold-launch, interactive UI/scroll, meminfo, and Perfetto heap benchmark.
#
#   apps/phone/scripts/android-perf-bench.sh <label> [--device SERIAL] [--package PKG] [--out DIR] [--skip-cold]
#
# Requires Android CLI (`android profiler`), `adb`, and `agent-device` (or `AGENT_DEVICE` env var).
set -euo pipefail

if [ $# -lt 1 ] || [ "$1" = "--help" ] || [ "$1" = "-h" ]; then
  sed -n '2,6p' "$0" | sed 's/^# \{0,1\}//'
  [ $# -ge 1 ] && exit 0 || exit 64
fi

LABEL="$1"
shift
DEVICE="${ANDROID_SERIAL:-}"
PKG="com.ardia.browser.android.dev"
OUT="/tmp/ardia-perf"
SKIP_COLD=0

while [ $# -gt 0 ]; do
  case "$1" in
    --device) DEVICE="$2"; shift ;;
    --package) PKG="$2"; shift ;;
    --out) OUT="$2"; shift ;;
    --skip-cold) SKIP_COLD=1 ;;
    *) echo "unknown option: $1" >&2; exit 64 ;;
  esac
  shift
done

if [ -z "$DEVICE" ]; then
  DEVICE="$(adb devices | awk 'NR>1 && $2=="device" {print $1; exit}')"
fi
[ -n "$DEVICE" ] || { echo "no connected Android device found" >&2; exit 1; }
AD="${AGENT_DEVICE:-agent-device}"
mkdir -p "$OUT"

if [ "$SKIP_COLD" = "0" ]; then
  adb -s "$DEVICE" shell am force-stop "$PKG"
  sleep 2
  android profiler systemtrace start \
    --device="$DEVICE" \
    --package="$PKG" \
    --preset=graphics \
    --enable=cpu \
    --duration=8 \
    --launch \
    --wait \
    --output="$OUT/${LABEL}_cold.perfetto-trace"
  sleep 3
  "$AD" back >/dev/null || true
  sleep 0.5
  "$AD" back >/dev/null || true
  sleep 1
fi

COORDS="$("$AD" snapshot -i --json | python3 -c '
import json, sys
d = json.load(sys.stdin)
res = {}
for n in d.get("data", d).get("nodes", []):
    lbl = n.get("label") or ""
    r = n.get("rect") or {}
    if not r:
        continue
    cx = int(r["x"] + r["width"] / 2)
    cy = int(r["y"] + r["height"] / 2)
    if lbl.startswith("Tabs,"):
        res["TABS"] = f"{cx} {cy}"
    elif lbl.startswith("Address,"):
        res["ADDR"] = f"{cx} {cy}"
    elif lbl == "Page Menu":
        res["MENU"] = f"{cx} {cy}"
for k in ("TABS", "ADDR", "MENU"):
    print(f"{k}=\"{res.get(k, \"\")}\"")
')"
eval "$COORDS"
if [ -z "$TABS" ] || [ -z "$ADDR" ] || [ -z "$MENU" ]; then
  echo "missing bottom bar buttons on screen (open an active tab first)" >&2
  exit 1
fi

SESSION="ardia_${LABEL}"
android profiler systemtrace start \
  --device="$DEVICE" \
  --package="$PKG" \
  --preset=graphics \
  --enable=cpu \
  --session="$SESSION" \
  --output="$OUT/${LABEL}_ui.perfetto-trace"

sleep 0.5
"$AD" swipe 540 1650 540 650 --count 6 --pause-ms 280 --pattern ping-pong --no-post-gesture-stabilization >/dev/null
sleep 0.4
"$AD" press $MENU >/dev/null
sleep 0.8
"$AD" press 540 350 >/dev/null
sleep 0.6
"$AD" press $TABS >/dev/null
sleep 0.7
"$AD" swipe 540 1600 540 700 --count 4 --pause-ms 280 --pattern ping-pong --no-post-gesture-stabilization >/dev/null
sleep 0.4
"$AD" press 540 1100 >/dev/null
sleep 0.7
"$AD" press $ADDR >/dev/null
sleep 0.8
"$AD" back >/dev/null
sleep 0.4
"$AD" back >/dev/null
sleep 0.6
"$AD" swipe 540 1650 540 650 --count 4 --pause-ms 280 --pattern ping-pong --no-post-gesture-stabilization >/dev/null
sleep 0.5

android profiler systemtrace stop --device="$DEVICE" --session="$SESSION"

adb -s "$DEVICE" shell dumpsys meminfo "$PKG" > "$OUT/${LABEL}_meminfo.txt"
android profiler heapdump capture \
  --device="$DEVICE" \
  --process="$PKG" \
  --type=perfetto \
  --output="$OUT/${LABEL}.perfetto-java-heap-dump"
