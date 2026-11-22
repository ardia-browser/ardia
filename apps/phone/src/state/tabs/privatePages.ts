import { pages } from "../../platform/pages";
import { actionWords } from "../../lib/sharedWords";
import { openExternal } from "../../platform/system";
import { countUsage } from "../telemetry/telemetry";
import { showToast, TOAST_LONG_DURATION_MS } from "../toasts/store";

export const PRIVATE_PAGES_UNAVAILABLE = "ERR_PRIVATE_PAGES_UNAVAILABLE";

export const INCOGNITO_NEEDS_WEBVIEW = "Update Android System WebView for Incognito";

const WEBVIEW_IN_STORE = "market://details?id=com.google.android.webview";
const WEBVIEW_ON_THE_WEB = "https://play.google.com/store/apps/details?id=com.google.android.webview";

export function privatePagesRefused(): boolean {
  const capabilities = pages.capabilities();
  return capabilities.ready && !capabilities.supportsPrivatePages;
}

const openWebViewListing = () => {
  openExternal(WEBVIEW_IN_STORE).catch(() => openExternal(WEBVIEW_ON_THE_WEB).catch(() => undefined));
};

export function refuseIncognito() {
  countUsage("incognito_unavailable");
  showToast(INCOGNITO_NEEDS_WEBVIEW, "warning", TOAST_LONG_DURATION_MS, { label: actionWords.update, run: openWebViewListing });
}
