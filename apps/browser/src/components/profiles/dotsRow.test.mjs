import assert from "node:assert/strict";
import { test } from "node:test";
import { dotsRowLeftInset } from "./dotsRow.ts";

const SIDE_ROOM = 43;
const start = (width, row) => {
  const inset = dotsRowLeftInset(width, row, SIDE_ROOM);
  return inset + (width - inset - row) / 2;
};

test("a row that already clears the Downloads button stays centred in the sidebar", () => {
  assert.equal(dotsRowLeftInset(190, 36, SIDE_ROOM), 0);
  assert.equal(start(190, 36), 77);
  assert.equal(dotsRowLeftInset(190, 104, SIDE_ROOM), 0);
});

test("a row too wide to clear the button when centred starts just past it (#2917)", () => {
  assert.equal(start(190, 132), SIDE_ROOM);
  assert.equal(start(190, 110), SIDE_ROOM);
  assert.equal(start(260, 180), SIDE_ROOM);
});

test("the row never moves further right than the button's room", () => {
  assert.equal(dotsRowLeftInset(190, 400, SIDE_ROOM), SIDE_ROOM);
});
