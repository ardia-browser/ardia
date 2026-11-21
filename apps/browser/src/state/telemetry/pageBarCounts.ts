import { HOST_ACTION_NAMES, type HostAction } from "../../lib/pluginPageBar";
import { consentOrNow, countFor } from "./countFor";

const SHOWN = { official: "plugin_page_bar_shown_official", other: "plugin_page_bar_shown_other" } as const;
const SWITCHED = { on: "plugin_site_switch_on", off: "plugin_site_switch_off" } as const;
const AUTO_ON_TYPED = "plugin_site_switch_auto_on_typed";
const SUPERSEDED = "plugin_page_bar_superseded";
const pressField = (action: HostAction) => `plugin_page_bar_press_${action.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`)}`;

const FIELDS = [...Object.values(SHOWN), ...HOST_ACTION_NAMES.map(pressField), ...Object.values(SWITCHED), AUTO_ON_TYPED, SUPERSEDED];

let counts: Record<string, number> = {};
const bump = (field: string) => countFor(consentOrNow(undefined), () => void (counts[field] = (counts[field] ?? 0) + 1));

export const notePageBarShown = (official: boolean) => bump(SHOWN[official ? "official" : "other"]);
export const notePageBarSuperseded = () => bump(SUPERSEDED);
export const notePageBarPress = (action: HostAction) => bump(pressField(action));
export const noteSiteSwitch = (on: boolean) => bump(SWITCHED[on ? "on" : "off"]);
export const noteSiteSwitchTypedOn = () => bump(AUTO_ON_TYPED);

export function takePageBarCounts(): Record<string, number> {
  const taken = Object.fromEntries(FIELDS.map((field) => [field, counts[field] ?? 0]));
  counts = {};
  return taken;
}
