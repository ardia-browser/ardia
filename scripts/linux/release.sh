#!/usr/bin/env bash
set -euo pipefail
usage='usage: scripts/linux/release.sh <version> [--engine exact|nearest|<dir>] [--out <dir>] [--allow-dirty]

Builds the Linux x64 release of Ardia <version> (a -nightly.<n> version is a
nightly), the Linux counterpart of scripts/release.sh: it fetches the engine,
builds apps/linux/dist and the ardia CLI, prepares uBlock Origin, packages
Ardia-<version>-linux-x64.tar.xz with lib/ardia/VERSION and the CLI, and the
same build as Ardia-<version>-linux-x64.deb and .AppImage, writes
ardia-bin-<version>.src.tar.gz (the Arch PKGBUILD and .SRCINFO pinned to that
tarball), the .sha256 files and provenance.txt, and runs the smoke gate on
the tarball, the .deb and the AppImage. It never publishes: it prints the
gh release upload command for the assets.

  --engine exact     the published engine of this commit'"'"'s engine key (default;
                     a release must match its source)
  --engine nearest   the nearest earlier published engine: a test build
  --engine DIR       an engine dir (chrome and manifest.json) or a Chromium out
                     dir, read only: a test build unless its manifest names
                     this commit'"'"'s engine key (engine/engine-key.sh)
  --out DIR          where the assets go (default dist/<version>/linux); an
                     existing DIR must be empty or an earlier output of this script
  --allow-dirty      build with uncommitted changes under apps/browser,
                     apps/linux, packages, engine or scripts/linux
                     (a test build, never a release)
  -h, --help         show this help

It needs MARKETING_VERSION to be <version> and docs/release-notes/<version>.md,
as scripts/release.sh does: the Linux assets go on the GitHub release the
macOS release made. pnpm comes from PATH, else
~/ardia-linux-build-156/tools/pnpm/node_modules/.bin. The .deb needs dpkg-deb
and readelf (apt install dpkg binutils, pacman -S dpkg binutils).'

die() { echo "release.sh: $*" >&2; exit 1; }
warn() { echo "warning: $*" >&2; }

version=""
engine_mode=exact
out=""
allow_dirty=0
while [ $# -gt 0 ]; do
  case "$1" in
    -h|--help) echo "$usage"; exit 0 ;;
    --engine) [ $# -ge 2 ] || die "--engine needs exact, nearest or a directory"; engine_mode=$2; shift 2 ;;
    --out) [ $# -ge 2 ] || die "--out needs a directory"; out=$2; shift 2 ;;
    --allow-dirty) allow_dirty=1; shift ;;
    -*) echo "$usage" >&2; exit 64 ;;
    *) [ -z "$version" ] || { echo "$usage" >&2; exit 64; }; version=$1; shift ;;
  esac
done
[ -n "$version" ] || { echo "$usage" >&2; exit 64; }

root=$(cd "$(dirname "$0")/../.." && pwd -P)
. "$root/scripts/lib/releases.sh"
channel=$(channel_of "$version") || exit 1
cd "$root"

pbx=apps/browser/macos/Ardia.xcodeproj/project.pbxproj
project_version=$(sed -n 's/.*MARKETING_VERSION = "\{0,1\}\([^";]*\)"\{0,1\};/\1/p' "$pbx" | sort -u)
[ "$project_version" = "$version" ] \
  || die "MARKETING_VERSION is '$project_version', not $version: the Linux release follows the macOS release of the same version"
[ -f "docs/release-notes/$version.md" ] || die "no release notes: write docs/release-notes/$version.md first"

dirty=$(git status --porcelain -- apps/browser apps/linux packages engine scripts/linux | grep -v ' apps/browser/build' || true)
if [ -n "$dirty" ]; then
  echo "$dirty" >&2
  [ "$allow_dirty" = 1 ] || die "uncommitted changes under apps/browser, apps/linux, packages, engine or scripts/linux (above)"
  warn "building with the uncommitted changes above: a test build, never a release"
fi

if ! command -v pnpm >/dev/null; then
  fallback="$HOME/ardia-linux-build-156/tools/pnpm/node_modules/.bin"
  [ -x "$fallback/pnpm" ] || die "pnpm is neither on PATH nor in $fallback"
  PATH="$fallback:$PATH"
fi
for tool in node python3 sha256sum tar xz git dpkg-deb readelf; do
  command -v "$tool" >/dev/null || die "$tool is required"
done
node scripts/lib/release-note.mjs "docs/release-notes/$version.md" headline >/dev/null \
  || die "docs/release-notes/$version.md: its frontmatter doesn't read (above)"

release_output_entry() {
  case $1 in
    provenance.txt|ui-build.log|ubo.log|smoke|smoke-deb|smoke-appimage) return 0 ;;
    Ardia-*-linux-x64.tar.xz|Ardia-*-linux-x64.tar.xz.sha256) return 0 ;;
    Ardia-*-linux-x64.deb|Ardia-*-linux-x64.deb.sha256|Ardia-*-linux-x64.AppImage|Ardia-*-linux-x64.AppImage.sha256) return 0 ;;
    ardia-bin-*.src.tar.gz|ardia-bin-*.src.tar.gz.sha256) return 0 ;;
    ardia-cli-*-linux-x64.tar.gz|ardia-cli-*-linux-x64.tar.gz.sha256) return 0 ;;
  esac
  return 1
}

out=${out:-$root/dist/$version/linux}
if [ -e "$out" ]; then
  [ -d "$out" ] || die "$out is not a directory"
  if [ -n "$(ls -A "$out")" ]; then
    [ -f "$out/provenance.txt" ] || die "$out is neither empty nor an earlier Linux release output (no provenance.txt): choose another --out"
    while IFS= read -r -d '' entry; do
      release_output_entry "${entry##*/}" || die "$out holds ${entry##*/}, which a Linux release build never writes: move it away or choose another --out"
    done < <(find "$out" -mindepth 1 -maxdepth 1 -print0)
  fi
  rm -rf "$out"
fi
mkdir -p "$out"
out=$(cd "$out" && pwd -P)
package_name="Ardia-$version-linux-x64.tar.xz"
deb_name="Ardia-$version-linux-x64.deb"
appimage_name="Ardia-$version-linux-x64.AppImage"
cli_name="ardia-cli-$version-linux-x64.tar.gz"
srcpkg_name="ardia-bin-$version.src.tar.gz"
export SOURCE_DATE_EPOCH=${SOURCE_DATE_EPOCH:-$(git log -1 --format=%ct)}

echo "==> Engine ($engine_mode)"
case "$engine_mode" in
  exact) engine=$(packages/ardiacore/scripts/fetch-engine.sh --arch linux-x86_64) || die "no published Linux engine for this commit's engine key: publish it with scripts/linux/publish-engine.sh --upload (docs/linux-ci.md)" ;;
  nearest) engine=$(packages/ardiacore/scripts/fetch-engine.sh --arch linux-x86_64 --nearest) || die "no published Linux engine near this commit's engine key" ;;
  "") die "--engine needs exact, nearest or a directory" ;;
  *) [ -d "$engine_mode" ] || die "--engine $engine_mode is neither exact, nearest nor a directory"; engine=$(cd "$engine_mode" && pwd -P) ;;
esac
head_key=$(engine/engine-key.sh) || die "couldn't compute this commit's engine key (engine/engine-key.sh)"
manifest_field() {
  python3 -I -c 'import json, sys; print(json.load(open(sys.argv[1])).get(sys.argv[2]) or "")' "$engine/manifest.json" "$1" 2>/dev/null || true
}
engine_key=""
chromium_version=""
engine_commit=""
if [ -f "$engine/manifest.json" ]; then
  engine_key=$(manifest_field engine_key)
  chromium_version=$(manifest_field chromium_version)
  engine_commit=$(manifest_field source_commit)
elif [ -f "$engine/../../chrome/VERSION" ]; then
  chromium_version=$(awk -F= '{ v[$1] = $2 } END { print v["MAJOR"] "." v["MINOR"] "." v["BUILD"] "." v["PATCH"] }' "$engine/../../chrome/VERSION")
fi
exact=0
[ "$engine_key" = "$head_key" ] && exact=1
engine_label=${engine_key:0:12}
engine_label=${engine_label:-"without a manifest"}
if [ "$exact" = 1 ]; then
  echo "    engine $engine_label (exact), Chromium ${chromium_version:-unknown}: $engine"
else
  [ "$engine_mode" = exact ] && die "the fetched engine names engine key '${engine_key:-none}', not this commit's $head_key"
  warn "the engine ($engine_label, Chromium ${chromium_version:-unknown}) isn't this commit's ${head_key:0:12}: a test build, not a release"
fi

echo "==> UI (apps/linux/dist)"
pnpm --filter @ardia/linux build >"$out/ui-build.log" 2>&1 \
  || { tail -20 "$out/ui-build.log" >&2; die "building apps/linux/dist failed ($out/ui-build.log)"; }

echo "==> ardia command (pinned in apps/browser/official-plugins.json)"
python3 -I scripts/release/official-plugins.py ${OFFICIAL_PLUGINS_FROM:+--from "$OFFICIAL_PLUGINS_FROM"} linux-cli "$version" "$out/$cli_name" \
  || die "the pinned ardia command couldn't be fetched and verified"

echo "==> uBlock Origin"
blocker=$(scripts/linux/fetch-ubo.sh 2>"$out/ubo.log") \
  || { tail -20 "$out/ubo.log" >&2; die "preparing uBlock Origin failed ($out/ubo.log)"; }

echo "==> Package"
python3 scripts/linux/package.py --out "$engine" --ui apps/linux/dist --content-blocker "$blocker" \
  --version "$version" --cli "$out/$cli_name" --destination "$out/$package_name" \
  --deb "$out/$deb_name" --appimage "$out/$appimage_name" >/dev/null
srcpkg=$(mktemp -d)
scripts/linux/arch/update-pkgbuild.sh "$version" --package "$out/$package_name" --out "$srcpkg/ardia-bin" >/dev/null \
  || { rm -rf "$srcpkg"; die "writing the Arch PKGBUILD for $package_name failed (above)"; }
tar --sort=name --owner=0 --group=0 --numeric-owner --mtime="@$SOURCE_DATE_EPOCH" -C "$srcpkg" -cf - ardia-bin \
  | gzip -n -9 > "$out/$srcpkg_name"
rm -rf "$srcpkg"
for built in "$package_name" "$deb_name" "$appimage_name" "$srcpkg_name"; do
  (cd "$out" && sha256sum "$built" > "$built.sha256")
done

{
  echo "version $version, $channel, linux-x64"
  echo "commit $(git rev-parse HEAD)${dirty:+ + uncommitted changes}"
  echo "engine key ${engine_key:-unknown} ($([ "$exact" = 1 ] && echo exact || echo "not this commit's $head_key")), from $engine"
  echo "engine source commit ${engine_commit:-unknown}"
  echo "chromium ${chromium_version:-unknown}"
  echo "package $(cut -d' ' -f1 "$out/$package_name.sha256")  $package_name"
  echo "deb $(cut -d' ' -f1 "$out/$deb_name.sha256")  $deb_name"
  echo "appimage $(cut -d' ' -f1 "$out/$appimage_name.sha256")  $appimage_name"
  echo "arch $(cut -d' ' -f1 "$out/$srcpkg_name.sha256")  $srcpkg_name"
  echo "cli $(cut -d' ' -f1 "$out/$cli_name.sha256")  $cli_name, from $(python3 -I scripts/release/official-plugins.py describe | grep '^plugin cli ')"
} > "$out/provenance.txt"

echo "==> Smoke"
smoke_extra=()
[ "$exact" = 1 ] || smoke_extra+=(--allow-old-engine)
node scripts/linux/smoke.mjs --package "$out/$package_name" --results "$out/smoke" --timeout-ms 600000 "${smoke_extra[@]}" \
  || die "the smoke gate failed ($out/smoke/results.json)"
node scripts/linux/smoke.mjs --package "$out/$deb_name" --results "$out/smoke-deb" --timeout-ms 600000 "${smoke_extra[@]}" \
  || die "the smoke gate failed for the .deb ($out/smoke-deb/results.json)"
node scripts/linux/smoke.mjs --package "$out/$appimage_name" --results "$out/smoke-appimage" --timeout-ms 600000 "${smoke_extra[@]}" \
  || die "the smoke gate failed for the AppImage ($out/smoke-appimage/results.json)"

echo
[ "$exact" = 1 ] || echo "NOT a release: built against engine $engine_label, not this commit's ${head_key:0:12}."
[ -z "$dirty" ] || echo "NOT a release: built with uncommitted changes."
du -sh "$out/$package_name" "$out/$deb_name" "$out/$appimage_name" "$out/$srcpkg_name" "$out/$cli_name"
echo
echo "Publish it on the v$version release (made by the macOS release) with:"
printf '  gh release upload v%s -R %s %q %q %q %q %q %q %q %q %q %q\n' "$version" "$REPO" \
  "$out/$package_name" "$out/$package_name.sha256" "$out/$deb_name" "$out/$deb_name.sha256" \
  "$out/$appimage_name" "$out/$appimage_name.sha256" "$out/$srcpkg_name" "$out/$srcpkg_name.sha256" "$out/$cli_name" "$out/$cli_name.sha256"
if [ "$channel" = stable ]; then
  echo "then, unless the Release workflow's aur job did it, move the AUR package to it (docs/linux-ci.md › The AUR):"
  printf '  scripts/linux/arch/publish-aur.sh %s --package %q\n' "$version" "$out/$package_name"
fi
