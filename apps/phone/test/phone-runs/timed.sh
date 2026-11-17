#!/system/bin/sh
P=com.ardia.browser.android; T=/data/local/tmp/ardia-sync12; O=$T/touch.out; : > $O
CLASSPATH=$T/ardia-touch.jar app_process /system/bin agentd.ArdiaTouch $1 > $O 2>&1 &
J=$!
n=0; until grep -q ready $O 2>/dev/null; do sleep 0.05; n=$((n+1)); [ $n -gt 200 ] && { cat $O; exit 1; }; done
[ "$3" = 1 ] && dumpsys gfxinfo $P reset >/dev/null
date -u +%FT%TZ
sleep $2
[ "$3" = 1 ] && dumpsys gfxinfo $P
date -u +%FT%TZ
wait $J; cat $O
