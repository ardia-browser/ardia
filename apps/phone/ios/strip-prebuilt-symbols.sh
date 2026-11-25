#!/bin/sh
set -eu
[ "${CONFIGURATION:-}" = "Release" ] || exit 0
dir="${TARGET_BUILD_DIR}/${FRAMEWORKS_FOLDER_PATH}"
for name in React hermesvm ReactNativeDependencies ExpoModulesJSI; do
  binary="$dir/$name.framework/$name"
  [ -f "$binary" ] || continue
  before=$(stat -f %z "$binary")
  xcrun strip -S "$binary"
  echo "stripped debug entries from $name: $before -> $(stat -f %z "$binary") bytes"
  if [ "${CODE_SIGNING_ALLOWED:-NO}" = "YES" ] && [ -n "${EXPANDED_CODE_SIGN_IDENTITY:-}" ]; then
    codesign --force --sign "$EXPANDED_CODE_SIGN_IDENTITY" --preserve-metadata=identifier,entitlements,flags --timestamp=none "$dir/$name.framework"
  fi
done
