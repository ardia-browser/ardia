#!/usr/bin/env bash
set -euo pipefail

usage="usage: scripts/release/cli-bootstrap-smoke.sh <Ardia.app> <version>
Launches hidden instances of <Ardia.app> on scratch data folders with scratch bin folders. A fresh profile is offered
the built-in Command Line plugin and gets no ardia until it's installed. A profile that installed it (its plugins.json
record, as Install writes it) gets ardia linked from the signed copy (so the copy passed the digest check), at the
version apps/browser/official-plugins.json pins (the command's own, not <version>), and with control on ardia tabs
answers."
case "${1:-}" in -h | --help | "") echo "$usage"; [ -n "${1:-}" ] && exit 0 || exit 64 ;; esac
app="$(cd "$1" && pwd -P)"
version="${2:?$usage}"
root="$(cd "$(dirname "$0")/../.." && pwd -P)"
case "$app" in /Applications/*) echo "error: never an installed app" >&2; exit 1 ;; esac
manifest="$app/Contents/Resources/Plugins/cli/plugin.json"
pinned="$(python3 -I -c 'import json, sys; print(next(p["version"] for p in json.load(open(sys.argv[1]))["plugins"] if p["name"] == "cli"))' "$root/apps/browser/official-plugins.json")"
[ -f "$manifest" ] || { echo "error: $app has no built-in Command Line plugin" >&2; exit 1; }
work="$(cd "$(mktemp -d /tmp/ac-cli.XXXXXX)" && pwd -P)"
pid=""
stop() {
  [ -n "$pid" ] && { kill "$pid" 2>/dev/null; for _ in $(seq 1 50); do kill -0 "$pid" 2>/dev/null || break; sleep 0.1; done; kill -KILL "$pid" 2>/dev/null; } || true
  pid=""
}
cleanup() {
  stop
  rm -rf "$work"
}
trap cleanup EXIT

status=0
check() {
  if [ "$2" = 1 ]; then echo "PASS  $1"; else echo "FAIL  $1${3:+  ($3)}"; status=1; fi
}

launch() {
  echo '{"version":1,"completedAt":1}' >"$1/onboarding.json"
  open -g -n --env ARDIA_BACKGROUND=1 --env "ARDIA_DATA_DIR=$1" --env "ARDIA_INSTANCE=cliBinDir=$2" \
    --stdout "$1/app.out.log" --stderr "$1/app.out.log" "$app"
  for _ in $(seq 1 100); do pid="$(pgrep -n -f "^$app/Contents/MacOS/Ardia" || true)"; [ -n "$pid" ] && break; sleep 0.1; done
}

fresh="$work/fresh"
mkdir -p "$fresh/d" "$fresh/bin"
launch "$fresh/d" "$fresh/bin"
for _ in $(seq 1 150); do [ -s "$fresh/d/session.json" ] && break; sleep 0.2; done
sleep 10
check "a fresh profile gets no ardia until it installs Command Line" "$([ ! -e "$fresh/bin/ardia" ] && [ ! -e "$fresh/d/Programs/cli/current" ] && echo 1 || echo 0)"
stop

data="$work/installed/d"
bin="$work/installed/bin"
mkdir -p "$data" "$bin"
approved="$(python3 -I -c 'import hashlib, sys; print(hashlib.sha256(open(sys.argv[1], "rb").read() + b"\0bundled").hexdigest())' "$manifest")"
printf '{"plugins":{"cli":{"enabled":true,"approved":"%s","values":{},"applied":{},"installed":true}},"version":1}\n' "$approved" >"$data/plugins.json"
(cd "$root" && node -e "import('./scripts/lib/instance.mjs').then(({ session }) => require('fs').writeFileSync(process.argv[1], JSON.stringify(session({ settings: { cliControl: true } }))))" "$data/session.json")
launch "$data" "$bin"
for _ in $(seq 1 300); do [ -L "$bin/ardia" ] && break; sleep 0.2; done
check "once installed, ardia is linked" "$([ -L "$bin/ardia" ] && echo 1 || echo 0)"
linked="$(readlink "$bin/ardia" || true)"
store="$(cd "$data" && pwd -P)/Programs/cli/current/bin/ardia"
check "from the signed copy in the store" "$([ "$linked" = "$store" ] || [ "$linked" = "$data/Programs/cli/current/bin/ardia" ] && echo 1 || echo 0)" "$linked"
got="$("$bin/ardia" --version 2>&1 || true)"
check "it is the pinned ardia $pinned (Ardia $version)" "$([ "$got" = "ardia $pinned" ] && echo 1 || echo 0)" "$got"
control="$data/Chromium/ArdiaControl.json"
for _ in $(seq 1 150); do [ -s "$control" ] && break; sleep 0.2; done
tabs="$(env -i HOME="$HOME" PATH="$bin:/usr/bin:/bin" ARDIA_DATA_DIR="$data" ARDIA_TELEMETRY=off ardia tabs 2>&1)" && ok=1 || ok=0
check "ardia tabs answers" "$ok" "$tabs"
exit "$status"
