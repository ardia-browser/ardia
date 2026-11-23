import { chooseFromMenu, type ChoiceItem } from "../app/menuChoice";
import { moveTabsToProfile, switchToTab } from "../browser/actions";
import { useBrowser, type BrowserState } from "../browser/store";
import { inPinnedContainer, isIncognitoProfile, isPinnedRow, pinnedSectionTitle, pinSection, viewTabIds } from "../browser/model";
import { groupOf } from "../pins/tabGrouping";
import { innermostGroupOf } from "../groups/groupNesting";
import { withSplitRows } from "../splits/splits";
import { bookmarkTabs, copyUrls, newGroupWithSelection } from "./actions";
import { noteSelectionRemovedFromGroups } from "../telemetry/usage";
import { bookmarksShown } from "../bookmarks/visibility";
import { bookmarkFolderItems, groupItems, hintWhen, profileItems, sections, windowItems, withAlternate, type Destination } from "./menuParts";
import { userClose, type ByUser } from "../tabs/closeActivation";
import { selectedTabIds } from "../pins/organize";
import { consentToken } from "../telemetry/client";

const store = () => useBrowser.getState();

export function closeSelectionByKey(windowId: string, user: ByUser | undefined): number {
  const s = store();
  const ids = (s.selection[windowId]?.length ?? 0) > 1 ? selectedTabIds(s, windowId) : [];
  if (ids.length < 2) return 0;
  s.closeTabs(ids, user ? userClose(ids, user) : {});
  s.setSelection(windowId, []);
  return ids.length;
}

function multiTabMenuFacts(s: BrowserState, windowId: string, ids: string[]) {
  const tabs = ids.map((id) => s.tabs[id]!);
  const chosen = new Set(ids);
  return {
    tabs,
    allPinned: tabs.every((t) => t.pin),
    allTiles: tabs.every((t) => pinSection(t) === "tile"),
    incognito: tabs.some((t) => isIncognitoProfile(t.profileId)),
    others: viewTabIds(s, windowId).filter((id) => !chosen.has(id) && !inPinnedContainer(s, id)),
  };
}

type Facts = ReturnType<typeof multiTabMenuFacts>;

export function multiTabMenuItems(s: BrowserState, windowId: string, ids: string[], f: Facts = multiTabMenuFacts(s, windowId, ids)): ChoiceItem<Destination>[] {
  const n = ids.length;
  const groups = groupItems(s, windowId, undefined);
  const moveTo: ChoiceItem<Destination> = {
    id: "moveTo",
    title: "Move to",
    symbol: "arrow.up.forward.square",
    children: sections<ChoiceItem<Destination>>(
      [
        ...(f.allTiles ? [] : [{ id: "pinTiles", title: "Top Apps", symbol: "square.grid.2x2" }]),
        ...(!f.allPinned || f.tabs.every(isPinnedRow) ? [] : [{ id: "pinRows", title: pinnedSectionTitle(s, f.tabs[0]), symbol: "pin" }]),
      ],
      [
        ...(groups.length ? [{ id: "moveToGroup", title: "Group", symbol: "folder", children: groups }] : []),
        ...(f.tabs.some((t) => groupOf(s, t.id)) ? [{ id: "ungroup", title: "Remove from Group", symbol: "folder.badge.minus" }] : []),
      ],
      [
        { id: "moveToProfile", title: "Profile", symbol: "person", enabled: !f.incognito, children: profileItems(s, (id) => f.tabs.every((t) => t.profileId === id)) },
        { id: "moveToWindow", title: "Window", symbol: "macwindow", enabled: !f.incognito, children: windowItems(s, windowId) },
      ],
      bookmarksShown(s.settings) ? [{ id: "bookmarkTo", title: "Bookmarks Folder", symbol: "bookmark", children: bookmarkFolderItems(s, windowId) }] : [],
    ),
  };
  return sections<ChoiceItem<Destination>>(
    [
      ...withAlternate({ id: "copy", title: `Copy ${n} Links`, symbol: "link" }, { id: "copyMd", title: `Copy ${n} Links as Markdown`, symbol: "link" }, null),
      { id: "duplicate", title: `Duplicate ${n} Tabs`, symbol: "plus.square.on.square" },
    ],
    [
      f.allPinned ? { id: "unpin", title: `Unpin ${n} Tabs`, symbol: "pin.slash" } : { id: "pinRows", title: `Pin ${n} Tabs`, symbol: "pin" },
      { id: "newGroup", title: `New Group with ${n} Tabs`, symbol: "folder.badge.plus", enabled: !f.allTiles, ...hintWhen(!f.allTiles, "newGroupWithTabs", s) },
      moveTo,
    ],
    [
      { id: "close", title: `Close ${n} Tabs`, symbol: "xmark" },
      { id: "closeOthers", title: "Close Other Tabs", symbol: "xmark.square", enabled: f.others.length > 0 },
    ],
  );
}

function sendTabs(windowId: string, ids: string[], profileId: string, to: Destination) {
  if (to.kind === "group") store().placeTabs(ids, { pinned: false, groupId: to.groupId });
  else if (to.kind === "profile") void moveTabsToProfile(ids, to.profileId);
  else if (to.kind === "window") {
    const target = store().moveTabsToWindow(ids, to.windowId);
    if (target) switchToTab(store().windows[target]?.activeTabIds[profileId] ?? ids[0]!);
  } else void bookmarkTabs(windowId, ids, to);
}

export async function openMultiMenu(windowId: string, shown: string[]) {
  const consent = consentToken();
  const f = multiTabMenuFacts(store(), windowId, shown);
  const choice = await chooseFromMenu(multiTabMenuItems(store(), windowId, shown, f));
  const s = store();
  const here = (list: string[]) => list.filter((id) => s.tabs[id]?.windowId === windowId);
  const ids = here(shown);
  if (!choice || !ids.length) return;
  if (typeof choice !== "string") sendTabs(windowId, ids, f.tabs[0]!.profileId, choice);
  else if (choice === "unpin") s.pinTabs(ids, false);
  else if (choice === "pinTiles") s.pinTabs(ids, true, false);
  else if (choice === "pinRows") s.pinTabs(ids, true, true);
  else if (choice === "duplicate") ids.forEach((id) => store().duplicateTab(id));
  else if (choice === "newGroup") newGroupWithSelection(windowId, ids);
  else if (choice === "ungroup") {
    const leaving = withSplitRows(s, ids).filter((id) => innermostGroupOf(s.groups, id)).length;
    s.removeTabsFromGroup(ids);
    noteSelectionRemovedFromGroups(leaving, consent);
  } else if (choice === "copy") copyUrls(ids, false);
  else if (choice === "copyMd") copyUrls(ids, true);
  else if (choice === "close") s.closeTabs(ids, userClose(ids, { consent }));
  else if (choice === "closeOthers") s.closeTabs(here(f.others), userClose(here(f.others), { consent }));
  if (choice !== "copy" && choice !== "copyMd") store().setSelection(windowId, []);
}
