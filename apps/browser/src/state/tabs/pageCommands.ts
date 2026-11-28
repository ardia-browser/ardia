import { webviews } from "../../platform/webviews";
import { useBrowser } from "../browser/store";
import { tabEngine } from "../engines/engines";
import { consentToken } from "../telemetry/client";
import { noteWebKitCount } from "../telemetry/engineSwitchCounts";
import { livePageId } from "./livePage";
import { canGoBack, canGoForward, goBackAsking, goForwardAsking } from "./navigation";
import { liveOf } from "./tabLive";

export function navigateFromPage(tabId: string, direction: "back" | "forward") {
  const s = useBrowser.getState();
  if (!s.tabs[tabId]) return;
  const liveId = livePageId(tabId);
  const live = liveOf(liveId);
  const canGo = direction === "back" ? canGoBack(liveId, live, s) : canGoForward(liveId, live);
  if (!canGo) return;
  if (direction === "back" && live.canGoBack && !webviews.get(liveId)) return;
  const isWebKit = tabEngine(s, tabId) === "webkit";
  const consent = consentToken();
  const go = direction === "back" ? goBackAsking(tabId) : goForwardAsking(tabId);
  void go.then(
    (went) => {
      if (went && isWebKit) noteWebKitCount("mouseNavigation", consent);
    },
    () => {},
  );
}
