import assert from "node:assert/strict";
import { test } from "node:test";
import { revealedOffset } from "./switcherScroll.ts";

const CARD = 168;
const STRIDE = 176;
const COUNT = 7;
const VIEWPORT = COUNT * CARD + (COUNT - 1) * (STRIDE - CARD);
const TABS = 15;
const at = (index, offset) => revealedOffset(index, offset, VIEWPORT, CARD, STRIDE);

test("hovering any card on screen never scrolls the row, so the card under the pointer stays put", () => {
  for (const offset of [0, STRIDE * 3, STRIDE * 8, STRIDE * 2.4]) {
    for (let x = 0; x < VIEWPORT; x += 7) {
      const under = Math.floor((offset + x) / STRIDE);
      if ((offset + x) % STRIDE >= CARD) continue;
      const left = under * STRIDE;
      if (left < offset || left + CARD > offset + VIEWPORT) continue;
      assert.equal(at(under, offset), offset, `offset ${offset}, pointer ${x}`);
    }
  }
});

test("stepping right scrolls one card once the selection passes the right edge, and stepping left one card at the left edge", () => {
  let offset = 0;
  for (let index = 1; index < COUNT; index++) offset = at(index, offset);
  assert.equal(offset, 0);
  offset = at(COUNT, offset);
  assert.equal(offset, STRIDE);
  offset = at(COUNT + 1, offset);
  assert.equal(offset, STRIDE * 2);
  for (let index = COUNT; index >= 2; index--) offset = at(index, offset);
  assert.equal(offset, STRIDE * 2);
  offset = at(1, offset);
  assert.equal(offset, STRIDE);
});

test("wrapping around jumps to the start or the end", () => {
  const end = TABS * STRIDE - (STRIDE - CARD) - VIEWPORT;
  assert.equal(at(TABS - 1, 0), end);
  assert.equal(at(0, end), 0);
});

test("a card cut off by a wheel scroll comes fully into view by the smallest scroll", () => {
  const offset = STRIDE * 2 + 60;
  assert.equal(at(2, offset), STRIDE * 2);
  assert.equal(at(2 + COUNT, offset), (2 + COUNT) * STRIDE + CARD - VIEWPORT);
  assert.equal(at(5, offset), offset);
});
