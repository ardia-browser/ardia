import { useTabs } from "../tabs/store";
import { selectedTab } from "../tabs/tabsState";
import { countUsage } from "../telemetry/telemetry";
import { useBrowse } from "./store";

export function browsingPrivately(): boolean {
  const state = useTabs.getState();
  return state.incognito || (useBrowse.getState().surface === "browsing" && selectedTab(state)?.isPrivate === true);
}

export function countNativeMenu(privately: boolean) {
  if (privately || browsingPrivately()) return;
  countUsage("native_menus_opened");
}

export function countDrawnMenu(privately: boolean) {
  if (privately || browsingPrivately()) return;
  countUsage("drawn_menus_opened");
}
