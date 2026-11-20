#!/bin/bash
set -euo pipefail
REPO=$(cd "$(dirname "$0")/../../../.." && pwd)
S=${FIXES_SCRATCH:-$HOME/ardia-scratch/film-n6/film}
PORT=${FIXES_SITES_PORT:-47311}
mkdir -p "$S"
cat >"$S/film.entitlements" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>com.apple.security.cs.disable-library-validation</key><true/><key>com.apple.security.cs.allow-dyld-environment-variables</key><true/></dict></plist>
PLIST
for side in before after; do
  src=$([ "$side" = before ] && echo "${BEFORE_SRC:-}" || echo "${AFTER_SRC:-}")
  if [ ! -d "$S/$side/Ardia.app" ] && [ -n "$src" ]; then
    mkdir -p "$S/$side"
    ditto "$src" "$S/$side/Ardia.app"
    codesign -f -s - --options runtime --entitlements "$S/film.entitlements" "$S/$side/Ardia.app" >/dev/null 2>&1
  fi
done
node "$REPO/apps/videos/scripts/fixes/sessions-0247n6.mjs" "$S"
if ! lsof -nP -iTCP:$PORT -sTCP:LISTEN >/dev/null 2>&1; then
  nohup node "$REPO/apps/videos/scripts/fixes/scenes/_47n3sites.mjs" "$PORT" >"$S/sites.log" 2>&1 &
  echo $! >"$S/sites.pid"
fi
echo "ready in $S"
