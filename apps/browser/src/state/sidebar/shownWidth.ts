import { useBrowser, type BrowserState } from "../browser/store";
import { shownSidebarWidth, sidebarWidthLimit, textScaledSidebarWidth } from "../../lib/windowLayout";
import { sidebarTextScale } from "../../lib/themeLook";
import type { SettingsMeta } from "../settings/settings";
import { useWindowRootWidth, windowRootWidth } from "../windows/rootSize";

type WidthState = Pick<BrowserState, "settings" | "settingsMeta">;

export const windowWidthOf = (s: Pick<BrowserState, "windows">, windowId: string): number | undefined => windowRootWidth(s, windowId);

export const sidebarWidthFollowsText = (meta: SettingsMeta): boolean => !meta.chosen.includes("sidebarWidth") && !meta.inferred.includes("sidebarWidth");

export const savedSidebarWidth = (s: WidthState): number =>
  sidebarWidthFollowsText(s.settingsMeta) ? textScaledSidebarWidth(s.settings.sidebarWidth, sidebarTextScale(s.settings.sidebarTextSize)) : s.settings.sidebarWidth;

export const sidebarWidthIn = (s: BrowserState, windowId: string): number => shownSidebarWidth(savedSidebarWidth(s), windowWidthOf(s, windowId));

export const keptSidebarWidth = (dragged: number, limit: number, saved = savedSidebarWidth(useBrowser.getState())): number => (dragged >= limit ? Math.max(dragged, saved) : dragged);

export function useShownSidebarWidth(windowId: string): number {
  const saved = useBrowser(savedSidebarWidth);
  return shownSidebarWidth(saved, useWindowRootWidth(windowId));
}

export function useSidebarWidthLimit(windowId: string): number {
  return sidebarWidthLimit(useWindowRootWidth(windowId));
}
