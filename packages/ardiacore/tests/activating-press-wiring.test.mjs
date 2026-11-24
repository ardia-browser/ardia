import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");
const dragRegion = read("../../shell/ios/WindowDragRegion.swift");
const revealInput = read("../ios/ArdiaWebView+RevealInput.mm");

const between = (text, start, end) => {
  const from = text.indexOf(start);
  assert.ok(from >= 0, `missing ${start}`);
  const to = text.indexOf(end, from + start.length);
  return text.slice(from, to < 0 ? undefined : to);
};

test("a drag region hands the press that brings Ardia forward to AppKit instead of swallowing it", () => {
  const monitor = between(dragRegion, "monitor = NSEvent.addLocalMonitorForEvents", "deinit");
  const down = monitor.slice(monitor.indexOf("self.doubleClickDown = nil\n      self.pressAwaitingActivation"));
  const handOver = down.indexOf("if !NSApp.isActive, !leavesWindowBehind { return place == .region ? self.pressAfterAppKitActivates(event, place) : event }");
  assert.ok(handOver > 0, "an inactive press goes to pressAfterAppKitActivates");
  assert.ok(handOver < down.indexOf("return nil"), "before any path that swallows the press");
});

test("the handed-over press still drags or clicks once AppKit has dispatched it, and only once", () => {
  const after = between(dragRegion, "private func pressAfterAppKitActivates", "override func mouseDown");
  assert.match(after, /-> NSEvent \{/);
  assert.doesNotMatch(after, /return nil/);
  assert.match(after, /return event\n/);
  assert.match(after, /Self\.activatingPresses \+= 1/);
  assert.match(after, /DispatchQueue\.main\.async/);
  assert.match(after, /self\.pressAwaitingActivation === event/);
  assert.match(after, /self\.press\(event, place, releaseFollows: false\)/);
  const mouseDown = between(dragRegion, "override func mouseDown", "private enum PressPlace");
  assert.match(mouseDown, /pressAwaitingActivation = nil/, "AppKit giving the view the press itself cancels the deferred one");
});

test("a press never orders a window front while Ardia is inactive", () => {
  const press = between(dragRegion, "private func press(", "private func clickOrDrag");
  assert.doesNotMatch(press, /NSApp\.activate/);
  assert.match(press, /if NSApp\.isActive, key == nil, window\.canBecomeKey, !leavesWindowBehind \{ window\.makeKeyAndOrderFront\(nil\) \}/);
});

test("the tab-switch reveal never swallows a button press that activates the app", () => {
  const swallows = between(revealInput, "+ (BOOL)swallowsAheadOfSwitch:", "- (void)noteOnScreenAhead");
  assert.match(swallows, /const BOOL activatesApp = \(type & kButtonDowns\) && !NSApp\.isActive;/);
  assert.match(swallows, /const BOOL overCoveredPage = lands && !activatesApp && gOnScreenAhead/);
});
