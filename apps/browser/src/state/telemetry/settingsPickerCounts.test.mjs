import assert from "node:assert/strict";
import { after, test } from "node:test";
import { noteSettingsPick, takeSettingsPickerCounts } from "./settingsPickerCounts.ts";
globalThis.__DEV__ = false;
await import("../../test-native/index.ts");
globalThis.fetch = async () => ({ status: 503 });
const client = await import("./client.ts");
client.loadChoice();
client.setSharing(true, "settings");
after(() => client.setSharing(false, "settings"));

const ZERO = {
  ctrl_tab_picks_step: 0,
  ctrl_tab_picks_switcher: 0,
  address_bar_picks_sidebar: 0,
  address_bar_picks_toolbar: 0,
  command_bar_picks_field: 0,
  command_bar_picks_centred: 0,
  scroll_toolbar_picks_keep: 0,
  scroll_toolbar_picks_hide: 0,
};

test("each picture picker counts its picks by the option chosen, and taking them starts over", () => {
  noteSettingsPick("ctrlTab", "switcher");
  noteSettingsPick("ctrlTab", "switcher");
  noteSettingsPick("ctrlTab", "step");
  noteSettingsPick("addressBar", "sidebar");
  noteSettingsPick("commandBar", "centred");
  noteSettingsPick("scrollToolbar", "keep");
  assert.deepEqual(takeSettingsPickerCounts(), { ...ZERO, ctrl_tab_picks_switcher: 2, ctrl_tab_picks_step: 1, address_bar_picks_sidebar: 1, command_bar_picks_centred: 1, scroll_toolbar_picks_keep: 1 });
  assert.deepEqual(takeSettingsPickerCounts(), ZERO);
});

test("picks made while sharing is off are not counted", () => {
  client.setSharing(false, "settings");
  noteSettingsPick("ctrlTab", "switcher");
  client.setSharing(true, "settings");
  assert.deepEqual(takeSettingsPickerCounts(), ZERO);
});
