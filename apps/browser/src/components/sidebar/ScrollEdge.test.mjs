import assert from "node:assert/strict";
import { test } from "node:test";
const { hiddenBelow, scrolledPastTop } = await import("./ScrollEdge.tsx");

test("the scrolled line stays hidden at the top, even when a relayout leaves float noise in the offset", () => {
  for (const offset of [0, -0, 2e-7, -3, 0.25, 0.49]) assert.equal(scrolledPastTop(offset), false, String(offset));
  for (const offset of [0.5, 1, 40]) assert.equal(scrolledPastTop(offset), true, String(offset));
});

test("the bottom line shows while rows are hidden below the list, as in Dia, and not at its end", () => {
  assert.equal(hiddenBelow({ offset: 0, viewport: 500, content: 1200 }), true);
  assert.equal(hiddenBelow({ offset: 400, viewport: 500, content: 1200 }), true);
  assert.equal(hiddenBelow({ offset: 700, viewport: 500, content: 1200 }), false);
  assert.equal(hiddenBelow({ offset: 699.5, viewport: 500, content: 1200 }), false);
});

test("a list that fits, or one not laid out yet, shows no bottom line", () => {
  assert.equal(hiddenBelow({ offset: 0, viewport: 500, content: 500 }), false);
  assert.equal(hiddenBelow({ offset: 0, viewport: 500, content: 320 }), false);
  assert.equal(hiddenBelow({ offset: 0, viewport: 0, content: 1200 }), false);
});
