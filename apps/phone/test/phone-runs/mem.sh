#!/bin/bash
S=g6vcdmxgydjbrga6; P=com.ardia.browser.android; O=/tmp/ardia-sync12-m3/out; L=$O/memory.txt
n0=$(grep -ac 'PAGELAB memory' $O/session.log)
adb -s $S shell am broadcast -a com.ardia.phone.MEMORY -p $P >/dev/null; sleep 3
echo "== $1 ($(date -u +%T) UTC, animator $(adb -s $S shell settings get global animator_duration_scale|tr -d '\r'))" >> $L
grep -a 'PAGELAB memory' $O/session.log | tail -n +$((n0+1)) | cut -c19- >> $L
adb -s $S shell dumpsys meminfo $P | grep -E 'TOTAL PSS|Graphics:|GL mtrack|Native Heap:|Java Heap:' | sed 's/^ */   meminfo: /' >> $L
tail -n 7 $L | cut -c1-400
