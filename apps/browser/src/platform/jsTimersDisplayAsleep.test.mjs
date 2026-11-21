import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const patch = readFileSync(new URL("../../../../patches/react-native-macos@0.81.9.patch", import.meta.url), "utf8");

function fileSection(path) {
  const start = patch.indexOf(`diff --git a/${path} b/${path}`);
  if (start === -1) return null;
  const next = patch.indexOf("\ndiff --git ", start + 1);
  return patch.slice(start, next === -1 ? patch.length : next);
}

function methodBody(added, signature) {
  const start = added.indexOf(`${signature}\n{`);
  assert.notEqual(start, -1, `the patch no longer has ${signature}`);
  const end = added.indexOf("\n}\n", start);
  return added.slice(start, end === -1 ? added.length : end);
}

const newSide = (section) =>
  section
    .split("\n")
    .filter((line) => (line.startsWith("+") && !line.startsWith("+++")) || line.startsWith(" "))
    .map((line) => line.slice(1))
    .join("\n");

const addedLines = (section) =>
  section
    .split("\n")
    .filter((line) => line.startsWith("+") && !line.startsWith("+++"))
    .map((line) => line.slice(1))
    .join("\n");

test("JS timers keep a clock while the display sleeps: React Native's frame tick is not a bare NSScreen CADisplayLink", () => {
  const section = fileSection("React/Base/macOS/RCTPlatformDisplayLink.m");
  if (section === null) return;
  const added = addedLines(section);
  if (!/displayLinkWithTarget:/.test(added)) return;
  const file = newSide(section);
  assert.match(file, /- \(void\)stallWith:\(NSTimer \*\)timer/, "a screen's CADisplayLink stops while its display sleeps, and with no fallback RCTTiming fires no setTimeout, setInterval or requestAnimationFrame until it wakes");
  const stall = methodBody(file, "- (void)stallWith:(NSTimer *)timer");
  assert.match(stall, /_duration = RCTStallFallbackInterval;\s*\[self tick\];/, "the fallback has to deliver a tick in the link's place");
  assert.match(methodBody(file, "- (void)tickWith:(CADisplayLink *)link"), /_stallTimer\.fireDate = \[NSDate dateWithTimeIntervalSinceNow:\[self stallWait\]\]/, "each real frame pushes the fallback out, so it only fires once frames stop");
  assert.match(methodBody(file, "- (void)tickWith:(CADisplayLink *)link"), /if \(timestamp <= _lastLinkTimestamp\) \{\s*return;\s*\}\s*_lastLinkTimestamp = timestamp;[\s\S]*if \(timestamp <= _timestamp\) \{\s*return;/, "a late display frame after a fallback tick must not move frame time backwards: the frame animation driver indexes its frames by it");
});

test("the fallback tick is scheduled only while React Native runs the link, so nothing ticks at rest", () => {
  const section = fileSection("React/Base/macOS/RCTPlatformDisplayLink.m");
  if (section === null || !/displayLinkWithTarget:/.test(addedLines(section))) return;
  const file = newSide(section);
  const sync = methodBody(file, "- (void)syncStallTimer");
  assert.match(sync, /BOOL running = runLoop != nil && !_paused;/);
  assert.match(sync, /if \(!running\) \{\s*\[_stallTimer invalidate\];/, "pausing or invalidating the link has to stop the fallback timer");
  assert.match(methodBody(file, "- (void)setPaused:(BOOL)paused"), /\[self syncStallTimerOn:runLoop modes:modes\];/);
  assert.match(methodBody(file, "- (void)invalidate"), /\[self syncStallTimerOn:runLoop modes:modes\];/);
  assert.match(file, /if \(owner == nil\) \{\s*\[timer invalidate\];/, "a timer that outlives its display link has to stop itself");
});

test("RCTTiming still sleeps far-off timers on a run-loop NSTimer instead of waiting on frames", () => {
  const section = fileSection("React/CoreModules/RCTTiming.mm");
  assert.notEqual(section, null, "the patch no longer carries RCTTiming's changes");
  const added = addedLines(section);
  assert.match(added, /kMinimumSleepInterval = 2 \* kFrameDuration/);
  assert.match(added, /- \(void\)sleepOrStartTimers/);
});
