import { useBrowser, type BrowserState } from "../browser/store";
import { isWindowClosing } from "../windows/closingWindows";
import type { Frame } from "../browser/types";
import type { TabPlacement } from "../pins/placing";
import { isRegularWindow } from "../windows/small";
import { installDroppedCrx } from "../extensions/crxDrop";
import { activeTabId } from "../browser/model";
import { splitOf, splitTabIdsOf } from "../splits/splits";
import { currentInterfaceScale } from "../settings/interfaceScale";
import { withoutEmptyFolderRows } from "../groups/emptyFolder";

const NEW_WINDOW_GRAB = { x: 90, y: 70 };

export function screenPoint(s: BrowserState, windowId: string, x: number, y: number, live?: Frame | null, scale = currentInterfaceScale()): [number, number] | null {
  const frame = live ?? s.windows[windowId]?.frame;
  if (!frame) return null;
  return [frame[0] + x * scale, frame[1] + frame[3] - y * scale];
}

export function rootPointIn(frame: Frame, [screenX, screenY]: [number, number], scale = currentInterfaceScale()): [number, number] {
  return [(screenX - frame[0]) / scale, (frame[1] + frame[3] - screenY) / scale];
}

const contains = (frame: Frame, [px, py]: [number, number]) => px >= frame[0] && px <= frame[0] + frame[2] && py >= frame[1] && py <= frame[1] + frame[3];

export function windowUnder(s: BrowserState, source: string, x: number, y: number, live?: Frame | null): { outside: boolean; overWindow: string | null } {
  const from = s.windows[source];
  const frame = live ?? from?.frame;
  const scale = currentInterfaceScale();
  const outside = !!frame && (x < 0 || y < 0 || x * scale > frame[2] || y * scale > frame[3]);
  const point = outside ? screenPoint(s, source, x, y, live) : null;
  if (!point || !from || from.kind === "private") return { outside, overWindow: null };
  const overWindow = s.ui.focusOrder.find((id) => {
    const w = s.windows[id];
    return isRegularWindow(w) && id !== source && !isWindowClosing(id) && !!w.frame && contains(w.frame, point);
  });
  return { outside, overWindow: overWindow ?? null };
}

export function dropTabsOutside(
  dragged: string[],
  source: string,
  x: number,
  y: number,
  onNewWindow?: (frame: Frame) => void,
  live?: Frame | null,
): string | null {
  const s = useBrowser.getState();
  const from = s.windows[source];
  const tabIds = withoutEmptyFolderRows(s, dragged);
  if (!from || from.kind === "private" || !tabIds.length) return null;
  const { overWindow } = windowUnder(s, source, x, y, live);
  if (overWindow) {
    s.moveTabsToWindow(tabIds, overWindow);
    return overWindow;
  }
  const point = screenPoint(s, source, x, y, live);
  if (!point || from.tabIds.every((id) => tabIds.includes(id))) return null;
  const [, , width, height] = from.frame ?? [0, 0, 1200, 800];
  const scale = currentInterfaceScale();
  const frame: Frame = [Math.round(point[0] - NEW_WINDOW_GRAB.x * scale), Math.round(point[1] - height + NEW_WINDOW_GRAB.y * scale), width, height];
  onNewWindow?.(frame);
  return s.createWindow({ profileId: s.tabs[tabIds[0]!]?.profileId, tabIds, frame });
}

export function openDroppedUrls(windowId: string, profileId: string, placement: TabPlacement | null, urls: string[]): string[] {
  const s = useBrowser.getState();
  const w = s.windows[windowId];
  if (!urls.length || !w || !(s.profiles[profileId] || w.profileId === profileId)) return [];
  const paged = w.profileId !== profileId;
  const ids = urls.map((url, i) => s.newTab(windowId, { url, background: paged || i > 0, profileId })).filter(Boolean);
  if (ids.length && placement && !paged) useBrowser.getState().placeTabs(ids, placement);
  return ids;
}

export type DroppedEntry = { kind: "file"; url: string } | { kind: "url"; url: string } | { kind: "text"; text: string };

export function droppedInputs(items: DroppedEntry[]): string[] {
  return items.flatMap((item) => {
    if (item.kind === "file") return /^file:\/\/\/[^/]/i.test(item.url) ? [item.url] : [];
    const input = item.kind === "url" ? item.url.trim() : item.text.trim();
    return input ? [input] : [];
  });
}

export function showsNewTab(s: BrowserState, tabId: string): boolean {
  const tab = s.tabs[tabId];
  if (!tab || tab.url) return false;
  const shown = activeTabId(s, tab.windowId);
  return shown === tabId || !!splitTabIdsOf(splitOf(s, shown))?.includes(tabId);
}

export function openDroppedInTab(tabId: string, items: DroppedEntry[]): void {
  const s = useBrowser.getState();
  const tab = s.tabs[tabId];
  if (!tab || !showsNewTab(s, tabId)) return;
  const [first, ...rest] = installDroppedCrx(tab.windowId, droppedInputs(items));
  if (!first) return;
  s.navigate(tabId, first);
  let previous: string | undefined;
  for (const input of rest) {
    const now = useBrowser.getState();
    const at = previous ? (now.windows[tab.windowId]?.tabIds.indexOf(previous) ?? -1) + 1 : 0;
    const id = now.newTab(tab.windowId, { url: input, background: true, profileId: tab.profileId, ...(at > 0 ? { index: at } : {}) });
    if (id) previous = id;
  }
}
