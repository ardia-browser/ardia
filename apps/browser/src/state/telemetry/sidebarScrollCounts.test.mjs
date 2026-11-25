import assert from "node:assert/strict";
import { test } from "node:test";

const { noteNewTabDocked, noteSidebarHoverHeld, noteSidebarScrolled, noteSidebarTeardownHeld } = await import("./sidebarScrollCounts.ts");
const { takeSidebarResizeCounts } = await import("./sidebarResizeCounts.ts");
const { setConsentPeriod } = await import("./consentPeriod.ts");

test("a scroll counts once, its updates more than 34 ms apart count as stutters, and the counts start again from zero", () => {
  setConsentPeriod(true, "sidebar-scroll");
  takeSidebarResizeCounts();
  for (const at of [1000, 1016, 1032, 1080, 1096]) noteSidebarScrolled(at);
  for (const at of [2000, 2016]) noteSidebarScrolled(at);
  noteSidebarHoverHeld();
  noteSidebarTeardownHeld();
  noteNewTabDocked(true);
  noteNewTabDocked(false);
  noteNewTabDocked(true);
  assert.deepEqual(takeSidebarResizeCounts(), { sidebar_resizes: 0, sidebar_scrolls: 2, sidebar_scroll_stalls: 1, sidebar_scroll_held_hovers: 1, sidebar_scroll_held_teardowns: 1, sidebar_new_tab_docks: 2, sidebar_new_tab_undocks: 1, sidebar_folds: 0, sidebar_fold_stutters: 0, sidebar_fold_overruns: 0 });
  assert.deepEqual(takeSidebarResizeCounts(), { sidebar_resizes: 0, sidebar_scrolls: 0, sidebar_scroll_stalls: 0, sidebar_scroll_held_hovers: 0, sidebar_scroll_held_teardowns: 0, sidebar_new_tab_docks: 0, sidebar_new_tab_undocks: 0, sidebar_folds: 0, sidebar_fold_stutters: 0, sidebar_fold_overruns: 0 });
  setConsentPeriod(false, null);
  noteSidebarTeardownHeld();
  assert.equal(takeSidebarResizeCounts().sidebar_scroll_held_teardowns, 0);
});
