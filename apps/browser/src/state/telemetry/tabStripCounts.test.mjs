import assert from "node:assert/strict";
import { test } from "node:test";
import {
  noteTabStripCompact,
  noteTabStripEdgeScroll,
  noteTabStripGroupToggle,
  noteTabStripOverflow,
  noteTabStripHeldClose,
  noteTabStripRevealAfterPress,
  noteTabStripTitledTabs,
  noteTextOnlyRow,
  takeTabStripCounts,
} from "./tabStripCounts.ts";

const ZERO = {
  tab_strip_group_toggles: 0,
  pinned_rows_made_text_only: 0,
  tab_strip_compact_layouts: 0,
  tab_strip_edge_scroll_drags: 0,
  tab_strip_reveals_after_press: 0,
  tab_strip_most_tabs: 0,
  tab_strip_held_closes: 0,
  tab_strip_most_titled_tabs: 0,
};

test("group collapses and expands from the strip are counted, and taking them starts over", () => {
  noteTabStripGroupToggle();
  noteTabStripGroupToggle();
  noteTextOnlyRow();
  assert.deepEqual(takeTabStripCounts(), { ...ZERO, tab_strip_group_toggles: 2, pinned_rows_made_text_only: 1 });
  assert.deepEqual(takeTabStripCounts(), ZERO);
});

test("compact layouts, edge-scrolled drags and reveals held for a press are counted, and the most tabs is a maximum, not a sum", () => {
  noteTabStripCompact();
  noteTabStripEdgeScroll();
  noteTabStripEdgeScroll();
  noteTabStripRevealAfterPress();
  noteTabStripOverflow(40);
  noteTabStripOverflow(120);
  noteTabStripOverflow(60);
  assert.deepEqual(takeTabStripCounts(), { ...ZERO, tab_strip_compact_layouts: 1, tab_strip_edge_scroll_drags: 2, tab_strip_reveals_after_press: 1, tab_strip_most_tabs: 120 });
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
