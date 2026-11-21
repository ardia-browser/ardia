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

echo "==> Built-in plugins"
bundled="$app/Contents/Resources/Plugins"
plist="$app/Contents/Info.plist"
rm -rf "$bundled"
mkdir -p "$bundled"
/usr/libexec/PlistBuddy -c "Delete :ArdiaBuiltInPlugins" "$plist" 2>/dev/null || true
/usr/libexec/PlistBuddy -c "Add :ArdiaBuiltInPlugins dict" "$plist"
for folder in "$dist"/plugins/*/; do
  name="$(basename "$folder")"
  [ -f "$folder/plugin.json" ] || continue
  ditto --norsrc --noextattr "$folder" "$bundled/$name"
  granted="$(python3 -I "$root/scripts/release/official-plugins.py" entitlements "$name" "$bundled/$name")" \
    || die "the pin's entitlements for the $name plugin don't match its folder"
  find "$bundled/$name" -type f \( -name '*.so' -o -name '*.dylib' \) -print0 | while IFS= read -r -d '' lib; do
    sign_as "$identity" --options runtime "$lib"
  done
  trap 'rm -f "$dist/plugin-machos" "$dist/program.entitlements"' EXIT
  python3 -I "$root/scripts/release/official-plugins.py" machos "$bundled/$name" > "$dist/plugin-machos" \
    || die "couldn't list the $name plugin's Mach-O files"
  while IFS= read -r -d '' exe; do
    case "$exe" in *.so | *.dylib) continue ;; esac
    keys="$(program="${exe#"$bundled/$name/"}" awk -F '\t' '$1 "" == ENVIRON["program"] "" { print $2 }' <<<"$granted")"
    if [ -z "$keys" ]; then sign_as "$identity" --options runtime "$exe"; continue; fi
    printf '<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0"><dict>%s</dict></plist>\n' \
      "$(printf '<key>%s</key><true/>' $keys)" > "$dist/program.entitlements"
    sign_as "$identity" --options runtime --entitlements "$dist/program.entitlements" "$exe"
  done < "$dist/plugin-machos"
  /usr/libexec/PlistBuddy -c "Add :ArdiaBuiltInPlugins:$name string $("$root/scripts/release/plugin-digest.py" "$bundled/$name")" "$plist"
done
registry="$(python3 -I "$root/scripts/release/official-plugins.py" registry "$bundled")" || die "the bundled plugins' program registry couldn't be made"
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
