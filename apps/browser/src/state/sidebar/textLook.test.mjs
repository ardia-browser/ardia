import assert from "node:assert/strict";
import { test } from "node:test";
const { highContrastSidebarText } = await import("./textLook.ts");
const { DEFAULT_LOOK, resolveLook, withSidebarText } = await import("../../lib/themeLook.ts");
const { SETTING_SPECS, DEFAULT_SETTINGS } = await import("../settings/settings.ts");
const { isConfigSettingKey } = await import("../settings/configAllowlist.ts");

test("the default sidebar text keeps Dia's look object, so nothing redraws", () => {
  assert.equal(withSidebarText(DEFAULT_LOOK, "default"), DEFAULT_LOOK);
  assert.equal(DEFAULT_SETTINGS.sidebarTextSize, "default");
  assert.equal(DEFAULT_SETTINGS.sidebarTextContrast, "auto");
});

test("larger sidebar text scales the row metrics and keeps one look per size", () => {
  const large = withSidebarText(DEFAULT_LOOK, "large");
  assert.equal(large, withSidebarText(DEFAULT_LOOK, "large"));
  assert.deepEqual(large.metrics, { rowHeight: 39, rowGap: 3, pinnedHeight: 47 });
  assert.equal(Math.round(large.sizes.body * large.sidebarScale), 15);
  const larger = withSidebarText(DEFAULT_LOOK, "larger");
  assert.deepEqual(larger.metrics, { rowHeight: 44, rowGap: 4, pinnedHeight: 54 });
  assert.equal(Math.round(larger.sizes.body * larger.sidebarScale), 17);
  assert.equal(larger.sizes.body, DEFAULT_LOOK.sizes.body, "the rest of the app keeps its sizes");
});

test("a theme's own row metrics scale with the sidebar text", () => {
  const themed = resolveLook({ metrics: { rowHeight: 30, pinnedHeight: 40 } });
  assert.deepEqual(withSidebarText(themed, "larger").metrics, { rowHeight: 39, rowGap: 4, pinnedHeight: 52 });
});

test("higher contrast follows macOS Increase Contrast until it is chosen", () => {
  assert.equal(highContrastSidebarText("auto", false), false);
  assert.equal(highContrastSidebarText("auto", true), true);
  assert.equal(highContrastSidebarText("standard", true), false);
  assert.equal(highContrastSidebarText("high", false), true);
});

test("both settings are config keys; only the contrast syncs", () => {
  assert.ok(isConfigSettingKey("sidebarTextSize"));
  assert.ok(isConfigSettingKey("sidebarTextContrast"));
  assert.equal(SETTING_SPECS.sidebarTextSize.synced, false);
  assert.equal(SETTING_SPECS.sidebarTextContrast.synced, true);
});
