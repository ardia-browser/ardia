#!/usr/bin/env bash
# Runs the Mac's leak check (engine/patches/build/helium-check-build.py, read only) on out/Release_GN_linux_$LINUX_CPU:
# it fails if Helium's uBlock Origin, its onboarding page or the non-free search data were built or packed, or if the
# binary or a pak names a Helium host. The check reads a Mac framework's layout, so it gets a scratch view of one:
# Versions/Current/Chromium Framework is the linked chrome, Resources/ holds the out dir's paks and locales/*.pak.
# Usage: scripts/linux/engine/check-build.sh
set -euo pipefail
source "$(dirname "$0")/env.sh"
case "${1:-}" in -h | --help) awk 'NR == 1 { next } /^#/ { sub(/^# ?/, ""); print; next } { exit }' "$0"; exit 0 ;; esac
out="$CB/chromium_git/chromium/src/out/$GN_OUT_CONFIGS"
[[ -x "$out/chrome" ]] || { echo "check-build.sh: build chrome in $out first" >&2; exit 1; }
view=$(mktemp -d)
trap 'rm -rf "$view"' EXIT
framework="$view/Chromium Framework.framework"
mkdir -p "$framework/Versions/Current/Resources"
ln -s "$out/chrome" "$framework/Versions/Current/Chromium Framework"
for pak in "$out"/*.pak; do ln -s "$pak" "$framework/Versions/Current/Resources/"; done
for pak in "$out"/locales/*.pak; do
  mkdir -p "$framework/Versions/Current/Resources/$(basename "$pak" .pak).lproj"
  ln -s "$pak" "$framework/Versions/Current/Resources/$(basename "$pak" .pak).lproj/locale.pak"
done
python3 "$AC_MAC_BUILD_DIR/helium-check-build.py" --out "$out" --framework "$framework"
