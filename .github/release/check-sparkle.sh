#!/usr/bin/env bash
set -euo pipefail

dist="${1:?usage: check-sparkle.sh <dist> <version>}"
version="${2:?usage: check-sparkle.sh <dist> <version>}"
feed="$dist/appcast.xml"
zip="$dist/Ardia-$version.zip"
root="$(git -C "$(dirname "$0")" rev-parse --show-toplevel)"
work="$(mktemp -d "${TMPDIR:-/tmp}/ac-sparkle.XXXXXX")"
trap 'rm -rf "$work"' EXIT

swiftc -O "$root/.claude/skills/release/scripts/ed25519.swift" -o "$work/ed25519"
enclosure="$(python3 -I "$root/.claude/skills/release/scripts/appcast.py" enclosure "$feed" "$version")" \
  || { echo "::error::$feed has no single item for $version"; exit 1; }
read -r signature length <<<"$enclosure"
key="$(plutil -extract SUPublicEDKey raw "$dist/export/Ardia.app/Contents/Info.plist")"
[ "$length" = "$(stat -f %z "$zip")" ] || { echo "::error::the appcast's length for $(basename "$zip") is $length, the file is $(stat -f %z "$zip")"; exit 1; }
"$work/ed25519" verify "$zip" "$signature" "$key" \
  || { echo "::error::$(basename "$zip")'s EdDSA signature doesn't verify with the app's SUPublicEDKey: SPARKLE_ED_PRIVATE_KEY is the wrong key"; exit 1; }
echo "PASS  $(basename "$zip") is signed with the key in SUPublicEDKey ($key)"
deltas="$(python3 -I "$root/.claude/skills/release/scripts/appcast.py" deltas "$feed" "$version")" \
  || { echo "::error::couldn't read $version's deltas from $feed"; exit 1; }
count=0
while read -r from url length signature; do
  [ -n "$from" ] || continue
  delta="$dist/${url##*/}"
  [ -f "$delta" ] || { echo "::error::the appcast lists a delta from build $from, but $dist has no $(basename "$delta")"; exit 1; }
  [ "$length" = "$(stat -f %z "$delta")" ] || { echo "::error::the appcast's length for $(basename "$delta") is $length, the file is $(stat -f %z "$delta")"; exit 1; }
  "$work/ed25519" verify "$delta" "$signature" "$key" \
    || { echo "::error::$(basename "$delta")'s EdDSA signature doesn't verify with the app's SUPublicEDKey"; exit 1; }
  count=$((count + 1))
done <<<"$deltas"
listed="$(find "$dist" -maxdepth 1 -name '*.delta' | wc -l | tr -d ' ')"
[ "$listed" = "$count" ] || { echo "::error::$dist holds $listed .delta files but the appcast lists $count"; exit 1; }
echo "PASS  $count delta(s) signed with the key in SUPublicEDKey"
