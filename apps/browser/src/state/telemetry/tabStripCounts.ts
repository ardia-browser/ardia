import { takeTabLayoutCounts } from "./tabLayoutCounts";
import { takeTabMotionCounts } from "./tabMotionCounts";
import { onConsentPeriodChange } from "./choice";
import { consentedCount, consentedMax } from "./consentedCount";

const groupToggles = consentedCount();
const textOnlyRows = consentedCount();
const compactLayouts = consentedCount();
const readableLayouts = consentedCount();
const edgeScrollDrags = consentedCount();
const revealsAfterPress = consentedCount();
const mostTabs = consentedMax();
const heldCloses = consentedCount();
const heldCloseStretches = consentedCount();
const mostTitledTabs = consentedMax();
const mostTabsInOverflow = consentedMax();
const scrolls = consentedCount();
const revealsHeldForScroll = consentedCount();
const scrollStalls = consentedCount();
const commandsRefused = consentedCount();
const toggleRemeasures = consentedCount();
let lastScrollAt = -Infinity;
let lastToggle = { windowId: "", at: -Infinity };
onConsentPeriodChange(() => {
  lastScrollAt = -Infinity;
  lastToggle = { windowId: "", at: -Infinity };
});

const TOGGLE_WINDOW_MS = 400;

const NEW_SCROLL_GAP_MS = 250;
const STALL_GAP_MS = 34;

export function noteTabStripGroupToggle(windowId: string, at: number) {
  groupToggles.note();
  lastToggle = { windowId, at };
}

export function noteTabStripChipsMeasured(windowId: string, at: number) {
  if (windowId === lastToggle.windowId && at - lastToggle.at < TOGGLE_WINDOW_MS) toggleRemeasures.note();
}

export function noteTextOnlyRow() {
  textOnlyRows.note();
}

export function noteTabStripCompact() {
  compactLayouts.note();
}

export function noteTabStripReadable() {
  readableLayouts.note();
}

export function noteTabStripEdgeScroll() {
  edgeScrollDrags.note();
}

export function noteTabStripRevealAfterPress() {
  revealsAfterPress.note();
}

export function noteTabStripOverflow(tabs: number) {
  mostTabs.note(tabs);
}

export function noteTabStripTabsInOverflow(tabs: number) {
  mostTabsInOverflow.note(tabs);
}

export function noteTabStripHeldClose() {
  heldCloses.note();
}

export function noteTabStripHeldCloseStretch() {
  heldCloseStretches.note();
}

export function noteTabStripTitledTabs(tabs: number) {
  mostTitledTabs.note(tabs);
}

export function noteTabStripCommandRefused() {
  commandsRefused.note();
}

export function noteTabStripRevealHeldForScroll() {
  revealsHeldForScroll.note();
}

export function noteTabStripScrolled(at: number) {
  const gap = at - lastScrollAt;
  lastScrollAt = at;
  if (gap > NEW_SCROLL_GAP_MS) scrolls.note();
  else if (gap > STALL_GAP_MS) scrollStalls.note();
}

export function takeTabStripCounts() {
  return {
    tab_strip_group_toggles: groupToggles.take(),
    tab_strip_toggle_remeasures: toggleRemeasures.take(),
    pinned_rows_made_text_only: textOnlyRows.take(),
    tab_strip_compact_layouts: compactLayouts.take(),
    tab_strip_readable_layouts: readableLayouts.take(),
    tab_strip_edge_scroll_drags: edgeScrollDrags.take(),
    tab_strip_reveals_after_press: revealsAfterPress.take(),
    tab_strip_most_tabs: mostTabs.take(),
    tab_strip_held_closes: heldCloses.take(),
    tab_strip_held_close_stretches: heldCloseStretches.take(),
    tab_strip_most_titled_tabs: mostTitledTabs.take(),
    tab_strip_most_tabs_in_overflow: mostTabsInOverflow.take(),
    tab_strip_scrolls: scrolls.take(),
    tab_strip_scroll_stalls: scrollStalls.take(),
    tab_strip_reveals_held_for_scroll: revealsHeldForScroll.take(),
    tab_strip_commands_refused: commandsRefused.take(),
    ...takeTabLayoutCounts(),
    ...takeTabMotionCounts(),
  };
}
