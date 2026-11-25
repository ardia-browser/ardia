import { useBrowser } from "../browser/store";
import { activeTabId } from "../browser/model";
import { dismissBarByCommandKey } from "../omnibox/barState";
import type { ByUser } from "../tabs/closeActivation";
import { closeLittleArdia, cycleLittleArdiaProfile, moveLittleArdiaToProfile, openInMainWindow, openLittleArdiaProfileMenu } from "../littleArdia/actions";

export function runLittleArdiaCommand(command: string, arg: string | null | undefined, windowId: string, user?: ByUser): boolean {
  const s = useBrowser.getState();
  const tabId = activeTabId(s, windowId);
  const tab = tabId ? s.tabs[tabId] : undefined;
  switch (command) {
    case "closeTab":
      if (s.windowUi[windowId]?.panel.open && tab?.url) s.closePanel(windowId);
      else void closeLittleArdia(windowId);
      return true;
    case "focusCommandBar":
      if (user && s.windowUi[windowId]?.panel.open && tab) dismissBarByCommandKey(windowId, tab.id, user.consent);
      else s.openPanel(windowId, tab?.url ?? "");
      return true;
    case "openFile":
      openInMainWindow(windowId);
      return true;
    case "switchProfile":
      if (arg) moveLittleArdiaToProfile(windowId, arg);
      return true;
    case "nextProfile":
      cycleLittleArdiaProfile(windowId, 1);
      return true;
    case "previousProfile":
      cycleLittleArdiaProfile(windowId, -1);
      return true;
    case "openProfileMenu":
      void openLittleArdiaProfileMenu(windowId);
      return true;
  }
  return false;
}
