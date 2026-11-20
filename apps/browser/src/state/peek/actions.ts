import { setPeekModifier, setPeekOtherSiteTabs, setSplitLinkModifier } from "../../platform/pageOptions";
import { hapticTick } from "../../platform/haptics";
import { webviews } from "../../platform/webviews";
import { useBrowser, type BrowserState } from "../browser/store";
import { activeTabId, IDLE_LIVE } from "../browser/model";
import { splitLinkModifierOf, type PeekModifier, type SplitLinkModifier } from "../settings/settings";
import { MAX_SPLIT_PANES, splitOf, splitTabIdsOf } from "../splits/splits";
import { openSplitPane } from "../splits/actions";
import { showToast } from "../app/toasts";
import { isPeekTab, otherSitePeekTabIds, peekSourceOf, peekTabId, peekTabIds, shownPageId, shownPeek } from "./peek";
import { closeFind } from "../find/actions";
import { hostOf } from "@ardia/core";
import { linkDestination } from "../../lib/linkWrappers";
import { navigationOf } from "../tabs/pageSession";
import { liveOf, onLiveChange } from "../tabs/tabLive";
import { notePageOverlay } from "../telemetry/usage";
import { holdPeekDonor } from "./donors";
import { PLATFORM_FEATURES } from "../../lib/platformFeatures";
import { endPeekToolbarPreview, previewPeekToolbar } from "./toolbarPreview";
import { revealToolbar } from "../windows/toolbarAutoHide";

const store = () => useBrowser.getState();
type PeekMotionHandle = { tabId: string; close: () => Promise<boolean>; promote: () => Promise<boolean> };
const motions = new Map<string, PeekMotionHandle>();

export function registerPeekMotion(windowId: string, handle: PeekMotionHandle) {
  motions.set(windowId, handle);
  return () => {
    if (motions.get(windowId) === handle) motions.delete(windowId);
  };
}

const motionOf = (windowId: string) => {
  const motion = motions.get(windowId);
  return motion && motion.tabId === shownPeek(store(), windowId)?.tabId ? motion : undefined;
};

export function dismissPeek(windowId: string) {
  const peek = shownPeek(store(), windowId);
  if (!peek) return;
  const motion = motionOf(windowId);
  if (motion) void motion.close();
  else finishPeek(peek.tabId);
}

export function finishPeek(tabId: string) {
  const source = peekSourceOf(store(), tabId);
  if (source) store().closePeek(source);
}

const focusSoon = (windowId: string, tabId: string) =>
  setTimeout(() => {
    const s = store();
    if (s.tabs[tabId] && activeTabId(s, windowId) === tabId && !shownPeek(s, windowId)) void webviews.get(tabId)?.focus();
  }, 50);

export function promotePeekNow(windowId: string, tabId: string) {
  const peek = shownPeek(store(), windowId);
  if (peek?.tabId !== tabId) {
    endPeekToolbarPreview(windowId, tabId);
    const sourceId = peekSourceOf(store(), tabId);
    if (sourceId) store().peekToTab(windowId, { activate: false, sourceId });
    return;
  }
  if (PLATFORM_FEATURES.nativePeekMotion) holdPeekDonor(windowId, tabId, peek.sourceId);
  revealToolbar(tabId);
  const id = store().peekToTab(windowId, { sourceId: peek.sourceId });
  endPeekToolbarPreview(windowId, tabId);
  if (!id) return;
  hapticTick();
  focusSoon(windowId, id);
}

export function openPeekAsTab(windowId: string) {
  const peek = shownPeek(store(), windowId);
  if (!peek) return;
  const motion = motionOf(windowId);
  if (!motion) return promotePeekNow(windowId, peek.tabId);
  previewPeekToolbar(windowId, peek.tabId, peek.sourceId);
  void motion.promote().then((started) => started || endPeekToolbarPreview(windowId, peek.tabId));
}

export function openPeekInSplit(windowId: string) {
  const s = store();
  const peek = shownPeek(s, windowId);
  if (!peek) return;
  if ((splitTabIdsOf(splitOf(s, peek.sourceId))?.length ?? 0) >= MAX_SPLIT_PANES) {
    return showToast(windowId, "Cannot Add New Pane", `Split View can show up to ${MAX_SPLIT_PANES} tabs at once.`);
  }
  const id = s.peekToTab(windowId, { activate: false });
  if (!id) return;
  if (openSplitPane(windowId, { tabId: id, anchorTabId: peek.sourceId, side: "right", openedForSplit: true })) focusSoon(windowId, id);
  else store().activate(id);
}

export function closePeekOnEscape(tabId: string): boolean {
  const s = store();
  const tab = s.tabs[tabId];
  const peek = tab ? shownPeek(s, tab.windowId) : undefined;
  if (!tab || !peek || (peek.tabId !== tabId && peek.sourceId !== tabId) || s.find[tabId]?.open || s.windowUi[tab.windowId]?.panel.open) return false;
  dismissPeek(tab.windowId);
  return true;
}

export function runPeekCommand(command: string, windowId: string): boolean {
  const s = store();
  const peek = shownPeek(s, windowId);
  if (!peek) return false;
  if (command === "openFile") {
    openPeekAsTab(windowId);
    return true;
  }
  if (command !== "closeTab" || s.windowUi[windowId]?.panel.open) return false;
  if (s.find[peek.tabId]?.open) closeFind(peek.tabId);
  else dismissPeek(windowId);
  return true;
}

let started = false;

export function startPeeks() {
  if (started) return;
  started = true;
  let sent: PeekModifier | null = null;
  let sentSplit: SplitLinkModifier | null = null;
  let sentSites: string | null = null;
  let read: { tabs: BrowserState["tabs"]; groups: BrowserState["groups"]; on: boolean } | null = null;
  const sync = () => {
    const s = store();
    const modifier = s.settings.peekModifier;
    if (modifier !== sent) void setPeekModifier((sent = modifier));
    const split = splitLinkModifierOf(s.settings);
    if (split !== sentSplit) void setSplitLinkModifier((sentSplit = split));
    const on = s.settings.peekLinksToOtherSites;
    if (read && read.tabs === s.tabs && read.groups === s.groups && read.on === on) return;
    read = { tabs: s.tabs, groups: s.groups, on };
    const ids = otherSitePeekTabIds(s);
    const key = ids.join("\n");
    if (key === sentSites) return;
    sentSites = key;
    void setPeekOtherSiteTabs(ids);
  };
  sync();
  useBrowser.subscribe(sync);
  useBrowser.subscribe((s, prev) => {
    if (s.peeks !== prev.peeks) bumpOnFirstLoad(s);
    if (s.tabs !== prev.tabs || s.peeks !== prev.peeks) landBackOnSite(s);
  });
  onLiveChange((id) => {
    const s = useBrowser.getState();
    if (!peekTabIds(s.peeks).has(id)) return;
    bumpOnFirstLoad(s);
    landBackOnSite(s);
  });
  useBrowser.subscribe(refocusAfterClose);
  useBrowser.subscribe(countPeeksShownAgain);
}

function countPeeksShownAgain(s: BrowserState, prev: BrowserState) {
  if (s.windows === prev.windows) return;
  for (const windowId in s.windows) {
    const peek = shownPeek(s, windowId);
    if (peek && prev.peeks[peek.sourceId]?.tabId === peek.tabId && shownPeek(prev, windowId)?.tabId !== peek.tabId) notePageOverlay("peekShownAgain");
  }
}

type LandingWatch = { nav: number | null; judged: boolean };
const landings = new Map<string, LandingWatch>();
const isLinkWrapper = (url: string) => linkDestination(url) !== url;

function landBackOnSite(s: BrowserState) {
  const shown = peekTabIds(s.peeks);
  for (const id of landings.keys()) if (!shown.has(id)) landings.delete(id);
  for (const [sourceId, peek] of Object.entries(s.peeks)) {
    const landing = peek.landing;
    const tab = s.tabs[peek.tabId];
    if (!landing || !tab) continue;
    const nav = navigationOf(tab)?.seq ?? null;
    let watch = landings.get(peek.tabId);
    if (!watch) landings.set(peek.tabId, (watch = { nav, judged: false }));
    if (watch.judged) continue;
    if (Date.now() > landing.until || nav !== watch.nav) {
      watch.judged = true;
      continue;
    }
    const live = liveOf(peek.tabId);
    if (live === IDLE_LIVE || live.isLoading || !/^https?:/i.test(tab.url) || isLinkWrapper(tab.url)) continue;
    watch.judged = true;
    if (hostOf(tab.url) !== landing.host) continue;
    const url = tab.url;
    queueMicrotask(() => {
      if (store().peeks[sourceId]?.tabId !== peek.tabId) return;
      if (landing.then === "tab") {
        if (peekTabId(store(), tab.windowId) === peek.tabId) return void openPeekAsTab(tab.windowId);
        return void store().peekToTab(tab.windowId, { activate: false, sourceId });
      }
      store().closePeek(sourceId);
      store().navigate(sourceId, url, { userInitiated: false });
    });
  }
}

function refocusAfterClose(s: BrowserState, prev: BrowserState) {
  if (s.peeks === prev.peeks) return;
  for (const [sourceId, peek] of Object.entries(prev.peeks)) {
    if (s.peeks[sourceId]?.tabId === peek.tabId || s.tabs[peek.tabId]) continue;
    const source = s.tabs[sourceId];
    if (source && activeTabId(s, source.windowId) === sourceId) void webviews.get(sourceId)?.focus();
  }
}

const loading = new Set<string>();
const loaded = new Set<string>();

function bumpOnFirstLoad(s: BrowserState) {
  const shown = peekTabIds(s.peeks);
  for (const id of [...loading, ...loaded]) if (!shown.has(id)) (loading.delete(id), loaded.delete(id));
  for (const id of shown) {
    if (loaded.has(id)) continue;
    if (liveOf(id).isLoading) loading.add(id);
    else if (loading.has(id)) {
      loading.delete(id);
      loaded.add(id);
      hapticTick();
    }
  }
}

export const currentShownPageId = (windowId: string) => shownPageId(useBrowser.getState(), windowId);

export function promotedFromPeek(tabId: string): boolean {
  const s = store();
  const tab = s.tabs[tabId];
  return !!tab && !isPeekTab(s, tabId);
}
