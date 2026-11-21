import assert from "node:assert/strict";
import { test } from "node:test";

const { noteClickRename, noteNewTabDocked, noteSidebarHoverHeld, noteSidebarScrolled } = await import("./sidebarScrollCounts.ts");
const { takeSidebarResizeCounts } = await import("./sidebarResizeCounts.ts");
const { setConsentPeriod, consentToken } = await import("./consentPeriod.ts");

test("a scroll counts once, its updates more than 34 ms apart count as stutters, and the counts start again from zero", () => {
  takeSidebarResizeCounts();
  for (const at of [1000, 1016, 1032, 1080, 1096]) noteSidebarScrolled(at);
  for (const at of [2000, 2016]) noteSidebarScrolled(at);
  noteSidebarHoverHeld();
  noteNewTabDocked(true);
  noteNewTabDocked(false);
  noteNewTabDocked(true);
  setConsentPeriod(true, "epoch");
  noteClickRename(consentToken());
  noteClickRename(null);
  assert.deepEqual(takeSidebarResizeCounts(), { sidebar_resizes: 0, sidebar_scrolls: 2, sidebar_scroll_stalls: 1, sidebar_scroll_held_hovers: 1, sidebar_new_tab_docks: 2, sidebar_new_tab_undocks: 1, sidebar_click_renames: 1 });
  assert.deepEqual(takeSidebarResizeCounts(), { sidebar_resizes: 0, sidebar_scrolls: 0, sidebar_scroll_stalls: 0, sidebar_scroll_held_hovers: 0, sidebar_new_tab_docks: 0, sidebar_new_tab_undocks: 0, sidebar_click_renames: 0 });
});
