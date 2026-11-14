import assert from "node:assert/strict";
import { test } from "node:test";
import { linkToHighlight, selectionLabel } from "./contextMenuText";

test("a selection's label collapses whitespace and breaks long text at a word, like the Mac's", () => {
  assert.equal(selectionLabel("  hello\n\n  world "), "hello world");
  const long = "The quick brown fox jumps over the lazy dog and keeps running far away";
  assert.equal(selectionLabel(long), "The quick brown fox jumps over the lazy dog and…");
  assert.equal(selectionLabel("x".repeat(60)), `${"x".repeat(50)}…`);
  assert.equal(Array.from(selectionLabel("😀".repeat(60))).length, 51);
});

test("a link to a highlight keeps the page and replaces its fragment", () => {
  assert.equal(linkToHighlight("https://example.com/a?b=1#old", "Hello, big-world & co"), "https://example.com/a?b=1#:~:text=Hello%2C%20big%2Dworld%20%26%20co");
  assert.equal(linkToHighlight("file:///tmp/a.html", "hello"), null);
  assert.equal(linkToHighlight("https://example.com/", "   "), null);
  const words = Array.from({ length: 30 }, (_, i) => `word${i}`).join(" ");
  assert.equal(linkToHighlight("https://example.com/", words), "https://example.com/#:~:text=word0%20word1%20word2%20word3%20word4,word25%20word26%20word27%20word28%20word29");
});
