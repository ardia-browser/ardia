#!/usr/bin/env bash
set -euo pipefail
if [[ ${1:-} == -h || ${1:-} == --help || $# -lt 1 ]]; then
  echo "usage: CHROMIUM_SRC=<dev tree> scripts/mac/webui-engine/build.sh <out dir> [targets…]   apply the Mac layers with the dev-only inputs and build the WebUI shell incrementally; the out dir must be non-official (is_official_build compiles only the inert stub) and the tree must not be the shared ~/chromium-build" >&2
  exit 64
fi
here=$(cd "$(dirname "$0")" && pwd)
repo=$(cd "$here/../../.." && pwd)
src=${CHROMIUM_SRC:-}
out=$1
shift
targets=("$@")
(( ${#targets[@]} )) || targets=(chrome_framework)
[[ -n "$src" && -d "$src" ]] || { echo "build.sh: set CHROMIUM_SRC to a dev Chromium tree" >&2; exit 64; }
shared=$(cd "$HOME/chromium-build/chromium_git/chromium/src" 2>/dev/null && pwd -P || true)
[[ "$(cd "$src" && pwd -P)" != "$shared" ]] || { echo "build.sh: $src is the shared tree, whose out/ is never touched; use a dev copy" >&2; exit 1; }
[[ -f "$src/$out/args.gn" ]] || { echo "build.sh: no $src/$out/args.gn: incremental builds only" >&2; exit 1; }
if grep -Eq '^[[:space:]]*is_official_build[[:space:]]*=[[:space:]]*true' "$src/$out/args.gn"; then
  echo "build.sh: $out is an official build, which compiles only the inert WebUI stub" >&2
  exit 1
fi
exec "$repo/scripts/agent/locked" chromium --wait 1800 -- bash -c '
  set -euo pipefail
  repo=$1 src=$2 out=$3
  shift 3
  export CHROMIUM_SRC=$src
  "$repo/engine/chromium/apply.sh"
  "$repo/engine/ardiacore/apply.sh"
  "$repo/scripts/mac/webui-engine/apply.sh" --dev
  "$repo/scripts/mac/webui-engine/apply.sh" --check
  source "$repo/engine/patches/build/env.sh"
  cd "$src"
  memory_gb=$(( $(sysctl -n hw.memsize) / 1073741824 ))
  cpus=$(sysctl -n hw.ncpu)
  local_jobs=$(( memory_gb * 10 / 25 ))
  (( local_jobs > cpus )) && local_jobs=$cpus
  (( local_jobs < 2 )) && local_jobs=2
  export SISO_LIMITS="step=$(( local_jobs * 2 )),local=$local_jobs,remote=$local_jobs,startlocal=$local_jobs,fastlocal=$local_jobs"
  export PYTHONPATH="$repo/scripts/agent/python-worker-cap${PYTHONPATH:+:$PYTHONPATH}"
  autoninja -C "$out" -local_jobs="$local_jobs" "$@"
' build "$repo" "$src" "$out" "${targets[@]}"
