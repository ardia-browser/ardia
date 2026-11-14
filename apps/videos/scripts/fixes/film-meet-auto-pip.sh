#!/bin/bash
set -uo pipefail
REPO=$(cd "$(dirname "$0")/../../../.." && pwd)
export FIXES_SCRATCH=${FIXES_SCRATCH:-/tmp/meetpip-film}
S=$FIXES_SCRATCH
BEFORE_SRC=${BEFORE_SRC:-/Applications/Ardia.app}
AFTER_SRC=${AFTER_SRC:-/tmp/meetpip/film/Ardia-after.app}
mkdir -p "$S/before" "$S/after"
cat >"$S/film.entitlements" <<'EOF'
<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>com.apple.security.cs.disable-library-validation</key><true/><key>com.apple.security.cs.allow-dyld-environment-variables</key><true/></dict></plist>
EOF
for side in before after; do
  src=$([ "$side" = before ] && echo "$BEFORE_SRC" || echo "$AFTER_SRC")
  if [ ! -d "$S/$side/Ardia.app" ]; then
    ditto "$src" "$S/$side/Ardia.app"
    codesign -f -s - --options runtime --entitlements "$S/film.entitlements" "$S/$side/Ardia.app" >/dev/null 2>&1
  fi
done
node "$REPO/apps/videos/scripts/fixes/sessions-meet-auto-pip.mjs" "$S"
export FIXES_SITES_PORT=${FIXES_SITES_PORT:-47251} FIXES_CALL_PORT=${FIXES_CALL_PORT:-47252}
if ! lsof -nP -iTCP:"$FIXES_SITES_PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  node "$REPO/apps/videos/scripts/capture/sites/serve.mjs" "$FIXES_SITES_PORT" >"$S/serve.log" 2>&1 &
  SITES=$!
  trap 'kill $SITES 2>/dev/null' EXIT
fi
export BEFORE_APP=$S/before/Ardia.app AFTER_APP=$S/after/Ardia.app
export FIXES_HOVER=1 FIXES_INPUT=1 FIXES_SERIAL=1 FIXES_PORT_BASE=${FIXES_PORT_BASE:-9681}
node "$REPO/apps/videos/scripts/fixes/run.mjs" meetpip "$@"
