import type { BrowserState } from "../browser/store";
import { noteAutoHideTabsChosen } from "../telemetry/autoHideTabsChoices";

type AutoHideTabsWindows = Pick<BrowserState, "windows" | "closedWindows">;

export function windowsInLineWithAutoHideTabs(s: Pick<BrowserState, "settings"> & AutoHideTabsWindows, autoHideTabs: boolean | undefined, fromSync: boolean): AutoHideTabsWindows | {} {
  if (autoHideTabs === undefined) return {};
  const unchanged = autoHideTabs === s.settings.autoHideTabs;
  const ownChoice = Object.values(s.windows).some((w) => w.autoHideTabs !== undefined) || s.closedWindows.some((c) => c.window.autoHideTabs !== undefined);
  if (!ownChoice || (unchanged && fromSync)) return {};
  if (unchanged) noteAutoHideTabsChosen();
  return {
    windows: Object.fromEntries(Object.entries(s.windows).map(([id, { autoHideTabs: _, ...w }]) => [id, w])),
    closedWindows: s.closedWindows.map(({ window: { autoHideTabs: _, ...window }, ...c }) => ({ ...c, window })),
  };
}
