import assert from "node:assert/strict";
import test from "node:test";
import { floatingSheetHalfRest, floatingSheetScale, halfSheetPosition, SHEET_DETENT_FLICK, sheetDetentAfterDrag, sheetHalfRest } from "./sheetDetent.ts";
import { TRAY_DRAG } from "./trayMotion.ts";

const SCREEN = 900;
const FULL = 840;
const HALF_REST = sheetHalfRest(FULL, SCREEN);
const HALF_HEIGHT = FULL - HALF_REST;

test("the half stop shows half the screen, and a sheet shorter than that has none", () => {
  assert.equal(HALF_REST, 390);
  assert.equal(HALF_HEIGHT, 450);
  assert.equal(sheetHalfRest(400, SCREEN), 0);
});

test("dragging up from half follows the finger to full, then stretches only a little past it", () => {
  assert.equal(halfSheetPosition(HALF_REST, -200), 190);
  assert.equal(halfSheetPosition(HALF_REST, -HALF_REST), 0);
  const past = halfSheetPosition(HALF_REST, -HALF_REST - 400);
  assert.ok(past < 0 && past > -TRAY_DRAG.upwardLimit);
  assert.equal(halfSheetPosition(HALF_REST, 120), HALF_REST + 120);
});

test("from half, a drag up past halfway or a flick up opens it fully", () => {
  assert.equal(sheetDetentAfterDrag(150, 0, HALF_REST, HALF_HEIGHT), "full");
  assert.equal(sheetDetentAfterDrag(350, -SHEET_DETENT_FLICK, HALF_REST, HALF_HEIGHT), "full");
  assert.equal(sheetDetentAfterDrag(300, 0, HALF_REST, HALF_HEIGHT), "half");
});

test("from full, a drag or flick down lands on half, not closed", () => {
  assert.equal(sheetDetentAfterDrag(80, SHEET_DETENT_FLICK, HALF_REST, HALF_HEIGHT), "half");
  assert.equal(sheetDetentAfterDrag(250, 0, HALF_REST, HALF_HEIGHT), "half");
  assert.equal(sheetDetentAfterDrag(60, 0, HALF_REST, HALF_HEIGHT), "full");
});

test("below half, a short drag springs back and a long drag or a flick closes it", () => {
  assert.equal(sheetDetentAfterDrag(HALF_REST + 30, 0, HALF_REST, HALF_HEIGHT), "half");
  assert.equal(sheetDetentAfterDrag(HALF_REST + 140, 0, HALF_REST, HALF_HEIGHT), "dismiss");
  assert.equal(sheetDetentAfterDrag(HALF_REST + 20, TRAY_DRAG.flickVelocity, HALF_REST, HALF_HEIGHT), "dismiss");
  assert.equal(sheetDetentAfterDrag(HALF_REST + 140, -400, HALF_REST, HALF_HEIGHT), "half");
});

test("a floating half stop scaled to the inset card shows the iPhone medium card's 450.6 pt on a 402 by 874 pt screen", () => {
  const scale = floatingSheetScale(402, 8);
  assert.equal(Math.round(scale * 10000) / 10000, 0.9602);
  const rest = floatingSheetHalfRest(812, 874, 0.5156, scale);
  assert.equal(Math.round((812 - rest) * scale * 10) / 10, 450.6);
  assert.equal(floatingSheetHalfRest(300, 874, 0.5156, scale), 0);
  assert.equal(floatingSheetScale(10, 8), 1);
});
