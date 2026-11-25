#!/bin/bash
# Films scroll and swipe smoothness (top tab strip pans, one-profile sidebar swipe, 200-tab sidebar flick) in hidden
# instances with the in-process recorder at 60 fps, then counts unique frames and stalls in each recording.
#
#   apps/videos/scripts/fixes/film-scroll-perf.sh before|after [scene ...]
#
# Scenes: scrollperf-strip scrollperf-swipe scrollperf-sidebar (default: all three).
# BEFORE_APP / AFTER_APP     the Debug or Release Ardia.app of that side (never one in /Applications)
# BEFORE_BUNDLE / AFTER_BUNDLE  a production main.jsbundle for that side (js-bench.mjs bundle <dir>); "none" keeps the app's own
# FILM_TAKES                 takes per scene (default 3); the metrics give each take and the median take
# FIXES_SCRATCH              default /tmp/ardia-perf/film; footage lands in $FIXES_SCRATCH/footage/<side>/<scene>-<kind>-t<n>.mov
# SCROLLPERF_KIND            trackpad (phases and momentum, the real gesture) or pan (the same deltas without phases). Default:
#                            trackpad, or pan while the screen is locked: AppKit holds phased scrolls then, so they film as nothing.
# SCROLLPERF_DRIVER          inproc (default): scroll.m posts the gestures inside the app, which works while the screen is
#                            locked, but a phased gesture posted that way moves no NSScrollView. acperf: real events to the app's
#                            process (acperf postscroll, SCROLLPERF_ACPERF), the only way to film trackpad scrolling; screen unlocked.
# Metrics: $FIXES_SCRATCH/metrics-<side>-<kind>.json (scroll-perf-metrics.mjs).
set -uo pipefail
REPO=$(cd "$(dirname "$0")/../../../.." && pwd)
HERE="$REPO/apps/videos/scripts/fixes"
[ "${1:-}" = before ] || [ "${1:-}" = after ] || { sed -n '2,17p' "$0" | sed 's/^# \{0,1\}//'; exit 64; }
SIDE=$1
shift
SCENES=${*:-scrollperf-strip scrollperf-swipe scrollperf-sidebar}
export FIXES_SCRATCH=${FIXES_SCRATCH:-/tmp/ardia-perf/film}
S=$FIXES_SCRATCH
mkdir -p "$S"
if [ "$SIDE" = before ]; then SRC=${BEFORE_APP:?BEFORE_APP is the before app}; BUNDLE=${BEFORE_BUNDLE:-none}; else SRC=${AFTER_APP:?AFTER_APP is the after app}; BUNDLE=${AFTER_BUNDLE:-none}; fi
COPY=$(node --input-type=module -e '
const { execFileSync } = await import("node:child_process");
const { writeFileSync } = await import("node:fs");
const { prepareApp, signingIdentity } = await import(process.argv[1]);
const [src, dir, bundle] = process.argv.slice(2);
const copy = prepareApp(src, dir, { bundle: bundle === "none" ? null : bundle, entitlements: ["com.apple.security.cs.disable-library-validation", "com.apple.security.cs.allow-dyld-environment-variables"] });
writeFileSync(`${copy}/Contents/Resources/ip.txt`, "127.0.0.1:1\n");
const granted = execFileSync("codesign", ["-d", "--entitlements", "-", "--xml", copy], { encoding: "utf8" });
writeFileSync(`${dir}/film.entitlements`, granted);
execFileSync("codesign", ["--force", "--sign", signingIdentity(src), "--timestamp=none", "--options", "runtime", "--entitlements", `${dir}/film.entitlements`, copy], { stdio: "ignore" });
process.stdout.write(copy);
' "$REPO/scripts/lib/app-copy.mjs" "$SRC" "$S/apps/$SIDE" "$BUNDLE") || exit 1
[ -f "$COPY/Contents/Resources/main.jsbundle" ] || { echo "film-scroll-perf: $COPY has no main.jsbundle; pass a bundle" >&2; exit 1; }
{ echo "app $SRC"; echo "bundle $BUNDLE"; shasum "$COPY/Contents/Resources/main.jsbundle"; date; } >"$S/apps/$SIDE.txt"
rm -f "$S/scroll.dylib" "$S/selfrec.dylib"
node "$HERE/sessions-scroll-perf.mjs" "$S"
export FIXES_SITES_PORT=${FIXES_SITES_PORT:-47641}
if ! lsof -nP -iTCP:"$FIXES_SITES_PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  node "$REPO/apps/videos/scripts/capture/sites/serve.mjs" "$FIXES_SITES_PORT" >"$S/serve.log" 2>&1 &
  SITES=$!
  trap 'kill $SITES 2>/dev/null' EXIT
fi
if [ "$SIDE" = before ]; then export BEFORE_APP=$COPY; else export AFTER_APP=$COPY AFTER_JS=none; fi
if [ -z "${SCROLLPERF_KIND:-}" ]; then
  if ioreg -n Root -d1 -a | grep -A1 CGSSessionScreenIsLocked | grep -q true; then SCROLLPERF_KIND=pan; else SCROLLPERF_KIND=trackpad; fi
fi
export SCROLLPERF_KIND
echo "film-scroll-perf: $SIDE, gestures: $SCROLLPERF_KIND" >&2
export FIXES_SELFREC=1 FIXES_SERIAL=1 FIXES_FPS=60 FIXES_PORT_BASE=${FIXES_PORT_BASE:-9641}
TAKES=${FILM_TAKES:-3}
NAMES=""
for scene in $SCENES; do
  for take in $(seq 1 "$TAKES"); do
    node "$HERE/run.mjs" "$scene" --side "$SIDE" || exit 1
    for ext in mov json; do mv "$S/footage/$SIDE/$scene.$ext" "$S/footage/$SIDE/$scene-$SCROLLPERF_KIND-t$take.$ext"; done
    NAMES="$NAMES $scene-$SCROLLPERF_KIND-t$take"
  done
done
node "$HERE/scroll-perf-metrics.mjs" "$S/footage/$SIDE" $NAMES >"$S/metrics-$SIDE-$SCROLLPERF_KIND.json" && cat "$S/metrics-$SIDE-$SCROLLPERF_KIND.json"
