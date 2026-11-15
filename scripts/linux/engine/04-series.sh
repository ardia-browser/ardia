#!/usr/bin/env bash
# Step 4 (Linux): our series on the tree scripts/linux/engine/03-helium.py left: the series base (series.py
# capture-base), then series_linux.py apply: every `chromium` line of engine/patches/series minus series-linux's
# skips, then series-linux's own patches; the layers (chrome/browser/ardia built for Linux, and the tree's ardia/:
# //ardia/core's portable files, //ardia/win's shared ones, scripts/linux/engine/src/ardia); the hooks linux-hooks
# names. Then the offline game. The table of results goes to $CB/logs/series-linux.tsv. Fails when a patch does not
# apply, after trying every one.
# Usage: scripts/linux/engine/04-series.sh --apply | --help (takes the Linux chromium lock itself)
set -euo pipefail
source "$(dirname "$0")/env.sh"
source "$AC_LINUX_BUILD_DIR/step-guard.sh" "$@"
export CHROMIUM_SRC="$CB/chromium_git/chromium/src" AC_SERIES_BASE="$CB/series-base"
python3 "$AC_REPO/engine/patches/series.py" capture-base
status=0
python3 "$AC_LINUX_BUILD_DIR/series_linux.py" apply --report "$CB/logs/series-linux.tsv" || status=$?
"$AC_MAC_BUILD_DIR/game-resource.sh" --apply
exit "$status"
