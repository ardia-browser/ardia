import type { ConsentToken } from "./choice";
import { consentOrNow, countFor } from "./countFor";

type Picks = {
  tabSwitcherOrder: "recent" | "in_order";
  tabSwitcherView: "thumbnails" | "compact_list" | "none";
  addressBar: "sidebar" | "toolbar";
  commandBar: "field" | "centred";
  scrollToolbar: "keep" | "hide";
  afterClosingTab: "recent" | "above" | "below";
  autoHideTabsKeys: "changed" | "cleared";
};

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

type Field = keyof typeof ZERO;

const FIELD_PREFIX: { [P in keyof Picks]: string } = {
  tabSwitcherOrder: "tab_switcher_order_picks",
  tabSwitcherView: "tab_switcher_view_picks",
  addressBar: "address_bar_picks",
  commandBar: "command_bar_picks",
  scrollToolbar: "scroll_toolbar_picks",
  afterClosingTab: "after_closing_tab_picks",
  autoHideTabsKeys: "auto_hide_tabs_keys",
};

let counts = { ...ZERO };

export function noteSettingsPick<P extends keyof Picks>(picker: P, option: Picks[P], consent?: ConsentToken | null) {
  const field = `${FIELD_PREFIX[picker]}_${option}` as Field;
  countFor(consentOrNow(consent), () => void counts[field]++);
}

export function noteShortcutsKeywordFind(consent?: ConsentToken | null) {
  countFor(consentOrNow(consent), () => void counts.shortcuts_keyword_finds++);
}

export function takeSettingsPickerCounts() {
  const taken = counts;
  counts = { ...ZERO };
  return taken;
}
