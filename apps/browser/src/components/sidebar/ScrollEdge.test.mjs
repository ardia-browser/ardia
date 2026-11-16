import assert from "node:assert/strict";
import { test } from "node:test";
const { scrolledPastTop } = await import("./ScrollEdge.tsx");

test("the scrolled line stays hidden at the top, even when a relayout leaves float noise in the offset", () => {
  for (const offset of [0, -0, 2e-7, -3, 0.25, 0.49]) assert.equal(scrolledPastTop(offset), false, String(offset));
  for (const offset of [0.5, 1, 40]) assert.equal(scrolledPastTop(offset), true, String(offset));
});
