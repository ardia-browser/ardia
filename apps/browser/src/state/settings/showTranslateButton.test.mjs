import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_SETTINGS, parseSettings, SETTING_SPECS } from "./settings.ts";
import { isConfigSettingKey } from "./configAllowlist.ts";
import { settingsSnapshot } from "../telemetry/settingsSnapshot.ts";

test("the Translate button shows by default, and turning it off syncs, sits in config files and in the daily settings snapshot", () => {
  assert.equal(DEFAULT_SETTINGS.showTranslateButton, true);
  assert.equal(SETTING_SPECS.showTranslateButton.synced, true);
  assert.ok(isConfigSettingKey("showTranslateButton"));
  assert.equal(parseSettings({ showTranslateButton: false }).showTranslateButton, false);
  assert.equal(parseSettings({ showTranslateButton: "no" }).showTranslateButton, true);
  assert.equal(settingsSnapshot(parseSettings({ showTranslateButton: false })).setting_showTranslateButton, "false");
});
