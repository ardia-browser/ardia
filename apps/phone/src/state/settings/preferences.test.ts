import assert from "node:assert/strict";
import { test } from "node:test";
import { importPreferences } from "../legacy/importRules.ts";
import { defaultPreferences, parsePreferences } from "./preferences.ts";

test("only Android defaults to collapsing the bottom bar, including missing or invalid saved values", () => {
  for (const platform of [undefined, "ios", "android"]) {
    const expected = platform === "android";
    assert.equal(defaultPreferences(platform).collapsesBottomBar, expected);
    assert.equal(parsePreferences({}, platform).collapsesBottomBar, expected);
    assert.equal(parsePreferences({ "settings.collapseBottomBar": "invalid" }, platform).collapsesBottomBar, expected);
  }
});

test("explicit saved on and off values override every platform's default", () => {
  for (const platform of [undefined, "ios", "android"]) {
    for (const enabled of [false, true]) {
      assert.equal(parsePreferences({ "settings.collapseBottomBar": String(enabled) }, platform).collapsesBottomBar, enabled);
    }
  }
});

test("legacy imports retain boolean and string choices, including an explicit off on Android", () => {
  for (const saved of [false, true, "false", "true"]) {
    const imported = importPreferences({ "settings.collapseBottomBar": saved });
    assert.deepEqual(imported.excluded, {});
    assert.equal(parsePreferences(imported.values, "android").collapsesBottomBar, String(saved) === "true");
  }
});
