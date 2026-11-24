#!/usr/bin/env bash
# The engine's identity on one platform: one hash of every file that platform's engine is built from. Prebuilt engines
# are published and looked up under it (packages/ardiacore/prebuilt-engines.tsv for macOS,
# packages/ardiacore/prebuilt-engines-linux.tsv for Linux, the `key` of scripts/windows/engine/prebuilt.json for Windows).
#
#   engine/engine-key.sh [--platform macos|linux|win] [<commit>]   the key of <commit> or tree (default HEAD); fails if
#                                                                  it lacks engine/ or the offline game
#   engine/engine-key.sh [--platform macos|linux|win] --paths      git pathspecs covering the key's inputs in this
#                                                                  checkout, one per line, for git status and rev-list
#
# A macOS or Linux key covers engine/, apps/browser/assets/offline-game and its pipeline, minus what the platform never
# builds:
#   - the lines engine/patches/series marks only for other platforms, with their patches and layers. A selector is `all`
#     or platforms joined by commas (`linux`, `win`, `linux,win`); each set is reduced to what it means for the platform
#     keyed and the series is then read by engine/patches/series.py's own parser. The series counts as the lines that
#     apply, so a line for other platforms changes no key of this one;
#   - the translation units a BUILD.gn under engine/ lists only inside blocks this platform never builds: conditions on
#     is_mac, is_linux and is_win joined by !, && and || are read as the platforms they can hold on (`if (is_linux ||
#     is_win)` and `if (!is_mac)` leave the macOS key), any other name can hold anywhere, and an else block counts as the
#     block around it. A source named by interpolation (`"${prefix}.cc"`, `"${stem}c"`, `"$unit"`) could be any unit
#     unless what follows its last interpolation ends in an extension no unit has (`.h`, `.inc`), so it keeps every
#     unit in the keys of the platforms its block holds on, and a BUILD.gn whose conditions can't be scanned
#     counts every unit it names for every platform;
#   - engine/engine-key.* and engine/patches/build/tests, tooling the build never reads.
# The files a layer of this platform copies in (its copies.tsv, source and target per line) count even when they live in
# the other platform's layer or outside engine/.
#
# A Windows key (win, or windows) covers what scripts/windows/engine/key-inputs.json declares the Windows build reads, read
# as data from the commit keyed (--paths: from the working tree), never run: the patches it applies, in order
# (engine/patches/series' lines for every platform or naming mac or win, less series-win's skips, then series-win's
# own; a series layer Windows would select, untagged or naming win, has no key until the Windows build runs series
# layers, engine/chromium aside, which it copies itself), its trees
# (engine/chromium/src, engine/patches/build, the offline game, scripts/windows/engine less its checks, tests and
# prebuilt.json), its files (series.py, the ArdiaCore headers and launch switches it copies, the app's EngineApi.h) and
# the resource lists, required and never excluded, with the sources they name. A commit without key-inputs.json is
# keyed with engine/engine-key.win-v1.json, the first declaration, which keys main from 991f98e9e on. A symlinked input
# has no key.
#
# --platform defaults to AC_TARGET_OS (mac or linux), else this OS; the Windows build sets AC_TARGET_OS=mac for the Mac
# steps it reuses, so a Windows key always needs --platform win.
set -euo pipefail

for arg in "$@"; do
  case "$arg" in -h | --help) awk 'NR == 1 { next } /^#/ { sub(/^# ?/, ""); print; next } { exit }' "$0"; exit 0 ;; esac
done
command -v python3 >/dev/null || { echo "engine-key: python3 is required" >&2; exit 1; }
exec python3 -I -B "$(cd "$(dirname "$0")" && pwd -P)/engine-key.py" "$@"
