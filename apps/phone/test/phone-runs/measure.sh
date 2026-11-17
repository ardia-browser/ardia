#!/bin/bash
S=g6vcdmxgydjbrga6; O=/tmp/ardia-sync12-m3/out
a=$(adb -s $S shell settings get global animator_duration_scale | tr -d '\r'); echo "animator_duration_scale=$a"; [ "$a" = "1.0" ] || { echo "ANIMATOR SCALE $a - abort"; exit 1; }
out=$O/gfx-$2.txt; echo "animator_duration_scale=$a (checked $(date -u +%T))" > $out
if [ $1 = run ]; then adb -s $S shell "sh /data/local/tmp/ardia-sync12/timed.sh /data/local/tmp/ardia-sync12/${3:-sched-expo.txt} 37 1" >> $out
elif [ $1 = warm ]; then adb -s $S shell "sh /data/local/tmp/ardia-sync12/timed.sh /data/local/tmp/ardia-sync12/${3:-sched-expo.txt} 37 0" >> $out
else adb -s $S shell "sh /data/local/tmp/ardia-sync12/idle.sh 30" >> $out; fi
grep -a 'done ' $out | cut -c1-60
grep -aE 'Total frames|^Janky frames:|50th percentile|90th percentile|95th percentile|99th percentile|50th gpu|Slow UI|Slow issue' $out | head -12 | tr '\n' ';'; echo
