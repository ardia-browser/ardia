import { removeDownloadStaging, type Download } from "../../platform/downloads";
import { olderBuildSessionDocument, SESSION_DOCUMENT } from "./sessionDocument";
import { useBrowser, type BrowserState, type HydrateData } from "../browser/store";
import { inPinnedContainer, snapshotTab } from "../browser/model";
import { parkWindowPins } from "../pins/parkedPins";
import { closedWindowEntry, MAX_CLOSED_WINDOWS } from "../pins/closedTabs";
import type { Tab } from "../browser/types";
import { downloadSession, withoutRepeats } from "../downloads/downloadsSlice";
import { noteSavedTopAppsMerged } from "../telemetry/topAppsSharing";
import { unchanged, type Migrations, type SavedObject } from "../../lib/savedDocument";
import { findDocument, fromNewerBuild, sessionBackups, usableSessionValue, wholeDownloads, wholeSession, type FoundDocument, type RestoredBackup } from "./sessionSafety";
import { isString } from "../../lib/decode";
import { droppedRows, rows, sessionFromSaved, SESSION_MIGRATIONS, SESSION_VERSION, type SavedSession } from "./savedSession";
import { sessionRowTables } from "./savedShapes";

const downloadsWithStagingPathOnly = (doc: SavedObject): SavedObject => ({
  ...doc,
  downloads: Array.isArray(doc.downloads)
    ? doc.downloads.map((d: unknown) => {
        if (typeof d !== "object" || d === null) return d;
        const { stagingId: _id, destination: _to, ...kept } = d as SavedObject;
        return kept;
      })
    : doc.downloads,
});
export const DOWNLOADS_DOCUMENT = "downloads.json";
export const DOWNLOADS_VERSION = 3;
const DOWNLOADS_MIGRATIONS: Migrations = { 0: unchanged, 1: unchanged, 2: downloadsWithStagingPathOnly };

export type LaunchOverrides = { restoreSession?: boolean; retiredDefaultsWaitForSync?: boolean };
type LoadedSession = HydrateData & { windowsAgainstAutoHideTabs: number };

type SavedDownloads = { list: Download[]; staged: { id: string; staging: NonNullable<Download["staging"]> }[]; droppedPrivate: boolean; rejected: boolean };
const NO_DOWNLOADS: SavedDownloads = { list: [], staged: [], droppedPrivate: false, rejected: false };

function forgetStaging(id: string) {
  const s = useBrowser.getState();
  const download = s.downloads.find((d) => d.id === id);
  if (!download) return;
  const { staging: _, ...kept } = download;
  s.upsertDownload(kept);
}

function savedDownloads(saved: Pick<BrowserState, "profiles">, found: FoundDocument): SavedDownloads {
  const raw = found.state === "usable" ? found.doc : null;
  const downloads = rows<Download>(raw?.downloads, (d) => isString(d.id) && isString(d.state) && (d.profile === undefined || d.profile === null || isString(d.profile)));
  const staged: SavedDownloads["staged"] = [];
  const list = withoutRepeats(downloads.filter((d) => downloadSession(saved, d) === null)).map((d, i) => {
    const id = `saved-${i}`;
    const { staging, ...kept } = d;
    if (!staging || d.state === "downloading") return { ...kept, id };
    staged.push({ id, staging });
    return { ...d, id };
  });
  const listed = Array.isArray(raw?.downloads) ? raw.downloads.length : 0;
  return { list, staged, droppedPrivate: downloads.some((d) => downloadSession(saved, d) !== null), rejected: listed > downloads.length };
}

function cleanStaging(downloads: SavedDownloads) {
  for (const { id, staging } of downloads.staged) {
    void removeDownloadStaging(staging)
      .catch(() => false)
      .then((removed) => removed && forgetStaging(id));
  }
}

function closedForLaunch(session: SavedSession): HydrateData {
  const now = Date.now();
  const pinSource = { tabs: session.tabs, groups: session.groups ?? {}, splits: session.splits ?? {}, history: {}, profiles: session.profiles ?? {}, settings: session.settings };
  let parkedPins = session.parkedPins ?? {};
  for (const w of Object.values(session.windows)) parkedPins = parkWindowPins(parkedPins, w, pinSource);
  const closedWindows = [
    ...(session.closedWindows ?? []).filter((c) => c.tabs.length).map(({ lastWindow: _, activePin: __, ...c }) => c),
    ...Object.values(session.windows)
      .map((w) =>
        closedWindowEntry(
          w,
          w.tabIds
            .map((id) => session.tabs[id])
            .filter((t): t is Tab => !!t && !inPinnedContainer(pinSource, t.id))
            .map((t) => ({ ...snapshotTab(t), active: Object.values(w.activeTabIds).includes(t.id) })),
          [],
          now,
        ),
      )
      .filter((c) => c.tabs.some((t) => t.url)),
  ].slice(-MAX_CLOSED_WINDOWS);
  return { ...session, parkedPins, closedWindows, windows: {}, windowOrder: [], tabs: {} };
}

type Prepared = { session: SavedSession; partial: boolean; rowTables: boolean };
type Candidate = { prepare: () => Prepared; backup: RestoredBackup<Prepared> | null; olderBuild: boolean };

const prepared = (doc: SavedObject): Prepared => {
  const session = sessionFromSaved(doc);
  return { session, partial: droppedRows(doc, session), rowTables: sessionRowTables(doc) };
};

export function wholeBackup(value: unknown): boolean {
  const doc = usableSessionValue(value, SESSION_VERSION, SESSION_MIGRATIONS);
  if (!doc) return false;
  try {
    const { session, partial } = prepared(doc);
    closedForLaunch(session);
    return !partial;
  } catch {
    return false;
  }
}

const findSession = () => findDocument(SESSION_DOCUMENT, SESSION_VERSION, SESSION_MIGRATIONS, wholeSession);
const findDownloads = () => findDocument(DOWNLOADS_DOCUMENT, DOWNLOADS_VERSION, DOWNLOADS_MIGRATIONS, wholeDownloads);

function backupsOf(found: FoundDocument): Candidate[] {
  if (found.state !== "unusable" && found.state !== "unknown") return [];
  const backups = sessionBackups(prepared, SESSION_VERSION, SESSION_MIGRATIONS);
  const ordered = [...backups.filter((b) => !b.value.partial), ...backups.filter((b) => b.value.partial)];
  return ordered.map((backup) => ({ prepare: () => backup.value, backup, olderBuild: false }));
}

export const OLDER_BUILD_SESSION_DOCUMENT = olderBuildSessionDocument(SESSION_VERSION);
const findOlderBuildSession = (primary: FoundDocument) =>
  fromNewerBuild(primary) ? findDocument(OLDER_BUILD_SESSION_DOCUMENT, SESSION_VERSION, SESSION_MIGRATIONS, wholeSession) : null;

function* candidates(found: FoundDocument, olderBuild: FoundDocument | null): Generator<Candidate> {
  if (found.state === "usable") yield { prepare: () => prepared(found.doc), backup: null, olderBuild: false };
  if (olderBuild?.state === "usable") yield { prepare: () => prepared(olderBuild.doc), backup: null, olderBuild: true };
  yield* backupsOf(found.state === "usable" ? { state: "unusable", reason: "shape", text: found.text } : found);
}

function launchData(session: SavedSession, downloads: Download[], { restoreSession, retiredDefaultsWaitForSync }: LaunchOverrides): LoadedSession {
  const restore = restoreSession ?? session.settings?.restoreSession !== false;
  const data = restore ? session : closedForLaunch(session);
  return { ...data, downloads, retiredDefaultsWaitForSync, windowsAgainstAutoHideTabs: restore ? session.windowsAgainstAutoHideTabs : 0 };
}

export function loadSession(overrides: LaunchOverrides = {}): LoadedSession | null {
  const downloads = findDownloads();
  const primary = findSession();
  for (const candidate of candidates(primary, findOlderBuildSession(primary))) {
    try {
      const { session } = candidate.prepare();
      const list = savedDownloads({ profiles: session.profiles ?? {} }, downloads);
      const data = launchData(session, list.list, overrides);
      cleanStaging(list);
      return data;
    } catch {
      continue;
    }
  }
  return null;
}

export type Launch = { loaded: LoadedSession | null; session: FoundDocument; olderBuild: FoundDocument | null; downloads: FoundDocument; restored: RestoredBackup<Prepared> | null; droppedPrivateDownloads: boolean; rowTables: boolean };

const textOf = (found: FoundDocument) => (found.state === "usable" || found.state === "unusable" ? found.text : null);

export function hydrateAtLaunch(overrides: LaunchOverrides): Launch {
  const primary = findSession();
  let session = primary;
  const olderBuildAtLaunch = findOlderBuildSession(primary);
  let olderBuild = olderBuildAtLaunch;
  let downloads = findDownloads();
  const downloadsFor = (saved: Pick<BrowserState, "profiles">) => {
    try {
      return savedDownloads(saved, downloads);
    } catch {
      downloads = { state: "unusable", reason: "shape", text: textOf(downloads) };
      return NO_DOWNLOADS;
    }
  };
  const attempt = (candidate: Candidate) => {
    try {
      const { session: value, partial, rowTables } = candidate.prepare();
      const list = downloadsFor({ profiles: value.profiles ?? {} });
      const data = launchData(value, list.list, overrides);
      noteSavedTopAppsMerged(data.topAppsMerged ?? "");
      useBrowser.getState().hydrate(data);
      cleanStaging(list);
      return { data, list, partial, rowTables };
    } catch (error) {
      console.warn("Couldn't restore a saved session", error);
      return null;
    }
  };
  let won: ReturnType<typeof attempt> = null;
  let loaded: LoadedSession | null = null;
  let restored: RestoredBackup<Prepared> | null = null;
  const damaged = (candidate: Candidate, reason: "shape" | "rows") => {
    if (candidate.backup) return;
    if (candidate.olderBuild && olderBuildAtLaunch?.state === "usable") olderBuild = { state: "unusable", reason, text: olderBuildAtLaunch.text };
    else if (!candidate.olderBuild && primary.state === "usable") session = { state: "unusable", reason, text: primary.text };
  };
  for (const candidate of candidates(primary, olderBuildAtLaunch)) {
    won = attempt(candidate);
    if (!won) {
      damaged(candidate, "shape");
      continue;
    }
    loaded = won.data;
    restored = candidate.backup;
    if (won.partial) damaged(candidate, "rows");
    break;
  }
  if (!won) {
    const list = downloadsFor({ profiles: {} });
    noteSavedTopAppsMerged("");
    try {
      useBrowser.getState().hydrate({ downloads: list.list });
      cleanStaging(list);
      won = { data: { downloads: list.list, windowsAgainstAutoHideTabs: 0 }, list, partial: false, rowTables: false };
    } catch {
      useBrowser.getState().hydrate({});
    }
  }
  if (won?.list.rejected && downloads.state === "usable") downloads = { state: "unusable", reason: "rows", text: downloads.text };
  return { loaded, session, olderBuild, downloads, restored, droppedPrivateDownloads: !!won?.list.droppedPrivate, rowTables: !!won?.rowTables };
}
