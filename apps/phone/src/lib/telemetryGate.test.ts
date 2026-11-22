import assert from "node:assert/strict";
import { test } from "node:test";
import { importPreferences } from "../state/legacy/importRules.ts";
import { createGate, DAILY_KEY, INSTALL_KEY, SHARING_KEY, type GateDeps } from "./telemetryGate.ts";
import { recordProblems, type PhoneRecord } from "./telemetrySchema.ts";

const DAY = 86_400_000;
const START = Date.parse("2026-11-14T10:00:00.000Z");

function harness(initial: Record<string, string> = {}) {
  const stored = new Map(Object.entries(initial));
  const posts: string[] = [];
  const writes: string[] = [];
  const timers: (() => void)[] = [];
  let clock = START;
  let ids = 0;
  let status = 200;
  const deps: GateDeps = {
    store: {
      read: (key) => stored.get(key) ?? null,
      write: (key, value) => {
        writes.push(key);
        if (value === null) stored.delete(key);
        else stored.set(key, value);
      },
    },
    post: async (body) => {
      posts.push(body);
      return status;
    },
    canPost: () => true,
    newId: () => `00000000-0000-4000-8000-${String(++ids).padStart(12, "0")}`,
    device: () => ({ platform: "android", appVersion: "1.0.0", osVersion: "15", environment: "production" }),
    now: () => clock,
    setTimer: (run) => {
      timers.push(run);
      return timers.length;
    },
    clearTimer: () => {},
  };
  const gate = createGate(deps);
  gate.load();
  const runTimers = async () => {
    while (timers.length) {
      timers.shift()!();
      await new Promise((done) => setImmediate(done));
    }
  };
  const sent = (): PhoneRecord[] =>
    posts.flatMap((body) =>
      JSON.parse(body).resourceLogs[0].scopeLogs[0].logRecords.map((record: { attributes: { key: string; value: Record<string, unknown> }[] }) => {
        const decode = (value: Record<string, unknown>) => ("intValue" in value ? Number(value.intValue) : Object.values(value)[0]);
        const values = Object.fromEntries(record.attributes.map((a) => [a.key, decode(a.value)]));
        const { event, uuid, distinct_id, ...properties } = values;
        return { event, uuid, distinct_id, timestamp: new Date(START).toISOString(), properties } as PhoneRecord;
      }),
    );
  return { gate, stored, posts, writes, timers, runTimers, sent, advance: (ms: number) => (clock += ms), fail: (code: number) => (status = code) };
}

test("a fresh install starts with sharing off and no install ID", () => {
  const { gate, stored } = harness();
  assert.equal(gate.isSharing(), false);
  assert.equal(gate.decided(), false);
  assert.equal(stored.get(INSTALL_KEY), undefined);
});

test("the import from the old app cannot switch sharing on", () => {
  const { values } = importPreferences({ [SHARING_KEY]: "on", [INSTALL_KEY]: "00000000-0000-4000-8000-000000000001", "telemetry.enabled": true, shareUsage: true });
  assert.deepEqual(Object.keys(values).filter((key) => key.startsWith("telemetry") || key.startsWith("share")), []);
  const { gate } = harness(values);
  assert.equal(gate.isSharing(), false);
});

test("with sharing off nothing is captured, counted, written or sent", async () => {
  const { gate, posts, writes, timers, runTimers } = harness();
  writes.length = 0;
  gate.capture("app_launched", { legacy_import: "none", legacy_import_failures: 0, look_mode: "full", interface_style: "match_mac", color_scheme: "match_mac", material_colors: "wallpaper", color_choice: "match_mac", ui_language: "en" });
  gate.count("tabs_opened");
  gate.count("searches");
  gate.rollDaily();
  gate.flushNow();
  await runTimers();
  assert.equal(gate.pending(), 0);
  assert.equal(timers.length, 0);
  assert.deepEqual(posts, []);
  assert.deepEqual(writes, []);
});

test("sharing that was on but lost its install ID reads as off", () => {
  const { gate } = harness({ [SHARING_KEY]: "on", [INSTALL_KEY]: "not-an-id" });
  assert.equal(gate.isSharing(), false);
});

test("turning sharing off drops what is waiting, the day's counts and anything in flight, at once", async () => {
  const { gate, stored, posts, runTimers } = harness();
  gate.setSharing(true, "settings");
  gate.count("tabs_opened");
  gate.capture("app_launched", { legacy_import: "none", legacy_import_failures: 0, look_mode: "full", interface_style: "match_mac", color_scheme: "match_mac", material_colors: "wallpaper", color_choice: "match_mac", ui_language: "en" });
  assert.equal(gate.pending(), 2);
  assert.ok(stored.get(DAILY_KEY));
  gate.setSharing(false, "settings");
  assert.equal(gate.pending(), 0);
  assert.equal(stored.get(DAILY_KEY), undefined);
  assert.equal(stored.get(SHARING_KEY), "off");
  await runTimers();
  assert.deepEqual(posts, []);
});

test("an answer that arrives after sharing was turned off is ignored, and nothing is sent again", async () => {
  const h = harness();
  h.gate.setSharing(true, "onboarding");
  let release: (code: number) => void = () => {};
  const slow = new Promise<number>((done) => (release = done));
  const posts: string[] = [];
  const gate = createGate({
    store: { read: (key) => h.stored.get(key) ?? null, write: (key, value) => (value === null ? h.stored.delete(key) : h.stored.set(key, value)) && undefined },
    post: (body) => (posts.push(body), slow),
    canPost: () => true,
    newId: () => "00000000-0000-4000-8000-000000000099",
    device: () => ({ platform: "ios", appVersion: "1.0.0", osVersion: "18.1", environment: "production" }),
    now: () => START,
    setTimer: () => 1,
    clearTimer: () => {},
  });
  gate.load();
  gate.capture("app_launched", { legacy_import: "imported", legacy_import_failures: 0, look_mode: "full", interface_style: "match_mac", color_scheme: "match_mac", material_colors: "wallpaper", color_choice: "match_mac", ui_language: "en" });
  gate.flushNow();
  gate.setSharing(false, "settings");
  release(500);
  await new Promise((done) => setImmediate(done));
  gate.flushNow();
  assert.equal(posts.length, 1);
  assert.equal(gate.pending(), 0);
});

test("every payload the phone can send validates against the schema, with no free text", async () => {
  const { gate, runTimers, sent } = harness();
  gate.setSharing(true, "settings");
  gate.capture("app_launched", { legacy_import: "started_fresh", legacy_import_failures: 0, look_mode: "full", interface_style: "match_mac", color_scheme: "match_mac", material_colors: "wallpaper", color_choice: "match_mac", ui_language: "en" });
  gate.capture("perf_launch", { launch_ms: 812, js_ms: 240 });
  for (const field of ["tabs_opened", "searches", "pins_to_mac", "tabs_sent", "page_processes_gone", "links_given_up", "pages_reloaded_online", "find_opened_system", "find_opened_bar", "find_closed_bar", "spaces_swiped", "tray_hidden_rows_opened", "deck_pictures_late", "tray_back_swiped", "search_tabs_opened", "spaces_picked", "tabs_moved_to_space", "pages_printed", "pages_translated", "pinned_tabs_refound", "site_permissions_revoked", "card_opens_waited", "native_menus_opened", "drawn_menus_opened", "library_opened", "deck_grid_shown", "landscape_shown", "duo_layout_shown", "list_sheets_late", "list_pages_added", "search_reveals_late", "address_field_scrolled", "deck_bar_swipes", "tabs_swiped_closed", "tabs_swiped_reopened", "page_menu_tapped_away", "new_tab_search_opened", "deck_incognito_switches", "deck_bar_swipes_returned", "tabs_bar_swiped", "tab_swipe_hints_shown", "deck_pulls_hitched", "bottom_bar_collapses", "browse_for_me_opened", "browse_answers_chatgpt", "browse_answers_on_device", "browse_answers_excerpts", "browse_answers_failed", "browse_chatgpt_fallbacks", "page_summaries_pinched", "page_summaries_from_menu", "page_summaries_on_device", "page_summaries_excerpts", "page_summaries_failed", "page_summaries_chatgpt", "page_summaries_chatgpt_fallbacks", "gemini_nano_downloading", "gemini_nano_not_offered", "gemini_nano_needs_update", "gemini_nano_errors", "paste_and_go_links", "paste_and_go_texts", "paste_and_go_unread", "search_tile_taps", "voice_tile_taps", "incognito_tile_taps", "start_logo_taps", "card_close_tapped", "material_back_swiped", "archive_bar_opened", "site_settings_sheet_opened", "search_sheet_expanded", "site_settings_sheet_expanded", "material_you_turned_on", "material_you_turned_off", "talk_to_me_answers_read", "talk_to_me_ear_listens", "talk_to_me_voice_downloads", "talk_to_me_download_failed", "talk_to_me_failed", "start_no_tabs_button_taps", "night_shade_verdicts_reused", "night_shade_verdicts_learned", "night_shade_verdicts_corrected", "page_pictures_blank", "page_pictures_hidden", "page_pictures_webkit", "tray_incognito_switches"] as const) gate.count(field);
  await runTimers();
  const records = sent();
  assert.deepEqual(records.map((record) => record.event).sort(), ["app_launched", "perf_launch", "sharing_turned_on"]);
  for (const record of records) assert.deepEqual(recordProblems(record), [], record.event);
});

test("the schema refuses free text, unknown fields and identifiers it doesn't know", () => {
  const base: PhoneRecord = {
    uuid: "00000000-0000-4000-8000-000000000001",
    event: "app_launched",
    distinct_id: "00000000-0000-4000-8000-000000000002",
    timestamp: "2026-11-14T10:00:00.000Z",
    properties: {
      $lib: "ardia-phone-telemetry",
      $lib_version: "1",
      $app_name: "Ardia",
      app: "phone",
      platform: "android",
      $app_version: "1.0.0",
      $os: "Android",
      $os_version: "15",
      $environment: "production",
      $process_person_profile: false,
      $geoip_disable: true,
      $session_id: "00000000-0000-4000-8000-000000000003",
      legacy_import: "none",
      legacy_import_failures: 0,
      look_mode: "no_motion",
      interface_style: "classic",
      color_scheme: "dark",
      material_colors: "fallback",
      color_choice: "custom",
      ui_language: "en",
    },
  };
  assert.deepEqual(recordProblems(base), []);
  assert.notDeepEqual(recordProblems({ ...base, properties: { ...base.properties, legacy_import: "https://example.com/" } }), []);
  assert.notDeepEqual(recordProblems({ ...base, properties: { ...base.properties, look_mode: "half" } }), []);
  assert.notDeepEqual(recordProblems({ ...base, properties: { ...base.properties, interface_style: "frosted" } }), []);
  assert.notDeepEqual(recordProblems({ ...base, properties: { ...base.properties, color_scheme: "sepia" } }), []);
  assert.notDeepEqual(recordProblems({ ...base, properties: { ...base.properties, material_colors: "#3EB489" } }), []);
  assert.notDeepEqual(recordProblems({ ...base, properties: { ...base.properties, url: "https://example.com/" } }), []);
  assert.notDeepEqual(recordProblems({ ...base, properties: { ...base.properties, $os_version: "Pixel of Ada" } }), []);
  assert.notDeepEqual(recordProblems({ ...base, distinct_id: "ada@example.com" }), []);
  assert.notDeepEqual(recordProblems({ ...base, event: "page_title" as never }), []);
  for (const inherited of ["constructor", "toString", "valueOf", "hasOwnProperty"]) {
    assert.deepEqual(recordProblems({ ...base, properties: { ...base.properties, [inherited]: "the best tapas in Lisbon" } }), [`${inherited}: not in the schema`]);
  }
});

test("a send or pin that began while sharing was off, or before it was turned off and on again, is never counted", () => {
  const { gate, stored } = harness();
  const beganWhileOff = gate.countingWindow();
  gate.setSharing(true, "settings");
  beganWhileOff("tabs_sent");
  assert.equal(stored.get(DAILY_KEY), undefined);
  const beganBeforeOff = gate.countingWindow();
  gate.setSharing(false, "settings");
  gate.setSharing(true, "settings");
  beganBeforeOff("pins_to_mac");
  assert.equal(stored.get(DAILY_KEY), undefined);
  const beganWhileOn = gate.countingWindow();
  beganWhileOn("tabs_sent");
  assert.equal(JSON.parse(stored.get(DAILY_KEY)!).tabs_sent, 1);
});

test("after days away, the last day used goes out once and is not merged with the day Ardia is opened again", async () => {
  const { gate, runTimers, sent, stored, advance } = harness();
  gate.setSharing(true, "settings");
  gate.count("tabs_opened");
  advance(6 * DAY);
  gate.count("tabs_opened");
  gate.count("tabs_opened");
  gate.rollDaily();
  await runTimers();
  const usage = sent().filter((record) => record.event === "usage_counts");
  assert.equal(usage.length, 1);
  assert.equal(usage[0]!.properties.tabs_opened, 1);
  assert.equal(JSON.parse(stored.get(DAILY_KEY)!).tabs_opened, 2);
});

test("the day's counts go out once, the first time the day has changed, and start again from zero", async () => {
  const { gate, runTimers, sent, stored, advance } = harness();
  gate.setSharing(true, "settings");
  gate.count("tabs_opened");
  gate.count("tabs_opened");
  gate.count("searches");
  gate.rollDaily();
  advance(DAY);
  gate.rollDaily();
  gate.rollDaily();
  gate.count("pins_to_mac");
  await runTimers();
  const usage = sent().filter((record) => record.event === "usage_counts");
  assert.equal(usage.length, 1);
  assert.equal(usage[0]!.properties.tabs_opened, 2);
  assert.equal(usage[0]!.properties.searches, 1);
  assert.equal(usage[0]!.properties.pins_to_mac, 0);
  assert.deepEqual(recordProblems(usage[0]!), []);
  assert.equal(JSON.parse(stored.get(DAILY_KEY)!).pins_to_mac, 1);
});

test("a day with nothing counted sends nothing", async () => {
  const { gate, runTimers, sent, advance } = harness();
  gate.setSharing(true, "settings");
  gate.rollDaily();
  advance(DAY);
  gate.rollDaily();
  await runTimers();
  assert.deepEqual(sent().map((record) => record.event), ["sharing_turned_on"]);
});

test("a failed send keeps the events and tries again later", async () => {
  const { gate, runTimers, posts, fail } = harness();
  gate.setSharing(true, "settings");
  fail(503);
  gate.flushNow();
  await new Promise((done) => setImmediate(done));
  assert.equal(gate.pending(), 1);
  fail(200);
  await runTimers();
  assert.equal(gate.pending(), 0);
  assert.ok(posts.length >= 2);
});
