import { ardiaError } from "@ardia/core";
import { addHistoryVisits, onHistoryChanged, queryHistory, watchHistory, type EngineHistoryEntry, type HistoryChange } from "../../platform/history";
import { readDocument } from "../../platform/documents";
import { useBrowser, type BrowserState } from "../browser/store";
import { afterFirstWindow } from "../../lib/afterFirstWindow";
import { MAX_HISTORY, MAX_VISIT_TIMES } from "./history";
import { engineProfile, isIncognitoProfile } from "../browser/model";
import type { HistoryEntry } from "../browser/types";
import { isWebPageUrl } from "../../lib/url";
import { engineProfiles } from "../profiles/engineProfiles";
import { onProfilesOpened, onProfilesUnloaded, openedEngineProfiles } from "../profiles/profileLoading";
import { migrateLegacyFile } from "../app/legacyFiles";
import { during } from "../app/jobActivity";
import { consentToken } from "../telemetry/client";
import { warnFor } from "../telemetry/logs";

const LEGACY_FILE = "history.json";
const LEGACY_TOLERANCE_MS = 60_000;
const CHUNK = 500;
const LEGACY_KEPT_MS = 15_000;
export const GAP_REPORT_MS = 30_000;
const MAX_GAP_REPORTS = 10;

const store = () => useBrowser.getState();
const profileLabel = (engine: string) => (engine ? "another profile" : "the default profile");

export type HistoryGap = `${HistoryChange["kind"]}-${"unloaded" | "moving"}` | "modified-unknown" | "visit-untitled";
export type NoteGap = (gap: HistoryGap, count?: number) => void;

const gaps = new Map<string, Map<HistoryGap, number>>();
let gapTimer: ReturnType<typeof setTimeout> | null = null;
let gapReports = 0;

function noteGap(engine: string, gap: HistoryGap, count = 1) {
  let counts = gaps.get(engine);
  if (!counts) gaps.set(engine, (counts = new Map()));
  counts.set(gap, (counts.get(gap) ?? 0) + count);
  if (gap !== "visit-untitled" && !gapTimer && gapReports < MAX_GAP_REPORTS) gapTimer = setTimeout(reportGaps, GAP_REPORT_MS);
}

const gapNoter =
  (engine: string): NoteGap =>
  (gap, count) =>
    noteGap(engine, gap, count);

function reportGaps() {
  gapTimer = null;
  for (const [engine, counts] of gaps) {
    if ([...counts.keys()].every((gap) => gap === "visit-untitled")) continue;
    if (gapReports >= MAX_GAP_REPORTS) break;
    gapReports++;
    const summary = [...counts].map(([gap, count]) => `${gap}=${count}`).join(" ");
    console.warn(`[history] changes the list missed for ${profileLabel(engine)}: ${summary}`);
  }
  gaps.clear();
}

function forgetGaps() {
  if (gapTimer) clearTimeout(gapTimer);
  gapTimer = null;
  gaps.clear();
  gapReports = 0;
}

const toEntry = (e: EngineHistoryEntry): HistoryEntry => ({
  url: e.url,
  title: e.title,
  favicon: null,
  visits: e.visits,
  lastVisit: e.visitTimes.length ? e.visitTimes[e.visitTimes.length - 1]! : 0,
  visitTimes: e.visitTimes,
});

const viewOf = (engine: string): HistoryEntry[] => store().history[engine]?.list ?? [];

const inApp = (engine: string) => engineProfiles(store()).includes(engine);

let legacyMoved = false;

function setView(engine: string, list: HistoryEntry[], floor?: number) {
  useBrowser.setState((s) => {
    if (!engineProfiles(s).includes(engine)) return {};
    const was = s.history[engine];
    const full = list.length >= MAX_HISTORY ? list[list.length - 1]!.lastVisit : -Infinity;
    const next = { list, floor: Math.max(floor ?? was?.floor ?? -Infinity, full), ready: legacyMoved || !!was?.ready };
    if (was && was.list === next.list && was.floor === next.floor && was.ready === next.ready) return {};
    return { history: { ...s.history, [engine]: next } };
  });
}

const byLastVisit = (a: HistoryEntry, b: HistoryEntry) => b.lastVisit - a.lastVisit;

type ListChange = Exclude<HistoryChange, { kind: "deleted"; all: true }>;
type Touched = { entry: HistoryEntry | undefined; index: number; moved: boolean; seq: number };

const isListChange = (change: HistoryChange): change is ListChange => change.kind !== "deleted" || !change.all;

const urlsOf = (change: ListChange): string[] =>
  change.kind === "visit" ? [change.url] : change.kind === "modified" ? change.rows.map((r) => r.url) : change.urls;

export function applyHistoryChanges(list: HistoryEntry[], changes: readonly ListChange[], note?: NoteGap): HistoryEntry[] {
  const wanted = new Set(changes.flatMap(urlsOf));
  const touched = new Map<string, Touched>();
  for (let i = 0; i < list.length; i++) {
    const h = list[i]!;
    if (wanted.has(h.url) && !touched.has(h.url)) touched.set(h.url, { entry: h, index: i, moved: false, seq: 0 });
  }
  const stateOf = (url: string) => {
    let state = touched.get(url);
    if (!state) touched.set(url, (state = { entry: undefined, index: -1, moved: false, seq: 0 }));
    return state;
  };
  let seq = 0;
  let dirty = false;
  for (const change of changes) {
    switch (change.kind) {
      case "visit": {
        if (!isWebPageUrl(change.url)) break;
        const state = stateOf(change.url);
        const old = state.entry;
        if (old?.visitTimes?.includes(change.at)) break;
        const times = [...(old?.visitTimes ?? []), change.at].sort((a, b) => a - b).slice(-MAX_VISIT_TIMES);
        state.entry = {
          url: change.url,
          title: change.title || old?.title || "",
          favicon: null,
          visits: Math.max(change.visits, 1),
          lastVisit: times[times.length - 1]!,
          visitTimes: times,
        };
        if (!state.entry.title) note?.("visit-untitled");
        state.moved = true;
        state.seq = ++seq;
        dirty = true;
        break;
      }
      case "modified": {
        for (const row of new Map(change.rows.map((r) => [r.url, r])).values()) {
          const state = touched.get(row.url);
          const h = state?.entry;
          if (!h && isWebPageUrl(row.url)) note?.("modified-unknown");
          if (!state || !h || ((row.title === h.title || !row.title) && row.visits === h.visits)) continue;
          state.entry = { ...h, title: row.title || h.title, visits: row.visits };
          dirty = true;
        }
        break;
      }
      case "deleted": {
        for (const url of change.urls) {
          const state = touched.get(url);
          if (!state?.entry) continue;
          state.entry = undefined;
          dirty = true;
        }
        break;
      }
    }
  }
  if (!dirty) return list;

  const replaced: Touched[] = [];
  const moved: Touched[] = [];
  for (const state of touched.values()) {
    if (state.moved && state.entry) moved.push(state);
    if (state.index >= 0) replaced.push(state);
  }
  replaced.sort((a, b) => a.index - b.index);
  moved.sort((a, b) => b.entry!.lastVisit - a.entry!.lastVisit || b.seq - a.seq);
  const next: HistoryEntry[] = [];
  let m = 0;
  let r = 0;
  for (let i = 0; i < list.length && next.length < MAX_HISTORY; i++) {
    let h: HistoryEntry | undefined = list[i]!;
    if (r < replaced.length && replaced[r]!.index === i) {
      const state = replaced[r++]!;
      h = state.moved ? undefined : state.entry;
    }
    if (!h) continue;
    while (m < moved.length && moved[m]!.entry!.lastVisit >= h.lastVisit) next.push(moved[m++]!.entry!);
    next.push(h);
  }
  while (m < moved.length) next.push(moved[m++]!.entry!);
  if (next.length > MAX_HISTORY) next.length = MAX_HISTORY;
  return next;
}

type Load = { running: Promise<void>; again: boolean; queued: HistoryChange[] };
const loads = new Map<string, Load>();
const loaded = new Set<string>();
const migrating = new Set<string>();

function load(engine: string): Promise<void> {
  const running = loads.get(engine);
  if (running) {
    running.again = true;
    return running.running;
  }
  const state: Load = { running: Promise.resolve(), again: false, queued: [] };
  loads.set(engine, state);
  const consent = consentToken();
  state.running = (async () => {
    try {
      do {
        state.again = false;
        state.queued = [];
        await watchHistory(engine);
        if (!inApp(engine)) return;
        const read = await queryHistory(engine, MAX_HISTORY, MAX_VISIT_TIMES);
        const floor = read.length >= MAX_HISTORY ? read.reduce((oldest, e) => Math.min(oldest, e.visitTimes.at(-1) ?? 0), Infinity) : -Infinity;
        let list = read.filter((e) => isWebPageUrl(e.url)).map(toEntry).sort(byLastVisit);
        list = applyHistoryChanges(list, state.queued.filter(isListChange), gapNoter(engine));
        if (state.queued.some((c) => c.kind === "deleted" && c.all)) state.again = true;
        setView(engine, list, floor);
        if (inApp(engine)) loaded.add(engine);
      } while (state.again && inApp(engine));
    } catch (error) {
      const failure = ardiaError(error);
      warnFor(consent, `[history] couldn't read ${profileLabel(engine)}'s history: ${failure.code} ${failure.message}`, error);
    } finally {
      loads.delete(engine);
    }
  })();
  return state.running;
}

let pending: HistoryChange[] = [];

function changed(change: HistoryChange) {
  if (!pending.length) queueMicrotask(applyPending);
  pending.push(change);
}

function applyPending() {
  const changes = pending;
  pending = [];
  const batches = new Map<string, ListChange[]>();
  const show = () => {
    during("historyApply", () => {
      for (const [engine, batch] of batches) setView(engine, applyHistoryChanges(viewOf(engine), batch, gapNoter(engine)));
    });
    batches.clear();
  };
  for (const change of changes) {
    const engine = change.profile;
    if (migrating.has(engine)) {
      noteGap(engine, `${change.kind}-moving`);
      continue;
    }
    const running = loads.get(engine);
    if (running) {
      running.queued.push(change);
      continue;
    }
    if (!loaded.has(engine)) {
      noteGap(engine, `${change.kind}-unloaded`);
      continue;
    }
    if (!isListChange(change)) {
      show();
      void load(engine);
      continue;
    }
    const batch = batches.get(engine);
    if (batch) batch.push(change);
    else batches.set(engine, [change]);
  }
  show();
}

type LegacyFile = { history?: Record<string, HistoryEntry[]> };

export const migrateHistoryFile = ({ keepMs = LEGACY_KEPT_MS } = {}) => migrateLegacyFile<LegacyFile>(LEGACY_FILE, "history", moveHistory, keepMs);

async function moveHistory(file: LegacyFile) {
  const s = store();
  const perEngine = new Map<string, HistoryEntry[]>();
  for (const [profileId, list] of Object.entries(file.history ?? {})) {
    if (!s.profiles[profileId] || isIncognitoProfile(profileId) || !Array.isArray(list)) continue;
    const engine = engineProfile(s, profileId);
    if (!perEngine.has(engine)) perEngine.set(engine, list);
  }
  for (const engine of perEngine.keys()) migrating.add(engine);
  try {
    for (const [engine, list] of perEngine) {
      const pages = list
        .filter((e) => e && typeof e.url === "string")
        .map((e) => ({
          url: e.url,
          title: e.title ?? "",
          visitTimes: (e.visitTimes?.length ? e.visitTimes : [e.lastVisit]).filter((t) => typeof t === "number" && t > 0),
        }))
        .filter((p) => p.visitTimes.length);
      for (let i = 0; i < pages.length; i += CHUNK) await addHistoryVisits(engine, pages.slice(i, i + CHUNK), LEGACY_TOLERANCE_MS);
    }
  } finally {
    migrating.clear();
  }
}

export function startHistory() {
  const events = onHistoryChanged(changed);
  const loadAll = (s: Pick<BrowserState, "profiles">) => {
    for (const engine of openedEngineProfiles(s)) if (!loaded.has(engine) && !loads.has(engine)) void load(engine);
  };
  let moving = readDocument(LEGACY_FILE) !== null;
  let stopped = false;
  if (!moving) loadAll(store());
  const migrate = () => {
    if (stopped) return;
    void migrateHistoryFile().then((result) => {
      legacyMoved = result !== "kept";
      if (moving) {
        moving = false;
        loadAll(store());
      } else if (result === "moved") void reloadHistory();
      else if (legacyMoved) for (const engine of loaded) setView(engine, viewOf(engine));
    });
  };
  if (moving) afterFirstWindow(migrate);
  else migrate();
  const stop = useBrowser.subscribe((s, prev) => {
    if (s.profiles === prev.profiles) return;
    const inStore = engineProfiles(s);
    for (const engine of loaded) if (!inStore.includes(engine)) loaded.delete(engine);
    if (!moving) loadAll(s);
  });
  const opened = onProfilesOpened(() => {
    if (!moving) loadAll(store());
  });
  const unloaded = onProfilesUnloaded((engines) => {
    for (const engine of engines) loaded.delete(engine);
  });
  return () => {
    stopped = true;
    events.remove();
    stop();
    opened();
    unloaded();
    pending = [];
    loaded.clear();
    forgetGaps();
    legacyMoved = false;
  };
}

export const reloadEngineHistory = (engine: string) => (loaded.has(engine) || loads.has(engine) ? load(engine) : Promise.resolve());

export const reloadHistory = () => Promise.all(openedEngineProfiles(store()).map(load));
