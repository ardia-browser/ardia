import assert from "node:assert/strict";
import { test } from "node:test";
const { sameList, spokenList } = await import("./lists.ts");

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

test("a spoken list joins its last two items with and", () => {
  assert.equal(spokenList([]), "");
  assert.equal(spokenList(["Chrome"]), "Chrome");
  assert.equal(spokenList(["Chrome", "Arc"]), "Chrome and Arc");
  assert.equal(spokenList(["Chrome", "Arc", "Safari"]), "Chrome, Arc and Safari");
});
