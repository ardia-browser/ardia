#!/bin/bash
S=g6vcdmxgydjbrga6; prev=""
while true; do v=$(adb -s $S shell settings get global animator_duration_scale 2>/dev/null | tr -d '\r'); if [ "$v" != "$prev" ]; then echo "$(date -u +%T) $v"; prev=$v; fi; sleep 1; done
