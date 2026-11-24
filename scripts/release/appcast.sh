#!/usr/bin/env bash
set -euo pipefail

usage="usage: SPARKLE_BIN=<dir> SPARKLE_KEY_FILE=<file> [APPCAST_DELTAS=<count, default 3>] scripts/release/appcast.sh <dist> <version> <headline> <notes body file> <published appcast or empty file> [<phased rollout seconds>]"
dist="${1:?$usage}"
version="${2:?$usage}"
headline="${3:?$usage}"
body="${4:?$usage}"
base_feed="${5:?$usage}"
phased="${6:-}"
sparkle="${SPARKLE_BIN:?$usage}"
key="${SPARKLE_KEY_FILE:?$usage}"
delta_count="${APPCAST_DELTAS:-3}"
. "$(dirname "$0")/lib.sh"
case "$delta_count" in '' | *[!0-9]*) die "APPCAST_DELTAS is a whole number of deltas, got '$delta_count'" ;; esac

annotate() {
  local level="$1"
  shift
  if [ -n "${GITHUB_ACTIONS:-}" ]; then echo "::$level::$*"; else echo "$level: $*" >&2; fi
}
summary() { [ -z "${GITHUB_STEP_SUMMARY:-}" ] || echo "- $*" >> "$GITHUB_STEP_SUMMARY"; }
size_of() { wc -c < "$1" | tr -d ' '; }
is_signature() { [[ "$1" =~ ^[A-Za-z0-9+/]{86}==$ ]]; }

echo "==> Appcast"
channel="$(channel_of "$version")"
zip="$dist/Ardia-$version.zip"
zip_name="$(basename "$zip")"
download_prefix="$REPO_URL/releases/download/v$version/"
updates="$dist/updates"
tools="$dist/updates.tools"
rm -rf "$updates" "$updates.home" "$updates.fetch" "$tools"
rm -f "$dist"/*.delta "$dist/appcast.built.xml"
mkdir -p "$tools" "$updates.fetch"

fresh_updates() {
  rm -rf "$updates" "$updates.home"
  mkdir -p "$updates" "$updates.home"
  cp "$zip" "$updates/"
  { printf '**%s**\n\n' "$headline"; cat "$body"; } > "$updates/Ardia-$version.md"
}

trusted_key() {
  python3 -I -c '
import base64, plistlib, sys
key = plistlib.load(open(sys.argv[1], "rb")).get("SUPublicEDKey", "")
if len(base64.b64decode(key, validate=True)) != 32:
    sys.exit(1)
print(key)
' "$dist/export/Ardia.app/Contents/Info.plist" 2>/dev/null
}

verifier() {
  if [ -n "${APPCAST_ED25519:-}" ]; then
    echo "$APPCAST_ED25519"
  else
    swiftc -O "$root/.claude/skills/release/scripts/ed25519.swift" -o "$tools/ed25519" 2>/dev/null && echo "$tools/ed25519"
  fi
}

fresh_updates
problem=""
wanted=0
bases=()
public_key=""
ed25519=""
fetch_deadline=$((SECONDS + ${APPCAST_DELTA_FETCH_SECONDS:-1800}))
if [ "$delta_count" = 0 ]; then
  annotate warning "APPCAST_DELTAS=0: $version ships without Sparkle deltas, so every update downloads the whole zip"
elif [ ! -s "$base_feed" ]; then
  echo "note: no published appcast to build deltas from: $version ships without them"
elif ! public_key="$(trusted_key)" || ! ed25519="$(verifier)"; then
  annotate warning "no SUPublicEDKey in the exported app or no Ed25519 verifier, so earlier zips can't be checked: $version ships without deltas"
  problem="the earlier zips can't be checked"
else
  base_lines="$(appcast delta-bases "$base_feed" "$version" "$delta_count")" || die "couldn't read the published appcast for the zips to build deltas from"
  while read -r base_build base_url base_length base_signature; do
    [ -n "$base_build" ] || continue
    wanted=$((wanted + 1))
    base_name="${base_url##*/}"
    if [ "$base_name" = "$zip_name" ] || [ -e "$updates/$base_name" ]; then
      annotate warning "build $base_build's zip is named $base_name, like a file already staged: no delta from it"
      continue
    fi
    staging="$updates.fetch/$base_build"
    mkdir -p "$staging"
    base_zip="$staging/$base_name"
    fetched=0
    for attempt in 1 2 3; do
      budget=$((fetch_deadline - SECONDS))
      [ "$budget" -ge 30 ] || break
      if curl -fsSL --connect-timeout 20 --max-time "$budget" -o "$base_zip" "$base_url"; then
        fetched=1
        break
      fi
      [ "$attempt" = 3 ] || [ $((fetch_deadline - SECONDS)) -lt 35 ] || sleep 5
    done
    if [ "$fetched" = 0 ]; then
      if [ $((fetch_deadline - SECONDS)) -lt 30 ]; then
        annotate warning "out of time for earlier zips (APPCAST_DELTA_FETCH_SECONDS): no delta from build $base_build"
      else
        annotate warning "couldn't download build $base_build ($base_url) to build a delta from"
      fi
      continue
    fi
    if ! is_signature "$base_signature" || [ "$(size_of "$base_zip")" != "$base_length" ] \
      || ! "$ed25519" verify "$base_zip" "$base_signature" "$public_key" >/dev/null 2>&1; then
      annotate warning "build $base_build's zip ($base_url) doesn't match the length and EdDSA signature the published appcast lists, checked with the app's SUPublicEDKey: no delta from it"
      continue
    fi
    mv "$base_zip" "$updates/$base_name"
    bases+=("$base_build")
  done <<<"$base_lines"
fi
rm -rf "$updates.fetch"

phased_args=()
[ -n "$phased" ] && phased_args=(--phased-rollout-interval "$phased")
[ "$channel" = nightly ] && phased_args+=(--channel nightly)
generate() {
  HOME="$updates.home" CFFIXED_USER_HOME="$updates.home" \
    "$sparkle/generate_appcast" --ed-key-file "$key" ${phased_args[@]+"${phased_args[@]}"} \
    --maximum-deltas "$1" \
    --download-url-prefix "$download_prefix" \
    --embed-release-notes --full-release-notes-url "$RELEASE_NOTES_URL" \
    --link "$REPO_URL" -o "$updates/appcast.xml" "$updates" || return 1
  appcast only "$updates/appcast.xml" "$version" "$updates/built.xml" || return 1
}

zip_size="$(size_of "$zip")"
made=()
delta_files=()
check_deltas() {
  local lines from url length signature name file
  made=()
  delta_files=()
  lines="$(appcast deltas "$updates/built.xml" "$version")" || { problem="couldn't read the deltas generate_appcast listed"; return 1; }
  while read -r from url length signature; do
    [ -n "$from" ] || continue
    name="${url##*/}"
    file="$updates/$name"
    [ "$url" = "$download_prefix$name" ] || { problem="the delta from build $from points at $url, not at v$version's release"; return 1; }
    [[ "$name" =~ ^[A-Za-z0-9._-]+\.delta$ ]] || { problem="the delta from build $from is named $name, not <app><build>-<build>.delta"; return 1; }
    [ -f "$file" ] || { problem="the appcast lists $name, but generate_appcast didn't write it"; return 1; }
    is_signature "$signature" || { problem="$name has no well-formed sparkle:edSignature"; return 1; }
    [[ "$length" =~ ^[0-9]+$ ]] && [ "$length" = "$(size_of "$file")" ] || { problem="the appcast's length for $name is $length, the file is $(size_of "$file")"; return 1; }
    [ "$length" -gt 0 ] && [ "$length" -lt "$zip_size" ] || { problem="$name is $length bytes, not smaller than the $zip_size-byte zip"; return 1; }
    "$ed25519" verify "$file" "$signature" "$public_key" >/dev/null 2>&1 || { problem="$name's EdDSA signature doesn't verify with the app's SUPublicEDKey"; return 1; }
    made+=("$from")
    delta_files+=("$file")
  done <<<"$lines"
}

if [ "${#bases[@]}" -gt 0 ]; then
  if ! generate "${#bases[@]}"; then
    problem="generate_appcast failed with the earlier zips"
  else
    check_deltas || true
  fi
  if [ -n "$problem" ]; then
    annotate warning "$problem: $version ships without deltas, its appcast built again from the new zip alone"
    bases=()
    made=()
    delta_files=()
    fresh_updates
    generate 0 || die "generate_appcast failed on the new zip alone"
  fi
else
  generate 0 || die "generate_appcast failed"
fi
[ -z "$(appcast deltas "$updates/built.xml" "$version")" ] || [ "${#delta_files[@]}" -gt 0 ] \
  || die "the appcast built from the new zip alone lists deltas"
for file in ${delta_files[@]+"${delta_files[@]}"}; do mv "$file" "$dist/"; done
if [ -s "$base_feed" ]; then
  appcast merge "$base_feed" "$updates/built.xml" "$version" "$dist/appcast.xml"
else
  mv "$updates/built.xml" "$dist/appcast.xml"
fi
appcast item "$dist/appcast.xml" "$version" >/dev/null || die "appcast.xml has no single item for $version"

if [ "${#made[@]}" -gt 0 ]; then
  echo "PASS  ${#made[@]} signed Sparkle delta(s) for $version, from build(s) ${made[*]}"
  summary "Sparkle deltas: ${#made[@]} (from builds ${made[*]})"
  [ "${#made[@]}" -ge "${#bases[@]}" ] || echo "note: ${#bases[@]} earlier build(s) were there (${bases[*]}); generate_appcast skips a delta that isn't smaller than the zip"
elif [ -n "$problem" ]; then
  summary "Sparkle deltas: none ($problem)"
elif [ "${#bases[@]}" -gt 0 ]; then
  annotate warning "generate_appcast made no delta for $version from build(s) ${bases[*]}: every update downloads the whole zip"
  summary "Sparkle deltas: none, although builds ${bases[*]} were there to build them from"
elif [ "$wanted" -gt 0 ]; then
  annotate warning "none of the $wanted earlier zips to build deltas from could be used (above): $version ships without deltas"
  summary "Sparkle deltas: none (the earlier zips couldn't be downloaded or verified)"
else
  summary "Sparkle deltas: none (no earlier $channel release to build them from)"
fi
rm -rf "$updates" "$updates.home" "$tools"
