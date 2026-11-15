#!/usr/bin/env bash
# Usage: scripts/linux/ubo.sh
# Fetches the uBlock Origin the app bundles into packages/ardiacore/vendor/ubo/ext, exactly as the Mac's
# packages/ardiacore/scripts/ubo.sh does (the same pinned release, SHA-256, key and edits): it runs that script, with its
# three macOS-only lines (lockf, shasum, its vendor path) swapped for Linux's (flock, sha256sum, the absolute path).
# A copy already at the pinned version and edit level is left alone.
set -euo pipefail
[[ "${1:-}" == "-h" || "${1:-}" == "--help" ]] && { sed -n "2,6p" "$0" | cut -c3-; exit 0; }
repo="$(cd "$(dirname "$0")/../.." && pwd)"
linux="$(mktemp)"
trap 'rm -f "$linux"' EXIT
python3 -I - "$repo/packages/ardiacore/scripts/ubo.sh" "$linux" "$repo/packages/ardiacore/vendor" <<'PY'
import sys
source, target, vendor = sys.argv[1:4]
text = open(source).read()
swaps = [
    ('vendor="$(cd "$(dirname "$0")/.." && pwd)/vendor"', f'vendor="{vendor}"'),
    ('UBO_LOCKED=1 exec lockf -k -t 600 "$ubo/.lock" "$0"', 'UBO_LOCKED=1 exec flock -w 600 "$ubo/.lock" bash "$0"'),
    ('shasum -a 256 -c -', 'sha256sum -c -'),
]
for old, new in swaps:
    if text.count(old) != 1:
        sys.exit(f"scripts/linux/ubo.sh: packages/ardiacore/scripts/ubo.sh no longer has exactly one {old!r}")
    text = text.replace(old, new)
open(target, "w").write(text)
PY
bash "$linux"
cat "$repo/packages/ardiacore/vendor/ubo/.version"
