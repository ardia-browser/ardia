#!/usr/bin/env bash
set -euo pipefail

usage="usage: scripts/release/cli-bootstrap-smoke.sh <Ardia.app> <version> <fixtures dir> [<earlier Ardia.app>]
Launches hidden instances of <Ardia.app> on scratch data folders with scratch bin folders, fetching official plugins
from <fixtures dir> (official-plugins.py fixtures: the pinned, SHA-256 checked release assets) instead of GitHub. A
fresh profile downloads nothing and gets no ardia until it installs Command Line. A profile whose plugins.json holds the
approval the Install sheet records for the pinned copy (its plugin.json under the official-<sha256> identity) fetches
it, checks its SHA-256 against the pin, links ardia from Ardia's copy without a quarantine flag, and with control on
ardia tabs answers; the linked ardia is the pinned version, run as published (ad hoc or Developer ID-signed alike). The
same profile with a changed asset, or with none (offline), gets no ardia and no downloaded copy. Command Line coverage
can't be skipped: no fixture fails. Given an earlier release that bundles Command Line (0.2.47), a profile where it
installed and linked its own ardia keeps that ardia on <Ardia.app>: the pinned copy is fetched and verified but waits for
your approval, because its plugin.json isn't the one approved, and plugins.json stays as it was; once the approval the
Update… sheet records is saved, ardia switches to the pinned version."
case "${1:-}" in -h | --help | "") echo "$usage"; [ -n "${1:-}" ] && exit 0 || exit 64 ;; esac
app="$(cd "$1" && pwd -P)"
version="${2:?$usage}"
fixtures="$(cd "${3:?$usage}" && pwd -P)"
earlier="${4:+$(cd "$4" && pwd -P)}"
root="$(cd "$(dirname "$0")/../.." && pwd -P)"
case "$app" in /Applications/*) echo "error: never an installed app" >&2; exit 1 ;; esac
case "$earlier" in /Applications/*) echo "error: never an installed app" >&2; exit 1 ;; esac
read -r pinned file sha < <(python3 -I -c 'import json, sys; p = next(p for p in json.load(open(sys.argv[1]))["plugins"] if p["name"] == "cli"); a = p["artifacts"]["macos-arm64"]; print(p["version"], a["file"], a["sha256"])' "$root/apps/browser/official-plugins.json")
[ -f "$fixtures/$file" ] || { echo "error: $fixtures has no $file; run scripts/release/official-plugins.py fixtures $fixtures" >&2; exit 1; }
[ "$(shasum -a 256 "$fixtures/$file" | cut -d' ' -f1)" = "$sha" ] || { echo "error: $fixtures/$file isn't the pinned $sha" >&2; exit 1; }
work="$(cd "$(mktemp -d /tmp/ac-cli.XXXXXX)" && pwd -P)"
pid=""
stop() {
  [ -n "$pid" ] && { kill "$pid" 2>/dev/null; for _ in $(seq 1 50); do kill -0 "$pid" 2>/dev/null || break; sleep 0.1; done; kill -KILL "$pid" 2>/dev/null; } || true
  pid=""
}
cleanup() {
  stop
  chmod -R u+w "$work" 2>/dev/null || true
  rm -rf "$work"
}
trap cleanup EXIT

status=0
check() {
  if [ "$2" = 1 ]; then echo "PASS  $1"; else echo "FAIL  $1${3:+  ($3)}"; status=1; fi
}

approved="$(python3 -I -c '
import hashlib, sys, tarfile
with tarfile.open(sys.argv[1], "r:gz") as packed:
    manifest = packed.extractfile("cli/plugin.json").read()
print(hashlib.sha256(manifest + b"\0official-" + sys.argv[2].encode()).hexdigest())' "$fixtures/$file" "$sha")"

launch() {
  local which="${4:-$app}"
  echo '{"version":1,"completedAt":1}' >"$1/onboarding.json"
  open -g -n --env ARDIA_BACKGROUND=1 --env "ARDIA_DATA_DIR=$1" --env "ARDIA_INSTANCE=cliBinDir=$2${3:+,officialPluginsFrom=$3}" \
    --stdout "$1/app.out.log" --stderr "$1/app.out.log" "$which"
  for _ in $(seq 1 100); do pid="$(pgrep -n -f "^$which/Contents/MacOS/Ardia" || true)"; [ -n "$pid" ] && break; sleep 0.1; done
}

installed_profile() {
  mkdir -p "$1/d" "$1/bin"
  printf '{"plugins":{"cli":{"enabled":true,"approved":"%s","values":{},"applied":{},"installed":true}},"version":1}\n' "$approved" >"$1/d/plugins.json"
  (cd "$root" && node -e "import('./scripts/lib/instance.mjs').then(({ session }) => require('fs').writeFileSync(process.argv[1], JSON.stringify(session({ settings: { cliControl: true } }))))" "$1/d/session.json")
}

fresh="$work/fresh"
mkdir -p "$fresh/d" "$fresh/bin"
launch "$fresh/d" "$fresh/bin" "$fixtures"
for _ in $(seq 1 150); do [ -s "$fresh/d/session.json" ] && break; sleep 0.2; done
sleep 10
check "a fresh profile downloads nothing and gets no ardia until it installs Command Line" \
  "$([ ! -e "$fresh/bin/ardia" ] && [ ! -e "$fresh/d/OfficialPlugins/cli/$sha" ] && [ ! -e "$fresh/d/Programs/cli/current" ] && echo 1 || echo 0)"
stop

data="$work/installed/d"
bin="$work/installed/bin"
installed_profile "$work/installed"
launch "$data" "$bin" "$fixtures"
for _ in $(seq 1 300); do [ -L "$bin/ardia" ] && break; sleep 0.2; done
check "the approved Command Line is fetched, verified and linked" "$([ -L "$bin/ardia" ] && echo 1 || echo 0)"
check "its download is kept under its SHA-256, with no quarantine flag" "$([ -f "$data/OfficialPlugins/cli/$sha/plugin.json" ] && [ -f "$data/OfficialPlugins/cli/$sha.tar.gz" ] && ! xattr -p com.apple.quarantine "$data/OfficialPlugins/cli/$sha/bin/ardia" >/dev/null 2>&1 && echo 1 || echo 0)"
linked="$(readlink "$bin/ardia" || true)"
store="$(cd "$data" && pwd -P)/Programs/cli/current/bin/ardia"
check "ardia comes from Ardia's copy in the store" "$([ "$linked" = "$store" ] || [ "$linked" = "$data/Programs/cli/current/bin/ardia" ] && echo 1 || echo 0)" "$linked"
check "the linked ardia is the pinned copy's, byte for byte" "$(cmp -s "$store" "$data/OfficialPlugins/cli/$sha/bin/ardia" && echo 1 || echo 0)"
got="$("$bin/ardia" --version 2>&1 || true)"
check "it is the pinned ardia $pinned (Ardia $version)" "$([ "$got" = "ardia $pinned" ] && echo 1 || echo 0)" "$got"
control="$data/Chromium/ArdiaControl.json"
for _ in $(seq 1 150); do [ -s "$control" ] && break; sleep 0.2; done
tabs="$(env -i HOME="$HOME" PATH="$bin:/usr/bin:/bin" ARDIA_DATA_DIR="$data" ARDIA_TELEMETRY=off ardia tabs 2>&1)" && ok=1 || ok=0
check "ardia tabs answers" "$ok" "$tabs"
stop

tampered="$work/tampered"
mkdir -p "$tampered/fixtures"
cp "$fixtures/$file" "$tampered/fixtures/$file"
printf 'x' >>"$tampered/fixtures/$file"
installed_profile "$tampered"
launch "$tampered/d" "$tampered/bin" "$tampered/fixtures"
sleep 15
check "a download that isn't the pinned one installs nothing" \
  "$([ ! -e "$tampered/bin/ardia" ] && [ ! -e "$tampered/d/OfficialPlugins/cli/$sha" ] && echo 1 || echo 0)"
stop

offline="$work/offline"
mkdir -p "$offline/none"
installed_profile "$offline"
launch "$offline/d" "$offline/bin" "$offline/none"
sleep 12
check "offline, nothing is half-installed and nothing goes on PATH" \
  "$([ ! -e "$offline/bin/ardia" ] && [ -z "$(find "$offline/d/OfficialPlugins" -mindepth 2 -maxdepth 2 ! -name '.*' 2>/dev/null)" ] && echo 1 || echo 0)"
stop

bundled="${earlier:+$earlier/Contents/Resources/Plugins/cli/plugin.json}"
if [ -z "$earlier" ]; then
  echo "SKIP  an earlier release's Command Line keeps working: no earlier release given"
elif [ ! -f "$bundled" ]; then
  echo "SKIP  an earlier release's Command Line keeps working: Ardia $(plutil -extract CFBundleShortVersionString raw "$earlier/Contents/Info.plist" 2>/dev/null) bundles no Command Line"
else
  read -r old_version receipt < <(python3 -I -c '
import hashlib, json, sys
text = open(sys.argv[1], "rb").read()
print(json.loads(text)["version"], hashlib.sha256(text + b"\0bundled").hexdigest())' "$bundled")
  upgrade="$work/upgrade"
  mkdir -p "$upgrade/d" "$upgrade/bin"
  printf '{"plugins":{"cli":{"enabled":true,"approved":"%s","values":{},"applied":{},"installed":true}},"version":1}\n' "$receipt" >"$upgrade/d/plugins.json"
  launch "$upgrade/d" "$upgrade/bin" "" "$earlier"
  for _ in $(seq 1 300); do [ -L "$upgrade/bin/ardia" ] && break; sleep 0.2; done
  sleep 2
  stop
  ran="$(env -i HOME="$HOME" PATH="$upgrade/bin:/usr/bin:/bin" ARDIA_DATA_DIR="$upgrade/d" ARDIA_TELEMETRY=off ardia --version 2>&1 || true)"
  check "the earlier release installs and links its own ardia $old_version" "$([ "$ran" = "ardia $old_version" ] && echo 1 || echo 0)" "$ran"
  saved="$(shasum -a 256 "$upgrade/d/plugins.json" | cut -d' ' -f1)"
  launch "$upgrade/d" "$upgrade/bin" "$fixtures"
  for _ in $(seq 1 300); do [ -f "$upgrade/d/OfficialPlugins/cli/$sha/plugin.json" ] && break; sleep 0.2; done
  sleep 5
  check "after the update, the pinned $pinned is fetched and verified, then waits for your approval instead of switching" \
    "$([ -f "$upgrade/d/OfficialPlugins/cli/$sha/plugin.json" ] && [ ! -e "$upgrade/d/OfficialPlugins/cli/active" ] && echo 1 || echo 0)"
  ran="$(env -i HOME="$HOME" PATH="$upgrade/bin:/usr/bin:/bin" ARDIA_DATA_DIR="$upgrade/d" ARDIA_TELEMETRY=off ardia --version 2>&1 || true)"
  check "ardia still runs, and is still the earlier $old_version" "$([ "$ran" = "ardia $old_version" ] && echo 1 || echo 0)" "$ran"
  check "plugins.json is untouched before you confirm" "$([ "$(shasum -a 256 "$upgrade/d/plugins.json" | cut -d' ' -f1)" = "$saved" ] && echo 1 || echo 0)"
  stop
  printf '{"plugins":{"cli":{"enabled":true,"approved":"%s","previous":"%s","values":{},"applied":{},"installed":true}},"version":1}\n' "$approved" "$receipt" >"$upgrade/d/plugins.json"
  launch "$upgrade/d" "$upgrade/bin" "$fixtures"
  for _ in $(seq 1 300); do [ -L "$upgrade/d/OfficialPlugins/cli/active" ] && break; sleep 0.2; done
  ran=""
  for _ in $(seq 1 100); do
    ran="$(env -i HOME="$HOME" PATH="$upgrade/bin:/usr/bin:/bin" ARDIA_DATA_DIR="$upgrade/d" ARDIA_TELEMETRY=off ardia --version 2>&1 || true)"
    [ "$ran" = "ardia $pinned" ] && break
    sleep 0.2
  done
  check "once you confirm (the approval Update… records), ardia is the pinned $pinned" "$([ "$ran" = "ardia $pinned" ] && echo 1 || echo 0)" "$ran"
  stop
fi
exit "$status"
