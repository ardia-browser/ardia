#!/usr/bin/env bash
set -uo pipefail
usage='usage: scripts/linux/ci-checks.sh [--part all|ui|engine] [--shard I/N] [--jobs N] [--logs DIR]

Runs the Linux checks that need no engine: the apps/desktop typecheck, host,
symbol, module-graph and acceptance self-tests, the UI build, the smoke gate
unit tests, and the Python and Node fixture suites under engine/.

--part ui runs the apps/desktop and scripts/linux checks, side by side.
--part engine runs the Python suites (engine/ardiacore-desktop/tests among them) and the engine/ardiacore-linux modules,
N at a time (default: the CPU count), each under a 10-minute deadline.
--shard I/N keeps the engine part to every Nth Python suite and module,
starting at the Ith, so N runners split it. The default part is all.

Every check runs; the exit status is non-zero if any failed, and each check
leaves its output in DIR (default: a temporary directory).'
jobs=$(nproc)
logs=""
part=all
shard=1
shards=1
while [ $# -gt 0 ]; do
  case "$1" in
    -h|--help) echo "$usage"; exit 0 ;;
    --jobs) jobs=$2; shift 2 ;;
    --logs) logs=$2; shift 2 ;;
    --part) part=$2; shift 2 ;;
    --shard) case "$2" in */*) shard=${2%/*}; shards=${2#*/} ;; *) echo "$usage" >&2; exit 64 ;; esac; shift 2 ;;
    *) echo "$usage" >&2; exit 64 ;;
  esac
done
case "$part" in all|ui|engine) ;; *) echo "$usage" >&2; exit 64 ;; esac
if ! [[ "$shard" =~ ^[0-9]+$ && "$shards" =~ ^[0-9]+$ ]] || [ "$shard" -lt 1 ] || [ "$shard" -gt "$shards" ]; then
  echo "$usage" >&2
  exit 64
fi
root=$(cd "$(dirname "$0")/../.." && pwd)
cd "$root" || exit 1
[ -n "$logs" ] || logs=$(mktemp -d)
mkdir -p "$logs"
export PYTHONDONTWRITEBYTECODE=1
failed=()
names=()

start() {
  local name=$1
  shift
  names+=("$name")
  (
    started=$(date +%s)
    timeout 900 "$@" >"$logs/$name.log" 2>&1
    echo "$? $(( $(date +%s) - started ))" >"$logs/$name.status"
  ) &
}

report() {
  wait
  local name status seconds
  for name in "${names[@]}"; do
    read -r status seconds <"$logs/$name.status"
    if [ "$status" -eq 0 ]; then
      echo "ok    ${seconds}s  $name"
    else
      echo "FAIL  ${seconds}s  $name (exit $status, $logs/$name.log)"
      tail -40 "$logs/$name.log" | sed 's/^/      /'
      failed+=("$name")
    fi
  done
  names=()
}

mine() {
  awk -v shard="$shard" -v shards="$shards" '(NR - 1) % shards == shard - 1'
}

if [ "$part" != engine ]; then
  start linux-typecheck pnpm --filter @ardia/desktop typecheck
  start linux-test-host pnpm --filter @ardia/desktop test:host
  start linux-test-symbols pnpm --filter @ardia/desktop test:symbols
  start linux-test-graph pnpm --filter @ardia/desktop test:graph
  start linux-acceptance-self-test pnpm --filter @ardia/desktop acceptance:self-test
  start linux-build pnpm --filter @ardia/desktop build
  start desktop-build-win pnpm --filter @ardia/desktop build:win
  start ardiacore-linux-bootstrap node --test engine/ardiacore-linux/tests/bootstrap.test.mjs
  start linux-smoke-gate node --test scripts/linux/smoke.test.mjs
  start linux-ubo-seed node --test scripts/linux/ubo-seed.test.mjs
  start linux-sign-update node --test scripts/linux/sign-update.test.mjs
  start linux-launcher node --test scripts/linux/ardia-launch.test.mjs
  report
fi

if [ "$part" != ui ]; then
  suites=$(printf '%s\n' patches-build-tests:engine/patches/build/tests chromium-ardia-tests:engine/chromium/src/chrome/browser/ardia/tests ardiacore-desktop-tests:engine/ardiacore-desktop/tests | mine)
  for suite in $suites; do
    start "${suite%%:*}" python3 -m unittest discover -s "${suite#*:}"
  done
  report

  modules=$(cd engine/ardiacore-linux/tests && ls test_*.py | sed 's/\.py$//' | mine)
  if [ -n "$modules" ]; then
    started=$(date +%s)
    results=$(cd engine/ardiacore-linux/tests && printf '%s\n' $modules | xargs -P "$jobs" -I{} sh -c \
      'begun=$(date +%s); timeout 600 python3 -m unittest {} >"$1/ardiacore-linux-{}.log" 2>&1; echo "$? {} $(( $(date +%s) - begun ))"' sh "$logs")
    module_failures=$(awk '$1 != 0 { print $2 }' <<<"$results")
    if [ -z "$module_failures" ]; then
      echo "ok    $(( $(date +%s) - started ))s  ardiacore-linux-tests ($(wc -l <<<"$results") modules, shard $shard of $shards)"
      sort -k3,3nr <<<"$results" | head -5 | awk '{ print "        " $3 "s  " $2 }'
    else
      for module in $module_failures; do
        echo "FAIL  ardiacore-linux-tests $module ($logs/ardiacore-linux-$module.log)"
        tail -40 "$logs/ardiacore-linux-$module.log" | sed 's/^/      /'
        failed+=("ardiacore-linux-$module")
      done
    fi
  fi
fi

if [ "${#failed[@]}" -gt 0 ]; then
  echo "failed: ${failed[*]}"
  exit 1
fi
echo "all Linux checks passed ($part, shard $shard of $shards)"
