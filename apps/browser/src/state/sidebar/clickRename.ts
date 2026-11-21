import type { GestureResponderEvent } from "react-native";
import { modifiersOf } from "../../lib/keys";
import { activeTabId, isPinnedRow } from "../browser/model";
import { useBrowser } from "../browser/store";
import { consentToken } from "../telemetry/client";
import { noteClickRename } from "../telemetry/sidebarScrollCounts";
import { startRename } from "./actions";
import { sidebarUi } from "./sidebarUi";

export const CLICK_RENAME_DELAY_MS = 500;

let renameTimer: ReturnType<typeof setTimeout> | undefined;
let armedTab: string | null = null;
let lastClick = { tabId: "", at: -Infinity };

const isShownPinnedRow = (windowId: string, tabId: string) => {
  const s = useBrowser.getState();
  return isPinnedRow(s.tabs[tabId]) && activeTabId(s, windowId) === tabId;
};

export function cancelClickRename() {
  clearTimeout(renameTimer);
  renameTimer = undefined;
}

export function armClickRename(windowId: string, tabId: string) {
  cancelClickRename();
  armedTab = isShownPinnedRow(windowId, tabId) ? tabId : null;
}

export function clickRename(windowId: string, tabId: string, click: GestureResponderEvent, windowKey: boolean, now = Date.now()) {
  const secondClick = lastClick.tabId === tabId && now - lastClick.at < CLICK_RENAME_DELAY_MS;
  lastClick = { tabId, at: now };
  const mods = modifiersOf(click);
  if (armedTab !== tabId || secondClick || !windowKey || mods.metaKey || mods.altKey || mods.shiftKey) return;
  const consent = consentToken();
  renameTimer = setTimeout(() => {
    renameTimer = undefined;
    if (!isShownPinnedRow(windowId, tabId) || sidebarUi().renaming) return;
    noteClickRename(consent);
    void startRename(windowId, { kind: "tab", id: tabId });
  }, CLICK_RENAME_DELAY_MS);
}
