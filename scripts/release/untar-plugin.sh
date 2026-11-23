#!/usr/bin/env bash
set -euo pipefail

usage="usage: scripts/release/untar-plugin.sh <archive> <folder>
Unpacks a pinned official-plugin tarball into <folder>: gzip (.tar.gz) with tar, brotli (.tar.br) through
scripts/release/brotli.swift, since macOS's tar has no brotli."
case "${1:-}" in -h | --help | "") echo "$usage"; [ -n "${1:-}" ] && exit 0 || exit 64 ;; esac
archive="$1"
folder="${2:?$usage}"
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
mkdir -p "$folder"
case "$archive" in
  *.tar.br) swift "$here/brotli.swift" decode <"$archive" | tar -xf - -C "$folder" ;;
  *.tar.gz) tar -xzf "$archive" -C "$folder" ;;
  *) echo "error: $archive is neither .tar.gz nor .tar.br" >&2; exit 1 ;;
esac
