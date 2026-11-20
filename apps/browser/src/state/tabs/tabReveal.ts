import { claimTabPress, dropTabPress, dropTabReveals, revealOffered, revealTab, setNativeTabSwitch, setTabsInSplits } from "../../platform/tabs";
import { useMedia } from "../media/media";
import { pageOf, usePages } from "./pageState";
import { useToolbarAutoHide } from "../windows/toolbarAutoHide";
import { useBrowser, type BrowserState } from "../browser/store";
import { activeTabId } from "../browser/model";
import { adoptOf, hasPage } from "./pageSession";
import { splitOf, splitTabIds } from "../splits/splits";
import type { Tab } from "../browser/types";
import { isWebPageUrl } from "../../lib/url";
import { PLATFORM_FEATURES } from "../../lib/platformFeatures";

const OFFERED = /^(tab|ardiacore):/;

export const tabPressTag = (tabId: string, selected: boolean, inSplit: boolean) =>
  PLATFORM_FEATURES.nativeTabSwitch && !inSplit ? `${selected ? "tab-selected" : "tab-switch"}:${tabId}` : undefined;

export const PAGE_IDENTITY_TAG = PLATFORM_FEATURES.nativeTabSwitch ? "page-identity" : undefined;

let pressSwitching = 0;

export const claimPress = (tabId: string, startedAt: number | undefined) =>
  PLATFORM_FEATURES.nativeTabSwitch && startedAt !== undefined ? claimTabPress(tabId, startedAt) : 0;

export const switchingPress = () => pressSwitching;

export function switchingByPress(press: number, run: () => void) {
  const outer = pressSwitching;
  pressSwitching = press;
  try {
    run();
  } finally {
    pressSwitching = outer;
  }
}

export function pressLeftTabBehind(press: number) {
  if (press) dropTabPress(press);
}

const tabsInSplits = (s: BrowserState) => Object.values(s.splits).flatMap(splitTabIds);

const popoverOpen = () => Object.values(usePages.getState().popover).some(Boolean);

const nativeSwitchAllowed = () => PLATFORM_FEATURES.nativeTabSwitch && !Object.keys(useMedia.getState().tabShares).length && !popoverOpen();

export type Switch = { tabId: string; offered?: string; over: string } | { tabId: null; to: string; over: string };

const hasWebPage = (t: Tab | undefined): t is Tab => !!t && hasPage(t) && isWebPageUrl(t.url);

function plainPage(tabId: string): boolean {
  const page = pageOf(tabId);
  return !page.newTabShown && !page.fullscreen && !page.crashed && !page.unresponsive;
}

function revealFor(s: BrowserState, prev: BrowserState, windowId: string, next: string, before: string): Switch | null {
  const w = s.windows[windowId]!;
  const was = prev.windows[windowId]!;
  if (w.spaceId !== was.spaceId || w.kind === "small") return null;
  if (splitOf(prev, before) || splitOf(s, next) || !plainPage(before) || !plainPage(next)) return null;
  if (Object.keys(useMedia.getState().tabShares).length) return null;
  const tab = s.tabs[next];
  const had = prev.tabs[next];
  if (!hasWebPage(tab) || tab.windowId !== windowId) return null;
  if (hasWebPage(had)) return had.windowId === windowId && was.tabIds.includes(next) ? { tabId: next, over: before } : null;
  const adopt = adoptOf(tab);
  if (!had && adopt && OFFERED.test(adopt) && hasWebPage(prev.tabs[before]) && !useToolbarAutoHide.getState().scrolledDown[before])
    return { tabId: next, offered: adopt, over: before };
  return null;
}

export function switchedTabs(s: BrowserState, prev: BrowserState): Switch[] {
  if (s.windows === prev.windows) return [];
  const out: Switch[] = [];
  for (const id in s.windows) {
    const w = s.windows[id]!;
    const was = prev.windows[id];
    if (!was || w === was) continue;
    const next = activeTabId(s, id);
    const before = activeTabId(prev, id);
    if (!before || next === before) continue;
    out.push((next && revealFor(s, prev, id, next, before)) || { tabId: null, to: next ?? "", over: before });
  }
  return out;
}

export function startTabReveal() {
  let nativeSwitch = nativeSwitchAllowed();
  if (PLATFORM_FEATURES.nativeTabSwitch) setNativeTabSwitch(nativeSwitch);
  const follow = () => {
    const allowed = nativeSwitchAllowed();
    if (allowed === nativeSwitch) return;
    nativeSwitch = allowed;
    setNativeTabSwitch(allowed);
  };
  useMedia.subscribe(follow);
  usePages.subscribe((s, prev) => {
    if (s.popover !== prev.popover) follow();
  });
  if (PLATFORM_FEATURES.nativeTabSwitch) setTabsInSplits(tabsInSplits(useBrowser.getState()));
  useBrowser.subscribe((s, prev) => {
    if (PLATFORM_FEATURES.nativeTabSwitch && s.splits !== prev.splits) setTabsInSplits(tabsInSplits(s));
    for (const change of switchedTabs(s, prev)) {
      if (change.tabId === null) dropTabReveals(change.over, pressSwitching, change.to);
      else if (change.offered) revealOffered(change.offered, change.over, pressSwitching);
      else revealTab(change.tabId, pressSwitching);
    }
  });
}
