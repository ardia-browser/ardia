import { useBrowser } from "../browser/store";
import { movingTabIds, resolveDrop, type DragSource, type DropSpot } from "../drag/drops";
import { descendantIds } from "../groups/groups";
import { cleanUpCandidates } from "../pins/tabCleanup";
import { sharedTabsIn, sharesTabs } from "../tabs/tabShare";
import { addressBarInSidebar } from "../windows/layout";
import { splitsOnRow } from "../splits/lanes";
import { splitOf } from "../splits/splits";
import { isRegularWindow } from "../windows/small";
import { isIncognitoProfile } from "../browser/model";

const store = () => useBrowser.getState();

export const isAddressBarInSidebar = (windowId: string) => addressBarInSidebar(store(), windowId);

export const movingTabsFrom = (lead: string) => movingTabIds(store(), lead);

export const descendantGroupIds = (groupId: string) => descendantIds(store().groups, groupId);

export const resolveDropNow = (source: DragSource, spot: DropSpot | null) => resolveDrop(store(), source, spot);

export type DragHome = { windowId: string; profileId: string };

export function dragHomeOf(tabIds: string[]): DragHome | null {
  const s = store();
  const first = s.tabs[tabIds[0] ?? ""];
  const w = first && s.windows[first.windowId];
  if (!first || !isRegularWindow(w) || isIncognitoProfile(first.profileId) || s.profileOrder.length < 2) return null;
  return tabIds.every((id) => s.tabs[id]?.profileId === first.profileId && s.tabs[id]?.windowId === w.id) ? { windowId: w.id, profileId: first.profileId } : null;
}

export function profileBeside(profileId: string, step: -1 | 1): string | null {
  const order = store().profileOrder;
  const at = order.indexOf(profileId);
  return at < 0 ? null : (order[at + step] ?? null);
}

export const splitIdOfNow = (tabId: string) => splitOf(store(), tabId)?.id ?? null;

export const splitsOnRowNow = (tabId: string, rowTabId: string) => splitsOnRow(store(), tabId, rowTabId);

export const cleanUpCandidateCount = (windowId: string) => cleanUpCandidates(store(), windowId).length;

export function sharedTabsForPanel(windowId: string) {
  const s = store();
  return sharesTabs(s) ? sharedTabsIn(s.tabs, windowId) : null;
}
