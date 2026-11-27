import type { BrowserState } from "../browser/store";
import { customNewTabUrl } from "../settings/settings";
import { newTabChoice, whenExtensionListKnown, type NewTabChoice } from "../extensions/newTabPage";
import { noteExtensionNewTab } from "../telemetry/newTabPageCounts";
import { navigationOf } from "./pageSession";
import { gateOpening, isGatedUrl, openingSignal, settleOpening } from "./openingGate";

type NewTabHome = {
  url: string | undefined;
  replaced: boolean;
  cancelled: boolean;
  settle: (tabId: string, get: () => BrowserState, onCancel: (tabId: string) => void) => void;
};

const settled = () => {};

export function newTabPageChoice(s: BrowserState, windowId: string, profileId?: string | null): NewTabChoice {
  const choice = newTabChoice(s, windowId, profileId, customNewTabUrl(s.settings));
  if (choice.via) noteExtensionNewTab(choice.via);
  return choice;
}

const overridableTabs = new Set<string>();
const MAX_OVERRIDABLE_TABS = 32;

export const cancelLateNewTabOverride = (tabId: string) => void overridableTabs.delete(tabId);

export function settleWhenListed(windowId: string, tabId: string, get: () => BrowserState) {
  const waited = get().tabs[tabId]?.profileId;
  if (!waited) return;
  overridableTabs.delete(tabId);
  overridableTabs.add(tabId);
  if (overridableTabs.size > MAX_OVERRIDABLE_TABS) overridableTabs.delete(overridableTabs.values().next().value!);
  whenExtensionListKnown(get(), windowId, waited, () => {
    if (!overridableTabs.delete(tabId)) return;
    const s = get();
    const tab = s.tabs[tabId];
    if (!tab || tab.profileId !== waited || tab.url || navigationOf(tab) || openingSignal(`tab:${tabId}`) || s.windowUi[tab.windowId]?.panel.open) return;
    const choice = newTabChoice(s, tab.windowId, waited, customNewTabUrl(s.settings));
    if (!choice.url || isGatedUrl(choice.url)) return;
    if (choice.via) noteExtensionNewTab(choice.via);
    s.navigate(tabId, choice.url, { userInitiated: true });
  });
}

export function newTabHome(s: BrowserState, windowId: string, profileId: string | null): NewTabHome {
  const choice = newTabPageChoice(s, windowId, profileId);
  const url = choice.url;
  if (!url && choice.waits) return { url, replaced: false, cancelled: false, settle: (tabId, get) => settleWhenListed(windowId, tabId, get) };
  if (!url || !isGatedUrl(url)) return { url, replaced: false, cancelled: false, settle: settled };
  const gated = gateOpening(url, { tabId: null, windowId, profileId, via: "newTab" }, null);
  if ("verdict" in gated) {
    if (gated.verdict && "cancel" in gated.verdict) return { url: undefined, replaced: false, cancelled: true, settle: settled };
    return { url: gated.verdict?.url ?? url, replaced: !!gated.verdict, cancelled: false, settle: settled };
  }
  return {
    url: undefined,
    replaced: false,
    cancelled: false,
    settle: (tabId, get, onCancel) =>
      void settleOpening(gated, null, (verdict) => {
        const tab = get().tabs[tabId];
        if (!tab || navigationOf(tab)) return;
        if (verdict && "cancel" in verdict) return onCancel(tabId);
        get().navigate(tabId, verdict?.url ?? url, { userInitiated: !verdict, gated: true });
      }),
  };
}
