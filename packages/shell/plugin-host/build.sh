#!/usr/bin/env bash
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
name="ArdiaPluginHost"
helpers="$TARGET_BUILD_DIR/${CONTENTS_FOLDER_PATH:-Contents}/Helpers"
work="${DERIVED_FILE_DIR:-$here/build}/plugin-host"
identity="${EXPANDED_CODE_SIGN_IDENTITY:--}"
[ -z "$identity" ] && identity="-"
min_os="${MACOSX_DEPLOYMENT_TARGET:-14.0}"
sources=("$here"/*.swift "$here/../ios/PluginCore/PluginURLParser.swift" "$here/../ios/PluginCore/PluginBase64.swift" "$here/../ios/PluginCore/PluginTimerQueue.swift")
binary="$work/$name"
mkdir -p "$work" "$helpers"

stale=0
[ -f "$binary" ] || stale=1
for src in "${sources[@]}" "$0"; do [ "$src" -nt "$binary" ] && stale=1; done
if [ "$stale" = 1 ]; then
  echo "Building $name"
  slices=()
  for arch in ${ARCHS:-$(uname -m)}; do
    out="$work/$name-$arch"
    xcrun swiftc -O -module-name "$name" -target "$arch-apple-macos$min_os" \
      -sdk "$(xcrun --sdk macosx --show-sdk-path)" -emit-executable \
      -framework Foundation -framework JavaScriptCore -o "$out" "${sources[@]}"
    slices+=("$out")
  done
  xcrun lipo -create "${slices[@]}" -output "$binary"
fi

cp "$binary" "$helpers/$name"
case "${EXPANDED_CODE_SIGN_IDENTITY_NAME:-}" in
  "Developer ID"*) timestamp=--timestamp ;;
  *) timestamp=--timestamp=none ;;
esac
codesign --force --sign "$identity" "$timestamp" --options runtime \
  --identifier "${PRODUCT_BUNDLE_IDENTIFIER:-com.ardia.browser}.plugin-host" "$helpers/$name"
