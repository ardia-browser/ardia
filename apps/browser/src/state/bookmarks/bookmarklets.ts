import { isJavaScriptUrl, resolveInput } from "@ardia/core";
import { webviews } from "../../platform/webviews";
import { useBrowser } from "../browser/store";
import { activeTabId, resolveWindowId } from "../browser/model";
import { isWebPageUrl } from "../../lib/url";
import { noteBookmarkletRun } from "../telemetry/bookmarkletCounts";

export const isBookmarklet = (url: string) => isJavaScriptUrl(url);

export function bookmarkUrlFrom(text: string, searchUrlPrefix: string): string {
  const typed = text.trim();
  return isBookmarklet(typed) ? typed : resolveInput(typed, searchUrlPrefix);
}

export function runBookmarklet(url: string, windowId: string | null | undefined, onTab?: string | null): boolean {
  const s = useBrowser.getState();
  const id = resolveWindowId(s, windowId);
  const tabId = onTab ?? (id ? activeTabId(s, id) : undefined);
  const tab = tabId ? s.tabs[tabId] : undefined;
  const web = tabId ? webviews.get(tabId) : undefined;
  if (!tab || !web || !(isWebPageUrl(tab.url) || tab.url === "about:blank")) {
    noteBookmarkletRun(false);
    return false;
  }
  noteBookmarkletRun(true);
  void web.loadUrl(url, { userInitiated: true });
  return true;
}
