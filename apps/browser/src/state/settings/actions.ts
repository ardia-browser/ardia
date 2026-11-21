import type { Shortcut } from "../commands/shortcuts";
import { storeAction, useBrowser } from "../browser/store";
import { tabLayoutOf } from "../browser/model";
import { steppedInterfaceScale } from "../../lib/interfaceScale";
import { noteTabLayoutSwitch } from "../telemetry/tabLayoutCounts";
import type { ConsentToken } from "../telemetry/choice";

export const updateSettings = storeAction("updateSettings");
export const setSearchEngine = storeAction("setSearchEngine");
export const addCustomEngine = storeAction("addCustomEngine");
export const updateCustomEngine = storeAction("updateCustomEngine");
export const removeCustomEngine = storeAction("removeCustomEngine");
export const toggleTabLayout = storeAction("toggleTabLayout");

export function setShortcutOverride(id: string, combo: Shortcut | null) {
  const next = { ...useBrowser.getState().settings.shortcuts };
  if (combo) next[id] = [combo.key, ...combo.modifiers];
  else delete next[id];
  useBrowser.getState().updateSettings({ shortcuts: next });
}

export function chooseTabLayout(layout: "sidebar" | "top") {
  useBrowser.getState().updateSettings({ tabLayout: layout });
  for (const id of Object.keys(useBrowser.getState().windows)) {
    if (tabLayoutOf(useBrowser.getState(), id) !== layout) useBrowser.getState().toggleTabLayout(id);
  }
}

export function switchTabLayout(windowId: string, consent?: ConsentToken | null) {
  const s = useBrowser.getState();
  if (!s.windows[windowId]) return;
  noteTabLayoutSwitch(tabLayoutOf(s, windowId) === "sidebar" ? "top" : "sidebar", consent);
  s.toggleTabLayout(windowId);
}

export function chooseSidebarSide(side: "left" | "right") {
  useBrowser.getState().updateSettings({ sidebarSide: side });
}

export function toggleSidebarSide() {
  chooseSidebarSide(useBrowser.getState().settings.sidebarSide === "right" ? "left" : "right");
}

export function chooseInterfaceScale(scale: number) {
  useBrowser.getState().updateSettings({ interfaceScale: steppedInterfaceScale(scale) });
}
