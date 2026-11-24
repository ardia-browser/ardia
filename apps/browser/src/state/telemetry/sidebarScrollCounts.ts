import { onConsentPeriodChange, type ConsentToken } from "./choice";
import { consentOrNow, countFor } from "./countFor";

const NEW_SCROLL_GAP_MS = 250;
const STALL_GAP_MS = 34;

let scrolls = 0;
let stalls = 0;
let heldHovers = 0;
let heldTeardowns = 0;
let newTabDocks = 0;
let newTabUndocks = 0;
let lastScrollAt = -Infinity;
onConsentPeriodChange(() => (lastScrollAt = -Infinity));

export function noteSidebarScrolled(at: number) {
  const gap = at - lastScrollAt;
  lastScrollAt = at;
  if (gap > NEW_SCROLL_GAP_MS) scrolls++;
  else if (gap > STALL_GAP_MS) stalls++;
}

export function noteSidebarHoverHeld() {
  heldHovers++;
}

export function noteSidebarTeardownHeld(consent?: ConsentToken | null) {
  countFor(consentOrNow(consent), () => void heldTeardowns++);
}

export function noteNewTabDocked(docked: boolean) {
  if (docked) newTabDocks++;
  else newTabUndocks++;
}

export function takeSidebarScrollCounts() {
  const taken = { sidebar_scrolls: scrolls, sidebar_scroll_stalls: stalls, sidebar_scroll_held_hovers: heldHovers, sidebar_scroll_held_teardowns: heldTeardowns, sidebar_new_tab_docks: newTabDocks, sidebar_new_tab_undocks: newTabUndocks };
  scrolls = 0;
  stalls = 0;
  heldHovers = 0;
  heldTeardowns = 0;
  newTabDocks = 0;
  newTabUndocks = 0;
  return taken;
}
