import type { ConsentToken } from "./choice";
import { consentedCount } from "./consentedCount";
import { countFor } from "./countFor";

let linuxInsidePresses: ReturnType<typeof consentedCount> | undefined;

export function noteLinuxDownloadsPanelInsidePress() {
  linuxInsidePresses ??= consentedCount();
  linuxInsidePresses.note();
}

const NO_COUNTS = { downloads_panel_press_closes: 0, downloads_panel_held_opens: 0, download_archives_opened: 0 };
let counts = { ...NO_COUNTS };

const KEYS = {
  pressClose: "downloads_panel_press_closes",
  heldOpen: "downloads_panel_held_opens",
  archiveOpen: "download_archives_opened",
} as const;

export const noteDownloadsPanel = (event: keyof typeof KEYS, consent?: ConsentToken | null) => countFor(consent, () => void counts[KEYS[event]]++, { [KEYS[event]]: 1 });

export function takeDownloadsPanelCounts() {
  const taken = counts;
  counts = { ...NO_COUNTS };
  return { ...taken, linux_downloads_panel_inside_presses: linuxInsidePresses?.take() ?? 0 };
}
