import assert from "node:assert/strict";
import { after, test } from "node:test";
import { noteSettingsPick, noteShortcutsKeywordFind, takeSettingsPickerCounts } from "./settingsPickerCounts.ts";
globalThis.__DEV__ = false;
await import("../../test-native/index.ts");
globalThis.fetch = async () => ({ status: 503 });
const client = await import("./client.ts");
const { useBrowser } = await import("../browser/store.ts");
const { chooseAfterClosingTab, chooseTabSwitcherOrder, chooseTabSwitcherView } = await import("../settings/actions.ts");
client.loadChoice();
client.setSharing(true, "settings");
after(() => client.setSharing(false, "settings"));

const ZERO = {
  tab_switcher_order_picks_recent: 0,
  tab_switcher_order_picks_in_order: 0,
  tab_switcher_view_picks_thumbnails: 0,
  tab_switcher_view_picks_compact_list: 0,
  tab_switcher_view_picks_none: 0,
  address_bar_picks_sidebar: 0,
  address_bar_picks_toolbar: 0,
  command_bar_picks_field: 0,
  command_bar_picks_centred: 0,
  scroll_toolbar_picks_keep: 0,
  scroll_toolbar_picks_hide: 0,
  after_closing_tab_picks_recent: 0,
  after_closing_tab_picks_above: 0,
  after_closing_tab_picks_below: 0,
  auto_hide_tabs_keys_changed: 0,
  auto_hide_tabs_keys_cleared: 0,
  shortcuts_keyword_finds: 0,
};

test("each picture picker counts its picks by the option chosen, and taking them starts over", () => {
  useBrowser.getState().hydrate({});
  chooseTabSwitcherOrder("inOrder");
  chooseTabSwitcherOrder("recent");
  chooseTabSwitcherOrder("inOrder");
  chooseTabSwitcherView("compactList");
  chooseTabSwitcherView("none");
  assert.equal(useBrowser.getState().settings.tabSwitcherOrder, "inOrder");
  assert.equal(useBrowser.getState().settings.tabSwitcherView, "none");
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
    tab_switcher_order_picks_in_order: 2,
    tab_switcher_order_picks_recent: 1,
    tab_switcher_view_picks_compact_list: 1,
    tab_switcher_view_picks_none: 1,
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
  chooseTabSwitcherView("thumbnails");
  chooseAfterClosingTab("tabAbove");
  client.setSharing(true, "settings");
  assert.deepEqual(takeSettingsPickerCounts(), ZERO);
});

test("the Auto-hide tabs row counts its shortcut changes and removals, and Keyboard Shortcuts counts finds by a command-bar word", () => {
  noteSettingsPick("autoHideTabsKeys", "changed");
  noteSettingsPick("autoHideTabsKeys", "changed");
  noteSettingsPick("autoHideTabsKeys", "cleared");
  noteShortcutsKeywordFind();
  assert.deepEqual(takeSettingsPickerCounts(), { ...ZERO, auto_hide_tabs_keys_changed: 2, auto_hide_tabs_keys_cleared: 1, shortcuts_keyword_finds: 1 });
  client.setSharing(false, "settings");
  noteShortcutsKeywordFind();
  client.setSharing(true, "settings");
  assert.deepEqual(takeSettingsPickerCounts(), ZERO);
});
