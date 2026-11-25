import assert from "node:assert/strict";
import test from "node:test";
import { PLATFORM_FEATURES as LINUX_FEATURES } from "../../../../browser/src/lib/platformFeatures.linux.ts";
import { classicTabs } from "../../../../browser/src/state/onboarding/presets.ts";
import { DEFAULT_SETTINGS } from "../../../../browser/src/state/settings/settings.ts";

test("Linux starts in sidebar tabs: the classic-browser presets leave the tab layout to the default", () => {
  assert.equal(LINUX_FEATURES.classicPresetsPutTabsOnTop, false);
  assert.equal("tabLayout" in classicTabs(LINUX_FEATURES), false);
  assert.equal(DEFAULT_SETTINGS.tabLayout, "sidebar");
});
