import type { OutsidePressEvent } from "../../platform/windows";
import { storeAction, useBrowser } from "../browser/store";
import { forgetThumbnails } from "../app/thumbnails";
import { noteDownloadsPanel } from "../telemetry/downloadsPanelCounts";

export const toggleSidebar = storeAction("toggleSidebar");
export const restoreClosed = storeAction("restoreClosed");
export const openPanel = storeAction("openPanel");
export const closePanel = storeAction("closePanel");
export const setDownloadsOpen = storeAction("setDownloadsOpen");
export const setFind = storeAction("setFind");
export const returnRefusedMove = storeAction("returnRefusedMove");
export const removeDownload = storeAction("removeDownload");
const clearListedDownloads = storeAction("clearDownloads");

export function clearDownloads(windowId?: string) {
  const before = useBrowser.getState().downloads;
  clearListedDownloads(windowId);
  const kept = new Set(useBrowser.getState().downloads);
  forgetThumbnails(before.filter((d) => !kept.has(d)).map((d) => d.path));
}

let downloadsPressedAway: { windowId: string; pressedAt: number } | null = null;

export function dismissDownloadsByPress(windowId: string, press: OutsidePressEvent) {
  if (!useBrowser.getState().windowUi[windowId]?.downloadsOpen) return;
  const pressedAt = press.nativeEvent.timestamp;
  downloadsPressedAway = pressedAt === undefined ? null : { windowId, pressedAt };
  setDownloadsOpen(windowId, false);
  noteDownloadsPanel("pressClose");
}

function downloadsClosedByThisPress(windowId: string, pressedAt: number | undefined) {
  const away = downloadsPressedAway;
  downloadsPressedAway = null;
  return pressedAt !== undefined && away?.windowId === windowId && away.pressedAt === pressedAt;
}

export function toggleDownloadsOpen(windowId: string, pressedAt?: number) {
  if (downloadsClosedByThisPress(windowId, pressedAt)) return;
  setDownloadsOpen(windowId, !useBrowser.getState().windowUi[windowId]?.downloadsOpen);
}
