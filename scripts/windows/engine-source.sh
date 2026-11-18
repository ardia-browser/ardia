#!/usr/bin/env bash
set -euo pipefail

usage="usage: scripts/windows/engine-source.sh <commit> <version> <build> <out.tar.xz>  (packs the source of the Windows engine that <commit> pins, for Ardia <version> build <build>)"
case "${1:-}" in -h | --help) echo "$usage"; exit 0 ;; esac
commit_rev="${1:?$usage}"
version="${2:?$usage}"
build="${3:?$usage}"
out="${4:?$usage}"
root="$(cd "$(dirname "$0")/../.." && pwd -P)"
repo="ardia-browser/ardia"
die() { echo "error: $*" >&2; exit 1; }
case "$out" in *.tar.xz) ;; *) die "$out doesn't end in .tar.xz" ;; esac
[ ! -e "$out" ] || die "$out already exists"
commit="$(git -C "$root" rev-parse --verify "$commit_rev^{commit}")" || die "no commit $commit_rev in this checkout"
pins="$(git -C "$root" show "$commit:scripts/windows/engine/helium-pins.ini")" || die "$commit has no scripts/windows/engine/helium-pins.ini"
pin() { awk -v section="[$1]" -v key="$2" '$0 == section { inside = 1; next } /^\[/ { inside = 0 } inside && $1 == key { print $3; exit }' <<<"$pins"; }
chromium="$(pin chromium version)"
helium="$(pin helium-chromium tag)"
helium_windows="$(pin helium-windows tag)"
if [ -z "$chromium" ] || [ -z "$helium" ] || [ -z "$helium_windows" ]; then
  die "scripts/windows/engine/helium-pins.ini at $commit pins no Chromium and Helium versions"
fi

work="$(mktemp -d "${TMPDIR:-/tmp}/ardia-windows-source.XXXXXX")"
trap 'rm -rf "$work"' EXIT
name="$(basename "$out" .tar.xz)"
src="$work/$name"
mkdir -p "$src"
fetch() {
  curl -fsSL --retry 3 --max-time 600 "https://codeload.github.com/imputnet/$1/tar.gz/refs/tags/$2" -o "$src/$1-$2.tar.gz" \
    || die "couldn't download imputnet/$1 at $2"
}
fetch helium-chromium "$helium"
fetch helium-windows "$helium_windows"
cat >"$src/README.txt" <<EOF
The source of Ardia for Windows, build $build ($version), besides Ardia's own repository.

Ardia, with the engine's patches and build scripts:
  https://github.com/$repo/tree/$commit
  How to build the engine: docs/engine-build-windows.md there. How to build the app: docs/windows.md.

Chromium $chromium (BSD-3-Clause and others):
  https://chromium.googlesource.com/chromium/src/+/refs/tags/$chromium
  https://commondatastorage.googleapis.com/chromium-browser-official/chromium-$chromium.tar.xz

Helium (GPL-3.0), copies of github.com/imputnet's tags:
  helium-chromium-$helium.tar.gz   its patches, domain substitution and build utilities
  helium-windows-$helium_windows.tar.gz   its Windows patches
EOF
mkdir -p "$(dirname "$out")"
tar -C "$work" -cf - "$name" | xz -T0 -9 >"$out.partial"
mv "$out.partial" "$out"
echo "engine-source: $out is Chromium $chromium with helium-chromium $helium and helium-windows $helium_windows"
