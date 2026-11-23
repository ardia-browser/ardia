import type { ConsentToken } from "./choice";
import { consentOrNow, countFor } from "./countFor";

const NO_COUNTS = { new_profile_downloads_shared: 0, new_profile_downloads_share_failed: 0, download_folders_found_separate: 0 };
let counts = { ...NO_COUNTS };

const count = (key: keyof typeof NO_COUNTS) => (consent?: ConsentToken | null) => countFor(consentOrNow(consent), () => void counts[key]++);

export const noteNewProfileDownloadsShared = count("new_profile_downloads_shared");
export const noteNewProfileDownloadsShareFailed = count("new_profile_downloads_share_failed");
export const noteDownloadFoldersFoundSeparate = count("download_folders_found_separate");

export function takeDownloadFolderCounts() {
  const taken = counts;
  counts = { ...NO_COUNTS };
  return taken;
}
