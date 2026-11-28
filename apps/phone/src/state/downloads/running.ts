import { create } from "zustand";
import { indicatorDue, mergeReported, type ReportedDownload, type RunningDownload } from "./runningRules.ts";

export const useRunningDownloads = create<{ running: RunningDownload[]; indicatorShown: boolean }>()(() => ({ running: [], indicatorShown: false }));

const started = new Map<string, { isPrivate: boolean; fileName: string; firstSeen: number }>();
let timer: ReturnType<typeof setTimeout> | null = null;

function settle(running: RunningDownload[], now: number) {
  if (timer) clearTimeout(timer);
  timer = null;
  const due = indicatorDue(running, now);
  const indicatorShown = due === 0;
  useRunningDownloads.setState({ running, indicatorShown });
  if (due !== null && due > 0) {
    timer = setTimeout(() => {
      timer = null;
      settle(useRunningDownloads.getState().running, Date.now());
    }, due);
  }
}

export function noteDownloadStarted(id: string, fileName: string, isPrivate: boolean, total: number | null, now = Date.now()) {
  const firstSeen = useRunningDownloads.getState().running.find((row) => row.id === id)?.firstSeen ?? started.get(id)?.firstSeen ?? now;
  started.set(id, { isPrivate, fileName, firstSeen });
  const running = useRunningDownloads.getState().running;
  const known = running.some((row) => row.id === id);
  const next = known
    ? running.map((row) => (row.id === id ? { ...row, isPrivate, fileName: row.fileName || fileName } : row))
    : [...running, { id, fileName, bytes: 0, total: total !== null && total > 0 ? total : null, fraction: null, isQueued: false, isPrivate, firstSeen }];
  settle(next, now);
}

export function noteDownloadsReported(reported: readonly ReportedDownload[], now = Date.now()) {
  const running = mergeReported(useRunningDownloads.getState().running, reported, started, now);
  settle(running, now);
}

export function noteDownloadEnded(id: string, now = Date.now()) {
  started.delete(id);
  const running = useRunningDownloads.getState().running;
  if (!running.some((row) => row.id === id)) return;
  settle(running.filter((row) => row.id !== id), now);
}

export function forgetRunningDownloads() {
  if (timer) clearTimeout(timer);
  timer = null;
  started.clear();
  useRunningDownloads.setState({ running: [], indicatorShown: false });
}
