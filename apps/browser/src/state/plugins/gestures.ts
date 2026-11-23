import { withoutFragment } from "../../lib/url";
import { useBrowser, type BrowserState } from "../browser/store";
import { activeTabId } from "../browser/model";
import { navigationOf } from "../tabs/pageSession";
import { onLiveChange } from "../tabs/tabLive";

const GESTURE_WINDOW_MS = 30_000;

export type Gesture = { id: number; windowId: string; tabId: string | null; doc: string | null; at: number };

const gestures = new Map<string, Gesture>();
let gestureSeq = 0;
let stopWatching: (() => void) | null = null;

const navSeqOf = (s: BrowserState, tabId: string | null) => (tabId ? navigationOf(s.tabs[tabId])?.seq : undefined);

function renavigated(s: BrowserState, prev: BrowserState, gesture: Gesture): boolean {
  const tabId = gesture.tabId;
  if (!tabId || navSeqOf(s, tabId) === navSeqOf(prev, tabId)) return false;
  const nav = navigationOf(s.tabs[tabId]);
  if (!nav) return true;
  return nav.url === prev.tabs[tabId]?.url || withoutFragment(nav.url) !== gesture.doc;
}

function outlived(s: BrowserState, prev: BrowserState, gesture: Gesture): boolean {
  if (!s.windows[gesture.windowId]) return true;
  const active = activeTabId(s, gesture.windowId) ?? null;
  if (active !== gesture.tabId && (activeTabId(prev, gesture.windowId) ?? null) === gesture.tabId) return true;
  if (!gesture.tabId) return false;
  const tab = s.tabs[gesture.tabId];
  if (!tab || withoutFragment(tab.url) !== gesture.doc) return true;
  return renavigated(s, prev, gesture);
}

function forgetWhere(gone: (gesture: Gesture) => boolean) {
  for (const [plugin, gesture] of gestures) if (gone(gesture)) gestures.delete(plugin);
  stopWhenIdle();
}

function stopWhenIdle() {
  if (gestures.size || !stopWatching) return;
  stopWatching();
  stopWatching = null;
}

function watchGesturePages() {
  if (stopWatching) return;
  const stopBrowser = useBrowser.subscribeTo(["tabs", "windows"], (s, prev) => {
    forgetWhere((gesture) => outlived(s, prev, gesture));
  });
  const stopLive = onLiveChange((tabId, live, prev) => {
    if (live.isLoading && !prev.isLoading) forgetWhere((gesture) => gesture.tabId === tabId);
  });
  stopWatching = () => {
    stopBrowser();
    stopLive();
  };
}

export function notePluginGesture(plugin: string, windowId: string, tabId?: string | null, now = Date.now()) {
  const s = useBrowser.getState();
  const tab = tabId ?? activeTabId(s, windowId) ?? null;
  const url = tab ? s.tabs[tab]?.url : undefined;
  gestures.set(plugin, { id: ++gestureSeq, windowId, tabId: tab, doc: typeof url === "string" ? withoutFragment(url) : null, at: now });
  watchGesturePages();
}

export function recentPluginGesture(plugin: string, now = Date.now()): Gesture | null {
  const gesture = gestures.get(plugin);
  if (!gesture) return null;
  if (now - gesture.at > GESTURE_WINDOW_MS || now < gesture.at) {
    gestures.delete(plugin);
    stopWhenIdle();
    return null;
  }
  return gesture;
}

export function forgetPluginGestures(plugin: string) {
  gestures.delete(plugin);
  stopWhenIdle();
}
