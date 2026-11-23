import assert from "node:assert/strict";
import { test } from "node:test";

globalThis.__DEV__ = false;
await import("../../test-native/index.ts");
const { focusHeroBar, registerHeroBar } = await import("./barState.ts");

test("⌘L selects the whole field, and a page shown again restores the selection it had", () => {
  const modes = [];
  const unregister = registerHeroBar("w1", "t1", (mode) => modes.push(mode));
  assert.equal(focusHeroBar("w1", "t1"), true);
  assert.equal(focusHeroBar("w1", "t1", "restore"), true);
  assert.deepEqual(modes, ["selectAll", "restore"]);
  unregister();
});

test("a second New Tab in the same window doesn't take the first one's bar, and closing it leaves the first", () => {
  const focused = [];
  const first = registerHeroBar("w1", "t1", () => focused.push("t1"));
  const second = registerHeroBar("w1", "t2", () => focused.push("t2"));
  assert.equal(focusHeroBar("w1", "t1", "restore"), true);
  assert.equal(focusHeroBar("w1", "t2"), true);
  second();
  assert.equal(focusHeroBar("w1", "t2"), false, "t2's bar is gone");
  assert.equal(focusHeroBar("w1", "t1"), true, "t1's bar is still there");
  assert.equal(focusHeroBar("w2", "t1"), false, "another window's bar for the same tab id isn't this one");
  assert.equal(focusHeroBar("w1", undefined), false);
  assert.deepEqual(focused, ["t1", "t2", "t1"]);
  first();
});
