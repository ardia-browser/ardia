#!/usr/bin/env bash
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
vendor="$(cd "$here/.." && pwd)/vendor"

UBOL_VERSION="2026.1116.1650"
UBOL_SHA256="eed328928569264b321d9fc162c19a68167db54e36c1be51328d5739439907b4"
ubol="$vendor/ubol-webkit"
stamp="$UBOL_VERSION-$(shasum -a 256 "$here/ubol-webkit.py" | cut -c1-16)"
installed() { [ -f "$ubol/.version" ] && [ "$(cat "$ubol/.version")" = "$stamp" ]; }
if ! installed && [ -z "${UBOL_LOCKED:-}" ]; then
  mkdir -p "$ubol"
  UBOL_LOCKED=1 exec lockf -k -t 600 "$ubol/.lock" "$0"
fi
if ! installed; then
  zip="$ubol/uBOLite_$UBOL_VERSION.safari.zip"
  if [ ! -f "$zip" ]; then
    url="https://github.com/uBlockOrigin/uBOL-home/releases/download/$UBOL_VERSION/uBOLite_$UBOL_VERSION.safari.zip"
    echo "Downloading $url"
    curl -fL --retry 3 -o "$zip.part" "$url"
    mv "$zip.part" "$zip"
  fi
  echo "$UBOL_SHA256  $zip" | shasum -a 256 -c -
  rm -rf "$ubol/unzip" "$ubol/rules.new"
  unzip -q "$zip" 'rulesets/*' manifest.json -d "$ubol/unzip"
  python3 -I "$here/ubol-webkit.py" "$ubol/unzip" "$ubol/rules.new" "$UBOL_VERSION"
  rm -rf "$ubol/unzip" "$ubol/rules"
  mv "$ubol/rules.new" "$ubol/rules"
  echo "$stamp" > "$ubol/.version"
fi
