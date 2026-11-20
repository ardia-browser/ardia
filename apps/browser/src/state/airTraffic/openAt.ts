import { pinKeyOf } from "../browser/model";
import { focus, openWindow } from "../browser/actions";
import { useBrowser } from "../browser/store";
import { noteAirTrafficLink } from "../telemetry/airTrafficCounts";
import type { ConsentToken } from "../telemetry/client";
import { groupWindow } from "./groups";

const store = () => useBrowser.getState();

export function openInRouteGroup(url: string, profileId: string, groupKey: string, consent?: ConsentToken | null): void {
  const s = store();
  const home = groupWindow(s, profileId, groupKey);
  const target = home ?? openWindow({ url, profileId });
  const tabId = home ? s.newTab(home, { url, profileId, gated: true }) : (store().windows[target]?.activeTabIds[profileId] ?? "");
  if (tabId && joinGroup(tabId, profileId, groupKey)) noteAirTrafficLink("group", consent);
  focus(target);
}

function joinGroup(tabId: string, profileId: string, groupKey: string): boolean {
  const s = store();
  const tab = s.tabs[tabId];
  const group = tab && Object.values(s.groups).find((g) => g.windowId === tab.windowId && g.profileId === profileId && pinKeyOf(g) === groupKey);
  if (!group) return false;
  s.addTabsToGroup(group.id, [tabId]);
  if (group.collapsed) store().updateGroup(group.id, { collapsed: false });
  return true;
}
