import { onNotificationResponse } from "../../platform/notifications";
import { useBrowser } from "../browser/store";
import { focus, switchToTab } from "../browser/actions";
import { handleWebNotificationResponse } from "../site/webNotifications";
import { noteEngineNotificationResponse } from "../telemetry/notificationRequestCounts";

export function startNotificationResponses() {
  return onNotificationResponse((response) => {
    if (response.id === "engine:") return noteEngineNotificationResponse();
    if (handleWebNotificationResponse(response) || response.action !== "click") return;
    const s = useBrowser.getState();
    const { tabId, windowId } = response;
    if (tabId && s.tabs[tabId]) switchToTab(tabId);
    else if (windowId && s.windows[windowId]) focus(windowId);
  });
}
