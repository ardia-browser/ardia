import type { BrowserState } from "../browser/store";

type Fronts = Pick<BrowserState, "windows" | "tabs">;

const switches = new Map<string, number>();

const frontOf = (s: Fronts, windowId: string) => {
  const w = s.windows[windowId];
  const id = w?.activeTabIds[w.profileId];
  return id && s.tabs[id]?.windowId === windowId ? id : undefined;
};

export function countSwitches(prev: Fronts, next: Fronts, counts: Map<string, number> = switches) {
  if (prev.windows === next.windows) return;
  for (const windowId of Object.keys(next.windows)) {
    const front = frontOf(next, windowId);
    if (front && front !== frontOf(prev, windowId)) counts.set(front, (counts.get(front) ?? 0) + 1);
  }
}

export const switchesOf = (tabId: string) => switches.get(tabId) ?? 0;

export function forgetSwitchesExcept(tabs: BrowserState["tabs"]) {
  for (const id of switches.keys()) if (!tabs[id]) switches.delete(id);
}

export const clearSwitches = () => switches.clear();
