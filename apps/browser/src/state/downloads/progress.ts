import { create } from "zustand";
import type { Download } from "../../platform/downloads";
import { noteDownloadProgressUpdate } from "../telemetry/downloadWork";

export type DownloadProgress = Pick<Download, "received" | "total" | "speed">;

const NO_PROGRESS: DownloadProgress = { received: 0, total: 0, speed: 0 };

export const useDownloadProgress = create<Record<string, DownloadProgress>>()(() => ({}));

export const withoutProgress = (d: Download): Download => (d.state === "downloading" ? { ...d, ...NO_PROGRESS } : d);

export const withProgress = <D extends Download | undefined>(d: D, progress: DownloadProgress | undefined): D =>
  d && progress && d.state === "downloading" ? { ...d, ...progress } : d;

export const withLiveProgress = (downloads: Download[]): Download[] => {
  const live = useDownloadProgress.getState();
  return downloads.map((d) => withProgress(d, live[d.id]));
};

export const anyDownloadProgress = () => Object.keys(useDownloadProgress.getState()).length > 0;

export function showDownloadProgress(d: Download) {
  const shown = useDownloadProgress.getState()[d.id];
  if (shown && shown.received === d.received && shown.total === d.total && shown.speed === d.speed) return;
  useDownloadProgress.setState({ [d.id]: { received: d.received, total: d.total, speed: d.speed } });
  noteDownloadProgressUpdate();
}

export function forgetDownloadProgress(ids: string[]) {
  const live = useDownloadProgress.getState();
  if (!ids.some((id) => id in live)) return;
  const gone = new Set(ids);
  useDownloadProgress.setState(Object.fromEntries(Object.entries(live).filter(([id]) => !gone.has(id))), true);
}
