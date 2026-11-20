import { useBrowser } from "../browser/store";
import { activeTabId } from "../browser/model";
import { revealTargets, type RevealTargets } from "./revealTargets";
import { useLive } from "../live/store";
import { knownFaviconTheme, resolveFavicon } from "../favicons/favicons";
import { iconMarks } from "./rowState";

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

export type RowsStamp = readonly unknown[];

export function rowsStamp(): RowsStamp {
  const s = useBrowser.getState();
  const l = useLive.getState();
  return [s.windows, s.groups, s.tabs, l.folderOrder, l.folders];
}

export const sameRows = (a: RowsStamp | null, b: RowsStamp) => !!a && a.length === b.length && a.every((x, i) => x === b[i]);
