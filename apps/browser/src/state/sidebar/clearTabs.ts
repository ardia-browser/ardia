import { closeTab } from "../browser/actions";
import { useBrowser } from "../browser/store";
import { plural } from "../browser/model";
import { cleanedTabsFor } from "../pins/closedTabs";
import { canUndoClear, clearedTabIds, type ClearedTabs } from "../pins/clearedTabs";
import { live } from "../live/store";
import { noteCleanUp, noteClearClosedSelectedTab } from "../telemetry/usage";
import { duplicateTabIds } from "../pins/duplicateTabs";
import { noteDuplicateTabsClosed, noteDuplicateTabsUndo } from "../telemetry/tidyTabsCounts";
import { showUndoToast } from "./undoToast";
import { userClose, type ByUser } from "../tabs/closeActivation";

const store = () => useBrowser.getState();

export function closeAllTabs(windowId: string, user?: ByUser) {
  const cleared = store().clearUnpinnedTabs(windowId, user ? userClose(clearedTabIds(store(), windowId), user) : {});
  const count = (cleared?.entries.length ?? 0) + (cleared?.blankPanes?.length ?? 0);
  if (!cleared || !count) return;
  if (cleared.selectedTabId) noteClearClosedSelectedTab(user?.consent);
  showClearUndo(cleared, `Cleared ${plural(count, "Tab")}`, "arrow.down");
}

export function closeDuplicateTabs(windowId: string, user?: ByUser) {
  const closed = store().closeDuplicateTabs(windowId, user ? userClose(duplicateTabIds(store(), windowId), user) : {});
  if (!closed?.entries.length) return;
  noteDuplicateTabsClosed(closed.entries.length, user?.consent);
  showClearUndo(closed, `Closed ${plural(closed.entries.length, "Duplicate Tab")}`, "square.on.square", () => noteDuplicateTabsUndo(user?.consent));
}

export function cleanUpWithUndo(windowId: string) {
  const before = new Set(cleanedTabsFor(store(), windowId).map((c) => c.id));
  if (!store().cleanUpTabs(windowId)) return;
  const cleanedIds = cleanedTabsFor(store(), windowId).map((c) => c.id).filter((id) => !before.has(id));
  showUndoToast(windowId, `Cleaned Up ${plural(cleanedIds.length, "Tab")}`, "wand.and.stars", {
    undo: () => {
      noteCleanUp("undone");
      store().restoreCleaned(cleanedIds, windowId);
    },
    watched: (s) => [s.cleanedTabs, s.privateCleanedTabs],
    canUndo: (s) => {
      const left = new Set(cleanedTabsFor(s, windowId).map((c) => c.id));
      return cleanedIds.every((id) => left.has(id));
    },
  });
}

export function middleClickTab(tabId: string, user: ByUser) {
  const removed = store().removeClosedPin(tabId);
  if (!removed) return void closeTab(tabId, { user });
  if (removed.entries.length) showClearUndo(removed, "Removed Pinned Tab", "pin.slash");
}

const showClearUndo = (cleared: ClearedTabs, title: string, icon: string, onUndo?: () => void) =>
  showUndoToast(cleared.windowId, title, icon, {
    undo: () => {
      store().undoClearTabs(cleared, (folderId) => !!live().folders[folderId]);
      onUndo?.();
    },
    watched: (s) => [s.windows[cleared.windowId], s.tabs, s.groups, s.splits, s.closedTabs],
    canUndo: (s) => canUndoClear(s, cleared),
  });
