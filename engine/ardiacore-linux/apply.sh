#!/usr/bin/env bash
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
repo=$(cd "$here/../.." && pwd)
src=${CHROMIUM_SRC:-$HOME/chromium-build/chromium_git/chromium/src}
owned=(ardia/linux)
mode=${1:-}
sources=()
targets=()
line_number=0
while IFS= read -r line || [[ -n "$line" ]]; do
  line_number=$((line_number + 1))
  [[ -n "$line" ]] || continue
  IFS=$'\t' read -r source target extra <<<"$line"
  if [[ "$line" == *$'\r'* || -n "${extra:-}" || -z "${target:-}" || "$line" != "$source"$'\t'"$target" ]]; then
    echo "error: copies.tsv:$line_number: expected <source><TAB><target>: $line" >&2
    exit 1
  fi
  for path in "$source" "$target"; do
    case "/$path/" in
      *//* | */./* | */../* | *\\*) echo "error: copies.tsv:$line_number: $path isn't a relative path without ., .. or \\" >&2; exit 1 ;;
    esac
  done
  sources+=("$source")
  targets+=("$target")
done <"$here/copies.tsv"
case "$mode" in
  --paths) printf '%s\n' "${targets[@]}"; exit 0 ;;
  ''|--check) ;;
  *) echo "usage: $0 [--check|--paths]" >&2; exit 64 ;;
esac
if [[ "$mode" != --check ]]; then
  for index in "${!sources[@]}"; do
    case "${sources[index]}" in
      engine/chromium/src/*)
        [[ -f "$src/${targets[index]}" ]] || { echo "error: ${targets[index]} isn't in the tree: the Linux logos replace Chromium's, they add none" >&2; exit 1; } ;;
    esac
  done
fi
if [[ "$mode" == --check ]]; then
  diff -r "$here/src/ardia/linux" "$src/ardia/linux" >/dev/null || { echo "drift: ardia/linux" >&2; exit 1; }
else
  mkdir -p "$src/ardia/linux"
  rsync -rlp --delete --checksum "$here/src/ardia/linux/" "$src/ardia/linux/"
fi
copy_file() {
  local source=$1 target=$2
  if [[ "$mode" == --check ]]; then
    cmp -s "$source" "$target" || { echo "drift: ${target#"$src/"}" >&2; exit 1; }
  else
    mkdir -p "${target%/*}"
    cmp -s "$source" "$target" || cp "$source" "$target"
  fi
}
for index in "${!sources[@]}"; do
  copy_file "$repo/${sources[index]}" "$src/${targets[index]}"
done
for file in "$here"/src/ardia/core/*; do
  copy_file "$file" "$src/ardia/core/${file##*/}"
done
