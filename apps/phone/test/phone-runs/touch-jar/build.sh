#!/bin/bash
# Usage: touch-jar/build.sh [out.jar]
# Builds ardia-touch.jar (class agentd.ArdiaTouch, run with app_process) from src/ with javac --release 11
# against the Android SDK's android.jar, then d8 --min-api 33. Needs ANDROID_HOME or ~/Library/Android/sdk.
set -euo pipefail
case "${1:-}" in -h|--help) sed -n '2,4p' "$0" | cut -c3-; exit 0 ;; esac
here="$(cd "$(dirname "$0")" && pwd)"
out="${1:-$here/ardia-touch.jar}"
sdk="${ANDROID_HOME:-$HOME/Library/Android/sdk}"
platform="$(ls -d "$sdk"/platforms/android-* | sort -V | tail -1)"
tools="$(ls -d "$sdk"/build-tools/* | sort -V | tail -1)"
work="$(mktemp -d /tmp/ardia-touch-build.XXXXXX)"
trap 'rm -rf "$work"' EXIT
javac --release 11 -nowarn -cp "$platform/android.jar" -d "$work/classes" "$here"/src/agentd/*.java
(cd "$work/classes" && jar cf "$work/classes.jar" agentd)
"$tools/d8" --min-api 33 --lib "$platform/android.jar" --output "$work" "$work/classes.jar"
(cd "$work" && jar cf "$out" classes.dex)
echo "$out $(shasum -a 256 "$out" | cut -d' ' -f1)"
