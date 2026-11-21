import assert from "node:assert/strict";
import { test } from "node:test";

const { peekOverlaps } = await import("./peekClearance.ts");

test("a left peek moves the left corner cards past its edge and leaves the right corner alone", () => {
  assert.deepEqual(peekOverlaps([-Infinity, 199], 9, 1342), { left: 190, right: 0 });
  assert.deepEqual(peekOverlaps([-Infinity, 199], 700, 650), { left: 0, right: 0 }, "a split pane right of the peek is not under it");
});

test("a right peek moves the right corner items back past its edge", () => {
  assert.deepEqual(peekOverlaps([1161, Infinity], 9, 1342), { left: 0, right: 190 });
});

test("no peek, nothing moves", () => {
  assert.deepEqual(peekOverlaps(undefined, 9, 1342), { left: 0, right: 0 });
});
