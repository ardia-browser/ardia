import { webviews } from "../../platform/webviews";
import { useBrowser } from "../browser/store";
import { showToast } from "../app/toasts";
import { isInternalTab } from "../pages/urls";
import { noteScreenshotCopied } from "../telemetry/urlCopies";
import { consentOrNow, type ConsentToken } from "../telemetry/consentPeriod";

export async function copyPageScreenshot(tabId: string, consent?: ConsentToken | null) {
  const tab = useBrowser.getState().tabs[tabId];
  const web = webviews.get(tabId);
  if (!tab?.url || !web || isInternalTab(tab)) return;
  const counted = consentOrNow(consent);
  const copied = await web.copyScreenshot().catch(() => ({ ok: false, reason: "noPicture" }) as const);
  if (!copied || (!copied.ok && copied.reason === "noPage")) return;
  noteScreenshotCopied(copied.ok, counted);
  if (!copied.ok) return showToast(tab.windowId, "Couldn't capture this page", undefined, { icon: "exclamationmark.triangle" });
  showToast(tab.windowId, "Copied Screenshot", `${copied.width} × ${copied.height}`, { icon: "camera.viewfinder" });
}
