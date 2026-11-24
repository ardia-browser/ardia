import assert from "node:assert/strict";
import { test } from "node:test";
const { singleLine } = await import("./singleLine.ts");

test("a title with line breaks reads as one line", () => {
  assert.equal(singleLine('(3) Owen Williams ⚡ on X: "also me\nseveral hours later:\n\nit works" / X'), '(3) Owen Williams ⚡ on X: "also me several hours later: it works" / X');
  assert.equal(singleLine("a \r\n  b"), "a b");
  assert.equal(singleLine("a\u2028b"), "a b");
  assert.equal(singleLine("\nleading and trailing\n"), "leading and trailing");
});

test("a title without line breaks comes back untouched", () => {
  const title = "  Inbox (3)  —  Gmail ";
  assert.equal(singleLine(title), title);
  assert.equal(singleLine(""), "");
});
