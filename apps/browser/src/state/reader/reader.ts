import { create } from "zustand";
import { webviews } from "../../platform/webviews";
import { withDeadline } from "../../lib/deadline";
import { useBrowser, type BrowserState } from "../browser/store";
import { changedIds } from "../browser/changes";
import { activeTabId } from "../browser/model";
import { peekTabId } from "../peek/peek";
import { showToast } from "../app/toasts";
import { noteReaderCheck, noteReaderNoArticle, noteReaderOpened } from "../telemetry/readerCounts";
import { readerCall, readerCheckCall, readerToggleCall, type ReaderLook, type ReaderReport } from "./readerPage";
import { READER_SIZE_NAMES } from "./tokens";

export type ReaderState = { url: string; available: boolean; active: boolean };

const NONE: ReaderState = { url: "", available: false, active: false };
const CHECK_DELAY_MS = 250;
const RECHECK_MS = 1500;
const SYNC_MS = 1000;
const CALL_DEADLINE_MS = 4000;

export const useReader = create<Record<string, ReaderState | undefined>>()(() => ({}));
export const readerState = (tabId: string): ReaderState => useReader.getState()[tabId] ?? NONE;
export const useReaderState = (tabId: string): ReaderState => useReader((s) => s[tabId] ?? NONE);
export const readerAvailable = (tabId: string) => {
  const state = readerState(tabId);
  return state.active || state.available;
};

const set = (tabId: string, state: ReaderState | undefined) => useReader.setState({ [tabId]: state });
const readable = (url: string | undefined) => !!url && /^(https?|file):/i.test(url);
const withoutHash = (url: string) => url.replace(/#.*$/, "");

function lookFrom(s: BrowserState): ReaderLook {
  const size = READER_SIZE_NAMES.indexOf(s.settings.readerTextSize);
  return { dark: s.ui.appDark, size: size < 0 ? 1 : size, font: s.settings.readerFont };
}

function keepLook(look: ReaderLook | undefined) {
  if (!look) return;
  const s = useBrowser.getState();
  const readerTextSize = READER_SIZE_NAMES[look.size] ?? s.settings.readerTextSize;
  const readerFont = look.font === "sans" ? "sans" : "serif";
  if (readerTextSize !== s.settings.readerTextSize || readerFont !== s.settings.readerFont) s.updateSettings({ readerTextSize, readerFont });
}

async function callPage(tabId: string, code: string): Promise<ReaderReport | null> {
  const web = webviews.get(tabId);
  if (!web) return null;
  return withDeadline(web.evaluate<ReaderReport>(code), CALL_DEADLINE_MS, null).catch(() => null);
}

let lookPushes = 0;

function pushLook(s: BrowserState) {
  lookPushes++;
  const look = lookFrom(s);
  for (const [tabId, state] of Object.entries(useReader.getState())) if (state?.active) void callPage(tabId, readerCall("setLook", look));
}

function settle(tabId: string, url: string, report: ReaderReport, available?: boolean, pushesBefore = lookPushes) {
  const tab = useBrowser.getState().tabs[tabId];
  if (!tab || tab.url !== url) return;
  const before = readerState(tabId);
  set(tabId, { url, available: available ?? before.available, active: report.active });
  if ((report.active || before.active) && pushesBefore === lookPushes) keepLook(report.look);
}

const counted = new Map<string, string>();

async function check(tabId: string) {
  const tab = useBrowser.getState().tabs[tabId];
  if (!tab || !readable(tab.url)) return;
  const url = tab.url;
  const pushes = lookPushes;
  const report = await callPage(tabId, readerCheckCall());
  if (!report) return;
  const available = !!report.readerable;
  const first = counted.get(tabId) !== url;
  if (first) {
    counted.set(tabId, url);
    noteReaderCheck(available);
  }
  settle(tabId, url, report, available, pushes);
  if (first && !available && useBrowser.getState().tabs[tabId]?.url === url) later(tabId, url);
}

const rechecks = new Map<string, ReturnType<typeof setTimeout>>();
function later(tabId: string, url: string) {
  if (rechecks.has(tabId)) return;
  rechecks.set(
    tabId,
    setTimeout(() => {
      rechecks.delete(tabId);
      const s = useBrowser.getState();
      if (s.tabs[tabId]?.url === url && !s.live[tabId]?.isLoading && !readerState(tabId).available) void check(tabId);
    }, RECHECK_MS),
  );
}

export function runReaderCommand(command: string, tabId: string): boolean {
  if (command !== "toggleReader") return false;
  void toggleReader(tabId);
  return true;
}

export async function toggleReader(tabId: string) {
  const s = useBrowser.getState();
  const tab = s.tabs[tabId];
  if (!tab || !readable(tab.url)) return;
  const url = tab.url;
  const pushes = lookPushes;
  const report = await callPage(tabId, readerToggleCall(lookFrom(s)));
  if (!report) return;
  if (report.noArticle) {
    noteReaderNoArticle();
    settle(tabId, url, report, false, pushes);
    showToast(tab.windowId, "No article found on this page", undefined, { icon: "doc.plaintext" });
    return;
  }
  if (report.active) noteReaderOpened();
  settle(tabId, url, report, true, pushes);
}

export async function closeReader(tabId: string) {
  const url = useBrowser.getState().tabs[tabId]?.url;
  if (!url || !readerState(tabId).active) return;
  const pushes = lookPushes;
  const report = await callPage(tabId, readerCall("hide"));
  if (report) settle(tabId, url, report, undefined, pushes);
}

function shownTabIds(s: BrowserState): Set<string> {
  const ids = new Set<string>();
  for (const windowId of s.windowOrder) {
    const active = activeTabId(s, windowId);
    if (active) ids.add(active);
    const peek = peekTabId(s, windowId);
    if (peek) ids.add(peek);
  }
  return ids;
}

const pending = new Map<string, ReturnType<typeof setTimeout>>();
function schedule(tabId: string) {
  if (pending.has(tabId)) return;
  pending.set(
    tabId,
    setTimeout(() => {
      pending.delete(tabId);
      const s = useBrowser.getState();
      const tab = s.tabs[tabId];
      if (tab && readable(tab.url) && !s.live[tabId]?.isLoading && readerState(tabId).url !== tab.url) void check(tabId);
    }, CHECK_DELAY_MS),
  );
}

function forget(tabId: string) {
  for (const timers of [pending, rechecks]) {
    const timer = timers.get(tabId);
    if (timer) clearTimeout(timer);
    timers.delete(tabId);
  }
  counted.delete(tabId);
}

function navigated(tabId: string, from: string, to: string) {
  const before = readerState(tabId);
  if (before === NONE) return;
  if (before.active && withoutHash(from) === withoutHash(to)) return set(tabId, { ...before, url: to });
  if (before.active) void callPage(tabId, readerCall("hide"));
  set(tabId, NONE);
}

async function sync() {
  const s = useBrowser.getState();
  const shown = shownTabIds(s);
  for (const [tabId, state] of Object.entries(useReader.getState())) {
    if (!state?.active || !shown.has(tabId)) continue;
    const pushes = lookPushes;
    const report = await callPage(tabId, readerCall("state"));
    if (report) settle(tabId, state.url, report, undefined, pushes);
  }
}

export function startReader() {
  let timer: ReturnType<typeof setInterval> | null = null;
  let syncing = false;
  const stopTimer = useReader.subscribe((r) => {
    const any = Object.values(r).some((state) => state?.active);
    if (any && !timer) {
      timer = setInterval(() => {
        if (syncing) return;
        syncing = true;
        void sync().finally(() => (syncing = false));
      }, SYNC_MS);
    } else if (!any && timer) {
      clearInterval(timer);
      timer = null;
    }
  });
  const stop = useBrowser.subscribe((s, prev) => {
    if (s.tabs !== prev.tabs) {
      for (const id of changedIds(s.tabs, prev.tabs)) {
        const tab = s.tabs[id];
        const was = prev.tabs[id];
        if (!tab) {
          forget(id);
          if (useReader.getState()[id]) set(id, undefined);
        } else if (was && was.url !== tab.url) navigated(id, was.url, tab.url);
      }
    }
    if (s.live !== prev.live) {
      for (const id of changedIds(s.live, prev.live)) {
        if (prev.live[id]?.isLoading && !s.live[id]?.isLoading && readerState(id).url) set(id, { ...readerState(id), url: "" });
      }
    }
    if (s.ui.appDark !== prev.ui.appDark || s.settings.readerTextSize !== prev.settings.readerTextSize || s.settings.readerFont !== prev.settings.readerFont) pushLook(s);
    if (s.tabs === prev.tabs && s.live === prev.live && s.windows === prev.windows && s.peeks === prev.peeks) return;
    for (const id of shownTabIds(s)) {
      const tab = s.tabs[id];
      if (tab && readable(tab.url) && !s.live[id]?.isLoading && readerState(id).url !== tab.url) schedule(id);
    }
  });
  return () => {
    if (timer) clearInterval(timer);
    stopTimer();
    stop();
  };
}
