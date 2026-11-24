import { useBrowser, type BrowserState } from "../browser/store";
import { activeTabId } from "../browser/model";
import { shownPageId } from "../peek/peek";
import type { Anchor } from "./store";
import { noteToolbarAnchor } from "../telemetry/usage";
import { consentToken } from "../telemetry/client";

type AnchorEntry = { windowId: string; tabId: string; anchor: Anchor; measure: () => Promise<Anchor> };
const toolbarAnchors = new Map<string, AnchorEntry>();
export const DEVELOPER_BAR_ANCHOR = "developerBar";
const anchorKey = (windowId: string, tabId: string, slot: string) => `${windowId}|${tabId}|${slot}`;

const MEASURE_WAIT_MS = 100;
const OFF_TOOLBAR: Anchor = { x: 100_000, y: 13, width: 28, height: 28 };

export const setToolbarAnchor = (windowId: string, tabId: string, slot: string, anchor: Anchor, measure: () => Promise<Anchor>) =>
  void toolbarAnchors.set(anchorKey(windowId, tabId, slot), { windowId, tabId, anchor, measure });

export function dropToolbarAnchor(windowId: string, tabId: string, slot: string, anchor: Anchor) {
  const key = anchorKey(windowId, tabId, slot);
  if (toolbarAnchors.get(key)?.anchor === anchor) toolbarAnchors.delete(key);
}

export function pruneToolbarAnchors(s: BrowserState) {
  if (!toolbarAnchors.size) return;
  for (const [key, entry] of toolbarAnchors) if (!s.windows[entry.windowId] || s.tabs[entry.tabId]?.windowId !== entry.windowId) toolbarAnchors.delete(key);
}

function anchorEntry(windowId: string, extensionId: string, tabId?: string): AnchorEntry | null {
  const s = useBrowser.getState();
  for (const pane of new Set([tabId ?? shownPageId(s, windowId), activeTabId(s, windowId)])) {
    if (!pane) continue;
    const entry = toolbarAnchors.get(anchorKey(windowId, pane, extensionId)) ?? toolbarAnchors.get(anchorKey(windowId, pane, "*")) ?? toolbarAnchors.get(anchorKey(windowId, pane, DEVELOPER_BAR_ANCHOR));
    if (entry) return entry;
  }
  return null;
}

export async function toolbarAnchor(windowId: string, extensionId: string, tabId?: string): Promise<Anchor> {
  const entry = anchorEntry(windowId, extensionId, tabId);
  if (!entry) return OFF_TOOLBAR;
  const cached = entry.anchor;
  const consent = consentToken();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<null>((resolve) => (timer = setTimeout(() => resolve(null), MEASURE_WAIT_MS)));
  const fresh = await Promise.race([entry.measure(), timedOut]);
  clearTimeout(timer);
  if (!fresh) noteToolbarAnchor("missed", consent);
  else if (fresh.x !== cached.x || fresh.y !== cached.y) noteToolbarAnchor("moved", consent);
  return fresh ?? cached;
}
