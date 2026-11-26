#!/usr/bin/env bash
set -euo pipefail

usage="usage: scripts/release/archive.sh <dist> <framework> <derived data> <adhoc|xcode> [<build setting>…]"
dist="${1:?$usage}"
framework="${2:?$usage}"
build="${3:?$usage}"
signing="${4:?$usage}"
shift 4
. "$(dirname "$0")/lib.sh"
case "$signing" in
  adhoc) archive_signing=(-xcconfig macos/AdHoc.xcconfig) ;;
  xcode) archive_signing=(-allowProvisioningUpdates) ;;
  *) die "$usage" ;;
esac

echo "==> Content blocker"
"$ardiacore/scripts/ubo.sh"
[ -f "$ardiacore/vendor/ubo/ext/manifest.json" ] || die "uBlock Origin isn't installed ($ardiacore/scripts/ubo.sh)"
"$ardiacore/scripts/ubol.sh"
[ -f "$ardiacore/vendor/ubol-webkit/rules/rulesets.json" ] || die "uBlock Origin Lite's WebKit rules aren't built ($ardiacore/scripts/ubol.sh)"
"$ardiacore/scripts/hsts-preload.sh"
[ -f "$ardiacore/vendor/hsts-preload/hosts/subdomains.hosts" ] || die "the HSTS preload list isn't built ($ardiacore/scripts/hsts-preload.sh)"

echo "==> Rust core"
"$root/packages/core-rs/scripts/build-xcframework.sh" >&2 || die "ArdiaCoreRS.xcframework didn't build (packages/core-rs/scripts/build-xcframework.sh)"

build_settings=(-configuration Release ARCHS=arm64 ARDIACORE_STAGE_DIR="$build/ArdiaCoreFramework" "$@" "${archive_signing[@]}")
release_settings=(-destination 'generic/platform=macOS' "${build_settings[@]}")

echo "==> Release build settings"
"$(dirname "$0")/no-debug-build.sh" --settings "$@" || die "a release build setting would compile in Debug-only code"
check_release_settings() {
  local name=$1 required=$2
  shift 2
  (cd "$root/apps/browser" && "$root/scripts/agent/locked" pod --wait 1800 -- \
    xcodebuild "$@" "${build_settings[@]}" ACTION=install -showBuildSettings) > "$dist/release-settings-$name.txt" 2>&1 ||
    die "couldn't read the $name's Release build settings ($dist/release-settings-$name.txt)"
  "$(dirname "$0")/no-debug-build.sh" --effective --require-targets "$required" < "$dist/release-settings-$name.txt" ||
    die "the $name's Release build settings would compile in Debug-only code ($dist/release-settings-$name.txt)"
}
check_release_settings app Ardia-macOS -workspace macos/Ardia.xcworkspace -scheme Ardia-macOS -destination 'generic/platform=macOS'
check_release_settings pods ArdiaCore,ArdiaShell -project macos/Pods/Pods.xcodeproj -alltargets -sdk macosx

echo "==> Archive"
(cd "$root/apps/browser" && ARDIACORE_FRAMEWORK="$framework" "$root/scripts/agent/locked" pod --wait 1800 -- \
  "$root/scripts/agent/locked" xcodebuild --wait 1800 -- xcodebuild -workspace macos/Ardia.xcworkspace -scheme Ardia-macOS \
  "${release_settings[@]}" -derivedDataPath "$build" -archivePath "$dist/Ardia.xcarchive" archive) \
  > "$dist/archive.log" 2>&1 || {
  grep -E "error:|build commands failed" -A2 "$dist/archive.log" | grep -v MACOSX_DEPLOYMENT_TARGET | tail -20 >&2
  die "archive failed ($dist/archive.log)"
}
