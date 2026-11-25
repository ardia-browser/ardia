import { create } from "zustand";
import { newUuid } from "../../lib/ids";
import { deletePageSnapshots, endPages, endPrivateSession, savePageState, snapshotsCommitted } from "../pages/store";
import { currentPreferences, setPreference } from "../settings/store";
import {
  archivedBefore,
  archivedIdsAmong,
  archivedRankedFrom,
  commitTabChanges,
  countArchivedTabs,
  expiredArchivedIds,
  knownReceivedKeys,
  readArchivedTab,
  readArchivedTabs,
  readOpenTabs,
  readTabState,
  searchArchivedTabs,
} from "../store/browserDatabase";
import { tabDatabase } from "../store/database";
import type { SqlDatabase } from "../../lib/sqlDatabase";
import { forgetPictures, forTheDatabase } from "./pictures";
import { forgetWarmPictures } from "./warmPictures";
import { privatePagesRefused, refuseIncognito } from "./privatePages";
import { receiveTabs, type IncomingTab } from "./received";
import type { AutoArchiveInterval, BrowserTab, TabPatch } from "./tabModels";
import { countUsage } from "../telemetry/telemetry";
import { labTrace } from "../../platform/lab";
import {
  archiveTabs,
  clearArchive,
  closeAllPrivateTabs,
  closeAllTabs,
  closeTab,
  deleteArchived,
  emptyTabs,
  findTab,
  launchTabs,
  moveToSpace,
  openTab,
  reopenLastClosed,
  restoreArchived,
  runAutoArchive,
  selectTab,
  updateTab,
  withSpaces,
  type OpenRequest,
  type TabsChange,
  type TabsData,
} from "./tabsState";
import type { TabSpaces } from "./spaces";

export type TabsStore = TabsData & { incognito: boolean; listing: number };

export const useTabs = create<TabsStore>()(() => ({ ...emptyTabs(), incognito: false, listing: 0 }));

export const ARCHIVE_LIMIT = 2000;
export const ARCHIVE_SEARCH_LIMIT = 200;
export const ARCHIVE_RETENTION_MS = 90 * 24 * 3_600_000;

const now = () => Date.now();

const data = (): TabsData => useTabs.getState();

const privateStates = new Map<string, string>();

let tabProfile: string | null = null;

export const setTabProfile = (profileSyncId: string | null) => {
  tabProfile = profileSyncId;
};

type PendingWrites = { clearArchived: boolean; put: Map<string, BrowserTab>; remove: Set<string>; releasedPictures: Set<string>; states: Map<string, string | null> };

const pendingWrites = new Map<SqlDatabase, PendingWrites>();
let flushQueued = false;
let retryTimer: ReturnType<typeof setTimeout> | null = null;
let failedFlushes = 0;
let writesStalled = false;
let stallListener: () => void = () => undefined;

export const onTabWritesStalled = (listener: () => void) => {
  stallListener = listener;
};

const RETRY_FIRST_MS = 100;
const RETRY_LONGEST_MS = 2_000;
const RETRIES_BEFORE_STALL = 8;

const emptyBatch = (): PendingWrites => ({ clearArchived: false, put: new Map(), remove: new Set(), releasedPictures: new Set(), states: new Map() });

function stageWrites(db: SqlDatabase, change: Pick<TabsChange, "put" | "remove" | "clearArchived">) {
  const batch = pendingWrites.get(db) ?? emptyBatch();
  if (change.clearArchived) {
    batch.clearArchived = true;
    for (const [id, tab] of batch.put) {
      if (tab.archivedAt === null) continue;
      batch.put.delete(id);
      batch.states.delete(id);
      batch.remove.add(id);
      batch.releasedPictures.add(id);
    }
  }
  for (const id of change.remove) {
    batch.put.delete(id);
    batch.states.delete(id);
    batch.remove.add(id);
    batch.releasedPictures.add(id);
  }
  for (const tab of change.put) {
    if (tab.isPrivate) continue;
    batch.remove.delete(tab.id);
    batch.releasedPictures.delete(tab.id);
    batch.put.set(tab.id, tab);
  }
  if (batch.clearArchived || batch.put.size || batch.remove.size || batch.releasedPictures.size || batch.states.size) pendingWrites.set(db, batch);
}

function stageState(db: SqlDatabase, id: string, saved: string | null) {
  const batch = pendingWrites.get(db) ?? emptyBatch();
  if (batch.remove.has(id)) return;
  batch.states.set(id, saved);
  pendingWrites.set(db, batch);
}

const liveIds = () => {
  const { open, privates } = data();
  return new Set([...open, ...privates].map((tab) => tab.id));
};

function pendingArchived(db: SqlDatabase, row: BrowserTab): BrowserTab | null {
  const batch = pendingWrites.get(db);
  if (!batch) return row;
  if (batch.remove.has(row.id)) return null;
  const queued = batch.put.get(row.id);
  if (queued) return queued.archivedAt !== null ? queued : null;
  return batch.clearArchived ? null : row;
}

const pendingOverfetch = (db: SqlDatabase) => {
  const batch = pendingWrites.get(db);
  return batch ? batch.remove.size + batch.put.size : 0;
};

function archiveView(db: SqlDatabase, read: (limit: number) => readonly BrowserTab[], matches: (tab: BrowserTab) => boolean, limit: number): BrowserTab[] {
  const live = liveIds();
  const rows = read(limit + pendingOverfetch(db) + live.size);
  const batch = pendingWrites.get(db);
  const seen = new Set(rows.map((tab) => tab.id));
  const kept = rows.flatMap((row) => {
    const tab = pendingArchived(db, row);
    return tab ? [tab] : [];
  });
  const queued = batch ? [...batch.put.values()].filter((tab) => tab.archivedAt !== null && !seen.has(tab.id)) : [];
  return [...kept, ...queued]
    .filter((tab) => !live.has(tab.id) && matches(tab))
    .sort((a, b) => (b.archivedAt ?? 0) - (a.archivedAt ?? 0))
    .slice(0, limit);
}

function archivedCountThroughPending(db: SqlDatabase): number {
  const batch = pendingWrites.get(db);
  const committed = countArchivedTabs(db);
  if (!batch) return committed;
  const touched = [...new Set([...batch.put.keys(), ...batch.remove])];
  const archivedNow = archivedIdsAmong(db, touched);
  const queuedArchived = [...batch.put.values()].filter((tab) => tab.archivedAt !== null).length;
  if (batch.clearArchived) return queuedArchived;
  return committed - archivedNow.size + queuedArchived;
}

export const isTransientWriteFailure = (error: unknown) => /busy|locked/i.test(error instanceof Error ? error.message : String(error));

function retryFlushLater(transient: boolean) {
  if (retryTimer) return;
  failedFlushes += 1;
  if (!transient || failedFlushes > RETRIES_BEFORE_STALL) {
    const announce = !writesStalled;
    writesStalled = true;
    labTrace(`PAGELAB tab writes stalled after ${failedFlushes} failures, kept for the next change, the app returning or the app leaving`);
    if (announce) {
      if (!useTabs.getState().incognito) countUsage("tab_writes_stalled");
      stallListener();
    }
    return;
  }
  const wait = Math.min(RETRY_FIRST_MS * 2 ** (failedFlushes - 1), RETRY_LONGEST_MS);
  labTrace(`PAGELAB tab writes failed ${failedFlushes} times, kept and retried in ${wait} ms`);
  retryTimer = setTimeout(() => {
    retryTimer = null;
    flushTabWrites();
  }, wait);
}

function committed(batch: PendingWrites, put: readonly BrowserTab[], cleared: readonly string[]) {
  const kept = new Set(put.map((tab) => tab.id));
  deletePageSnapshots([...new Set([...batch.releasedPictures, ...cleared])].filter((id) => !kept.has(id)));
  const pictures: Record<string, string> = {};
  for (const tab of put) if (!tab.isPrivate && tab.snapshotFileName) pictures[tab.id] = tab.snapshotFileName;
  snapshotsCommitted(pictures);
}

export function flushTabWrites(): boolean {
  flushQueued = false;
  let flushed = true;
  let transient = true;
  for (const [db, batch] of [...pendingWrites]) {
    const put = [...batch.put.values()].map(forTheDatabase);
    try {
      const cleared = commitTabChanges(db, { clearArchived: batch.clearArchived, put, remove: [...batch.remove], states: [...batch.states] });
      if (pendingWrites.get(db) === batch) pendingWrites.delete(db);
      committed(batch, put, cleared);
    } catch (error) {
      flushed = false;
      transient = transient && isTransientWriteFailure(error);
    }
  }
  if (flushed) {
    failedFlushes = 0;
    writesStalled = false;
  } else retryFlushLater(transient);
  return flushed;
}

export const tabWritesPending = () => pendingWrites.size > 0;

export const tabWritesStalled = () => writesStalled;

const nextFrame = (run: () => void) => (typeof requestAnimationFrame === "function" ? requestAnimationFrame(run) : setTimeout(run, 0));

function flushAfterFrame() {
  if (flushQueued || !pendingWrites.size) return;
  flushQueued = true;
  nextFrame(() =>
    setTimeout(() => {
      if (flushQueued) flushTabWrites();
    }, 0),
  );
}

type WriteTiming = "now" | "afterFrame";

const METADATA_ONLY: ReadonlySet<keyof TabPatch> = new Set<keyof TabPatch>(["title", "faviconUrl", "themeColorHex", "snapshotFileName"]);

const patchTiming = (patch: TabPatch): WriteTiming => ((Object.keys(patch) as (keyof TabPatch)[]).every((key) => patch[key] === undefined || METADATA_ONLY.has(key)) ? "afterFrame" : "now");

function apply(change: TabsChange, timing: WriteTiming = "now") {
  const db = tabDatabase();
  const hadPrivate = useTabs.getState().privates.length > 0;
  const listed = change.put.some((t) => !t.isPrivate) || change.remove.length > 0;
  noteTabLives(data(), change);
  useTabs.setState((s) => ({ ...change.data, listing: listed ? s.listing + 1 : s.listing }));
  forgetPictures(change.remove);
  forgetWarmPictures(change.remove);
  stageWrites(db, change);
  if (timing === "afterFrame" && change.remove.length === 0 && !change.clearArchived) flushAfterFrame();
  else flushTabWrites();
  const archived = new Set(change.put.filter((t) => t.archivedAt !== null && !t.isPrivate).map((t) => t.id));
  endPages(change.endedPages.filter((id) => !archived.has(id)));
  for (const id of change.endedPages) if (archived.has(id)) void saveAndEnd(id);
  for (const id of change.endedPages) privateStates.delete(id);
  if (hadPrivate && change.data.privates.length === 0) {
    endPrivateSession();
    useTabs.setState({ incognito: false });
  }
}

const tabStillKept = (id: string) => {
  const { open, privates, archive } = data();
  if (open.some((t) => t.id === id) || privates.some((t) => t.id === id) || archive?.some((t) => t.id === id)) return true;
  return archive === null && archivedTabById(id) !== null;
};

async function saveAndEnd(id: string) {
  const save = reserveStateSave(id);
  const saved = await savePageState(id);
  if (saved && tabStillKept(id) && stateSaveIsCurrent(save)) {
    stageState(tabDatabase(), id, saved);
    flushTabWrites();
  }
  const { open, privates } = data();
  if (!open.some((t) => t.id === id) && !privates.some((t) => t.id === id)) endPages([id]);
}

export function tabSavedState(id: string): string | null {
  if (privateStates.has(id)) return privateStates.get(id)!;
  if (data().privates.some((t) => t.id === id)) return null;
  const db = tabDatabase();
  const batch = pendingWrites.get(db);
  if (batch?.remove.has(id)) return null;
  if (batch?.states.has(id)) return batch.states.get(id)!;
  return readTabState(db, id);
}

export type StateSave = { id: string; life: number; revision: number };

const tabLives = new Map<string, number>();
const acceptedStateRevision = new Map<string, number>();
let stateRevisions = 0;

const lifeOf = (id: string) => tabLives.get(id) ?? 0;

function noteTabLives(before: TabsData, change: TabsChange) {
  for (const tab of change.put) {
    const was = findTab(before, tab.id);
    if (!was || (was.archivedAt === null) !== (tab.archivedAt === null)) tabLives.set(tab.id, lifeOf(tab.id) + 1);
  }
  for (const id of change.remove) {
    tabLives.set(id, lifeOf(id) + 1);
    acceptedStateRevision.delete(id);
  }
}

export function reserveStateSave(id: string): StateSave {
  stateRevisions += 1;
  return { id, life: lifeOf(id), revision: stateRevisions };
}

function stateSaveIsCurrent(save: StateSave) {
  if (save.life !== lifeOf(save.id) || save.revision < (acceptedStateRevision.get(save.id) ?? 0)) return false;
  acceptedStateRevision.set(save.id, save.revision);
  return true;
}

export function saveTabState(id: string, saved: string | null, save: StateSave = reserveStateSave(id)): boolean {
  if (!stateSaveIsCurrent(save)) {
    labTrace(`PAGELAB page state for ${id} dropped, a newer one or a restore came first`);
    return false;
  }
  if (data().privates.some((t) => t.id === id)) {
    if (saved) privateStates.set(id, saved);
    else privateStates.delete(id);
    return true;
  }
  if (!data().open.some((t) => t.id === id)) return false;
  stageState(tabDatabase(), id, saved);
  flushAfterFrame();
  return true;
}

function expiredThroughPending(db: SqlDatabase, cutoff: number, live: ReadonlySet<string>): { byAge: string[]; byRank: string[] } {
  const shift = pendingOverfetch(db) + live.size;
  const tail = archivedRankedFrom(db, Math.max(0, ARCHIVE_LIMIT - shift));
  const queuedArchived = [...(pendingWrites.get(db)?.put.values() ?? [])].filter((tab) => tab.archivedAt !== null).map((tab) => tab.id);
  const candidates = [...tail.map((tab) => tab.id), ...queuedArchived];
  const overflow = candidates.length ? new Set(candidates) : null;
  const kept = overflow ? new Set(archiveView(db, (limit) => readArchivedTabs(db, limit), () => true, ARCHIVE_LIMIT).map((tab) => tab.id)) : null;
  const byRank = overflow && kept ? [...overflow].filter((id) => !kept.has(id)) : [];
  return { byAge: archivedBefore(db, cutoff), byRank };
}

export function pruneExpiredArchive() {
  const db = tabDatabase();
  const { open, privates } = data();
  const live = new Set([...open, ...privates].map((tab) => tab.id));
  const batch = pendingWrites.get(db);
  const cutoff = now() - ARCHIVE_RETENTION_MS;
  const stillArchived = (id: string) => {
    if (live.has(id) || batch?.remove.has(id)) return false;
    const queued = batch?.put.get(id);
    return !queued || queued.archivedAt !== null;
  };
  const stillExpired = (id: string) => {
    if (!stillArchived(id)) return false;
    const queued = batch?.put.get(id);
    return !queued || (queued.archivedAt !== null && queued.archivedAt < cutoff);
  };
  const pending = batch ? expiredThroughPending(db, cutoff, live) : null;
  const expired = pending ? [...new Set([...pending.byAge.filter(stillExpired), ...pending.byRank.filter(stillArchived)])] : expiredArchivedIds(db, cutoff, ARCHIVE_LIMIT).filter(stillExpired);
  if (!expired.length) return 0;
  const gone = new Set(expired);
  stageWrites(db, { put: [], remove: expired });
  useTabs.setState((s) => ({ archive: s.archive?.filter((tab) => !gone.has(tab.id)) ?? null }));
  flushTabWrites();
  useTabs.setState({ archivedCount: archivedCountThroughPending(db) });
  return expired.length;
}

export function loadTabs() {
  flushTabWrites();
  const db = tabDatabase();
  pruneExpiredArchive();
  const stored = readOpenTabs(db);
  const archivedCount = archivedCountThroughPending(db);
  useTabs.setState({ ...withSpaces(launchTabs(stored, archivedCount), data().spaces), incognito: false, listing: 0 });
  snapshotsCommitted(Object.fromEntries(stored.flatMap((tab) => (tab.snapshotFileName ? [[tab.id, tab.snapshotFileName]] : []))));
}

let tabsOpenedThisRun = 0;

export function openNewTab(request: Omit<OpenRequest, "isPrivate"> & { isPrivate?: boolean }): BrowserTab {
  const { change, tab } = openTab(
    data(),
    { ...request, isPrivate: request.isPrivate ?? useTabs.getState().incognito, profileSyncId: request.profileSyncId ?? tabProfile },
    now(),
    newUuid(),
  );
  apply(change);
  if (!tab.isPrivate && !request.received) countUsage("tabs_opened");
  labTrace(`PAGELAB tab opened #${++tabsOpenedThisRun} origin ${request.origin}${tab.isPrivate ? " private" : ""}${request.received ? " received" : ""} id ${tab.id} open ${useTabs.getState().open.length}`);
  return tab;
}

export function applyTabSpaces(spaces: TabSpaces) {
  const next = withSpaces(data(), spaces);
  if (next !== data()) useTabs.setState(next);
}

export function moveTabToSpace(id: string, space: string) {
  const tab = findTab(data(), id);
  if (!tab || tab.isPrivate) return;
  const change = moveToSpace(data(), id, space);
  if (!change.put.length) return;
  apply(change);
  countUsage("tabs_moved_to_space");
}

export const selectTabById = (id: string | null) => apply(selectTab(data(), id, now()), "afterFrame");

export const closeTabById = (id: string) => apply(closeTab(data(), id, now()));

export const closeEveryTab = () => {
  apply(closeAllTabs(data(), now()));
  useTabs.setState({ incognito: false });
};

export const closePrivateTabs = () => {
  apply(closeAllPrivateTabs(data()));
  useTabs.setState({ incognito: false });
};

export function reopenClosedTab(): BrowserTab | null {
  const { change, reopened } = reopenLastClosed(data(), now());
  apply(change);
  return reopened.find((t) => t.id === change.data.selectedId) ?? reopened[reopened.length - 1] ?? null;
}

export const updateTabById = (id: string, patch: TabPatch) => apply(updateTab(data(), id, patch), patchTiming(patch));

export function rewriteTab(id: string) {
  const tab = findTab(data(), id);
  if (!tab) return;
  stageWrites(tabDatabase(), { put: [tab], remove: [] });
  flushAfterFrame();
}

export const archiveDueTabs = () => apply(runAutoArchive(data(), currentPreferences().autoArchiveInterval, now()));

export function setAutoArchiveInterval(interval: AutoArchiveInterval) {
  setPreference("autoArchiveInterval", interval);
  archiveDueTabs();
}

export function setIncognito(incognito: boolean): boolean {
  if (incognito && !useTabs.getState().incognito && privatePagesRefused()) {
    refuseIncognito();
    return false;
  }
  useTabs.setState({ incognito });
  return true;
}

export function archivedTabById(id: string): BrowserTab | null {
  if (liveIds().has(id)) return null;
  const db = tabDatabase();
  const queued = pendingWrites.get(db)?.put.get(id);
  if (queued) return queued.archivedAt !== null ? queued : null;
  const row = readArchivedTab(db, id);
  return row ? pendingArchived(db, row) : null;
}

const sameArchive = (before: readonly BrowserTab[] | null, after: readonly BrowserTab[] | null) => before !== null && after !== null && before.length === after.length && before.every((tab, index) => tab === after[index]);

export function loadArchive() {
  const current = data();
  const db = tabDatabase();
  const archive = archiveView(db, (limit) => readArchivedTabs(db, limit), () => true, ARCHIVE_LIMIT);
  const archivedCount = archivedCountThroughPending(db);
  if (!sameArchive(current.archive, archive) || current.archivedCount !== archivedCount) useTabs.setState({ archive, archivedCount });
}

const PREPARED_ARCHIVE_FRESH_MS = 2_000;
let archivePreparedAt = 0;

export function prepareArchive() {
  loadArchive();
  archivePreparedAt = now();
}

let archivePreparation: ReturnType<typeof requestAnimationFrame> | null = null;

export function prepareArchiveNextFrame() {
  if (archivePreparation !== null) return;
  archivePreparation = requestAnimationFrame(() => {
    archivePreparation = null;
    prepareArchive();
  });
}

export function loadArchiveUnlessPrepared() {
  if (archivePreparation !== null) {
    cancelAnimationFrame(archivePreparation);
    archivePreparation = null;
    prepareArchive();
    return;
  }
  if (data().archive !== null && now() - archivePreparedAt < PREPARED_ARCHIVE_FRESH_MS) return;
  loadArchive();
}

export const archiveInMemory = () => data().archive !== null;

export function searchArchive(text: string): BrowserTab[] {
  const query = text.trim();
  const archive = data().archive;
  if (!query && archive) return archive;
  const db = tabDatabase();
  const needle = query.toLowerCase();
  const matches = (tab: BrowserTab) => !needle || tab.title.toLowerCase().includes(needle) || tab.url.toLowerCase().includes(needle);
  return archiveView(db, (limit) => (query ? searchArchivedTabs(db, query, limit) : readArchivedTabs(db, limit)), matches, ARCHIVE_SEARCH_LIMIT);
}

export function restoreArchivedTab(tab: BrowserTab): boolean {
  const current = archivedTabById(tab.id);
  if (!current) {
    labTrace(`PAGELAB archived tab ${tab.id} is gone, its restore is ignored`);
    return false;
  }
  apply(restoreArchived(data(), current, now()));
  return true;
}

export function deleteArchivedTabsById(ids: readonly string[]): number {
  const archived = ids.filter((id) => archivedTabById(id) !== null);
  if (archived.length < ids.length) labTrace(`PAGELAB ${ids.length - archived.length} archive deletes ignored, their tabs are open again or gone`);
  if (archived.length) apply(deleteArchived(data(), archived));
  return archived.length;
}

export const clearArchivedTabs = () => apply(clearArchive(data()));

export const archiveTabById = (id: string) => apply(archiveTabs(data(), [id], true, now()));

export function receiveSentTabs(incoming: readonly IncomingTab[]): BrowserTab[] {
  if (!incoming.length) return [];
  const known = knownReceivedKeys(tabDatabase(), incoming.map((tab) => tab.key));
  const { change, opened } = receiveTabs(data(), incoming, known, now(), newUuid);
  if (opened.length) apply(change);
  for (const tab of opened) labTrace(`PAGELAB tab opened #${++tabsOpenedThisRun} origin received-from-mac id ${tab.id} open ${useTabs.getState().open.length}`);
  return opened;
}

export const currentTabs = data;
