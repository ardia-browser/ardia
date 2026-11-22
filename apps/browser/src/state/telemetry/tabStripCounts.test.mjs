import assert from "node:assert/strict";
import { after, test } from "node:test";
globalThis.__DEV__ = false;
await import("../../test-native/index.ts");
globalThis.fetch = async () => ({ status: 503 });
const client = await import("./client.ts");
import { noteTabLayoutSwitch } from "./tabLayoutCounts.ts";
import {
  noteTabStripChipsMeasured,
  noteTabStripToggleHidSelected,
  noteTabStripCommandRefused,
  noteTabStripCompact,
  noteTabStripReadable,
  noteTabStripEdgeScroll,
  noteTabStripGroupToggle,
  noteTabStripOverflow,
  noteTabStripHeldClose,
  noteTabStripRevealAfterPress,
  noteTabStripRevealHeldForScroll,
  noteTabStripScrolled,
  noteTabStripTabsInOverflow,
  noteTabStripTitledTabs,
  noteTextOnlyRow,
  takeTabStripCounts,
} from "./tabStripCounts.ts";

const ZERO = {
  tab_strip_group_toggles: 0,
  tab_strip_toggle_remeasures: 0,
  tab_strip_toggle_hid_selected: 0,
  pinned_rows_made_text_only: 0,
  tab_strip_compact_layouts: 0,
  tab_strip_readable_layouts: 0,
  tab_strip_edge_scroll_drags: 0,
  tab_strip_reveals_after_press: 0,
  tab_strip_most_tabs: 0,
  tab_strip_held_closes: 0,
  tab_strip_most_titled_tabs: 0,
  tab_strip_most_tabs_in_overflow: 0,
  tab_strip_scrolls: 0,
  tab_strip_scroll_stalls: 0,
  tab_strip_reveals_held_for_scroll: 0,
  tab_strip_commands_refused: 0,
  tab_layout_switches_to_top: 0,
  tab_layout_switches_to_sidebar: 0,
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
  for (const at of [1000, 1016, 1033, 1100, 1116, 2000, 2008]) noteTabStripScrolled(at);
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
  ["tab_strip_toggle_hid_selected", () => noteTabStripToggleHidSelected(), 1],
  ["tab_strip_toggle_remeasures", () => (noteTabStripGroupToggle("w", (clock += 10_000)), noteTabStripChipsMeasured("w", (clock += 50))), 1],
  ["pinned_rows_made_text_only", () => noteTextOnlyRow(), 1],
  ["tab_strip_compact_layouts", () => noteTabStripCompact(), 1],
  ["tab_strip_readable_layouts", () => noteTabStripReadable(), 1],
  ["tab_strip_edge_scroll_drags", () => noteTabStripEdgeScroll(), 1],
  ["tab_strip_reveals_after_press", () => noteTabStripRevealAfterPress(), 1],
  ["tab_strip_most_tabs", () => noteTabStripOverflow(40), 40],
  ["tab_strip_held_closes", () => noteTabStripHeldClose(), 1],
  ["tab_strip_most_titled_tabs", () => noteTabStripTitledTabs(6), 6],
  ["tab_strip_most_tabs_in_overflow", () => noteTabStripTabsInOverflow(7), 7],
  ["tab_strip_scrolls", () => noteTabStripScrolled((clock += 10_000)), 1],
  ["tab_strip_scroll_stalls", () => (noteTabStripScrolled((clock += 10_000)), noteTabStripScrolled((clock += 100))), 1],
  ["tab_strip_reveals_held_for_scroll", () => noteTabStripRevealHeldForScroll(), 1],
  ["tab_strip_commands_refused", () => noteTabStripCommandRefused(), 1],
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
