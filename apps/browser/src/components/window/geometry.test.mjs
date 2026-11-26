import assert from "node:assert/strict";
import { test } from "node:test";

globalThis.__DEV__ = false;
const { evenPair, outerCorners, splitGeometry } = await import("./geometry.ts");
const GAP = 9;

const split = (ids, sizes, orientation = "horizontal") => ({ id: "s", orientation, slots: ids.map((tabId, i) => ({ size: sizes[i], tabId })) });

test("split panes sit the card's 9 pt apart and fill it to the last point, whatever the width's parity", () => {
  for (const width of [1158, 1159, 1160.5, 801]) {
    const { panes, dividers } = splitGeometry(split(["a", "b"], [0.5, 0.5]), width, 700, GAP);
    assert.equal(panes.b.x - (panes.a.x + panes.a.width), GAP, `${width}: the gap`);
    assert.equal(panes.b.x + panes.b.width, width, `${width}: the right pane ends at the card's edge`);
    assert.equal(dividers[0].rect.width, GAP);
  }
  const three = splitGeometry(split(["a", "b", "c"], [1 / 3, 1 / 3, 1 / 3]), 1001, 700, GAP).panes;
  assert.equal(three.c.x + three.c.width, 1001);
  const tall = splitGeometry(split(["a", "b"], [0.5, 0.5], "vertical"), 900, 701, GAP).panes;
  assert.equal(tall.b.y + tall.b.height, 701);
});

test("double-clicking a split divider evens the two panes it separates and leaves the others", () => {
  assert.deepEqual(evenPair([0.7, 0.3], 0), [0.5, 0.5]);
  assert.deepEqual(evenPair([0.2, 0.5, 0.3], 1), [0.2, 0.4, 0.4]);
  assert.deepEqual(evenPair([0.6, 0.4], 1), [0.6, 0.4]);
});

test("side-by-side panes round only the corners on the card's outer edge", () => {
  assert.deepEqual(outerCorners({ x: 0, y: 0, width: 499, height: 800 }, 1000, 800, 12), { topLeft: 12, topRight: 0, bottomLeft: 12, bottomRight: 0 });
  assert.deepEqual(outerCorners({ x: 501, y: 0, width: 499, height: 800 }, 1000, 800, 12), { topLeft: 0, topRight: 12, bottomLeft: 0, bottomRight: 12 });
});

test("a pane in a stack rounds only its outer corner, and a lone pane rounds all four", () => {
  assert.deepEqual(outerCorners({ x: 501, y: 401, width: 499, height: 399 }, 1000, 800, 12), { topLeft: 0, topRight: 0, bottomLeft: 0, bottomRight: 12 });
  assert.deepEqual(outerCorners({ x: 0, y: 0, width: 1000, height: 800 }, 1000, 800, 12), { topLeft: 12, topRight: 12, bottomLeft: 12, bottomRight: 12 });
});
