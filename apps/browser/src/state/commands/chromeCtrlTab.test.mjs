import assert from "node:assert/strict";
import { test } from "node:test";
globalThis.__DEV__ = false;
await import("../../test-native/index.ts");
const { presetFollowingChrome } = await import("./chromeCtrlTab.ts");

test("turning on Chrome's most recently used order picks the recent tabs switcher, and turning it off goes back to stepping", () => {
  assert.equal(presetFollowingChrome({ "": false }, { "": true }, "step"), "switcher");
  assert.equal(presetFollowingChrome({ "": true }, { "": false }, "switcher"), "step");
});

test("a value already seen changes nothing, so a pick made in Ardia's Settings afterwards stays", () => {
  assert.equal(presetFollowingChrome({ "": true }, { "": true }, "step"), null);
  assert.equal(presetFollowingChrome({ "": false }, { "": false }, "switcher"), null);
});

test("the first look adopts an on left from an earlier version only over the default, never over custom keys", () => {
  assert.equal(presetFollowingChrome({}, { "": true }, "step"), "switcher");
  assert.equal(presetFollowingChrome({}, { "": true }, "custom"), null);
  assert.equal(presetFollowingChrome({}, { "": false }, "switcher"), null);
});

test("a change that already matches the choice asks for nothing", () => {
  assert.equal(presetFollowingChrome({ "": false }, { "": true }, "switcher"), null);
});

test("a change in one profile is followed even when another profile's value is unchanged", () => {
  assert.equal(presetFollowingChrome({ "": false, work: false }, { "": false, work: true }, "step"), "switcher");
});
