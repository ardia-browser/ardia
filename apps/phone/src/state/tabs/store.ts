import { create } from "zustand";
import { newUuid } from "../../lib/ids";
import { deletePageSnapshots, endPages, endPrivateSession, savePageState } from "../pages/store";
import { currentPreferences, setPreference } from "../settings/store";
import {
  countArchivedTabs,
  deleteArchivedTabs,
  expiredArchivedIds,
  knownReceivedKeys,
  readArchivedTab,
  readArchivedTabs,
  readOpenTabs,
  readTabState,
  searchArchivedTabs,
  writeTabState,
  writeTabs,
} from "../store/browserDatabase";
import { tabDatabase } from "../store/database";
import { forgetPictures, forTheDatabase } from "./pictures";
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
  withArchive,
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

function apply(change: TabsChange) {
  const db = tabDatabase();
  const hadPrivate = useTabs.getState().privates.length > 0;
  writeTabs(db, change.put.map(forTheDatabase), change.remove);
  forgetPictures(change.remove);
  const cleared = change.clearArchived ? deleteArchivedTabs(db) : [];
  const listed = change.put.some((t) => !t.isPrivate) || change.remove.length > 0;
  useTabs.setState((s) => ({ ...change.data, listing: listed ? s.listing + 1 : s.listing }));
  const archived = new Set(change.put.filter((t) => t.archivedAt !== null && !t.isPrivate).map((t) => t.id));
  endPages(change.endedPages.filter((id) => !archived.has(id)));
  for (const id of change.endedPages) if (archived.has(id)) void saveAndEnd(id);
  deletePageSnapshots([...change.remove, ...cleared]);
  for (const id of change.endedPages) privateStates.delete(id);
  if (hadPrivate && change.data.privates.length === 0) {
    endPrivateSession();
    useTabs.setState({ incognito: false });
  }
}

async function saveAndEnd(id: string) {
  const saved = await savePageState(id);
  if (saved) writeTabState(tabDatabase(), id, saved);
  const { open, privates } = data();
  if (!open.some((t) => t.id === id) && !privates.some((t) => t.id === id)) endPages([id]);
}

export function tabSavedState(id: string): string | null {
  return privateStates.get(id) ?? (data().privates.some((t) => t.id === id) ? null : readTabState(tabDatabase(), id));
}

export function saveTabState(id: string, saved: string | null) {
  if (data().privates.some((t) => t.id === id)) {
    if (saved) privateStates.set(id, saved);
    else privateStates.delete(id);
    return;
  }
  if (data().open.some((t) => t.id === id)) writeTabState(tabDatabase(), id, saved);
}

export function pruneExpiredArchive() {
  const db = tabDatabase();
  const expired = expiredArchivedIds(db, now() - ARCHIVE_RETENTION_MS, ARCHIVE_LIMIT);
  if (expired.length) writeTabs(db, [], expired);
  return expired.length;
}

export function loadTabs() {
  const db = tabDatabase();
  pruneExpiredArchive();
  useTabs.setState({ ...withSpaces(launchTabs(readOpenTabs(db), countArchivedTabs(db)), data().spaces), incognito: false, listing: 0 });
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

export const selectTabById = (id: string | null) => apply(selectTab(data(), id, now()));

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

export const updateTabById = (id: string, patch: TabPatch) => apply(updateTab(data(), id, patch));

export function rewriteTab(id: string) {
  const tab = findTab(data(), id);
  if (tab) writeTabs(tabDatabase(), [forTheDatabase(tab)], []);
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

export const archivedTabById = (id: string): BrowserTab | null => readArchivedTab(tabDatabase(), id);

export const loadArchive = () => useTabs.setState(withArchive(data(), readArchivedTabs(tabDatabase(), ARCHIVE_LIMIT)));

const PREPARED_ARCHIVE_FRESH_MS = 2_000;
let archivePreparedAt = 0;

export function prepareArchive() {
  loadArchive();
  archivePreparedAt = now();
}

export function loadArchiveUnlessPrepared() {
  if (data().archive !== null && now() - archivePreparedAt < PREPARED_ARCHIVE_FRESH_MS) return;
  loadArchive();
}

export function searchArchive(text: string): BrowserTab[] {
  const query = text.trim();
  const archive = data().archive;
  if (!query && archive) return archive;
  return query ? searchArchivedTabs(tabDatabase(), query, ARCHIVE_SEARCH_LIMIT) : readArchivedTabs(tabDatabase(), ARCHIVE_SEARCH_LIMIT);
}

export const restoreArchivedTab = (tab: BrowserTab) => apply(restoreArchived(data(), tab, now()));

export const deleteArchivedTabsById = (ids: readonly string[]) => apply(deleteArchived(data(), ids));

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
