import type { CommandEvent } from "../../platform/commands";
import type { BrowserState } from "../browser/store";

export function gestureTab(s: BrowserState, e: Pick<CommandEvent, "mouseGesture" | "gestureTabId" | "windowId">): string | null {
  const tabId = e.mouseGesture ? e.gestureTabId : null;
  const tab = tabId ? s.tabs[tabId] : undefined;
  if (!tabId || !tab || !e.windowId || tab.windowId !== e.windowId) return null;
  return s.windows[e.windowId]?.kind === "small" ? null : tabId;
}
