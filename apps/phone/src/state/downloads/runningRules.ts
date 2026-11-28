import { destinationWords } from "../../lib/sharedWords.ts";
import { fileSizeText } from "../library/libraryText.ts";

export type RunningDownload = {
  id: string;
  fileName: string;
  bytes: number;
  total: number | null;
  fraction: number | null;
  isQueued: boolean;
  isPrivate: boolean | null;
  firstSeen: number;
};

export type ReportedDownload = { id: string; fileName: string; bytes: number; total: number | null; fraction: number | null; isQueued: boolean };

export const DOWNLOAD_INDICATOR_DELAY_MS = 800;

export const DOWNLOADS_IN_PROGRESS = "In progress";

export const DOWNLOADED_FILES = "Downloaded";

const knownTotal = (total: number | null) => (total !== null && total > 0 ? total : null);

export function rowFraction(row: Pick<RunningDownload, "bytes" | "total" | "fraction">): number | null {
  if (row.fraction !== null) return Math.min(1, Math.max(0, row.fraction));
  const total = knownTotal(row.total);
  return total === null ? null : Math.min(1, Math.max(0, row.bytes / total));
}

export function combinedProgress(rows: readonly Pick<RunningDownload, "bytes" | "total" | "fraction">[]): number | null {
  if (rows.length === 0) return null;
  let bytes = 0;
  let total = 0;
  for (const row of rows) {
    const whole = knownTotal(row.total);
    if (whole === null) return null;
    bytes += Math.min(row.bytes, whole);
    total += whole;
  }
  return total > 0 ? Math.min(1, bytes / total) : null;
}

const percentOf = (fraction: number) => Math.floor(Math.min(1, Math.max(0, fraction)) * 100);

export const SPOKEN_PERCENT_STEP = 10;

export function indicatorLabel(count: number, fraction: number | null): string {
  const parts: string[] = [destinationWords.downloads, `${count} in progress`];
  if (fraction !== null) parts.push(`${Math.floor(percentOf(fraction) / SPOKEN_PERCENT_STEP) * SPOKEN_PERCENT_STEP}%`);
  return parts.join(", ");
}

export function runningDetail(row: Pick<RunningDownload, "bytes" | "total" | "fraction" | "isQueued">): string {
  if (row.isQueued) return "Waiting";
  const fraction = rowFraction(row);
  const total = knownTotal(row.total);
  if (fraction === null || total === null) return row.bytes > 0 ? `${fileSizeText(row.bytes)} so far` : "Downloading…";
  return `${percentOf(fraction)}% · ${fileSizeText(row.bytes)} of ${fileSizeText(total)}`;
}

export const cancelDownloadLabel = (fileName: string) => (fileName ? `Cancel ${fileName}` : "Cancel Download");

export function mergeReported(previous: readonly RunningDownload[], reported: readonly ReportedDownload[], meta: ReadonlyMap<string, { isPrivate: boolean; fileName: string; firstSeen: number }>, now: number): RunningDownload[] {
  const before = new Map(previous.map((row) => [row.id, row]));
  return reported.map((row) => {
    const known = before.get(row.id);
    const started = meta.get(row.id);
    return {
      id: row.id,
      fileName: row.fileName || started?.fileName || known?.fileName || "",
      bytes: row.bytes,
      total: knownTotal(row.total) ?? known?.total ?? null,
      fraction: row.fraction,
      isQueued: row.isQueued,
      isPrivate: started?.isPrivate ?? known?.isPrivate ?? null,
      firstSeen: known?.firstSeen ?? started?.firstSeen ?? now,
    };
  });
}

export function indicatorDue(rows: readonly RunningDownload[], now: number): number | null {
  if (rows.length === 0) return null;
  const earliest = Math.min(...rows.map((row) => row.firstSeen));
  return Math.max(0, earliest + DOWNLOAD_INDICATOR_DELAY_MS - now);
}

export const anyPrivate = (rows: readonly RunningDownload[]) => rows.some((row) => row.isPrivate !== false);
