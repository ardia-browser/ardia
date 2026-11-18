import { useBrowser } from "../browser/store";
import { movingTabIds, resolveDrop, type DragSource, type DropSpot } from "../drag/drops";
import { descendantIds } from "../groups/groups";
import { cleanUpCandidates } from "../pins/tabCleanup";
import { sharedTabsIn, sharesTabs } from "../tabs/tabShare";
import { addressBarInSidebar } from "../windows/layout";
import { splitsOnRow } from "../splits/lanes";
import { movableToProfile } from "../windows/profileMoves";

const store = () => useBrowser.getState();

export const isAddressBarInSidebar = (windowId: string) => addressBarInSidebar(store(), windowId);

export const movingTabsFrom = (lead: string) => movingTabIds(store(), lead);

export const descendantGroupIds = (groupId: string) => descendantIds(store().groups, groupId);

export const resolveDropNow = (source: DragSource, spot: DropSpot | null) => resolveDrop(store(), source, spot);

export const splitsOnRowNow = (tabId: string, rowTabId: string) => splitsOnRow(store(), tabId, rowTabId);

export const tabsMovableTo = (tabIds: string[], profileId: string) => movableToProfile(store(), tabIds, profileId);

export const cleanUpCandidateCount = (windowId: string) => cleanUpCandidates(store(), windowId).length;

export function sharedTabsForPanel(windowId: string) {
  const s = store();
  return sharesTabs(s) ? sharedTabsIn(s.tabs, windowId) : null;
}
