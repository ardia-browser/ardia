import assert from "node:assert/strict";
import { test } from "node:test";
import { animations } from "react-native";
const { clampWidth, grabbedWidth, resizeGesture, rubberBand, snapsAt, unstretch } = await import("./resizeDrag.ts");

const bounds = { min: 160, max: 400 };

function sidebarDrag(saved = 190) {
  const shown = [];
  const commits = [];
  const gesture = resizeGesture({
    current: {
      ...bounds,
      direction: 1,
      saved: () => saved,
      pointerFromEdge: (e) => e.fromEdge,
      onLive: (width) => shown.push(width),
      onCommit: (width, dragged) => commits.push({ width, dragged }),
    },
  });
  return {
    shown,
    commits,
    press: (fromEdge) => gesture.onPanResponderGrant({ fromEdge }),
    move: (dx) => gesture.onPanResponderMove({}, { dx }),
    release: (dx) => gesture.onPanResponderRelease({}, { dx }),
  };
}

test("a grab off the edge starts the drag from where the pointer is, so the edge follows it", () => {
  assert.equal(grabbedWidth(190, 1, -2), 188);
  assert.equal(grabbedWidth(190, 1, 3), 193);
  assert.equal(grabbedWidth(190, -1, 3), 187);
  assert.equal(grabbedWidth(190, -1, -2), 192);
});

test("a left sidebar grabbed 2 pt inside its edge and dragged 72 pt right ends with its edge under the pointer", () => {
  const pointer = 188 + 72;
  const start = unstretch(grabbedWidth(190, 1, -2), bounds);
  assert.equal(rubberBand(start + 72, bounds), pointer);
});

test("grabbed again 2 pt inside the edge while it springs back from past max, the edge jumps to the pointer", () => {
  const drag = sidebarDrag();
  animations.held = true;
  try {
    drag.press(0);
    drag.move(300);
    drag.release(300);
    const springing = drag.shown.at(-1);
    assert.ok(springing > 400);
    drag.press(-2);
    assert.ok(Math.abs(drag.shown.at(-1) - (springing - 2)) < 1e-9);
  } finally {
    animations.held = false;
    animations.running = [];
  }
});

test("a press and release with no movement keeps the saved width and commits as a click, not a drag", () => {
  const drag = sidebarDrag();
  drag.press(-2);
  drag.release(0);
  drag.press(-2);
  drag.release(0);
  drag.press(-2);
  drag.move(30);
  drag.move(0);
  drag.release(0);
  drag.press(0);
  drag.move(40);
  drag.release(40);
  assert.deepEqual(drag.commits, [
    { width: 190, dragged: false },
    { width: 190, dragged: false },
    { width: 188, dragged: true },
    { width: 230, dragged: true },
  ]);
});

test("a press off the edge leaves the edge where it is until the pointer moves, then puts it under the pointer", () => {
  const drag = sidebarDrag();
  drag.press(-2);
  assert.equal(drag.shown.at(-1), 190);
  drag.move(1);
  assert.equal(drag.shown.at(-1), 189);
});

test("past min and max the width stretches and settles back inside", () => {
  assert.ok(rubberBand(450, bounds) > 400 && rubberBand(450, bounds) < 450);
  assert.ok(rubberBand(100, bounds) < 160 && rubberBand(100, bounds) > 100);
  assert.ok(Math.abs(unstretch(rubberBand(450, bounds), bounds) - 450) < 1e-6);
  assert.equal(clampWidth(450, bounds), 400);
  assert.equal(clampWidth(100, bounds), 160);
});

function snappingDrag(snap, saved = 190) {
  const commits = [];
  const live = [];
  let snapped = 0;
  const gesture = resizeGesture({
    current: { ...bounds, direction: 1, saved: () => saved, onLive: (w) => live.push(w), onCommit: (width) => commits.push(width), snap: { ...snap, onSnap: () => snapped++ } },
  });
  return { commits, live, snapped: () => snapped, drag: (dx) => (gesture.onPanResponderGrant({}), gesture.onPanResponderMove({}, { dx }), gesture.onPanResponderRelease({}, { dx })) };
}

test("dragging the docked sidebar's edge well past its minimum snaps to icons and keeps the saved width", () => {
  const short = snappingDrag({ below: 120 });
  short.drag(-50);
  assert.equal(short.snapped(), 0, "30 pt past the minimum springs back");
  const far = snappingDrag({ below: 120 });
  far.drag(-80);
  assert.equal(far.snapped(), 1);
  assert.deepEqual(far.commits, [], "the saved width is left alone");
  assert.equal(far.live.at(-1), null, "the live width is let go");
});

test("dragging the icons' edge outward past the snap returns to the full sidebar, and a click does nothing", () => {
  const strip = { min: 46, max: 46 };
  let snapped = 0;
  const gesture = resizeGesture({ current: { ...strip, direction: -1, saved: () => 46, onLive: () => {}, onCommit: () => {}, snap: { above: 86, onSnap: () => snapped++ } } });
  gesture.onPanResponderGrant({});
  gesture.onPanResponderRelease({}, { dx: 0 });
  assert.equal(snapped, 0);
  gesture.onPanResponderGrant({});
  gesture.onPanResponderMove({}, { dx: -60 });
  gesture.onPanResponderRelease({}, { dx: -60 });
  assert.equal(snapped, 1, "a right-side strip grows leftward");
  assert.equal(snapsAt(87, { above: 86, onSnap() {} }), true);
  assert.equal(snapsAt(86, { above: 86, onSnap() {} }), false);
  assert.equal(snapsAt(100, undefined), false);
});
