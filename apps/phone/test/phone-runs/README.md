# Phone runs: fixed-clock input and measurement

The testers' tooling for measuring the Android app on a real phone the same way every run (sync11 to sync14 on
the POCO M3 Pro), kept here so a run does not rebuild it. Evidence from each run stays under
`/tmp/ardia-phone-shots/<build>-<phone>/`; nothing here writes there by itself.

## The touch jar

`touch-jar/` holds the source of `ardia-touch.jar` (class `agentd.ArdiaTouch`, run with `app_process`). It replays a
schedule of taps and swipes at fixed offsets through its own uhid touchscreen (`Hid.java`, agent-os be261a5a's file,
whose input Xiaomi doesn't block as injected), so every mode gets identical input however fast the app settles.
A stroke sends one report every 8 ms, a tap is held 50 ms, and the clock starts when it prints `ready`, once the
device shows up in InputManager. It refuses anything but portrait.

Build it with `touch-jar/build.sh [out.jar]` (javac `--release 11` against the SDK's `android.jar`, then `d8
--min-api 33`), push it to the run's folder on the phone, and run
`CLASSPATH=<folder>/ardia-touch.jar app_process /system/bin agentd.ArdiaTouch <schedule>` (`timed.sh` does this). It
prints `done N ms; planned->started: …` with each step's planned and actual start. The sync13 and sync14 testers
built it from this source against agent-os's stubs with agent-os's r8.jar (sync14's jar: sha256
d0b5d083ee703e0c14201341e272435f31b5a856ac94481054fae27c4c52caba). This script's jar has the same classes but a
different hash, so record the hash a run used.

## Schedules

`sched-*.txt`: one action per line, `offset_ms action args`, where action is `tap x y` or `swipe x1 y1 x2 y2 ms`.
Coordinates are for a 1080 × 2400 phone. `sched-expo13.txt` is the 37 s step-38 script for sync13 and later, whose bar puts New Tab at y 2184 (sync13 on the M3); `sched-expo.txt` is the same script for sync11 and sync12 (New Tab at y 1945);
`sched-ds-*.txt` are the "Deck speed" windows (open, pre-position, scroll, tray); `sched-tray*.txt` open and close the
tray over a page. For the layout from sync13 on (Tabs at 114,2200, New Tab at 540,2184, the focused card the right-hand
one), from the sync14 M3 run:
- `sched-scroll.txt`: the Deck speed script's step 2 from an open deck, five swipes 860 to 220 (300 ms) 1.5 s apart,
  then five back;
- `sched-deckcard.txt`: from a page, open the deck (Tabs), then the focused card, five times;
- `sched-cardopen.txt`: from the deck, open the focused card, then the deck again, five times;
- `sched-close7.txt` and `sched-close8.txt`: flick the focused card up to close it, seven or eight times, 1.5 s apart.

## Timing from a recording

`rec.sh`, `vtool.py` and `opentimes.py` time opens, flicks and launches from a screen recording the way the F4's
expo58b run did. Every frame's time is its own stamp from screenrecord's metadata track, and every touch's is the
input log's line, so nothing depends on when screenrecord was started: its first frame arrives 235 to 590 ms after
the command, different every time, and a clock started at the command makes recordings incomparable (the M3's
openana.py did that until 2026-11-16).

```
S=<serial> T=/data/local/tmp/<run> LOG=<run>/session.log \
  rec.sh <run>/out deckcard 31 "sh $T/timed.sh $T/sched-deckcard.txt 30 0"
LOG=<run>/session.log opentimes.py taps <run>/out deckcard deck card
LOG=<run>/session.log opentimes.py launch <run>/out cold
```

`LOG` is the file a running `adb logcat -b all` writes; `PHONE_UTC_OFFSET` is the phone's log time zone (default
+05:30). Touches come from MIUIInput's lines, so this works on the MIUI phones (F4, M3). `rec.sh` refuses a recording
without frame stamps.

## Scripts

Each starts with the serial (`S=`), the output folder on the Mac (`O=`) and the folder on the phone
(`/data/local/tmp/ardia-sync12`) of the run it was written for; set them for the run.

- `timed.sh <schedule> <window_s> <measure 1|0>` (on the phone): starts the jar, resets `gfxinfo` once the jar is
  ready, waits the window, dumps `gfxinfo`.
- `measure.sh run|warm|idle <name> [schedule]`: checks the animator scale is 1, then the 37 s run, an unmeasured
  warm-up, or a 30 s idle window.
- `ds.sh <name> <schedule> <window_s>`: one "Deck speed" window with the animator-scale check.
- `idle.sh <seconds>` (on the phone): `gfxinfo` over an untouched window.
- `mem.sh <label>`: the lab's Memory broadcast, appending the new `PAGELAB memory` lines and `dumpsys meminfo` to
  `memory.txt`.
- `coldstart.sh <n>`: force-stop, launch, screenshot after 3 s, report whether the tray is open.
- `open9.sh`: opens the nine pages every run uses, in order, one VIEW intent each.
- `perf-window.sh <gfx file>`: the `PAGELAB perf` lines inside that window (the phone's clock is UTC+5:30).
- `scalewatch.sh`: logs every change of the animator duration scale (MIUI's Developer options resets it).
- `sum.sh <gfx files…>`: one line per `gfxinfo` dump: frames, janky share, the 50th, 90th, 95th and 99th percentiles, the GPU median, slow UI and slow draw commands.
- `blankscan.py`: finds flat (blank) frames in a screen recording's page area above the tray.
