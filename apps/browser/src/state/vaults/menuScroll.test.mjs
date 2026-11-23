import assert from "node:assert/strict";
import { test } from "node:test";
const { scrollToKeep } = await import("./menuScroll.ts");

const ROW = 42;
const PAD = 7;
const ROOM = ROW * 7;
const rowAt = (index) => ({ start: PAD + index * ROW, end: PAD + (index + 1) * ROW });
const content = (rows) => PAD + rows * ROW + 4;

test("stepping down past the bottom keeps the whole highlighted row and its inset in view", () => {
  const view = { top: 0, room: ROOM, content: content(19), inset: PAD };
  const y = scrollToKeep(rowAt(7), view);
  assert.equal(y, rowAt(7).end + PAD - ROOM);
  assert.ok(rowAt(7).end + PAD <= y + ROOM, "the row's bottom and its 7 pt inset are inside the viewport");
  assert.ok(rowAt(7).start >= y, "its top too");
});

test("a row already in view doesn't scroll", () => {
  assert.equal(scrollToKeep(rowAt(2), { top: 0, room: ROOM, content: content(19), inset: PAD }), null);
});

test("stepping back up shows the row with the inset above it, and the first row goes back to the top", () => {
  const view = { top: 400, room: ROOM, content: content(19), inset: PAD };
  assert.equal(scrollToKeep(rowAt(5), view), rowAt(5).start - PAD);
  assert.equal(scrollToKeep(rowAt(0), view), 0);
});

test("the last row never scrolls past the end of the list", () => {
  const view = { top: 0, room: ROOM, content: content(19), inset: PAD };
  assert.equal(scrollToKeep(rowAt(18), view), content(19) - ROOM);
});
