import assert from "node:assert/strict";
import { test } from "node:test";
import { importPreferences } from "../legacy/importRules.ts";
import { defaultPreferences, parsePreferences, serializePreference } from "./preferences.ts";

test("both phones default to folding the bottom bar into the pill on scroll, including missing or invalid saved values", () => {
  for (const platform of [undefined, "ios", "android"]) {
    const expected = platform !== undefined;
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

test("the custom theme is stored as JSON on the phone, sanitized when read, and Custom is a colour choice", () => {
  const theme = { stops: [{ color: { r: 0.4, g: 0.2, b: 0.9, a: 1 }, x: 0.3, y: 0.7 }], intensity: 0.7, grain: 0.5, texture: "denim" as const, translucency: 0.4, mode: "dark" as const, angle: 90 };
  const stored = serializePreference<"customTheme">(theme);
  assert.equal(typeof stored, "string");
  const read = parsePreferences({ "settings.color": "custom", "settings.customTheme": stored! });
  assert.equal(read.colorChoice, "custom");
  assert.deepEqual(read.customTheme, theme);
  assert.equal(serializePreference<"customTheme">(null), null);
  assert.equal(parsePreferences({ "settings.customTheme": "{not json" }).customTheme, null);
  assert.equal(parsePreferences({ "settings.customTheme": JSON.stringify({ stops: [] }) }).customTheme, null);
  const wild = parsePreferences({ "settings.customTheme": JSON.stringify({ ...theme, intensity: 7, texture: "silk", mode: "sepia", stops: [...theme.stops, ...theme.stops, ...theme.stops, ...theme.stops] }) }).customTheme!;
  assert.equal(wild.intensity, 1);
  assert.equal(wild.texture, "grain");
  assert.equal(wild.mode, "auto");
  assert.equal(wild.stops.length, 3);
});
