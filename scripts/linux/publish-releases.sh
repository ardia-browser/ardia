#!/usr/bin/env bash
set -euo pipefail
usage='usage: scripts/linux/publish-releases.sh [--repo OWNER/NAME] [--out DIR] [--dry-run]

Publishes the release list installed Linux apps check for updates as
releases.json on the GitHub prerelease linux-releases (never latest). Apps read
it from https://github.com/<repo>/releases/download/linux-releases/releases.json,
a release download with no API rate limit. The list is the repository'"'"'s last
100 published releases, each with its tag, page, prerelease flag and asset
names. Run it again after uploading Linux packages to a release by hand.

  --repo      the repository (default: $GITHUB_REPOSITORY, else
              ardia-browser/ardia)
  --out       also keep releases.json in this directory
  --dry-run   write releases.json, print the gh commands, publish nothing'

die() { echo "publish-releases.sh: $*" >&2; exit 1; }

repo=${GITHUB_REPOSITORY:-ardia-browser/ardia}
out=""
dry=0
while [ $# -gt 0 ]; do
  case "$1" in
    -h|--help) echo "$usage"; exit 0 ;;
    --repo|--out) [ $# -ge 2 ] || die "$1 needs a value"; [ "$1" = --repo ] && repo=$2 || out=$2; shift 2 ;;
    --dry-run) dry=1; shift ;;
    *) echo "$usage" >&2; exit 64 ;;
  esac
done

tag=linux-releases
work=$(mktemp -d "${TMPDIR:-/tmp}/ardia-linux-releases.XXXXXX")
trap 'rm -rf "$work"' EXIT
run() {
  if [ "$dry" = 1 ]; then printf '+ %s\n' "$*"; else "$@"; fi
}

gh api "repos/$repo/releases?per_page=100" \
  --jq '[.[] | select(.draft | not) | {tag_name, html_url, prerelease, assets: [.assets[] | {name}]}]' >"$work/releases.json"
count=$(jq length "$work/releases.json")
[ "$count" -gt 0 ] || die "GitHub listed no published releases for $repo"
[ -z "$out" ] || { mkdir -p "$out"; cp "$work/releases.json" "$out/releases.json"; }

notes="$work/notes.md"
echo "The release list installed Linux apps read to check for updates. Not a release to download." >"$notes"
if [ "$dry" = 1 ] || ! gh release view "$tag" -R "$repo" >/dev/null 2>&1; then
  run gh release create "$tag" -R "$repo" --prerelease --latest=false --title "Linux update feed" --notes-file "$notes"
fi
run gh release upload "$tag" -R "$repo" --clobber "$work/releases.json"
run gh release edit "$tag" -R "$repo" --prerelease --latest=false
if [ "$dry" = 0 ]; then
  [ "$(gh release view "$tag" -R "$repo" --json isPrerelease -q .isPrerelease)" = true ] || die "$tag isn't a prerelease"
fi
echo "releases.json: $count releases"
