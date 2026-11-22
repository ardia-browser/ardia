#!/usr/bin/env bash
set -euo pipefail

usage="usage: scripts/release/export-sign.sh <dist> <archive> <identity> [<provisioning profile>]"
dist="${1:?$usage}"
archive="${2:?$usage}"
identity="${3:?$usage}"
provisioning_profile="${4:-}"
. "$(dirname "$0")/lib.sh"
app="$dist/export/Ardia.app"

if [ -n "$provisioning_profile" ]; then
  app_entitlements="$macos/Ardia-macOS/Ardia.entitlements"
  grants_browser_passkeys "$provisioning_profile" && app_entitlements="$macos/Ardia-macOS/Ardia-ICloudPasskeys.entitlements"
  echo "==> Export (Developer ID, $(basename "$provisioning_profile"), $(basename "$app_entitlements"))"
  "$root/scripts/lib/export-developer-id.sh" "$archive/Products/Applications/Ardia.app" "$app" "$provisioning_profile" \
    "$app_entitlements" "$identity" com.ardia.browser > "$dist/export.log" 2>&1 || { cat "$dist/export.log" >&2; exit 1; }
else
  echo "==> Export (Developer ID)"
  for attempt in 1 2 3 4 5 6; do
    rm -rf "$dist/export"
    xcodebuild -exportArchive -archivePath "$archive" -exportOptionsPlist "$macos/ExportOptions-DeveloperID.plist" \
      -exportPath "$dist/export" -allowProvisioningUpdates > "$dist/export.log" 2>&1 && break
    grep -q "A timestamp was expected" "$dist/export.log" && [ "$attempt" -lt 6 ] \
      || { cat "$dist/export.log" >&2; exit 1; }
    echo "    no timestamp from Apple (attempt $attempt), exporting again"
    sleep 10
  done
fi
[ "$(lipo -archs "$app/Contents/MacOS/Ardia")" = arm64 ] || die "the app's executable is $(lipo -archs "$app/Contents/MacOS/Ardia"), not arm64"

echo "==> Official plugins (fetched on Install; the app carries only the pin and the program registry)"
plist="$app/Contents/Info.plist"
[ ! -e "$app/Contents/Resources/Plugins" ] || die "the export bundles plugins; official plugins are fetched on Install"
/usr/libexec/PlistBuddy -c "Delete :ArdiaBuiltInPlugins" "$plist" 2>/dev/null || true
signed_pin="$(python3 -I "$root/scripts/release/official-plugins.py" signed-pin)" || die "the official plugins' pin couldn't be read"
plutil -replace ArdiaOfficialPlugins -json "$signed_pin" "$plist" || die "couldn't write ArdiaOfficialPlugins into Info.plist"
registry="$(python3 -I "$root/scripts/release/official-plugins.py" registry)" || die "the pin's program registry couldn't be made"
plutil -replace ArdiaProgramRegistry -json "$registry" "$plist" || die "couldn't write ArdiaProgramRegistry into Info.plist"

echo "==> Licenses"
licenses="$app/Contents/Resources/Licenses"
mkdir -p "$licenses"
cp "$root"/LICENSE* "$root/NOTICE" "$licenses/"

echo "==> Sign Chrome's framework"
entitlements_dir="$ardiacore/scripts/signing"
fw="$app/Contents/Frameworks/Chromium Framework.framework"
fwv="$(cd "$fw/Versions/Current" && pwd -P)" || die "no Chromium Framework.framework in the export"
"$ardiacore/scripts/strip-engine.sh" "$app" "$dist/symbols"
"$ardiacore/scripts/prune-bundle.sh" "$app"
for lib in "$fwv"/Libraries/*.dylib; do sign_as "$identity" "$lib"; done
for helper in "$fwv"/Helpers/*.app; do
  case "$(basename "$helper")" in
    *"Renderer).app") sign_as "$identity" --options restrict,kill,runtime --entitlements "$entitlements_dir/renderer.entitlements" "$helper" ;;
    *"GPU).app") sign_as "$identity" --options restrict,kill,runtime --entitlements "$entitlements_dir/gpu.entitlements" "$helper" ;;
    *) sign_as "$identity" --options restrict,library,kill,runtime "$helper" ;;
  esac
done
sign_as "$identity" --options restrict,library,kill,runtime "$fwv/Helpers/chrome_crashpad_handler"
sign_as "$identity" --options restrict,library,kill,runtime "$fwv/Helpers/app_mode_loader"
[ -e "$fwv/Helpers/web_app_shortcut_copier" ] && sign_as "$identity" --options restrict,library,kill,runtime \
  --identifier com.ardia.browser.web_app_shortcut_copier "$fwv/Helpers/web_app_shortcut_copier"
sign_as "$identity" "$fw"
plugin_host="$app/Contents/Helpers/ArdiaPluginHost"
[ -e "$plugin_host" ] && sign_as "$identity" --options runtime --identifier com.ardia.browser.plugin-host "$plugin_host"
[ -d "$app/Contents/Frameworks/hermes.framework" ] \
  && sign_as "$identity" --preserve-metadata=identifier,entitlements,flags,runtime "$app/Contents/Frameworks/hermes.framework"
sign_as "$identity" --preserve-metadata=entitlements,requirements,flags,runtime "$app"
