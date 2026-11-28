import { sameList } from "../../lib/lists";
import { changedIds } from "../browser/changes";
import { activeTabId } from "../browser/model";
import { useBrowser, type BrowserState } from "../browser/store";
import { isAsleep } from "../tabs/pageSession";
import type { ConsentToken } from "../telemetry/choice";
import { consentToken } from "../telemetry/client";
import { noteLiveFolderTabsKept } from "../telemetry/usage";
import { live, setLive, useLive } from "./store";
import type { LiveFolder } from "./types";

type ShownTabs = Record<string, string[]>;
type Folders = Record<string, LiveFolder>;
type Before = { folders: Folders; s: BrowserState };

function activeIn(s: BrowserState, folder: LiveFolder): string[] {
  const ids: string[] = [];
  for (const windowId in s.windows) {
    const id = activeTabId(s, windowId, folder.profileId);
    if (id && s.tabs[id]?.liveItem?.folderId === folder.id) ids.push(id);
  }
  return ids;
}

function joined(s: BrowserState, before: BrowserState, folder: LiveFolder): string[] {
  if (s.tabs === before.tabs) return [];
  return changedIds(s.tabs, before.tabs).filter((id) => s.tabs[id]?.liveItem?.folderId === folder.id && before.tabs[id]?.liveItem?.folderId !== folder.id);
}

export function settleLiveShownTabs(shown: ShownTabs, folders: Folders, s: BrowserState, hidden: (folderId: string) => ReadonlySet<string>, before: Before = { folders, s }): ShownTabs {
  let next = shown;
  const put = (id: string, ids: string[]) => {
    if (next === shown) next = { ...shown };
    if (ids.length) next[id] = ids;
    else delete next[id];
  };
  for (const id in shown) if (!folders[id]?.collapsed) put(id, []);
  for (const folder of Object.values(folders)) {
    if (!folder.collapsed) continue;
    const startsOver = before.folders[folder.id]?.collapsed !== true;
    const active = activeIn(s, folder);
    const arrived = startsOver ? active : [...active.filter((id) => !activeIn(before.s, folder).includes(id)), ...joined(s, before.s, folder)];
    const gone = hidden(folder.id);
    const kept = (startsOver ? [] : (shown[folder.id] ?? [])).filter((tabId) => {
      const tab = s.tabs[tabId];
      return tab?.liveItem?.folderId === folder.id && !gone.has(tab.liveItem.itemId) && (active.includes(tabId) || !isAsleep(tab));
    });
    for (const tabId of arrived) if (!kept.includes(tabId)) kept.push(tabId);
    if (!sameList(kept, shown[folder.id] ?? [])) put(folder.id, kept);
  }
  return next;
}

function shownTabsAdded(next: ShownTabs, prev: ShownTabs): number {
  let added = 0;
  for (const id in next) if (next[id] !== prev[id]) for (const tabId of next[id]!) if (!prev[id]?.includes(tabId)) added++;
  return added;
}

const hiddenItems = (folderId: string): ReadonlySet<string> => new Set([...(live().hidden[folderId] ?? []), ...(live().repoHidden[folderId] ?? [])].map((it) => it.id));

function settle(consent: ConsentToken | null, before?: Before) {
  const was = live().shownTabs;
  const next = settleLiveShownTabs(was, live().folders, useBrowser.getState(), hiddenItems, before);
  if (next === was) return;
  setLive({ shownTabs: next });
  const added = shownTabsAdded(next, was);
  if (added) noteLiveFolderTabsKept(added, consent);
}

export function hideShownTabs(folderId: string, windowId: string) {
  const shown = live().shownTabs[folderId];
  if (!shown) return;
  const tabs = useBrowser.getState().tabs;
  const kept = shown.filter((id) => tabs[id]?.windowId !== windowId);
  setLive({ shownTabs: { ...live().shownTabs, [folderId]: kept } });
}

let started = false;

export function startLiveShownTabs() {
  if (started) return;
  started = true;
  useBrowser.subscribeTo(["windows", "tabs"], (s, prev) => settle(consentToken(), { folders: live().folders, s: prev }));
  useLive.subscribe((l, prev) => {
    if (l.folders !== prev.folders) settle(consentToken(), { folders: prev.folders, s: useBrowser.getState() });
    else if (l.hidden !== prev.hidden || l.repoHidden !== prev.repoHidden) settle(consentToken());
  });
}
