#!/usr/bin/env bash
# Usage: scripts/linux/fetch-engine.sh <x64|arm64> <out-file> [--repo OWNER/NAME]
# Downloads the prebuilt Linux engine scripts/linux/engine/prebuilt.json names (the tarball
# scripts/linux/engine/06-package.sh makes, attached to a GitHub release of the repository prebuilt.json names, else
# $GITHUB_REPOSITORY) with gh, checks its SHA-256 and writes it to
# <out-file>. Exits 3 when prebuilt.json doesn't exist yet (no engine has been published).
set -euo pipefail
[[ "${1:-}" == "-h" || "${1:-}" == "--help" ]] && { sed -n "2,6p" "$0" | cut -c3-; exit 0; }
cpu="${1:?x64 or arm64}"
out="${2:?out file}"
repo_flag=""
[[ "${3:-}" == "--repo" ]] && repo_flag="${4:?OWNER/NAME}"
prebuilt="$(dirname "$0")/engine/prebuilt.json"
[[ -f "$prebuilt" ]] || { echo "fetch-engine: no $prebuilt: no Linux engine has been published yet" >&2; exit 3; }
read -r release asset sha256 published_in < <(python3 -I -c '
import json, sys
data = json.load(open(sys.argv[1]))
entry = data.get(sys.argv[2]) or {}
if not entry.get("asset") or not entry.get("sha256"):
    sys.exit(f"fetch-engine: prebuilt.json names no {sys.argv[2]} engine")
print(data["release"], entry["asset"], entry["sha256"], data.get("repository") or "-")
' "$prebuilt" "$cpu")
[[ "$published_in" == "-" ]] && published_in=""
repo="${repo_flag:-${published_in:-${GITHUB_REPOSITORY:-ardia-browser/ardia}}}"
scratch="$(mktemp -d)"
trap 'rm -rf "$scratch"' EXIT
gh release download "$release" --repo "$repo" --pattern "$asset" --dir "$scratch"
actual="$(sha256sum "$scratch/$asset" | cut -d' ' -f1)"
[[ "$actual" == "$sha256" ]] || { echo "fetch-engine: $asset has SHA-256 $actual, not $sha256" >&2; exit 1; }
mkdir -p "$(dirname "$out")"
mv "$scratch/$asset" "$out"
echo "fetch-engine: $asset ($actual) from $release is $out"
