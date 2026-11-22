import type { ConsentToken } from "./choice";
import { consentOrNow, countFor } from "./countFor";

let asked = 0;
let cancelled = 0;

export function noteQuitAskedAfterTabsConfirm(wasCancelled: boolean, consent?: ConsentToken | null) {
  countFor(consentOrNow(consent), () => void (asked++, wasCancelled && cancelled++));
}

export function takeQuitWarningCounts() {
  const taken = { quit_warnings_after_tabs_confirm: asked, quit_warnings_after_tabs_confirm_cancelled: cancelled };
  asked = cancelled = 0;
  return taken;
}
