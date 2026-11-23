import { create } from "zustand";
import { useBrowser, type BrowserState } from "../browser/store";
import { activeTabId } from "../browser/model";
import { liveOf, onLiveChange } from "../tabs/tabLive";
import { isWebPageUrl } from "../../lib/url";
import { jsStartedAt } from "../telemetry/jsStart";

type LaunchRowsRelease = "loaded" | "nopage" | "deadline" | "scroll" | "drag" | "profile" | "reveal" | "late";

export const HOLD_MS = 1000;
export const HOLD_WITHOUT_PAGE_MS = 250;
export const LATE_MS = 3000;
const MAX_REPORTED_ROWS = 5000;
const MAX_REPORTED_MS = 60_000;

type Held = { tab: string | null; profileId: string | undefined; loading: boolean };

const useLaunchRows = create<{ started: boolean; held: Record<string, true> }>()(() => ({ started: false, held: {} }));

const holdingIn = (s: { started: boolean; held: Record<string, true> }, windowId: string) => s.started && !!s.held[windowId];

export const useLaunchRowsHolding = (windowId: string) => useLaunchRows((s) => holdingIn(s, windowId));

export const launchRowsHolding = (windowId: string) => holdingIn(useLaunchRows.getState(), windowId);

export const launchRowsStarted = () => useLaunchRows.getState().started;

export const joinsLaunchRows = (windowId: string) => !launchRowsStarted() || launchRowsHolding(windowId);

const windows = new Map<string, Held>();
let startedAt: number | null = null;
let firstRelease: LaunchRowsRelease | null = null;
let laterRows = 0;
let growing = 0;
let cancelled = 0;
let mountedAt: number | null = null;
let timers: ReturnType<typeof setTimeout>[] = [];
let stops: (() => void)[] = [];
let now = () => Date.now();
let restored: string[] | null = null;
let jsStart = jsStartedAt;

export const noteRestoredWindows = (windowIds: string[]) => void (restored = [...windowIds]);

export const noteRestoredWindowsNow = () => noteRestoredWindows(useBrowser.getState().windowOrder);

export function releaseLaunchRows(windowId: string, by: LaunchRowsRelease | null) {
  if (!windows.delete(windowId)) return;
  if (by) firstRelease ??= by;
  const { [windowId]: _, ...held } = useLaunchRows.getState().held;
  useLaunchRows.setState({ held });
  if (!windows.size) stopWatching();
}

function stopWatching() {
  timers.forEach(clearTimeout);
  timers = [];
  stops.forEach((stop) => stop());
  stops = [];
}

function launchTabOf(s: BrowserState, windowId: string): string | null {
  const tabId = activeTabId(s, windowId);
  const url = tabId ? s.tabs[tabId]?.url : undefined;
  return tabId && url && isWebPageUrl(url) && s.tabs[tabId]!.page.kind !== "frozen" ? tabId : null;
}

function watch() {
  stops.push(
    onLiveChange((id, live) => {
      const s = useBrowser.getState();
      for (const [windowId, held] of windows) {
        if (held.tab !== id) continue;
        if (!s.windows[windowId] || s.tabs[id]?.windowId !== windowId) releaseLaunchRows(windowId, null);
        else if (live.isLoading) held.loading = true;
        else if (held.loading) releaseLaunchRows(windowId, "loaded");
      }
    }),
    useBrowser.subscribeTo(["windows", "tabs"], (s) => {
      for (const [windowId, held] of windows) {
        const w = s.windows[windowId];
        if (!w || (held.tab && s.tabs[held.tab]?.windowId !== windowId)) releaseLaunchRows(windowId, null);
        else if (w.profileId !== held.profileId) releaseLaunchRows(windowId, "profile");
      }
    }),
  );
}

export function startLaunchRows() {
  if (useLaunchRows.getState().started) return;
  startedAt = now();
  const late = startedAt - jsStart > LATE_MS;
  const s = useBrowser.getState();
  const held: Record<string, true> = {};
  if (!late) {
    for (const windowId of restored ?? s.windowOrder) {
      const w = s.windows[windowId];
      if (!w || w.kind === "small") continue;
      const tab = launchTabOf(s, windowId);
      windows.set(windowId, { tab, profileId: w.profileId, loading: !!tab && liveOf(tab).isLoading });
      held[windowId] = true;
    }
  }
  firstRelease = late ? "late" : windows.size ? null : "loaded";
  useLaunchRows.setState({ started: true, held });
  if (!windows.size) return;
  watch();
  const withPage = [...windows].filter(([, h]) => h.tab).map(([id]) => id);
  const withoutPage = [...windows].filter(([, h]) => !h.tab).map(([id]) => id);
  if (withoutPage.length) timers.push(setTimeout(() => withoutPage.forEach((id) => releaseLaunchRows(id, "nopage")), HOLD_WITHOUT_PAGE_MS));
  if (withPage.length) timers.push(setTimeout(() => withPage.forEach((id) => releaseLaunchRows(id, "deadline")), HOLD_MS));
}

export function noteLaunchRowsDeferred(rows: number) {
  if (rows <= 0) return;
  laterRows += rows;
  growing += 1;
}

function settleOne() {
  if (growing <= 0) return;
  growing -= 1;
  if (!growing && !cancelled) mountedAt = now();
}

export const noteLaunchRowsMounted = () => settleOne();

export function noteLaunchRowsCancelled() {
  if (growing <= 0) return;
  cancelled += 1;
  settleOne();
}

export const launchRowsSettled = () => !useLaunchRows.getState().started || (!windows.size && growing === 0);

export function launchRowsReport(): { later: number; ms: number | null; release: LaunchRowsRelease | null } {
  const ms = laterRows && mountedAt !== null && startedAt !== null ? Math.max(0, Math.round(mountedAt - startedAt)) : null;
  return { later: Math.min(laterRows, MAX_REPORTED_ROWS), ms: ms !== null && ms < MAX_REPORTED_MS ? ms : null, release: firstRelease };
}

export function launchRowsFields() {
  const { later, ms, release } = launchRowsReport();
  return { sidebar_rows_later: later, sidebar_rows_ms: ms, sidebar_rows_release: release };
}

export function resetLaunchRowsForTests(clock?: () => number) {
  stopWatching();
  windows.clear();
  startedAt = mountedAt = null;
  firstRelease = null;
  laterRows = growing = cancelled = 0;
  restored = null;
  now = clock ?? (() => Date.now());
  jsStart = now();
  useLaunchRows.setState({ started: false, held: {} });
}
