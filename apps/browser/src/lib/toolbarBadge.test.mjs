import test from "node:test";
import assert from "node:assert/strict";

const { toolbarBadgeText } = await import("./toolbarBadge.ts");

test("short badge text is shown as it is", () => {
  assert.equal(toolbarBadgeText("3"), "3");
  assert.equal(toolbarBadgeText("1.2k"), "1.2k");
  assert.equal(toolbarBadgeText("new"), "new");
});

test("a long count is rounded to fit instead of cut", () => {
  assert.equal(toolbarBadgeText("123.8k"), "124k");
  assert.equal(toolbarBadgeText("12.34k"), "12k");
  assert.equal(toolbarBadgeText("1.234k"), "1.2k");
  assert.equal(toolbarBadgeText("45.6M"), "46M");
  assert.equal(toolbarBadgeText("-12.5k"), "-13k");
});

test("a long plain number gets a unit", () => {
  assert.equal(toolbarBadgeText("12345"), "12k");
  assert.equal(toolbarBadgeText("1000.4"), "1000");
});

test("rounding up into the next unit moves to that unit", () => {
  assert.equal(toolbarBadgeText("999.9k"), "1m");
  assert.equal(toolbarBadgeText("999.96K"), "1M");
});

test("long text that isn't a count keeps its first four characters", () => {
  assert.equal(toolbarBadgeText("hello"), "hell");
  assert.equal(toolbarBadgeText("12345b"), "1234");
});

test("numbers past 999 show as 999+", () => {
  assert.equal(toolbarBadgeText(42), "42");
  assert.equal(toolbarBadgeText(1000), "999+");
});
