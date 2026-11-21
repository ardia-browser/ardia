import { changedIds } from "../browser/changes";
import { IDLE_LIVE, merge } from "../browser/model";
import type { BrowserState } from "../browser/store";
import type { Tab, TabLive } from "../browser/types";
import { frozenCopiesOf } from "../pins/pinShare";
import { hasPage, holderOfPage, isAsleep, navigationOf } from "./pageSession";

export type LiveListener = (tabId: string, live: TabLive, prev: TabLive) => void;
type Browser = { getState(): BrowserState; subscribe(listener: (s: BrowserState, prev: BrowserState) => void): () => void };

const values = new Map<string, TabLive>();
const watchers = new Map<string, Set<() => void>>();
const listeners = new Set<LiveListener>();
let browser: Browser | null = null;
let published: BrowserState | null = null;
const writtenUnpublished = new Set<string>();
const announced = new Map<string, TabLive>();
const unannounced = new Set<string>();
let draining = false;

export const liveOf = (tabId: string): TabLive => values.get(tabId) ?? IDLE_LIVE;

export const shownLiveOf = (s: Pick<BrowserState, "tabs">, tabId: string): TabLive => liveOf(holderOfPage(s.tabs[tabId]) ?? tabId);

export const liveReachOf = (s: Pick<BrowserState, "tabs">, tabId: string): string[] => [tabId, ...frozenCopiesOf(s, tabId).map((t) => t.id)];

function storeLive(tabId: string, next: TabLive) {
  if (next === IDLE_LIVE) values.delete(tabId);
  else values.set(tabId, next);
}

let firstFailure: { error: unknown } | null = null;

function heedFailure(callback: () => void) {
  try {
    callback();
  } catch (error) {
    firstFailure ??= { error };
  }
}

function announceLive(tabId: string, next: TabLive, prev: TabLive) {
  for (const id of browser ? liveReachOf(browser.getState(), tabId) : [tabId]) {
    const woken = watchers.get(id);
    if (woken) for (const listener of [...woken]) heedFailure(listener);
  }
  for (const listener of [...listeners]) heedFailure(() => listener(tabId, next, prev));
}

export function drainLive() {
  if (draining) return;
  draining = true;
  try {
    for (const tabId of unannounced) {
      unannounced.delete(tabId);
      const next = liveOf(tabId);
      const prev = announced.get(tabId) ?? IDLE_LIVE;
      if (next === prev) continue;
      if (next === IDLE_LIVE) announced.delete(tabId);
      else announced.set(tabId, next);
      announceLive(tabId, next, prev);
    }
  } finally {
    draining = false;
  }
  const failure = firstFailure;
  firstFailure = null;
  if (failure) throw failure.error;
}

function stageReplace(tabId: string, next: TabLive) {
  if (next === liveOf(tabId)) return;
  storeLive(tabId, next);
  unannounced.add(tabId);
}

export function replaceLive(tabId: string, next: TabLive) {
  stageReplace(tabId, next);
  drainLive();
}

export function stageLive(tabId: string, patch: Partial<TabLive>) {
  if (!browser?.getState().tabs[tabId]) return;
  const prev = liveOf(tabId);
  const next = merge(prev, patch);
  if (next === prev) return;
  storeLive(tabId, next);
  unannounced.add(tabId);
  if (!published?.tabs[tabId]) writtenUnpublished.add(tabId);
}

export function setLive(tabId: string, patch: Partial<TabLive>) {
  stageLive(tabId, patch);
  drainLive();
}

export function forgetLive(ids: Iterable<string>) {
  for (const id of ids) stageReplace(id, IDLE_LIVE);
  drainLive();
}

export const forgetAllLive = () => forgetLive([...values.keys()]);

const reloadedElsewhere = (tab: Tab, was: Tab) =>
  (tab.windowId !== was.windowId || tab.profileId !== was.profileId) && navigationOf(tab)?.seq !== navigationOf(was)?.seq;

function forgetUnpublished(s: BrowserState) {
  const gone = [...writtenUnpublished].filter((id) => !s.tabs[id]);
  writtenUnpublished.clear();
  return gone;
}

export function bindLiveToBrowser(store: Browser, afterTransactionIdempotent?: (listener: () => void) => unknown) {
  browser = store;
  published = store.getState();
  afterTransactionIdempotent?.(() => forgetLive(forgetUnpublished(store.getState())));
  store.subscribe((s, prev) => {
    published = s;
    const gone = forgetUnpublished(s);
    if (s.tabs === prev.tabs || !values.size) return forgetLive(gone);
    for (const id of changedIds(s.tabs, prev.tabs)) {
      const tab = s.tabs[id];
      const was = prev.tabs[id];
      const heldBy = holderOfPage(was);
      if (!tab || (isAsleep(tab) && !isAsleep(was)) || (was && reloadedElsewhere(tab, was))) gone.push(id);
      else if (heldBy && hasPage(tab)) stageReplace(id, liveOf(heldBy));
    }
    forgetLive(gone);
  });
}

export function watchLive(tabId: string, listener: () => void): () => void {
  let woken = watchers.get(tabId);
  if (!woken) watchers.set(tabId, (woken = new Set()));
  woken.add(listener);
  return () => {
    woken.delete(listener);
    if (!woken.size && watchers.get(tabId) === woken) watchers.delete(tabId);
  };
}

export function onLiveChange(listener: LiveListener): () => void {
  listeners.add(listener);
  return () => void listeners.delete(listener);
}
