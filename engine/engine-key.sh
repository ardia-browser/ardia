#!/usr/bin/env bash
# The engine's identity on one platform: one hash of every file that platform's engine is built from. Prebuilt engines
# are published and looked up under it (packages/ardiacore/prebuilt-engines.tsv for macOS,
# packages/ardiacore/prebuilt-engines-linux.tsv for Linux).
#
#   engine/engine-key.sh [--platform macos|linux] [<commit>]   the key of <commit> or tree (default HEAD); fails if it
#                                                              lacks engine/ or the offline game
#   engine/engine-key.sh [--platform macos|linux] --paths      git pathspecs covering the key's inputs in this checkout,
#                                                              one per line, for git status and git rev-list
#
# A key covers engine/, apps/browser/assets/offline-game and its pipeline, minus what the platform never builds:
#   - the lines engine/patches/series marks for the other platform, read by engine/patches/series.py's own parser, with
#     their patches and layers. The series counts as the lines that apply, so a line for the other platform changes
#     neither key of this one;
#   - the translation units a BUILD.gn under engine/ lists only inside `if (is_mac)` or `if (is_linux)` for the other
#     platform;
#   - engine/engine-key.* and engine/patches/build/tests, tooling the build never reads.
# The files a layer of this platform copies in (its copies.tsv, source and target per line) count even when they live in
# the other platform's layer or outside engine/. --platform defaults to AC_TARGET_OS (mac or linux), else this OS.
set -euo pipefail

for arg in "$@"; do
  case "$arg" in -h | --help) awk 'NR == 1 { next } /^#/ { sub(/^# ?/, ""); print; next } { exit }' "$0"; exit 0 ;; esac
done
command -v python3 >/dev/null || { echo "engine-key: python3 is required" >&2; exit 1; }
exec python3 -I "$(cd "$(dirname "$0")" && pwd -P)/engine-key.py" "$@"
