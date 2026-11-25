#!/usr/bin/env bash
set -euo pipefail
usage='usage: scripts/linux/arch/publish-aur.sh <version> (--sha256 HEX | --package TARBALL) [--dry-run]

Updates the AUR package ardia-bin to Ardia <version>: clones
ssh://aur@aur.archlinux.org/ardia-bin.git, writes PKGBUILD and .SRCINFO with
update-pkgbuild.sh, checks that the tarball the PKGBUILD downloads from the
GitHub release has that sha256, commits and pushes. The first push creates the
package on the AUR. It refuses to move ardia-bin to an older version.

  --dry-run   clone read-only over HTTPS, show the commit, push nothing and
              download nothing

Environment:
  AUR_SSH_KEY_FILE  the private key of the AUR account (default: ssh'"'"'s own keys)
  AUR_GIT_NAME, AUR_GIT_EMAIL
                    the commit author (default: git config, else
                    github-actions[bot])
  AUR_OUT           also copy the PKGBUILD and .SRCINFO into this directory'

die() { echo "publish-aur.sh: $*" >&2; exit 1; }
order_key() {
  case "$1" in
    *nightly.*) printf '%s.0.%s\n' "${1%%nightly.*}" "${1##*nightly.}" ;;
    *) printf '%s.1.0\n' "$1" ;;
  esac
}

here=$(cd "$(dirname "$0")" && pwd -P)
version=""
digest_args=()
dry=0
while [ $# -gt 0 ]; do
  case "$1" in
    -h|--help) echo "$usage"; exit 0 ;;
    --sha256|--package) [ $# -ge 2 ] || die "$1 needs a value"; digest_args+=("$1" "$2"); shift 2 ;;
    --dry-run) dry=1; shift ;;
    -*) echo "$usage" >&2; exit 64 ;;
    *) [ -z "$version" ] || { echo "$usage" >&2; exit 64; }; version=$1; shift ;;
  esac
done
[ -n "$version" ] && [ ${#digest_args[@]} -eq 2 ] || { echo "$usage" >&2; exit 64; }
pkgver=${version/-nightly/nightly}

work=$(mktemp -d "${TMPDIR:-/tmp}/ardia-aur.XXXXXX")
trap 'rm -rf "$work"' EXIT
ssh_command=(ssh -o "UserKnownHostsFile=$here/aur_known_hosts" -o StrictHostKeyChecking=yes -o BatchMode=yes)
if [ -n "${AUR_SSH_KEY_FILE:-}" ]; then
  [ -f "$AUR_SSH_KEY_FILE" ] || die "no key at AUR_SSH_KEY_FILE=$AUR_SSH_KEY_FILE"
  ssh_command+=(-o IdentitiesOnly=yes -i "$AUR_SSH_KEY_FILE")
fi
export GIT_SSH_COMMAND="${ssh_command[*]@Q}"
if [ "$dry" = 1 ]; then
  remote=https://aur.archlinux.org/ardia-bin.git
else
  remote=ssh://aur@aur.archlinux.org/ardia-bin.git
fi
git clone -q "$remote" "$work/aur" 2>"$work/clone.log" || { cat "$work/clone.log" >&2; die "could not clone $remote"; }
cd "$work/aur"
if [ -f .SRCINFO ]; then
  current=$(sed -n 's/^\tpkgver = //p' .SRCINFO)
  if [ -n "$current" ] && [ "$current" != "$pkgver" ] && [ "$(printf '%s\n%s\n' "$(order_key "$current")" "$(order_key "$pkgver")" | sort -V | tail -1)" != "$(order_key "$pkgver")" ]; then
    die "the AUR has ardia-bin $current, newer than $pkgver"
  fi
fi

"$here/update-pkgbuild.sh" "$version" "${digest_args[@]}" --out "$work/aur" >/dev/null
[ -z "${AUR_OUT:-}" ] || { mkdir -p "$AUR_OUT"; cp PKGBUILD .SRCINFO "$AUR_OUT/"; }
git add PKGBUILD .SRCINFO
if git diff --cached --quiet 2>/dev/null && git rev-parse -q --verify HEAD >/dev/null; then
  echo "ardia-bin is already $pkgver-1 on the AUR"
  exit 0
fi
name=${AUR_GIT_NAME:-$(git config user.name || echo 'github-actions[bot]')}
email=${AUR_GIT_EMAIL:-$(git config user.email || echo '41898282+github-actions[bot]@users.noreply.github.com')}
git -c user.name="$name" -c user.email="$email" commit -q -m "Update to $pkgver-1"
git --no-pager show --stat --format='%an <%ae>: %s' HEAD

if [ "$dry" = 1 ]; then
  echo "dry run: pushed nothing to $remote"
  exit 0
fi
url=$(bash -c 'source ./PKGBUILD; printf "%s\n" "${source[0]#*::}"')
expected=$(sed -n 's/^\tsha256sums = //p' .SRCINFO)
actual=$(curl -fsSL --retry 3 "$url" | sha256sum | cut -d' ' -f1)
[ "$actual" = "$expected" ] || die "$url has sha256 ${actual:-nothing}, not $expected: publish the tarball first"
echo "ok   $url matches the PKGBUILD's sha256"
git push -q origin HEAD:master
echo "pushed ardia-bin $pkgver-1 to the AUR"
