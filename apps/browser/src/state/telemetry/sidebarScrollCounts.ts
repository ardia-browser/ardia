const NEW_SCROLL_GAP_MS = 250;
const STALL_GAP_MS = 34;

let scrolls = 0;
let stalls = 0;
let heldHovers = 0;
let lastScrollAt = -Infinity;

export function noteSidebarScrolled(at: number) {
  const gap = at - lastScrollAt;
  lastScrollAt = at;
  if (gap > NEW_SCROLL_GAP_MS) scrolls++;
  else if (gap > STALL_GAP_MS) stalls++;
}

export function noteSidebarHoverHeld() {
  heldHovers++;
}

export function takeSidebarScrollCounts() {
  const taken = { sidebar_scrolls: scrolls, sidebar_scroll_stalls: stalls, sidebar_scroll_held_hovers: heldHovers };
  scrolls = 0;
  stalls = 0;
  heldHovers = 0;
  return taken;
}
