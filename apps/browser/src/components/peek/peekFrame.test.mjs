import assert from "node:assert/strict";
import { test } from "node:test";
const { peekFrame, PEEK_SIDE_GAP } = await import("./peekFrame.ts");
const { SMALL_BAR_BUTTON } = await import("../littleArdia/tokens.ts");

const sideColumn = SMALL_BAR_BUTTON + 2 * PEEK_SIDE_GAP;

test("a Peek with its buttons in the title bar sits centred, the same inset on each side", () => {
  const frame = peekFrame(1000, 800);
  assert.deepEqual(frame, peekFrame(1000, 800, "top"));
  assert.equal(frame.left, 1000 - frame.left - frame.width);
  assert.equal(frame.top, 800 - frame.top - frame.height);
});

test("side buttons widen only their own gutter, enough for the column and its gaps, and never move the card's top", () => {
  for (const width of [300, 600, 1000, 2400]) {
    const top = peekFrame(width, 800);
    const left = peekFrame(width, 800, "left");
    const right = peekFrame(width, 800, "right");
    assert.ok(left.left >= sideColumn, `left gutter at ${width}`);
    assert.equal(width - left.left - left.width, top.left, `left mode keeps the right inset at ${width}`);
    assert.equal(right.left, top.left, `right mode keeps the left inset at ${width}`);
    assert.ok(width - right.left - right.width >= sideColumn, `right gutter at ${width}`);
    for (const frame of [left, right]) {
      assert.equal(frame.top, top.top);
      assert.equal(frame.height, top.height);
      assert.ok(frame.width <= top.width);
    }
  }
});

test("a window too small for a Peek gives it no size rather than a negative one", () => {
  for (const buttons of ["top", "left", "right"]) {
    const frame = peekFrame(30, 20, buttons);
    assert.equal(frame.width, 0, buttons);
    assert.equal(frame.height, 0, buttons);
  }
});
