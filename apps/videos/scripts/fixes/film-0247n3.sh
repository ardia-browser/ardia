#!/bin/bash
set -uo pipefail
REPO=$(cd "$(dirname "$0")/../../../.." && pwd)
export FIXES_SCRATCH=${FIXES_SCRATCH:-$HOME/ardia-scratch/uiux-film/film}
export BEFORE_APP=${BEFORE_APP:-$FIXES_SCRATCH/before/Ardia.app}
export AFTER_APP=${AFTER_APP:-$FIXES_SCRATCH/after/Ardia.app}
export AFTER_JS=${AFTER_JS:-none}
export FIXES_HOVER=1 FIXES_INPUT=1 FIXES_SELFREC=1 FIXES_PASTEBOARD=1 FIXES_SERIAL=1 FIXES_FPS=${FIXES_FPS:-60} FIXES_SITES_PORT=${FIXES_SITES_PORT:-47273} FIXES_PORT_BASE=${FIXES_PORT_BASE:-9781}
exec node "$REPO/apps/videos/scripts/fixes/run.mjs" "$@"
