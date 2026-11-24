#!/bin/bash
S=g6vcdmxgydjbrga6; O=/tmp/ardia-sync12-m3/out
a=$(adb -s $S shell settings get global animator_duration_scale | tr -d '\r'); [ "$a" = "1.0" ] || { echo "ANIMATOR SCALE $a - abort"; exit 1; }
out=$O/ds-$1.txt; echo "animator_duration_scale=$a (checked $(date -u +%T)); schedule $2" > $out
adb -s $S shell "sh /data/local/tmp/ardia-sync12/timed.sh /data/local/tmp/ardia-sync12/$2 $3 1" >> $out
echo "animator_duration_scale=$a"; grep -a 'done ' $out | cut -c1-40
/tmp/ardia-sync12-m3/scripts/sum.sh $out
