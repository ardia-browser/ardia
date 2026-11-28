import type { BrowserState } from "../browser/store";
import { autoHidesTabsIn, collapsedStyleIn } from "../browser/model";
import type { CollapsedSidebar } from "../browser/types";
import { noteAutoHideTabsChosen } from "../telemetry/autoHideTabsChoices";

type WindowsPart = Pick<BrowserState, "windows" | "settings">;

export function withSidebarCollapsed(s: WindowsPart, windowId: string, collapsed: boolean, style?: CollapsedSidebar): Partial<Pick<BrowserState, "windows">> {
  const w = s.windows[windowId];
  const restyled = !!style && collapsedStyleIn(s, windowId) !== style;
  if (!w || w.kind === "small" || (autoHidesTabsIn(s, windowId) === collapsed && !restyled)) return {};
  if (autoHidesTabsIn(s, windowId) !== collapsed) noteAutoHideTabsChosen();
  const { autoHideTabs: _, collapsedSidebar: ownStyle, ...rest } = w;
  const kept = style ?? ownStyle;
  return {
    windows: {
      ...s.windows,
      [windowId]: { ...rest, ...(collapsed === s.settings.autoHideTabs ? {} : { autoHideTabs: collapsed }), ...(kept && kept !== s.settings.collapsedSidebar ? { collapsedSidebar: kept } : {}) },
    },
  };
}

export function withIconsForWidth(s: WindowsPart, windowId: string, on: boolean): Partial<Pick<BrowserState, "windows">> {
  const w = s.windows[windowId];
  if (!w || w.kind === "small" || !!w.iconsForWidth === on) return {};
  const { iconsForWidth: _, ...rest } = w;
  return { windows: { ...s.windows, [windowId]: on ? { ...rest, iconsForWidth: true } : rest } };
}
