export const PHONE_LIB = "ardia-phone-telemetry";
export const PHONE_SERVICE = "ardia-phone";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[47][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const VERSION = /^\d{1,4}(\.\d{1,4}){0,3}(-[a-z]+\.\d{1,4})?$/;
const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const MAX_COUNT = 1_000_000;
const MAX_MS = 600_000;

export const CRASH_KINDS = ["js", "crash", "hang", "memory", "resource", "killed", "watchdog"] as const;

export const CRASH_REASONS = [
  "type_error",
  "reference_error",
  "range_error",
  "syntax_error",
  "error",
  "other",
  "sigsegv",
  "sigbus",
  "sigabrt",
  "sigtrap",
  "sigill",
  "sigkill",
  "sigfpe",
  "signal_other",
  "hang",
  "memory_limit",
  "watchdog",
  "java_crash",
  "native_crash",
  "anr",
  "low_memory",
  "excessive_resource",
  "init_failure",
  "signaled",
] as const;

export const CRASH_AGES = ["<1h", "<1d", "<7d", "7d+"] as const;

export const PREVIOUS_SESSIONS = ["clean", "unclean", "none", "unknown"] as const;

export const COUNTED = ["tabs_opened", "searches", "pins_to_mac", "tabs_sent", "page_processes_gone", "links_given_up", "pages_reloaded_online", "find_opened_system", "find_opened_bar", "find_closed_bar", "spaces_swiped", "tray_hidden_rows_opened", "deck_pictures_late", "tray_back_swiped", "search_tabs_opened", "spaces_picked", "tabs_moved_to_space", "pages_printed", "pages_translated", "pinned_tabs_refound", "site_permissions_revoked", "card_opens_waited", "native_menus_opened", "drawn_menus_opened", "library_opened", "deck_grid_shown", "landscape_shown", "duo_layout_shown", "list_sheets_late", "list_pages_added", "search_reveals_late", "address_field_scrolled", "deck_bar_swipes", "tabs_swiped_closed", "tabs_swiped_reopened", "page_menu_tapped_away", "new_tab_search_opened", "new_tab_pins_opened", "deck_incognito_switches", "deck_bar_swipes_returned", "tabs_bar_swiped", "tab_swipe_hints_shown", "deck_pulls_hitched", "bottom_bar_collapses", "browse_for_me_opened", "browse_answers_chatgpt", "browse_answers_on_device", "browse_answers_excerpts", "browse_answers_failed", "browse_chatgpt_fallbacks", "page_summaries_pinched", "page_summaries_from_menu", "page_summaries_on_device", "page_summaries_excerpts", "page_summaries_failed", "page_summaries_chatgpt", "page_summaries_chatgpt_fallbacks", "gemini_nano_downloading", "gemini_nano_not_offered", "gemini_nano_needs_update", "gemini_nano_errors", "gemini_nano_download_failed", "gemini_nano_write_failed", "gemini_nano_download_rewrites", "paste_and_go_links", "paste_and_go_texts", "paste_and_go_unread", "search_tile_taps", "voice_tile_taps", "incognito_tile_taps", "start_logo_taps", "card_close_tapped", "material_back_swiped", "archive_bar_opened", "site_settings_sheet_opened", "search_sheet_expanded", "site_settings_sheet_expanded", "material_you_turned_on", "material_you_turned_off", "talk_to_me_answers_read", "talk_to_me_ear_listens", "talk_to_me_voice_downloads", "talk_to_me_download_failed", "talk_to_me_failed", "start_no_tabs_button_taps", "night_shade_verdicts_reused", "night_shade_verdicts_learned", "night_shade_verdicts_corrected", "page_pictures_blank", "page_pictures_hidden", "page_pictures_webkit", "page_pictures_scrolled", "custom_theme_chosen", "theme_edits", "settings_panes_opened", "tray_incognito_switches", "incognito_unavailable", "deck_pictures_at_press", "deck_opens_while_landing", "tab_writes_stalled", "page_covers_capped", "search_opens_cold", "searches_forgotten", "glass_shaders_failed", "archive_card_reoffers", "drawn_menu_actions_chosen", "glass_unsourced", "web_videos_floated", "web_videos_kept_playing", "glass_captures_over_budget", "glass_lens_bridged", "app_update_checks", "app_update_offers_shown", "app_update_offers_opened", "app_update_handoffs_failed", "app_update_installs_started", "app_update_checksums_refused", "app_update_installs_failed", "app_update_installs_cancelled", "app_update_installs_completed", "glass_lens_withheld", "js_errors"] as const;

export type Counted = (typeof COUNTED)[number];

const COUNT_RULE = { kind: "count" } as const;
const USAGE_FIELDS = Object.fromEntries(COUNTED.map((field) => [field, COUNT_RULE])) as Record<Counted, typeof COUNT_RULE>;

export type FieldRule =
  | { kind: "const"; value: string | boolean }
  | { kind: "enum"; values: readonly string[] }
  | { kind: "pattern"; pattern: RegExp }
  | { kind: "count" }
  | { kind: "ms" }
  | { kind: "flag" };

export const CONTEXT_FIELDS = {
  $lib: { kind: "const", value: PHONE_LIB },
  $lib_version: { kind: "const", value: "1" },
  $app_name: { kind: "const", value: "Ardia" },
  app: { kind: "const", value: "phone" },
  platform: { kind: "enum", values: ["android", "ios"] },
  $app_version: { kind: "pattern", pattern: VERSION },
  $os: { kind: "enum", values: ["Android", "iOS"] },
  $os_version: { kind: "pattern", pattern: VERSION },
  $environment: { kind: "enum", values: ["dev", "test", "production"] },
  $process_person_profile: { kind: "const", value: false },
  $geoip_disable: { kind: "const", value: true },
  $session_id: { kind: "pattern", pattern: UUID },
} as const satisfies Record<string, FieldRule>;

export const EVENT_FIELDS = {
  sharing_turned_on: { source: { kind: "enum", values: ["settings", "onboarding"] } },
  app_launched: {
    legacy_import: { kind: "enum", values: ["imported", "started_fresh", "none"] },
    legacy_import_failures: { kind: "count" },
    look_mode: { kind: "enum", values: ["full", "no_blur", "no_motion", "neither"] },
    interface_style: { kind: "enum", values: ["match_mac", "glass", "classic"] },
    color_scheme: { kind: "enum", values: ["match_mac", "system", "light", "dark"] },
    material_colors: { kind: "enum", values: ["wallpaper", "profile", "fallback", "not_material"] },
    color_choice: { kind: "enum", values: ["match_mac", "preset", "custom"] },
    glass_render: { kind: "enum", values: ["lens", "frost", "clear", "solid", "classic", "native", "none"] },
    previous_session: { kind: "enum", values: PREVIOUS_SESSIONS },
  },
  perf_launch: { launch_ms: { kind: "ms" }, js_ms: { kind: "ms" } },
  perf_backdrop: { backdrop_ms: { kind: "ms" } },
  perf_launch_tray: { tray_ms: { kind: "ms" } },
  usage_counts: USAGE_FIELDS,
  app_crashed: {
    kind: { kind: "enum", values: CRASH_KINDS },
    reason: { kind: "enum", values: CRASH_REASONS },
    foreground: { kind: "enum", values: ["yes", "no", "unknown"] },
    ago: { kind: "enum", values: CRASH_AGES },
  },
} as const satisfies Record<string, Record<string, FieldRule>>;

export type PhoneEvent = keyof typeof EVENT_FIELDS;

export type EventProps<E extends PhoneEvent> = { [K in keyof (typeof EVENT_FIELDS)[E]]: (typeof EVENT_FIELDS)[E][K] extends { kind: "enum"; values: readonly (infer V)[] } ? V : (typeof EVENT_FIELDS)[E][K] extends { kind: "flag" } ? boolean : number };

export type PhoneRecord = { uuid: string; event: PhoneEvent; distinct_id: string; timestamp: string; properties: Record<string, string | number | boolean> };

function fieldProblem(rule: FieldRule, value: unknown): string | null {
  switch (rule.kind) {
    case "const":
      return value === rule.value ? null : "not the fixed value";
    case "enum":
      return typeof value === "string" && rule.values.includes(value) ? null : "not one of its values";
    case "pattern":
      return typeof value === "string" && rule.pattern.test(value) ? null : "not in its format";
    case "count":
      return Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= MAX_COUNT ? null : "not a count";
    case "ms":
      return Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= MAX_MS ? null : "not a duration";
    case "flag":
      return typeof value === "boolean" ? null : "not a flag";
  }
}

export function recordProblems(record: PhoneRecord): string[] {
  const problems: string[] = [];
  const fields: Record<string, FieldRule> = EVENT_FIELDS[record.event];
  if (!fields) return [`unknown event ${record.event}`];
  if (!UUID.test(record.uuid)) problems.push("uuid");
  if (!UUID.test(record.distinct_id)) problems.push("distinct_id");
  if (!ISO_TIME.test(record.timestamp)) problems.push("timestamp");
  const rules: Record<string, FieldRule> = { ...CONTEXT_FIELDS, ...fields };
  for (const [key, value] of Object.entries(record.properties)) {
    const rule = Object.hasOwn(rules, key) ? rules[key] : undefined;
    if (!rule) problems.push(`${key}: not in the schema`);
    else {
      const problem = fieldProblem(rule, value);
      if (problem) problems.push(`${key}: ${problem}`);
    }
  }
  for (const key of Object.keys(rules)) if (!(key in record.properties)) problems.push(`${key}: missing`);
  return problems;
}

export type DeviceFacts = { platform: "android" | "ios"; appVersion: string; osVersion: string; environment: "dev" | "test" | "production" };

export function eventContext(device: DeviceFacts, sessionId: string): Record<string, string | boolean> {
  return {
    $lib: PHONE_LIB,
    $lib_version: "1",
    $app_name: "Ardia",
    app: "phone",
    platform: device.platform,
    $app_version: device.appVersion,
    $os: device.platform === "ios" ? "iOS" : "Android",
    $os_version: device.osVersion,
    $environment: device.environment,
    $process_person_profile: false,
    $geoip_disable: true,
    $session_id: sessionId,
  };
}

export function buildRecord<E extends PhoneEvent>(
  event: E,
  props: EventProps<E>,
  ids: { uuid: string; installId: string; sessionId: string },
  device: DeviceFacts,
  at: number,
): PhoneRecord {
  return {
    uuid: ids.uuid,
    event,
    distinct_id: ids.installId,
    timestamp: new Date(at).toISOString(),
    properties: { ...eventContext(device, ids.sessionId), ...(props as Record<string, string | number | boolean>) },
  };
}

export const RESOURCE_FIELDS = ["service.name", "service.version", "deployment.environment", "os.type", "os.version"] as const;

export function resourceFor(device: DeviceFacts): Record<(typeof RESOURCE_FIELDS)[number], string> {
  return {
    "service.name": PHONE_SERVICE,
    "service.version": device.appVersion,
    "deployment.environment": device.environment === "production" ? "production" : "development",
    "os.type": device.platform,
    "os.version": device.osVersion,
  };
}

const MOST_PENDING_PER_FIELD = 1000;

export function pendingUsage(pending: Record<string, unknown>): Counted[] {
  const counted: Counted[] = [];
  for (const field of COUNTED) {
    const times = pending[field];
    if (typeof times !== "number" || !Number.isInteger(times) || times <= 0) continue;
    for (let i = 0; i < Math.min(times, MOST_PENDING_PER_FIELD); i++) counted.push(field);
  }
  return counted;
}

export type DailyCounts = { day: string } & Record<Counted, number>;

export type BrowseForMeOutcome = "chatgpt" | "on_device" | "excerpts" | "failed";

const BROWSE_ANSWERS: Record<BrowseForMeOutcome, Counted> = {
  chatgpt: "browse_answers_chatgpt",
  on_device: "browse_answers_on_device",
  excerpts: "browse_answers_excerpts",
  failed: "browse_answers_failed",
};

export const browseForMeCounts = (outcome: BrowseForMeOutcome, chatGPTFellBack: boolean): Counted[] =>
  chatGPTFellBack ? [BROWSE_ANSWERS[outcome], "browse_chatgpt_fallbacks"] : [BROWSE_ANSWERS[outcome]];

export type TalkToMeCount = "answers_read" | "ear_listens" | "voice_downloads" | "download_failed" | "failed";

const TALK_TO_ME: Record<TalkToMeCount, Counted> = {
  answers_read: "talk_to_me_answers_read",
  ear_listens: "talk_to_me_ear_listens",
  voice_downloads: "talk_to_me_voice_downloads",
  download_failed: "talk_to_me_download_failed",
  failed: "talk_to_me_failed",
};

export const talkToMeCount = (count: string): Counted | null => (Object.hasOwn(TALK_TO_ME, count) ? TALK_TO_ME[count as TalkToMeCount] : null);

export type PageSummaryTrigger = "pinch" | "menu";

export type PageSummaryOutcome = "chatgpt" | "on_device" | "excerpts" | "failed";

const SUMMARY_OPENED: Record<PageSummaryTrigger, Counted> = { pinch: "page_summaries_pinched", menu: "page_summaries_from_menu" };

const SUMMARY_WRITTEN: Record<PageSummaryOutcome, Counted> = { chatgpt: "page_summaries_chatgpt", on_device: "page_summaries_on_device", excerpts: "page_summaries_excerpts", failed: "page_summaries_failed" };

export const pageSummaryOpenedCount = (trigger: string): Counted | null => SUMMARY_OPENED[trigger as PageSummaryTrigger] ?? null;

export const pageSummarySettledCount = (outcome: string): Counted | null => SUMMARY_WRITTEN[outcome as PageSummaryOutcome] ?? null;

export function pageSummarySettledCounts(outcome: string, chatGPTFellBack: boolean | undefined): Counted[] {
  const written = pageSummarySettledCount(outcome);
  if (!written) return [];
  return chatGPTFellBack === true && outcome !== "chatgpt" && outcome !== "failed" ? [written, "page_summaries_chatgpt_fallbacks"] : [written];
}

export type GeminiNanoMissing = "downloading" | "download_failed" | "not_offered" | "needs_update" | "errors" | "write_failed";

const GEMINI_NANO_MISSING: Record<GeminiNanoMissing, Counted> = { downloading: "gemini_nano_downloading", not_offered: "gemini_nano_not_offered", needs_update: "gemini_nano_needs_update", errors: "gemini_nano_errors", download_failed: "gemini_nano_download_failed", write_failed: "gemini_nano_write_failed" };

export const geminiNanoMissingCount = (missing: string | null | undefined): Counted[] => (missing && Object.hasOwn(GEMINI_NANO_MISSING, missing) ? [GEMINI_NANO_MISSING[missing as GeminiNanoMissing]] : []);

export const utcDay = (at: number) => new Date(at).toISOString().slice(0, 10);

export const emptyDay = (day: string): DailyCounts => ({ day, tabs_opened: 0, searches: 0, pins_to_mac: 0, tabs_sent: 0, page_processes_gone: 0, links_given_up: 0, pages_reloaded_online: 0, find_opened_system: 0, find_opened_bar: 0, find_closed_bar: 0, spaces_swiped: 0, tray_hidden_rows_opened: 0, deck_pictures_late: 0, tray_back_swiped: 0, search_tabs_opened: 0, spaces_picked: 0, tabs_moved_to_space: 0, pages_printed: 0, pages_translated: 0, pinned_tabs_refound: 0, site_permissions_revoked: 0, card_opens_waited: 0, native_menus_opened: 0, drawn_menus_opened: 0, library_opened: 0, deck_grid_shown: 0, landscape_shown: 0, duo_layout_shown: 0, list_sheets_late: 0, list_pages_added: 0, search_reveals_late: 0, address_field_scrolled: 0, deck_bar_swipes: 0, tabs_swiped_closed: 0, tabs_swiped_reopened: 0, page_menu_tapped_away: 0, new_tab_search_opened: 0, new_tab_pins_opened: 0, deck_incognito_switches: 0, deck_bar_swipes_returned: 0, tabs_bar_swiped: 0, tab_swipe_hints_shown: 0, deck_pulls_hitched: 0, bottom_bar_collapses: 0, browse_for_me_opened: 0, browse_answers_chatgpt: 0, browse_answers_on_device: 0, browse_answers_excerpts: 0, browse_answers_failed: 0, browse_chatgpt_fallbacks: 0, page_summaries_pinched: 0, page_summaries_from_menu: 0, page_summaries_on_device: 0, page_summaries_excerpts: 0, page_summaries_failed: 0, page_summaries_chatgpt: 0, page_summaries_chatgpt_fallbacks: 0, gemini_nano_downloading: 0, gemini_nano_not_offered: 0, gemini_nano_needs_update: 0, gemini_nano_errors: 0, gemini_nano_download_failed: 0, gemini_nano_write_failed: 0, gemini_nano_download_rewrites: 0, paste_and_go_links: 0, paste_and_go_texts: 0, paste_and_go_unread: 0, search_tile_taps: 0, voice_tile_taps: 0, incognito_tile_taps: 0, start_logo_taps: 0 , card_close_tapped: 0, material_back_swiped: 0, archive_bar_opened: 0, site_settings_sheet_opened: 0, search_sheet_expanded: 0, site_settings_sheet_expanded: 0, material_you_turned_on: 0, material_you_turned_off: 0, talk_to_me_answers_read: 0, talk_to_me_ear_listens: 0, talk_to_me_voice_downloads: 0, talk_to_me_download_failed: 0, talk_to_me_failed: 0, start_no_tabs_button_taps: 0, night_shade_verdicts_reused: 0, night_shade_verdicts_learned: 0, night_shade_verdicts_corrected: 0, page_pictures_blank: 0, page_pictures_hidden: 0, page_pictures_webkit: 0, page_pictures_scrolled: 0, custom_theme_chosen: 0, theme_edits: 0, settings_panes_opened: 0, tray_incognito_switches: 0, incognito_unavailable: 0, deck_pictures_at_press: 0, deck_opens_while_landing: 0, tab_writes_stalled: 0, page_covers_capped: 0, search_opens_cold: 0, searches_forgotten: 0, glass_shaders_failed: 0, archive_card_reoffers: 0, drawn_menu_actions_chosen: 0, glass_unsourced: 0, web_videos_floated: 0, web_videos_kept_playing: 0, glass_captures_over_budget: 0, glass_lens_bridged: 0, app_update_checks: 0, app_update_offers_shown: 0, app_update_offers_opened: 0, app_update_handoffs_failed: 0, app_update_installs_started: 0, app_update_checksums_refused: 0, app_update_installs_failed: 0, app_update_installs_cancelled: 0, app_update_installs_completed: 0, glass_lens_withheld: 0, js_errors: 0 });

const anyCounted = (counts: DailyCounts) => COUNTED.some((field) => counts[field] > 0);

export function rollOver(state: DailyCounts | null, today: string): { state: DailyCounts; due: DailyCounts | null } {
  if (!state) return { state: emptyDay(today), due: null };
  if (state.day >= today) return { state, due: null };
  return { state: emptyDay(today), due: anyCounted(state) ? state : null };
}

export function counted(state: DailyCounts | null, field: Counted, today: string): { state: DailyCounts; due: DailyCounts | null } {
  const rolled = rollOver(state, today);
  return { state: { ...rolled.state, [field]: Math.min(MAX_COUNT, rolled.state[field] + 1) }, due: rolled.due };
}

export function usageProps(counts: DailyCounts): EventProps<"usage_counts"> {
  return { tabs_opened: counts.tabs_opened, searches: counts.searches, pins_to_mac: counts.pins_to_mac, tabs_sent: counts.tabs_sent, page_processes_gone: counts.page_processes_gone, links_given_up: counts.links_given_up, pages_reloaded_online: counts.pages_reloaded_online, find_opened_system: counts.find_opened_system, find_opened_bar: counts.find_opened_bar, find_closed_bar: counts.find_closed_bar, spaces_swiped: counts.spaces_swiped, tray_hidden_rows_opened: counts.tray_hidden_rows_opened, deck_pictures_late: counts.deck_pictures_late, tray_back_swiped: counts.tray_back_swiped, search_tabs_opened: counts.search_tabs_opened, spaces_picked: counts.spaces_picked, tabs_moved_to_space: counts.tabs_moved_to_space, pages_printed: counts.pages_printed, pages_translated: counts.pages_translated, pinned_tabs_refound: counts.pinned_tabs_refound, site_permissions_revoked: counts.site_permissions_revoked, card_opens_waited: counts.card_opens_waited, native_menus_opened: counts.native_menus_opened, drawn_menus_opened: counts.drawn_menus_opened, library_opened: counts.library_opened, deck_grid_shown: counts.deck_grid_shown, landscape_shown: counts.landscape_shown, duo_layout_shown: counts.duo_layout_shown, list_sheets_late: counts.list_sheets_late, list_pages_added: counts.list_pages_added, search_reveals_late: counts.search_reveals_late, address_field_scrolled: counts.address_field_scrolled, deck_bar_swipes: counts.deck_bar_swipes, tabs_swiped_closed: counts.tabs_swiped_closed, tabs_swiped_reopened: counts.tabs_swiped_reopened, page_menu_tapped_away: counts.page_menu_tapped_away, new_tab_search_opened: counts.new_tab_search_opened, new_tab_pins_opened: counts.new_tab_pins_opened, deck_incognito_switches: counts.deck_incognito_switches, deck_bar_swipes_returned: counts.deck_bar_swipes_returned, tabs_bar_swiped: counts.tabs_bar_swiped, tab_swipe_hints_shown: counts.tab_swipe_hints_shown, deck_pulls_hitched: counts.deck_pulls_hitched, bottom_bar_collapses: counts.bottom_bar_collapses, browse_for_me_opened: counts.browse_for_me_opened, browse_answers_chatgpt: counts.browse_answers_chatgpt, browse_answers_on_device: counts.browse_answers_on_device, browse_answers_excerpts: counts.browse_answers_excerpts, browse_answers_failed: counts.browse_answers_failed, browse_chatgpt_fallbacks: counts.browse_chatgpt_fallbacks, page_summaries_pinched: counts.page_summaries_pinched, page_summaries_from_menu: counts.page_summaries_from_menu, page_summaries_on_device: counts.page_summaries_on_device, page_summaries_excerpts: counts.page_summaries_excerpts, page_summaries_failed: counts.page_summaries_failed, page_summaries_chatgpt: counts.page_summaries_chatgpt, page_summaries_chatgpt_fallbacks: counts.page_summaries_chatgpt_fallbacks, gemini_nano_downloading: counts.gemini_nano_downloading, gemini_nano_not_offered: counts.gemini_nano_not_offered, gemini_nano_needs_update: counts.gemini_nano_needs_update, gemini_nano_errors: counts.gemini_nano_errors, gemini_nano_download_failed: counts.gemini_nano_download_failed, gemini_nano_write_failed: counts.gemini_nano_write_failed, gemini_nano_download_rewrites: counts.gemini_nano_download_rewrites, paste_and_go_links: counts.paste_and_go_links, paste_and_go_texts: counts.paste_and_go_texts, paste_and_go_unread: counts.paste_and_go_unread, search_tile_taps: counts.search_tile_taps, voice_tile_taps: counts.voice_tile_taps, incognito_tile_taps: counts.incognito_tile_taps, start_logo_taps: counts.start_logo_taps , card_close_tapped: counts.card_close_tapped, material_back_swiped: counts.material_back_swiped, archive_bar_opened: counts.archive_bar_opened, site_settings_sheet_opened: counts.site_settings_sheet_opened, search_sheet_expanded: counts.search_sheet_expanded, site_settings_sheet_expanded: counts.site_settings_sheet_expanded, material_you_turned_on: counts.material_you_turned_on, material_you_turned_off: counts.material_you_turned_off, talk_to_me_answers_read: counts.talk_to_me_answers_read, talk_to_me_ear_listens: counts.talk_to_me_ear_listens, talk_to_me_voice_downloads: counts.talk_to_me_voice_downloads, talk_to_me_download_failed: counts.talk_to_me_download_failed, talk_to_me_failed: counts.talk_to_me_failed, start_no_tabs_button_taps: counts.start_no_tabs_button_taps, night_shade_verdicts_reused: counts.night_shade_verdicts_reused, night_shade_verdicts_learned: counts.night_shade_verdicts_learned, night_shade_verdicts_corrected: counts.night_shade_verdicts_corrected, page_pictures_blank: counts.page_pictures_blank, page_pictures_hidden: counts.page_pictures_hidden, page_pictures_webkit: counts.page_pictures_webkit, page_pictures_scrolled: counts.page_pictures_scrolled, custom_theme_chosen: counts.custom_theme_chosen, theme_edits: counts.theme_edits, settings_panes_opened: counts.settings_panes_opened, tray_incognito_switches: counts.tray_incognito_switches, incognito_unavailable: counts.incognito_unavailable, deck_pictures_at_press: counts.deck_pictures_at_press, deck_opens_while_landing: counts.deck_opens_while_landing, tab_writes_stalled: counts.tab_writes_stalled, page_covers_capped: counts.page_covers_capped, search_opens_cold: counts.search_opens_cold, searches_forgotten: counts.searches_forgotten, glass_shaders_failed: counts.glass_shaders_failed, archive_card_reoffers: counts.archive_card_reoffers, drawn_menu_actions_chosen: counts.drawn_menu_actions_chosen, glass_unsourced: counts.glass_unsourced, web_videos_floated: counts.web_videos_floated, web_videos_kept_playing: counts.web_videos_kept_playing, glass_captures_over_budget: counts.glass_captures_over_budget, glass_lens_bridged: counts.glass_lens_bridged, app_update_checks: counts.app_update_checks, app_update_offers_shown: counts.app_update_offers_shown, app_update_offers_opened: counts.app_update_offers_opened, app_update_handoffs_failed: counts.app_update_handoffs_failed, app_update_installs_started: counts.app_update_installs_started, app_update_checksums_refused: counts.app_update_checksums_refused, app_update_installs_failed: counts.app_update_installs_failed, app_update_installs_cancelled: counts.app_update_installs_cancelled, app_update_installs_completed: counts.app_update_installs_completed, glass_lens_withheld: counts.glass_lens_withheld, js_errors: counts.js_errors };
}

export function parseDaily(raw: string | null | undefined): DailyCounts | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Partial<DailyCounts>;
    if (typeof value.day !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value.day)) return null;
    const out = emptyDay(value.day);
    for (const field of COUNTED) {
      const n = value[field];
      out[field] = Number.isSafeInteger(n) && (n as number) >= 0 ? Math.min(MAX_COUNT, n as number) : 0;
    }
    return out;
  } catch {
    return null;
  }
}

export function launchProps(processStart: number | null, jsStart: number, firstFrame: number): EventProps<"perf_launch"> | null {
  if (processStart === null) return null;
  const launch = Math.round(firstFrame - processStart);
  const js = Math.round(jsStart - processStart);
  if (!(launch >= 0 && launch <= MAX_MS) || !(js >= 0 && js <= launch)) return null;
  return { launch_ms: launch, js_ms: js };
}

export function backdropProps(processStart: number | null, backdropShownAt: number | null): EventProps<"perf_backdrop"> | null {
  if (processStart === null || backdropShownAt === null) return null;
  const backdrop = Math.round(backdropShownAt - processStart);
  return backdrop >= 0 && backdrop <= MAX_MS ? { backdrop_ms: backdrop } : null;
}

export function launchTrayProps(processStart: number | null, trayUpAt: number): EventProps<"perf_launch_tray"> | null {
  if (processStart === null) return null;
  const tray = Math.round(trayUpAt - processStart);
  return tray >= 0 && tray <= MAX_MS ? { tray_ms: tray } : null;
}

export const legacyImportOutcome = (outcome: "imported" | "startedFresh" | "none" | null): EventProps<"app_launched">["legacy_import"] =>
  outcome === "imported" ? "imported" : outcome === "startedFresh" ? "started_fresh" : "none";

export function osVersionOf(raw: string | number): string {
  const text = String(raw).trim();
  return VERSION.test(text) ? text : (text.match(/^\d{1,4}(\.\d{1,4}){0,2}/)?.[0] ?? "0");
}

export function appVersionOf(raw: string | null | undefined): string {
  const text = (raw ?? "").trim();
  return VERSION.test(text) ? text : "0";
}
