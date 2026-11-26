import { useBrowser, type BrowserState } from "../browser/store";
import { pinSection } from "../browser/model";
import type { Tab } from "../browser/types";
import { cleanTileLetters } from "../../lib/tileLetter";
import { noteTileLetters } from "../telemetry/minimalismCounts";
import type { ConsentToken } from "../telemetry/choice";
import { measureRow, setSidebarUi, type Anchor } from "../sidebar/sidebarUi";
import { tabLayoutOf } from "../browser/model";
import type { View } from "react-native";

export const showsTileLetters = (s: Pick<BrowserState, "settings">, tab: Pick<Tab, "pin">): boolean =>
  s.settings.minimalismMode && s.settings.minimalismPinnedIcons === "letters" && pinSection(tab) === "tile";

export function setTileLetters(tabId: string, typed: string | null, consent: ConsentToken | null) {
  const s = useBrowser.getState();
  const tab = s.tabs[tabId];
  if (!tab) return;
  const letters = typed === null ? null : cleanTileLetters(typed);
  if ((letters ?? undefined) === tab.tileLetters) return;
  s.updateTab(tabId, { tileLetters: letters ?? undefined });
  noteTileLetters(letters ? "set" : "reset", consent);
}

const stripTiles = new Map<string, Pick<View, "measureInWindow">>();
const stripKey = (windowId: string, tabId: string) => `${windowId}\u0001${tabId}`;

export function registerStripTile(windowId: string, tabId: string, view: Pick<View, "measureInWindow"> | null) {
  if (view) stripTiles.set(stripKey(windowId, tabId), view);
  else stripTiles.delete(stripKey(windowId, tabId));
}

function measureStripTile(windowId: string, tabId: string): Promise<Anchor | null> {
  const view = stripTiles.get(stripKey(windowId, tabId));
  if (!view) return Promise.resolve(null);
  return new Promise((resolve) => view.measureInWindow((x, y, width, height) => resolve(width ? { x, y, width, height } : null)));
}

const tileAnchor = (windowId: string, tabId: string) =>
  tabLayoutOf(useBrowser.getState(), windowId) === "top" ? measureStripTile(windowId, tabId) : measureRow(windowId, tabId);

export async function openTileLetters(windowId: string, tabId: string) {
  const anchor = await tileAnchor(windowId, tabId);
  if (useBrowser.getState().tabs[tabId]) setSidebarUi({ tileLetters: { windowId, tabId, anchor }, hover: null });
}

export const closeTileLetters = () => setSidebarUi({ tileLetters: null });

export function commitTileLetters(tabId: string, typed: string, consent: ConsentToken | null) {
  setTileLetters(tabId, typed, consent);
  closeTileLetters();
}
