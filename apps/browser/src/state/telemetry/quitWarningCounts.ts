import type { ConsentToken } from "./choice";
import { countFor } from "./countFor";

let asked = 0;
let cancelled = 0;

export function noteQuitAskedAfterTabsConfirm(wasCancelled: boolean, consent?: ConsentToken | null) {
  countFor(consent, () => void (asked++, wasCancelled && cancelled++), { quit_warnings_after_tabs_confirm: 1, quit_warnings_after_tabs_confirm_cancelled: +wasCancelled });
}

export function takeQuitWarningCounts() {
  const taken = { quit_warnings_after_tabs_confirm: asked, quit_warnings_after_tabs_confirm_cancelled: cancelled };
  asked = cancelled = 0;
  return taken;
}
