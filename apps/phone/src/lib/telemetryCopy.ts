export const PHONE_SHARING_COPY = {
  toggle: "Share anonymous usage stats",
  summary: "How fast Ardia opens, rough counts of what you use, and how often a page stops. Never the sites you visit, anything you type or search, or what’s in your tabs.",
  whatsSent: "What’s Sent",
  footnote:
    "Off unless you turn it on. Sent to ardia.dev with a random ID made on this phone, and kept on our own servers. No third parties. Turning it off stops it at once and deletes anything waiting to be sent. This setting doesn’t sync.",
  onboardingNote: "Off unless you turn it on. Change it any time in Settings.",
} as const;

export type SentItem = { text: string; fields: readonly string[] };

export const PHONE_WHATS_SENT: { title: string; items: SentItem[] }[] = [
  {
    title: "With everything",
    items: [
      {
        text: "A random install ID, made on this phone the first time you turn sharing on and kept through updates. Nothing is sent with it while sharing is off",
        fields: ["distinct_id"],
      },
      { text: "A random ID for each time Ardia opens, so one session’s events can be read together, and a random ID for each event", fields: ["$session_id", "uuid"] },
      { text: "That it came from Ardia’s phone app, under the name ardia-phone, and which version of its reporting it uses", fields: ["app", "$app_name", "$lib", "$lib_version", "service.name"] },
      { text: "Android or iOS, and its version number", fields: ["platform", "$os", "$os_version", "os.type", "os.version"] },
      { text: "Ardia’s version number, and whether it’s a test build", fields: ["$app_version", "$environment", "service.version", "deployment.environment"] },
      { text: "Two flags asking our servers not to build a profile and not to work out a location from your connection", fields: ["$process_person_profile", "$geoip_disable"] },
      { text: "When it happened", fields: ["timestamp"] },
    ],
  },
  {
    title: "Usage",
    items: [
      { text: "When you turn sharing on: whether you did it in Settings or during setup", fields: ["sharing_turned_on", "source"] },
      {
        text: "Each launch, and whether Ardia has brought over the previous version’s tabs and history, started without them after it couldn’t, or had nothing to bring over, and how many tries failed before it opened. Never what it brought or why",
        fields: ["app_launched", "legacy_import", "legacy_import_failures", "look_mode"],
      },
      {
        text: "With each launch, the Appearance you chose: Glass, Classic or Match My Mac, and Light, Dark, System or Match My Mac",
        fields: ["interface_style", "color_scheme"],
      },
      {
        text: "How long Ardia took to open, from when the system started it to its first screen, and how much of that passed before its code began to run",
        fields: ["perf_launch", "launch_ms", "js_ms"],
      },
      {
        text: "On iPhone, how long Ardia took to show its first backdrop, from when the system started it",
        fields: ["perf_backdrop", "backdrop_ms"],
      },
      {
        text: "With Auto-Open Keyboard on, how long Ardia took to put its search tray up when it opened, from when the system started it",
        fields: ["perf_launch_tray", "tray_ms"],
      },
      {
        text: "At most once a day, for the last day you used Ardia before today: how many tabs you opened, searches you made, pages you pinned to your Mac, tabs you sent to another device, pages that stopped working because their page process ended, links from other apps Ardia gave up on because they took too long, and pages that reloaded by themselves when the phone came back online, how often the tab switcher opened before a page's picture was ready, how often you searched your tabs, how often you picked a space from its menu, how many tabs you moved to another space, how many pages you printed, how many you translated, how often a pinned site took you back to its tab after the page had moved on, how often you showed the tab switcher as a grid, how often Archive or History took more than 0.4 seconds to show its list, how often you scrolled far enough in them to show older days, and how often you swiped a long address in the search field to read the rest of it. Counts only, never which",
        fields: ["usage_counts", "tabs_opened", "searches", "pins_to_mac", "tabs_sent", "page_processes_gone", "links_given_up", "pages_reloaded_online", "find_opened_system", "find_opened_bar", "spaces_swiped", "tray_hidden_rows_opened", "deck_pictures_late", "tray_back_swiped", "search_tabs_opened", "spaces_picked", "tabs_moved_to_space", "pages_printed", "pages_translated", "pinned_tabs_refound", "site_permissions_revoked", "card_opens_waited", "native_menus_opened", "library_opened", "deck_grid_shown", "landscape_shown", "duo_layout_shown", "list_sheets_late", "list_pages_added", "search_reveals_late", "address_field_scrolled"],
      },
    ],
  },
];
