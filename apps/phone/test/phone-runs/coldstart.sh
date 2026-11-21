#!/bin/bash
S=g6vcdmxgydjbrga6; O=/tmp/ardia-sync12-m3/out
adb -s $S shell am force-stop com.ardia.browser.android; sleep 1
adb -s $S shell am start -W -a android.intent.action.MAIN -c android.intent.category.LAUNCHER -n com.ardia.browser.android/.MainActivity | grep -E 'TotalTime'
sleep 3; adb -s $S exec-out screencap -p > $O/coldstart-item6-$1.png
adb -s $S shell uiautomator dump /sdcard/ardia-ui.xml >/dev/null 2>&1; adb -s $S shell cat /sdcard/ardia-ui.xml | grep -o 'content-desc="Close Search"\|content-desc="Tabs, [0-9]* tabs"' | head -2; adb -s $S shell rm -f /sdcard/ardia-ui.xml
