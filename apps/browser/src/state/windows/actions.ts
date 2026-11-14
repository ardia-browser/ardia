import { storeAction, useBrowser } from "../browser/store";
import { noteDownloadsPanel } from "../telemetry/downloadsPanelCounts";

export const toggleSidebar = storeAction("toggleSidebar");
export const restoreClosed = storeAction("restoreClosed");
export const openPanel = storeAction("openPanel");
export const closePanel = storeAction("closePanel");
export const setDownloadsOpen = storeAction("setDownloadsOpen");
export const setFind = storeAction("setFind");
export const returnRefusedMove = storeAction("returnRefusedMove");
export const removeDownload = storeAction("removeDownload");
export const clearDownloads = storeAction("clearDownloads");

const SAME_PRESS_MS = 600;
let downloadsPressedAway: { windowId: string; at: number } | null = null;

export function dismissDownloadsByPress(windowId: string) {
  if (!useBrowser.getState().windowUi[windowId]?.downloadsOpen) return;
  downloadsPressedAway = { windowId, at: Date.now() };
  setDownloadsOpen(windowId, false);
  noteDownloadsPanel("pressClose");
}

function downloadsClosedByThisPress(windowId: string, now = Date.now()) {
  const away = downloadsPressedAway;
  downloadsPressedAway = null;
  return !!away && away.windowId === windowId && now - away.at < SAME_PRESS_MS;
}

export function toggleDownloadsOpen(windowId: string) {
  if (downloadsClosedByThisPress(windowId)) return;
  setDownloadsOpen(windowId, !useBrowser.getState().windowUi[windowId]?.downloadsOpen);
}
