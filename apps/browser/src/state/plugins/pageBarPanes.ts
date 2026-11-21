import { useLayoutEffect, useMemo } from "react";
import { create } from "zustand";
import { useShallow } from "zustand/react/shallow";
import { useBrowser } from "../browser/store";
import { isIncognitoProfile } from "../browser/model";
import { isPeekTab } from "../peek/peek";
import { notePageBarShown, notePageBarSuperseded } from "../telemetry/pageBarCounts";
import { pageBarFor, sameMatch, type PageBarMatch, type PageBarPane } from "./pageBar";
import { usePageDocuments } from "./pageBarDocuments";
import { usePlugins } from "./store";
import { usePages } from "../tabs/pageState";

export type PageBars = Record<string, PageBarMatch>;

export const usePageBarPanes = create<Record<string, PageBars>>()(() => ({}));

export type PaneLayoutFacts = Pick<PageBarPane, "tabId" | "visible" | "lingering" | "warm" | "covered" | "mounted" | "documentFullscreen">;

const countedDocuments = new Map<string, string>();

function countShown(bars: PageBars) {
  for (const [tabId, match] of Object.entries(bars)) {
    const key = match.at > 0 ? `${match.at}|${match.plugin}` : `${match.url}|${match.plugin}`;
    if (countedDocuments.get(tabId) === key) continue;
    countedDocuments.set(tabId, key);
    notePageBarShown(match.official);
    if (match.superseded > 0) notePageBarSuperseded();
  }
}

const sameBars = (a: PageBars | undefined, b: PageBars): boolean => {
  const keys = Object.keys(b);
  return !!a && Object.keys(a).length === keys.length && keys.every((k) => sameMatch(a[k], b[k]));
};

export function publishPageBars(windowId: string, bars: PageBars) {
  countShown(bars);
  if (sameBars(usePageBarPanes.getState()[windowId], bars)) return;
  usePageBarPanes.setState({ [windowId]: bars });
}

export function withdrawPageBars(windowId: string) {
  usePageBarPanes.setState((s) => {
    const next = { ...s };
    delete next[windowId];
    return next;
  }, true);
}

const NO_BARS: PageBars = {};

export function watchPublishedPageBars(windowId: string, onBars: (bars: PageBars) => void): () => void {
  const read = () => onBars(usePageBarPanes.getState()[windowId] ?? NO_BARS);
  read();
  return usePageBarPanes.subscribe(read);
}

export const publishedPageBar = (windowId: string, tabId: string): PageBarMatch | null => usePageBarPanes.getState()[windowId]?.[tabId] ?? null;

const tabFacts = (windowId: string, ids: string[]) => (s: ReturnType<typeof useBrowser.getState>) => {
  const profile = s.windows[windowId]?.profileId ?? "";
  return ids.flatMap((id) => {
    const t = s.tabs[id];
    if (!t) return [false, false, false, false, false];
    return [t.page.kind === "loaded" || t.page.kind === "adopted", t.page.kind === "frozen", isPeekTab(s, id), t.profileId !== profile, isIncognitoProfile(t.profileId)];
  });
};

export function usePageBars(windowId: string, panes: PaneLayoutFacts[], window: { small: boolean; fullscreen: boolean }): PageBars {
  const ids = panes.map((p) => p.tabId);
  const facts = useBrowser(useShallow(tabFacts(windowId, ids)));
  const plugins = usePlugins(useShallow((s) => ({ listings: s.listings, records: s.records, order: s.order })));
  const newTab = usePages(useShallow((p) => ids.map((id) => !!p.pages[id]?.newTabShown)));
  const docs = usePageDocuments(useShallow((d) => ids.map((id) => (Object.hasOwn(d, id) ? d[id] : undefined))));
  const bars = useMemo(() => {
    const out: PageBars = {};
    const documents = Object.fromEntries(ids.flatMap((id, i) => (docs[i] ? [[id, docs[i]!]] : [])));
    panes.forEach((p, i) => {
      const [live, frozen, peek, otherProfile, privatePage] = facts.slice(i * 5, i * 5 + 5) as boolean[];
      const match = pageBarFor({ plugins, documents }, { ...p, live: !!live, frozen: !!frozen, peek: !!peek, otherProfile: !!otherProfile, privatePage: !!privatePage, newTabShown: newTab[i]!, small: window.small, windowFullscreen: window.fullscreen });
      if (match) out[p.tabId] = match;
    });
    return out;
  }, [JSON.stringify(panes), facts, newTab, plugins, docs, window.small, window.fullscreen]);
  useLayoutEffect(() => publishPageBars(windowId, bars), [windowId, bars]);
  useLayoutEffect(() => () => withdrawPageBars(windowId), [windowId]);
  return bars;
}
