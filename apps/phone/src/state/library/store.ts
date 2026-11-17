import { create } from "zustand";
import { downloads } from "../../platform/downloads";
import { history } from "../history/store";
import { settled } from "../pages/store";
import { dismissSearch } from "../search/store";
import { openRemote } from "../sync/actions";
import { readPreferences, writePreference } from "../store/browserDatabase";
import { browserDatabase } from "../store/database";
import { selectedProfile, syncData } from "../sync/store";
import { belongsToSpace } from "../tabs/spaces";
import { useTabs } from "../tabs/store";
import { countUsage } from "../telemetry/telemetry";
import { forgettingHidden, hidingEntry, historyEntries, keepingHidden, type HiddenHistory, type HistoryEntry, type HistoryVisitInput } from "./historyTimeline";

export type DownloadedFile = Awaited<ReturnType<typeof downloads.files>>[number];

export type LibrarySection = "history" | "bookmarks" | "downloads";

export const LIBRARY_SECTIONS: readonly LibrarySection[] = ["history", "bookmarks", "downloads"];

export const LIBRARY_NAMES: Record<LibrarySection, string> = { history: "History", bookmarks: "Bookmarks", downloads: "Downloads" };

export const LIBRARY_SYMBOLS: Record<LibrarySection, string> = { history: "clock", bookmarks: "book", downloads: "arrow.down.circle" };

export const LIBRARY_SEARCH_PROMPTS: Record<LibrarySection, string | null> = { history: "Search History", bookmarks: "Search Bookmarks", downloads: null };

export const HIDDEN_HISTORY_KEY = "library.hiddenHistory";

export const HISTORY_FETCH_LIMIT = 5000;

const HISTORY_SCAN = 20_000;

type LibraryState = {
  open: boolean;
  section: LibrarySection;
  path: string[];
  history: HistoryEntry[];
  historyLoaded: boolean;
  files: DownloadedFile[];
  filesLoaded: boolean;
};

export const useLibrary = create<LibraryState>()(() => ({ open: false, section: "history", path: [], history: [], historyLoaded: false, files: [], filesLoaded: false }));

export function openLibrary(section: LibrarySection) {
  useLibrary.setState({ open: true, section, path: [] });
  countUsage("library_opened");
}

export const closeLibrary = () => useLibrary.setState({ open: false });

export function openFromLibrary(url: string, title: string) {
  closeLibrary();
  dismissSearch();
  openRemote(url, title, null);
}

export function showLibrarySection(section: LibrarySection) {
  if (useLibrary.getState().section === section) return;
  useLibrary.setState({ section, path: [] });
}

export const pushLibraryPage = (page: string) => useLibrary.setState((state) => ({ path: [...state.path, page] }));

export const followLibraryPath = (path: string[]) => useLibrary.setState({ path });

export const popLibraryPage = () => useLibrary.setState((state) => ({ path: state.path.slice(0, -1) }));

export function reloadLibrary() {
  const section = useLibrary.getState().section;
  if (section === "history") loadHistory();
  if (section === "downloads") void loadDownloads();
}

type StoredHidden = Record<string, Record<string, number>>;

function storedHidden(): StoredHidden {
  const raw = readPreferences(browserDatabase())[HIDDEN_HISTORY_KEY];
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? (parsed as StoredHidden) : {};
  } catch {
    return {};
  }
}

function writeHidden(spaces: StoredHidden) {
  const kept = Object.fromEntries(Object.entries(spaces).filter(([, hidden]) => Object.keys(hidden).length > 0));
  writePreference(browserDatabase(), HIDDEN_HISTORY_KEY, Object.keys(kept).length ? JSON.stringify(kept) : null);
}

const loadHidden = (space: string | null): HiddenHistory => (space ? (storedHidden()[space] ?? {}) : {});

function saveHidden(hidden: HiddenHistory, space: string | null) {
  if (!space) return;
  writeHidden({ ...storedHidden(), [space]: { ...hidden } });
}

export function forgetHiddenHistory(since: number | null) {
  const spaces = storedHidden();
  writeHidden(Object.fromEntries(Object.entries(spaces).map(([space, hidden]) => [space, forgettingHidden(hidden, since)])));
  if (useLibrary.getState().open) reloadLibrary();
}

const syncedSpace = () => (syncData().status.isEnabled ? selectedProfile() : null);

const syncedVisits = (): HistoryVisitInput[] => (syncedSpace()?.history ?? []).map((item) => ({ url: item.url, title: item.title, visitedAt: item.lastVisit }));

const settledHidden = (hidden: HiddenHistory, synced: readonly HistoryVisitInput[]) => (syncData().status.isSyncing ? hidden : keepingHidden(hidden, synced));

let localSpaces = new Map<string, Set<string | null>>();

function localVisits(): HistoryVisitInput[] {
  const spaces = useTabs.getState().spaces;
  const visits = history()
    .search("", HISTORY_SCAN)
    .filter((visit) => belongsToSpace(spaces, visit.profileSyncId))
    .slice(0, HISTORY_FETCH_LIMIT);
  localSpaces = new Map();
  for (const visit of visits) {
    const ids = localSpaces.get(visit.url) ?? new Set<string | null>();
    ids.add(visit.profileSyncId);
    localSpaces.set(visit.url, ids);
  }
  return visits.map((visit) => ({ url: visit.url, title: visit.title, visitedAt: visit.visitedAt }));
}

export function loadHistory() {
  const space = syncedSpace()?.syncId ?? null;
  const synced = syncedVisits();
  const stored = loadHidden(space);
  const hidden = settledHidden(stored, synced);
  if (JSON.stringify(hidden) !== JSON.stringify(stored)) saveHidden(hidden, space);
  useLibrary.setState({ history: historyEntries(localVisits(), synced, hidden), historyLoaded: true });
}

export function deleteHistoryEntry(entry: HistoryEntry) {
  const space = syncedSpace()?.syncId ?? null;
  const hidden = settledHidden(hidingEntry(entry, loadHidden(space)), syncedVisits());
  saveHidden(hidden, space);
  useLibrary.setState((state) => ({ history: state.history.filter((shown) => shown.url !== entry.url) }));
  for (const profileSyncId of localSpaces.get(entry.url) ?? []) history().removeVisits([entry.url], profileSyncId);
  localSpaces.delete(entry.url);
}

export async function loadDownloads() {
  const files = await settled(() => downloads.files(), [] as DownloadedFile[]);
  useLibrary.setState({ files, filesLoaded: true });
}

export function deleteDownload(file: DownloadedFile) {
  useLibrary.setState((state) => ({ files: state.files.filter((shown) => shown.uri !== file.uri) }));
  void settled(() => downloads.delete(file.uri), false);
}

export function deleteAllDownloads() {
  useLibrary.setState({ files: [] });
  void settled(() => downloads.deleteAll(), 0);
}

export const previewDownload = (file: DownloadedFile) => void settled(() => downloads.preview(file.uri), false);

export const shareDownload = (file: DownloadedFile) => void settled(() => downloads.share(file.uri), false);
