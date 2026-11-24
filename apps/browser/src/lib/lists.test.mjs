import assert from "node:assert/strict";
import { test } from "node:test";
const { sameList } = await import("./lists.ts");

test("two lists are the same when they hold the same items in the same order", () => {
  assert.equal(sameList([], []), true);
  assert.equal(sameList(["a", "b"], ["a", "b"]), true);
  assert.equal(sameList(["a", "b"], ["b", "a"]), false);
  assert.equal(sameList(["a"], ["a", "a"]), false);
  assert.equal(sameList(["a", "b"], ["a"]), false);
  assert.equal(sameList([NaN], [NaN]), false);
  const shared = {};
  assert.equal(sameList([shared], [shared]), true);
  assert.equal(sameList([{}], [{}]), false);
});
