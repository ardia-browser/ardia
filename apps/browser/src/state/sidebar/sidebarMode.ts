import { useBrowser } from "../browser/store";
import { iconsForWidth } from "../../lib/windowLayout";
import { autoHidesTabsIn, tabLayoutOf } from "../browser/model";
import { noteIconsForWidth, noteSidebarDragSnap } from "../telemetry/dockCounts";

const store = () => useBrowser.getState();

export function collapseWindowToIcons(windowId: string) {
  if (!store().windows[windowId]) return;
  store().setSidebarCollapsed(windowId, true, "icons");
  noteSidebarDragSnap("icons");
}

export function expandWindowSidebar(windowId: string) {
  if (!store().windows[windowId]) return;
  store().setSidebarCollapsed(windowId, false);
  noteSidebarDragSnap("full");
}

export function followWindowWidth(windowId: string, windowWidth: number | undefined) {
  const s = store();
  const w = s.windows[windowId];
  if (!w || w.kind === "small" || !windowWidth) return;
  const on = iconsForWidth(s.settings.sidebarWidth, windowWidth, !!w.iconsForWidth);
  if (on === !!w.iconsForWidth) return;
  s.setIconsForWidth(windowId, on);
  if (!autoHidesTabsIn(s, windowId) && tabLayoutOf(s, windowId) === "sidebar") noteIconsForWidth(on);
}
