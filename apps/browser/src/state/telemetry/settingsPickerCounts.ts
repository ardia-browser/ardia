import type { ConsentToken } from "./choice";
import { consentOrNow, countFor } from "./countFor";

type Picks = {
  ctrlTab: "step" | "switcher";
  addressBar: "sidebar" | "toolbar";
  commandBar: "field" | "centred";
  scrollToolbar: "keep" | "hide";
  afterClosingTab: "recent" | "above";
};

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
  ctrl_tab_follows_chrome_step: 0,
  ctrl_tab_follows_chrome_switcher: 0,
};

type Field = keyof typeof ZERO;

const FIELD_PREFIX: { [P in keyof Picks]: string } = {
  ctrlTab: "ctrl_tab_picks",
  addressBar: "address_bar_picks",
  commandBar: "command_bar_picks",
  scrollToolbar: "scroll_toolbar_picks",
  afterClosingTab: "after_closing_tab_picks",
};

let counts = { ...ZERO };

export function noteSettingsPick<P extends keyof Picks>(picker: P, option: Picks[P], consent?: ConsentToken | null) {
  const field = `${FIELD_PREFIX[picker]}_${option}` as Field;
  countFor(consentOrNow(consent), () => void counts[field]++);
}

export function noteCtrlTabFollowedChrome(option: Picks["ctrlTab"], consent?: ConsentToken | null) {
  countFor(consentOrNow(consent), () => void counts[`ctrl_tab_follows_chrome_${option}`]++);
}

export function takeSettingsPickerCounts() {
  const taken = counts;
  counts = { ...ZERO };
  return taken;
}
