import assert from "node:assert/strict";
import test from "node:test";
import { revealScrollY } from "./settingsReveal.ts";

test("a row above the visible list scrolls up to its top edge", () => {
  assert.equal(revealScrollY(300, 72, 420, 1800), 300);
});

test("a row below the visible list scrolls down until its bottom edge shows", () => {
  assert.equal(revealScrollY(2000, 72, 100, 1800), 272);
});

test("a row already in view, or a list not laid out yet, leaves the scroll alone", () => {
  assert.equal(revealScrollY(500, 72, 420, 1800), null);
  assert.equal(revealScrollY(300, 72, 420, 0), null);
});

test("a row taller than the list lines its top up with the list's top", () => {
  assert.equal(revealScrollY(2000, 2400, 100, 1800), 2000);
});
