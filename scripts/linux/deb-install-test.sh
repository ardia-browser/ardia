#!/usr/bin/env bash
set -euo pipefail
usage='usage: scripts/linux/deb-install-test.sh <Ardia-<version>-linux-x64.deb> [<image>...]

Installs the .deb with apt in fresh containers (docker or podman) and checks
that its dependencies resolve, every library chrome needs is found, chrome
--version runs, chrome-sandbox is setuid root, ardia is an x-www-browser
alternative that survives a rolled-back deconfigure or remove, curl is there for the bundled CLI installer, the AppArmor profile
is written only where AppArmor reads the 4.0 ABI, and apt purge leaves the file
system as it was before the install. The images default to debian:13 and
ubuntu:24.04; ubuntu:24.04 also gets the apparmor package first, so its run
covers the profile. apt retries each download 5 times and each image pull is
tried 3 times, so one network flake does not fail the test.'

case "${1:-}" in
  -h|--help) echo "$usage"; exit 0 ;;
  ""|-*) echo "$usage" >&2; exit 64 ;;
esac
deb=$(realpath "$1")
shift
[ -f "$deb" ] || { echo "deb-install-test.sh: no file at $deb" >&2; exit 1; }
images=("$@")
[ ${#images[@]} -gt 0 ] || images=(debian:13 ubuntu:24.04)
engine=$(command -v docker || command -v podman || true)
[ -n "$engine" ] || { echo "deb-install-test.sh: docker or podman is required" >&2; exit 1; }

check='
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
echo "Acquire::Retries \"5\";" > /etc/apt/apt.conf.d/80-retries
fail() { echo "FAIL $*"; exit 1; }
snapshot() {
  find / -xdev \( -path /proc -o -path /sys -o -path /dev -o -path /run -o -path /tmp -o -path /var/log \
    -o -path /var/cache/apt -o -path /var/cache/debconf -o -path /var/lib/apt -o -path /var/lib/dpkg -o -path /root \) -prune \
    -o -print | sort
  find /var/lib/dpkg/info -name "ardia*" | sort
}
apt-get update -qq
if [ "$WITH_APPARMOR" = 1 ]; then apt-get install -y -qq --no-install-recommends apparmor >/dev/null; fi
apt-get satisfy -y -qq "$(dpkg-deb -f /pkg/ardia.deb Depends), $(dpkg-deb -f /pkg/ardia.deb Recommends)" >/tmp/deps.log 2>&1 \
  || { cat /tmp/deps.log; fail "the dependencies do not resolve"; }
echo "ok   dependencies resolve"
snapshot >/tmp/before
apt-get install -y -qq /pkg/ardia.deb >/tmp/install.log 2>&1 || { cat /tmp/install.log; exit 1; }
missing=$(ldd /usr/lib/ardia/chrome /usr/lib/ardia/chrome_crashpad_handler | grep "not found" || true)
[ -z "$missing" ] || fail "unresolved libraries: $missing"
echo "ok   libraries resolve"
[ "$(stat -c "%a %U" /usr/lib/ardia/chrome-sandbox)" = "4755 root" ] || fail "chrome-sandbox is not setuid root"
echo "ok   chrome-sandbox is setuid root"
version=$(/usr/bin/ardia --version) || fail "ardia --version exited $?"
echo "ok   $version"
grep -qx "Exec=/usr/bin/ardia %U" /usr/share/applications/ardia.desktop || fail "the desktop entry does not run /usr/bin/ardia"
test -f /usr/share/icons/hicolor/256x256/apps/ardia.png || fail "no icon"
test -f /usr/share/polkit-1/actions/dev.ardia.linux.policy || fail "no polkit policy"
echo "ok   desktop entry, icon and polkit policy"
update-alternatives --query x-www-browser | grep -qx "Alternative: /usr/bin/ardia" || fail "ardia is not an x-www-browser alternative"
update-alternatives --query gnome-www-browser | grep -qx "Alternative: /usr/bin/ardia" || fail "ardia is not a gnome-www-browser alternative"
command -v curl >/dev/null || fail "no curl, which the bundled CLI installer needs"
echo "ok   x-www-browser and gnome-www-browser alternatives, curl"
update-alternatives --set x-www-browser /usr/bin/ardia >/dev/null
/var/lib/dpkg/info/ardia.prerm deconfigure in-favour other 1.0
/var/lib/dpkg/info/ardia.postinst abort-deconfigure in-favour other 1.0
update-alternatives --query x-www-browser | grep -qx "Status: manual" || fail "a rolled-back deconfigure lost the manual x-www-browser choice"
update-alternatives --query x-www-browser | grep -qx "Value: /usr/bin/ardia" || fail "a rolled-back deconfigure moved x-www-browser off ardia"
/var/lib/dpkg/info/ardia.prerm remove
/var/lib/dpkg/info/ardia.postinst abort-remove
update-alternatives --query gnome-www-browser | grep -qx "Alternative: /usr/bin/ardia" || fail "a rolled-back remove left ardia without its alternatives"
echo "ok   alternatives survive a rolled-back deconfigure and remove"
if [ -e /etc/apparmor.d/abi/4.0 ]; then
  grep -q "profile ardia /usr/lib/ardia/chrome " /etc/apparmor.d/ardia || fail "no AppArmor profile for /usr/lib/ardia/chrome"
  echo "ok   AppArmor profile installed"
else
  test ! -e /etc/apparmor.d/ardia || fail "an AppArmor profile without the 4.0 ABI"
  echo "ok   no AppArmor profile without the 4.0 ABI"
fi
apt-get purge -y -qq ardia >/dev/null
snapshot >/tmp/after
diff -u /tmp/before /tmp/after || fail "apt purge changed the files above"
echo "ok   apt purge leaves nothing behind"
'

status=0
for image in "${images[@]}"; do
  with_apparmor=0
  [[ "$image" == ubuntu:* ]] && with_apparmor=1
  echo "== $image (AppArmor package: $([ $with_apparmor = 1 ] && echo yes || echo no))"
  pulled=0
  for attempt in 1 2 3; do
    if "$engine" pull -q "$image" >/dev/null; then pulled=1; break; fi
    echo "pull $image failed (attempt $attempt of 3)"
    [ "$attempt" = 3 ] || sleep $((attempt * 10))
  done
  if [ "$pulled" = 0 ]; then
    echo "FAIL $image: could not pull it"
    status=1
    continue
  fi
  if ! "$engine" run --rm -e WITH_APPARMOR=$with_apparmor -v "$deb:/pkg/ardia.deb:ro" "$image" bash -c "$check"; then
    echo "FAIL $image"
    status=1
  fi
done
exit $status
