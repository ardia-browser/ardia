#!/usr/bin/env bash
set -euo pipefail
usage='usage: scripts/linux/rpm-install-test.sh <Ardia-<version>-linux-x64.rpm> [--older <older .rpm>] [<image>...]

Installs the .rpm in fresh containers (docker or podman) with the distribution'"'"'s
own package manager, dnf on Fedora and AlmaLinux and zypper on openSUSE, and checks that its
dependencies resolve, every library chrome needs is found, ardia --version
runs, chrome-sandbox is setuid root, the desktop entries validate and run
/usr/bin/ardia, the icon and the polkit policy are there without the self-update
action, ardia-update leaves updates to the package manager (kind: managed),
rpm --verify passes, the AppArmor profile is written only where AppArmor reads
the 4.0 ABI, an older build upgrades to this one (its own files go, one ardia
stays), and removing it leaves the file system as it was before the install
(the desktop and icon caches the distribution regenerates aside).

  --older RPM   the build to upgrade from; by default one is made from this
                .rpm with the version before it (X becomes X-nightly.1,
                X-nightly.N becomes X-nightly.N-1) and a file only it carries,
                with linux_formats.py rpm in a fedora container; only that
                made build is checked for its file before and after

The images default to fedora:43, almalinux:9 (the RHEL family, with curl-minimal
installed as it ships) and opensuse/tumbleweed; tumbleweed also gets
apparmor-parser and apparmor-abstractions first, so its run
covers the profile. dnf retries each download 5
times, zypper each repository refresh 5 times 30 s apart, from the third try on
from downloadcontent.opensuse.org rather than a mirror (a Tumbleweed mirror can lag
a new snapshot), and each install 3 times, and each image pull is tried 3 times,
so one network flake does not fail the test.'

rpm_file=""
older=""
images=()
while [ $# -gt 0 ]; do
  case "$1" in
    -h|--help) echo "$usage"; exit 0 ;;
    --older) [ $# -ge 2 ] || { echo "$usage" >&2; exit 64; }; older=$(realpath "$2"); shift 2 ;;
    -*) echo "$usage" >&2; exit 64 ;;
    *) if [ -z "$rpm_file" ]; then rpm_file=$(realpath "$1"); else images+=("$1"); fi; shift ;;
  esac
done
[ -n "$rpm_file" ] || { echo "$usage" >&2; exit 64; }
[ -f "$rpm_file" ] || { echo "rpm-install-test.sh: no file at $rpm_file" >&2; exit 1; }
[ -z "$older" ] || [ -f "$older" ] || { echo "rpm-install-test.sh: no file at $older" >&2; exit 1; }
[ ${#images[@]} -gt 0 ] || images=(fedora:43 almalinux:9 opensuse/tumbleweed)
engine=$(command -v docker || command -v podman || true)
[ -n "$engine" ] || { echo "rpm-install-test.sh: docker or podman is required" >&2; exit 1; }
here=$(cd "$(dirname "$0")" && pwd -P)

pull() {
  local attempt
  for attempt in 1 2 3; do
    if "$engine" pull -q "$1" >/dev/null; then return 0; fi
    echo "pull $1 failed (attempt $attempt of 3)"
    [ "$attempt" = 3 ] || sleep $((attempt * 10))
  done
  return 1
}

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
chmod 0755 "$work"

generated_older=0
if [ -z "$older" ]; then
  generated_older=1
  builder=fedora:43
  pull "$builder" || { echo "FAIL could not pull $builder to make the older build"; exit 1; }
  echo "== making the older build in $builder"
  "$engine" run --rm -v "$rpm_file:/pkg/new.rpm:ro" -v "$here:/scripts:ro" -v "$work:/out" "$builder" bash -c '
    set -euo pipefail
    echo "retries=5" >> /etc/dnf/dnf.conf
    dnf install -y -q rpm-build python3 cpio binutils >/tmp/older-deps.log 2>&1 || { tail -30 /tmp/older-deps.log; exit 1; }
    version=$(rpm -qp --qf "%{VERSION}" /pkg/new.rpm 2>/dev/null)
    version=${version/\~/-}
    if [[ "$version" =~ ^([0-9]+\.[0-9]+\.[0-9]+)-nightly\.([0-9]+)$ ]]; then
      if ((BASH_REMATCH[2] > 0)); then older="${BASH_REMATCH[1]}-nightly.$((BASH_REMATCH[2] - 1))"; else echo "no version sorts before $version"; exit 1; fi
    else
      older="$version-nightly.1"
    fi
    mkdir -p /tmp/tree && cd /tmp/tree
    rpm2cpio /pkg/new.rpm | cpio -idm --quiet
    echo "$older" > usr/lib/ardia/VERSION
    echo older > usr/lib/ardia/older-build-only
    python3 -I /scripts/linux_formats.py rpm --fast --tree /tmp/tree --version "$older" --destination /out/older.rpm >/dev/null
    echo "older build $older"
  ' || { echo "FAIL could not make the older build"; exit 1; }
  older="$work/older.rpm"
fi

check='
set -euo pipefail
fail() { echo "FAIL $*"; exit 1; }
if command -v zypper >/dev/null; then
  family=zypper
  install() { local try; for try in 1 2 3; do zypper -q -n --no-gpg-checks install --allow-unsigned-rpm "$@" && return 0; [ "$try" = 3 ] || sleep 10; done; return 1; }
  remove() { zypper -q -n remove "$@"; }
  refreshed() {
    local try
    for try in 1 2 3 4 5; do
      [ "$try" != 3 ] || sed -i "s|http://download.opensuse.org/|https://downloadcontent.opensuse.org/|" /etc/zypp/repos.d/*.repo
      zypper -q -n --gpg-auto-import-keys refresh --force >/dev/null && return 0
      [ "$try" = 5 ] || sleep 30
    done
    return 1
  }
  refreshed || fail "zypper could not refresh its repositories in 5 tries"
  install findutils diffutils desktop-file-utils which apparmor-parser apparmor-abstractions >/dev/null 2>&1
else
  family=dnf
  echo "retries=5" >> /etc/dnf/dnf.conf
  install() { dnf install -y -q "$@"; }
  remove() { dnf remove -y -q "$@"; }
  install findutils diffutils desktop-file-utils which >/dev/null 2>&1
fi
snapshot() {
  find / -xdev \( -path /proc -o -path /sys -o -path /dev -o -path /run -o -path /tmp -o -path /var/tmp -o -path /var/log \
    -o -path /var/cache -o -path /var/lib/rpm -o -path /usr/lib/sysimage/rpm -o -path /var/lib/dnf -o -path /usr/lib/sysimage/libdnf5 \
    -o -path /var/lib/zypp -o -path /etc/zypp -o -path /root -o -name mimeinfo.cache -o -name icon-theme.cache \) -prune \
    -o -print | sort
}
mapfile -t needs < <({ rpm -qp --requires /pkg/new.rpm; rpm -qp --recommends /pkg/new.rpm; } 2>/dev/null | grep -v "^rpmlib(" | sort -u)
if [ "$family" = zypper ]; then
  for i in "${!needs[@]}"; do
    [[ ${needs[$i]} =~ ^\(([^\ ]+)\ or\  ]] && needs[$i]=${BASH_REMATCH[1]}
  done
fi
install "${needs[@]}" >/tmp/deps.log 2>&1 || { cat /tmp/deps.log; fail "the dependencies do not resolve on $family"; }
echo "ok   dependencies resolve ($family)"
snapshot >/tmp/before
install /pkg/older.rpm >/tmp/older.log 2>&1 || { cat /tmp/older.log; fail "the older build does not install"; }
older=$(rpm -q --qf "%{VERSION}" ardia)
[ "$GENERATED_OLDER" = 0 ] || test -f /usr/lib/ardia/older-build-only || fail "the older build lacks its own file"
install /pkg/new.rpm >/tmp/install.log 2>&1 || { cat /tmp/install.log; fail "the upgrade from $older does not install"; }
expected=$(rpm -qp --qf "%{NAME}-%{VERSION}-%{RELEASE}.%{ARCH}" /pkg/new.rpm 2>/dev/null)
[ "$(rpm -q ardia)" = "$expected" ] || fail "rpm -q ardia says $(rpm -q ardia | tr "\n" " "), not $expected"
[ "$GENERATED_OLDER" = 0 ] || test ! -e /usr/lib/ardia/older-build-only || fail "the upgrade left the older build'"'"'s own file"
echo "ok   $older upgrades to $expected"
rpm --verify ardia >/tmp/verify.log 2>&1 || { cat /tmp/verify.log; fail "rpm --verify ardia"; }
echo "ok   rpm --verify"
missing=$(ldd /usr/lib/ardia/chrome /usr/lib/ardia/chrome_crashpad_handler | grep "not found" || true)
[ -z "$missing" ] || fail "unresolved libraries: $missing"
echo "ok   libraries resolve"
[ "$(stat -c "%a %U" /usr/lib/ardia/chrome-sandbox)" = "4755 root" ] || fail "chrome-sandbox is not setuid root"
echo "ok   chrome-sandbox is setuid root"
version=$(/usr/bin/ardia --version) || fail "ardia --version exited $?"
echo "ok   $version"
for class in ardia-little ardia-settings ardia-import; do
  grep -q "^StartupWMClass=$class$" "/usr/share/applications/$class.desktop" || fail "no $class.desktop for the $class windows"
  grep -q "^NoDisplay=true$" "/usr/share/applications/$class.desktop" || fail "$class.desktop is not hidden"
  grep -q "^Icon=ardia$" "/usr/share/applications/$class.desktop" || fail "$class.desktop has no ardia icon"
done
for entry in /usr/share/applications/ardia*.desktop; do
  desktop-file-validate "$entry" || fail "$entry does not validate"
  grep -q "^Exec=/usr/bin/ardia\( \|$\)" "$entry" || fail "$entry does not run /usr/bin/ardia"
done
test -f /usr/share/icons/hicolor/256x256/apps/ardia.png || fail "no icon"
grep -q dev.ardia.linux.reauthenticate /usr/share/polkit-1/actions/dev.ardia.linux.policy || fail "no polkit policy"
! grep -q dev.ardia.linux.update /usr/share/polkit-1/actions/dev.ardia.linux.policy || fail "the polkit policy offers the self-update action"
echo "ok   desktop entries, icon and polkit policy without the update action"
command -v curl >/dev/null || fail "no curl, which the bundled CLI installer needs"
kind=$(/usr/lib/ardia/ardia-update kind) || fail "ardia-update kind exited $?"
[ "$kind" = managed ] || fail "ardia-update kind says $kind, not managed"
echo "ok   updates are left to $family (ardia-update kind: managed)"
if [ -e /etc/apparmor.d/abi/4.0 ]; then
  grep -q "profile ardia /usr/lib/ardia/chrome " /etc/apparmor.d/ardia || fail "no AppArmor profile for /usr/lib/ardia/chrome"
  echo "ok   AppArmor profile installed"
else
  test ! -e /etc/apparmor.d/ardia || fail "an AppArmor profile without the 4.0 ABI"
  echo "ok   no AppArmor profile without the 4.0 ABI"
fi
remove ardia >/tmp/remove.log 2>&1 || { cat /tmp/remove.log; fail "removing ardia"; }
snapshot >/tmp/after
diff -u /tmp/before /tmp/after || fail "removing ardia changed the files above"
echo "ok   removal leaves nothing behind"
'

status=0
for image in "${images[@]}"; do
  echo "== $image"
  if ! pull "$image"; then
    echo "FAIL $image: could not pull it"
    status=1
    continue
  fi
  if ! "$engine" run --rm -e GENERATED_OLDER="$generated_older" -v "$rpm_file:/pkg/new.rpm:ro" -v "$older:/pkg/older.rpm:ro" "$image" bash -c "$check"; then
    echo "FAIL $image"
    status=1
  fi
done
exit $status
