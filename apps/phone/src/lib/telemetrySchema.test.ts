import assert from "node:assert/strict";
import { test } from "node:test";
import { appVersionOf, backdropProps, browseForMeCounts, COUNTED, geminiNanoMissingCount, launchProps, launchTrayProps, legacyImportOutcome, osVersionOf, pageSummaryOpenedCount, pageSummarySettledCount, pageSummarySettledCounts, parseDaily, pendingUsage, rollOver, talkToMeCount } from "./telemetrySchema.ts";

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
  assert.deepEqual(parseDaily(JSON.stringify({ day: "2026-11-13", tabs_opened: -2, searches: 1.5, pins_to_mac: 2 })), { day: "2026-11-13", tabs_opened: 0, searches: 0, pins_to_mac: 2, tabs_sent: 0, page_processes_gone: 0, links_given_up: 0, pages_reloaded_online: 0, find_opened_system: 0, find_opened_bar: 0, find_closed_bar: 0, spaces_swiped: 0, tray_hidden_rows_opened: 0, deck_pictures_late: 0, tray_back_swiped: 0, search_tabs_opened: 0, spaces_picked: 0, tabs_moved_to_space: 0, pages_printed: 0, pages_translated: 0, pinned_tabs_refound: 0, site_permissions_revoked: 0, card_opens_waited: 0, native_menus_opened: 0, drawn_menus_opened: 0, library_opened: 0, deck_grid_shown: 0, landscape_shown: 0, duo_layout_shown: 0, list_sheets_late: 0, list_pages_added: 0, search_reveals_late: 0, address_field_scrolled: 0, deck_bar_swipes: 0, tabs_swiped_closed: 0, tabs_swiped_reopened: 0, page_menu_tapped_away: 0, new_tab_search_opened: 0, new_tab_pins_opened: 0, deck_incognito_switches: 0, deck_bar_swipes_returned: 0, tabs_bar_swiped: 0, tab_swipe_hints_shown: 0, deck_pulls_hitched: 0, bottom_bar_collapses: 0, browse_for_me_opened: 0, browse_answers_chatgpt: 0, browse_answers_on_device: 0, browse_answers_excerpts: 0, browse_answers_failed: 0, browse_chatgpt_fallbacks: 0, page_summaries_pinched: 0, page_summaries_from_menu: 0, page_summaries_on_device: 0, page_summaries_excerpts: 0, page_summaries_failed: 0, page_summaries_chatgpt: 0, page_summaries_chatgpt_fallbacks: 0, gemini_nano_downloading: 0, gemini_nano_not_offered: 0, gemini_nano_needs_update: 0, gemini_nano_errors: 0, gemini_nano_download_failed: 0, gemini_nano_write_failed: 0, gemini_nano_download_rewrites: 0, paste_and_go_links: 0, paste_and_go_texts: 0, paste_and_go_unread: 0, search_tile_taps: 0, voice_tile_taps: 0, incognito_tile_taps: 0, start_logo_taps: 0, card_close_tapped: 0, material_back_swiped: 0, archive_bar_opened: 0, site_settings_sheet_opened: 0, search_sheet_expanded: 0, site_settings_sheet_expanded: 0, material_you_turned_on: 0, material_you_turned_off: 0, talk_to_me_answers_read: 0, talk_to_me_ear_listens: 0, talk_to_me_voice_downloads: 0, talk_to_me_download_failed: 0, talk_to_me_failed: 0, start_no_tabs_button_taps: 0, night_shade_verdicts_reused: 0, night_shade_verdicts_learned: 0, night_shade_verdicts_corrected: 0, page_pictures_blank: 0, page_pictures_hidden: 0, page_pictures_webkit: 0, page_pictures_scrolled: 0, custom_theme_chosen: 0, theme_edits: 0, settings_panes_opened: 0, tray_incognito_switches: 0, incognito_unavailable: 0, deck_pictures_at_press: 0, deck_opens_while_landing: 0, tab_writes_stalled: 0, page_covers_capped: 0, search_opens_cold: 0, searches_forgotten: 0, glass_shaders_failed: 0, archive_card_reoffers: 0, drawn_menu_actions_chosen: 0, glass_unsourced: 0, web_videos_floated: 0, web_videos_kept_playing: 0, glass_captures_over_budget: 0, glass_lens_bridged: 0, app_update_checks: 0, app_update_offers_shown: 0, app_update_offers_opened: 0, app_update_handoffs_failed: 0, app_update_installs_started: 0, app_update_checksums_refused: 0, app_update_installs_failed: 0, app_update_installs_cancelled: 0, app_update_installs_completed: 0, glass_lens_withheld: 0, js_errors: 0 });
  assert.deepEqual(rollOver(null, "2026-11-14").due, null);
});

test("Android's Night Shade verdict counts, kept by native, come back as usage counts", () => {
  assert.deepEqual(pendingUsage({ night_shade_verdicts_reused: 2, night_shade_verdicts_learned: 1, night_shade_verdicts_corrected: 1 }), ["night_shade_verdicts_reused", "night_shade_verdicts_reused", "night_shade_verdicts_learned", "night_shade_verdicts_corrected"]);
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

test("a Browse for Me answer counts once under the writer that wrote it, and a ChatGPT answer that fell back counts its fallback too", () => {
  assert.deepEqual(browseForMeCounts("chatgpt", false), ["browse_answers_chatgpt"]);
  assert.deepEqual(browseForMeCounts("on_device", false), ["browse_answers_on_device"]);
  assert.deepEqual(browseForMeCounts("on_device", true), ["browse_answers_on_device", "browse_chatgpt_fallbacks"]);
  assert.deepEqual(browseForMeCounts("excerpts", true), ["browse_answers_excerpts", "browse_chatgpt_fallbacks"]);
  assert.deepEqual(browseForMeCounts("failed", false), ["browse_answers_failed"]);
  for (const field of ["browse_for_me_opened", "browse_answers_chatgpt", "browse_answers_on_device", "browse_answers_excerpts", "browse_answers_failed", "browse_chatgpt_fallbacks"]) assert.ok((COUNTED as readonly string[]).includes(field), field);
});

test("Talk to Me counts only its five outcomes, each under its own field", () => {
  assert.equal(talkToMeCount("answers_read"), "talk_to_me_answers_read");
  assert.equal(talkToMeCount("ear_listens"), "talk_to_me_ear_listens");
  assert.equal(talkToMeCount("voice_downloads"), "talk_to_me_voice_downloads");
  assert.equal(talkToMeCount("download_failed"), "talk_to_me_download_failed");
  assert.equal(talkToMeCount("failed"), "talk_to_me_failed");
  assert.equal(talkToMeCount("toString"), null);
  assert.equal(talkToMeCount("Harper"), null);
  for (const field of ["talk_to_me_answers_read", "talk_to_me_ear_listens", "talk_to_me_voice_downloads", "talk_to_me_download_failed", "talk_to_me_failed"]) assert.ok((COUNTED as readonly string[]).includes(field), field);
});

test("page summaries count how they opened and who wrote them, and nothing else", () => {
  assert.equal(pageSummaryOpenedCount("pinch"), "page_summaries_pinched");
  assert.equal(pageSummaryOpenedCount("menu"), "page_summaries_from_menu");
  assert.equal(pageSummaryOpenedCount("chatgpt"), null);
  assert.equal(pageSummarySettledCount("on_device"), "page_summaries_on_device");
  assert.equal(pageSummarySettledCount("excerpts"), "page_summaries_excerpts");
  assert.equal(pageSummarySettledCount("failed"), "page_summaries_failed");
  assert.equal(pageSummarySettledCount("https://example.com"), null);
  for (const field of ["page_summaries_pinched", "page_summaries_from_menu", "page_summaries_on_device", "page_summaries_excerpts", "page_summaries_failed"]) assert.ok((COUNTED as readonly string[]).includes(field), field);
});

test("an Android page summary counts once under who wrote it, and a ChatGPT summary the phone had to write also counts as a fallback", () => {
  assert.equal(pageSummarySettledCount("chatgpt"), "page_summaries_chatgpt");
  assert.deepEqual(pageSummarySettledCounts("chatgpt", false), ["page_summaries_chatgpt"]);
  assert.deepEqual(pageSummarySettledCounts("on_device", undefined), ["page_summaries_on_device"]);
  assert.deepEqual(pageSummarySettledCounts("on_device", true), ["page_summaries_on_device", "page_summaries_chatgpt_fallbacks"]);
  assert.deepEqual(pageSummarySettledCounts("excerpts", true), ["page_summaries_excerpts", "page_summaries_chatgpt_fallbacks"]);
  assert.deepEqual(pageSummarySettledCounts("failed", true), ["page_summaries_failed"]);
  assert.deepEqual(pageSummarySettledCounts("https://example.com", true), []);
  for (const field of ["page_summaries_chatgpt", "page_summaries_chatgpt_fallbacks"]) assert.ok((COUNTED as readonly string[]).includes(field), field);
});

test("Android counts why Gemini Nano wasn't used, and nothing for an unknown reason or when it was", () => {
  assert.deepEqual(geminiNanoMissingCount("not_offered"), ["gemini_nano_not_offered"]);
  assert.deepEqual(geminiNanoMissingCount("needs_update"), ["gemini_nano_needs_update"]);
  assert.deepEqual(geminiNanoMissingCount("downloading"), ["gemini_nano_downloading"]);
  assert.deepEqual(geminiNanoMissingCount("errors"), ["gemini_nano_errors"]);
  assert.deepEqual(geminiNanoMissingCount("download_failed"), ["gemini_nano_download_failed"]);
  assert.deepEqual(geminiNanoMissingCount("write_failed"), ["gemini_nano_write_failed"]);
  assert.deepEqual(geminiNanoMissingCount(null), []);
  assert.deepEqual(geminiNanoMissingCount(undefined), []);
  assert.deepEqual(geminiNanoMissingCount("toString"), []);
  for (const field of ["gemini_nano_downloading", "gemini_nano_not_offered", "gemini_nano_needs_update", "gemini_nano_errors", "gemini_nano_download_failed", "gemini_nano_write_failed", "gemini_nano_download_rewrites"]) assert.ok((COUNTED as readonly string[]).includes(field), field);
});
