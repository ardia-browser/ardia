export const PHONE_SHARING_COPY = {
  toggle: "Share anonymous usage stats",
  summary: "How fast Ardia opens, rough counts of what you use, how often a page stops, and when Ardia itself stops unexpectedly. Never the sites you visit, anything you type or search, or what’s in your tabs.",
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
        text: "With each launch, whether your color matches your Mac, is one of Ardia’s colors, or is a custom theme. Never which colors",
        fields: ["color_choice"],
      },
      {
        text: "With each launch, the best glass this phone can draw, not what each surface drew: the Liquid Glass lens, frosted glass, clear glass when the lens can’t be drawn, or no blur on Android, the system’s own glass, Classic, or none in Material You",
        fields: ["glass_render"],
      },
      {
        text: "On Android, with each launch, whether the Material You design was off, and with it on, whether Dynamic Colors used your wallpaper, Ardia used your custom color, or the phone gave no wallpaper palette and Ardia used its own",
        fields: ["material_colors"],
      },
      {
        text: "With each launch, whether Ardia last left the screen normally, was still in front when it stopped (a crash, a forced quit or the system ending it), or there was nothing to compare, because this is the first launch or sharing was off then",
        fields: ["previous_session"],
      },
      {
        text: "When Ardia stopped unexpectedly while sharing was on: what kind of stop it was (an error in Ardia’s own code, a crash, a hang, running out of memory, using too much of the phone, the system ending it, or a watchdog timeout), its cause from a fixed list (the error type, like TypeError, never its message; the signal, like SIGSEGV; or the reason Android or iOS gave), whether Ardia was on screen, and roughly how long ago it was. Sent when Ardia next opens or comes back to the front once the phone has reported it, which can take up to a day, at most 10 per launch. Never what you were doing, which page was open, or any part of a crash log",
        fields: ["app_crashed", "kind", "reason", "foreground", "ago"],
      },
      {
        text: "In the same daily counts: how many errors in Ardia’s own code it recovered from without stopping. A count only, never the error",
        fields: ["js_errors"],
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
        text: "At most once a day, for the last day you used Ardia before today: how many tabs you opened, searches you made, pages you pinned to your Mac, tabs you sent to another device, pages that stopped working because their page process ended, links from other apps Ardia gave up on because they took too long, and pages that reloaded by themselves when the phone came back online, how often the tab switcher opened before a page’s picture was ready, how often a tap on the tabs button had to copy the page right then because its picture wasn’t up to date, how often you opened a card while the tab switcher was still settling, how often you searched your tabs, how often you picked a space from its menu, how many tabs you moved to another space, how many pages you printed, how many you translated, how often a pinned site took you back to its tab after the page had moved on, how often + opened search on a new tab and how often you opened one of your space’s pinned sites from the tiles above it, how often you showed the tab switcher as a grid, how often you opened the tab switcher by swiping up on the bottom bar instead of tapping its tabs button, how often a back swipe closed a tab or a forward swipe reopened one, how often Archive or History took more than 0.4 seconds to show its list, how often you scrolled far enough in them to show older days, how often you swiped a long address in the search field to read the rest of it, how often you swiped up on the bottom bar and let go early so the page came back, how often you switched tabs by swiping the bottom bar sideways, whether the one-time hint about that swipe was shown on Android, how often the page stalled for more than a twentieth of a second while it shrank into the tab switcher, how often the bottom bar folded away as a page scrolled, and how often you opened a menu or a confirmation, counted apart for the phone’s own menus and the ones Ardia draws, never while browsing privately. Counts only, never which",
        fields: ["usage_counts", "tabs_opened", "searches", "pins_to_mac", "tabs_sent", "page_processes_gone", "links_given_up", "pages_reloaded_online", "find_opened_system", "find_opened_bar", "find_closed_bar", "spaces_swiped", "tray_hidden_rows_opened", "deck_pictures_late", "deck_pictures_at_press", "deck_opens_while_landing", "tray_back_swiped", "search_tabs_opened", "spaces_picked", "tabs_moved_to_space", "pages_printed", "pages_translated", "pinned_tabs_refound", "site_permissions_revoked", "card_opens_waited", "native_menus_opened", "drawn_menus_opened", "library_opened", "deck_grid_shown", "landscape_shown", "duo_layout_shown", "list_sheets_late", "list_pages_added", "search_reveals_late", "address_field_scrolled", "deck_bar_swipes", "tabs_swiped_closed", "tabs_swiped_reopened", "page_menu_tapped_away", "new_tab_search_opened", "new_tab_pins_opened", "deck_incognito_switches", "deck_bar_swipes_returned", "tabs_bar_swiped", "tab_swipe_hints_shown", "deck_pulls_hitched", "bottom_bar_collapses"],
      },
      {
        text: "In the same daily counts: how often you opened Browse for Me, how many of its answers ChatGPT wrote, the phone’s own model wrote (Apple Intelligence on iPhone, Gemini Nano on Android) or were the pages’ own lines, how many it couldn’t write, and how often ChatGPT couldn’t answer so the phone did. Counts only, never what you searched for or what the answer said",
        fields: ["browse_for_me_opened", "browse_answers_chatgpt", "browse_answers_on_device", "browse_answers_excerpts", "browse_answers_failed", "browse_chatgpt_fallbacks"],
      },
      {
        text: "In the same daily counts, on iPhone: how many Browse for Me answers Talk to Me read aloud and how many of those you started by holding the phone to your ear, how often its voice finished downloading or failed to, and how often it couldn’t speak. Counts only, never what it read",
        fields: ["talk_to_me_answers_read", "talk_to_me_ear_listens", "talk_to_me_voice_downloads", "talk_to_me_download_failed", "talk_to_me_failed"],
      },
      {
        text: "In the same daily counts: how often you turned Incognito on with the eyes in the search panel, and on Android how often Ardia couldn’t turn Incognito on because the phone’s Android System WebView is too old to keep Incognito pages separate. Counts only, never what you browsed",
        fields: ["tray_incognito_switches", "incognito_unavailable"],
      },
      {
        text: "In the same daily counts, on iPhone: how often you summarized a page by pinching in or from the page menu, how many summaries Apple Intelligence wrote on the phone or were the page’s own lines, and how many it couldn’t write. Counts only, never which page or what the summary said",
        fields: ["page_summaries_pinched", "page_summaries_from_menu", "page_summaries_on_device", "page_summaries_excerpts", "page_summaries_failed"],
      },
      {
        text: "In the same daily counts, on Android: when a search answer or a page summary couldn’t use Gemini Nano, why: it was still downloading, its download stopped, Google doesn’t offer it to apps on this phone, it needed a Google AICore or system update, it didn’t start, or it started but couldn’t write; and how often you rewrote a search answer with Gemini Nano once its download finished. Counts only, never what you searched for or which page",
        fields: ["gemini_nano_downloading", "gemini_nano_not_offered", "gemini_nano_needs_update", "gemini_nano_errors", "gemini_nano_download_failed", "gemini_nano_write_failed", "gemini_nano_download_rewrites"],
      },
      {
        text: "In the same daily counts: how often you tapped Paste and Go with a link or with text, and how often it found nothing to paste because you didn’t allow the paste or the clipboard had emptied. Never what you copied, and never while browsing privately",
        fields: ["paste_and_go_links", "paste_and_go_texts", "paste_and_go_unread"],
      },
      {
        text: "In the same daily counts, on Android: how often you opened Ardia from its Search, Voice Search and New Incognito Tab tiles in Quick Settings. Counts only",
        fields: ["search_tile_taps", "voice_tile_taps", "incognito_tile_taps"],
      },
      {
        text: "In the same daily counts: how often you tapped Archive or Spaces on the start page, the button that takes the place of Tabs when no tabs are open. Counts only, and never while browsing privately",
        fields: ["start_no_tabs_button_taps"],
      },
      {
        text: "In the same daily counts, on Android: how often a page opened with Night Shade already knowing from an earlier visit whether that site is light or dark, how often it had to learn that on this visit, and how often a site had changed so what it knew was wrong. Counts only, never which site, and never while browsing privately",
        fields: ["night_shade_verdicts_reused", "night_shade_verdicts_learned", "night_shade_verdicts_corrected"],
      },
      {
        text: "In the same daily counts: how often a picture of a page for the tab switcher was thrown away because it came out as one flat color or the page was not on screen, and how often it had to come from the page engine instead of a copy of the screen; on Android, how often a page’s picture was taken again because you had scrolled the page while it was still loading, so switching back to the tab shows where you left it. Counts only, and never while browsing privately",
        fields: ["page_pictures_blank", "page_pictures_hidden", "page_pictures_webkit", "page_pictures_scrolled"],
      },
      {
        text: "In the same daily counts: how often Ardia couldn’t save your latest tab changes and told you it would keep trying, and how often the search panel opened before its suggestions were ready. Counts only, and never while browsing privately",
        fields: ["tab_writes_stalled", "search_opens_cold"],
      },
      {
        text: "In the same daily counts: how often you deleted a past search from the search suggestions. A count only, never what you searched for, and never while browsing privately",
        fields: ["searches_forgotten"],
      },
      {
        text: "In the same daily counts, on Android with Material You: how often the tab switcher offered its Archive suggestion again when you came back from your Incognito tabs. Counts only",
        fields: ["archive_card_reoffers"],
      },
      {
        text: "In the same daily counts, on iPhone: how often a tab you swiped to kept its saved picture until a time limit instead of handing over to the page the moment it drew. Counts only, and never while browsing privately",
        fields: ["page_covers_capped"],
      },
      {
        text: "In the same daily counts: how often you chose Custom in Settings › Appearance, and how many changes you made on its Theme page. Counts only, never the colors or settings you picked",
        fields: ["custom_theme_chosen", "theme_edits"],
      },
      {
        text: "In the same daily counts: how often the phone refused to draw the Liquid Glass lens or its rim light, so the glass fell back to plain frost or a flat fill. Counts only",
        fields: ["glass_shaders_failed"],
      },
      {
        text: "In the same daily counts, on iPhone: how often drawing what is under the Liquid Glass took too long, so that glass turned to clear glass for a few seconds. Counts only",
        fields: ["glass_captures_over_budget"],
      },
      {
        text: "In the same daily counts, on iPhone: how often the Liquid Glass over a page briefly showed clear glass because its picture of the page couldn’t keep up, at most once a second per glass. Counts only",
        fields: ["glass_lens_bridged"],
      },
      {
        text: "In the same daily counts, on iPhone: how often a Liquid Glass surface on screen showed clear glass instead of its lens for over three seconds, at most once each time. Counts only",
        fields: ["glass_lens_withheld"],
      },
      {
        text: "In the same daily counts: how often you opened one of the Settings panes, such as General or Tabs. Counts only, never which pane or what you changed",
        fields: ["settings_panes_opened"],
      },
      {
        text: "In the same daily counts, on Android: how many actions you chose in menus Ardia draws, never which action or while browsing privately",
        fields: ["drawn_menu_actions_chosen"],
      },
      {
        text: "In the same daily counts, on iPhone: how often you left Ardia while a web video was in Picture in Picture or full screen, and how often it was still playing 5 seconds later with Ardia in the background. Counts only, never which video or page, and never while browsing privately",
        fields: ["web_videos_floated", "web_videos_kept_playing"],
      },
      {
        text: "In the same daily counts, on Android: how many glass buttons and bars found nothing under them to blur, so they drew a flat fill instead of glass. Counts only",
        fields: ["glass_unsourced"],
      },
      {
        text: "In the same daily counts, on Android: how often you tapped the Ardia logo on the start page to search. Counts only, and never while browsing privately",
        fields: ["start_logo_taps"],
      },
      {
        text: "In the same daily counts, on Android: how often you summarized a page by pinching in or from the page menu, how many summaries ChatGPT or Gemini Nano wrote, how many neither could write, and how often ChatGPT couldn’t summarize so Gemini Nano did on the phone, never while browsing privately. Counts only, never which page or what the summary said",
        fields: ["page_summaries_chatgpt", "page_summaries_chatgpt_fallbacks"],
      },
      {
        text: "In the same daily counts, on Android: how often Ardia checked GitHub for a newer version of the app, how often a new version first put its dot on Settings, how often you tapped Download in Settings › About, how often the phone had nothing that could download it, how often Ardia started Android’s install of a checked download, how often that install was cancelled, failed or finished, and how often a download didn’t match the release’s checksum and was deleted. Counts only, never which version it offered",
        fields: ["app_update_checks", "app_update_offers_shown", "app_update_offers_opened", "app_update_handoffs_failed", "app_update_installs_started", "app_update_installs_cancelled", "app_update_installs_failed", "app_update_installs_completed", "app_update_checksums_refused"],
      },
      {
        text: "In the same daily counts, on Android: how often you turned the Material You design on or off in Settings, how often you closed the find bar, and with Material You on, how often you closed a tab with its card’s close button, went back with the system’s back swipe, opened Archive from the bottom bar, opened the page menu from the address bar, and pulled Search or the page menu up to full screen. Counts only, never which page, and never while browsing privately",
        fields: ["find_closed_bar", "card_close_tapped", "material_back_swiped", "archive_bar_opened", "site_settings_sheet_opened", "search_sheet_expanded", "site_settings_sheet_expanded", "material_you_turned_on", "material_you_turned_off"],
      },
      {
        text: "In the same daily counts: how often you opened Site Settings from the page menu, how often you changed a site’s Page Zoom, Night Shade or Desktop Site there, and how often you opened History, Bookmarks or Downloads from the tab switcher’s menu, never while browsing privately. Counts only, never which site",
        fields: ["page_menu_site_settings_opened", "site_settings_zoom_changed", "site_settings_night_shade_changed", "site_settings_desktop_site_changed", "deck_menu_history_opened", "deck_menu_bookmarks_opened", "deck_menu_downloads_opened"],
      },
    ],
  },
];
