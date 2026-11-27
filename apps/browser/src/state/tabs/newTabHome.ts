import type { BrowserState } from "../browser/store";
import { customNewTabUrl } from "../settings/settings";
import { extensionNewTabUrl } from "../extensions/newTabPage";
import { noteExtensionNewTab } from "../telemetry/newTabPageCounts";
import { navigationOf } from "./pageSession";
import { gateOpening, isGatedUrl, settleOpening } from "./openingGate";

type NewTabHome = {
  url: string | undefined;
  replaced: boolean;
  cancelled: boolean;
  settle: (tabId: string, get: () => BrowserState, onCancel: (tabId: string) => void) => void;
};

const settled = () => {};

export function newTabPageUrl(s: BrowserState, windowId: string, profileId?: string | null): string | undefined {
  const custom = customNewTabUrl(s.settings);
  if (custom) {
    if (custom.startsWith("chrome-extension://")) noteExtensionNewTab("address");
    return custom;
  }
  const page = extensionNewTabUrl(s, windowId, profileId);
  if (page) noteExtensionNewTab("override");
  return page;
}

export function newTabHome(s: BrowserState, windowId: string, profileId: string | null): NewTabHome {
  const url = newTabPageUrl(s, windowId, profileId);
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
