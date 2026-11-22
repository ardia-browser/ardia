#!/usr/bin/env bash
set -euo pipefail
usage='usage: scripts/linux/fetch-engine.sh [--nearest]
       packages/ardiacore/scripts/fetch-engine.sh --arch linux-x86_64 [--nearest]

Downloads, verifies and caches the prebuilt Linux x64 ArdiaCore engine whose
engine key (engine/engine-key.sh --platform linux: engine/ but for the mac
lines of the series, and the offline game it packs) matches this checkout
(scripts/linux/publish-engine.sh makes them), and prints
the engine directory (the one holding chrome and manifest.json) for
scripts/linux/package.py --out.

  --nearest   when this engine key has no published engine, use the one of
              the nearest earlier commit that changed a path the key covers,
              with a warning

Rows come from packages/ardiacore/prebuilt-engines-linux.tsv
(key<TAB>tag<TAB>sha256[<TAB>built key]), then from the published table. A
row with a built key serves an engine published under that other key (one the
engine key changed from) built from the sources of this key. The .complete of
a cached engine holds the archive SHA-256 and, below it, the row it was
fetched and verified for, so scripts/linux/runtime_files.py serves can tell it
is the exact engine of this key whichever table the row came from, and a cached
engine is found again with no table at hand.
Environment:
  ARDIACORE_PREBUILT_REPO          GitHub repo (default ardia-browser/ardia)
  ARDIACORE_PREBUILT_ASSETS        asset base URL (default
                                   https://github.com/$repo/releases/download)
  ARDIACORE_PREBUILT_TABLE_URL     published table URL, or none (default the
                                   copy on the main branch of $repo)
  ARDIACORE_PREBUILT_LINUX_TABLE   local table path (default the checked-in one)
Engines are cached in apps/browser/build-ardiacore/prebuilt-linux-x86_64.'
nearest=0
case "${1:-}" in
  -h|--help) echo "$usage"; exit 0 ;;
  "") ;;
  --nearest) nearest=1 ;;
  *) echo "$usage" >&2; exit 64 ;;
esac
[ $# -le 1 ] || { echo "$usage" >&2; exit 64; }

here=$(cd "$(dirname "$0")" && pwd)
root=$(cd "$here/../.." && pwd)
repo=${ARDIACORE_PREBUILT_REPO:-ardia-browser/ardia}
assets=${ARDIACORE_PREBUILT_ASSETS:-https://github.com/$repo/releases/download}
table=${ARDIACORE_PREBUILT_LINUX_TABLE:-$root/packages/ardiacore/prebuilt-engines-linux.tsv}
table_url=${ARDIACORE_PREBUILT_TABLE_URL:-https://raw.githubusercontent.com/$repo/main/packages/ardiacore/prebuilt-engines-linux.tsv}
store=$root/apps/browser/build-ardiacore/prebuilt-linux-x86_64
archive_root=ardiacore-linux-x64
die() { echo "fetch-engine.sh: $*" >&2; exit 1; }

for tool in git curl sha256sum python3; do
  command -v "$tool" >/dev/null || die "$tool is required"
done
key_script=$root/engine/engine-key.sh
engine_key() { "$key_script" --platform linux "$@"; }
git -C "$root" rev-parse --git-dir >/dev/null 2>&1 \
  || die "$root isn't a git checkout: a prebuilt engine is matched to its engine key (engine/engine-key.sh --platform linux)"
mapfile -t key_paths < <(engine_key --paths)
[ "${#key_paths[@]}" -gt 0 ] || die "engine/engine-key.sh --platform linux --paths listed nothing"
dirty=$(git -C "$root" status --porcelain -- "${key_paths[@]}" | cut -c4- | awk 'NR <= 5' | paste -sd ',' - | sed 's/,/, /g')
[ -z "$dirty" ] \
  || die "$dirty (in the Linux engine key, engine/engine-key.sh --platform linux) has uncommitted changes, and no prebuilt engine has them: build the engine (docs/linux-port.md)"
key=$(engine_key) || die "couldn't compute this checkout's engine key (engine/engine-key.sh --platform linux)"

remote_rows="" remote_loaded=0
row_in() { awk -F'\t' -v t="$1" '$1 == t { print; exit }'; }
load_remote() {
  [ "$remote_loaded" = 0 ] || return 0
  remote_loaded=1
  [ "$table_url" != none ] || return 0
  remote_rows=$(curl -fsSL --retry 2 "$table_url" 2>/dev/null) \
    || { echo "warning: couldn't read the published engine table at $table_url" >&2; remote_rows=""; }
}
cached_key() {
  local dir=$store/${1:0:12}
  [ -f "$dir/.complete" ] && [ -f "$dir/manifest.json" ] || return 1
  [ "$(python3 -I -c 'import json, sys; print(json.load(open(sys.argv[1])).get("engine_key", ""))' "$dir/manifest.json" 2>/dev/null)" = "${2:-$1}" ]
}
cached_alias() {
  [ -f "$store/${1:0:12}/.complete" ] || return 1
  python3 -I "$here/runtime_files.py" serves --engine "$store/${1:0:12}" --key "$1" --table "$table"
}
row=""
resolve() {
  row=""
  [ -n "$1" ] || return 1
  [ ! -f "$table" ] || row=$(row_in "$1" <"$table")
  [ -z "$row" ] || return 0
  if cached_key "$1" || cached_alias "$1"; then row="$1"; return 0; fi
  load_remote
  row=$(row_in "$1" <<<"$remote_rows")
  [ -n "$row" ]
}

found="" distance=0
if resolve "$key"; then
  found=$row
else
  index=0
  while read -r commit; do
    candidate=$(engine_key "$commit" 2>/dev/null || true)
    if [ "$candidate" != "$key" ] && resolve "$candidate"; then found=$row distance=$index; break; fi
    index=$((index + 1))
  done < <(git -C "$root" rev-list --max-count=200 HEAD -- "${key_paths[@]}")
  if [ -z "$found" ]; then
    die "no prebuilt Linux engine for engine key ${key:0:12} or any of the 200 commits before it that changed a path the key covers: build this commit's engine on the Linux builder (scripts/linux/build.sh --apply), publish it with scripts/linux/publish-engine.sh --upload and commit packages/ardiacore/prebuilt-engines-linux.tsv"
  fi
  if [ "$nearest" = 0 ]; then
    die "no prebuilt Linux engine for engine key ${key:0:12}: build this commit's engine on the Linux builder (scripts/linux/build.sh --apply), publish it with scripts/linux/publish-engine.sh --upload and commit packages/ardiacore/prebuilt-engines-linux.tsv, or pass --nearest to use ${found:0:12}, $distance engine commits older"
  fi
  echo "warning: no prebuilt Linux engine for engine key ${key:0:12}; using ${found:0:12}, $distance engine commits older, and the app may not match it" >&2
fi

IFS=$'\t' read -r selected tag sha built <<<"$found"
built=${built:-$selected}
[[ "$selected" =~ ^[0-9a-f]{40}$ ]] && [[ "$built" =~ ^[0-9a-f]{40}$ ]] || die "bad engine table row: $found"
short=${selected:0:12}
dest=$store/$short
mkdir -p "$store"
exec 9>"$store/.lock"
if command -v flock >/dev/null; then
  flock -w 300 9 || die "another fetch-engine.sh still holds $store/.lock after 300s"
fi
if [ -z "${tag:-}" ] && [ -z "${sha:-}" ] && [ -f "$dest/.complete" ]; then
  echo "using the cached Linux engine $short" >&2
  touch "$dest/.complete"
  echo "$dest"
  exit 0
fi
[[ "${tag:-}" =~ ^[A-Za-z0-9._-]+$ ]] || die "bad release tag in the engine table row: $found"
[[ "$tag" != engine-* || "$tag" = "engine-${built:0:12}" ]] || die "bad release tag in the engine table row: $found"
[[ "${sha:-}" =~ ^[0-9a-f]{64}$ ]] || die "bad SHA-256 in the engine table row: $found"
if [ -f "$dest/.complete" ] && [ "$(head -n 1 "$dest/.complete")" = "$sha" ] && cached_key "$selected" "$built"; then
  echo "using the cached Linux engine $short" >&2
  printf '%s\n%s\t%s\t%s\t%s\n' "$sha" "$selected" "$tag" "$sha" "$built" >"$dest/.complete"
  echo "$dest"
  exit 0
fi

for stale in "$store"/.tmp-*; do
  [ ! -e "$stale" ] || rm -rf "$stale"
done
tmp=$(mktemp -d "$store/.tmp-XXXXXX")
trap 'rm -rf "$tmp"' EXIT
file="ArdiaCore-${built:0:12}-linux-x64.tar.xz"
url="$assets/$tag/$file"
echo "downloading the Linux engine $short ($url)" >&2
curl -fsSL --retry 3 -o "$tmp/$file" "$url" || die "couldn't download $url"
actual=$(sha256sum "$tmp/$file" | awk '{ print $1 }')
[ "$actual" = "$sha" ] || die "$file has SHA-256 $actual, not $sha from the engine table"
python3 -I "$here/runtime_files.py" unpack --archive "$tmp/$file" --into "$tmp/unpacked" --key "$built" >/dev/null \
  || die "$file isn't a valid Linux engine for $short"
rm -f "$tmp/$file"
rm -rf "$dest"
mv "$tmp/unpacked/$archive_root" "$dest"
printf '%s\n%s\t%s\t%s\t%s\n' "$sha" "$selected" "$tag" "$sha" "$built" >"$dest/.complete"
rm -rf "$tmp"
trap - EXIT

kept=0
while read -r marker; do
  dir=${marker%/.complete}
  [ "$dir" != "$dest" ] || continue
  kept=$((kept + 1))
  [ "$kept" -lt 2 ] || rm -rf "$dir"
done < <(ls -1t "$store"/*/.complete 2>/dev/null)
for dir in "$store"/*/; do
  dir=${dir%/}
  [ -f "$dir/.complete" ] || rm -rf "$dir"
done
echo "$dest"
