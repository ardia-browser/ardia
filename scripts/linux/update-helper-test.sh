#!/usr/bin/env bash
set -euo pipefail
usage='usage: scripts/linux/update-helper-test.sh [--work DIR] [--update-verify FILE] [image...]

Tests lib/ardia/ardia-update, the Linux self-update helper, and the
lib/ardia/ardia-update-verify it checks every manifest and package with, in
fresh containers (docker or podman). It builds two stand-in releases with
package.py, OLD 0.2.47-nightly.6 and NEW 0.2.47-nightly.9 (a copy of sleep
stands in for chrome), signs their manifests with a throwaway Ed25519 key
that each test install swaps into lib/ardia/linux-update.pem, and forges the
manifests the helper must refuse.

In each Debian-family image (default debian:13 and ubuntu:24.04) it checks
kind for every install type and missing requirement (the verifier among
them), upgrades a .deb, a
tarball installed with install.sh --prefix /usr (no ardia.new or ardia.old
left behind, and a process running from the old tree survives) and an
AppImage as a non-root user, and checks every refusal: a bad, short, long or
missing signature, the wrong key, a key that is not an Ed25519 key, an older
or equal version, checksum and size mismatches,
symlinked, hard-linked, FIFO and foreign-owned files, a manifest naming
another version'"'"'s file, a path or shell metacharacters, a bad version
string, a concurrent run, a relative folder and an AppImage replaced after
Ardia started, that the reads it makes as the user hold no descriptor to its
private copies, and that its watchdog stops a stalled step. In archlinux (default) it
installs the AUR PKGBUILD built from the OLD tarball and checks kind is
managed.

  --work DIR            build the releases and fixtures in DIR (default: a
                        temporary directory, removed afterwards)
  --update-verify FILE  bundle this x86_64-unknown-linux-musl
                        ardia-update-verify (default: build it with
                        scripts/linux/update-verify.sh)

Needs python3, node, openssl, dpkg-deb, readelf, xz, docker or podman, and
cargo unless --update-verify is given.'

work=""
update_verify=()
images=()
while (($#)); do
  case "$1" in
    -h|--help) echo "$usage"; exit 0 ;;
    --work) work=${2:?--work needs a directory}; shift 2 ;;
    --update-verify) update_verify=(--update-verify "${2:?--update-verify needs a file}"); shift 2 ;;
    -*) echo "$usage" >&2; exit 64 ;;
    *) images+=("$1"); shift ;;
  esac
done
((${#images[@]})) || images=(debian:13 ubuntu:24.04 archlinux:latest)
engine=$(command -v docker || command -v podman || true)
[[ -n "$engine" ]] || { echo "update-helper-test.sh: docker or podman is required" >&2; exit 1; }
for tool in python3 node openssl dpkg-deb readelf xz; do
  command -v "$tool" >/dev/null || { echo "update-helper-test.sh: $tool is required" >&2; exit 1; }
done

root=$(CDPATH='' cd -- "$(dirname -- "$0")/../.." && pwd -P)
if ((${#update_verify[@]} == 0)); then
  echo "==> building ardia-update-verify"
  update_verify=(--update-verify "$("$root/scripts/linux/update-verify.sh")")
fi
if [[ -z "$work" ]]; then
  work=$(mktemp -d)
  trap 'rm -rf "$work"' EXIT
else
  mkdir -p "$work"
  work=$(CDPATH='' cd -- "$work" && pwd -P)
  rm -rf "${work:?}/pkgs" "$work/cases" "$work/keys" "$work/arch" "$work/stub"
fi

OLD=0.2.47-nightly.6
NEW=0.2.47-nightly.9
OLDER=0.2.47-nightly.5
export ARDIA_APPIMAGE_TOOLS=${ARDIA_APPIMAGE_TOOLS:-$work/appimage-tools}
export SOURCE_DATE_EPOCH=1700000000

stub="$work/stub"
mkdir -p "$stub/engine/locales" "$stub/ui"
cp /usr/bin/sleep "$stub/engine/chrome"
chmod 0755 "$stub/engine/chrome"
for name in chrome_crashpad_handler icudtl.dat resources.pak chrome_100_percent.pak chrome_200_percent.pak v8_context_snapshot.bin; do
  printf 'stand-in %s\n' "$name" > "$stub/engine/$name"
done
printf 'locale\n' > "$stub/engine/locales/en-US.pak"

build_release() {
  local version=$1 out="$work/pkgs/$1"
  mkdir -p "$out"
  printf '<html><body>Ardia %s</body></html>\n' "$version" > "$stub/ui/index.html"
  python3 "$root/scripts/linux/package.py" --out "$stub/engine" --ui "$stub/ui" --version "$version" --no-ubo-seed \
    --destination "$out/Ardia-$version-linux-x64.tar.xz" --deb "$out/Ardia-$version-linux-x64.deb" \
    --appimage "$out/Ardia-$version-linux-x64.AppImage" "${update_verify[@]}" >/dev/null
}
echo "==> building $OLD and $NEW with package.py"
build_release "$OLD"
build_release "$NEW"

keys="$work/keys"
mkdir -p "$keys"
openssl genpkey -algorithm ed25519 -out "$keys/test.pem" 2>/dev/null
openssl pkey -in "$keys/test.pem" -pubout -out "$keys/test.pub.pem"
openssl genpkey -algorithm ed25519 -out "$keys/other.pem" 2>/dev/null

cases="$work/cases"
sign() { openssl pkeyutl -sign -inkey "${2:-$keys/test.pem}" -rawin -in "$1" -out "$1.sig"; }
copy_packages() {
  local from=$1 to=$2 dir=$3 extension
  for extension in deb tar.xz AppImage; do
    cp "$work/pkgs/$from/Ardia-$from-linux-x64.$extension" "$dir/Ardia-$to-linux-x64.$extension"
  done
}
release_case() {
  local name=$1 from=$2 version=$3 key=${4:-$keys/test.pem}
  mkdir -p "$cases/$name"
  copy_packages "$from" "$version" "$cases/$name"
  node "$root/scripts/linux/sign-update.mjs" --unsigned --dir "$cases/$name" --version "$version" >/dev/null
  sign "$cases/$name/Ardia-$version-linux-update.txt" "$key"
}
line_for() {
  local format=$1 name=$2 file=$3
  printf '%s %s %s %s\n' "$format" "$name" "$(sha256sum "$file" | cut -d' ' -f1)" "$(stat -c %s "$file")"
}
flip_last_byte() { python3 -I -c 'import sys; p = sys.argv[1]; b = bytearray(open(p, "rb").read()); b[-1] ^= 0xFF; open(p, "wb").write(b)' "$1"; }

echo "==> writing the update folders the helper must accept or refuse"
release_case valid "$NEW" "$NEW"
release_case badsig "$NEW" "$NEW"
flip_last_byte "$cases/badsig/Ardia-$NEW-linux-update.txt.sig"
release_case wrongkey "$NEW" "$NEW" "$keys/other.pem"
release_case older "$OLD" "$OLDER"
release_case equal "$OLD" "$OLD"
release_case checksum "$NEW" "$NEW"
release_case size "$NEW" "$NEW"
release_case smaller "$NEW" "$NEW"
release_case symlink "$NEW" "$NEW"
release_case bigsig "$NEW" "$NEW"
printf 'x' >> "$cases/bigsig/Ardia-$NEW-linux-update.txt.sig"
release_case shortsig "$NEW" "$NEW"
truncate -s 63 "$cases/shortsig/Ardia-$NEW-linux-update.txt.sig"
release_case nosig "$NEW" "$NEW"
rm "$cases/nosig/Ardia-$NEW-linux-update.txt.sig"
for extension in deb tar.xz AppImage; do
  file="Ardia-$NEW-linux-x64.$extension"
  flip_last_byte "$cases/checksum/$file"
  printf 'x' >> "$cases/size/$file"
  truncate -s -1 "$cases/smaller/$file"
  mv "$cases/symlink/$file" "$cases/symlink/real-$file"
  ln -s "real-$file" "$cases/symlink/$file"
done

forged_case() {
  local name=$1 version=$2
  mkdir -p "$cases/$name"
  cat > "$cases/$name/Ardia-$version-linux-update.txt"
  sign "$cases/$name/Ardia-$version-linux-update.txt"
}
new_pkg() { echo "$work/pkgs/$NEW/Ardia-$NEW-linux-x64.$1"; }
old_pkg() { echo "$work/pkgs/$OLD/Ardia-$OLD-linux-x64.$1"; }
{
  printf 'ardia-linux-update 1\nversion %s\n' "$NEW"
  line_for deb "Ardia-$OLD-linux-x64.deb" "$(old_pkg deb)"
  line_for tarball "Ardia-$OLD-linux-x64.tar.xz" "$(old_pkg tar.xz)"
  line_for appimage "Ardia-$OLD-linux-x64.AppImage" "$(old_pkg AppImage)"
} | forged_case othername "$NEW"
copy_packages "$OLD" "$OLD" "$cases/othername"
{
  printf 'ardia-linux-update 1\nversion %s\n' 0.2.48-beta.1
  line_for deb Ardia-0.2.48-beta.1-linux-x64.deb "$(new_pkg deb)"
  line_for tarball Ardia-0.2.48-beta.1-linux-x64.tar.xz "$(new_pkg tar.xz)"
  line_for appimage Ardia-0.2.48-beta.1-linux-x64.AppImage "$(new_pkg AppImage)"
} | forged_case badversion 0.2.48-beta.1
copy_packages "$NEW" 0.2.48-beta.1 "$cases/badversion"
{
  printf 'ardia-linux-update 1\nversion %s\n' "$NEW"
  line_for deb "../Ardia-$NEW-linux-x64.deb" "$(new_pkg deb)"
  line_for tarball "../Ardia-$NEW-linux-x64.tar.xz" "$(new_pkg tar.xz)"
  line_for appimage "../Ardia-$NEW-linux-x64.AppImage" "$(new_pkg AppImage)"
} | forged_case traversal "$NEW"
copy_packages "$NEW" "$NEW" "$cases/traversal"
{
  printf 'ardia-linux-update 1\nversion %s\n' "$NEW"
  line_for deb "Ardia-$NEW-linux-x64.deb\$(touch\${IFS}/tmp/pwned)" "$(new_pkg deb)"
  line_for tarball "Ardia-$NEW-linux-x64.tar.xz;touch\${IFS}/tmp/pwned" "$(new_pkg tar.xz)"
  line_for appimage "Ardia-$NEW-linux-x64.AppImage\`touch\${IFS}/tmp/pwned\`" "$(new_pkg AppImage)"
} | forged_case metachar "$NEW"
copy_packages "$NEW" "$NEW" "$cases/metachar"
{
  printf 'ardia-linux-update 1\nversion %s\n' "$NEW"
  line_for appimage "Ardia-$NEW-linux-x64.AppImage" "$(new_pkg AppImage)"
  line_for tarball "Ardia-$NEW-linux-x64.tar.xz" "$(new_pkg tar.xz)"
  line_for deb "Ardia-$NEW-linux-x64.deb" "$(new_pkg deb)"
} | forged_case outoforder "$NEW"
copy_packages "$NEW" "$NEW" "$cases/outoforder"
{
  printf 'ardia-linux-update 1\r\nversion %s\r\n' "$NEW"
  line_for deb "Ardia-$NEW-linux-x64.deb" "$(new_pkg deb)" | sed 's/$/\r/'
  line_for tarball "Ardia-$NEW-linux-x64.tar.xz" "$(new_pkg tar.xz)" | sed 's/$/\r/'
  line_for appimage "Ardia-$NEW-linux-x64.AppImage" "$(new_pkg AppImage)" | sed 's/$/\r/'
} | forged_case crlf "$NEW"
copy_packages "$NEW" "$NEW" "$cases/crlf"
{
  printf 'ardia-linux-update 1\nversion %s\n' 0.2.48
  line_for deb Ardia-0.2.48-linux-x64.deb "$(new_pkg deb)"
  line_for tarball Ardia-0.2.48-linux-x64.tar.xz "$(new_pkg tar.xz)"
  line_for appimage Ardia-0.2.48-linux-x64.AppImage "$(new_pkg AppImage)"
} | forged_case versionmismatch "$NEW"
copy_packages "$NEW" 0.2.48 "$cases/versionmismatch"
{
  printf 'ardia-linux-update 1\nversion %s\n' "$NEW"
  line_for deb "Ardia-$NEW-linux-x64.deb" "$(new_pkg deb)"
  line_for tarball "Ardia-$NEW-linux-x64.tar.xz" "$(new_pkg tar.xz)"
  line_for appimage "Ardia-$NEW-linux-x64.AppImage" "$(new_pkg AppImage)"
  head -c 4096 /dev/zero | tr '\0' 'x'
  printf '\n'
} | forged_case bigmanifest "$NEW"
copy_packages "$NEW" "$NEW" "$cases/bigmanifest"
{
  printf 'ardia-linux-update 1\nversion %s\n' "$NEW"
  line_for tarball "Ardia-$NEW-linux-x64.tar.xz" "$(new_pkg tar.xz)"
} | forged_case tarballonly "$NEW"
copy_packages "$NEW" "$NEW" "$cases/tarballonly"

mkdir -p "$work/arch"
"$root/scripts/linux/arch/update-pkgbuild.sh" "$OLD" --package "$(old_pkg tar.xz)" --out "$work/arch" >/dev/null
cp "$(old_pkg tar.xz)" "$work/arch/ardia-bin-${OLD/-nightly/nightly}.tar.xz"

cat > "$work/check-debian.sh" <<'CHECK'
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
echo 'Acquire::Retries "5";' > /etc/apt/apt.conf.d/80-retries
failures=0
ok() { echo "ok   $*"; }
bad() { echo "FAIL $*"; failures=$((failures + 1)); }
expect() {
  local label=$1 wanted=$2 got=$3
  if [[ "$got" == "$wanted" ]]; then ok "$label: $got"; else bad "$label: wanted '$wanted', got '$got'"; fi
}
apt-get update -qq
apt-get install -y -qq --no-install-recommends pkexec xz-utils >/dev/null
useradd -m -u 1234 tester
helper=/usr/lib/ardia/ardia-update
cases=/home/tester/cases
as_tester() { setpriv --reuid=1234 --regid=1234 --clear-groups env -i HOME=/home/tester PATH=/usr/bin:/bin "$@"; }
kind_of() { as_tester "$@" kind; }
stage() {
  rm -rf "${cases:?}/$1"
  mkdir -p "$cases"
  cp -a "/work/cases/$1" "$cases/$1"
  chown -hR 1234:1234 "$cases"
}
result_of() {
  local out status=0 line
  out=$("$@" 2>>/tmp/helper.log) || status=$?
  line=$(printf '%s\n' "$out" | tail -n 1)
  case "$line:$status" in
    installed*:0 | failed*:[1-9]*) printf '%s' "$line" ;;
    *) printf '%s (exit %s)' "$line" "$status" ;;
  esac
}
as_pkexec() { result_of timeout 300 env -i PATH=/usr/bin:/bin HOME=/root PKEXEC_UID=1234 "$@"; }
swap_key() { cp /work/keys/test.pub.pem /usr/lib/ardia/linux-update.pem; }
verifier=/usr/lib/ardia/ardia-update-verify
installed_version() { cat /usr/lib/ardia/VERSION; }
refusals() {
  local kind=$1 entry name wanted
  for entry in badsig:signature wrongkey:signature bigsig:signature shortsig:signature nosig:missing older:notNewer equal:notNewer checksum:checksum size:checksum \
    smaller:checksum symlink:missing othername:manifest badversion:manifest traversal:manifest metachar:manifest \
    outoforder:manifest crlf:manifest versionmismatch:manifest bigmanifest:manifest; do
    name=${entry%%:*} wanted=${entry#*:}
    stage "$name"
    expect "$kind refuses $name" "failed $wanted" "$(as_pkexec "$helper" install "$cases/$name")"
  done
  [[ "$kind" != deb ]] || { stage tarballonly; expect "deb refuses a manifest without a deb line" "failed kind" "$(as_pkexec "$helper" install "$cases/tarballonly")"; }
  stage valid
  printf -- '-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VxAyEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=\n-----END PUBLIC KEY-----\n' > /usr/lib/ardia/linux-update.pem
  expect "$kind refuses with a key that isn't an Ed25519 key" "failed signature" "$(as_pkexec "$helper" install "$cases/valid")"
  swap_key
  mv "$verifier" /tmp/verifier.aside
  expect "$kind refuses without the verifier" "failed kind" "$(as_pkexec "$helper" install "$cases/valid")"
  mv /tmp/verifier.aside "$verifier"
  stage valid
  ln "$cases/valid/Ardia-$NEW-linux-x64.deb" "$cases/valid/linked.deb"
  ln "$cases/valid/Ardia-$NEW-linux-x64.tar.xz" "$cases/valid/linked.tar.xz"
  expect "$kind refuses a hard-linked package" "failed missing" "$(as_pkexec "$helper" install "$cases/valid")"
  stage valid
  for extension in deb tar.xz; do rm "$cases/valid/Ardia-$NEW-linux-x64.$extension"; mkfifo "$cases/valid/Ardia-$NEW-linux-x64.$extension"; done
  chown -h 1234:1234 "$cases"/valid/*
  expect "$kind refuses a FIFO" "failed missing" "$(as_pkexec "$helper" install "$cases/valid")"
  stage valid
  chown 0:0 "$cases/valid/Ardia-$NEW-linux-x64.deb" "$cases/valid/Ardia-$NEW-linux-x64.tar.xz"
  expect "$kind refuses a package the user doesn't own" "failed missing" "$(as_pkexec "$helper" install "$cases/valid")"
  stage valid
  chmod 0000 "$cases/valid/Ardia-$NEW-linux-x64.deb" "$cases/valid/Ardia-$NEW-linux-x64.tar.xz"
  expect "$kind reads the user's files as the user (an unreadable package)" "failed missing" "$(as_pkexec "$helper" install "$cases/valid")"
  stage valid
  chmod 0000 "$cases/valid/Ardia-$NEW-linux-update.txt"
  expect "$kind reads the user's files as the user (an unreadable manifest)" "failed missing" "$(as_pkexec "$helper" install "$cases/valid")"
  stage valid
  chown 0:0 "$cases/valid"
  expect "$kind refuses a folder the user doesn't own" "failed missing" "$(as_pkexec "$helper" install "$cases/valid")"
  stage valid
  expect "$kind refuses a relative folder" "failed usage" "$(cd "$cases" && as_pkexec "$helper" install valid)"
  expect "$kind refuses a missing folder" "failed missing" "$(as_pkexec "$helper" install "$cases/nothing")"
  expect "$kind refuses a run as the user" "failed usage" "$(result_of as_tester "$helper" install "$cases/valid")"
  flock -o /run/ardia-update.lock sleep 30 &
  local holder=$!
  sleep 1
  expect "$kind refuses a concurrent run" "failed busy" "$(as_pkexec "$helper" install "$cases/valid")"
  kill "$holder"
  wait "$holder" 2>/dev/null || true
  [[ ! -e /tmp/pwned ]] && ok "no manifest name ran as a command" || bad "a manifest name ran as a command"
  expect "$kind left the install alone after the refusals" "$OLD" "$(installed_version)"
  local leftovers
  leftovers=$(find /var/tmp -maxdepth 1 -name 'ardia-update.*' | wc -l)
  expect "$kind left no private folder behind" 0 "$leftovers"
}

echo "-- deb"
apt-get install -y -qq "/work/pkgs/$OLD/Ardia-$OLD-linux-x64.deb" >/tmp/apt.log 2>&1 || { cat /tmp/apt.log; exit 1; }
expect "deb helper mode and owner" "755 root" "$(stat -c '%a %U' "$helper")"
expect "deb key mode" "644" "$(stat -c '%a' /usr/lib/ardia/linux-update.pem)"
expect "deb verifier mode and owner" "755 root" "$(stat -c '%a %U' "$verifier")"
expect "the verifier is static and runs without OpenSSL" "ok" "$(env -i "$verifier" version "$OLD")"
swap_key
expect "deb kind" deb "$(kind_of "$helper")"
expect "an unprivileged kind ignores APPIMAGE outside an AppImage" deb "$(as_tester APPIMAGE=/home/tester/x.AppImage APPDIR=/tmp/elsewhere "$helper" kind)"
refusals deb
mv /usr/bin/setpriv /usr/bin/setpriv.real
printf '#!/bin/sh\necho reader >> /tmp/reader-fds\nfor fd in /proc/$$/fd/*; do readlink "$fd"; done >> /tmp/reader-fds\nexec /usr/bin/setpriv.real "$@"\n' > /usr/bin/setpriv
chmod 0755 /usr/bin/setpriv
stage checksum
expect "deb reads the manifest, signature and package as the user before the checksum refusal" "failed checksum" "$(as_pkexec "$helper" install "$cases/checksum")"
mv /usr/bin/setpriv.real /usr/bin/setpriv
expect "each read as the user went through setpriv" 3 "$(grep -cx reader /tmp/reader-fds)"
expect "no read as the user holds the helper's private copies or its lock" 0 "$(grep -cE '/var/tmp/ardia-update|/run/ardia-update.lock' /tmp/reader-fds || true)"
cp "$helper" /tmp/helper.aside
sed -i 's/^install_budget=540$/install_budget=5/' "$helper"
printf '#!/bin/sh\nsleep 300\n' > /usr/sbin/apt-get
chmod 0755 /usr/sbin/apt-get
stage valid
started=$SECONDS
expect "deb gives up on an apt-get that outlives the install budget" "failed timeout" "$(as_pkexec "$helper" install "$cases/valid")"
elapsed=$((SECONDS - started))
((elapsed < 40)) && ok "the timeout came after ${elapsed}s" || bad "the timeout took ${elapsed}s"
running_sleeps=$(for cmdline in /proc/[0-9]*/cmdline; do tr '\0' ' ' < "$cmdline" 2>/dev/null; echo; done | grep -cx 'sleep 300 ' || true)
((running_sleeps > 0)) && bad "the timed-out apt-get is still running" || ok "the timed-out apt-get was killed"
rm /usr/sbin/apt-get
cp /tmp/helper.aside "$helper"
sed -i 's/^watchdog_seconds=.*/watchdog_seconds=5/' "$helper"
mv /usr/bin/find /usr/bin/find.real
printf '#!/bin/sh\nexec sleep 301\n' > /usr/bin/find
chmod 0755 /usr/bin/find
stage valid
started=$SECONDS
expect "deb's watchdog stops a step the install budget doesn't cover" "failed timeout" "$(as_pkexec "$helper" install "$cases/valid")"
elapsed=$((SECONDS - started))
((elapsed < 40)) && ok "the watchdog fired after ${elapsed}s" || bad "the watchdog took ${elapsed}s"
mv /usr/bin/find.real /usr/bin/find
running_sleeps=$(for cmdline in /proc/[0-9]*/cmdline; do tr '\0' ' ' < "$cmdline" 2>/dev/null; echo; done | grep -cx 'sleep 301 ' || true)
((running_sleeps > 0)) && bad "the stalled step is still running" || ok "the stalled step was killed"
cp /tmp/helper.aside "$helper"
expect "deb left the install alone after the timeout" "$OLD" "$(installed_version)"
stage valid
expect "deb upgrade" "installed $NEW" "$(as_pkexec "$helper" install "$cases/valid")"
expect "dpkg version after the upgrade" "${NEW/-/\~}" "$(dpkg-query -W -f='${Version}' ardia)"
expect "VERSION after the upgrade" "$NEW" "$(installed_version)"
swap_key
stage valid
expect "deb refuses a replay of the installed release" "failed notNewer" "$(as_pkexec "$helper" install "$cases/valid")"
apt-get purge -y -qq ardia >/dev/null 2>&1

echo "-- tarball"
mkdir -p /tmp/old
tar -xJf "/work/pkgs/$OLD/Ardia-$OLD-linux-x64.tar.xz" -C /tmp/old
/tmp/old/ardia/install.sh --prefix /usr
swap_key
expect "tarball helper mode and owner" "755 root" "$(stat -c '%a %U' "$helper")"
expect "tarball verifier mode and owner" "755 root" "$(stat -c '%a %U' "$verifier")"
expect "tarball kind" tarball "$(kind_of "$helper")"
mv /usr/lib/ardia/VERSION /tmp/VERSION.aside
expect "kind without VERSION" "unsupported noVersion" "$(kind_of "$helper")"
mv /tmp/VERSION.aside /usr/lib/ardia/VERSION
mv /usr/lib/ardia/linux-update.pem /tmp/key.aside
expect "kind without the key" "unsupported noKey" "$(kind_of "$helper")"
mv /tmp/key.aside /usr/lib/ardia/linux-update.pem
if command -v openssl >/dev/null; then mv "$(command -v openssl)" /tmp/openssl.aside; fi
expect "kind without openssl" tarball "$(kind_of "$helper")"
[[ ! -e /tmp/openssl.aside ]] || mv /tmp/openssl.aside /usr/bin/openssl
mv "$verifier" /tmp/verifier.aside
expect "kind without the verifier" "unsupported noVerifier" "$(kind_of "$helper")"
printf '#!/bin/sh\nexit 1\n' > "$verifier"
chmod 0755 "$verifier"
expect "kind with a verifier that doesn't run here" "unsupported noVerifier" "$(kind_of "$helper")"
mv /tmp/verifier.aside "$verifier"
chmod u-s /usr/bin/pkexec
expect "kind without a setuid pkexec" "unsupported noPkexec" "$(kind_of "$helper")"
chmod u+s /usr/bin/pkexec
/tmp/old/ardia/install.sh --prefix /opt/ardia
expect "install.sh --prefix /opt/ardia points the update action there" "1" "$(grep -c '>/opt/ardia/lib/ardia/ardia-update<' /usr/share/polkit-1/actions/dev.ardia.linux.policy)"
expect "kind when the policy names another install" "unsupported noPolicy" "$(kind_of "$helper")"
expect "kind of the /opt/ardia install" tarball "$(kind_of /opt/ardia/lib/ardia/ardia-update)"
rm -rf /opt/ardia
for unsafe in shared:1777 team:0775; do
  folder=/srv/${unsafe%%:*}
  mkdir -p "$folder"
  chmod "${unsafe#*:}" "$folder"
  /tmp/old/ardia/install.sh --prefix "$folder/ardia" 2>/dev/null
  expect "install.sh --prefix under a ${unsafe#*:} folder leaves the update action out" "0" "$(grep -c 'dev.ardia.linux.update' /usr/share/polkit-1/actions/dev.ardia.linux.policy || true)"
  expect "the policy keeps its reauthenticate action" "1" "$(grep -c 'dev.ardia.linux.reauthenticate' /usr/share/polkit-1/actions/dev.ardia.linux.policy)"
  expect "kind of the install under a ${unsafe#*:} folder" "unsupported noPolicy" "$(kind_of "$folder/ardia/lib/ardia/ardia-update")"
  rm -rf "$folder"
done
mkdir -p /srv/mine
chown 1234:1234 /srv/mine
chmod 0755 /srv/mine
/tmp/old/ardia/install.sh --prefix /srv/mine/ardia 2>/dev/null
expect "install.sh --prefix under a user's folder leaves the update action out" "0" "$(grep -c 'dev.ardia.linux.update' /usr/share/polkit-1/actions/dev.ardia.linux.policy || true)"
expect "kind of the install under a user's folder" "unsupported noPolicy" "$(kind_of /srv/mine/ardia/lib/ardia/ardia-update)"
rm -rf /srv/mine
/tmp/old/ardia/install.sh --prefix /usr
swap_key
expect "install.sh --prefix /usr names /usr/lib/ardia/ardia-update" "1" "$(grep -c '>/usr/lib/ardia/ardia-update<' /usr/share/polkit-1/actions/dev.ardia.linux.policy)"
expect "tarball kind again" tarball "$(kind_of "$helper")"
refusals tarball
/usr/lib/ardia/chrome 600 &
holder=$!
exec 7</usr/lib/ardia/VERSION
stage valid
expect "tarball upgrade" "installed $NEW" "$(as_pkexec "$helper" install "$cases/valid")"
expect "VERSION after the upgrade" "$NEW" "$(installed_version)"
expect "only lib/ardia is left in /usr/lib" "ardia" "$(cd /usr/lib && ls -d ardia* | tr '\n' ' ' | sed 's/ $//')"
if kill -0 "$holder" 2>/dev/null; then ok "a process running from the old tree survives ($(readlink /proc/$holder/exe))"; else bad "the process running from the old tree died"; fi
expect "a file held open in the old tree still reads" "$OLD" "$(cat <&7)"
exec 7<&-
kill "$holder"
expect "tarball install stays root-owned" "0" "$(find /usr/lib/ardia ! -user 0 | wc -l)"
expect "tarball upgrade left no private folder" 0 "$(find /var/tmp -maxdepth 1 -name 'ardia-update.*' | wc -l)"
swap_key
stage valid
expect "tarball refuses a replay of the installed release" "failed notNewer" "$(as_pkexec "$helper" install "$cases/valid")"

echo "-- appimage"
apps=/home/tester/Apps
mnt=/home/tester/mnt
mkdir -p "$apps" "$mnt"
cp "/work/pkgs/$OLD/Ardia-$OLD-linux-x64.AppImage" "$apps/Ardia.AppImage"
chmod 0755 "$apps/Ardia.AppImage"
chown -R 1234:1234 "$apps" "$mnt"
(cd "$mnt" && as_tester "$apps/Ardia.AppImage" --appimage-extract >/dev/null)
cp /work/keys/test.pub.pem "$mnt/squashfs-root/lib/ardia/linux-update.pem"
chown 1234:1234 "$mnt/squashfs-root/lib/ardia/linux-update.pem"
inner="$mnt/squashfs-root/lib/ardia/ardia-update"
as_app() { as_tester APPIMAGE="$apps/Ardia.AppImage" APPDIR="$mnt/squashfs-root" "$@"; }
app_install() { result_of timeout 300 setpriv --reuid=1234 --regid=1234 --clear-groups env -i HOME=/home/tester PATH=/usr/bin:/bin APPIMAGE="$apps/Ardia.AppImage" APPDIR="$mnt/squashfs-root" "$inner" install "$1"; }
old_sum=$(sha256sum < "$apps/Ardia.AppImage")
expect "appimage kind" appimage "$(as_app "$inner" kind)"
expect "kind with another AppImage's APPDIR" "unsupported noPolicy" "$(as_tester APPIMAGE="$apps/Ardia.AppImage" APPDIR=/tmp "$inner" kind)"
expect "kind without APPIMAGE" "unsupported noPolicy" "$(as_tester "$inner" kind)"
chmod 0555 "$apps"
expect "kind when the AppImage's folder isn't writable" "unsupported noPolicy" "$(as_app "$inner" kind)"
chmod 0755 "$apps"
for entry in badsig:signature wrongkey:signature shortsig:signature older:notNewer equal:notNewer checksum:checksum size:checksum smaller:checksum symlink:missing othername:manifest traversal:manifest metachar:manifest crlf:manifest bigmanifest:manifest; do
  name=${entry%%:*} wanted=${entry#*:}
  stage "$name"
  expect "appimage refuses $name" "failed $wanted" "$(app_install "$cases/$name")"
done
stage valid
chown 0:0 "$cases/valid/Ardia-$NEW-linux-x64.AppImage"
expect "appimage refuses a package the user doesn't own" "failed missing" "$(app_install "$cases/valid")"
stage valid
setpriv --reuid=1234 --regid=1234 --clear-groups flock -o "$apps" sleep 30 &
holder=$!
sleep 1
expect "appimage refuses a concurrent run" "failed busy" "$(app_install "$cases/valid")"
kill "$holder"
wait "$holder" 2>/dev/null || true
stage valid
replaced_after_launch=$(result_of timeout 300 bash -c 'sleep 5; touch -c "$1"; shift; exec "$@"' _ "$apps/Ardia.AppImage" \
  setpriv --reuid=1234 --regid=1234 --clear-groups env -i HOME=/home/tester PATH=/usr/bin:/bin APPIMAGE="$apps/Ardia.AppImage" \
  APPDIR="$mnt/squashfs-root" "$inner" install "$cases/valid")
expect "appimage refuses to replace an AppImage that changed after Ardia started" "failed notNewer" "$replaced_after_launch"
expect "the refusals left the AppImage alone" "$old_sum" "$(sha256sum < "$apps/Ardia.AppImage")"
expect "the refusals left no staged AppImage" "" "$(find "$apps" -name '.ardia-update-*')"
stage valid
expect "appimage upgrade" "installed $NEW" "$(app_install "$cases/valid")"
expect "the AppImage is the new release" "$(sha256sum < "/work/pkgs/$NEW/Ardia-$NEW-linux-x64.AppImage")" "$(sha256sum < "$apps/Ardia.AppImage")"
expect "the new AppImage's mode and owner" "755 tester" "$(stat -c '%a %U' "$apps/Ardia.AppImage")"
expect "the upgrade left no staged AppImage" "" "$(find "$apps" -name '.ardia-update-*')"
expect "the upgrade left no private folder" 0 "$(find /tmp -maxdepth 1 -name 'ardia-update.*' | wc -l)"

if ((failures)); then echo "$failures checks failed"; echo "--- helper stderr"; tail -n 60 /tmp/helper.log; exit 1; fi
echo "all checks passed"
CHECK

cat > "$work/check-arch.sh" <<'CHECK'
set -euo pipefail
pacman -Syu --noconfirm --needed base-devel >/dev/null 2>&1
useradd -m builder
cp -r /work/arch /home/builder/build
chown -R builder:builder /home/builder/build
su builder -c 'cd /home/builder/build && makepkg -d --noconfirm >/tmp/makepkg.log 2>&1' || { cat /tmp/makepkg.log; exit 1; }
pacman -U --noconfirm -dd /home/builder/build/*.pkg.tar.* >/dev/null
got=$(su builder -c '/usr/lib/ardia/ardia-update kind')
if [[ "$got" == managed ]]; then echo "ok   pacman install kind: managed"; else echo "FAIL pacman install kind: wanted managed, got '$got'"; exit 1; fi
echo "all checks passed"
CHECK

status=0
for image in "${images[@]}"; do
  echo "== $image"
  case "$image" in
    archlinux*) script=check-arch.sh ;;
    *) script=check-debian.sh ;;
  esac
  if ! "$engine" run --rm -e OLD="$OLD" -e NEW="$NEW" -v "$work:/work:ro" "$image" bash /work/"$script"; then
    echo "FAIL $image"
    status=1
  fi
done
exit $status
