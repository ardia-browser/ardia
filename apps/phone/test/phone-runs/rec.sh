#!/bin/bash
# rec.sh <outdir> <name> <seconds> <phone shell command>
# Records the screen with screenrecord (40 Mb/s) while <phone shell command> runs on the phone, starting 1 s into the
# recording, and keeps <outdir>/<name>.mp4, <name>.cmd.txt (the command's output, with the phone's wall clock) and the
# session log's line range for opentimes.py. Needs S (the phone's serial), T (a folder on the phone) and LOG (the file a
# running `adb logcat -b all` writes). Fails when the recording lacks screenrecord's per-frame time stamps, since every
# timing is taken from those stamps and never from when screenrecord was started.
set -uo pipefail
if [ $# -lt 4 ] || [ "$1" = "--help" ] || [ "$1" = "-h" ]; then
  sed -n '2,7p' "$0" | sed 's/^# \{0,1\}//'
  [ $# -ge 1 ] && exit 0 || exit 64
fi
out="$1"; name="$2"; seconds="$3"; command="$4"
: "${S:?set S to the phone serial}" "${T:?set T to a folder on the phone}" "${LOG:?set LOG to the session log}"
mkdir -p "$out"
scale=$(adb -s "$S" shell settings get global animator_duration_scale | tr -d '\r')
[ "$scale" = "1.0" ] || [ "$scale" = "1" ] || { echo "animator scale $scale, not 1: not recording" >&2; exit 1; }
first=$(wc -l < "$LOG")
adb -s "$S" shell "screenrecord --bit-rate 40000000 --time-limit $seconds $T/$name.mp4" &
recorder=$!
sleep 1
{ echo "animator_duration_scale=$scale start $(date -u +%T.%N)"; adb -s "$S" shell "$command"; } > "$out/$name.cmd.txt" 2>&1
wait "$recorder"
adb -s "$S" pull "$T/$name.mp4" "$out/" >/dev/null && adb -s "$S" shell rm "$T/$name.mp4"
sleep 1
echo "loglines $first $(wc -l < "$LOG")" >> "$out/$name.cmd.txt"
if python3 -I "$(dirname "$0")/vtool.py" --check "$out/$name.mp4"; then
  echo "frame stamps ok" >> "$out/$name.cmd.txt"
else
  echo "NO FRAME STAMPS in $name.mp4: its timings can't be taken" | tee -a "$out/$name.cmd.txt" >&2
  exit 1
fi
