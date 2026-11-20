import { useMemo, useSyncExternalStore } from "react";
import { usePages } from "../tabs/pageState";
import { useMedia } from "./media";

let shared = new Set<string>();
const watchers = new Map<string, Set<() => void>>();
let stopMedia: (() => void) | null = null;
let stopPages: (() => void) | null = null;

function sharedNow(): Set<string> {
  const pages = usePages.getState().pages;
  const next = new Set<string>();
  for (const [capturer, share] of Object.entries(useMedia.getState().tabShares)) if (pages[capturer]?.mediaAccess?.screen) next.add(share.capturedTabId);
  return next;
}

function refresh() {
  const next = sharedNow();
  const changed = [...next].filter((id) => !shared.has(id)).concat([...shared].filter((id) => !next.has(id)));
  shared = next;
  for (const id of changed) watchers.get(id)?.forEach((wake) => wake());
}

function followPages() {
  const sharing = Object.keys(useMedia.getState().tabShares).length > 0;
  if (sharing && !stopPages) stopPages = usePages.subscribe((p, prev) => p.pages !== prev.pages && refresh());
  else if (!sharing && stopPages) {
    stopPages();
    stopPages = null;
  }
}

function start() {
  shared = sharedNow();
  followPages();
  stopMedia = useMedia.subscribe((m, prev) => {
    if (m.tabShares === prev.tabShares) return;
    followPages();
    refresh();
  });
}

function stop() {
  stopMedia?.();
  stopPages?.();
  stopMedia = stopPages = null;
}

export function watchTabShared(tabId: string, wake: () => void): () => void {
  if (!watchers.size) start();
  let mine = watchers.get(tabId);
  if (!mine) watchers.set(tabId, (mine = new Set()));
  mine.add(wake);
  return () => {
    mine.delete(wake);
    if (!mine.size && watchers.get(tabId) === mine) watchers.delete(tabId);
    if (!watchers.size) stop();
  };
}

export const tabSharedNow = (tabId: string) => (watchers.size ? shared.has(tabId) : sharedNow().has(tabId));

export function useTabShared(tabId: string): boolean {
  const subscribe = useMemo(() => (wake: () => void) => watchTabShared(tabId, wake), [tabId]);
  return useSyncExternalStore(subscribe, () => tabSharedNow(tabId));
}
