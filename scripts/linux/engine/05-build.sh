#!/usr/bin/env bash
# Step 5 (Linux): compile out/Release_GN_linux_$LINUX_CPU (default x64). TARGETS defaults to chrome and chrome_sandbox (the
# setuid sandbox the .deb installs). JOBS sets siso's
# local jobs, compiles and links alike (default 16). Blink's bindings generators run first, at BINDINGS_JOBS (default
# 4): each runs a worker per core. KEEP_GOING is -k (0: keep going past failures). The output is also appended to LOG
# (default $CB/logs/05-build.log), so a background run can be followed with tail. After a build it writes
# ardia.build.json beside the binary: the app's version and build, from apps/browser/linux/scripts/version.mjs.
# Usage: scripts/linux/engine/05-build.sh --apply | --help (takes the Linux chromium lock itself)
set -euo pipefail
source "$(dirname "$0")/env.sh"
source "$AC_LINUX_BUILD_DIR/step-guard.sh" "$@"
log="${LOG:-$CB/logs/05-build.log}"
exec > >(tee -a "$log") 2>&1
echo "== 05-build.sh $(date -Is) TARGETS=${TARGETS:-chrome chrome_sandbox} JOBS=${JOBS:-16}"
CHROMIUM_SRC="$CB/chromium_git/chromium/src" "$AC_MAC_BUILD_DIR/game-resource.sh" --apply
cd "$CB/chromium_git/chromium/src"
TARGETS="${TARGETS:-chrome chrome_sandbox}"
if [[ " $TARGETS " == *" chrome "* ]]; then
  autoninja -j "${BINDINGS_JOBS:-4}" -k "${KEEP_GOING:-0}" -C "out/$GN_OUT_CONFIGS" \
    phony/third_party/blink/renderer/bindings/generate_bindings_all < /dev/null
fi
autoninja -j "${JOBS:-16}" -k "${KEEP_GOING:-0}" -C "out/$GN_OUT_CONFIGS" $TARGETS < /dev/null
node --input-type=module -e '
import { writeFileSync, renameSync } from "node:fs";
const { appVersion, appBuild } = await import(process.argv[1]);
writeFileSync(process.argv[2] + ".tmp", JSON.stringify({ version: appVersion, build: String(appBuild) }) + "\n");
renameSync(process.argv[2] + ".tmp", process.argv[2]);
' "$AC_REPO/apps/browser/linux/scripts/version.mjs" "out/$GN_OUT_CONFIGS/ardia.build.json"
cat "out/$GN_OUT_CONFIGS/ardia.build.json"
