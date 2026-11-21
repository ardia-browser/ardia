#!/usr/bin/env bash
set -euo pipefail

usage="usage: scripts/lib/pack-symbols.sh [--app] <Chromium Framework.framework | Ardia.app> <dSYM dir> <symbols archive> <uuids file>"
mode=framework
if [ "${1:-}" = "--app" ]; then
  mode=app
  shift
fi
bundle="${1:?$usage}"
dsyms="${2:?$usage}"
archive="${3:?$usage}"
uuids="${4:?$usage}"
die() { echo "error: $*" >&2; exit 1; }
asset_limit=$((2 * 1024 * 1024 * 1024))

if [ "$mode" = app ]; then
  imageroot="$(cd "$bundle" 2>/dev/null && pwd -P)" || die "no app at $bundle"
  required="Contents/MacOS/Ardia"
  label="Ardia"
  hint="pack the dSYMs of the archive that made this app"
  [ -f "$imageroot/$required" ] || die "$bundle holds no $required"
else
  imageroot="$(cd "$bundle/Versions/Current" 2>/dev/null && pwd -P)" || die "no framework at $bundle"
  required="Chromium Framework"
  label="Chromium Framework"
  hint="pack the dSYMs of the build that made this framework (is_official_build writes them beside it)"
  [ -f "$imageroot/$required" ] || die "$bundle holds no Chromium Framework"
fi
[ -d "$dsyms" ] || die "no dSYM folder at $dsyms"
dsyms="$(cd "$dsyms" && pwd -P)"
scratch="$(mktemp -d)"
trap 'rm -rf "$scratch" "$uuids.part"' EXIT

uuid_rows() { dwarfdump --uuid "$1" 2>/dev/null | awk '/^UUID: / { arch = $3; gsub(/[()]/, "", arch); print tolower($2) "\t" arch }'; }

(cd "$dsyms" && find . -path '*.dSYM/Contents/Resources/DWARF/*' -type f | sed 's|^\./||' | LC_ALL=C sort) >"$scratch/dwarf"
while IFS= read -r rel; do
  { uuid_rows "$dsyms/$rel" || true; } | awk -v rel="$rel" '{ print $0 "\t" rel }'
done <"$scratch/dwarf" >"$scratch/available"

if [ "$mode" = app ]; then
  echo "$required" >"$scratch/images"
else
  (cd "$imageroot" && find . -type f \( -perm -u+x -o -name '*.dylib' \) | sed 's|^\./||' | LC_ALL=C sort) >"$scratch/images"
fi
: >"$uuids.part"
unmatched=()
while IFS= read -r image; do
  rows="$(uuid_rows "$imageroot/$image" || true)"
  if [ -z "$rows" ]; then
    [ "$image" != "$required" ] || die "dwarfdump found no UUID in $imageroot/$image"
    continue
  fi
  while IFS=$'\t' read -r id arch; do
    dwarf="$(awk -F '\t' -v u="$id" -v a="$arch" '$1 == u && $2 == a { print $3; exit }' "$scratch/available")"
    if [ -n "$dwarf" ]; then
      printf '%s\t%s\t%s\n' "$id" "$arch" "$dwarf" >>"$uuids.part"
    elif [ "$image" = "$required" ]; then
      die "no dSYM in $dsyms holds $label's UUID $id ($arch): $hint"
    else
      unmatched+=("$image")
    fi
  done <<<"$rows"
done <"$scratch/images"

cut -f 3 "$uuids.part" | sed 's|\.dSYM/.*|.dSYM|' | LC_ALL=C sort -u >"$scratch/bundles"
(cd "$dsyms" && COPYFILE_DISABLE=1 tar -cf - -T "$scratch/bundles") | xz -T0 -9 >"$archive"
size="$(wc -c <"$archive" | tr -d ' ')"
[ "$size" -lt "$asset_limit" ] || die "$(basename "$archive") is $size bytes, over GitHub's 2 GiB limit for a release asset"
mv "$uuids.part" "$uuids"
echo "    $(wc -l <"$uuids" | tr -d ' ') images in $(wc -l <"$scratch/bundles" | tr -d ' ') dSYMs: $(basename "$archive") ($((size / 1048576)) MB), $(basename "$uuids")"
[ "${#unmatched[@]}" = 0 ] || echo "warning: no dSYM for ${unmatched[*]}: their frames stay unnamed" >&2
