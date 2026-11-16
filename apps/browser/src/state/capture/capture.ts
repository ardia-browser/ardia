import { create } from "zustand";
import { webviews } from "../../platform/webviews";
import { useBrowser } from "../browser/store";
import { activeTabId } from "../browser/model";
import { peekTabId } from "../peek/peek";
import { UNAVAILABLE_COMMANDS } from "../commands/commandCatalog";
import { isInternalTab } from "../pages/urls";
import { paneUnder, type Point, type Rect } from "./captureArea";
import { noteCaptureCancelled, noteCaptureCopied, noteCaptureFailed, noteCaptureStarted } from "../telemetry/captureCounts";

export const useCapture = create<{ windowId: string | null }>()(() => ({ windowId: null }));

export const useCapturing = (windowId: string) => useCapture((c) => c.windowId === windowId);

function canCapture(windowId: string): boolean {
  const s = useBrowser.getState();
  const shown = activeTabId(s, windowId);
  const tab = shown ? s.tabs[shown] : undefined;
  return !UNAVAILABLE_COMMANDS.has("capture") && !!tab?.url && !isInternalTab(tab) && !peekTabId(s, windowId);
}

export function runCaptureCommand(command: string, windowId: string): boolean {
  if (command !== "capture") return false;
  if (useCapture.getState().windowId === windowId) endCapture(windowId);
  else if (canCapture(windowId)) {
    noteCaptureStarted();
    useCapture.setState({ windowId });
  }
  return true;
}

function leave(windowId: string, refocus: boolean): boolean {
  if (useCapture.getState().windowId !== windowId) return false;
  useCapture.setState({ windowId: null });
  const shown = refocus ? activeTabId(useBrowser.getState(), windowId) : undefined;
  if (shown) void webviews.get(shown)?.focus();
  return true;
}

export function endCapture(windowId: string, { refocus = true }: { refocus?: boolean } = {}) {
  if (leave(windowId, refocus)) noteCaptureCancelled();
}

export function closeCaptureOnEscape(tabId: string): boolean {
  const windowId = useBrowser.getState().tabs[tabId]?.windowId;
  if (!windowId || useCapture.getState().windowId !== windowId) return false;
  endCapture(windowId);
  return true;
}

export async function finishCapture(windowId: string, selection: Rect, panes: Readonly<Record<string, Rect>>, origin: Point) {
  if (!leave(windowId, true)) return;
  const picked = paneUnder(selection, panes);
  if (!picked) return noteCaptureCancelled();
  const { x, y, width, height } = picked.rect;
  const copied = await webviews
    .get(picked.tabId)
    ?.copyRegionToPasteboard([origin.x + x, origin.y + y, width, height])
    .catch(() => null);
  if (copied) noteCaptureCopied(Object.keys(panes).length > 1);
  else noteCaptureFailed();
}
