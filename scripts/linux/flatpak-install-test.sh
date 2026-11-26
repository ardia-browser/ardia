#!/usr/bin/env bash
set -euo pipefail
usage='usage: scripts/linux/flatpak-install-test.sh <Ardia-<version>-linux-x64.flatpak> [<image>...]

Installs the single-file Flatpak bundle with flatpak install --user --bundle in
fresh privileged containers (docker or podman; bubblewrap needs them), as an
ordinary user, and checks that its runtime comes from Flathub, it is
dev.ardia.Ardia on the stable branch at the bundle'"'"'s version, ardia --version
runs, the desktop entry, the hidden Little Ardia, Settings and Import entries
and the icon are exported under the app id and the entry opens links, cobalt.ini and zypak are there and chrome-sandbox is not setuid, the permissions hold the network,
display, sound, downloads, keyring and import grants and nothing of the home
folder beyond them, ardia-update leaves updates to Flatpak (kind: managed),
Ardia starts headless with Chromium'"'"'s sandbox through zypak (renderers without
--no-sandbox, a page target over DevTools), and flatpak uninstall --delete-data
leaves no app, export or data folder. The images default to ubuntu:24.04 and
fedora:43. Each image pull is tried 3 times.'

case "${1:-}" in
  -h|--help) echo "$usage"; exit 0 ;;
  ""|-*) echo "$usage" >&2; exit 64 ;;
esac
bundle=$(realpath "$1")
shift
[ -f "$bundle" ] || { echo "flatpak-install-test.sh: no file at $bundle" >&2; exit 1; }
images=("$@")
[ ${#images[@]} -gt 0 ] || images=(ubuntu:24.04 fedora:43)
engine=$(command -v docker || command -v podman || true)
[ -n "$engine" ] || { echo "flatpak-install-test.sh: docker or podman is required" >&2; exit 1; }

setup='
set -euo pipefail
if command -v apt-get >/dev/null; then
  export DEBIAN_FRONTEND=noninteractive
  echo "Acquire::Retries \"5\";" > /etc/apt/apt.conf.d/80-retries
  apt-get update -qq >/dev/null
  apt-get install -y -qq flatpak dbus curl procps >/dev/null 2>&1
else
  echo "retries=5" >> /etc/dnf/dnf.conf
  dnf install -y -q flatpak dbus-daemon curl procps-ng util-linux shadow-utils >/dev/null 2>&1
fi
mkdir -p /run/dbus
dbus-daemon --system --fork
flatpak remote-add --system --if-not-exists flathub https://dl.flathub.org/repo/flathub.flatpakrepo
useradd -m tester
su tester -c "dbus-run-session -- bash -c \"\$CHECK\""
'

check='
set -euo pipefail
fail() { echo "FAIL $*"; exit 1; }
app=dev.ardia.Ardia
exports=$HOME/.local/share/flatpak/exports/share
flatpak remote-add --user --if-not-exists flathub https://dl.flathub.org/repo/flathub.flatpakrepo
for try in 1 2 3; do
  flatpak install --user -y --noninteractive --bundle /pkg/ardia.flatpak >/tmp/install.log 2>&1 && break
  [ "$try" = 3 ] && { cat /tmp/install.log; fail "flatpak install --bundle"; }
  sleep 10
done
info=$(flatpak info --user "$app")
grep -q "Ref: app/$app/x86_64/stable" <<<"$info" || fail "the bundle is not app/$app/x86_64/stable: $info"
grep -q "Runtime: org.freedesktop.Platform/x86_64/" <<<"$info" || fail "no freedesktop runtime: $info"
flatpak list --user --runtime --columns=ref,origin | grep -q "^org.freedesktop.Platform/x86_64/.*flathub" || fail "the runtime did not come from Flathub"
echo "ok   $(grep -m1 "Version:" <<<"$info" | xargs), runtime from Flathub, branch stable"
version=$(flatpak run "$app" --version 2>/tmp/version.log) || { status=$?; tail -20 /tmp/version.log; fail "ardia --version exited $status"; }
echo "ok   $version"
desktop=$exports/applications/$app.desktop
test -f "$desktop" || fail "no exported $app.desktop"
grep -q "^Exec=.*flatpak run .*--command=ardia .*$app @@u %U @@" "$desktop" || fail "the exported entry does not open links in $app: $(grep ^Exec= "$desktop")"
grep -q "^MimeType=.*x-scheme-handler/https;" "$desktop" || fail "the exported entry does not take https links"
grep -q "^Icon=$app$" "$desktop" || fail "the exported entry has no $app icon"
test -f "$exports/icons/hicolor/256x256/apps/$app.png" || fail "no exported icon"
for window in little settings import; do
  hidden=$exports/applications/$app.$window.desktop
  grep -q "^StartupWMClass=ardia-$window$" "$hidden" || fail "no exported $app.$window.desktop for the ardia-$window windows"
  grep -q "^NoDisplay=true$" "$hidden" || fail "$app.$window.desktop is not hidden"
  grep -q "^Icon=$app$" "$hidden" || fail "$app.$window.desktop has no $app icon"
done
echo "ok   desktop entries and icon exported, links open in $app"
flatpak run --command=sh "$app" -c "test -f /app/lib/ardia/chrome-sandbox && test ! -u /app/lib/ardia/chrome-sandbox && test -f /app/etc/cobalt.ini && test -x /app/bin/zypak-wrapper.sh" || fail "the Flatpak lacks cobalt.ini, zypak or a plain chrome-sandbox for zypak to stand in for"
permissions=$(flatpak info --user --show-permissions "$app")
for want in shared=network shared=ipc sockets=wayland sockets=fallback-x11 sockets=pulseaudio devices=all filesystems=xdg-download; do
  values=$(grep "^${want%%=*}=" <<<"$permissions" | cut -d= -f2-)
  [[ ";$values" == *";${want#*=};"* ]] || fail "the permissions lack $want: $permissions"
done
for name in org.freedesktop.secrets org.freedesktop.Notifications; do
  grep -qx "$name=talk" <<<"$permissions" || fail "the permissions don'"'"'t let it talk to $name: $permissions"
done
filesystems=$(grep "^filesystems=" <<<"$permissions" | cut -d= -f2-)
for grant in ${filesystems//;/ }; do
  case "$grant" in
    xdg-download|xdg-run/pipewire-0) ;;
    xdg-config/*:ro|"~/.mozilla/"*:ro|"~/.librewolf:ro"|"~/.zen:ro"|"~/.var/app/"*:ro|"~/snap/"*:ro) ;;
    *) fail "the Flatpak reaches $grant, beyond downloads, PipeWire and other browsers'"'"' data read-only" ;;
  esac
done
echo "ok   cobalt.ini, zypak and a plain chrome-sandbox; network, display, sound, devices, downloads, keyring and read-only import grants"
mkdir -p "$HOME/.config/google-chrome" "$HOME/.mozilla/firefox" "$HOME/.config/ungranted"
echo chrome > "$HOME/.config/google-chrome/Local State"
echo firefox > "$HOME/.mozilla/firefox/profiles.ini"
echo hidden > "$HOME/.config/ungranted/secret"
flatpak run --command=sh "$app" -c '"'"'
  set -e
  [ "$XDG_CONFIG_HOME" = "$HOME/.var/app/dev.ardia.Ardia/config" ] || { echo "XDG_CONFIG_HOME is $XDG_CONFIG_HOME"; exit 1; }
  grep -qx chrome "$XDG_CONFIG_HOME/google-chrome/Local State" || { echo "no host Chrome profile at \$XDG_CONFIG_HOME/google-chrome"; exit 1; }
  grep -qx firefox "$HOME/.mozilla/firefox/profiles.ini" || { echo "no host Firefox profile at ~/.mozilla/firefox"; exit 1; }
  ! touch "$XDG_CONFIG_HOME/google-chrome/written" 2>/dev/null || { echo "the Chrome profile is writable"; exit 1; }
  [ ! -e "$XDG_CONFIG_HOME/ungranted" ] && [ ! -e "$HOME/.config/ungranted" ] || { echo "an ungranted config folder is visible"; exit 1; }
'"'"' || fail "Import can'"'"'t read other browsers'"'"' profiles where the engine looks, or reaches more than them"
echo "ok   Import reads host browser profiles at \$XDG_CONFIG_HOME and ~/.mozilla read-only, and nothing else of ~/.config"
kind=$(flatpak run --command=/app/lib/ardia/ardia-update "$app" kind) || fail "ardia-update kind exited $?"
[ "$kind" = managed ] || fail "ardia-update kind says $kind, not managed"
echo "ok   updates are left to Flatpak (ardia-update kind: managed)"
flatpak run --env=ARDIA_BACKGROUND=1 "$app" --ozone-platform=headless --use-angle=swiftshader --remote-debugging-port=9333 about:blank >/tmp/run.log 2>&1 &
started=""
for _ in $(seq 1 60); do
  if curl -fsS http://127.0.0.1:9333/json/version >/tmp/version.json 2>/dev/null; then started=1; break; fi
  sleep 1
done
[ -n "$started" ] || { tail -40 /tmp/run.log; fail "Ardia did not start headless in the Flatpak"; }
curl -fsS -X PUT "http://127.0.0.1:9333/json/new?data:text/html,ardia" >/dev/null || fail "DevTools did not open a page"
sleep 3
curl -fsS http://127.0.0.1:9333/json/list | grep -q "\"type\": \"page\"" || fail "no page target"
processes=$(ps -eo args)
renderers=$(grep -c "^/app/lib/ardia/chrome --type=renderer" <<<"$processes" || true)
[ "$renderers" -gt 0 ] || { tail -40 /tmp/run.log; fail "no renderer process"; }
! grep "^/app/lib/ardia/chrome" <<<"$processes" | grep -q -- "--no-sandbox" || fail "a Chromium process runs with --no-sandbox"
grep -q "/app/bin/zypak-helper child .*/app/lib/ardia/chrome --type=zygote" <<<"$processes" || { grep -E "zypak|ardia/chrome" <<<"$processes" | cut -c1-200; fail "Chromium'"'"'s zygote does not run in zypak'"'"'s sandbox"; }
echo "ok   starts headless with the zygote in zypak'"'"'s sandbox, $renderers renderers, none with --no-sandbox, a page over DevTools"
flatpak kill "$app" 2>/dev/null || true
for _ in $(seq 1 20); do flatpak ps --columns=application | grep -q "$app" || break; sleep 1; done
test -d "$HOME/.var/app/$app" || fail "no data folder under ~/.var/app/$app after a run"
flatpak uninstall --user -y --noninteractive --delete-data "$app" >/tmp/uninstall.log 2>&1 || { cat /tmp/uninstall.log; fail "flatpak uninstall"; }
test ! -e "$HOME/.local/share/flatpak/app/$app" || fail "the app folder is left behind"
test ! -e "$desktop" || fail "the desktop entry is left behind"
for window in little settings import; do
  test ! -e "$exports/applications/$app.$window.desktop" || fail "$app.$window.desktop is left behind"
done
test ! -e "$exports/icons/hicolor/256x256/apps/$app.png" || fail "the icon is left behind"
test ! -e "$HOME/.var/app/$app" || fail "the data folder is left behind after --delete-data"
echo "ok   flatpak uninstall --delete-data leaves nothing behind"
'

pull() {
  local attempt
  for attempt in 1 2 3; do
    if "$engine" pull -q "$1" >/dev/null; then return 0; fi
    echo "pull $1 failed (attempt $attempt of 3)"
    [ "$attempt" = 3 ] || sleep $((attempt * 10))
  done
  return 1
}

status=0
for image in "${images[@]}"; do
  echo "== $image"
  if ! pull "$image"; then
    echo "FAIL $image: could not pull it"
    status=1
    continue
  fi
  if ! "$engine" run --rm --privileged -e CHECK="$check" -v "$bundle:/pkg/ardia.flatpak:ro" "$image" bash -c "$setup"; then
    echo "FAIL $image"
    status=1
  fi
done
exit $status
