import { useBrowser } from "../browser/store";
import { showsEmptyWindow } from "../browser/model";
import { httpPagesPort } from "../../platform/launchConfig";
import { closeQuietly } from "../pins/closedTabs";

export const windowIsEmpty = (windowId: string) => showsEmptyWindow(useBrowser.getState(), windowId);

export function openCheckPage(windowId: string) {
  const port = httpPagesPort();
  return useBrowser.getState().newTab(windowId, { url: port ? `http://127.0.0.1:${port}/a` : "about:blank" });
}

export function closeCheckPage(tabId: string) {
  if (useBrowser.getState().tabs[tabId]) useBrowser.setState((s) => closeQuietly(s, [tabId]));
}
