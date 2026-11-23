import assert from "node:assert/strict";
import { after, test } from "node:test";
globalThis.__DEV__ = false;
await import("../../test-native/index.ts");
globalThis.fetch = async () => ({ status: 503 });
const client = await import("./client.ts");
import { noteTabLayoutSwitch } from "./tabLayoutCounts.ts";
import {
  noteTabStripChipsMeasured,
  noteTabStripCloseAfterSelect,
  noteTabStripCommandRefused,
  noteTabStripCompact,
  noteTabStripReadable,
  noteTabStripEdgeScroll,
  noteTabStripGroupToggle,
  noteTabStripOverflow,
  noteTabStripHeldClose,
  noteTabStripHeldCloseStretch,
  noteTabStripRevealAfterPress,
  noteTabStripRevealHeldForScroll,
  noteTabStripScrolled,
  noteTabStripMenuPick,
  noteTabStripPick,
  noteTabStripTitledTabs,
  noteTextOnlyRow,
  takeTabStripCounts,
} from "./tabStripCounts.ts";
import { noteTabMotion } from "./tabMotionCounts.ts";
import { noteCloseActivation } from "./closeActivationCounts.ts";
const { consentToken } = await import("./client.ts");

const ZERO = {
  tab_strip_group_toggles: 0,
  tab_strip_toggle_remeasures: 0,
  pinned_rows_made_text_only: 0,
  tab_strip_compact_layouts: 0,
  tab_strip_readable_layouts: 0,
  tab_strip_edge_scroll_drags: 0,
  tab_strip_reveals_after_press: 0,
  tab_strip_most_tabs: 0,
  tab_strip_held_closes: 0,
  tab_strip_held_close_stretches: 0,
  tab_strip_most_titled_tabs: 0,
  tab_strip_picks: 0,
  tab_strip_picks_after_scroll: 0,
  tab_strip_menu_picks: 0,
  tab_strip_scrolls: 0,
  tab_strip_scroll_stalls: 0,
  tab_strip_reveals_held_for_scroll: 0,
  tab_strip_commands_refused: 0,
  tab_strip_closes_after_select_ignored: 0,
  tab_layout_switches_to_top: 0,
  tab_layout_switches_to_sidebar: 0,
  sidebar_tab_open_motions: 0,
  sidebar_tab_close_motions: 0,
  sidebar_tab_motion_interrupts: 0,
  tab_strip_open_motions: 0,
  tab_strip_close_motions: 0,
  tab_strip_motion_interrupts: 0,
  tab_strip_motion_overruns: 0,
  close_activated_tab_above: 0,
  close_tab_above_fallbacks: 0,
};

const sharing = (on) => {
  client.loadChoice();
  client.setSharing(on, "settings");
};
after(() => client.setSharing(false, "settings"));

test("group collapses and expands from the strip are counted, and taking them starts over", () => {
  sharing(true);
  noteTabStripGroupToggle("w1", 1000);
  noteTabStripGroupToggle("w1", 2000);
  noteTextOnlyRow();
  assert.deepEqual(takeTabStripCounts(), { ...ZERO, tab_strip_group_toggles: 2, pinned_rows_made_text_only: 1 });
  assert.deepEqual(takeTabStripCounts(), ZERO);
});

test("a group's name or folders measured again while it opens or closes are counted; measured at any other time or in another window they aren't", () => {
  noteTabStripChipsMeasured("w1", 5000);
  noteTabStripGroupToggle("w1", 10_000);
  takeTabStripCounts();
  noteTabStripChipsMeasured("w1", 10_016);
  noteTabStripChipsMeasured("w2", 10_100);
  noteTabStripChipsMeasured("w1", 10_200);
  noteTabStripChipsMeasured("w1", 10_500);
  assert.deepEqual(takeTabStripCounts(), { ...ZERO, tab_strip_toggle_remeasures: 2 });
});

test("compact layouts, edge-scrolled drags and reveals held for a press are counted, and the most tabs is a maximum, not a sum", () => {
  noteTabStripCompact();
  noteTabStripReadable();
  noteTabStripEdgeScroll();
  noteTabStripEdgeScroll();
  noteTabStripRevealAfterPress();
  noteTabStripOverflow(40);
  noteTabStripOverflow(120);
  noteTabStripOverflow(60);
  assert.deepEqual(takeTabStripCounts(), { ...ZERO, tab_strip_compact_layouts: 1, tab_strip_readable_layouts: 1, tab_strip_edge_scroll_drags: 2, tab_strip_reveals_after_press: 1, tab_strip_most_tabs: 120 });
  assert.deepEqual(takeTabStripCounts(), ZERO);
});

test("closes that land in a held strip are counted, and the most tabs given title room is a maximum", () => {
  noteTabStripHeldClose();
  noteTabStripHeldClose();
  noteTabStripTitledTabs(4);
  noteTabStripTitledTabs(9);
  noteTabStripTitledTabs(2);
  assert.deepEqual(takeTabStripCounts(), { ...ZERO, tab_strip_held_closes: 2, tab_strip_most_titled_tabs: 9 });
  assert.deepEqual(takeTabStripCounts(), ZERO);
});

test("a scroll starts after a quarter second without one, and an update more than two frames after the last is a stall", () => {
  for (const at of [1000, 1016, 1033, 1100, 1116, 2000, 2008]) noteTabStripScrolled("w|p", at);
  noteTabStripRevealHeldForScroll();
  assert.deepEqual(takeTabStripCounts(), { ...ZERO, tab_strip_scrolls: 2, tab_strip_scroll_stalls: 1, tab_strip_reveals_held_for_scroll: 1 });
  assert.deepEqual(takeTabStripCounts(), ZERO);
});

test("tab layout switches go out with the strip's counts, and taking them starts over", () => {
  noteTabLayoutSwitch("top");
  noteTabLayoutSwitch("sidebar");
  noteTabLayoutSwitch("sidebar");
  assert.deepEqual(takeTabStripCounts(), { ...ZERO, tab_layout_switches_to_top: 1, tab_layout_switches_to_sidebar: 2 });
  assert.deepEqual(takeTabStripCounts(), ZERO);
});

let clock = 1e9;
const EVERY_FIELD = [
  ["tab_strip_group_toggles", () => noteTabStripGroupToggle("w", (clock += 10_000)), 1],
  ["tab_strip_toggle_remeasures", () => (noteTabStripGroupToggle("w", (clock += 10_000)), noteTabStripChipsMeasured("w", (clock += 50))), 1],
  ["pinned_rows_made_text_only", () => noteTextOnlyRow(), 1],
  ["tab_strip_compact_layouts", () => noteTabStripCompact(), 1],
  ["tab_strip_readable_layouts", () => noteTabStripReadable(), 1],
  ["tab_strip_edge_scroll_drags", () => noteTabStripEdgeScroll(), 1],
  ["tab_strip_reveals_after_press", () => noteTabStripRevealAfterPress(), 1],
  ["tab_strip_most_tabs", () => noteTabStripOverflow(40), 40],
  ["tab_strip_held_closes", () => noteTabStripHeldClose(), 1],
  ["tab_strip_held_close_stretches", () => noteTabStripHeldCloseStretch(), 1],
  ["tab_strip_most_titled_tabs", () => noteTabStripTitledTabs(6), 6],
  ["tab_strip_picks", () => noteTabStripPick("w|p", (clock += 60_000)), 1],
  ["tab_strip_picks_after_scroll", () => (noteTabStripScrolled("w|p", (clock += 60_000)), noteTabStripPick("w|p", (clock += 2_000))), 1],
  ["tab_strip_menu_picks", () => noteTabStripMenuPick(client.consentToken()), 1],
  ["tab_strip_scrolls", () => noteTabStripScrolled("w|p", (clock += 10_000)), 1],
  ["tab_strip_scroll_stalls", () => (noteTabStripScrolled("w|p", (clock += 10_000)), noteTabStripScrolled("w|p", (clock += 100))), 1],
  ["tab_strip_reveals_held_for_scroll", () => noteTabStripRevealHeldForScroll(), 1],
  ["tab_strip_commands_refused", () => noteTabStripCommandRefused(), 1],
  ["tab_strip_closes_after_select_ignored", () => noteTabStripCloseAfterSelect(), 1],
  ["close_activated_tab_above", () => noteCloseActivation(client.consentToken(), "above"), 1],
  ["close_tab_above_fallbacks", () => noteCloseActivation(client.consentToken(), "fallback"), 1],
];

test("every tab strip count stays at zero while sharing is off, counts once sharing is on, and turning sharing off drops what was counted", () => {
  sharing(true);
  takeTabStripCounts();
  for (const [field, note, counted] of EVERY_FIELD) {
    sharing(false);
    note();
    assert.equal(takeTabStripCounts()[field], 0, `${field} counted with sharing off`);
    sharing(true);
    note();
    assert.equal(takeTabStripCounts()[field], counted, `${field} with sharing on`);
    note();
    sharing(false);
    sharing(true);
    assert.equal(takeTabStripCounts()[field], 0, `${field} kept what was counted before sharing went off`);
  }
});

test("tab opens, closes, interrupts and overruns animated in the sidebar and the strip are counted apart, and only while sharing", () => {
  sharing(false);
  noteTabMotion(consentToken(), "strip", "open");
  assert.deepEqual(takeTabStripCounts(), ZERO);
  sharing(true);
  noteTabMotion(consentToken(), "sidebar", "open", 2);
  noteTabMotion(consentToken(), "sidebar", "close");
  noteTabMotion(consentToken(), "sidebar", "interrupt");
  noteTabMotion(consentToken(), "strip", "open");
  noteTabMotion(consentToken(), "strip", "close", 3);
  noteTabMotion(consentToken(), "strip", "interrupt");
  noteTabMotion(consentToken(), "strip", "overrun");
  assert.deepEqual(takeTabStripCounts(), { ...ZERO, sidebar_tab_open_motions: 2, sidebar_tab_close_motions: 1, sidebar_tab_motion_interrupts: 1, tab_strip_open_motions: 1, tab_strip_close_motions: 3, tab_strip_motion_interrupts: 1, tab_strip_motion_overruns: 1 });
  assert.deepEqual(takeTabStripCounts(), ZERO);
});

test("a tab picked in the strip counts as reached by scrolling only within ten seconds of the strip's last scroll", () => {
  sharing(true);
  takeTabStripCounts();
  noteTabStripScrolled("w|p", (clock += 60_000));
  noteTabStripPick("w|p", (clock += 9_000));
  noteTabStripPick("w|p", (clock += 2_000));
  const counts = takeTabStripCounts();
  assert.deepEqual([counts.tab_strip_picks, counts.tab_strip_picks_after_scroll], [2, 1]);
});

test("a pick counts as reached by scrolling only in the strip that scrolled", () => {
  sharing(true);
  takeTabStripCounts();
  noteTabStripScrolled("a|p", (clock += 60_000));
  noteTabStripPick("b|p", (clock += 1_000));
  noteTabStripPick("a|p", (clock += 1_000));
  const counts = takeTabStripCounts();
  assert.deepEqual([counts.tab_strip_picks, counts.tab_strip_picks_after_scroll], [2, 1]);
});

test("a pick from the open tabs menu counts under the consent taken when the menu opened, not the one when it was chosen", () => {
  sharing(true);
  takeTabStripCounts();
  const opened = client.consentToken();
  sharing(false);
  sharing(true);
  noteTabStripMenuPick(opened);
  assert.equal(takeTabStripCounts().tab_strip_menu_picks, 0);
  noteTabStripMenuPick(client.consentToken());
  assert.equal(takeTabStripCounts().tab_strip_menu_picks, 1);
});
