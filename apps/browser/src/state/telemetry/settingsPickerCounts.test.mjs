import assert from "node:assert/strict";
import { after, test } from "node:test";
import { noteCtrlTabFollowedChrome, noteSettingsPick, takeSettingsPickerCounts } from "./settingsPickerCounts.ts";
globalThis.__DEV__ = false;
await import("../../test-native/index.ts");
globalThis.fetch = async () => ({ status: 503 });
const client = await import("./client.ts");
const { useBrowser } = await import("../browser/store.ts");
const { chooseAfterClosingTab } = await import("../settings/actions.ts");
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
  after_closing_tab_picks_recent: 0,
  after_closing_tab_picks_above: 0,
  after_closing_tab_picks_below: 0,
  ctrl_tab_follows_chrome_step: 0,
  ctrl_tab_follows_chrome_switcher: 0,
};

test("each picture picker counts its picks by the option chosen, and taking them starts over", () => {
  noteSettingsPick("ctrlTab", "switcher");
  noteSettingsPick("ctrlTab", "switcher");
  noteSettingsPick("ctrlTab", "step");
  noteSettingsPick("addressBar", "sidebar");
  noteSettingsPick("commandBar", "centred");
  noteSettingsPick("scrollToolbar", "keep");
  useBrowser.getState().hydrate({});
  chooseAfterClosingTab("tabAbove");
  assert.equal(useBrowser.getState().settings.afterClosingTab, "tabAbove");
  chooseAfterClosingTab("tabBelow");
  chooseAfterClosingTab("previouslyActive");
  assert.equal(useBrowser.getState().settings.afterClosingTab, "previouslyActive");
  assert.deepEqual(takeSettingsPickerCounts(), {
    ...ZERO,
    ctrl_tab_picks_switcher: 2,
    ctrl_tab_picks_step: 1,
    address_bar_picks_sidebar: 1,
    command_bar_picks_centred: 1,
    scroll_toolbar_picks_keep: 1,
    after_closing_tab_picks_above: 1,
    after_closing_tab_picks_below: 1,
    after_closing_tab_picks_recent: 1,
  });
  assert.deepEqual(takeSettingsPickerCounts(), ZERO);
});

test("picks made while sharing is off are not counted", () => {
  client.setSharing(false, "settings");
  noteSettingsPick("ctrlTab", "switcher");
  chooseAfterClosingTab("tabAbove");
  client.setSharing(true, "settings");
  assert.deepEqual(takeSettingsPickerCounts(), ZERO);
});

test("⌃Tab following Chrome's own setting counts apart from a pick in Settings", () => {
  noteCtrlTabFollowedChrome("switcher");
  noteCtrlTabFollowedChrome("step");
  noteCtrlTabFollowedChrome("switcher");
  assert.deepEqual(takeSettingsPickerCounts(), { ...ZERO, ctrl_tab_follows_chrome_switcher: 2, ctrl_tab_follows_chrome_step: 1 });
});
