import type { BrowserState } from "../browser/store";
import { activeTabId, tabsShownIn } from "../browser/model";
import { addressBarInSidebar, minimalismIn } from "../windows/layout";
import { peekShown } from "../windows/dockMotion";
import { usePages } from "../tabs/pageState";

export type BarPlacement = "field" | "centred" | "centredNoField";

export function keyBarPlacement(o: { setting: BrowserState["settings"]["commandBarPlacement"]; small: boolean; fieldShown: boolean }): BarPlacement {
  if (o.small) return "field";
  if (o.setting !== "field") return "centred";
  return o.fieldShown ? "field" : "centredNoField";
}

export function addressFieldShown(s: BrowserState, windowId: string): boolean {
  if (!s.windows[windowId] || minimalismIn(s, windowId)) return false;
  if (addressBarInSidebar(s, windowId)) return tabsShownIn(s, windowId) || peekShown(windowId);
  const tabId = activeTabId(s, windowId);
  return !!tabId && !!s.tabs[tabId]?.url && !usePages.getState().pages[tabId]?.fullscreen;
}

export const commandKeyPlacement = (s: BrowserState, windowId: string): BarPlacement =>
  keyBarPlacement({ setting: s.settings.commandBarPlacement, small: s.windows[windowId]?.kind === "small", fieldShown: addressFieldShown(s, windowId) });

export const clickBarPlacement = (s: BrowserState, windowId: string): BarPlacement =>
  s.settings.commandBarPlacement === "centredOnClick" && s.windows[windowId]?.kind !== "small" ? "centred" : "field";

type PlacementSetting = BrowserState["settings"]["commandBarPlacement"];

export const placementCard = (setting: PlacementSetting): "field" | "centred" => (setting === "field" ? "field" : "centred");

export const placementFromCard = (card: PlacementSetting, current: PlacementSetting): PlacementSetting =>
  card === "centred" && current === "centredOnClick" ? current : card;

export const isCentred = (placement: BarPlacement | undefined) => placement === "centred" || placement === "centredNoField";
