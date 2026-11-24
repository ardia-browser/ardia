#!/usr/bin/env bash
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
src=${CHROMIUM_SRC:-$HOME/chromium-build/chromium_git/chromium/src}
owned=(ardia/desktop)
mode=${1:-}
case "$mode" in
  --paths) printf '%s/\n' "${owned[@]}"; exit 0 ;;
  ''|--check) ;;
  *) echo "usage: $0 [--check|--paths]" >&2; exit 64 ;;
esac
if [[ "$mode" == --check ]]; then
  diff -r "$here/src/ardia/desktop" "$src/ardia/desktop" >/dev/null || { echo "drift: ardia/desktop" >&2; exit 1; }
else
  mkdir -p "$src/ardia/desktop"
  rsync -rlp --delete --checksum "$here/src/ardia/desktop/" "$src/ardia/desktop/"
fi
