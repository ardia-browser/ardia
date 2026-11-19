import type { ConsentToken } from "./choice";
import { countFor } from "./countFor";

let asked = 0;
let cancelled = 0;
let askedWithDownloads = 0;
let cancelledWithDownloads = 0;

export function noteQuitAskedAfterTabsConfirm(wasCancelled: boolean, consent?: ConsentToken | null) {
  countFor(consent, () => void (asked++, wasCancelled && cancelled++), { quit_warnings_after_tabs_confirm: 1, quit_warnings_after_tabs_confirm_cancelled: +wasCancelled });
}

export function noteQuitAskedWithDownloads(wasCancelled: boolean, consent?: ConsentToken | null) {
  countFor(consent, () => void (askedWithDownloads++, wasCancelled && cancelledWithDownloads++), { quit_warnings_with_downloads: 1, quit_warnings_with_downloads_cancelled: +wasCancelled });
}

export function takeQuitWarningCounts() {
  const taken = { quit_warnings_after_tabs_confirm: asked, quit_warnings_after_tabs_confirm_cancelled: cancelled, quit_warnings_with_downloads: askedWithDownloads, quit_warnings_with_downloads_cancelled: cancelledWithDownloads };
  asked = cancelled = askedWithDownloads = cancelledWithDownloads = 0;
  return taken;
}
