import type { BrowserState } from "../browser/store";
import { isPinnedRow } from "../browser/model";
import type { Tab } from "../browser/types";

export type SplitLane = "row" | "list" | "tile";

export const splitLane = (t: Pick<Tab, "pin">): SplitLane => (!t.pin ? "list" : isPinnedRow(t) ? "row" : "tile");

export function crossesLane(anchor: Pick<Tab, "pin">, t: Pick<Tab, "pin">): boolean {
  const lane = splitLane(anchor);
  const own = splitLane(t);
  return lane !== "tile" && own !== "tile" && own !== lane;
}

export function splitsOnRow(s: Pick<BrowserState, "tabs">, tabId: string, rowTabId: string): boolean {
  const tab = s.tabs[tabId];
  const row = s.tabs[rowTabId];
  return !!tab && !!row && tab.id !== row.id && tab.windowId === row.windowId && tab.profileId === row.profileId && (splitLane(tab) === "tile") === (splitLane(row) === "tile");
}
