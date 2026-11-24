import type { Settings } from "../settings/settings";
import { useBrowser } from "../browser/store";
import { useSettings } from "../browser/hooks";
import { noteDeveloperModeToggled } from "../telemetry/developerModeCounts";
import { showMenu } from "../app/system";
import { openSplitPane } from "../splits/actions";
import { MAX_SPLIT_PANES, splitOf, splitTabIds, type SplitSide } from "../splits/splits";
import { addressFieldShown, clickBarPlacement } from "../omnibox/barPlacement";
import { activate } from "../tabs/actions";
import { activeTabId } from "../browser/model";

type DeveloperModeSites = Settings["developerModeSites"];

const WEB_HOST = /^https?:\/\/(?:[^@/?#]*@)?(\[[0-9a-f:.]+\]|[^:/?#]+)/i;
const LOOPBACK_HOST = /^(?:localhost|[^/?#:@\s]+\.localhost|127(?:\.\d{1,3}){1,3}|0\.0\.0\.0|\[::1\])$/i;

export function developerModeHost(url: string): string | null {
  const host = WEB_HOST.exec(url)?.[1];
  return host ? host.toLowerCase().replace(/\.$/, "") : null;
}

export const isLoopbackHost = (host: string): boolean => LOOPBACK_HOST.test(host);

export function developerModeOn(sites: DeveloperModeSites | undefined, url: string): boolean {
  const host = developerModeHost(url);
  if (!host) return false;
  return sites && Object.hasOwn(sites, host) ? sites[host]! : false;
}

export function developerModeSitesWith(sites: DeveloperModeSites, host: string, on: boolean): DeveloperModeSites {
  const next: DeveloperModeSites = { ...sites, [host]: on };
  if (!on) delete next[host];
  return next;
}

export const canChooseDeveloperMode = (url: string): boolean => developerModeHost(url) !== null;

export function setDeveloperMode(url: string, on: boolean) {
  const host = developerModeHost(url);
  if (!host) return;
  const s = useBrowser.getState();
  if (developerModeOn(s.settings.developerModeSites, url) === on) return;
  s.updateSettings({ developerModeSites: developerModeSitesWith(s.settings.developerModeSites, host, on) });
  noteDeveloperModeToggled(on, isLoopbackHost(host));
}

export function openBarFromDeveloperBar(windowId: string, tabId: string, url: string) {
  if (activeTabId(useBrowser.getState(), windowId) !== tabId) activate(tabId);
  const s = useBrowser.getState();
  s.openPanel(windowId, url, undefined, addressFieldShown(s, windowId) ? clickBarPlacement(s, windowId) : "centredNoField");
}

export const DEVELOPER_BAR_IN_CORE = false;

export const useDeveloperMode = (url: string): boolean => useSettings((s) => DEVELOPER_BAR_IN_CORE && developerModeOn(s.developerModeSites, url));

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
