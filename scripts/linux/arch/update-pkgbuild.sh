#!/usr/bin/env bash
set -euo pipefail
usage='usage: scripts/linux/arch/update-pkgbuild.sh <version> (--sha256 HEX | --package TARBALL) [--out DIR]
       scripts/linux/arch/update-pkgbuild.sh --check

Points the ardia-bin PKGBUILD at the release tarball of Ardia <version>
(Ardia-<version>-linux-x64.tar.xz on the v<version> GitHub release): it sets
pkgver (a nightly'"'"'s -nightly.<n> becomes nightly.<n>, which pacman
sorts before its stable), resets pkgrel to 1, pins sha256sums to HEX
or to the digest of TARBALL, and writes the matching .SRCINFO, as
makepkg --printsrcinfo would, without needing makepkg.

  --out DIR   write PKGBUILD and .SRCINFO to DIR (the AUR checkout) instead of
              updating scripts/linux/arch in place
  --check     exit 1 if scripts/linux/arch/.SRCINFO doesn'"'"'t match its PKGBUILD
  -h, --help  show this help'

die() { echo "update-pkgbuild.sh: $*" >&2; exit 1; }

here=$(cd "$(dirname "$0")" && pwd -P)

srcinfo() (
  set +eu
  source "$1"
  printf 'pkgbase = %s\n' "$pkgname"
  for attr in pkgdesc pkgver pkgrel epoch url install changelog; do
    [ -n "${!attr}" ] && printf '\t%s = %s\n' "$attr" "${!attr}"
  done
  for attr in arch groups license checkdepends makedepends depends optdepends provides conflicts replaces \
    noextract options backup source validpgpkeys md5sums sha1sums sha224sums sha256sums sha384sums sha512sums b2sums; do
    declare -p "$attr" >/dev/null 2>&1 || continue
    eval "values=(\"\${${attr}[@]}\")"
    for value in "${values[@]}"; do
      printf '\t%s = %s\n' "$attr" "$value"
    done
  done
  printf '\npkgname = %s\n' "$pkgname"
)

version=""
sha256=""
tarball=""
out=""
check=0
while [ $# -gt 0 ]; do
  case "$1" in
    -h|--help) echo "$usage"; exit 0 ;;
    --sha256) [ $# -ge 2 ] || die "--sha256 needs a digest"; sha256=$2; shift 2 ;;
    --package) [ $# -ge 2 ] || die "--package needs a tarball"; tarball=$2; shift 2 ;;
    --out) [ $# -ge 2 ] || die "--out needs a directory"; out=$2; shift 2 ;;
    --check) check=1; shift ;;
    -*) echo "$usage" >&2; exit 64 ;;
    *) [ -z "$version" ] || { echo "$usage" >&2; exit 64; }; version=$1; shift ;;
  esac
done

if [ "$check" = 1 ]; then
  [ -z "$version$sha256$tarball$out" ] || { echo "$usage" >&2; exit 64; }
  if ! diff -u "$here/.SRCINFO" <(srcinfo "$here/PKGBUILD"); then
    die "scripts/linux/arch/.SRCINFO doesn't match its PKGBUILD (above): run update-pkgbuild.sh <version> --sha256 <digest>"
  fi
  exit 0
fi

[ -n "$version" ] || { echo "$usage" >&2; exit 64; }
[[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-nightly\.[0-9]+)?$ ]] \
  || die "$version is neither <major>.<minor>.<patch> nor <major>.<minor>.<patch>-nightly.<n>"
if [ -n "$tarball" ]; then
  [ -z "$sha256" ] || die "pass --sha256 or --package, not both"
  [ -f "$tarball" ] || die "no tarball at $tarball"
  [ "${tarball##*/}" = "Ardia-$version-linux-x64.tar.xz" ] || die "${tarball##*/} isn't Ardia-$version-linux-x64.tar.xz"
  sha256=$(sha256sum "$tarball" | cut -d' ' -f1)
fi
[[ "$sha256" =~ ^[0-9a-f]{64}$ ]] || die "pass the tarball's sha256 (64 lowercase hex digits) with --sha256, or --package"

out=${out:-$here}
mkdir -p "$out"
pkgbuild=$(mktemp)
trap 'rm -f "$pkgbuild"' EXIT
sed -e "s/^pkgver=.*/pkgver=${version/-nightly/nightly}/" -e 's/^pkgrel=.*/pkgrel=1/' \
  -e "s/^sha256sums=.*/sha256sums=('$sha256')/" "$here/PKGBUILD" > "$pkgbuild"
grep -qx "pkgver=${version/-nightly/nightly}" "$pkgbuild" && grep -qx "sha256sums=('$sha256')" "$pkgbuild" \
  || die "the PKGBUILD lost its one-line pkgver= or sha256sums= assignment"
srcinfo "$pkgbuild" > "$out/.SRCINFO"
cp "$pkgbuild" "$out/PKGBUILD"
chmod 0644 "$out/PKGBUILD" "$out/.SRCINFO"
echo "$out/PKGBUILD: ardia-bin ${version/-nightly/nightly}-1, sha256 $sha256"
