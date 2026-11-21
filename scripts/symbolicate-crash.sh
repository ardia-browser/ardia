#!/usr/bin/env bash
# Names the frames of a native crash in Chromium Framework (or any other engine image): finds the engine release whose
# symbols hold the image's UUID, downloads them and runs atos on the offsets.
#
#   scripts/symbolicate-crash.sh [--tag <engine-tag>] [--cache <dir>] <image uuid> <offset>...
#   scripts/symbolicate-crash.sh -h | --help
#
# The UUID and the offsets are what the crash records for the image: "Chromium Framework + 0x2e2334" is the offset
# 0x2e2334, and a leading + is accepted. scripts/publish-engine.sh uploads ArdiaCore-<tree:12>-uuids.txt (one
# "<uuid> <arch> <DWARF file>" row per image) and ArdiaCore-<tree:12>-symbols.tar.xz (the build's dSYMs) to each
# engine-<tree:12> prerelease; every release is searched newest first, or --tag names one. Each run downloads into its
# own folder and moves only the image it checked into --cache (default dist/engine-symbols), so runs can share a
# cache. Prints "<offset> <frame>" per offset and warns about any atos could not name.
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd -P)"
. "$root/scripts/lib/releases.sh"
die() { echo "error: $*" >&2; exit 1; }
usage="usage: scripts/symbolicate-crash.sh [--tag <engine-tag>] [--cache <dir>] <image uuid> <offset>... (--help)"
tag="" cache="$root/dist/engine-symbols"
while [ $# -gt 0 ]; do
  case "$1" in
    -h | --help) awk 'NR == 1 { next } /^#/ { sub(/^# ?/, ""); print; next } { exit }' "$0"; exit 0 ;;
    --tag) tag="${2:?--tag takes an engine release tag}"; shift ;;
    --cache) cache="${2:?--cache takes a directory}"; shift ;;
    -*) die "unknown option $1 (--help)" ;;
    *) break ;;
  esac
  shift
done
[ $# -ge 2 ] || die "$usage"

uuid="$(printf '%s' "$1" | tr 'A-F' 'a-f')"
shift
[[ "$uuid" =~ ^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$ ]] || die "$uuid isn't an image UUID (8-4-4-4-12 hex digits)"
offsets=()
for offset in "$@"; do
  offset="${offset#+}"
  [[ "$offset" =~ ^0[xX][0-9a-fA-F]+$ ]] || die "$offset isn't a hex offset like 0x2e2334"
  offsets+=("$offset")
done
for tool in gh atos dwarfdump tar; do
  command -v "$tool" >/dev/null || die "$tool isn't installed"
done

image_row() { awk -F '\t' -v u="$uuid" '$1 == u { print; exit }' "$1"; }
image_uuid() { dwarfdump --uuid "$1" | awk -v a="($2)" '/^UUID: / && $3 == a { print tolower($2); exit }'; }

mkdir -p "$cache"
run="$(mktemp -d "$cache/.run.XXXXXX")"
trap 'rm -rf "$run"' EXIT

lists_image() {
  local candidate="$1" name sidecar
  name="$(engine_uuids_name "$candidate")"
  sidecar="$cache/$candidate/$name"
  if [ ! -f "$sidecar" ]; then
    mkdir -p "$run/$candidate" "$cache/$candidate"
    gh release download "$candidate" -R "$REPO" -p "$name" -D "$run/$candidate" >/dev/null 2>&1 || return 2
    mv -f "$run/$candidate/$name" "$sidecar"
  fi
  row="$(image_row "$sidecar")"
  [ -n "$row" ]
}

row=""
if [ -n "$tag" ]; then
  status=0
  lists_image "$tag" || status=$?
  [ "$status" != 2 ] || die "$tag has no $(engine_uuids_name "$tag"): its symbols weren't published"
  [ "$status" = 0 ] || die "$tag's symbols don't list the image $uuid"
else
  page=1 engines=0
  while [ -z "$row" ]; do
    releases="$(gh api "repos/$REPO/releases?per_page=100&page=$page" --jq '.[] | [.tag_name, ([.assets[].name] | join(" "))] | @tsv')" \
      || die "couldn't list $REPO's releases: is gh signed in?"
    [ -n "$releases" ] || break
    while IFS=$'\t' read -r candidate assets; do
      [[ "$candidate" == engine-* ]] || continue
      engines=$((engines + 1))
      [[ " $assets " == *" $(engine_uuids_name "$candidate") "* ]] || continue
      if lists_image "$candidate"; then
        tag="$candidate"
        break
      fi
    done <<<"$releases"
    page=$((page + 1))
  done
  [ "$engines" -gt 0 ] || die "$REPO has no engine-* releases"
fi
[ -n "$row" ] || die "no engine release lists the image $uuid: its symbols weren't published (releases before the symbols were uploaded have none)"

IFS=$'\t' read -r _ arch rel <<<"$row"
binary="$cache/$tag/symbols/$rel"
if [ "$(image_uuid "$binary" "$arch" 2>/dev/null || true)" != "$uuid" ]; then
  name="$(engine_symbols_name "$tag")"
  mkdir -p "$run/$tag/symbols"
  gh release download "$tag" -R "$REPO" -p "$name" -D "$run/$tag" || die "couldn't download $name from $tag"
  tar -xJf "$run/$tag/$name" -C "$run/$tag/symbols" "$rel" || die "couldn't unpack $rel from $name"
  found="$(image_uuid "$run/$tag/symbols/$rel" "$arch" || true)"
  [ "$found" = "$uuid" ] || die "$rel in $tag has UUID ${found:-none}, not $uuid"
  mkdir -p "$(dirname "$binary")"
  mv -f "$run/$tag/symbols/$rel" "$binary"
fi

echo "$rel ($uuid, $arch) from $tag" >&2
frames="$(atos -arch "$arch" -o "$binary" -l 0x0 "${offsets[@]}")" || die "atos failed on $rel"
paste <(printf '%s\n' "${offsets[@]}") <(printf '%s\n' "$frames")
unnamed="$(grep -c -E '^0[xX][0-9a-fA-F]+$' <<<"$frames" || true)"
[ "$unnamed" = 0 ] || echo "warning: atos couldn't name $unnamed of ${#offsets[@]} offsets in $rel" >&2
