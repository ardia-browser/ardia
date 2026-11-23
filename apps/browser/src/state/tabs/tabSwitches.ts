import type { BrowserState } from "../browser/store";
import type { FrontTabChange } from "../windows/frontTabs";

const switches = new Map<string, number>();

export function countSwitch(change: Pick<FrontTabChange, "after">, counts: Map<string, number> = switches) {
  if (change.after) counts.set(change.after, (counts.get(change.after) ?? 0) + 1);
}

export const switchesOf = (tabId: string) => switches.get(tabId) ?? 0;

export function forgetSwitchesExcept(tabs: BrowserState["tabs"]) {
  for (const id of switches.keys()) if (!tabs[id]) switches.delete(id);
}

export const clearSwitches = () => switches.clear();
