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
  const screenLink = /displayLinkWithTarget:/.test(added);
  const runLoopFallback = /NSTimer|CFRunLoopTimer|dispatch_source_set_timer/.test(added);
  assert.ok(
    !screenLink || runLoopFallback,
    "RCTPlatformDisplayLink ticks from an NSScreen CADisplayLink with no run-loop fallback: that link stops while the display sleeps, and RCTTiming then fires no setTimeout, setInterval or requestAnimationFrame until it wakes",
  );
});

test("RCTTiming still sleeps far-off timers on a run-loop NSTimer instead of waiting on frames", () => {
  const section = fileSection("React/CoreModules/RCTTiming.mm");
  assert.notEqual(section, null, "the patch no longer carries RCTTiming's changes");
  const added = addedLines(section);
  assert.match(added, /kMinimumSleepInterval = 2 \* kFrameDuration/);
  assert.match(added, /- \(void\)sleepOrStartTimers/);
});
