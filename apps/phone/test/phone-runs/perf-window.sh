#!/bin/bash
f=$1; s=$(grep -m1 -E '^[0-9]{4}-' $f); e=$(grep -E '^[0-9]{4}-' $f | tail -1)
ps=$(date -u -d "${s} +5 hours 30 minutes" +%T 2>/dev/null || date -u -d "$(echo $s|sed 's/T/ /;s/Z//') 5 hours 30 minutes" +%T)
pe=$(date -u -d "$(echo $e|sed 's/T/ /;s/Z//') 5 hours 30 minutes" +%T); ps=$(date -u -d "$(echo $s|sed 's/T/ /;s/Z//') 5 hours 30 minutes" +%T)
echo "# $f window phone $ps..$pe"
grep -a 'PAGELAB perf' /tmp/ardia-sync12-m3/out/session.log | awk -v a=$ps -v b=$pe '$2>=a && $2<=b' | cut -c19- | sed 's/^ *[0-9]* *[0-9]* I PAGELAB : //'
