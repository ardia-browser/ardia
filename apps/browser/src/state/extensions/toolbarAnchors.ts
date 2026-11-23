import { useBrowser, type BrowserState } from "../browser/store";
import { activeTabId } from "../browser/model";
import { shownPageId } from "../peek/peek";
import type { Anchor } from "./store";
import { noteToolbarAnchor } from "../telemetry/usage";
import { consentToken } from "../telemetry/client";

type AnchorEntry = { windowId: string; tabId: string; slot: string; anchor: Anchor; measure: () => Promise<Anchor> };
const toolbarAnchors = new Map<string, AnchorEntry>();
const queuedToolbarContexts = new Set<string>();
export const DEVELOPER_BAR_ANCHOR = "developerBar";
const anchorKey = (windowId: string, tabId: string, slot: string) => `${windowId}|${tabId}|${slot}`;

const MEASURE_WAIT_MS = 100;
const OFF_TOOLBAR: Anchor = { x: 100_000, y: 13, width: 28, height: 28 };

function queueToolbarContext(windowId: string) {
  if (Platform.OS !== "windows" || queuedToolbarContexts.has(windowId)) return;
  queuedToolbarContexts.add(windowId);
  void Promise.resolve().then(() => {
    queuedToolbarContexts.delete(windowId);
    const s = useBrowser.getState();
    if (!s.windows[windowId]) return;
    const tabId = shownPageId(s, windowId) ?? "";
    const anchors: Record<string, Anchor> = Object.fromEntries(
      [...toolbarAnchors.values()]
        .filter((entry) => entry.windowId === windowId && entry.tabId === tabId && entry.slot !== "*" && entry.slot !== DEVELOPER_BAR_ANCHOR)
        .map((entry) => [entry.slot, entry.anchor]),
    );
    void call("extensions.toolbarContext", { windowId, tabId, anchors }).catch(() => {});
  });
}

export function syncWindowsToolbarContexts(s: BrowserState, prev?: BrowserState) {
  if (Platform.OS !== "windows") return;
  for (const id of s.windowOrder) {
    if (!prev?.windows[id] || shownPageId(s, id) !== shownPageId(prev, id)) queueToolbarContext(id);
  }
}

export function setToolbarAnchor(windowId: string, tabId: string, slot: string, anchor: Anchor, measure: () => Promise<Anchor>) {
  const key = anchorKey(windowId, tabId, slot);
  const last = toolbarAnchors.get(key)?.anchor;
  toolbarAnchors.set(key, { windowId, tabId, slot, anchor, measure });
  if (!last || last.x !== anchor.x || last.y !== anchor.y || last.width !== anchor.width || last.height !== anchor.height) queueToolbarContext(windowId);
}

export function dropToolbarAnchor(windowId: string, tabId: string, slot: string, anchor: Anchor) {
  const key = anchorKey(windowId, tabId, slot);
  if (toolbarAnchors.get(key)?.anchor === anchor) {
    toolbarAnchors.delete(key);
    queueToolbarContext(windowId);
  }
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
import { Platform } from "react-native";
import { call } from "../../platform/engine";
