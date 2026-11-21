import { switchOrigin, type HostAction } from "../../lib/pluginPageBar";
import { useBrowser } from "../browser/store";
import { showMenu } from "../app/system";
import { activeTabId } from "../browser/model";
import { addressFieldShown, clickBarPlacement } from "../omnibox/barPlacement";
import { openSplitPane } from "../splits/actions";
import { MAX_SPLIT_PANES, splitOf, splitTabIds, type SplitSide } from "../splits/splits";
import { activate } from "../tabs/actions";
import { copyPageUrl } from "../site/selection";
import { togglePopover } from "../tabs/popoverDismiss";
import { webviews } from "../tabs/webviewHandles";
import { notePageBarPress } from "../telemetry/pageBarCounts";
import { publishedPageBar } from "./pageBarPanes";
import type { PageBarMatch } from "./pageBar";
import { confirmedDocument, usePageDocuments } from "./pageBarDocuments";
import { siteSwitchValue } from "./siteSwitches";
import { activeManifest, currentPlugins } from "./store";

function openBarFromPageBar(windowId: string, tabId: string, url: string) {
  if (activeTabId(useBrowser.getState(), windowId) !== tabId) activate(tabId);
  const s = useBrowser.getState();
  s.openPanel(windowId, url, undefined, addressFieldShown(s, windowId) ? clickBarPlacement(s, windowId) : "centredNoField");
}

const SPLIT_SIDES: { side: SplitSide; title: string; symbol: string }[] = [
  { side: "right", title: "Add Right Split", symbol: "rectangle.righthalf.inset.filled" },
  { side: "left", title: "Add Left Split", symbol: "sidebar.left" },
  { side: "top", title: "Add Top Split", symbol: "rectangle.split.1x2" },
  { side: "bottom", title: "Add Bottom Split", symbol: "rectangle.bottomhalf.inset.filled" },
];

export async function showSplitSidesMenu(tabId: string, stillTarget: () => boolean = () => true) {
  const split = splitOf(useBrowser.getState(), tabId);
  const enabled = !split || splitTabIds(split).length < MAX_SPLIT_PANES;
  const item = ({ side, title, symbol }: (typeof SPLIT_SIDES)[number]) => ({ id: side, title, symbol, enabled });
  const choice = await showMenu([...SPLIT_SIDES.slice(0, 2).map(item), { separator: true as const }, ...SPLIT_SIDES.slice(2).map(item)]);
  const picked = SPLIT_SIDES.find((s) => s.side === choice);
  const tab = useBrowser.getState().tabs[tabId];
  if (picked && tab && stillTarget()) openSplitPane(tab.windowId, { anchorTabId: tabId, side: picked.side });
}

function targetOf(windowId: string, tabId: string, action: HostAction, document?: { url: string; at: number }): PageBarMatch | null {
  const match = publishedPageBar(windowId, tabId);
  const tab = useBrowser.getState().tabs[tabId];
  if (!match || !tab || tab.windowId !== windowId || !match.spec.buttons.includes(action)) return null;
  const live = confirmedDocument(usePageDocuments.getState(), tabId);
  if (!live || live.url !== match.url || live.at !== match.at) return null;
  if (document && (live.url !== document.url || live.at !== document.at)) return null;
  const spec = activeManifest(currentPlugins(), match.plugin)?.pageBar;
  const origin = switchOrigin(live.url);
  if (!spec?.when.siteSwitch || !origin || siteSwitchValue(currentPlugins(), match.plugin, spec.when.siteSwitch, origin) !== true) return null;
  return match;
}

export function runHostAction(action: HostAction, windowId: string, tabId: string) {
  const match = targetOf(windowId, tabId, action);
  if (!match) return;
  notePageBarPress(action);
  switch (action) {
    case "siteControls":
      return togglePopover(tabId, "siteControls");
    case "address":
      return openBarFromPageBar(windowId, tabId, match.url);
    case "copyLink":
      return void copyPageUrl(tabId, match.url);
    case "console":
    case "network":
    case "inspect":
      return void webviews.get(tabId)?.showDevTools(action);
    case "split":
      return void showSplitSidesMenu(tabId, () => targetOf(windowId, tabId, action, match) !== null);
    case "extensions":
      return;
  }
}

export const hostActionTarget = (action: HostAction, windowId: string, tabId: string): boolean => targetOf(windowId, tabId, action) !== null;
