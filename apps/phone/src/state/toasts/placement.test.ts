import assert from "node:assert/strict";
import { test } from "node:test";
import { pageBarClearance, toastBottom, toastDragDismisses, toastPlace } from "./placement.ts";

const base = { keyboardLift: null, safeBottom: 24, barClearance: 64, hostBottomY: 2400 / 2.75, barTopY: null, gap: 8 };

test("over the deck the toast sits a gap above the bar's measured top, whatever the phone", () => {
  assert.equal(toastBottom({ ...base, hostBottomY: 872, barTopY: 700 }), 180);
  assert.equal(toastBottom({ ...base, hostBottomY: 915, barTopY: 760 }), 163);
});

test("with no deck bar it clears the system area and the page bar, and the keyboard wins when it is up", () => {
  assert.equal(toastBottom(base), 88);
  assert.equal(toastBottom({ ...base, barTopY: 860, hostBottomY: 872 }), 88);
  assert.equal(toastBottom({ ...base, keyboardLift: 300, barTopY: 700, hostBottomY: 872 }), 308);
});

test("with the keyboard up the toast moves to the top of the screen, 4 points under the status bar, as both apps place it", () => {
  assert.deepEqual(toastPlace({ ...base, safeTop: 48, keyboardLift: 300 }), { top: 52 });
  assert.deepEqual(toastPlace({ ...base, safeTop: 48 }), { bottom: 88 });
});

test("a toast drags away past 24 points or on a fling projected past 40, and springs back otherwise", () => {
  assert.equal(toastDragDismisses(25, 0), true);
  assert.equal(toastDragDismisses(10, 100), true);
  assert.equal(toastDragDismisses(10, 50), false);
  assert.equal(toastDragDismisses(-30, 0), false);
});

test("over a page the toast clears the floating bar by 64 points, and Android's Material You bar, 8 above the safe area and 64 tall, by its top plus a gap (#3339)", () => {
  assert.equal(pageBarClearance(null, 64, 8), 64);
  assert.equal(pageBarClearance({ inset: 8, height: 64 }, 64, 8), 80);
  assert.equal(toastBottom({ ...base, barClearance: pageBarClearance({ inset: 8, height: 64 }, 64, 8) }), 104);
});
