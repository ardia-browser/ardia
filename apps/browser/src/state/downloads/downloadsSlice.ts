import type { StateCreator } from "zustand";
import { shallow } from "zustand/shallow";
import type { Download } from "../../platform/downloads";
import type { BrowserWindow } from "../browser/types";
import type { BrowserState } from "../browser/store";
import { engineProfile, isIncognitoProfile, privateSession } from "../browser/model";
import { focusedWindowOf, patchWindowUi } from "../windows/ui";
import { awaitsKeep } from "./status";
import { noteDownloadsPanel } from "../telemetry/downloadsPanelCounts";
import { forgetDownloadProgress, showDownloadProgress, withoutProgress } from "./progress";
import { libraryOf, libraryShows, mediaKindOf, showLibrarySection, type LibrarySection } from "../library/library";
import { mediaTypeOf } from "../library/items";
import { rememberOffTheRecordPath } from "../library/offTheRecordPaths";

export type DownloadsSlice = {
  downloads: Download[];

  upsertDownload(d: Download): void;
  removeDownload(id: string): void;
  clearDownloads(windowId?: string): void;
  forgetDownloads(profile: string): void;
};

const MAX_DOWNLOADS = 100;

export function downloadSession(s: Pick<BrowserState, "profiles">, d: Pick<Download, "profile" | "offTheRecord">): string | null {
  if (d.offTheRecord) return d.profile ?? "";
  return d.profile && isIncognitoProfile(d.profile) ? privateSession(s, d.profile) : null;
}

export function downloadVisibleIn(s: Pick<BrowserState, "profiles">, d: Pick<Download, "profile" | "offTheRecord">, window: Pick<BrowserWindow, "kind" | "profileId"> | undefined): boolean {
  if (!window) return false;
  const session = downloadSession(s, d);
  if (window.kind === "private") return session !== null && session === privateSession(s, window.profileId);
  return session === null && (d.profile ?? "") === engineProfile(s, window.profileId);
}

const sessionOpen = (s: Pick<BrowserState, "windows" | "profiles">, session: string) =>
  Object.values(s.windows).some((w) => w.kind === "private" && privateSession(s, w.profileId) === session);
const endedPrivateDownloads = new Set<string>();
const LIBRARY_SHOWS_DOWNLOADS: readonly LibrarySection[] = ["downloads", "media"];

function listedInShownMedia(windowId: string, d: Download): boolean {
  if (d.state !== "finished") return false;
  const media = mediaTypeOf(d);
  const kind = mediaKindOf(libraryOf(windowId));
  return !!media && (kind === "all" || kind === media);
}

export function withoutRepeats<Row extends Pick<Download, "url" | "path" | "profile" | "startTime">>(downloads: readonly Row[]): Row[] {
  const seen = new Set<string>();
  return downloads.filter((d) => {
    if (!d.path || d.startTime === undefined) return true;
    const key = `${d.profile ?? ""}\n${d.url}\n${d.path}\n${d.startTime}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

type VisibleDownloads = { profiles: BrowserState["profiles"]; kind: BrowserWindow["kind"] | undefined; profileId: string | undefined; list: Download[] };

const visibleDownloads = new WeakMap<readonly Download[], Map<string, VisibleDownloads>>();

export function downloadsIn(s: Pick<BrowserState, "downloads" | "windows" | "profiles">, windowId: string): Download[] {
  const window = s.windows[windowId];
  let byWindow = visibleDownloads.get(s.downloads);
  if (!byWindow) visibleDownloads.set(s.downloads, (byWindow = new Map()));
  const kept = byWindow.get(windowId);
  if (kept && kept.profiles === s.profiles && kept.kind === window?.kind && kept.profileId === window?.profileId) return kept.list;
  const list = s.downloads.filter((d) => downloadVisibleIn(s, d, window));
  byWindow.set(windowId, { profiles: s.profiles, kind: window?.kind, profileId: window?.profileId, list });
  return list;
}

export const createDownloadsSlice: StateCreator<BrowserState, [], [], DownloadsSlice> = (set, get) => ({
  downloads: [],

  upsertDownload(d) {
    const before = get().downloads;
    let turnLibraryToDownloads: string | null = null;
    set((s) => {
      const listed = s.downloads.find((x) => x.id === d.id);
      if (!d.path && (d.state === "downloading" || d.state === "cancelled")) {
        return listed && d.state === "cancelled" ? { downloads: s.downloads.filter((x) => x.id !== d.id) } : s;
      }
      const session = downloadSession(s, d);
      if (session !== null && d.path) rememberOffTheRecordPath(d.path);
      if (!listed && session !== null && (!sessionOpen(s, session) || endedPrivateDownloads.has(d.id))) {
        endedPrivateDownloads.add(d.id);
        return s;
      }
      const record = withoutProgress(d);
      if (listed && shallow(listed, record)) return s;
      const downloads = listed ? s.downloads.map((x) => (x.id === d.id ? record : x)) : [record, ...s.downloads].slice(0, MAX_DOWNLOADS);
      const focused = focusedWindowOf(s);
      const newlyHeld = awaitsKeep(d) && !s.downloads.some((x) => x.id === d.id && awaitsKeep(x));
      const wanted = (!listed || newlyHeld) && focused && downloadVisibleIn(s, d, s.windows[focused]) && !s.windowUi[focused]?.downloadsOpen;
      const inLibrary = !!wanted && libraryShows(focused, LIBRARY_SHOWS_DOWNLOADS);
      if (inLibrary) noteDownloadsPanel("libraryShown");
      if (inLibrary && (newlyHeld || (libraryShows(focused, ["media"]) && !listedInShownMedia(focused, d)))) turnLibraryToDownloads = focused;
      const open = wanted && !inLibrary;
      if (open && newlyHeld) noteDownloadsPanel("heldOpen");
      return { downloads, ...(open ? patchWindowUi(s, focused, { downloadsOpen: true }) : {}) };
    });
    if (turnLibraryToDownloads) showLibrarySection(turnLibraryToDownloads, "downloads");
    if (d.state === "downloading" && get().downloads.some((x) => x.id === d.id && x.state === "downloading")) showDownloadProgress(d);
    else forgetDownloadProgress([d.id]);
    const added = get().downloads !== before && !before.some((x) => x.id === d.id);
    if (added) forgetDownloadProgress(before.slice(MAX_DOWNLOADS - 1).map((x) => x.id));
  },

  removeDownload(id) {
    set((s) => ({ downloads: s.downloads.filter((d) => d.id !== id) }));
    forgetDownloadProgress([id]);
  },

  clearDownloads(windowId) {
    set((s) => ({
      downloads: s.downloads.filter((d) => d.state === "downloading" || (windowId !== undefined && !downloadVisibleIn(s, d, s.windows[windowId]))),
    }));
  },

  forgetDownloads(profile) {
    const session = privateSession(get(), profile);
    const gone = (d: Download) => (session !== null ? downloadSession(get(), d) === session : d.profile === profile);
    const forgotten = get().downloads.filter(gone).map((d) => d.id);
    if (session !== null) for (const id of forgotten) endedPrivateDownloads.add(id);
    if (!forgotten.length) return;
    set((s) => ({ downloads: s.downloads.filter((d) => !gone(d)) }));
    forgetDownloadProgress(forgotten);
  },
});
