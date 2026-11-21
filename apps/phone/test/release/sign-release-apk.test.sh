#!/bin/bash
# sign-release-apk.test.sh
# Proves apps/phone/scripts/sign-release-apk loads a real PKCS12 keystore the way the release workflow gives it: makes
# a throwaway PKCS12 key and a minimal APK, signs it, and checks the signer is that key, the keystore is gone afterwards,
# a wrong password fails, and no password reaches the output. Needs keytool, and ANDROID_HOME with build-tools and a
# platform's android.jar. Touches no real key.
set -euo pipefail
if [ "${1:-}" = "--help" ] || [ "${1:-}" = "-h" ]; then
  sed -n '2,6p' "$0" | sed 's/^# \{0,1\}//'
  exit 0
fi
here="$(cd "$(dirname "$0")" && pwd)"
script="$here/../../scripts/sign-release-apk"
sdk="${ANDROID_HOME:-$HOME/Library/Android/sdk}"
tools="$(ls -d "$sdk"/build-tools/* | sort -V | tail -1)"
platform="$(ls -d "$sdk"/platforms/android-* | sort -V | tail -1)"
work="$(mktemp -d "${TMPDIR:-/tmp}/sign-release-test.XXXXXX")"
trap 'rm -rf "$work"' EXIT
failed=0
pass() { echo "ok: $1"; }
fail() { echo "FAILED: $1"; failed=1; }

cat > "$work/AndroidManifest.xml" <<'XML'
<manifest xmlns:android="http://schemas.android.com/apk/res/android" package="com.ardia.signing.test" android:versionCode="1" android:versionName="1"><application /></manifest>
XML
"$tools/aapt2" link -o "$work/unsigned.apk" -I "$platform/android.jar" --manifest "$work/AndroidManifest.xml"
"$tools/zipalign" -f 4 "$work/unsigned.apk" "$work/aligned.apk"

password="test-$(openssl rand -hex 12)"
alias_name="ardia"
mkdir -p "$work/keygen"
STORE_PASSWORD="$password" keytool -genkeypair -storetype PKCS12 -keystore "$work/keygen/test.p12" -alias "$alias_name" -keyalg RSA -keysize 2048 -validity 2 \
  -dname "CN=signing test" -storepass:env STORE_PASSWORD -keypass:env STORE_PASSWORD > /dev/null 2>&1
expected="$(STORE_PASSWORD="$password" keytool -list -v -storetype PKCS12 -keystore "$work/keygen/test.p12" -alias "$alias_name" -storepass:env STORE_PASSWORD 2>/dev/null | sed -n 's/.*SHA256: //p' | head -1 | tr -d ': ' | tr '[:upper:]' '[:lower:]')"
encoded="$(base64 < "$work/keygen/test.p12" | tr -d '\n')"
rm -rf "$work/keygen"
[ -n "$expected" ] || { echo "FAILED: couldn't read the test key's fingerprint"; exit 1; }

mkdir -p "$work/tmp"
if output="$(TMPDIR="$work/tmp" ANDROID_RELEASE_KEYSTORE_B64="$encoded" ANDROID_RELEASE_KEYSTORE_PASSWORD="$password" ANDROID_RELEASE_KEY_ALIAS="$alias_name" "$script" "$work/aligned.apk" "$work/signed.apk" 2>&1)"; then
  pass "it signs with a PKCS12 keystore"
else
  printf '%s\n' "$output" | sed "s/$password/<password>/g" | tail -5
  fail "it signs with a PKCS12 keystore"
fi
printed="$(printf '%s\n' "$output" | tail -1 | tr -d ': ' | tr '[:upper:]' '[:lower:]')"
[ "$printed" = "$expected" ] && pass "it prints the test key as the signer" || fail "it printed $printed, expected $expected"
actual="$("$tools/apksigner" verify --print-certs "$work/signed.apk" 2>/dev/null | sed -n 's/.*certificate SHA-256 digest: //p' | head -1)"
[ "$actual" = "$expected" ] && pass "the APK verifies with the test key" || fail "the APK's signer is ${actual:-nothing}, expected $expected"
[ -z "$(ls -A "$work/tmp")" ] && pass "no keystore is left in TMPDIR" || fail "left in TMPDIR: $(ls -A "$work/tmp")"
grep -q -- "$password" <<<"$output" && fail "the password reached the output" || pass "the password never reaches the output"

if wrong="$(TMPDIR="$work/tmp" ANDROID_RELEASE_KEYSTORE_B64="$encoded" ANDROID_RELEASE_KEYSTORE_PASSWORD="not-$password" ANDROID_RELEASE_KEY_ALIAS="$alias_name" "$script" "$work/aligned.apk" "$work/wrong.apk" 2>&1)"; then
  fail "a wrong password signed anyway"
else
  pass "a wrong password fails"
fi
grep -q -- "$password" <<<"$wrong" && fail "the password reached the failure's output" || pass "the failure doesn't show the password"
[ -z "$(ls -A "$work/tmp")" ] && pass "no keystore is left after a failure" || fail "left after a failure: $(ls -A "$work/tmp")"
if TMPDIR="$work/tmp" ANDROID_RELEASE_KEYSTORE_B64="" ANDROID_RELEASE_KEYSTORE_PASSWORD="$password" ANDROID_RELEASE_KEY_ALIAS="$alias_name" "$script" "$work/aligned.apk" "$work/empty.apk" > /dev/null 2>&1; then
  fail "a missing keystore signed anyway"
else
  pass "a missing keystore fails"
fi

[ "$failed" = 0 ] && echo "all signing checks passed" || { echo "the signing script failed its checks"; exit 1; }
