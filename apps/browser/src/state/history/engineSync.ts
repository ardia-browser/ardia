import { ardiaError } from "@ardia/core";
import { addHistoryVisits, onHistoryChanged, queryHistory, watchHistory, type EngineHistoryEntry, type HistoryChange } from "../../platform/history";
import { readDocument } from "../../platform/documents";
import { useBrowser, type BrowserState } from "../browser/store";
import { afterFirstWindow } from "../../lib/afterFirstWindow";
import { MAX_HISTORY, MAX_VISIT_TIMES } from "./history";
import { applyHistoryChanges, historyListIndexed, indexHistoryList, isListChange, type HistoryGap, type ListChange, type NoteGap } from "./historyChanges";
import { engineProfile, isIncognitoProfile } from "../browser/model";
import type { HistoryEntry } from "../browser/types";
import { isWebPageUrl } from "../../lib/url";
import { engineProfiles } from "../profiles/engineProfiles";
import { onProfilesOpened, onProfilesUnloaded, openedEngineProfiles } from "../profiles/profileLoading";
import { migrateLegacyFile } from "../app/legacyFiles";
import { during } from "../app/jobActivity";
import { isQuitting, onQuittingChanged } from "../app/quit";
import { consentToken } from "../telemetry/client";
import { warnFor } from "../telemetry/logs";

const LEGACY_FILE = "history.json";
export const INDEX_WHEN_QUIET_MS = 2000;
const LEGACY_TOLERANCE_MS = 60_000;
const CHUNK = 500;
const LEGACY_KEPT_MS = 15_000;
export const GAP_REPORT_MS = 30_000;
const MAX_GAP_REPORTS = 10;

const store = () => useBrowser.getState();
const profileLabel = (engine: string) => (engine ? "another profile" : "the default profile");


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

const indexTimers = new Map<string, { timer: ReturnType<typeof setTimeout>; list: readonly HistoryEntry[] }>();

function forgetIndexTimer(engine: string) {
  const pending = indexTimers.get(engine);
  if (pending) clearTimeout(pending.timer);
  indexTimers.delete(engine);
}

function forgetReplacedIndexTimers() {
  for (const [engine, { list }] of [...indexTimers]) if (viewOf(engine) !== list) forgetIndexTimer(engine);
}

export const historyIndexesPending = () => indexTimers.size;

function forgetIndexTimers() {
  for (const engine of [...indexTimers.keys()]) forgetIndexTimer(engine);
}

function indexWhenQuiet(engine: string) {
  forgetIndexTimer(engine);
  const list = viewOf(engine);
  if (isQuitting() || !list.length || historyListIndexed(list)) return;
  const timer = setTimeout(() => {
    indexTimers.delete(engine);
    if (!isQuitting() && loaded.has(engine) && inApp(engine) && viewOf(engine) === list) indexHistoryList(list);
  }, INDEX_WHEN_QUIET_MS);
  indexTimers.set(engine, { timer, list });
}

type Load = { running: Promise<void>; again: boolean; queued: HistoryChange[]; epoch: string };
const loads = new Map<string, Load>();
let syncSession = 0;
const unloads = new Map<string, number>();
const readEpoch = (engine: string) => `${syncSession}:${unloads.get(engine) ?? 0}`;

function currentLoad(engine: string): Load | undefined {
  const running = loads.get(engine);
  return running && running.epoch === readEpoch(engine) ? running : undefined;
}
const loaded = new Set<string>();
const migrating = new Set<string>();

function load(engine: string): Promise<void> {
  const running = currentLoad(engine);
  if (running) {
    running.again = true;
    return running.running;
  }
  const epoch = readEpoch(engine);
  const state: Load = { running: Promise.resolve(), again: false, queued: [], epoch };
  loads.set(engine, state);
  const consent = consentToken();
  state.running = (async () => {
    try {
      do {
        state.again = false;
        state.queued = [];
        await watchHistory(engine);
        if (!inApp(engine) || readEpoch(engine) !== epoch) return;
        const read = await queryHistory(engine, MAX_HISTORY, MAX_VISIT_TIMES);
        if (readEpoch(engine) !== epoch) return;
        const floor = read.length >= MAX_HISTORY ? read.reduce((oldest, e) => Math.min(oldest, e.visitTimes.at(-1) ?? 0), Infinity) : -Infinity;
        let list = read.filter((e) => isWebPageUrl(e.url)).map(toEntry).sort(byLastVisit);
        const replayed = state.queued.filter(isListChange);
        list = applyHistoryChanges(list, replayed, gapNoter(engine));
        if (state.queued.some((c) => c.kind === "deleted" && c.all)) state.again = true;
        setView(engine, list, floor);
        if (inApp(engine)) loaded.add(engine);
        if (replayed.length && loaded.has(engine)) indexWhenQuiet(engine);
      } while (state.again && inApp(engine) && readEpoch(engine) === epoch);
    } catch (error) {
      const failure = ardiaError(error);
      warnFor(consent, `[history] couldn't read ${profileLabel(engine)}'s history: ${failure.code} ${failure.message}`, error);
    } finally {
      if (loads.get(engine) === state) loads.delete(engine);
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
      for (const [engine, batch] of batches) {
        setView(engine, applyHistoryChanges(viewOf(engine), batch, gapNoter(engine)));
        indexWhenQuiet(engine);
      }
    });
    batches.clear();
  };
  for (const change of changes) {
    const engine = change.profile;
    if (migrating.has(engine)) {
      noteGap(engine, `${change.kind}-moving`);
      continue;
    }
    const running = currentLoad(engine);
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
    for (const engine of openedEngineProfiles(s)) if (!loaded.has(engine) && !currentLoad(engine)) void load(engine);
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
  const stop = useBrowser.subscribeTo(["profiles"], (s, prev) => {
    if (s.profiles === prev.profiles) return;
    const inStore = engineProfiles(s);
    for (const engine of loaded) if (!inStore.includes(engine)) loaded.delete(engine);
    for (const engine of [...indexTimers.keys()]) if (!inStore.includes(engine)) forgetIndexTimer(engine);
    if (!moving) loadAll(s);
  });
  const opened = onProfilesOpened(() => {
    if (!moving) loadAll(store());
  });
  const unloaded = onProfilesUnloaded((engines) => {
    for (const engine of engines) {
      unloads.set(engine, (unloads.get(engine) ?? 0) + 1);
      loaded.delete(engine);
      forgetIndexTimer(engine);
    }
  });
  const quitting = onQuittingChanged((on) => on && forgetIndexTimers());
  const replaced = useBrowser.subscribeTo(["history"], (s, prev) => s.history !== prev.history && indexTimers.size > 0 && forgetReplacedIndexTimers());
  return () => {
    stopped = true;
    syncSession++;
    events.remove();
    stop();
    opened();
    unloaded();
    quitting();
    replaced();
    forgetIndexTimers();
    pending = [];
    loaded.clear();
    forgetGaps();
    legacyMoved = false;
  };
}

export const reloadEngineHistory = (engine: string) => (loaded.has(engine) || currentLoad(engine) ? load(engine) : Promise.resolve());

export const reloadHistory = () => Promise.all(openedEngineProfiles(store()).map(load));
