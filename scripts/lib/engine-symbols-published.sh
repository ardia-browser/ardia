#!/usr/bin/env bash
# Checks that an engine release on GitHub can name the crashes of a framework: the release carries a non-empty
# ArdiaCore-<key:12>-symbols.tar.xz and ArdiaCore-<key:12>-uuids.txt, the uuids file names a DWARF file for every
# architecture's UUID of the framework's Chromium Framework binary, and that file in the archive is a dSYM with the
# same UUID and the build's full symbol table (over 100,000 function names, text symbols only; the stripped framework
# has a few thousand).
# scripts/publish-engine.sh runs it after its upload and the Release workflow before it builds, so neither an engine
# nor an app ships with crashes nobody can symbolicate.
#
#   scripts/lib/engine-symbols-published.sh <engine-<key:12>> <Chromium Framework.framework>
#   scripts/lib/engine-symbols-published.sh -h | --help
set -euo pipefail

root="$(cd "$(dirname "$0")/../.." && pwd -P)"
. "$root/scripts/lib/releases.sh"
die() { echo "error: $*" >&2; exit 1; }
case "${1:-}" in
  -h | --help) awk 'NR == 1 { next } /^#/ { sub(/^# ?/, ""); print; next } { exit }' "$0"; exit 0 ;;
esac
[ $# -eq 2 ] || die "usage: scripts/lib/engine-symbols-published.sh <engine-<key:12>> <Chromium Framework.framework> (--help)"
tag="$1" framework="$2"
[[ "$tag" == engine-* ]] || die "$tag isn't an engine release tag (engine-<key:12>)"
binary="$framework/Versions/Current/Chromium Framework"
[ -f "$binary" ] || die "no Chromium Framework at $framework"

symbols="$(engine_symbols_name "$tag")"
uuids="$(engine_uuids_name "$tag")"
listing="$(gh release view "$tag" -R "$REPO" --json assets --jq '.assets[] | [.name, .size] | @tsv')" \
  || die "couldn't read the release $tag: is gh signed in, and is it published?"
asset_size() { awk -F '\t' -v n="$1" '$1 == n { print $2; exit }' <<<"$listing"; }
for name in "$symbols" "$uuids"; do
  size="$(asset_size "$name")"
  [ -n "$size" ] || die "$tag has no $name, so crashes in its engine can't be symbolicated: publish it with scripts/publish-engine.sh (docs/releasing.md backfills one)"
  [ "$size" -gt 0 ] || die "$tag's $name is empty"
done

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
gh release download "$tag" -R "$REPO" -p "$uuids" -D "$work" >/dev/null || die "couldn't download $uuids from $tag"
images="$(dwarfdump --uuid "$binary" | awk '/^UUID: / { gsub(/[()]/, "", $3); print tolower($2) "\t" $3 }')"
[ -n "$images" ] || die "dwarfdump found no UUID in $binary"
min_symbols=100000
rows=()
while IFS=$'\t' read -r uuid arch; do
  rel="$(awk -F '\t' -v u="$uuid" -v a="$arch" '$1 == u && $2 == a { print $3; exit }' "$work/$uuids")"
  [ -n "$rel" ] || die "$tag's $uuids doesn't list Chromium Framework $uuid ($arch) with a DWARF file: the symbols published there are from another build"
  [[ "$rel" == *.dSYM/Contents/Resources/DWARF/* && "$rel" != /* && "$rel" != *..* ]] || die "$tag's $uuids names $rel for $uuid ($arch), which isn't a DWARF file inside a dSYM"
  rows+=("$uuid"$'\t'"$arch"$'\t'"$rel")
done <<<"$images"
gh release download "$tag" -R "$REPO" -p "$symbols" -D "$work" >/dev/null || die "couldn't download $symbols from $tag"
mkdir "$work/symbols"
for row in "${rows[@]}"; do
  IFS=$'\t' read -r uuid arch rel <<<"$row"
  tar -xJf "$work/$symbols" -C "$work/symbols" "$rel" 2>/dev/null || die "$tag's $symbols has no $rel"
  found="$(dwarfdump --uuid "$work/symbols/$rel" | awk -v a="($arch)" '/^UUID: / && $3 == a { print tolower($2); exit }')"
  [ "$found" = "$uuid" ] || die "$rel in $tag's $symbols has UUID ${found:-none} for $arch, not $uuid"
  kind="$(otool -hv -arch "$arch" "$work/symbols/$rel" | awk 'END { print $5 }')"
  [ "$kind" = DSYM ] || die "$rel in $tag's $symbols is a ${kind:-unreadable} file, not a dSYM: a stripped binary names no frames"
  named="$( (nm -arch "$arch" "$work/symbols/$rel" 2>/dev/null || true) | awk -v m="$min_symbols" '$2 == "t" || $2 == "T" { n++ } n > m { print "yes"; exit }')"
  [ "$named" = yes ] || die "$rel in $tag's $symbols names $min_symbols functions or fewer: it isn't the build's full symbol table"
  echo "$tag names Chromium Framework $uuid ($arch) with $rel"
done
