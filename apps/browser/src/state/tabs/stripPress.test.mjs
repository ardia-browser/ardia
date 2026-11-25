import assert from "node:assert/strict";
import { test } from "node:test";

const { ackStripPress, markStripPress, matchStripPress, pressStripClose, pressStripOpen } = await import("./stripPress.ts");

test("a ✕ press marks only its own tab's close in its own window; matching doesn't consume, the commit does", () => {
  markStripPress("w1", "close", "t1", 1000);
  assert.deepEqual(matchStripPress("w2", ["t1"], [], 1010), []);
  assert.deepEqual(matchStripPress("w1", ["t2"], [], 1010), []);
  assert.deepEqual(matchStripPress("w1", ["t1"], [], 1010), ["t1"]);
  assert.deepEqual(matchStripPress("w1", ["t1"], [], 1011), ["t1"], "a render that's retried still finds it");
  ackStripPress("w1", ["t1"]);
  assert.deepEqual(matchStripPress("w1", ["t1"], [], 1020), []);
});

test("two closes in one change are both taken by its commit", () => {
  markStripPress("w1", "close", "a", 1000);
  markStripPress("w1", "close", "b", 1000);
  const ids = matchStripPress("w1", ["a", "b"], [], 1010);
  assert.deepEqual(ids, ["a", "b"]);
  ackStripPress("w1", ids);
  assert.deepEqual(matchStripPress("w1", ["a", "b"], [], 1010), []);
});

test("a press that changed nothing leaves no mark: + that opened no tab, ✕ that kept the tab", () => {
  pressStripOpen("w1", () => "", () => true);
  assert.deepEqual(matchStripPress("w1", [], ["anything"]), []);
  pressStripClose("w1", "pinned", () => {}, () => true);
  assert.deepEqual(matchStripPress("w1", ["pinned"], []), []);
  markStripPress("w1", "close", "", 1000);
  assert.deepEqual(matchStripPress("w1", [""], [], 1010), []);
  pressStripOpen("w1", () => "t9", () => true);
  assert.deepEqual(matchStripPress("w1", [], ["t8"]), []);
  assert.deepEqual(matchStripPress("w1", [], ["t9"]), ["t9"]);
  ackStripPress("w1", ["t9"]);
});

test("an unused mark runs out after a second", () => {
  markStripPress("w1", "close", "late", 5000);
  assert.deepEqual(matchStripPress("w1", ["late"], [], 6500), []);
});
