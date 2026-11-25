#!/bin/bash
# The stable release's perf gate, start to finish, under one perflab lock (docs/perf/README.md › Gating a release).
#
#   apps/browser/scripts/perf/gate.sh <version> <previous> [--out <dir>] [--port <n>] [--control-bundle <file>]
#
# The candidate is dist/<version>-rc/export/Ardia.app, the control dist/<previous>/export/Ardia.app. It takes the perflab
# lock for the whole run, and stops at once with the lock's 75 when it stays busy past GATE_LOCK_WAIT seconds (3600).
# Then:
#   1. side by side: smoke.sh <version> <previous> --rc, ratchet.mjs run --own, native-bench --only prepare
#      (logs in <out>/smoke.log, ratchet.log, prep.log)
#   2. two native-bench rounds (launch x6, session x2, windows x2), each in a new folder under <out>
#   3. gate-verdict.mjs on both rounds
#   4. on a pass, keeps the candidate's bench bundle as dist/<version>/bench/main.jsbundle: the next gate's control bundle
# Exit: 0 pass, 1 a row fails, 2 a round is invalid; 10 the smoke test failed, 11 the ratchet, 12 the prepare, 13 round 1,
# 14 round 2, 15 the verdict couldn't run (each step's own status is in the output); 70 it passed but the bundle
# couldn't be kept; 71 an app instance it launched is still running after cleanup (whatever the verdict); 75 the lock
# stayed busy; 130, 143, 129 stopped by INT, TERM, HUP. No step's status is passed
# through, so none can be taken for the lock's own 75-77.
# Stopping it (INT, TERM or HUP to its pid or its process group) stops every job it started: INT first, so the
# benches quit their instances, then TERM, then KILL, each after a deadline. The lock stays held until they have all
# exited, and it returns after that. Each run keeps its own folder, <out>/.run.XXXXXX (the worker's pid, each job's
# group marker), removed at the end unless cleanup failed. The jobs run with TMPDIR set to a scratch folder of the
# run's, /tmp/ac-gate.XXXXXX (its ratchet report is in ac-ratchet/ there), and the benches keep their data in
# <out>/prep/rc, <out>/prep/<previous> and each round's own folder, so every app instance they launch with `open`
# (outside every process group) has ARDIA_DATA_DIR or HOME inside one of those. <out> itself is never one: anything
# else under it, or beside it, is someone else's. bench-sweep.mjs quits, then kills, exactly those, and checks they're gone before the lock is let go. The lock wrapper runs in a process group of its
# own and only the worker under it is signalled, so the wrapper waits for the worker before it lets go.
set -u
here=$(cd "$(dirname "$0")" && pwd)
self=$here/$(basename "$0")
root=${GATE_ROOT:-$(cd "$here/../../../.." && pwd)}
perf=${GATE_PERF:-$here}
sweep=${GATE_SWEEP:-$here/bench-sweep.mjs}
GATE_SHARED_TMPDIR=${GATE_SHARED_TMPDIR:-${TMPDIR:-/tmp}}
export GATE_SHARED_TMPDIR
smoke=${GATE_SMOKE:-$root/.claude/skills/release/scripts/smoke.sh}

help() { sed -n '2,/^set -u/p' "$self" | sed '$d' | sed 's/^# \{0,1\}//'; }
case ${1:-} in -h | --help) help; exit 0 ;; esac
[ $# -ge 2 ] || { help >&2; exit 64; }
version=$1 previous=$2
shift 2
out=$HOME/ardia-scratch/gate-$version port=9478 control_bundle=$root/dist/$previous/bench/main.jsbundle
while [ $# -gt 0 ]; do
  case $1 in
    --out) out=$2; shift 2 ;;
    --port) port=$2; shift 2 ;;
    --control-bundle) control_bundle=$2; shift 2 ;;
    *) echo "gate.sh: unknown option $1 (--help)" >&2; exit 64 ;;
  esac
done

own_group=(perl -e '$SIG{INT} = $SIG{QUIT} = "DEFAULT"; setpgrp(0, 0); open(my $f, ">", "$ENV{GATE_RUN}/group.$$") or die "gate.sh: cannot mark the group: $!\n"; close $f; exec { $ARGV[0] } @ARGV or die "gate.sh: cannot run $ARGV[0]: $!\n"')
group_alive() { kill -0 -- "-$1" 2>/dev/null; }
await_group() {
  local end=$(($(date +%s) + 10))
  while [ ! -e "$GATE_RUN/group.$1" ] && kill -0 "$1" 2>/dev/null && [ "$(date +%s)" -lt "$end" ]; do sleep 0.02; done
  [ -e "$GATE_RUN/group.$1" ] || { kill -KILL "$1" 2>/dev/null; wait "$1" 2>/dev/null; return 1; }
}
wait_groups() {
  local secs=$1 end g alive
  shift
  end=$(($(date +%s) + secs))
  while :; do
    alive=0
    for g in "$@"; do group_alive "$g" && alive=1; done
    [ "$alive" = 0 ] && return 0
    [ "$(date +%s)" -ge "$end" ] && return 1
    sleep 0.2
  done
}
stop_groups() {
  local steps=$1 step g
  shift
  for step in $steps; do
    for g in "$@"; do kill -"${step%:*}" -- "-$g" 2>/dev/null; done
    wait_groups "${step#*:}" "$@" && return 0
  done
}
pending=""
defer_signals() { trap 'pending=130' INT; trap 'pending=143' TERM; trap 'pending=129' HUP; }

sweep_markers() {
  local args=() m
  [ -s "$GATE_RUN/markers" ] || return 0
  while IFS= read -r m; do [ -n "$m" ] && args+=(--under "$m"); done < "$GATE_RUN/markers"
  TMPDIR=$GATE_SHARED_TMPDIR node "$sweep" stop "${args[@]}" --quit-secs "${GATE_APP_QUIT_SECS:-15}"
}

if [ -z "${GATE_LOCKED:-}" ]; then
  mkdir -p "$out" || exit 12
  GATE_RUN=$(mktemp -d "$out/.run.XXXXXX") || exit 12
  export GATE_RUN
  finish() {
    local status=$1
    trap '' INT TERM HUP
    if ! sweep_markers || [ -e "$GATE_RUN/cleanup-failed" ]; then
      echo "gate: app instances it launched are still running; kept $GATE_RUN"
      exit 71
    fi
    rm -rf "$GATE_RUN"
    exit "$status"
  }
  stop_chain() {
    trap '' INT TERM HUP
    local worker
    worker=$(cat "$GATE_RUN/worker.pid" 2>/dev/null)
    if [ -n "$worker" ] && [ "$(ps -o pgid= -p "$worker" 2>/dev/null | tr -d ' ')" = "$chain" ]; then
      kill -TERM "$worker" 2>/dev/null
      wait_groups "${GATE_CHAIN_TERM_SECS:-150}" "$chain"
    fi
    group_alive "$chain" && stop_groups "TERM:10 KILL:5" "$chain"
    wait "$chain" 2>/dev/null
    finish "$1"
  }
  defer_signals
  "${own_group[@]}" "$root/scripts/agent/locked" perflab --wait "${GATE_LOCK_WAIT:-3600}" -- \
    env GATE_LOCKED=1 "$self" "$version" "$previous" --out "$out" --port "$port" --control-bundle "$control_bundle" &
  chain=$!
  await_group "$chain" || finish "${pending:-12}"
  trap 'stop_chain 130' INT
  trap 'stop_chain 143' TERM
  trap 'stop_chain 129' HUP
  [ -z "$pending" ] || stop_chain "$pending"
  wait "$chain"
  status=$?
  trap '' INT TERM HUP
  group_alive "$chain" && ! wait_groups 10 "$chain" && stop_groups "TERM:10 KILL:5" "$chain"
  finish "$status"
fi

own_run=""
if [ -z "${GATE_RUN:-}" ]; then
  mkdir -p "$out" || exit 12
  GATE_RUN=$(mktemp -d "$out/.run.XXXXXX") || exit 12
  export GATE_RUN
  own_run=1
fi
GATE_TMP=$(mktemp -d "${GATE_TMP_ROOT:-/tmp}/ac-gate.XXXXXX") || exit 12
out_abs=$(cd "$out" 2>/dev/null && pwd -P) || { mkdir -p "$out" && out_abs=$(cd "$out" && pwd -P); } || exit 12
printf '%s\n' "$GATE_TMP" "$out_abs/prep/rc" "$out_abs/prep/$previous" > "$GATE_RUN/markers"
export TMPDIR=$GATE_TMP AC_SCRATCH_TMP=$GATE_TMP
groups=()
stop_jobs() {
  trap '' INT TERM HUP
  if [ ${#groups[@]} -gt 0 ]; then
    stop_groups "INT:${GATE_JOB_INT_SECS:-45} TERM:${GATE_JOB_TERM_SECS:-15} KILL:5" "${groups[@]}"
    for g in "${groups[@]}"; do wait "$g" 2>/dev/null; done
  fi
  groups=()
  if ! sweep_markers; then
    touch "$GATE_RUN/cleanup-failed"
    echo "gate: app instances it launched are still running (see above); kept $GATE_RUN"
    exit 71
  fi
  [ -z "$own_run" ] || rm -rf "$GATE_RUN"
}
start_job() {
  local log=$1
  shift
  "${own_group[@]}" "$@" > "$log" 2>&1 &
  job=$!
  groups+=("$job")
  await_group "$job" || job=""
}
take_signals() {
  trap 'exit 130' INT
  trap 'exit 143' TERM
  trap 'exit 129' HUP
  [ -z "$pending" ] || exit "$pending"
}
trap stop_jobs EXIT
take_signals
echo $$ > "$GATE_RUN/worker.pid"

awake=()
command -v caffeinate >/dev/null && awake=(caffeinate -d -i)
candidate=$root/dist/$version-rc/export/Ardia.app control=$root/dist/$previous/export/Ardia.app

defer_signals
start_job "$out/smoke.log" timeout "${GATE_PREP_TIMEOUT:-3600}" "$smoke" "$version" "$previous" --rc
smoke_pid=$job
start_job "$out/ratchet.log" timeout "${GATE_PREP_TIMEOUT:-3600}" node "$perf/ratchet.mjs" run --own --app "$candidate"
ratchet_pid=$job
start_job "$out/prep.log" timeout "${GATE_PREP_TIMEOUT:-3600}" node "$perf/native-bench.mjs" --out "$out/prep" --port "$port" --only prepare \
  --app "$candidate" --label rc --control "$control" --control-label "$previous" --control-bundle "$control_bundle"
prep_pid=$job
take_signals
[ -n "$smoke_pid" ] && [ -n "$ratchet_pid" ] && [ -n "$prep_pid" ] || { echo "gate: a prep job couldn't start"; exit 12; }
wait "$smoke_pid"; smoke_status=$?
wait "$ratchet_pid"; ratchet_status=$?
wait "$prep_pid"; prep_status=$?
groups=()
echo "gate: smoke $smoke_status, ratchet $ratchet_status, prepare $prep_status"
[ "$smoke_status" = 0 ] || { echo "gate: the smoke test failed (status $smoke_status, $out/smoke.log)"; exit 10; }
[ "$ratchet_status" = 0 ] || { echo "gate: the ratchet failed (status $ratchet_status, $out/ratchet.log)"; exit 11; }
[ "$prep_status" = 0 ] || { echo "gate: the prepare failed (status $prep_status, $out/prep.log)"; exit 12; }

rounds=()
for r in 1 2; do
  dir=$(mktemp -d "$out_abs/round$r.XXXXXX") || exit $((12 + r))
  echo "$dir" >> "$GATE_RUN/markers"
  defer_signals
  start_job "$dir.log" timeout "${GATE_ROUND_TIMEOUT:-3600}" ${awake[@]+"${awake[@]}"} node "$perf/native-bench.mjs" --out "$dir" --port "$port" --prepared \
    --app "$out/prep/rc/app/Ardia.app" --label rc --control "$out/prep/$previous/app/Ardia.app" --control-label "$previous" \
    --only launch,session,windows --launch-runs 6 --runs 2
  round_pid=$job
  take_signals
  [ -n "$round_pid" ] || { echo "gate: round $r couldn't start"; exit $((12 + r)); }
  wait "$round_pid"; status=$?
  groups=()
  echo "gate: round $r exited $status ($dir)"
  [ "$status" = 0 ] || { echo "gate: round $r failed (status $status, $dir.log)"; exit $((12 + r)); }
  rounds+=("$dir")
done

node "$perf/gate-verdict.mjs" --control "$previous" --candidate rc "${rounds[@]}"
verdict=$?
case $verdict in
  0)
    kept=$root/dist/$version/bench/main.jsbundle
    mkdir -p "$(dirname "$kept")" && cp "$out/prep/rc/bundle/main.jsbundle" "$kept" || { echo "gate: passed, but couldn't keep the bench bundle as $kept"; exit 70; }
    echo "gate: kept the bench bundle as $kept (the next gate's control bundle)"
    exit 0 ;;
  1 | 2) exit "$verdict" ;;
  *) echo "gate: the verdict couldn't run (status $verdict)"; exit 15 ;;
esac
