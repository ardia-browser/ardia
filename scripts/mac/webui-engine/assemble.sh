#!/usr/bin/env bash
set -euo pipefail
if [[ $# -ne 3 || $1 == -h || $1 == --help ]]; then
  echo "usage: scripts/mac/webui-engine/assemble.sh <Chromium Framework.framework> <apps/desktop/dist/mac> <out .app>" >&2
  exit 64
fi
here=$(cd "$(dirname "$0")" && pwd)
framework=$1
ui=$2
app=$3
name="Ardia WebUI Dev"
rm -rf "$app"
mkdir -p "$app/Contents/MacOS" "$app/Contents/Frameworks" "$app/Contents/Resources"
clang -O2 -arch arm64 -mmacosx-version-min=14.0 "$here/launcher/main.c" -o "$app/Contents/MacOS/$name"
cp -c -R "$framework" "$app/Contents/Frameworks/"
cp -R "$ui" "$app/Contents/Resources/ardia-ui"
printf 'APPL????' >"$app/Contents/PkgInfo"
icons="$here/../../../apps/browser/macos/Ardia-macOS/Assets.xcassets/AppIcon.appiconset"
scratch=$(mktemp -d)
trap 'rm -rf "$scratch"' EXIT
iconset="$scratch/AppIcon.iconset"
mkdir -p "$iconset"
for size in 16 32 128 256 512; do
  cp "$icons/icon_${size}x${size}_1x.png" "$iconset/icon_${size}x${size}.png"
  cp "$icons/icon_${size}x${size}_2x.png" "$iconset/icon_${size}x${size}@2x.png"
done
iconutil -c icns "$iconset" -o "$app/Contents/Resources/AppIcon.icns"
version=$(plutil -extract CFBundleShortVersionString raw "$framework/Resources/Info.plist" 2>/dev/null || echo 158.0.0.0)
cat >"$app/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleDevelopmentRegion</key><string>en</string>
  <key>CFBundleDisplayName</key><string>$name</string>
  <key>CFBundleExecutable</key><string>$name</string>
  <key>CFBundleIconFile</key><string>AppIcon</string>
  <key>CFBundleIdentifier</key><string>com.ardia.browser.webui-dev</string>
  <key>CFBundleInfoDictionaryVersion</key><string>6.0</string>
  <key>CFBundleName</key><string>$name</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>$version</string>
  <key>CFBundleVersion</key><string>$version</string>
  <key>LSMinimumSystemVersion</key><string>14.0</string>
  <key>NSHighResolutionCapable</key><true/>
  <key>NSSupportsAutomaticGraphicsSwitching</key><true/>
</dict>
</plist>
PLIST
codesign --force --deep --sign - "$app" >/dev/null 2>&1
echo "app: $app"
