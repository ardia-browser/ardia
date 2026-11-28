import { Platform } from "react-native";
import { downloads, type DownloadEvent, type DownloadProgress } from "../../platform/downloads";
import { pages, type PageEngineEvent } from "../../platform/pages";
import { actionWords } from "../../lib/sharedWords";
import { fileExtension } from "../../lib/fileKinds";
import { installDownloadedPackage } from "../appUpdate/store";
import { loadDownloads, openLibrary, useLibrary } from "../library/store";
import { settled } from "../pages/store";
import { noteDownloadEnded, noteDownloadsReported, noteDownloadStarted, useRunningDownloads } from "../downloads/running";
import { anyPrivate } from "../downloads/runningRules";
import { currentTabs, useTabs } from "../tabs/store";
import { findTab } from "../tabs/tabsState";
import { countUsage } from "../telemetry/telemetry";
import { currentToastKey, showToast, type ToastAction } from "../toasts/store";
import { downloadedDetail, downloadFailedToast, downloadFailureWhy, downloadHost, downloadRetries, downloadsCompleteDetail, downloadsCompleteTitle, opensInInstaller } from "./pagePrompts";

type PageDownload = Extract<PageEngineEvent, { name: "page.download" }>;
type Finished = Extract<DownloadEvent, { name: "downloads.finished" }>;

type Tracked = {
  id: string;
  key: string;
  pageId: string;
  url: string;
  fileName: string;
  isPrivate: boolean;
  total: number | null;
};

type Completed = { key: string; names: string[] };

const tracked = new Map<string, Tracked>();
const cancelled = new Set<string>();
const retrying = new Map<string, { fileName: string; key: string }>();

const retryKey = (pageId: string, url: string) => `${pageId} ${url}`;
let completed: Completed | null = null;

const quietly = (call: () => Promise<unknown>) => void settled(call, undefined);

const cardKey = (id: string) => `download:${id}`;

const fileTile = (fileName: string) => ({ kind: "file" as const, ext: fileExtension(fileName) });

const counted = (download: Tracked | null) => download !== null && !download.isPrivate;

const browsingPrivately = () => useTabs.getState().incognito;

export function openDownloadsAlone() {
  openLibrary("downloads", { alone: true });
}

export function openDownloadsFromIndicator() {
  const running = useRunningDownloads.getState().running;
  if (!browsingPrivately() && running.length > 0 && !anyPrivate(running)) countUsage("download_indicator_opened");
  openDownloadsAlone();
}

export function cancelDownload(id: string) {
  const download = tracked.get(id);
  const row = useRunningDownloads.getState().running.find((item) => item.id === id);
  cancelled.add(id);
  tracked.delete(id);
  noteDownloadEnded(id);
  const isPrivate = download ? download.isPrivate : row?.isPrivate !== false;
  if (!isPrivate && !browsingPrivately()) countUsage("downloads_cancelled");
  quietly(() => downloads.cancel(id));
}

export async function refreshRunningDownloads() {
  const reported = await settled(() => downloads.active(), []);
  noteDownloadsReported(reported);
}

export function downloadStarted(event: PageDownload) {
  if (event.downloadId === null) {
    showToast({ key: `download:refused:${event.fileName}`, title: downloadFailedToast(event.fileName), tile: { kind: "icon", icon: "warning" }, titleLines: 2, stage: "failed" });
    return;
  }
  const id = event.downloadId;
  const again = retrying.get(retryKey(event.pageId, event.url));
  if (again) retrying.delete(retryKey(event.pageId, event.url));
  const download: Tracked = {
    id,
    key: again?.key ?? cardKey(id),
    pageId: event.pageId,
    url: event.url,
    fileName: again?.fileName || event.fileName,
    isPrivate: event.isPrivate,
    total: event.contentLength !== null && event.contentLength > 0 ? event.contentLength : null,
  };
  tracked.set(id, download);
  noteDownloadStarted(id, download.fileName, download.isPrivate, download.total);
}

export function downloadsProgressed(list: readonly DownloadProgress[]) {
  for (const progress of list) {
    const download = tracked.get(progress.id);
    if (download && progress.total !== null && progress.total > 0) download.total = progress.total;
  }
  noteDownloadsReported(list.filter((progress) => !cancelled.has(progress.id)));
}

function claim(event: Finished): Tracked | null {
  const found = event.id ? (tracked.get(event.id) ?? null) : ([...tracked.values()].find((download) => download.fileName === event.fileName) ?? null);
  if (event.id) noteDownloadEnded(event.id);
  if (!found) return null;
  tracked.delete(found.id);
  noteDownloadEnded(found.id);
  return found;
}

function opener(fileName: string) {
  if (opensInInstaller(Platform.OS, fileName) && downloads.installsPackages()) {
    return (target: string) => quietly(async () => (await installDownloadedPackage(target)) || showToast("Couldn’t open the installer.", "warning"));
  }
  return (target: string) => quietly(() => downloads.open(target));
}

function retryAction(download: Tracked | null, failure: Finished["failure"]): ToastAction | null {
  if (!download || !downloadRetries(failure, download.url, download.isPrivate)) return null;
  if (!findTab(currentTabs(), download.pageId)) return null;
  const { pageId, url, fileName, key } = download;
  return {
    label: actionWords.retry,
    run: () => {
      countUsage("downloads_retried");
      retrying.set(retryKey(pageId, url), { fileName, key });
      quietly(() => pages.download(pageId, url));
    },
  };
}

function showFailure(event: Finished, download: Tracked | null) {
  const key = download?.key ?? `download:failed:${event.fileName}`;
  if (counted(download) && currentToastKey() === key) countUsage("download_cards_updated");
  if (completed?.key === key) completed = null;
  showToast({
    key,
    title: downloadFailedToast(download?.fileName || event.fileName || ""),
    detail: downloadFailureWhy(event.failure),
    tile: { kind: "icon", icon: "warning" },
    icon: "warning",
    action: retryAction(download, event.failure),
    titleLines: 2,
    stage: "failed",
  });
}

function showCompleted(event: Finished, download: Tracked | null) {
  const name = event.fileName || download?.fileName || "";
  const visible = currentToastKey();
  const key = download?.key ?? `download:done:${name}`;
  if (completed && visible === completed.key && completed.key !== key) {
    const group = completed;
    group.names.push(name);
    if (counted(download)) countUsage("download_cards_grouped");
    showToast({
      key: group.key,
      title: downloadsCompleteTitle(group.names.length),
      detail: downloadsCompleteDetail(group.names),
      tile: { kind: "count", count: group.names.length },
      icon: "download",
      action: { label: actionWords.show, run: openDownloadsAlone },
      stage: `group:${group.names.length}`,
    });
    return;
  }
  if (counted(download) && visible === key) countUsage("download_cards_updated");
  const open = opener(name);
  const uri = event.uri;
  const host = download && !download.isPrivate ? downloadHost(download.url) : null;
  completed = { key, names: [name] };
  showToast({
    key,
    title: name,
    detail: downloadedDetail(download?.total ?? null, host),
    tile: fileTile(name),
    icon: "download",
    action: uri ? { label: actionWords.open, run: () => open(uri) } : null,
    stage: "done",
  });
}

export function downloadFinished(event: Finished) {
  if (event.id && cancelled.has(event.id)) {
    cancelled.delete(event.id);
    tracked.delete(event.id);
    noteDownloadEnded(event.id);
    return;
  }
  const download = claim(event);
  if (event.failure) showFailure(event, download);
  else {
    showCompleted(event, download);
    if (useLibrary.getState().open) void loadDownloads();
  }
}

export function downloadDropped(event: Finished) {
  if (event.id) cancelled.delete(event.id);
  claim(event);
}

export function forgetDownloadCards() {
  tracked.clear();
  cancelled.clear();
  retrying.clear();
  completed = null;
}
