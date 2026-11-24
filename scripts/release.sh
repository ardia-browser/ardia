#!/usr/bin/env bash
set -euo pipefail

usage="usage: scripts/release.sh <version> [--rc] [--phased <seconds>] [--phase build|sign|check]  (a -nightly.<n> version is a nightly)"
version="${1:?$usage}"
shift
rc=0
phased=""
phase=all
while [ $# -gt 0 ]; do
  case "$1" in
    --rc) rc=1 ;;
    --phase)
      phase="${2:-}"
      shift
      case "$phase" in build | sign | check) ;; *) echo "error: --phase is build, sign or check, got '$phase'" >&2; exit 1 ;; esac
      ;;
    --phased)
      phased="${2:-}"
      shift
      case "$phased" in '' | *[!0-9]* | 0) echo "error: --phased takes whole seconds (86400 is a day), got '$phased'" >&2; exit 1 ;; esac
      ;;
    *) echo "error: unknown option $1 ($usage)" >&2; exit 1 ;;
  esac
  shift
done
[ "$rc" = 1 ] && [ -n "$phased" ] && { echo "error: a candidate is never published, so --phased doesn't apply to --rc" >&2; exit 1; }
stages="$(cd "$(dirname "$0")/release" && pwd -P)"
. "$stages/lib.sh"
. "$root/scripts/lib/paths.sh"
channel="$(channel_of "$version")"

if [ "$rc" = 1 ]; then dist="$root/dist/$version-rc"; else dist="$root/dist/$version"; fi
[ "$rc" = 1 ] && [ -n "${RC_DIST:-}" ] && dist="$(cd "$root" && mkdir -p "$RC_DIST" && cd "$RC_DIST" && pwd)"
app="$dist/export/Ardia.app"
build_input="${RELEASE_BUILD_INPUT:-}"
archive="$dist/Ardia.xcarchive"
[ "$phase" = sign ] && [ -n "$build_input" ] && archive="$build_input/Ardia.xcarchive"

if [ "$phase" = check ]; then
  [ -d "$app" ] || die "no $app: run --phase sign first"
  "$stages/launch-check.sh" "$app"
  echo "Launch check passed: $app"
  exit 0
fi

work="$(mktemp -d "${TMPDIR:-/tmp}/ac-release-work.XXXXXX")"
trap 'rm -rf "$work"' EXIT
base_feed="$work/appcast.xml"
preflight_mode=release
[ "$rc" = 1 ] && preflight_mode="${RELEASE_PREFLIGHT_MODE:-candidate}"
preflight_args=(--mode "$preflight_mode" --feed "${APPCAST_BASE:-$LATEST_DOWNLOAD_URL/appcast.xml}" --feed-out "$base_feed" --values-out "$work/values")
[ "${RELEASE_FEED_MAY_BE_MISSING:-0}" = 1 ] && preflight_args+=(--allow-no-feed)
node "$stages/preflight.mjs" "$version" "${preflight_args[@]}" || die "preflight stopped the release (above)"
checked() { sed -n "s/^$1=//p" "$work/values"; }
project_version="$(checked project_version)"
release_build="$(checked release_build)"
min_macos="$(checked min_macos)"
version_settings=()
[ "$project_version" = "$version" ] || version_settings=(MARKETING_VERSION="$version" CURRENT_PROJECT_VERSION="$release_build")

sparkle="${SPARKLE_BIN:-$macos/Pods/Sparkle/bin}"
sparkle_key_file="${SPARKLE_KEY_FILE:-}"
if [ "$phase" = build ]; then
  :
elif [ -n "$sparkle_key_file" ]; then
  [ -s "$sparkle_key_file" ] || die "SPARKLE_KEY_FILE ($sparkle_key_file) is missing or empty"
else
  if [ -n "${SPARKLE_ACCOUNT:-}" ]; then
    sparkle_account="$SPARKLE_ACCOUNT"
  else
    legacy_account="$("$root/scripts/lib/legacy-name.sh" appName | tr '[:upper:]' '[:lower:]')"
    sparkle_account=ardia
    for account in ardia $legacy_account; do
      if "$sparkle/generate_keys" --account "$account" -p >/dev/null 2>&1; then sparkle_account="$account"; break; fi
    done
  fi
  "$sparkle/generate_keys" --account "$sparkle_account" -p >/dev/null 2>&1 \
    || die "no Sparkle EdDSA key in the login keychain under account $sparkle_account (SPARKLE_ACCOUNT; docs/releasing.md)"
fi

framework_src="$chromium_framework"
[ "$phase" = sign ] && framework_src="$archive/Products/Applications/Ardia.app/Contents/Frameworks/Chromium Framework.framework"
[ "$phase" = sign ] && { [ -d "$archive" ] || die "no $archive: run --phase build first"; }
framework_engine="${ARDIACORE_FRAMEWORK_ENGINE:-}"
provisioning_profile="${RELEASE_PROVISIONING_PROFILE:-}"
read -r -a extra_build_settings <<<"${RELEASE_BUILD_SETTINGS:-}"

notes_body="$work/notes-body.md"
notes="$root/docs/release-notes/$version.md"
notes_video=""
if [ -f "$notes" ]; then
  note() { node "$root/scripts/lib/release-note.mjs" "$notes" "$1"; }
  headline="$(note headline)" || die "$notes: its frontmatter doesn't read (above)"
  notes_video="$(note video)"
  note body > "$notes_body"
elif [ "$rc" = 1 ]; then
  headline="Release candidate $version"
  echo "A release candidate of Ardia $version. Not published." > "$notes_body"
else
  die "no release notes: write docs/release-notes/$version.md first"
fi

dirty="$(git -C "$root" status --porcelain -- apps/browser packages engine scripts/dmg | grep -v ' apps/browser/build' || true)"
if [ -n "$dirty" ]; then
  [ "$rc" = 1 ] || { echo "$dirty" >&2; die "uncommitted changes under apps/browser, packages, engine or scripts/dmg (above)"; }
  echo "warning: the candidate includes uncommitted changes:" >&2
  echo "$dirty" >&2
fi

[ -d "$framework_src" ] || die "no ArdiaCore framework at $framework_src (engine/ardiacore/apply.sh, then build chrome_framework)"
[ "$phase" = sign ] || [[ " $(lipo -archs "$framework_src/Versions/Current/Chromium Framework" 2>/dev/null) " == *" arm64 "* ]] \
  || die "the ArdiaCore framework at $framework_src has no arm64 slice"
if [ "$phase" = sign ]; then
  [ -n "$provisioning_profile" ] || die "--phase sign exports the ad hoc archive --phase build made: set RELEASE_PROVISIONING_PROFILE"
elif [ -n "$framework_engine" ]; then
  [ -n "${ARDIACORE_FRAMEWORK:-}" ] || die "ARDIACORE_FRAMEWORK_ENGINE names the engine key (engine/engine-key.sh --platform macos) a prebuilt ARDIACORE_FRAMEWORK was built from; set both or neither"
  head_engine="$("$root/engine/engine-key.sh" --platform macos)"
  [ "$framework_engine" = "$head_engine" ] \
    || die "ARDIACORE_FRAMEWORK_ENGINE is $framework_engine but HEAD's macOS engine key is $head_engine: that framework wasn't built from this commit's engine"
fi
if [ "$phase" = all ] && [ -z "${ARDIACORE_FRAMEWORK:-}" ]; then
  "$root/scripts/lib/engine-fresh.sh" "$framework_src" "$chromium_src" || exit 1
fi

engine_source=""
if [ "$phase" != build ]; then
  engine_tree="$("$root/engine/engine-key.sh" --platform macos)"
  read -r engine_release engine_built <<<"$(awk -v t="$engine_tree" '$1 == t { print $2, ($4 == "" ? $1 : $4); exit }' "$ardiacore/prebuilt-engines.tsv")"
  [ "$rc" = 1 ] || [ -n "$engine_release" ] \
    || die "packages/ardiacore/prebuilt-engines.tsv lists no published engine for this engine key (${engine_tree:0:12}): publish it with scripts/publish-engine.sh, commit the table line, then release"
  case "$engine_release" in engine-*) engine_tag="$engine_release" ;; *) engine_tag="v$engine_release" ;; esac
  [ -n "$engine_release" ] \
    && engine_source="$REPO_URL/releases/download/$engine_tag/ArdiaCore-${engine_built:0:12}-source.tar.xz"

  identity_name="Developer ID Application"
  identity="$(security find-identity -v -p codesigning | awk -v n="$identity_name" 'index($0, n) { print $2; exit }')"
  [ -n "$identity" ] || die "no $identity_name identity"
  load_notary_auth
  notarize=0
  if xcrun notarytool history "${notary_auth[@]}" >/dev/null 2>&1; then
    notarize=1
  elif [ "${ALLOW_UNNOTARIZED:-0}" = 1 ]; then
    echo "warning: no notarytool credentials; the build won't be notarized" >&2
  else
    echo "error: notarytool credentials are missing or invalid (scripts/.notary.env or the '${NOTARY_PROFILE:-ardia}' profile):" >&2
    xcrun notarytool history "${notary_auth[@]}" 2>&1 | head -2 >&2
    exit 1
  fi
fi

if [ "$phase" != sign ]; then
  rm -rf "$dist"
  mkdir -p "$dist"
  {
    echo "version $version, build $release_build, $channel${version_settings:+ (${version_settings[*]})}"
    echo "commit $(git -C "$root" rev-parse HEAD)${dirty:+ + uncommitted changes}"
    python3 -I "$stages/official-plugins.py" describe
    echo "framework $(plutil -extract SCMRevision raw "$framework_src/Versions/Current/Resources/Info.plist" 2>/dev/null)"
    echo "framework built $(stat -f '%Sm' "$framework_src/Versions/Current/Chromium Framework")"
  } > "$dist/provenance.txt"
  if [ -n "$provisioning_profile" ] || [ "$phase" = build ]; then archive_signing=adhoc; else archive_signing=xcode; fi
  "$stages/archive.sh" "$dist" "$framework_src" "${RELEASE_BUILD_DIR:-$root/apps/browser/build-release}" "$archive_signing" \
    ${version_settings[@]+"${version_settings[@]}"} AC_UPDATE_CHANNEL="$channel" \
    ${extra_build_settings[@]+"${extra_build_settings[@]}"}
fi
if [ "$phase" = build ]; then
  echo
  echo "Built $archive (signed ad hoc); sign it with --phase sign. Official plugins aren't bundled: Install fetches the pinned ones."
  exit 0
fi
if [ "$phase" = sign ] && [ -n "$build_input" ]; then
  rm -rf "$dist"
  mkdir -p "$dist"
  [ -f "$build_input/provenance.txt" ] && [ ! -L "$build_input/provenance.txt" ] || die "no provenance.txt in $build_input"
  cp "$build_input/provenance.txt" "$dist/provenance.txt"
fi

"$stages/export-sign.sh" "$dist" "$archive" "$identity" ${provisioning_profile:+"$provisioning_profile"}
"$stages/verify.sh" "$app" "$archive" "$version" "$release_build"
echo "==> Pack app symbols"
"$root/scripts/lib/pack-symbols.sh" --app "$app" "$archive/dSYMs" "$dist/$(app_symbols_name "$version")" "$dist/$(app_uuids_name "$version")"
[ "$phase" = sign ] || "$stages/launch-check.sh" "$app"
if [ "$notarize" = 1 ]; then
  echo "==> Notarize app"
  "$stages/notarize.sh" "$app" "$dist"
fi
"$stages/package.sh" "$dist" "$version" "$identity"
[ "$notarize" = 1 ] && "$stages/notarize.sh" "$dist/Ardia-$version.dmg" "$dist"

echo "==> Release notes"
notes_args=()
[ "$notarize" = 1 ] && notes_args+=(--notarized)
[ -n "$notes_video" ] && notes_args+=(--video "$notes_video")
[ -n "$engine_source" ] && notes_args+=(--engine-source "$engine_source")
"$stages/notes.sh" "$version" "$notes_body" "$min_macos" ${notes_args[@]+"${notes_args[@]}"} > "$dist/release-notes.md"

if [ -z "$sparkle_key_file" ]; then
  sparkle_key_file="$work/sparkle-key"
  "$sparkle/generate_keys" --account "$sparkle_account" -x "$sparkle_key_file" >/dev/null
fi
SPARKLE_BIN="$sparkle" SPARKLE_KEY_FILE="$sparkle_key_file" "$stages/appcast.sh" "$dist" "$version" "$headline" "$notes_body" "$base_feed" ${phased:+"$phased"}

echo
[ "$notarize" = 1 ] && echo "Notarized and stapled." || echo "NOT notarized."
[ "$rc" = 1 ] && echo "Release candidate: never publish dist/$version-rc."
[ "$channel" = nightly ] && [ "$rc" = 0 ] && echo "Nightly: publish it with .claude/skills/release/scripts/publish.sh $version (a prerelease; the feed and ardia.dev/nightly follow)."
[ "$phase" = sign ] && echo "Not launched yet: remove the signing keys, then run the launch check (--phase check)."
[ -n "$phased" ] && echo "Phased rollout: $phased s between steps (the appcast item has phasedRolloutInterval; the whole release takes $((phased * 7)) s)."
du -sh "$app" "$dist/Ardia-$version.dmg" "$dist/Ardia-$version.zip" "$dist/appcast.xml" "$dist/release-notes.md"
