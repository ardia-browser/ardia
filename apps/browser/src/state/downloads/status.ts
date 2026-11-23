import { bytesProgress, formatBytes, formatTimeLeft } from "../../lib/transferText";
import type { Download } from "./actions";

export const awaitsKeep = (d: Pick<Download, "state" | "dangerous">) => d.state === "downloading" && d.dangerous === true;

export function dangerWarning(d: Download, short = false) {
  if (d.url.startsWith("http:")) return short ? "Blocked: not secure" : "Insecure download blocked";
  return short ? "Blocked: unsafe file type" : "This type of file can harm your computer";
}

export function downloadStatus(d: Download, exists = true) {
  if (d.state === "finished") return exists ? formatBytes(d.total > 0 ? d.total : d.received) : "Deleted";
  if (d.state === "failed") return "Failed to Download";
  if (d.state === "cancelled") return "Cancelled";
  if (awaitsKeep(d)) return dangerWarning(d);
  const progress = bytesProgress(d.received, d.total);
  if (d.paused) return `${progress} — Paused`;
  if (d.speed <= 0) return progress;
  const withSpeed = `${progress}, ${formatBytes(d.speed)}/s`;
  return d.total > 0 ? `${withSpeed} — ${formatTimeLeft((d.total - d.received) / d.speed)}` : withSpeed;
}
