import type { SearchScope } from "@ardia/core";
import { useBrowser } from "../browser/store";
import { activeTabId } from "../browser/model";
import { shownPeek } from "../peek/peek";
import { expectFocus, heroBarFocus } from "../focus/focusClaims";
import { webviews } from "../../platform/webviews";
import { clickBarPlacement } from "./barPlacement";
import { notePageFocusReturnAfterBar } from "../telemetry/pageFocusReturns";
import { consentToken, type ConsentToken } from "../telemetry/client";
import { noteCommandBarKeyDismissal } from "../telemetry/inlineCompletionCounts";

export type BarSnapshot = {
  typed: string;
  edited: boolean;
  selection: { start: number; end: number };
  selected: number;
  scope: SearchScope | null;
  scopeFrom: string;
};

const ntpQueries = new Map<string, BarSnapshot>();

export const savedNtpQuery = (tabId: string) => ntpQueries.get(tabId) ?? null;

export function saveNtpQuery(tabId: string, snapshot: BarSnapshot | null) {
  if (snapshot?.typed || snapshot?.scope) ntpQueries.set(tabId, snapshot);
  else ntpQueries.delete(tabId);
}

export type HeroBarFocus = "selectAll" | "restore";

const heroBars = new Map<string, (mode: HeroBarFocus) => void>();
const heroBarKey = (windowId: string, tabId: string) => `${windowId}\n${tabId}`;

export function registerHeroBar(windowId: string, tabId: string, focus: (mode: HeroBarFocus) => void): () => void {
  const key = heroBarKey(windowId, tabId);
  heroBars.set(key, focus);
  return () => {
    if (heroBars.get(key) === focus) heroBars.delete(key);
  };
}

export function focusHeroBar(windowId: string, tabId: string | undefined, mode: HeroBarFocus = "selectAll"): boolean {
  const focus = tabId === undefined ? undefined : heroBars.get(heroBarKey(windowId, tabId));
  if (!focus || tabId === undefined) return false;
  expectFocus(windowId, heroBarFocus(tabId));
  focus(mode);
  return true;
}

export function openBarFromAddress(windowId: string, text: string) {
  const s = useBrowser.getState();
  s.openPanel(windowId, text, undefined, clickBarPlacement(s, windowId));
}

export function openEmptySidebarField(windowId: string) {
  openBarFromAddress(windowId, "");
}

export type BarDismissal = "escape" | "closeKey" | "commandKey";

export function cancelPanel(windowId: string) {
  const consent = consentToken();
  useBrowser.getState().closePanel(windowId);
  setTimeout(() => {
    const now = useBrowser.getState();
    const active = activeTabId(now, windowId);
    if (!active || !now.tabs[active]?.url || now.windowUi[windowId]?.panel.open || shownPeek(now, windowId)) return;
    void webviews.get(active)?.focusIfUnfocused().then((focused) => {
      if (focused) notePageFocusReturnAfterBar(consent);
    });
  }, 0);
}

export function dismissBarByCommandKey(windowId: string, tabId: string, consent: ConsentToken | null) {
  closePanelToHeroBar(windowId, tabId, "commandKey");
  noteCommandBarKeyDismissal(consent);
}

export function closePanelToHeroBar(windowId: string, tabId: string, reason?: BarDismissal) {
  useBrowser.getState().closePanel(windowId);
  const now = useBrowser.getState();
  if (activeTabId(now, windowId) !== tabId) return;
  if (!now.tabs[tabId]?.url) focusHeroBar(windowId, tabId);
  else if (reason && now.tabs[tabId]?.windowId === windowId) void webviews.get(tabId)?.focus();
}
