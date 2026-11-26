#!/usr/bin/env bash
set -euo pipefail
if [[ $# -lt 3 || $1 == -h || $1 == --help ]]; then
  echo "usage: scripts/mac/webui-engine/launch.sh <Ardia WebUI Dev.app> <data dir> <devtools port> [switches…]   hidden WebUI instance (ARDIA_WEBUI_BUNDLE picks the UI bundle); prints its pid" >&2
  exit 64
fi
app=$1 data=$2 port=$3
shift 3
if lsof -nP -iTCP:"$port" -sTCP:LISTEN -t >/dev/null 2>&1; then echo "port $port is already in use" >&2; exit 1; fi
mkdir -p "$data/Chromium"
envs=(--env ARDIA_DATA_DIR="$data" --env ARDIA_BACKGROUND=1 --env ARDIA_SHELL=webui --env ARDIA_WEBUI_HANDED_OFF=1)
[[ -n "${ARDIA_WEBUI_BUNDLE:-}" ]] && envs+=(--env ARDIA_WEBUI_BUNDLE="$ARDIA_WEBUI_BUNDLE")
open -g -n "${envs[@]}" "$app" --args --ardia-shell=webui --user-data-dir="$data/Chromium" --ardia-data-dir="$data" \
  --ardia-background --use-mock-keychain --remote-debugging-port="$port" --remote-allow-origins='*' --enable-logging --v=0 \
  --disable-backgrounding-occluded-windows --mute-audio --profile-directory=Default "$@"
for _ in $(seq 1 200); do
  pid=$(lsof -nP -iTCP:"$port" -sTCP:LISTEN -t 2>/dev/null | head -1 || true)
  [[ -n "$pid" ]] && { echo "$pid"; exit 0; }
  sleep 0.05
done
echo "no DevTools listener on $port" >&2
exit 1
