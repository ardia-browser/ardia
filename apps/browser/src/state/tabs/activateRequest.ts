import { focus, switchToTab } from "../browser/actions";
import { activeTabId } from "../browser/model";
import { useBrowser } from "../browser/store";
import type { ActivateRequest } from "../../platform/tabs";
import type { PageEngine } from "../engines/engines";
import { notePictureInPictureBackToTab, noteWindowActivationRequest } from "../telemetry/pictureInPictureCounts";

export function answerActivateRequest(tabId: string, reason: ActivateRequest["reason"], engine: PageEngine) {
  const s = useBrowser.getState();
  const tab = s.tabs[tabId];
  if (!tab) return;
  if (reason === "window") {
    noteWindowActivationRequest(activeTabId(s, tab.windowId) !== tabId);
    focus(tab.windowId);
    return;
  }
  if (reason === "pictureInPicture") notePictureInPictureBackToTab(engine);
  switchToTab(tabId);
  focus(tab.windowId);
}
