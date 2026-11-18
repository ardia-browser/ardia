#!/bin/bash
set -euo pipefail
REPO=$(cd "$(dirname "$0")/../../../.." && pwd)
S=${FIXES_SCRATCH:-$HOME/ardia-scratch/uiux-film/film}
PORT=${FIXES_SITES_PORT:-47273}
mkdir -p "$S"
node "$REPO/apps/videos/scripts/fixes/sessions-0247n3.mjs" "$S"
if ! lsof -nP -iTCP:$PORT -sTCP:LISTEN >/dev/null 2>&1; then
  nohup node "$REPO/apps/videos/scripts/fixes/scenes/_47n3sites.mjs" "$PORT" >"$S/sites.log" 2>&1 &
  echo $! >"$S/sites.pid"
fi
echo "ready in $S"
