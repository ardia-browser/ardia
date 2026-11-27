import { focusPluginPage } from "../../platform/plugins";
import { webviews } from "../../platform/webviews";
import { useBrowser } from "../browser/store";
import { pluginPageOf } from "./pageNames";

export const showsPluginPage = (tabId: string) => !webviews.has(tabId) && pluginPageOf(useBrowser.getState().tabs[tabId]?.url) !== null;

export function focusTabPage(tabId: string): Promise<boolean> {
  const handle = webviews.get(tabId);
  if (handle) return handle.focus().then(() => true, () => false);
  if (!showsPluginPage(tabId)) return Promise.resolve(false);
  return focusPluginPage(tabId).catch(() => false);
}
