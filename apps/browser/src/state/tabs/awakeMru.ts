import type { BrowserState } from "../browser/store";
import { viewTabIds } from "../browser/model";
import { hasPage } from "./pageSession";
import { isSleeping } from "./sleepingTabs";

export function lastAwakeTab(s: BrowserState, windowId: string, profileId: string, excluded: ReadonlySet<string>, openerId?: string | null): string | undefined {
  let best: string | undefined;
  let unseen: string | undefined;
  for (const id of viewTabIds(s, windowId, profileId)) {
    const tab = s.tabs[id]!;
    if (excluded.has(id) || !tab.url || tab.url === "about:blank" || !hasPage(tab) || isSleeping(id)) continue;
    if (tab.unseen) {
      if (!unseen || tab.createdAt > s.tabs[unseen]!.createdAt) unseen = id;
    } else if (!best || tab.lastActiveAt > s.tabs[best]!.lastActiveAt ||
      (id === openerId && tab.lastActiveAt === s.tabs[best]!.lastActiveAt)) best = id;
  }
  return best ?? unseen;
}
