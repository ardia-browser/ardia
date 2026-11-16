#!/bin/bash
set -uo pipefail
REPO=$(cd "$(dirname "$0")/../../../.." && pwd)
export FIXES_SCRATCH=${FIXES_SCRATCH:-$HOME/ardia-scratch/atc-film}
S=$FIXES_SCRATCH
BEFORE_SRC=${BEFORE_SRC:-$S/dl/Netnyahoo.app}
AFTER_SRC=${AFTER_SRC:-$REPO/apps/browser/build-extorderfilm/Build/Products/Debug/Ardia.app}
mkdir -p "$S/before" "$S/after"
cat >"$S/film.entitlements" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>com.apple.security.cs.disable-library-validation</key><true/><key>com.apple.security.cs.allow-dyld-environment-variables</key><true/></dict></plist>
PLIST
if [ ! -d "$BEFORE_SRC" ]; then
  mkdir -p "$S/dl"
  gh release download v0.2.47-nightly.2 -R ardia-browser/ardia -p 'Ardia-0.2.47-nightly.2.zip' -D "$S/dl" --clobber
  ditto -x -k "$S/dl/Ardia-0.2.47-nightly.2.zip" "$S/dl"
fi
for side in before after; do
  src=$([ "$side" = before ] && echo "$BEFORE_SRC" || echo "$AFTER_SRC")
  if [ ! -d "$S/$side/Ardia.app" ]; then
    ditto "$src" "$S/$side/Ardia.app"
    codesign -f -s - --options runtime --entitlements "$S/film.entitlements" "$S/$side/Ardia.app" >/dev/null 2>&1
  fi
done
node "$REPO/apps/videos/scripts/fixes/sessions-atc-pattern.mjs" "$S"
export FIXES_SITES_PORT=${FIXES_SITES_PORT:-47297}
if ! lsof -nP -iTCP:"$FIXES_SITES_PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  node "$REPO/apps/videos/scripts/capture/sites/serve.mjs" "$FIXES_SITES_PORT" >"$S/serve.log" 2>&1 &
  SITES=$!
  trap 'kill $SITES 2>/dev/null' EXIT
fi
export BEFORE_APP=$S/before/Ardia.app AFTER_APP=$S/after/Ardia.app
export FIXES_INPUT=1 FIXES_SELFREC=1 FIXES_SERIAL=1 FIXES_PORT_BASE=${FIXES_PORT_BASE:-9895}
node "$REPO/apps/videos/scripts/fixes/run.mjs" atcpattern "$@"
