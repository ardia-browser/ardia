import { SyncNative } from "../../platform/sync";

export function takeSyncFileCounts() {
  const counts = SyncNative?.takeFileCounts?.();
  const failures = SyncNative?.takeOpenFailures?.();
  return {
    ...(counts ? { sync_files_online_only: counts.placeholders, sync_files_busy: counts.busy, sync_files_downloaded: counts.hydrated } : {}),
    ...(failures
      ? {
          sync_open_failures_format: failures.format ?? 0,
          sync_open_failures_authentication: failures.authentication ?? 0,
          sync_open_failures_too_large: failures.too_large ?? 0,
          sync_open_failures_other: failures.other ?? 0,
        }
      : {}),
  };
}
