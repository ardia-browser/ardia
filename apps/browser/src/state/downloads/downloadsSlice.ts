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

export const downloadsIn = (s: Pick<BrowserState, "downloads" | "windows" | "profiles">, windowId: string) =>
  s.downloads.filter((d) => downloadVisibleIn(s, d, s.windows[windowId]));

export const createDownloadsSlice: StateCreator<BrowserState, [], [], DownloadsSlice> = (set, get) => ({
  downloads: [],

  upsertDownload(d) {
    const before = get().downloads;
    set((s) => {
      const listed = s.downloads.find((x) => x.id === d.id);
      if (!d.path && (d.state === "downloading" || d.state === "cancelled")) {
        return listed && d.state === "cancelled" ? { downloads: s.downloads.filter((x) => x.id !== d.id) } : s;
      }
      const session = downloadSession(s, d);
      if (!listed && session !== null && (!sessionOpen(s, session) || endedPrivateDownloads.has(d.id))) {
        endedPrivateDownloads.add(d.id);
        return s;
      }
      const record = withoutProgress(d);
      if (listed && shallow(listed, record)) return s;
      const downloads = listed ? s.downloads.map((x) => (x.id === d.id ? record : x)) : [record, ...s.downloads].slice(0, MAX_DOWNLOADS);
      const focused = focusedWindowOf(s);
      const newlyHeld = awaitsKeep(d) && !s.downloads.some((x) => x.id === d.id && awaitsKeep(x));
      const open = newlyHeld && focused && downloadVisibleIn(s, d, s.windows[focused]) && !s.windowUi[focused]?.downloadsOpen;
      if (open) noteDownloadsPanel("heldOpen");
      return { downloads, ...(open ? patchWindowUi(s, focused, { downloadsOpen: true }) : {}) };
    });
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
