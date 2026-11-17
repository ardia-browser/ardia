#!/bin/bash
S=g6vcdmxgydjbrga6
for u in https://example.com/ https://github.com/ https://www.bbc.com/news https://www.mozilla.org/ https://www.python.org/ https://archlinux.org/ https://www.kernel.org/ https://www.gnu.org/ https://en.wikipedia.org/wiki/Red_panda; do adb -s $S shell am start -a android.intent.action.VIEW -d "$u" -n com.ardia.browser.android/.MainActivity >/dev/null 2>&1; sleep ${1:-7}; done
