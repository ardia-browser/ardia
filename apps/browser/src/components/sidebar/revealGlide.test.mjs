import assert from "node:assert/strict";
import { test } from "node:test";
import { glideOffsets } from "./useRevealTabs.ts";
import { REVEAL_GLIDE } from "./tokens.ts";

test("a reveal glides from where the list is to the row, eased, and lands exactly", () => {
  assert.deepEqual(glideOffsets(100, 500, 0), { y: 100, done: false });
  const middle = glideOffsets(100, 500, REVEAL_GLIDE.duration / 2);
  assert.ok(Math.abs(middle.y - 300) < 1, `halfway is halfway on an even ease, got ${middle.y}`);
  assert.deepEqual(glideOffsets(100, 500, REVEAL_GLIDE.duration), { y: 500, done: true });
  assert.deepEqual(glideOffsets(100, 500, REVEAL_GLIDE.duration * 3), { y: 500, done: true });
  assert.deepEqual(glideOffsets(500, 100, REVEAL_GLIDE.duration), { y: 100, done: true });
});
