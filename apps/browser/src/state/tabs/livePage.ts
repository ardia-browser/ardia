import type { WebViewHandle } from "../../platform/tabs";
import { requestPinHandOff } from "../pins/pinHandoff";
import { useBrowser } from "../browser/store";
import { activeTabId } from "../browser/model";
import { webviewMount, webviews } from "../../platform/webviews";
import { holderOfPage } from "./pageSession";

const ARRIVAL_DEADLINE_MS = 3000;
const ARRIVAL_POLL_MS = 30;
const SETTLE_MS = 60;

const store = () => useBrowser.getState();

export const livePageId = (tabId: string) => holderOfPage(store().tabs[tabId]) ?? tabId;

export async function withLivePage(tabId: string, act: (page: WebViewHandle, pageId: string) => unknown, mayAct: () => boolean = () => true): Promise<boolean> {
  const tab = store().tabs[tabId];
  const holderId = holderOfPage(tab);
  if (!tab || !holderId) {
    const page = webviews.get(tabId);
    if (!page) return false;
    act(page, tabId);
    return true;
  }
  const windowId = tab.windowId;
  const before = webviewMount(holderId);
  if (!(await requestPinHandOff(tabId, mayAct))) return false;
  const shownHere = () => {
    const holder = store().tabs[holderId];
    return holder?.windowId === windowId && !holderOfPage(holder) && activeTabId(store(), windowId) === holderId;
  };
  const until = Date.now() + ARRIVAL_DEADLINE_MS;
  while (Date.now() < until && shownHere()) {
    const page = webviews.get(holderId);
    if (page && webviewMount(holderId) !== before) {
      await new Promise((done) => setTimeout(done, SETTLE_MS));
      if (!shownHere() || webviews.get(holderId) !== page || !mayAct()) return false;
      act(page, holderId);
      return true;
    }
    await new Promise((done) => setTimeout(done, ARRIVAL_POLL_MS));
  }
  return false;
}
