import type { Shortcut } from "../commands/shortcuts";
import { storeAction, useBrowser } from "../browser/store";
import { tabLayoutOf } from "../browser/model";
import { steppedInterfaceScale } from "../../lib/interfaceScale";
import { noteTabLayoutSwitch } from "../telemetry/tabLayoutCounts";
import type { ConsentToken } from "../telemetry/choice";
import { noteSettingsPick } from "../telemetry/settingsPickerCounts";
import type { Settings } from "./settings";

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

export function chooseAddressBar(addressBar: Settings["addressBar"]) {
  useBrowser.getState().updateSettings({ addressBar });
  noteSettingsPick("addressBar", addressBar);
}

export function chooseScrollToolbar(hideToolbarWhileScrolling: boolean) {
  useBrowser.getState().updateSettings({ hideToolbarWhileScrolling });
  noteSettingsPick("scrollToolbar", hideToolbarWhileScrolling ? "hide" : "keep");
}

export function chooseCommandBarPlacement(commandBarPlacement: Settings["commandBarPlacement"]) {
  useBrowser.getState().updateSettings({ commandBarPlacement });
  noteSettingsPick("commandBar", commandBarPlacement === "field" ? "field" : "centred");
}

export function setMouseShortcut(id: string, button: Shortcut | null) {
  const next = { ...useBrowser.getState().settings.mouseShortcuts };
  if (button) next[id] = [button.key, ...button.modifiers];
  else delete next[id];
  useBrowser.getState().updateSettings({ mouseShortcuts: next });
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
