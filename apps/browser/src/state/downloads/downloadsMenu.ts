import { showMenu, type MenuItem } from "../../platform/menus";
import { useBrowser, type BrowserState } from "../browser/store";
import { menuShortcut } from "../commands/commandShortcuts";
import { menuSections as sections } from "../app/menuSections";
import { noteDownloadsPanel } from "../telemetry/downloadsPanelCounts";
import { consentToken } from "../telemetry/client";
import type { ConsentToken } from "../telemetry/choice";
import { downloadsIn } from "./downloadsSlice";

export const hasClearableDownloads = (s: BrowserState, windowId: string) => downloadsIn(s, windowId).some((d) => d.state !== "downloading");

export function downloadsMenuItems(s: BrowserState, windowId: string): MenuItem[] {
  return sections(
    [{ id: "downloads:show", title: "Show Downloads", symbol: "arrow.down.circle", ...menuShortcut("downloads", s) }],
    [{ id: "downloads:clear", title: "Clear Downloads", symbol: "xmark.circle", enabled: hasClearableDownloads(s, windowId) }],
  );
}

export function runDownloadsMenuChoice(windowId: string, choice: string | null, consent: ConsentToken | null) {
  const s = useBrowser.getState();
  if (choice === "downloads:show") {
    if (!s.windowUi[windowId]?.downloadsOpen) s.setDownloadsOpen(windowId, true);
  } else if (choice === "downloads:clear" && hasClearableDownloads(s, windowId)) {
    noteDownloadsPanel("menuClear", consent);
    s.setDownloadsOpen(windowId, false);
    s.clearDownloads(windowId);
  }
}

const shownProfileOf = (windowId: string) => useBrowser.getState().windows[windowId]?.profileId;

export async function openDownloadsMenu(windowId: string) {
  const consent = consentToken();
  const profileId = shownProfileOf(windowId);
  if (!profileId) return;
  const choice = await showMenu(downloadsMenuItems(useBrowser.getState(), windowId));
  if (shownProfileOf(windowId) !== profileId) return;
  runDownloadsMenuChoice(windowId, choice, consent);
}
