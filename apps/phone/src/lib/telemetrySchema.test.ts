import assert from "node:assert/strict";
import { test } from "node:test";
import { appVersionOf, backdropProps, launchProps, launchTrayProps, legacyImportOutcome, osVersionOf, parseDaily, pendingUsage, rollOver } from "./telemetrySchema.ts";

test("launch timings are measured from the process start, and dropped when it is unknown or out of range", () => {
  assert.deepEqual(launchProps(1000, 1300, 1900), { launch_ms: 900, js_ms: 300 });
  assert.equal(launchProps(null, 1300, 1900), null);
  assert.equal(launchProps(2000, 1300, 1900), null);
  assert.equal(launchProps(0, 1, 700_001), null);
});

test("the old app's import reads as imported, started fresh or none from how the launch got past it", () => {
  assert.equal(legacyImportOutcome("imported"), "imported");
  assert.equal(legacyImportOutcome("startedFresh"), "started_fresh");
  assert.equal(legacyImportOutcome("none"), "none");
  assert.equal(legacyImportOutcome(null), "none");
});

test("versions keep only their numbers", () => {
  assert.equal(osVersionOf(35), "35");
  assert.equal(osVersionOf("18.1.1"), "18.1.1");
  assert.equal(osVersionOf("15 (Ada's build)"), "15");
  assert.equal(appVersionOf("1.0.0"), "1.0.0");
  assert.equal(appVersionOf("Ardia nightly"), "0");
});

test("a damaged day of counts starts over rather than sending something odd", () => {
  assert.equal(parseDaily("{"), null);
  assert.equal(parseDaily(JSON.stringify({ day: "yesterday", tabs_opened: 3 })), null);
  assert.deepEqual(parseDaily(JSON.stringify({ day: "2026-11-13", tabs_opened: -2, searches: 1.5, pins_to_mac: 2 })), { day: "2026-11-13", tabs_opened: 0, searches: 0, pins_to_mac: 2, tabs_sent: 0, page_processes_gone: 0, links_given_up: 0, pages_reloaded_online: 0, find_opened_system: 0, find_opened_bar: 0, spaces_swiped: 0, tray_hidden_rows_opened: 0, deck_pictures_late: 0, tray_back_swiped: 0, search_tabs_opened: 0, spaces_picked: 0, tabs_moved_to_space: 0, pages_printed: 0, pages_translated: 0, pinned_tabs_refound: 0, site_permissions_revoked: 0, card_opens_waited: 0, native_menus_opened: 0, library_opened: 0, deck_grid_shown: 0, landscape_shown: 0, duo_layout_shown: 0, list_sheets_late: 0, list_pages_added: 0, search_reveals_late: 0, address_field_scrolled: 0 });
  assert.deepEqual(rollOver(null, "2026-11-14").due, null);
});

test("counts kept by native while JavaScript wasn't running come back as one count per send, only for known fields and whole positive numbers", () => {
  assert.deepEqual(pendingUsage({ tabs_sent: 2 }), ["tabs_sent", "tabs_sent"]);
  assert.deepEqual(pendingUsage({ tabs_sent: 1, tabs_opened: 1 }), ["tabs_opened", "tabs_sent"]);
  assert.deepEqual(pendingUsage({ made_up: 3, tabs_sent: -1, searches: 1.5, pins_to_mac: "2" }), []);
  assert.equal(pendingUsage({ tabs_sent: 1e9 }).length, 1000);
});

test("the backdrop's time is the native backdrop's first frame after the process start, and nothing without either", () => {
  assert.deepEqual(backdropProps(1000, 2100), { backdrop_ms: 1100 });
  assert.equal(backdropProps(null, 2100), null);
  assert.equal(backdropProps(1000, null), null);
  assert.equal(backdropProps(3000, 2100), null);
});

test("the launch tray's time runs from the process start to the tray being up, and nothing without a start or before it", () => {
  assert.deepEqual(launchTrayProps(1000, 1900), { tray_ms: 900 });
  assert.equal(launchTrayProps(null, 1900), null);
  assert.equal(launchTrayProps(3000, 1900), null);
});
