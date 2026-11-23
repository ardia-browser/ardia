import { useBrowser } from "../browser/store";
import { activeTabId } from "../browser/model";
import { revealTargets, type RevealTargets } from "./revealTargets";
import { useLive } from "../live/store";
import { knownFaviconTheme, resolveFavicon } from "../favicons/favicons";
import { iconMarks } from "./rowState";
import { watchTabState } from "../tabs/tabStateWatch";
import { watchFaviconOf, watchFaviconTheme } from "../favicons/faviconHooks";
import { fieldWatch, watchWindowRecord } from "../browser/keyedWatch";
import { groupOf } from "../pins/tabGrouping";

const asked = new Map<string, Set<(tabId: string) => void>>();

export const revealTab = (windowId: string, tabId: string) => asked.get(windowId)?.forEach((reveal) => reveal(tabId));

export function watchRevealTargets(windowId: string, found: (targets: RevealTargets, viaPill: boolean) => void) {
  const ask = (tabId: string) => found({ switched: tabId, opened: null }, true);
  const askers = asked.get(windowId) ?? new Set();
  asked.set(windowId, askers.add(ask));
  const unsubscribe = watchStoreTargets(windowId, found);
  return () => {
    unsubscribe();
    askers.delete(ask);
    if (!askers.size) asked.delete(windowId);
  };
}

const watchStoreTargets = (windowId: string, found: (targets: RevealTargets, viaPill: boolean) => void) =>
  useBrowser.subscribeTo(["windows", "tabs"], (s, prev) => {
    if (s.windows === prev.windows && s.tabs === prev.tabs) return;
    const targets = revealTargets(s, prev, windowId);
    if (targets.switched || targets.opened) found(targets, false);
  });

export const selectedTabIn = (windowId: string) => activeTabId(useBrowser.getState(), windowId);

export const windowProfileIn = (windowId: string) => useBrowser.getState().windows[windowId]?.profileId;

export const inShownProfile = (windowId: string, tabId: string) => {
  const s = useBrowser.getState();
  return !!s.tabs[tabId] && s.tabs[tabId]!.profileId === s.windows[windowId]?.profileId;
};

export const showsProfile = (windowId: string, profileId: string) => useBrowser.getState().windows[windowId]?.profileId === profileId;

export type PillTab = { id: string; url: string; favicon: string | null; icon: string | null; profileId: string; faviconUri: string | null; template: boolean; marks: number };

export function selectedTabSnapshot(windowId: string): PillTab | null {
  const s = useBrowser.getState();
  const id = activeTabId(s, windowId);
  const tab = id ? s.tabs[id] : undefined;
  if (!id || !tab) return null;
  const faviconUri = resolveFavicon(tab.url, tab.favicon, tab.profileId)?.uri ?? null;
  const theme = faviconUri ? knownFaviconTheme(faviconUri) : null;
  return { id, url: tab.url, favicon: tab.favicon ?? null, icon: tab.customIcon ?? null, profileId: tab.profileId, faviconUri, template: theme?.kind === "template" && !!theme.stroke, marks: iconMarks(s, id) };
}

export const samePillTab = (a: PillTab, b: PillTab) =>
  a.id === b.id &&
  a.url === b.url &&
  a.favicon === b.favicon &&
  a.icon === b.icon &&
  a.profileId === b.profileId &&
  a.faviconUri === b.faviconUri &&
  a.template === b.template &&
  a.marks === b.marks;

export function watchPillTab(tab: PillTab, changed: () => void): () => void {
  const offs = [watchTabState(tab.id, changed), watchFaviconOf(tab.url, tab.favicon, changed)];
  if (tab.faviconUri) offs.push(watchFaviconTheme(tab.faviconUri, changed));
  return () => offs.forEach((off) => off());
}

export type SelectedPlace = { id: string | null; index: number; group: string | null };

export function selectedPlaceIn(windowId: string): SelectedPlace {
  const s = useBrowser.getState();
  const id = activeTabId(s, windowId) ?? null;
  return { id, index: id ? (s.windows[windowId]?.tabIds.indexOf(id) ?? -1) : -1, group: id ? (groupOf(s, id)?.id ?? null) : null };
}

export const movedInPlace = (was: SelectedPlace, now: SelectedPlace) =>
  !!now.id && now.id === was.id && (now.index !== was.index || now.group !== was.group);

const watchGroups = fieldWatch(() => useBrowser, (s) => s.groups);

export function watchSelectedPlace(windowId: string, changed: () => void): () => void {
  const offWindow = watchWindowRecord(windowId, changed);
  const offGroups = watchGroups(windowId, changed);
  return () => {
    offWindow();
    offGroups();
  };
}

export type RowsStamp = readonly unknown[];

export function rowsStamp(): RowsStamp {
  const s = useBrowser.getState();
  const l = useLive.getState();
  return [s.windows, s.groups, s.tabs, l.folderOrder, l.folders];
}

export const sameRows = (a: RowsStamp | null, b: RowsStamp) => !!a && a.length === b.length && a.every((x, i) => x === b[i]);
