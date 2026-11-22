#!/usr/bin/env bash
# Usage: quickjs-suite.sh
#   Runs QuickJS-ng's own test suite (make test) on the exact sources the
#   pinned rquickjs-sys crate vendors, in a scratch copy, and exits with its status.
set -euo pipefail
case "${1:-}" in -h|--help) sed -n '2,4p' "$0"; exit 0 ;; esac
here="$(cd "$(dirname "$0")/.." && pwd)"
manifest="$(cd "$here" && cargo metadata --format-version 1 | python3 -I -c 'import json,sys; print(next(p["manifest_path"] for p in json.load(sys.stdin)["packages"] if p["name"] == "rquickjs-sys"))')"
source="$(dirname "$manifest")/quickjs"
[ -f "$source/quickjs.h" ] || { echo "no vendored QuickJS-ng at $source" >&2; exit 1; }
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
cp -R "$source" "$work/quickjs"
grep -E 'define QJS_VERSION_(MAJOR|MINOR|PATCH)' "$work/quickjs/quickjs.h"
make -C "$work/quickjs" test
