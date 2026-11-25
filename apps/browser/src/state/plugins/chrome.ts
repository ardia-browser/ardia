import { createContext, useContext } from "react";
import { activeManifest, activeNames, currentPlugins, usePlugins, type PluginsStore } from "./store";
import { usePluginSurfaces, type PluginSurfacesStore } from "./surfaces";

export const PLUGIN_CHROME = { toolbar: 1, sidebar: 2, panels: 4, overlays: 8, verificationCodes: 16, pageBars: 32 } as const;

type Contributing = Pick<PluginsStore, "listings" | "records" | "order">;

let measured: Contributing | null = null;
let measuredParts = 0;

export function contributedChrome(s: Contributing): number {
  if (measured && measured.listings === s.listings && measured.records === s.records && measured.order === s.order) return measuredParts;
  let parts = 0;
  for (const name of activeNames(s)) {
    const contributes = activeManifest(s, name)!.contributes;
    if (contributes.toolbar.length) parts |= PLUGIN_CHROME.toolbar;
    if (contributes.sidebarViews.length) parts |= PLUGIN_CHROME.sidebar;
    if (contributes.panels.some((p) => p.mode === "sidecar")) parts |= PLUGIN_CHROME.panels;
    if (contributes.passwordManager?.verificationCodeSetup) parts |= PLUGIN_CHROME.verificationCodes;
    if (contributes.pageBar) parts |= PLUGIN_CHROME.pageBars;
  }
  measured = { listings: s.listings, records: s.records, order: s.order };
  measuredParts = parts;
  return parts;
}

export const pageBarsWanted = (): boolean => (contributedChrome(currentPlugins()) & PLUGIN_CHROME.pageBars) !== 0;

function shownChrome(s: PluginSurfacesStore, windowId: string): number {
  let parts = 0;
  if (s.sidePanels[windowId] || s.retainedSidePanels[windowId]?.length) parts |= PLUGIN_CHROME.panels;
  if (s.popovers[windowId] || s.commandViews[windowId] || s.quickPick?.windowId === windowId || s.inputBox?.windowId === windowId) parts |= PLUGIN_CHROME.overlays;
  return parts;
}

export function usePluginChromeOf(windowId: string): number {
  const contributed = usePlugins(contributedChrome);
  const shown = usePluginSurfaces((s) => shownChrome(s, windowId));
  return contributed | shown;
}

export const PluginChromeContext = createContext(0);

export const usePluginChrome = (part: number): boolean => (useContext(PluginChromeContext) & part) !== 0;
