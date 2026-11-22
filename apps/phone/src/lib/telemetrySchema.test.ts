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
  const counts = parseDaily(JSON.stringify({ day: "2026-11-13", tabs_opened: -2, searches: 1.5, pins_to_mac: 2 }));
  assert.ok(counts);
  assert.equal(counts.day, "2026-11-13");
  assert.equal(counts.tabs_opened, 0);
  assert.equal(counts.searches, 0);
  assert.equal(counts.pins_to_mac, 2);
  assert.equal(counts.drawn_menu_actions_chosen, 0);
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
