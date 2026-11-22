import { afterStoreTransactionIdempotent, inStoreTransaction, useBrowser, type BrowserState } from "../browser/store";
import { activeTabId, isIncognitoProfile } from "../browser/model";
import { usePages } from "../tabs/pageState";
import { changedIds } from "../browser/changes";
import { holderOfPage } from "../tabs/pageSession";
import { liveReachOf, onLiveChange, shownLiveOf } from "../tabs/tabLive";
import { focusedWindowOf } from "../windows/ui";
import { eligibleKind, isEligibleTab, shownPage } from "./automationWindows";
import type { AutomationEventName } from "./eventNames";
import { LIBRARY_EVENTS, startLibraryEvents } from "./libraryEvents";

export type EventSend = (name: AutomationEventName, data: Record<string, unknown>) => void;

const IDLE_SCAN_MS = 30_000;

function tabData(s: BrowserState, tabId: string) {
  const t = s.tabs[tabId]!;
  return { windowId: t.windowId, tabId, profile: t.profileId, ...shownPage(t) };
}

function peekData(s: BrowserState, sourceId: string) {
  const peek = s.peeks[sourceId]!;
  const t = s.tabs[peek.tabId];
  if (!t || !eligibleKind(s, t.windowId) || isIncognitoProfile(t.profileId)) return null;
  return { windowId: t.windowId, tabId: peek.tabId, profile: t.profileId, sourceTabId: peek.sourceId, ...shownPage(t) };
}

const splitTabs = (s: BrowserState, id: string) => s.splits[id]!.slots.flatMap((slot) => ("tabId" in slot ? [slot.tabId] : slot.stack));

export function diffMore(s: BrowserState, prev: BrowserState, send: EventSend, wants: ReadonlySet<string>) {
  if (s.windows !== prev.windows) {
    for (const id in s.windows) {
      const w = s.windows[id]!;
      const before = prev.windows[id];
      if (wants.has("littleArdia.opened") && !before && eligibleKind(s, id) === "little") {
        const tabId = activeTabId(s, id);
        send("littleArdia.opened", { windowId: id, profile: w.profileId, ...(tabId && isEligibleTab(s, tabId) ? { tabId, ...shownPage(s.tabs[tabId]!) } : {}) });
      }
      if (wants.has("profile.switched") && before && before.profileId !== w.profileId && eligibleKind(s, id) && eligibleKind(prev, id)) {
        send("profile.switched", { windowId: id, from: before.profileId, profile: w.profileId, profileName: s.profiles[w.profileId]?.name ?? "" });
      }
    }
  }
  if (s.peeks !== prev.peeks) {
    for (const id in s.peeks) if (wants.has("peek.opened") && s.peeks[id]!.tabId !== prev.peeks[id]?.tabId) {
      const data = peekData(s, id);
      if (data) send("peek.opened", data);
    }
    for (const id in prev.peeks) if (wants.has("peek.closed") && s.peeks[id]?.tabId !== prev.peeks[id]!.tabId) {
      const data = peekData(prev, id);
      if (data) send("peek.closed", { ...data, keptAsTab: isEligibleTab(s, prev.peeks[id]!.tabId) });
    }
  }
  if (s.splits !== prev.splits) {
    for (const id in s.splits) if (wants.has("split.created") && !prev.splits[id] && eligibleKind(s, s.splits[id]!.windowId)) {
      send("split.created", { windowId: s.splits[id]!.windowId, splitId: id, tabIds: splitTabs(s, id).filter((t) => isEligibleTab(s, t)) });
    }
    for (const id in prev.splits) if (wants.has("split.closed") && !s.splits[id] && eligibleKind(prev, prev.splits[id]!.windowId)) {
      send("split.closed", { windowId: prev.splits[id]!.windowId, splitId: id });
    }
  }
  if (s.tabs !== prev.tabs) {
    for (const id in s.tabs) {
      const t = s.tabs[id]!;
      const before = prev.tabs[id];
      if (!before || before === t || !isEligibleTab(s, id) || !isEligibleTab(prev, id)) continue;
      if (before.windowId !== t.windowId && wants.has("tab.moved")) send("tab.moved", { ...tabData(s, id), fromWindowId: before.windowId });
      if (!before.pin && t.pin && wants.has("pin.added")) send("pin.added", { ...tabData(s, id), as: t.pin.as });
      if (before.pin && !t.pin && wants.has("pin.removed")) send("pin.removed", tabData(s, id));
    }
  }
}

function startMediaEvents(send: EventSend, wants: ReadonlySet<string>) {
  const audibleIn = (s: BrowserState, tabId: string) => !!s.tabs[tabId] && shownLiveOf(s, tabId).playingAudio;
  const audible = new Set(Object.keys(useBrowser.getState().tabs).filter((id) => audibleIn(useBrowser.getState(), id)));
  const recheck = (s: BrowserState, ids: Iterable<string>) => {
    for (const tabId of ids) {
      const playing = audibleIn(s, tabId);
      if (playing === audible.has(tabId)) continue;
      if (playing) audible.add(tabId);
      else audible.delete(tabId);
      const name = playing ? "media.started" : "media.stopped";
      if (s.tabs[tabId] && wants.has(name) && isEligibleTab(s, tabId)) send(name, tabData(s, tabId));
    }
  };
  const reached = new Set<string>();
  const stopLive = onLiveChange((id, live, prev) => {
    if (live.playingAudio === prev.playingAudio) return;
    const s = useBrowser.getState();
    const ids = liveReachOf(s, id);
    if (inStoreTransaction()) for (const tabId of ids) reached.add(tabId);
    recheck(s, ids);
  });
  const stopReconcile = afterStoreTransactionIdempotent(() => {
    const ids = [...reached];
    reached.clear();
    recheck(useBrowser.getState(), ids);
  });
  const stopHolders = useBrowser.subscribe((s, prev) => {
    if (s.tabs !== prev.tabs) recheck(s, changedIds(s.tabs, prev.tabs).filter((id) => !s.tabs[id] || holderOfPage(s.tabs[id]) !== holderOfPage(prev.tabs[id])));
  });
  return () => {
    stopLive();
    stopHolders();
    stopReconcile();
  };
}

function startCrashes(send: EventSend) {
  return usePages.subscribe((pages, prev) => {
    if (pages.pages === prev.pages) return;
    const s = useBrowser.getState();
    for (const id in pages.pages) {
      const crashed = pages.pages[id]!.crashed;
      if (!crashed || prev.pages[id]?.crashed || !isEligibleTab(s, id)) continue;
      send("tab.crashed", { ...tabData(s, id), reason: crashed.reason, status: crashed.status });
    }
  });
}

function shownTabs(s: BrowserState): Set<string> {
  const focused = focusedWindowOf(s);
  const shown = new Set<string>();
  if (focused) {
    const active = activeTabId(s, focused);
    if (active) shown.add(active);
  }
  return shown;
}

export type TabIdleTracker = { watch: (thresholds: ReadonlySet<number>) => void; catchUp: (thresholds: readonly number[]) => void; idleNow: (threshold: number) => Record<string, unknown>[]; stop: () => void };

type IdleRecord = { since: number; profile: string; createdAt: number; restoredAt?: number };

export function startTabIdle(send: EventSend): TabIdleTracker {
  const idle = new Map<number, Map<string, IdleRecord>>();
  const touched = new Map<string, number>();
  const idleData = (s: BrowserState, id: string, threshold: number) => ({ ...tabData(s, id), pinned: !!s.tabs[id]!.pin, idle: threshold });
  const stillIdle = (s: BrowserState, id: string, record: IdleRecord) => {
    const tab = s.tabs[id];
    return !!tab && isEligibleTab(s, id) && tab.profileId === record.profile && tab.createdAt === record.createdAt && tab.restoredAt === record.restoredAt;
  };
  const lastActivity = (s: BrowserState, id: string) => Math.max(s.tabs[id]!.lastActiveAt, s.tabs[id]!.restoredAt ?? 0, touched.get(id) ?? 0);
  const scan = (only?: ReadonlySet<number>, quietly = false) => {
    const s = useBrowser.getState();
    const now = Date.now();
    const shown = shownTabs(s);
    for (const id of shown) touched.set(id, now);
    for (const [threshold, tabs] of idle) {
      if (only && !only.has(threshold)) continue;
      for (const [id, record] of tabs) {
        if (!stillIdle(s, id, record)) tabs.delete(id);
        else if (shown.has(id)) {
          tabs.delete(id);
          send("tab.resumed", idleData(s, id, threshold));
        }
      }
      for (const id in s.tabs) {
        if (tabs.has(id) || shown.has(id) || !isEligibleTab(s, id)) continue;
        const last = lastActivity(s, id);
        if (now - last >= threshold * 1000) {
          const { profileId, createdAt, restoredAt } = s.tabs[id]!;
          tabs.set(id, { since: last, profile: profileId, createdAt, restoredAt });
          if (!quietly) send("tab.idle", { ...idleData(s, id, threshold), idleSince: last });
        }
      }
    }
    for (const id of touched.keys()) if (!s.tabs[id]) touched.delete(id);
  };
  const timer = setInterval(scan, IDLE_SCAN_MS);
  const unsubscribe = useBrowser.subscribe((s, prev) => {
    if (s.ui !== prev.ui || s.windows !== prev.windows) scan();
  });
  return {
    watch: (thresholds) => {
      for (const threshold of idle.keys()) if (!thresholds.has(threshold)) idle.delete(threshold);
      for (const threshold of thresholds) {
        if (idle.has(threshold)) continue;
        idle.set(threshold, new Map());
        scan(new Set([threshold]), true);
      }
    },
    catchUp: (thresholds) => scan(new Set(thresholds)),
    idleNow: (threshold) => {
      const s = useBrowser.getState();
      return [...(idle.get(threshold) ?? [])].filter(([id, record]) => stillIdle(s, id, record)).map(([id, record]) => ({ ...idleData(s, id, threshold), idleSince: record.since }));
    },
    stop: () => {
      clearInterval(timer);
      unsubscribe();
    },
  };
}

export function startStoreEvents(send: EventSend, needs: { events: ReadonlySet<string> }): () => void {
  const stops: (() => void)[] = [];
  const diffing = ["littleArdia.opened", "profile.switched", "peek.opened", "peek.closed", "split.created", "split.closed", "tab.moved", "pin.added", "pin.removed"];
  if (diffing.some((name) => needs.events.has(name))) stops.push(useBrowser.subscribe((s, prev) => diffMore(s, prev, send, needs.events)));
  if (needs.events.has("media.started") || needs.events.has("media.stopped")) stops.push(startMediaEvents(send, needs.events));
  if (needs.events.has("tab.crashed")) stops.push(startCrashes(send));
  if (LIBRARY_EVENTS.some((name) => needs.events.has(name))) stops.push(startLibraryEvents(send, needs.events));
  return () => stops.forEach((stop) => stop());
}
