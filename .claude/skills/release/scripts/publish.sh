#!/usr/bin/env bash
set -euo pipefail

usage="usage: publish.sh <version> [--dry-run] [--break-lock]"
version="${1:?$usage}"
shift
dry=0
break_lock=0
for arg in "$@"; do
  case "$arg" in
    --dry-run) dry=1 ;;
    --break-lock) break_lock=1 ;;
    *) echo "error: unknown option $arg ($usage)" >&2; exit 1 ;;
  esac
done
here="$(cd "$(dirname "$0")" && pwd)"
root="$(git -C "$here" rev-parse --show-toplevel)"
. "$root/scripts/lib/releases.sh"
. "$root/scripts/lib/paths.sh"
dist="${RELEASE_DIST:-$root/dist/$version}"
die() { echo "error: $*" >&2; exit 1; }
run() {
  echo "+ $*"
  [ "$dry" = 1 ] || "$@"
}

channel="$(channel_of "$version")"
feed_name="appcast$engine_suffix.xml"
dmg="$dist/Ardia-$version$engine_suffix.dmg"
zip="$dist/Ardia-$version$engine_suffix.zip"
feed="$dist/$feed_name"
cli="$dist/ardia-cli-$version-macos-arm64.tar.gz"

assets=("$dmg" "$zip" "$feed")
[ -z "$engine_suffix" ] && assets+=("$cli" "$cli.sha256")
for file in "${assets[@]}"; do
  [ -f "$file" ] || die "no $file (scripts/release.sh $version first)"
done
linux="$dist/linux"
if [ -d "$linux" ]; then
  linux_package="$linux/Ardia-$version-linux-x64.tar.xz"
  linux_cli="$linux/ardia-cli-$version-linux-x64.tar.gz"
  linux_deb="$linux/Ardia-$version-linux-x64.deb"
  linux_appimage="$linux/Ardia-$version-linux-x64.AppImage"
  linux_arch="$linux/ardia-bin-$version.src.tar.gz"
  provenance="$linux/provenance.txt"
  [ -f "$provenance" ] || die "$linux has no provenance.txt"
  grep -q '^engine key [0-9a-f]\{40\} (exact)' "$provenance" && ! grep -q 'uncommitted changes' "$provenance" \
    || die "$linux is a Linux test build (an inexact engine or uncommitted changes, $provenance), not a release"
  linux_files=("$linux_package" "$linux_appimage" "$linux_arch" "$linux_cli")
  if grep -q '^deb dropped' "$provenance"; then
    echo "note: $(grep -m1 '^deb dropped' "$provenance"): the release ships without the .deb"
  else
    linux_files+=("$linux_deb")
  fi
  linux_sums=()
  for file in "${linux_files[@]}"; do
    for asset in "$file" "$file.sha256"; do
      [ -f "$asset" ] || die "$linux has no $(basename "$asset") (scripts/linux/release.sh $version first, or remove $linux to publish without Linux)"
      assets+=("$asset")
    done
    linux_sums+=("${file##*/}.sha256")
  done
  (cd "$linux" && shasum -a 256 -c --quiet "${linux_sums[@]}") \
    || die "the Linux assets in $linux don't match their .sha256 files"
  echo "PASS  the Linux assets join the release: ${linux_files[*]##*/}"
else
  echo "note: no $linux: the release ships without the Linux tarball"
fi
windows="$dist/windows"
if [ -d "$windows" ]; then
  windows_assets=()
  for cpu in x64 arm64; do
    windows_setup="Ardia-$version-windows-$cpu-setup.exe"
    for file in "$windows/$windows_setup" "$windows/$windows_setup.sha256"; do
      [ -f "$file" ] || die "$windows has no $(basename "$file") (the Release workflow's windows job makes them, or remove $windows to publish without Windows)"
    done
    windows_assets+=("$windows_setup")
  done
  windows_source="Ardia-$version-windows-source.tar.xz"
  for file in "$windows/$windows_source" "$windows/$windows_source.sha256"; do
    [ -f "$file" ] || die "$windows has no $(basename "$file"): the installers ship only beside their engine's source"
  done
  windows_assets+=("$windows_source")
  stamped_version="$(python3 -I -c 'import json, sys; print(json.load(open(sys.argv[1]))["version"])' "$windows/Ardia.build.json" 2>/dev/null)" \
    || die "$windows has no readable Ardia.build.json"
  [ "$stamped_version" = "$version" ] || die "the Windows installers in $windows are Ardia $stamped_version, not $version"
  (cd "$windows" && for file in "${windows_assets[@]}"; do shasum -a 256 -c --quiet "$file.sha256" || exit 1; done) \
    || die "the Windows files in $windows don't match their .sha256 files"
  for file in "${windows_assets[@]}"; do assets+=("$windows/$file" "$windows/$file.sha256"); done
  echo "PASS  the Windows installers and their engine's source join the release"
else
  echo "note: no $windows: the release ships without the Windows installers"
fi
item_channel="$(appcast channel "$feed" "$version")"
[ "$item_channel" = "$channel" ] || die "$version's item in $feed is on the $item_channel channel, not $channel"
[ -f "$dist/release-notes.md" ] || die "no $dist/release-notes.md"
if ! git -C "$root" ls-remote --exit-code --tags origin "refs/tags/v$version" >/dev/null 2>&1; then
  [ "$dry" = 1 ] && echo "note: v$version isn't on origin yet (git tag v$version && git push origin main v$version)" \
    || die "push the tag first: git tag v$version && git push origin main v$version"
fi
. "$here/publish-lock.sh"

work="$(mktemp -d "${TMPDIR:-/tmp}/ac-publish.XXXXXX")"
trap 'release_lock; rm -rf "$work"' EXIT
trap 'exit 130' INT TERM HUP
take_lock "$version" "$dry" "$break_lock"
stable_tag="$(latest_stable_tag)"

built="$dist/appcast$engine_suffix.built.xml"
[ -f "$built" ] || cp "$feed" "$built"
merged="$feed"
[ "$dry" = 1 ] && merged="$work/$feed_name"
if download_live_feed "$stable_tag" "$work/live" "$feed_name"; then
  appcast merge "$work/live/$feed_name" "$built" "$version" "$merged"
else
  echo "note: $stable_tag has no $feed_name yet: $version starts it"
  cp "$built" "$merged"
fi
appcast check-above "$merged" "$version"
if [ "$channel" = stable ]; then
  latest_version="${stable_tag#v}"
  [ "$version" != "$latest_version" ] && [ "$(printf '%s\n%s\n' "$latest_version" "$version" | sort -V | tail -1)" = "$version" ] \
    || die "$version isn't above the latest stable release ($latest_version): publishing it as latest would move every download and feed backward"
  echo "PASS  $version is above the latest stable release ($latest_version)"
fi

if [ -n "$engine_suffix" ]; then
  gh release view "v$version" -R "$REPO" >/dev/null 2>&1 \
    || die "publish the arm64 build of $version first: the $ardia_arch build joins its release"
  run gh release upload "v$version" -R "$REPO" --clobber "$dmg" "$zip"
  if [ "$channel" = nightly ]; then
    cp -c "$dmg" "$work/Ardia-Nightly$engine_suffix.dmg"
    run gh release upload nightly -R "$REPO" --clobber "$work/Ardia-Nightly$engine_suffix.dmg"
  fi
  run gh release upload "$stable_tag" -R "$REPO" --clobber "$merged"
  [ "$dry" = 1 ] && { echo "dry run: nothing published"; exit 0; }
  status=0
  for url in "$LATEST_DOWNLOAD_URL/$feed_name" "https://ardia.dev/$feed_name"; do
    for _ in $(seq 1 18); do
      xml="$(curl -fsSL --max-time 20 "$url" 2>/dev/null || true)"
      grep -q "<sparkle:shortVersionString>$version<" <<<"$xml" && break
      sleep 10
    done
    grep -q "<sparkle:shortVersionString>$version<" <<<"$xml" && echo "PASS  $url lists $version" \
      || { echo "FAIL  $url lists $version"; status=1; }
  done
  exit $status
fi

if [ "$channel" = nightly ]; then
  release_flags=(--prerelease --latest=false)
else
  release_flags=(--latest)
  if download_live_feed "$stable_tag" "$work/intel" appcast-x86_64.xml; then
    assets+=("$work/intel/appcast-x86_64.xml")
    echo "PASS  $stable_tag's appcast-x86_64.xml moves to v$version, so Intel copies keep their feed"
  fi
fi
run gh release create "v$version" -R "$REPO" "${release_flags[@]}" --verify-tag --title "Ardia $version" \
  --notes-file "$dist/release-notes.md" "${assets[@]}"
if [ "$channel" = nightly ]; then
  nightly_notes="The newest nightly, always as Ardia-Nightly.dmg (https://ardia.dev/nightly). Now $version: its notes and source are at $REPO_URL/releases/tag/v$version. Every nightly's notes: $RELEASE_NOTES_URL"
  if ! gh release view nightly -R "$REPO" >/dev/null 2>&1; then
    run gh release create nightly -R "$REPO" --prerelease --latest=false --title "Ardia Nightly" --notes "$nightly_notes"
  fi
  cp -c "$dmg" "$work/Ardia-Nightly.dmg"
  run gh release upload nightly -R "$REPO" --clobber "$work/Ardia-Nightly.dmg"
  run gh release edit nightly -R "$REPO" --notes "$nightly_notes"
  run gh release upload "$stable_tag" -R "$REPO" --clobber "$merged"
fi

tap() { [ "${PUBLISH_TAP:-1}" = 0 ] && { echo "note: the Homebrew tap is left alone (PUBLISH_TAP=0): run update-tap.sh $version"; return 0; }; "$here/update-tap.sh" "$@"; }
[ "$dry" = 1 ] && { tap "$version" --dry-run || true; echo "dry run: nothing published"; exit 0; }
status=0
for url in "$LATEST_DOWNLOAD_URL/appcast.xml" "https://ardia.dev/appcast.xml"; do
  for _ in $(seq 1 18); do
    xml="$(curl -fsSL --max-time 20 "$url" 2>/dev/null || true)"
    grep -q "<sparkle:shortVersionString>$version<" <<<"$xml" && break
    sleep 10
  done
  grep -q "<sparkle:shortVersionString>$version<" <<<"$xml" && echo "PASS  $url lists $version" \
    || { echo "FAIL  $url lists $version"; status=1; }
done
if [ "$channel" = nightly ]; then
  url="$NIGHTLY_DMG_URL"
  size="$(curl -fsSLI --max-time 30 "$url" | awk 'tolower($1) == "content-length:" { n = $2 } END { print n + 0 }')"
  [ "$size" = "$(stat -f %z "$dmg")" ] && echo "PASS  $url is $version's DMG" \
    || { echo "FAIL  $url is $version's DMG (size $size, expected $(stat -f %z "$dmg"))"; status=1; }
  to="$(curl -s -o /dev/null --max-time 15 -w '%{redirect_url}' https://ardia.dev/nightly || true)"
  [ "$to" = "$NIGHTLY_DMG_URL" ] && echo "PASS  https://ardia.dev/nightly leads there" \
    || { echo "FAIL  https://ardia.dev/nightly leads there (goes to ${to:-nothing}: deploy the site, infra/site/nginx.conf)"; status=1; }
fi
tap "$version" || { echo "FAIL  the Homebrew tap's cask is $version"; status=1; }
exit $status
