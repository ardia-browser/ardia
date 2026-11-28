import assert from "node:assert/strict";
import { test } from "node:test";
import { importPreferences } from "../legacy/importRules.ts";
import { acceptsPreference, clampPageCornerRadius, defaultPreferences, PAGE_CORNER_RADIUS, parsePreferences, PREFERENCE_KEYS, serializePreference } from "./preferences.ts";

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

test("the iPad page has its border and a 16-point corner by default, and both are saved under their own keys", () => {
  for (const platform of [undefined, "ios", "android"]) {
    const read = parsePreferences({}, platform);
    assert.equal(read.pageBorder, true);
    assert.equal(read.pageCornerRadius, 16);
  }
  assert.deepEqual(PAGE_CORNER_RADIUS, { min: 0, max: 24, standard: 16 });
  assert.equal(PREFERENCE_KEYS.pageBorder, "browsing.pageBorder");
  assert.equal(PREFERENCE_KEYS.pageCornerRadius, "browsing.pageCornerRadius");
  assert.equal(serializePreference<"pageBorder">(false), "false");
  assert.equal(serializePreference<"pageCornerRadius">(9), "9");
});

test("a saved page border and corner read back, the corner held to 0 to 24 whole points, and anything else falls back to the defaults", () => {
  const read = (border: string, radius: string) => parsePreferences({ "browsing.pageBorder": border, "browsing.pageCornerRadius": radius });
  assert.deepEqual([read("false", "0").pageBorder, read("false", "0").pageCornerRadius], [false, 0]);
  assert.deepEqual([read("true", "24").pageBorder, read("true", "24").pageCornerRadius], [true, 24]);
  assert.equal(read("true", "30").pageCornerRadius, 24);
  assert.equal(read("true", "-4").pageCornerRadius, 0);
  assert.equal(read("true", "11.6").pageCornerRadius, 12);
  for (const junk of ["", "big", "NaN", "Infinity", "1e3", "12pt", "99999"]) assert.equal(read("true", junk).pageCornerRadius, 16, junk);
  for (const junk of ["", "yes", "1", "TRUE"]) assert.equal(read(junk, "16").pageBorder, true, junk);
  assert.equal(acceptsPreference("pageCornerRadius", "12"), true);
  assert.equal(acceptsPreference("pageCornerRadius", "wide"), false);
});

test("setting the corner holds it to 0 to 24 whole points, as loading does", () => {
  assert.equal(clampPageCornerRadius(16), 16);
  assert.equal(clampPageCornerRadius(25), 24);
  assert.equal(clampPageCornerRadius(-1), 0);
  assert.equal(clampPageCornerRadius(3.4), 3);
  assert.equal(clampPageCornerRadius(Number.POSITIVE_INFINITY), 16);
});
