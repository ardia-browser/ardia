import assert from "node:assert/strict";
import { test } from "node:test";
import { columnCenterX, columnContentLeft, columnContentWidth, currentScreenLayout, PHONE_LAYOUT, reportScreenLayout, screenLayoutOf, useScreenLayout } from "./screenLayout.ts";

test("the native report maps to a layout, and anything incomplete or missing stays the phone layout", () => {
  assert.deepEqual(screenLayoutOf(null), PHONE_LAYOUT);
  assert.deepEqual(screenLayoutOf({ layout: "column", column: { edge: "trailing", inset: 84 } }), { name: "column", column: { edge: "trailing", inset: 84 } });
  assert.deepEqual(screenLayoutOf({ layout: "column" }), PHONE_LAYOUT);
  assert.deepEqual(screenLayoutOf({ layout: "split", fold: { top: 440, bottom: 520 } }), { name: "split", fold: { top: 440, bottom: 520 } });
  assert.deepEqual(screenLayoutOf({ layout: "split" }), PHONE_LAYOUT);
  assert.deepEqual(screenLayoutOf({ layout: "wide" }), { name: "wide" });
  assert.deepEqual(screenLayoutOf({ layout: "phone" }), PHONE_LAYOUT);
});

test("a closed Duo's trailing 84 column sits 48 from the edge with 382 points of content, and a narrow inset pulls the column in", () => {
  const trailing = { edge: "trailing", inset: 84 } as const;
  assert.equal(columnCenterX(trailing, 466), 418);
  assert.equal(columnContentWidth(trailing, 466), 382);
  assert.equal(columnContentLeft(trailing), 0);
  const leading = { edge: "leading", inset: 72 } as const;
  assert.equal(columnCenterX(leading, 466), 48);
  assert.equal(columnContentLeft(leading), 72);
  assert.equal(columnCenterX({ edge: "leading", inset: 60 }, 466), 36);
});

test("an unchanged report keeps the same layout object, so nothing re-renders for it", () => {
  reportScreenLayout({ layout: "column", column: { edge: "trailing", inset: 84 } });
  const first = currentScreenLayout();
  reportScreenLayout({ layout: "column", column: { edge: "trailing", inset: 84 } });
  assert.equal(currentScreenLayout(), first);
  reportScreenLayout({ layout: "wide" });
  assert.deepEqual(currentScreenLayout(), { name: "wide" });
  useScreenLayout.setState({ layout: PHONE_LAYOUT });
});
