#!/bin/bash
# Runs the shared WebUI as the Mac app's shell, for testing only. Debug builds only: a Release app ignores the flag.
#
#   scripts/mac/run-webui-dev.sh [--app <Ardia.app>] [--webui-app <host.app>] [--data-dir <path>] [--background]
#                                [--port <n>] [--no-build] [--dry-run]
#   scripts/mac/run-webui-dev.sh -h | --help
#
# It builds the WebUI bundle (pnpm -C apps/desktop build:mac, into apps/desktop/dist/mac) and opens the Debug app with
# ARDIA_SHELL=webui and --ardia-shell=webui. The app then hands off to the WebUI host (ARDIA_WEBUI_APP, else
# "Ardia WebUI Dev.app" beside it) with ARDIA_WEBUI_BUNDLE pointing at the bundle; with no host built yet it logs where
# it looked and stays on the React Native shell.
#
# --app PATH         the Debug Ardia.app to open (default: $ARDIA_APP, else the newest apps/browser/build-*/ Debug app).
# --webui-app PATH   the dev-only WebUI host app scripts/mac/webui-engine assembles (sets ARDIA_WEBUI_APP to its
#                    resolved path). Without it the app looks for "Ardia WebUI Dev.app" beside itself.
# --data-dir PATH    the profile to use (default: ~/Library/Application Support/Ardia WebUI Dev). Anything inside the
#                    installed app's profile (Application Support/com.ardia.browser or Application Support/Ardia, by
#                    any case, symlink or alias) is refused; point it at a copy instead.
# --background       a hidden instance (ARDIA_BACKGROUND=1): no focus, menus and file panels are logged.
# --port N           ARDIA_REMOTE_DEBUGGING_PORT for CDP.
# --no-build         reuse apps/desktop/dist/mac as it is.
# --dry-run          print the build and open commands instead of running them.
set -euo pipefail

usage() { awk 'NR == 1 { next } /^#/ { sub(/^# ?/, ""); print; next } { exit }' "$0"; }
die() { echo "run-webui-dev: $*" >&2; exit 1; }

root=$(cd "$(dirname "$0")/../.." && pwd -P)
support="$HOME/Library/Application Support"
data_dir="$support/Ardia WebUI Dev"

lowercase() { printf '%s' "$1" | tr '[:upper:]' '[:lower:]'; }

canonical_path() {
  command -v python3 >/dev/null || return 1
  python3 -I -c 'import os, sys; print(os.path.realpath(sys.argv[1]), end="")' "$1"
}

inside_profile() {
  local candidate=$1 root=$2 canonical_root ancestor root_id
  canonical_root=$(canonical_path "$root") || return 0
  case "$(lowercase "$candidate")/" in "$(lowercase "$canonical_root")"/*) return 0 ;; esac
  [ -e "$root" ] || return 1
  root_id=$(stat -L -f '%d:%i' "$root") || return 0
  ancestor=$candidate
  while [ -n "$ancestor" ] && [ "$ancestor" != / ]; do
    [ -e "$ancestor" ] && [ "$(stat -L -f '%d:%i' "$ancestor")" = "$root_id" ] && return 0
    ancestor=$(dirname "$ancestor")
  done
  return 1
}

refuse_live_profile() {
  local candidate root
  candidate=$(canonical_path "$1") || die "can't resolve $1; pass --data-dir with a directory you own"
  for root in "${live_roots[@]}"; do
    ! inside_profile "$candidate" "$root" || die "refusing $1: it is inside the installed app's profile ($root); pass --data-dir with a copy"
  done
}
app="${ARDIA_APP:-}"
webui_app=""
background=0
port=""
build=1
dry_run=0

while [ $# -gt 0 ]; do
  case "$1" in
    -h | --help) usage; exit 0 ;;
    --app) [ $# -ge 2 ] || die "--app needs a path"; app="$2"; shift 2 ;;
    --webui-app) [ $# -ge 2 ] || die "--webui-app needs a path"; webui_app="$2"; shift 2 ;;
    --data-dir) [ $# -ge 2 ] || die "--data-dir needs a path"; data_dir="$2"; shift 2 ;;
    --background) background=1; shift ;;
    --port) [ $# -ge 2 ] || die "--port needs a number"; port="$2"; shift 2 ;;
    --no-build) build=0; shift ;;
    --dry-run) dry_run=1; shift ;;
    *) usage >&2; die "unknown option $1" ;;
  esac
done

[ -z "$port" ] || [[ "$port" =~ ^[0-9]+$ ]] || die "--port takes a number, not $port"
if [ -z "$app" ]; then
  app=$(ls -td "$root"/apps/browser/build-*/Build/Products/Debug/Ardia*.app "$root"/apps/browser/build-*/Prebuilt/Debug*/Ardia*.app 2>/dev/null | head -1 || true)
  [ -n "$app" ] || [ "$dry_run" = 1 ] || die "no Debug app found; build one with scripts/agent/build-app --as <you>, or pass --app"
  app="${app:-<Debug Ardia.app>}"
fi
[ "$dry_run" = 1 ] || [ -d "$app" ] || die "no app at $app"

live_roots=("$support/com.ardia.browser" "$support/Ardia")
app_identifier=$([ -f "$app/Contents/Info.plist" ] && /usr/libexec/PlistBuddy -c 'Print CFBundleIdentifier' "$app/Contents/Info.plist" 2>/dev/null || true)
[ -z "$app_identifier" ] || live_roots+=("$support/$app_identifier")
data_dir=$(canonical_path "$data_dir") || die "can't resolve $data_dir"
refuse_live_profile "$data_dir"
[ "$dry_run" = 1 ] || mkdir -p "$data_dir" || die "can't create $data_dir"

if [ -n "$webui_app" ]; then
  webui_app=$(canonical_path "$webui_app") || die "can't resolve $webui_app"
fi

bundle="$root/apps/desktop/dist/mac"
build_cmd=(pnpm -C "$root/apps/desktop" build:mac)
open_cmd=(open -g -n --env ARDIA_SHELL=webui --env "ARDIA_DATA_DIR=$data_dir" --env "ARDIA_WEBUI_BUNDLE=$bundle")
[ "$background" = 0 ] || open_cmd+=(--env ARDIA_BACKGROUND=1)
[ -z "$port" ] || open_cmd+=(--env "ARDIA_REMOTE_DEBUGGING_PORT=$port")
[ -z "$webui_app" ] || open_cmd+=(--env "ARDIA_WEBUI_APP=$webui_app")
open_cmd+=("$app" --args --ardia-shell=webui)

if [ "$dry_run" = 1 ]; then
  if [ "$build" = 1 ]; then printf '%q ' "${build_cmd[@]}"; echo; fi
  printf '%q ' "${open_cmd[@]}"; echo
  exit 0
fi

[ "$build" = 0 ] || "${build_cmd[@]}"
[ -f "$bundle/index.html" ] || die "no WebUI bundle at $bundle; run without --no-build"
"${open_cmd[@]}"
echo "Opened $app as the WebUI shell (dev only), profile $data_dir."
echo "Its log says [webui-dev] for the hand-off: log stream --predicate 'eventMessage CONTAINS \"[webui-dev]\"'"
