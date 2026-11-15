import assert from "node:assert/strict";
import { test } from "node:test";
import { fieldButtonsShown } from "./fieldButtons.ts";
import { DEFAULT_SETTINGS, parseSettings, SETTING_SPECS } from "../../state/settings/settings.ts";
import { isConfigSettingKey } from "../../state/settings/configAllowlist.ts";
import { settingsSnapshot } from "../../state/telemetry/settingsSnapshot.ts";

test("the address bar's buttons show on hover by default, and always when asked", () => {
  assert.equal(DEFAULT_SETTINGS.addressBarButtons, "hover");
  assert.equal(fieldButtonsShown("hover", false), false);
  assert.equal(fieldButtonsShown("hover", true), true);
  assert.equal(fieldButtonsShown("always", false), true);
  assert.equal(fieldButtonsShown("always", true), true);
});

test("the address bar buttons setting syncs, sits in config files and in the daily settings snapshot, and a value it doesn't know falls back to hover", () => {
  assert.equal(SETTING_SPECS.addressBarButtons.synced, true);
  assert.ok(isConfigSettingKey("addressBarButtons"));
  assert.equal(parseSettings({ addressBarButtons: "always" }).addressBarButtons, "always");
  assert.equal(parseSettings({ addressBarButtons: "sometimes" }).addressBarButtons, "hover");
  assert.equal(settingsSnapshot(parseSettings({ addressBarButtons: "always" })).setting_addressBarButtons, "always");
});
