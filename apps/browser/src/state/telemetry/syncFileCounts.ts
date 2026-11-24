import { SyncNative } from "../../platform/sync";
import { countFor, type ConsentToken } from "./consentPeriod";

export type SyncOpenFailure = "format" | "authentication" | "too_large" | "other";
export const SYNC_OPEN_FAILURES: readonly SyncOpenFailure[] = ["format", "authentication", "too_large", "other"];

const noFailures = (): Record<SyncOpenFailure, number> => ({ format: 0, authentication: 0, too_large: 0, other: 0 });
let hostFailures = noFailures();

export function noteSyncOpenFailures(consent: ConsentToken | null, failures: Partial<Record<SyncOpenFailure, number>>) {
  countFor(consent, () => {
    for (const code of SYNC_OPEN_FAILURES) {
      const count = failures[code];
      if (typeof count === "number" && Number.isSafeInteger(count) && count > 0) hostFailures[code] += count;
    }
  });
}

export function takeSyncFileCounts() {
  const counts = SyncNative?.takeFileCounts?.();
  const native = SyncNative?.takeOpenFailures?.();
  const host = hostFailures;
  hostFailures = noFailures();
  const failures = native || SYNC_OPEN_FAILURES.some((code) => host[code] > 0) ? native ?? {} : null;
  return {
    ...(counts ? { sync_files_online_only: counts.placeholders, sync_files_busy: counts.busy, sync_files_downloaded: counts.hydrated } : {}),
    ...(failures
      ? {
          sync_open_failures_format: (failures.format ?? 0) + host.format,
          sync_open_failures_authentication: (failures.authentication ?? 0) + host.authentication,
          sync_open_failures_too_large: (failures.too_large ?? 0) + host.too_large,
          sync_open_failures_other: (failures.other ?? 0) + host.other,
        }
      : {}),
  };
}
