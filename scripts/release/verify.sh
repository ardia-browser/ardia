#!/usr/bin/env bash
set -euo pipefail

usage="usage: scripts/release/verify.sh <exported Ardia.app> <archive> <version> <build number>"
app="${1:?$usage}"
archive="${2:?$usage}"
version="${3:?$usage}"
release_build="${4:?$usage}"
. "$(dirname "$0")/lib.sh"
channel="$(channel_of "$version")"
fwv="$(cd "$app/Contents/Frameworks/Chromium Framework.framework/Versions/Current" && pwd -P)"

echo "==> Verify"
codesign --verify --deep --strict "$app"
[ -d "$archive/dSYMs/Ardia.app.dSYM" ] || die "the archive has no Ardia.app.dSYM"
entitlements() { codesign -d --entitlements - --xml "$1" 2>/dev/null; }
entitlements_are() {
  codesign -d --entitlements - --xml --arch "$2" "$1" 2>/dev/null | EXPECTED="$3" python3 -I -c 'import os, plistlib, sys
data = sys.stdin.buffer.read().strip()
got = plistlib.loads(data) if data else {}
print(sorted(got.items()))
sys.exit(0 if got == {key: True for key in os.environ["EXPECTED"].split()} and all(value is True for value in got.values()) else 3)'
}
info() { plutil -extract "$1" raw "$app/Contents/Info.plist" 2>/dev/null; }
[ "$(info CFBundleIdentifier)" = com.ardia.browser ] || die "bundle id is $(info CFBundleIdentifier)"
[ "$(info CFBundleExecutable)" = Ardia ] || die "executable is $(info CFBundleExecutable)"
[ "$(info CFBundleShortVersionString)" = "$version" ] || die "CFBundleShortVersionString is $(info CFBundleShortVersionString)"
[ "$(info CFBundleVersion)" = "$release_build" ] || die "CFBundleVersion is $(info CFBundleVersion), not $release_build"
[ "$(info ACUpdateChannel)" = "$channel" ] || die "ACUpdateChannel is '$(info ACUpdateChannel)', not $channel"
for key in SUFeedURL SUPublicEDKey NSDockTilePlugIn NSCameraUsageDescription NSMicrophoneUsageDescription \
  NSBluetoothAlwaysUsageDescription NSLocationUsageDescription NSLocalNetworkUsageDescription; do
  [ -n "$(info "$key")" ] || die "Info.plist has no $key"
done
[ -d "$app/Contents/Frameworks/Sparkle.framework" ] || die "no Sparkle.framework"
[ -d "$app/Contents/PlugIns/ArdiaDockTile.plugin" ] || die "no dock tile plug-in"
[ ! -e "$app/Contents/Helpers/ArdiaFairPlay.app" ] || die "the removed FairPlay helper is still in the app"
[ -f "$app/Contents/embedded.provisionprofile" ] || die "no Developer ID provisioning profile (keychain groups need it)"
for folder in "$app"/Contents/Resources/Plugins/*/; do
  [ -d "$folder" ] || continue
  name="$(basename "$folder")"
  recorded="$(plutil -extract "ArdiaBuiltInPlugins.$name" raw "$app/Contents/Info.plist" 2>/dev/null || true)"
  [ -n "$recorded" ] || die "Info.plist has no digest for the built-in plugin $name"
  [ "$("$root/scripts/release/plugin-digest.py" "$folder")" = "$recorded" ] \
    || die "the signed $name plugin's files don't match the digest in Info.plist: something changed them after export-sign.sh recorded it"
  team="$(codesign -dv "$app" 2>&1 | sed -n 's/^TeamIdentifier=//p')"
  granted="$(python3 -I "$root/scripts/release/official-plugins.py" entitlements "$name" "$folder")" \
    || die "the pin's entitlements for the built-in $name plugin don't match its folder"
  machos="$(mktemp)"
  trap 'rm -f "$machos"' EXIT
  python3 -I "$root/scripts/release/official-plugins.py" machos "$folder" > "$machos" || die "couldn't list the $name plugin's Mach-O files"
  while IFS= read -r -d '' exe; do
    codesign --verify --strict "$exe" || die "$exe isn't validly signed"
    expected="$(program="${exe#"$folder"}" awk -F '\t' '$1 "" == ENVIRON["program"] "" { print $2 }' <<<"$granted")"
    archs="$(lipo -archs "$exe")" || die "$exe has no architectures lipo can read"
    for arch in $archs; do
      signed="$(codesign -dv --arch "$arch" "$exe" 2>&1)" || die "$exe ($arch) isn't signed"
      flags="$(sed -n 's/^CodeDirectory .* flags=\(0x[0-9a-f]*\)(.*/\1/p' <<<"$signed")"
      [ -n "$flags" ] && (( flags & 0x10000 )) || die "$exe ($arch) isn't signed with the hardened runtime"
      [ "$(sed -n 's/^TeamIdentifier=//p' <<<"$signed")" = "$team" ] || die "$exe ($arch) isn't signed by the app's team ($team)"
      actual="$(entitlements_are "$exe" "$arch" "$expected")" \
        || die "$exe ($arch) has entitlements ${actual:-unreadable}, not the pin's '$expected'"
    done
  done < "$machos"
  rm -f "$machos"
done
recorded_registry="$(plutil -extract ArdiaProgramRegistry json -o - "$app/Contents/Info.plist" 2>/dev/null || true)"
[ -n "$recorded_registry" ] || die "Info.plist has no ArdiaProgramRegistry"
python3 -I "$root/scripts/release/official-plugins.py" verify-registry "$app/Contents/Resources/Plugins" "$recorded_registry" \
  || die "Info.plist's ArdiaProgramRegistry doesn't match the signed plugins and the pin's reserved programs"
[ -f "$app/Contents/Resources/Plugins/cli/plugin.json" ] || die "the app has no built-in Command Line plugin"
[ -f "$app/Contents/Resources/Extensions/ublock/manifest.json" ] || die "no uBlock Origin in the app"
[ -f "$app/Contents/Resources/ContentRules/rulesets.json" ] || die "no WebKit content rules in the app"
for file in "$root"/LICENSE* "$root/NOTICE"; do
  cmp -s "$file" "$app/Contents/Resources/Licenses/$(basename "$file")" || die "the app lacks $(basename "$file") in Contents/Resources/Licenses"
done
designated="$(codesign -d -r- "$app" 2>&1 | sed -n 's/^designated => //p')"
[[ "$designated" == *'identifier "com.ardia.browser"'* && "$designated" == *"subject.OU] = U5L5T3NGVV"* ]] \
  || die "designated requirement: $designated"
app_ents="$(entitlements "$app")"
for group in webauthn unexportable-keys secure-payment-confirmation; do
  [[ "$app_ents" == *"U5L5T3NGVV.com.ardia.browser.$group"* ]] || die "the app lacks the keychain group …$group"
done
if grants_browser_passkeys "$app/Contents/embedded.provisionprofile"; then
  [[ "$app_ents" == *web-browser.public-key-credential* ]] || die "the profile grants browser passkeys but the app isn't signed with them"
else
  [[ "$app_ents" != *web-browser.public-key-credential* ]] || die "the app is signed with com.apple.developer.web-browser.public-key-credential, which its profile doesn't grant"
fi
for helper in "$fwv"/Helpers/*"Renderer).app" "$fwv"/Helpers/*"GPU).app"; do
  [[ "$(entitlements "$helper")" == *cs.allow-jit* ]] || die "$(basename "$helper") lost allow-jit"
done
while IFS= read -r -d '' code; do
  details="$(codesign -dvv "$code" 2>&1)"
  [[ "$details" == *"TeamIdentifier=U5L5T3NGVV"* && "$details" == *"Authority=Developer ID Application"* \
    && "$details" == *"Timestamp="* ]] || die "$code isn't Developer ID-signed with a timestamp"
  [[ "$(entitlements "$code")" != *get-task-allow* ]] || die "$code has get-task-allow"
done < <(find "$app" \( -name "*.app" -o -name "*.framework" -o -name "*.dylib" -o -name "*.xpc" -o -name "*.plugin" \
  -o -path "*/Helpers/*" -type f -perm -u+x -o -path "*/MacOS/*" -type f \) -print0)
