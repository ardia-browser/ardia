let groupToggles = 0;
let textOnlyRows = 0;
let compactLayouts = 0;
let edgeScrollDrags = 0;
let revealsAfterPress = 0;
let mostTabs = 0;
let heldCloses = 0;
let mostTitledTabs = 0;
let mostTabsInOverflow = 0;
let scrolls = 0;
let revealsHeldForScroll = 0;
let scrollStalls = 0;
let commandsRefused = 0;
let lastScrollAt = -Infinity;

const NEW_SCROLL_GAP_MS = 250;
const STALL_GAP_MS = 34;

export function noteTabStripGroupToggle() {
  groupToggles++;
}

export function noteTextOnlyRow() {
  textOnlyRows++;
}

export function noteTabStripCompact() {
  compactLayouts++;
}

export function noteTabStripEdgeScroll() {
  edgeScrollDrags++;
}

export function noteTabStripRevealAfterPress() {
  revealsAfterPress++;
}

export function noteTabStripOverflow(tabs: number) {
  mostTabs = Math.max(mostTabs, tabs);
}

export function noteTabStripTabsInOverflow(tabs: number) {
  mostTabsInOverflow = Math.max(mostTabsInOverflow, tabs);
}

export function noteTabStripHeldClose() {
  heldCloses++;
}

export function noteTabStripTitledTabs(tabs: number) {
  mostTitledTabs = Math.max(mostTitledTabs, tabs);
}

export function noteTabStripCommandRefused() {
  commandsRefused++;
}

export function noteTabStripRevealHeldForScroll() {
  revealsHeldForScroll++;
}

export function noteTabStripScrolled(at: number) {
  const gap = at - lastScrollAt;
  lastScrollAt = at;
  if (gap > NEW_SCROLL_GAP_MS) scrolls++;
  else if (gap > STALL_GAP_MS) scrollStalls++;
}

export function takeTabStripCounts() {
  const taken = {
    tab_strip_group_toggles: groupToggles,
    pinned_rows_made_text_only: textOnlyRows,
    tab_strip_compact_layouts: compactLayouts,
    tab_strip_edge_scroll_drags: edgeScrollDrags,
    tab_strip_reveals_after_press: revealsAfterPress,
    tab_strip_most_tabs: mostTabs,
    tab_strip_held_closes: heldCloses,
    tab_strip_most_titled_tabs: mostTitledTabs,
    tab_strip_most_tabs_in_overflow: mostTabsInOverflow,
    tab_strip_scrolls: scrolls,
    tab_strip_scroll_stalls: scrollStalls,
    tab_strip_reveals_held_for_scroll: revealsHeldForScroll,
    tab_strip_commands_refused: commandsRefused,
  };
  groupToggles = 0;
  textOnlyRows = 0;
  compactLayouts = 0;
  edgeScrollDrags = 0;
  revealsAfterPress = 0;
  mostTabs = 0;
  heldCloses = 0;
  mostTitledTabs = 0;
  mostTabsInOverflow = 0;
  scrolls = 0;
  scrollStalls = 0;
  revealsHeldForScroll = 0;
  commandsRefused = 0;
  return taken;
}
