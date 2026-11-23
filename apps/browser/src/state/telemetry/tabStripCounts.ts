import { takeTabLayoutCounts } from "./tabLayoutCounts";
import { takeTabMotionCounts } from "./tabMotionCounts";
import { isSharing, onConsentPeriodChange } from "./choice";
import { consentedCount, consentedMax } from "./consentedCount";
import { countFor, type ConsentToken } from "./consentPeriod";

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
const picks = consentedCount();
const picksAfterScroll = consentedCount();
let menuPicks = 0;
const scrolls = consentedCount();
const revealsHeldForScroll = consentedCount();
const scrollStalls = consentedCount();
const commandsRefused = consentedCount();
const toggleRemeasures = consentedCount();
const closesAfterSelect = consentedCount();
const lastScrollAt = new Map<string, number>();
let lastToggle = { windowId: "", at: -Infinity };
onConsentPeriodChange(() => {
  lastScrollAt.clear();
  menuPicks = 0;
  lastToggle = { windowId: "", at: -Infinity };
});

const TOGGLE_WINDOW_MS = 400;

const NEW_SCROLL_GAP_MS = 250;
const STALL_GAP_MS = 34;
const PICK_AFTER_SCROLL_MS = 10000;

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

export function noteTabStripPick(strip: string, at: number) {
  picks.note();
  if (at - (lastScrollAt.get(strip) ?? -Infinity) < PICK_AFTER_SCROLL_MS) picksAfterScroll.note();
}

export function noteTabStripMenuPick(consent: ConsentToken | null) {
  countFor(consent, () => void menuPicks++);
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

export function noteTabStripCloseAfterSelect() {
  closesAfterSelect.note();
}

export function noteTabStripScrolled(strip: string, at: number) {
  if (!isSharing()) return;
  const gap = at - (lastScrollAt.get(strip) ?? -Infinity);
  if (gap > NEW_SCROLL_GAP_MS) for (const [key, when] of lastScrollAt) if (at - when > PICK_AFTER_SCROLL_MS) lastScrollAt.delete(key);
  lastScrollAt.set(strip, at);
  if (gap > NEW_SCROLL_GAP_MS) scrolls.note();
  else if (gap > STALL_GAP_MS) scrollStalls.note();
}

function takeMenuPicks() {
  const taken = menuPicks;
  menuPicks = 0;
  return taken;
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
    tab_strip_picks: picks.take(),
    tab_strip_picks_after_scroll: picksAfterScroll.take(),
    tab_strip_menu_picks: takeMenuPicks(),
    tab_strip_scrolls: scrolls.take(),
    tab_strip_scroll_stalls: scrollStalls.take(),
    tab_strip_reveals_held_for_scroll: revealsHeldForScroll.take(),
    tab_strip_commands_refused: commandsRefused.take(),
    tab_strip_closes_after_select_ignored: closesAfterSelect.take(),
    ...takeTabLayoutCounts(),
    ...takeTabMotionCounts(),
  };
}
