import assert from "node:assert/strict";
import { test } from "node:test";

globalThis.__DEV__ = false;
const { evenPair, splitGeometry } = await import("./geometry.ts");
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

test("a grid lays out both stacks with their own sizes and divider identities in either orientation", () => {
  for (const orientation of ["horizontal", "vertical"]) {
    const slots = [
      { size: 0.4, stack: ["a", "b"], stackSizes: [0.3, 0.7] },
      { size: 0.6, stack: ["c", "d"], stackSizes: [0.6, 0.4] },
    ];
    const { panes, dividers } = splitGeometry({ orientation, slots }, 1009, 809, GAP);
    const horizontal = orientation === "horizontal";
    const main = horizontal ? "x" : "y";
    const cross = horizontal ? "y" : "x";
    const length = horizontal ? "width" : "height";
    const depth = horizontal ? "height" : "width";
    assert.equal(panes.a[main], 0);
    assert.equal(panes.a[length], horizontal ? 400 : 320);
    assert.equal(panes.a[cross], 0);
    assert.equal(panes.b[cross], panes.a[depth] + GAP);
    assert.equal(panes.c[cross], 0);
    assert.equal(panes.d[cross], panes.c[depth] + GAP);
    assert.equal(panes.d[main] + panes.d[length], horizontal ? 1009 : 809);
    assert.equal(panes.b[cross] + panes.b[depth], horizontal ? 809 : 1009);
    assert.equal(panes.d[cross] + panes.d[depth], horizontal ? 809 : 1009);
    assert.deepEqual(dividers.map(({ kind, index }) => [kind, index]), [["stack", 0], ["root", 0], ["stack", 1]]);
    assert.notEqual(dividers[0].rect[cross], dividers[2].rect[cross]);
  }
});
