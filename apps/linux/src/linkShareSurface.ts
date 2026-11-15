import { copyText } from "@ardia/shell";
import { activeTabId } from "../../browser/src/state/browser/model";
import { useBrowser } from "../../browser/src/state/browser/store";
import { webviews } from "../../browser/src/platform/webviews";
import { reportHostError } from "./host";
import { setShareSurface } from "./linkShare";
import { showMenu } from "./menus";

const openInActivePage = (url: string, windowId: string | null) => {
  const state = useBrowser.getState();
  const window = windowId && state.windows[windowId] ? windowId : state.ui.focusOrder[0];
  const tabId = window ? activeTabId(state, window) : undefined;
  const page = tabId ? webviews.get(tabId) : undefined;
  if (!page) return false;
  void Promise.resolve(page.loadUrl(url)).catch(reportHostError);
  return true;
};

setShareSurface({ menu: (items, at) => showMenu(items, undefined, at), copy: copyText, openInActivePage });
