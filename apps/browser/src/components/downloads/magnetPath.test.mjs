import assert from "node:assert/strict";
import { test } from "node:test";
import { magnetPath, magnetPoint, magnetTarget } from "./magnetPath.ts";
import { MAGNET } from "./tokens.ts";

const BASE = { width: 1000, height: 700, sidebarOpen: true, sidebarWidth: 200, right: false, topStrip: false, footer: true, lightsY: 20 };
const REACH = (MAGNET.icon * MAGNET.peakScale) / 2 + MAGNET.pageEdgeGap;

test("on the Mac the flight starts in the middle of the page, at the share of its height the tokens give", () => {
  const path = magnetPath(BASE, false);
  assert.deepEqual(path.start, { x: 600, y: 700 * MAGNET.startShare });
  assert.equal(path.arc, MAGNET.arc);
  assert.equal(path.fromPageEdge, false);
});

test("from the page edge with the sidebar shown, the flight starts inside the sidebar beside the page, so its whole path is over the app", () => {
  const left = magnetPath(BASE, true);
  assert.deepEqual(left.start, { x: 200 - REACH, y: 700 * MAGNET.startShare });
  assert.deepEqual(left.target, magnetTarget(BASE));
  assert.equal(left.arc, MAGNET.arc);
  const right = magnetPath({ ...BASE, right: true }, true);
  assert.deepEqual(right.start, { x: 800 + REACH, y: 700 * MAGNET.startShare });
  for (const path of [left, right]) {
    for (let step = 0; step <= 20; step++) {
      const point = magnetPoint(path, step / 20);
      const inSidebar = path === left ? point.x <= 200 : point.x >= 800;
      assert.ok(inSidebar, `step ${step} at ${point.x}`);
    }
  }
});

test("from the page edge to a button in the top band, the flight runs along that band from above the page's middle, with no arc out of the window", () => {
  const strip = magnetPath({ ...BASE, topStrip: true, footer: false }, true);
  assert.deepEqual(strip.start, { x: 500, y: MAGNET.topStripTarget.y });
  assert.equal(strip.arc, 0);
  const closed = magnetPath({ ...BASE, sidebarOpen: false, footer: false }, true);
  assert.deepEqual(closed.start, { x: 500, y: MAGNET.closedTarget.y });
  assert.deepEqual(closed.target, MAGNET.closedTarget);
  assert.equal(closed.arc, 0);
});

test("a narrow sidebar keeps the start inside it", () => {
  const path = magnetPath({ ...BASE, sidebarWidth: 40 }, true);
  assert.equal(path.start.x, 20);
});

test("the targets are the Mac's: the footer button, the sidebar's toolbar row, the top strip and the closed corner", () => {
  assert.deepEqual(magnetTarget({ ...BASE, footer: false }), { x: 200 - MAGNET.sidebarTarget.right, y: 20 });
  assert.deepEqual(magnetTarget({ ...BASE, topStrip: true }), { x: 1000 - MAGNET.topStripTarget.right, y: MAGNET.topStripTarget.y });
  assert.deepEqual(magnetTarget({ ...BASE, sidebarOpen: false, footer: false, right: true }), { x: 1000 - MAGNET.closedTarget.x, y: MAGNET.closedTarget.y });
  const footer = magnetTarget(BASE);
  assert.ok(footer.x < 200 && footer.y > 600);
});

test("the path's ends are its start and target, and its arc lifts the middle", () => {
  const path = magnetPath(BASE, true);
  assert.deepEqual(magnetPoint(path, 0), path.start);
  const end = magnetPoint(path, 1);
  assert.ok(Math.abs(end.x - path.target.x) < 1e-9 && Math.abs(end.y - path.target.y) < 1e-9);
  const middle = magnetPoint(path, 0.5);
  assert.equal(middle.y, (path.start.y + path.target.y) / 2 - MAGNET.arc);
});
