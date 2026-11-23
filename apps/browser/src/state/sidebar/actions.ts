import { foreignWriteHooks } from "../browser/foreignWriteHooks";
import { cleanUrlReport, linkLines, markdownLink } from "@ardia/core";
import { copyLink } from "../../platform/clipboard";
import { prompt } from "../../platform/dialogs";
import { updateFolder } from "../live/store";
import { useBrowser } from "../browser/store";
import { webviews } from "../../platform/webviews";
import { focusHeroBar } from "../omnibox/barState";
import { ancestorIds } from "../groups/groups";
import { activeTabId, bookmarkProfileId, familyKeyOf, inPinnedContainer, ownTabTitle, pinSection, tabLayoutOf, tabsShownIn, tabTitle } from "../browser/model";
import { anchorOutdated, type ClickMods } from "../drag/drops";
import { selectedTabIds } from "../pins/organize";
import { groupLabel, groupOf } from "../pins/tabGrouping";
import type { Tab } from "../browser/types";
import { awaitsFirstPage } from "../tabs/pendingAddress";
import { noteUrlCopied } from "../telemetry/urlCopies";
import { noteRangeSelect, noteTileDoubleClick, type TileDoubleClick } from "../telemetry/tabPresses";
import { samePage } from "../../lib/url";
import { liveOf, shownLiveOf } from "../tabs/tabLive";
import { withLivePage } from "../tabs/livePage";
import { consentToken, type ConsentToken } from "../telemetry/client";
import { holderOfPage } from "../tabs/pageSession";
import { holderOf } from "../pins/pinShare";
import { pinHandOffOf } from "../pins/pinHandoff";
import { noteTextOnlyRow } from "../telemetry/tabStripCounts";
import { NO_ROW_ICON } from "../pins/rowIcons";
import type { BookmarkFolderChoice } from "./menuParts";
import { DEFAULT_SIDEBAR_WIDTH } from "../../lib/windowLayout";
import { activeLook } from "../../lib/activeLook";
import { measureRow, setSidebarUi, sidebarUi, type Target } from "./sidebarUi";

const store = () => useBrowser.getState();

export function clickTab(windowId: string, tabId: string, mods: ClickMods = {}) {
  const ranging = !!mods.shiftKey && !mods.metaKey;
  const fromShownTab = ranging && anchorOutdated(store(), windowId);
  store().clickTab(windowId, tabId, mods);
  if (ranging && store().selection[windowId]?.length) noteRangeSelect(fromShownTab);
}

export const resetSidebarWidth = () => store().updateSettings({ sidebarWidth: activeLook().sidebarWidth ?? DEFAULT_SIDEBAR_WIDTH });

export function returnFocusToPage(windowId: string) {
  const s = store();
  const active = activeTabId(s, windowId);
  if (!active) return;
  if (s.tabs[active]?.url) void webviews.get(active)?.focus();
  else focusHeroBar(windowId, active);
}

export function toggleBookmarkInWindow(windowId: string, page: { url: string; title: string; favicon: string | null }) {
  const s = store();
  s.toggleBookmark(bookmarkProfileId(s, s.windows[windowId]), page);
}

const PIN_ARRIVAL_DEADLINE_MS = 3000;

export function refreshShownTile(windowId: string, tabId: string, wasShown: boolean) {
  const s = store();
  const tab = s.tabs[tabId];
  if (!tab || tab.windowId !== windowId) return;
  const consent = consentToken();
  if (holderOf(s, tabId)) return void whenPinLands(windowId, familyKeyOf(tab)).then((landed) => landed && refreshShownPage(windowId, landed, false, consent));
  if (activeTabId(s, windowId) === tabId) refreshShownPage(windowId, tabId, wasShown, consent);
}

function whenPinLands(windowId: string, family: string): Promise<string | null> {
  const flight = pinHandOffOf(family);
  if (!flight) return Promise.resolve(null);
  const before = activeTabId(store(), windowId);
  return new Promise((done) => {
    let settled = false;
    let stop = () => {};
    const finish = (landed: string | null) => {
      if (settled) return;
      settled = true;
      stop();
      clearTimeout(deadline);
      done(landed);
    };
    const deadline = setTimeout(() => finish(null), PIN_ARRIVAL_DEADLINE_MS);
    stop = useBrowser.subscribe((now) => {
      const shown = activeTabId(now, windowId);
      const tab = shown ? now.tabs[shown] : undefined;
      if (shown && tab && familyKeyOf(tab) === family && !holderOfPage(tab)) finish(shown);
      else if (shown !== before) finish(null);
    });
    void flight.then((landed) => landed || finish(null));
  });
}

function refreshShownPage(windowId: string, tabId: string, wasShown: boolean, consent: ConsentToken | null) {
  const s = store();
  const tab = s.tabs[tabId];
  if (!tab || activeTabId(s, windowId) !== tabId) return;
  if (tab.pinnedUrl && !samePage(tab.url, tab.pinnedUrl)) {
    noteTileDoubleClick("return", consent);
    return s.returnToPinnedUrl(tabId);
  }
  if (!wasShown || !tab.url || shownLiveOf(s, tabId).isLoading) return noteTileDoubleClick("fresh", consent);
  const outcome = (what: TileDoubleClick) => noteTileDoubleClick(what, consent);
  void withLivePage(tabId, (page, pageId) => {
    if (liveOf(pageId).isLoading) return outcome("fresh");
    return Promise.resolve()
      .then(() => page.reload())
      .then(
        () => outcome("reload"),
        () => outcome("missed"),
      );
  }).then((reached) => reached || outcome("missed"));
}

export async function startRename(windowId: string, target: Target) {
  const s = store();
  if (target.kind === "tab") {
    const tab = s.tabs[target.id];
    if (!tab) return;
    if (pinSection(tab) === "tile") {
      const name = await prompt({
        title: "Rename Tab",
        value: tab.customTitle ?? tab.title,
        placeholder: tab.title || "Tab name",
        confirmTitle: "Update",
        windowId,
      });
      if (name !== null) foreignWriteHooks.around(() => store().updateTab(tab.id, { customTitle: name }));
      return;
    }
    const group = groupOf(s, tab.id);
    if (group && activeTabId(s, windowId) !== tab.id) {
      for (const id of [group.id, ...ancestorIds(s.groups, group.id)]) if (s.groups[id]!.collapsed) s.updateGroup(id, { collapsed: false });
    }
  }
  if (target.kind === "group" && !sidebarShows(windowId)) return renameGroupInSheet(windowId, target.id);
  setSidebarUi({ renaming: { windowId, ...target } });
}

const sidebarShows = (windowId: string) => tabLayoutOf(store(), windowId) === "sidebar" && !!store().windows[windowId] && tabsShownIn(store(), windowId);

async function renameGroupInSheet(windowId: string, groupId: string) {
  const g = store().groups[groupId];
  if (!g) return;
  const name = await prompt({
    title: "Rename Group",
    value: g.name,
    placeholder: groupLabel(store(), g),
    confirmTitle: "Update",
    windowId,
  });
  if (name !== null && store().groups[groupId]) foreignWriteHooks.around(() => store().updateGroup(groupId, { name: name.trim() }));
}

export function commitRename(target: Target, text: string) {
  const name = text.trim();
  if (target.kind === "tab") {
    const tab = store().tabs[target.id];
    if (tab) store().updateTab(tab.id, { customTitle: name && name !== tab.title ? name : null });
  } else store().updateGroup(target.id, { name });
  endRename(target);
}

export function endRename(target: Target) {
  const r = sidebarUi().renaming;
  if (r && r.id === target.id) setSidebarUi({ renaming: null });
}

export async function openIconPicker(windowId: string, target: Target) {
  const anchor = await measureRow(windowId, target.id);
  setSidebarUi({ iconPicker: { windowId, ...target, anchor }, hover: null });
}

export function setIcon(target: Target, icon: string | null) {
  if (target.kind === "tab" && icon === NO_ROW_ICON) noteTextOnlyRow();
  if (target.kind === "tab") store().updateTab(target.id, { customIcon: icon });
  else if (target.kind === "live") updateFolder(target.id.split("|")[1] ?? "", { icon });
  else store().updateGroup(target.id, { icon });
}

export function newGroupWithSelection(windowId: string, ids = selectedTabIds(store(), windowId)) {
  const groupId = store().groupTabs(ids.filter((id) => pinSection(store().tabs[id]) !== "tile"));
  if (groupId && sidebarShows(windowId)) void startRename(windowId, { kind: "group", id: groupId });
  return groupId;
}

export function copyUrls(ids: string[], markdown: boolean) {
  const tabs = ids.map((id) => store().tabs[id]).filter((t): t is Tab => !!t?.url);
  if (!tabs.length) return;
  const reports = tabs.map((t) => cleanUrlReport(t.url));
  const lines = tabs.map((t, i) => (markdown ? markdownLink(ownTabTitle(t), t.url) : reports[i]!.url));
  copyLink(linkLines(lines, markdown));
  tabs.forEach((t, i) => noteUrlCopied(awaitsFirstPage(t.id), reports[i]!.removedTracker));
}

export async function bookmarkTabs(windowId: string, ids: string[], folder: BookmarkFolderChoice) {
  const s = store();
  const profileId = bookmarkProfileId(s, s.windows[windowId]);
  let parentId = folder.kind === "folder" ? folder.parentId : undefined;
  if (folder.kind === "newFolder") {
    const title = await prompt({ title: "New Folder", placeholder: "Folder name", confirmTitle: "Create", windowId });
    if (!title) return;
    parentId = store().addBookmarkFolder({ profileId, title });
  }
  for (const id of ids) {
    const t = store().tabs[id];
    if (t?.url) store().addBookmark({ profileId, url: t.url, title: tabTitle(t), favicon: t.favicon, parentId });
  }
}

export async function editPinnedPage(windowId: string, tabId: string) {
  const tab = store().tabs[tabId];
  if (!tab || !inPinnedContainer(store(), tabId)) return;
  const url = await prompt({
    title: "Edit Pinned Page",
    value: tab.pinnedUrl ?? tab.url,
    placeholder: "Enter Pinned URL",
    confirmTitle: "Save",
    windowId,
  });
  if (url) store().setPinnedUrl(tabId, url.includes("://") ? url : `https://${url}`);
}
