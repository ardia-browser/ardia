#!/usr/bin/env bash
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
vendor="$(cd "$here/.." && pwd)/vendor"

UBOL_VERSION="2026.1124.1811"
UBOL_SHA256="66b8a21da4e1286d8f858c5095780ac56b0feffd3c40146e7acbe49ab5633312"
UBOL_CHROMIUM_SHA256="b0472c07028ced638cc0ae7c57403dd95ad6cdfc7391a37f9fa7aaf6239dfc55"
ubol="$vendor/ubol-webkit"
stamp="$UBOL_VERSION-$(shasum -a 256 "$here/ubol-webkit.py" | cut -c1-16)"
installed() { [ -f "$ubol/.version" ] && [ "$(cat "$ubol/.version")" = "$stamp" ]; }
if ! installed && [ -z "${UBOL_LOCKED:-}" ]; then
  mkdir -p "$ubol"
  UBOL_LOCKED=1 exec lockf -k -t 600 "$ubol/.lock" "$0"
fi
fetch() {
  local zip="$ubol/uBOLite_$UBOL_VERSION.$1.zip"
  if [ ! -f "$zip" ]; then
    local url="https://github.com/uBlockOrigin/uBOL-home/releases/download/$UBOL_VERSION/uBOLite_$UBOL_VERSION.$1.zip"
    echo "Downloading $url" >&2
    curl -fL --proto '=https' --tlsv1.2 --retry 3 -o "$zip.part" "$url" || return 1
    mv "$zip.part" "$zip" || return 1
  fi
  if ! echo "$2  $zip" | shasum -a 256 -c - >&2; then
    rm -f "$zip"
    echo "error: $zip doesn't match its pinned SHA-256; removed it so the next build downloads it again" >&2
    return 1
  fi
  echo "$zip"
}
if ! installed; then
  safari="$(fetch safari "$UBOL_SHA256")"
  chromium="$(fetch chromium "$UBOL_CHROMIUM_SHA256")"
  rm -rf "$ubol/unzip" "$ubol/unzip-chromium" "$ubol/rules.new"
  unzip -q "$safari" 'rulesets/*' manifest.json js/scripting/css-procedural-api.js -d "$ubol/unzip"
  unzip -q "$chromium" 'rulesets/*' -d "$ubol/unzip-chromium"
  python3 -I "$here/ubol-webkit.py" "$ubol/unzip" "$ubol/rules.new" "$UBOL_VERSION" "$ubol/unzip-chromium"
  rm -rf "$ubol/unzip" "$ubol/unzip-chromium" "$ubol/rules"
  mv "$ubol/rules.new" "$ubol/rules"
  echo "$stamp" > "$ubol/.version"
  find "$ubol" -maxdepth 1 -name 'uBOLite_*.zip' ! -name "uBOLite_$UBOL_VERSION.*" -delete
fi
