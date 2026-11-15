import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_SETTINGS, parseSettings, SETTING_SPECS } from "./settings.ts";
import { isConfigSettingKey } from "./configAllowlist.ts";
import { settingsSnapshot } from "../telemetry/settingsSnapshot.ts";

test("history suggestions are on by default, and turning them off syncs, sits in config files and in the daily settings snapshot", () => {
  assert.equal(DEFAULT_SETTINGS.commandBarHistory, true);
  assert.equal(SETTING_SPECS.commandBarHistory.synced, true);
  assert.ok(isConfigSettingKey("commandBarHistory"));
  assert.equal(parseSettings({ commandBarHistory: false }).commandBarHistory, false);
  assert.equal(parseSettings({ commandBarHistory: 0 }).commandBarHistory, true);
  assert.equal(settingsSnapshot(parseSettings({ commandBarHistory: false })).setting_commandBarHistory, "false");
});
