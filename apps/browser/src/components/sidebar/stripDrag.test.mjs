import assert from "node:assert/strict";
import { test } from "node:test";
const { stripDragHandoff } = await import("./stripDrag.ts");
const { handoffPoint, ICON_STRIP, stripInset, stripPointerOver, stripRail } = await import("./iconStripGeometry.ts");
const { edgeWatchWidth, PEEK_EDGE_STRIP, TAB_DRAG_EDGE_STRIP } = await import("../window/dockMotion.ts");

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

function fakeController(frame = { x: 9, y: 120, w: 172, h: 33 }) {
  const calls = [];
  const view = { measureInWindow: (cb) => cb(frame.x, frame.y, frame.w, frame.h) };
  return {
    calls,
    items: new Map([["t:a", { view }]]),
    begin: async (key, x, y) => void calls.push(["begin", key, x, y]),
    move: (x, y) => calls.push(["move", x, y]),
    end: (commit) => calls.push(["end", commit]),
    interrupt: () => calls.push(["interrupt"]),
  };
}

test("a drag from a strip icon floats the sidebar out, then begins on that row in it and jumps to the pointer", async () => {
  const controller = fakeController();
  let reveals = 0;
  const drag = stripDragHandoff("w", "t:a", () => reveals++, 5, () => controller);
  drag.begin(20, 80);
  drag.move(24, 90);
  assert.equal(reveals, 1);
  assert.deepEqual(controller.calls, [], "nothing moves until the floating sidebar has settled");
  await tick(20);
  drag.move(30, 140);
  drag.end(true);
  assert.deepEqual(controller.calls, [["begin", "t:a", 9 + ICON_STRIP.square / 2 + stripInset, 120 + 33 / 2], ["move", 24, 90], ["move", 30, 140], ["end", true]]);
});

test("a drag let go before the sidebar settles hands nothing over, and one whose row isn't there drops quietly", async () => {
  const controller = fakeController();
  const early = stripDragHandoff("w", "t:a", () => {}, 5, () => controller);
  early.begin(20, 80);
  early.end(true);
  await tick(20);
  assert.deepEqual(controller.calls, []);
  const missing = stripDragHandoff("w", "t:gone", () => {}, 5, () => controller);
  missing.begin(20, 80);
  await tick(20);
  missing.move(40, 40);
  missing.end(false);
  assert.deepEqual(controller.calls, []);
  const none = stripDragHandoff("w", "t:a", () => {}, 5, () => null);
  none.begin(1, 1);
  await tick(20);
  none.end(true);
});

test("the hand-off point sits on the row's icon, or the pointer when the row can't be measured", () => {
  assert.deepEqual(handoffPoint(null, { x: 3, y: 4 }), { x: 3, y: 4 });
  assert.deepEqual(handoffPoint({ x: 0, y: 0, w: 20, h: 20 }, { x: 3, y: 4 }), { x: 10, y: 10 });
  const row = { x: 801, y: 120, w: 190, h: 33 };
  assert.equal(handoffPoint(row, { x: 977, y: 130 }).x, 801 + ICON_STRIP.square / 2 + stripInset, "a left strip grabs near the row's left end");
  assert.equal(handoffPoint(row, { x: 977, y: 130 }, true).x, 801 + 190 - ICON_STRIP.square / 2 - stripInset, "a right strip grabs near its right end, under the pointer");
});

test("the strip's first and last squares line up with the page card's top and bottom edges, on whole points", () => {
  assert.deepEqual(stripRail(9, 9), { top: 9, bottom: 9 });
  assert.deepEqual(stripRail(37.5, 6), { top: 38, bottom: 6 });
  assert.equal((ICON_STRIP.width - ICON_STRIP.square) / 2, stripInset);
  assert.equal(stripPointerOver(45, false, 800), true);
  assert.equal(stripPointerOver(46, false, 800), false);
  assert.equal(stripPointerOver(760, true, 800), true);
});

test("with icons docked, the edge watch reveals nothing at rest, a tab drag over any of the strip opens it, and a peek holds as before", () => {
  assert.equal(edgeWatchWidth(false, false, 260, 0), PEEK_EDGE_STRIP, "hidden on a borderless frame watches the edge");
  assert.equal(edgeWatchWidth(false, false, 260, 0, ICON_STRIP.width, true), 0, "icons cover the edge themselves");
  assert.equal(edgeWatchWidth(false, true, 260, 9), TAB_DRAG_EDGE_STRIP);
  assert.equal(edgeWatchWidth(false, true, 260, 9, ICON_STRIP.width, true), ICON_STRIP.width);
  assert.equal(edgeWatchWidth(true, true, 260, 9, ICON_STRIP.width, true), 260);
});

const { emitAppEvent } = await import("../../test-native/shell.ts");

function slowController(key = "t:a", frame = { x: 9, y: 120, w: 172, h: 33 }) {
  const calls = [];
  let release;
  const measured = new Promise((r) => (release = r));
  const view = { measureInWindow: (cb) => void measured.then(() => cb(frame.x, frame.y, frame.w, frame.h)) };
  return {
    calls,
    release: () => release(),
    items: new Map([[key, { kind: "row", view }]]),
    begin: async (k, x, y, consent) => void calls.push(["begin", k, x, y, consent]),
    move: (x, y) => calls.push(["move", x, y]),
    end: (commit) => calls.push(["end", commit]),
    interrupt: () => calls.push(["interrupt"]),
  };
}

test("Escape while the sidebar is still floating out cancels the hand-off, so no drag ever starts", async () => {
  const controller = fakeController();
  const drag = stripDragHandoff("w", "t:a", () => {}, 5, () => controller);
  drag.begin(20, 80);
  emitAppEvent({ type: "dragEscape" });
  await tick(20);
  drag.end(true);
  assert.deepEqual(controller.calls, []);
});

test("a measurement that lands after the sidebar was torn down starts nothing on the controller it measured", async () => {
  const controller = slowController();
  let current = controller;
  const drag = stripDragHandoff("w", "t:a", () => {}, 1, () => current);
  drag.begin(20, 80);
  await tick(10);
  current = null;
  controller.release();
  await tick(10);
  drag.end(true);
  assert.deepEqual(controller.calls, []);
});

test("a measurement that lands after cancel starts nothing, and mouse-up after a hand-off reaches the controller that began it", async () => {
  const late = slowController();
  const cancelled = stripDragHandoff("w", "t:a", () => {}, 1, () => late);
  cancelled.begin(20, 80);
  await tick(10);
  cancelled.cancel();
  late.release();
  await tick(10);
  assert.deepEqual(late.calls, []);
  const first = fakeController();
  let current = first;
  const handed = stripDragHandoff("w", "t:a", () => {}, 1, () => current);
  handed.begin(20, 80);
  await tick(20);
  current = fakeController();
  handed.end(true);
  assert.deepEqual(first.calls.map((c) => c[0]), ["begin", "move", "end"]);
  assert.deepEqual(current.calls, []);
});

test("the hand-off carries the consent period of the press, not the one current when the pointer crossed the drag threshold or the sidebar settled", async () => {
  const { setConsentPeriod } = await import("../../state/telemetry/consentPeriod.ts");
  setConsentPeriod(false, null);
  const controller = slowController();
  controller.release();
  const reveals = [];
  const drag = stripDragHandoff("w", "t:a", (consent) => reveals.push(consent), 5, () => controller);
  drag.press();
  setConsentPeriod(true, "later-opt-in");
  drag.begin(20, 80);
  await tick(20);
  drag.end(true);
  setConsentPeriod(false, null);
  assert.equal(controller.calls[0][0], "begin");
  assert.equal(controller.calls[0][4], null, "the press began with sharing off");
  assert.deepEqual(reveals, [null], "the reveal it counts as a peek carries the same press token");
});

test("a group grabbed from the strip is held by its header row, not the middle of its open members", async () => {
  const header = { measureInWindow: (cb) => cb(9, 300, 172, 33) };
  const box = { measureInWindow: (cb) => cb(9, 300, 172, 300) };
  const calls = [];
  const controller = { items: new Map([["g:r", { kind: "group", view: box, header }]]), begin: async (...a) => void calls.push(a), move: () => {}, end: () => {}, interrupt: () => {} };
  const drag = stripDragHandoff("w", "g:r", () => {}, 1, () => controller);
  drag.begin(20, 310);
  await tick(20);
  drag.end(true);
  assert.equal(calls[0][2], 300 + 33 / 2);
});

test("a drag begun later with the token of a press from another consent period is never counted, and one from this period is", async () => {
  const { setConsentPeriod } = await import("../../state/telemetry/consentPeriod.ts");
  const presses = await import("../../state/telemetry/tabPresses.ts");
  setConsentPeriod(true, "opted-in");
  const count = () => presses.devTabPresses().drags_without_drop;
  const before = count();
  const pressedWhileOff = {};
  presses.noteDragBegan(pressedWhileOff, null);
  presses.noteDragWithoutDrop(pressedWhileOff);
  assert.equal(count(), before, "pressed with sharing off, begun after the opt-in");
  const fresh = {};
  presses.noteDragBegan(fresh, "opted-in");
  presses.noteDragWithoutDrop(fresh);
  assert.equal(count(), before + 1, "pressed and begun in this period");
  setConsentPeriod(false, null);
});

const { shellNativeModules } = await import("../../test-native/shell.ts");
const RN = await import("react-native");

function escapeCapture() {
  const calls = [];
  const focus = shellNativeModules.ArdiaFocus;
  const real = focus.setDragEscapeCapture;
  focus.setDragEscapeCapture = (on) => (calls.push(on), Promise.resolve());
  return { on: () => calls.at(-1) === true, restore: () => void (focus.setDragEscapeCapture = real) };
}

test("a first drag's late measurement never starts a second drag of the same icon before its own settle", async () => {
  const controller = slowController();
  const drag = stripDragHandoff("w", "t:a", () => {}, 30, () => controller);
  drag.begin(20, 80);
  await tick(40);
  drag.end(true);
  drag.begin(20, 90);
  controller.release();
  await tick(5);
  assert.deepEqual(controller.calls, [], "the second drag waits for its own settle");
  await tick(60);
  assert.equal(controller.calls[0]?.[0], "begin");
  drag.end(true);
});

test("cancelling one icon's pending hand-off keeps Escape captured for another icon's pending one", async () => {
  const capture = escapeCapture();
  try {
    const controller = fakeController();
    const a = stripDragHandoff("w", "t:a", () => {}, 50, () => controller);
    const b = stripDragHandoff("w", "t:b", () => {}, 50, () => controller);
    a.begin(20, 80);
    b.begin(20, 120);
    a.cancel();
    assert.equal(capture.on(), true, "b still needs Escape");
    b.cancel();
    assert.equal(capture.on(), false);
  } finally {
    capture.restore();
  }
});

test("the app resigning active cancels a pending hand-off", async () => {
  const listeners = [];
  const real = RN.AppState.addEventListener;
  RN.AppState.addEventListener = (_type, listener) => (listeners.push(listener), { remove: () => listeners.splice(listeners.indexOf(listener), 1) });
  try {
    const controller = fakeController();
    const drag = stripDragHandoff("w", "t:a", () => {}, 10, () => controller);
    drag.begin(20, 80);
    listeners.forEach((l) => l("inactive"));
    await tick(30);
    drag.end(true);
    assert.deepEqual(controller.calls, []);
    assert.equal(listeners.length, 0, "the listener goes with the hand-off");
  } finally {
    RN.AppState.addEventListener = real;
  }
});

