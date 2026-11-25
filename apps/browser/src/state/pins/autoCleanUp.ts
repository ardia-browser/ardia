import { useBrowser, type BrowserState } from "../browser/store";
import { activeTabId } from "../browser/model";
import { changedIds } from "../browser/changes";
import { hiddenProfileIdsIn, hiddenSweepLimits, nextCleanUpAt, noteDeselectedTabs } from "./tabCleanup";
import { noteAutoCleanUp } from "../telemetry/cleanUpCounts";

const RECHECK_MS = 30 * 60 * 1000;
const RETRY_FLOOR_MS = 1000;

let timer: ReturnType<typeof setTimeout> | null = null;
let unsubscribe: (() => void) | null = null;

const inactiveForMs = (s: BrowserState) => {
  const minutes = s.settings.cleanUpInactiveTabsAfterMinutes;
  return minutes === null ? null : minutes * 60_000;
};

export function nextAutoCleanUpAt(s: BrowserState, now = Date.now(), sweptAt = -Infinity): number | null {
  const after = inactiveForMs(s);
  if (after === null) return null;
  let next = now + Math.min(after, RECHECK_MS);
  for (const id of s.windowOrder) {
    for (const profileId of [undefined, ...hiddenProfileIdsIn(s, id)]) next = Math.min(next, nextCleanUpAt(s, id, after, profileId, sweptAt));
  }
  return next;
}

function schedule(sweptAt?: number) {
  if (timer) clearTimeout(timer);
  timer = null;
  const now = Date.now();
  const at = nextAutoCleanUpAt(useBrowser.getState(), now, sweptAt);
  if (at !== null) timer = setTimeout(cleanUpDue, Math.max(sweptAt === undefined ? 0 : RETRY_FLOOR_MS, at - now));
}

function cleanUpWindow(windowId: string, after: number, hiddenProfilesUpTo?: number) {
  const before = useBrowser.getState();
  const shown = before.windows[windowId]?.profileId;
  const hidden = (before.windows[windowId]?.tabIds ?? []).filter((id) => before.tabs[id]?.profileId !== shown);
  const cleaned = before.cleanUpTabs(windowId, { inactiveForMs: after, hiddenProfilesUpTo });
  if (!cleaned) return;
  const tabs = useBrowser.getState().tabs;
  noteAutoCleanUp(cleaned, hidden.filter((id) => !tabs[id]).length);
}

function sweep(after: number) {
  for (const id of useBrowser.getState().windowOrder) cleanUpWindow(id, after);
  for (const [id, limit] of hiddenSweepLimits(useBrowser.getState(), after)) cleanUpWindow(id, after, limit);
}

function cleanUpDue() {
  timer = null;
  const sweptAt = Date.now();
  const after = inactiveForMs(useBrowser.getState());
  if (after !== null) sweep(after);
  schedule(sweptAt);
}

function deselectedTabs(s: BrowserState, prev: BrowserState): string[] {
  const left: string[] = [];
  for (const id of changedIds(s.windows, prev.windows)) {
    const was = activeTabId(prev, id);
    if (was && was !== activeTabId(s, id)) left.push(was);
  }
  return left;
}

export function startAutoCleanUp() {
  if (unsubscribe) return;
  unsubscribe = useBrowser.subscribeTo(["windows", "settings"], (s, prev) => {
    if (s.windows !== prev.windows) {
      const left = deselectedTabs(s, prev);
      if (left.length) noteDeselectedTabs(s, left);
    }
    if (inactiveForMs(s) !== inactiveForMs(prev)) schedule();
  });
  schedule();
}

export function stopAutoCleanUp() {
  unsubscribe?.();
  unsubscribe = null;
  if (timer) clearTimeout(timer);
  timer = null;
}
