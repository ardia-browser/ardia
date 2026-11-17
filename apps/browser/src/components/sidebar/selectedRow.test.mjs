import assert from "node:assert/strict";
import { test } from "node:test";
const { rowAway, visibleSpan } = await import("./selectedRow.ts");
const { GLOW_ROOM } = await import("./pageLayout.ts");

const row = (y, height = 34) => ({ y, height });

test("the pill points down only once the selected row is wholly below the list, as in Dia", () => {
  assert.equal(rowAway(row(600), 0, 500), "below");
  assert.equal(rowAway(row(500), 0, 500), "below");
  assert.equal(rowAway(row(480), 0, 500), null);
  assert.equal(rowAway(row(200), 0, 500), null);
});

test("the pill points up once the selected row is wholly above the list's visible top", () => {
  const scrolled = 400;
  const top = visibleSpan(scrolled, 500).top;
  assert.equal(top, scrolled + GLOW_ROOM);
  assert.equal(rowAway(row(top - 34), scrolled, 500), "above");
  assert.equal(rowAway(row(top - 20), scrolled, 500), null);
  assert.equal(rowAway(row(0), 0, 500), null);
  const lifted = visibleSpan(scrolled, 500, 3).top;
  assert.equal(lifted, scrolled + GLOW_ROOM - 3);
  assert.equal(rowAway(row(lifted - 32), scrolled, 500, 3), null, "a row still peeking under the lifted line shows no pill");
  assert.equal(rowAway(row(lifted - 34), scrolled, 500, 3), "above");
});

test("no pill without a selected row in the list, or before the list is laid out", () => {
  assert.equal(rowAway(null, 0, 500), null);
  assert.equal(rowAway(row(900), 0, 0), null);
});
