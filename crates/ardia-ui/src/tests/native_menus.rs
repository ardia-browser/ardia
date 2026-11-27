use ardia_state::{BrowserState, TabId};
use gpui::{TestAppContext, point, px};

use super::support::Browser;
use crate::host::NativeMenuItem;
use crate::mock::HostCall;
use crate::msg::{MenuTarget, Msg};
use crate::popovers::context_menu::{MenuEntry, MenuItem, key_equivalent, native_menu};
use crate::popovers::menu_items::tab_or_selection;
use crate::sidebar::overflow_menu::overflow_menu;

fn window_of(browser: &Browser, state: &BrowserState) -> ardia_state::windows::BrowserWindow {
    state
        .window(browser.window.as_str())
        .map(|w| w.as_ref().clone())
        .expect("window")
}

fn find<'a>(items: &'a [NativeMenuItem], title: &str) -> &'a NativeMenuItem {
    items
        .iter()
        .find(|item| item.title == title)
        .unwrap_or_else(|| panic!("no {title} in {items:?}"))
}

fn lines(items: &[NativeMenuItem]) -> Vec<String> {
    items
        .iter()
        .map(|item| {
            if item.separator {
                return "-".to_owned();
            }
            format!(
                "{} [{}]{}",
                item.title,
                item.symbol.as_deref().unwrap_or(""),
                if item.alternate { " (alt)" } else { "" }
            )
        })
        .collect()
}

#[test]
fn shortcuts_become_appkit_key_equivalents() {
    let copy = key_equivalent(Some("⇧⌘C")).expect("a key");
    assert_eq!(copy.key, "c");
    assert_eq!(copy.modifiers, ["shift", "command"]);
    let back = key_equivalent(Some("⌘←")).expect("a key");
    assert_eq!(back.key, "\u{F702}");
    assert_eq!(key_equivalent(Some("🌐F")), None);
    assert_eq!(key_equivalent(None), None);
}

#[test]
fn alternates_pair_their_shortcuts_or_fall_back_to_option() {
    let paired = vec![
        MenuItem::new("copy", "Copy Link")
            .symbol("link")
            .shortcut(Some("⇧⌘C".into()))
            .msg(Msg::command("copyUrl"))
            .alternate(
                MenuItem::new("copyMd", "Copy Link as Markdown")
                    .symbol("link")
                    .shortcut(Some("⌥⇧⌘C".into()))
                    .msg(Msg::command("copyUrlAsMarkdown")),
            )
            .entry(),
    ];
    let menu = native_menu(&paired);
    assert_eq!(menu.items.len(), 2);
    assert_eq!(menu.items[0].key, "c");
    assert_eq!(menu.items[1].modifiers, ["option", "shift", "command"]);
    assert!(menu.items[1].alternate);
    let loose = vec![
        MenuItem::new("mute", "Mute Tab")
            .msg(Msg::command("x"))
            .alternate(MenuItem::new("muteSite", "Mute Site").msg(Msg::command("y")))
            .entry(),
    ];
    let menu = native_menu(&loose);
    assert_eq!(menu.items[0].key, "");
    assert!(menu.items[0].modifiers.is_empty());
    assert_eq!(menu.items[1].modifiers, ["option"]);
}

#[test]
fn only_items_that_do_something_can_be_picked() {
    let entries = vec![
        MenuItem::new("a", "Runs").msg(Msg::command("x")).entry(),
        MenuItem::new("b", "Nothing").entry(),
        MenuItem::new("c", "Off")
            .enabled(false)
            .msg(Msg::command("x"))
            .entry(),
        MenuEntry::Separator,
        MenuEntry::submenu(
            "sub",
            "More",
            None,
            vec![MenuItem::new("a", "Again").msg(Msg::command("z")).entry()],
        ),
    ];
    let menu = native_menu(&entries);
    assert!(menu.items[0].enabled);
    assert!(!menu.items[1].enabled);
    assert!(!menu.items[2].enabled);
    assert!(menu.items[3].separator);
    assert_eq!(menu.items[4].children[0].id, "a#2");
    assert_eq!(menu.picks.len(), 2);
    assert_eq!(menu.picks["a#2"], vec![Msg::command("z")]);
}

#[gpui::test]
fn the_tab_menu_carries_the_old_symbols_and_shortcuts(cx: &mut TestAppContext) {
    let browser = Browser::open(cx);
    let tab = browser.active();
    let state = browser.state();
    let menu = native_menu(&tab_or_selection(
        &state,
        &window_of(&browser, &state),
        &tab,
    ));
    let shown = lines(&menu.items);
    for line in [
        "Copy Link [link]",
        "Copy Link as Markdown [link] (alt)",
        "Duplicate [plus.square.on.square]",
        "Move to [arrow.up.forward.square]",
        "Customize [slider.horizontal.3]",
        "Close Tab [xmark]",
        "Close Tabs [xmark.square]",
    ] {
        assert!(shown.contains(&line.to_owned()), "{line} not in {shown:#?}");
    }
    let close = find(&menu.items, "Close Tab");
    assert_eq!(
        (close.key.as_str(), close.modifiers.clone()),
        ("w", vec!["command".to_owned()])
    );
    let rename = find(&find(&menu.items, "Customize").children, "Rename…");
    assert_eq!(rename.symbol.as_deref(), Some("pencil"));
    assert!(
        find(
            &find(&menu.items, "Close Tabs").children,
            "Close Other Tabs"
        )
        .symbol
        .is_none()
    );
}

#[gpui::test]
fn the_overflow_menu_matches_the_old_one(cx: &mut TestAppContext) {
    let browser = Browser::open(cx);
    let state = browser.state();
    let menu = native_menu(&overflow_menu(&state, &window_of(&browser, &state)));
    assert_eq!(
        lines(&menu.items),
        [
            "Search Tabs… [magnifyingglass]",
            "-",
            "Open Tabs [square.stack]",
            "Recently Closed [clock.arrow.circlepath]",
            "-",
            "Clean Up Tabs [wand.and.stars]",
            "Close Duplicate Tabs [square.on.square]",
            "Close All Tabs [xmark]",
        ]
    );
    let search = find(&menu.items, "Search Tabs…");
    assert_eq!(search.key, "a");
    assert_eq!(search.modifiers, ["shift", "command"]);
    assert!(!find(&menu.items, "Close Duplicate Tabs").enabled);
}

#[gpui::test]
fn duplicate_pages_can_be_closed_from_the_overflow_menu(cx: &mut TestAppContext) {
    let browser = Browser::open(cx);
    browser.new_tab(cx, "https://example.org/same#one");
    browser.new_tab(cx, "https://example.org/same/");
    let state = browser.state();
    let window = window_of(&browser, &state);
    let duplicates = crate::sidebar::overflow_menu::duplicate_tabs(&state, &window);
    assert_eq!(duplicates.len(), 1);
    let menu = native_menu(&overflow_menu(&state, &window));
    assert!(find(&menu.items, "Close Duplicate Tabs").enabled);
}

#[gpui::test]
fn a_right_click_shows_a_native_menu_and_runs_the_pick(cx: &mut TestAppContext) {
    let browser = Browser::open(cx);
    let tab: TabId = browser.active();
    let before = browser.tab_count();
    browser.host.set_menu_pick(Some(Some("duplicate".into())));
    browser
        .handle
        .update(cx, |view, window, cx| {
            view.handle(
                Msg::Menu(Some((
                    MenuTarget::Tab(tab.clone()),
                    point(px(60.), px(80.)),
                ))),
                window,
                cx,
            )
        })
        .expect("open");
    browser.redraw(cx);
    cx.run_until_parked();
    assert!(browser.bounds(cx, "context-menu").is_none());
    let shown = browser
        .host
        .calls()
        .into_iter()
        .find_map(|call| match call {
            HostCall::ShowMenu(items) => Some(items),
            _ => None,
        })
        .expect("a native menu");
    assert_eq!(shown[0].title, "Copy Link");
    assert_eq!(browser.tab_count(), before + 1);
}

#[gpui::test]
fn dismissing_the_native_menu_changes_nothing(cx: &mut TestAppContext) {
    let browser = Browser::open(cx);
    let before = browser.tab_count();
    browser.host.set_menu_pick(Some(None));
    browser
        .handle
        .update(cx, |view, window, cx| {
            view.handle(
                Msg::Menu(Some((MenuTarget::SidebarOverflow, point(px(60.), px(80.))))),
                window,
                cx,
            )
        })
        .expect("open");
    browser.redraw(cx);
    cx.run_until_parked();
    assert!(browser.bounds(cx, "context-menu").is_none());
    assert_eq!(browser.tab_count(), before);
}

fn render(items: &[NativeMenuItem], depth: usize, out: &mut Vec<String>) {
    for item in items {
        let pad = "  ".repeat(depth);
        if item.separator {
            out.push(format!("{pad}---"));
            continue;
        }
        let mut line = format!("{pad}{}", item.title);
        if let Some(symbol) = &item.symbol {
            line.push_str(&format!(" [{symbol}]"));
        }
        let mods: String = [
            ("control", "⌃"),
            ("option", "⌥"),
            ("shift", "⇧"),
            ("command", "⌘"),
        ]
        .iter()
        .filter(|(m, _)| item.modifiers.iter().any(|x| x == m))
        .map(|(_, glyph)| *glyph)
        .collect();
        if !item.key.is_empty() || !mods.is_empty() {
            line.push_str(&format!(" {mods}{}", item.key.to_uppercase()));
        }
        if item.alternate {
            line.push_str(" (alt)");
        }
        if item.checked {
            line.push_str(" ✓");
        }
        if !item.enabled {
            line.push_str(" (off)");
        }
        if !item.children.is_empty() {
            line.push_str(" ›");
        }
        out.push(line);
        render(&item.children, depth + 1, out);
    }
}

#[gpui::test]
fn the_shown_tabs_native_menu_matches_the_old_reference_dump(cx: &mut TestAppContext) {
    let browser = Browser::open(cx);
    browser.new_tab(cx, "https://b.com/");
    let shown = browser.new_tab(cx, "https://c.com/");
    let state = browser.state();
    let menu = native_menu(&tab_or_selection(
        &state,
        &window_of(&browser, &state),
        &shown,
    ));
    let mut lines = Vec::new();
    render(&menu.items, 0, &mut lines);
    let profile = state
        .profile_order
        .first()
        .and_then(|id| state.profile(id.as_str()))
        .map(|p| p.name.clone())
        .unwrap_or_default();
    let mut expected: Vec<String> = [
        "Copy Link [link] ⇧⌘C",
        "Copy Link as Markdown [link] ⌥⇧⌘C (alt)",
        "Duplicate [plus.square.on.square]",
        "Open in Split View [rectangle.split.2x1] ⌃⇧=",
        "Mute Tab [speaker.slash]",
        "Mute Site [speaker.slash] ⌥ (alt)",
        "---",
        "Pin Tab [pin] ⌥⇧⌘D",
        "Move to [arrow.up.forward.square] ›",
        "  Top Apps [square.grid.2x2]",
        "  ---",
        "  New Group [folder.badge.plus] ⌃⌘N",
        "  ---",
        "  Profile [person] ›",
        &format!("    {profile} ✓ (off)"),
        "  Window [macwindow] ›",
        "    New Window",
        "Bookmark Tab… [bookmark] ⌘D",
        "---",
        "Customize [slider.horizontal.3] ›",
        "  Rename… [pencil]",
        "  Change Icon… [photo]",
    ]
    .iter()
    .map(|s| (*s).to_owned())
    .collect();
    if cfg!(target_os = "macos") {
        expected.push("  ---".into());
        expected.push("  Open in WebKit [globe]".into());
    }
    expected.extend(
        [
            "---",
            "Close Tab [xmark] ⌘W",
            "Close Tabs [xmark.square] ›",
            "  Close Other Tabs",
            "  Close Tabs Below (off)",
            "  Close Tabs Above",
        ]
        .iter()
        .map(|s| (*s).to_owned()),
    );
    assert_eq!(lines, expected);
}

fn deep(entries: &[MenuEntry]) -> Vec<String> {
    let mut lines = Vec::new();
    render(&native_menu(entries).items, 0, &mut lines);
    lines
}

#[gpui::test]
fn exit_picture_in_picture_joins_the_quick_actions_while_a_video_floats(cx: &mut TestAppContext) {
    use crate::popovers::menu_items::tab_or_selection_full;
    use crate::popovers::tab_menu_extras::TabExtras;
    let browser = Browser::open(cx);
    let tab = browser.new_tab(cx, "https://b.com/");
    let state = browser.state();
    let window = window_of(&browser, &state);
    let plain = deep(&tab_or_selection_full(
        &state,
        &window,
        &tab,
        &[],
        &TabExtras::default(),
    ));
    assert!(
        !plain
            .iter()
            .any(|l| l.starts_with("Exit Picture in Picture"))
    );
    let floating = TabExtras {
        pip_open: true,
        ..TabExtras::default()
    };
    let lines = deep(&tab_or_selection_full(
        &state,
        &window,
        &tab,
        &[],
        &floating,
    ));
    let at = lines
        .iter()
        .position(|l| l == "Exit Picture in Picture [pip.exit]")
        .expect("the row is there");
    assert_eq!(lines[at - 1], "Mute Site [speaker.slash] ⌥ (alt)");
    assert_eq!(lines[at + 1], "---");
}

#[gpui::test]
fn unread_rows_follow_the_old_rules(cx: &mut TestAppContext) {
    use crate::popovers::tab_menu_extras::unread_entries;
    use ardia_state::settings::SettingsPatch;
    let browser = Browser::open(cx);
    let tab = browser.new_tab(cx, "https://mail.example.com/inbox");
    let title = |browser: &Browser, badged: bool| {
        let state = browser.state();
        let t = state.tab(tab.as_str()).expect("tab").clone();
        unread_entries(&state, &t, badged)
            .first()
            .and_then(|e| e.title().map(str::to_owned))
    };
    browser.act(
        cx,
        ardia_state::Action::UpdateSettings {
            patch: SettingsPatch::new().set("showUnreadCounts", true),
            from_sync: false,
        },
    );
    assert_eq!(title(&browser, true).as_deref(), Some("Hide Unread Count"));
    assert_eq!(title(&browser, false), None);
    browser.act(
        cx,
        ardia_state::Action::UpdateSettings {
            patch: SettingsPatch::new().set("unreadHiddenSites", vec!["mail.example.com"]),
            from_sync: false,
        },
    );
    assert_eq!(title(&browser, false).as_deref(), Some("Show Unread Count"));
    browser.act(
        cx,
        ardia_state::Action::UpdateSettings {
            patch: SettingsPatch::new().set("showUnreadCounts", false),
            from_sync: false,
        },
    );
    assert_eq!(title(&browser, true).as_deref(), Some("Show Unread Counts"));
    assert_eq!(title(&browser, false), None);
}

#[test]
fn a_pinned_calendar_gets_the_old_calendar_menu() {
    use crate::live::{CalendarView, DismissedNow};
    use crate::popovers::tab_menu_extras::calendar_entries;
    use ardia_state::live::CalendarSettings;
    use ardia_state::model::TabPin;
    let mut tab = ardia_state::tabs::Tab::new(
        TabId::new("cal"),
        ardia_state::WindowId::new("w"),
        ardia_state::ProfileId::default_profile(),
        "https://calendar.google.com/calendar/u/0/r",
        0,
    );
    let settings = CalendarSettings::default();
    let view = CalendarView::default();
    let none = DismissedNow::default();
    assert!(calendar_entries(&tab, &settings, &view, &none, 0).is_empty());
    tab.pin = Some(TabPin::Row);
    assert_eq!(
        deep(&calendar_entries(&tab, &settings, &view, &none, 0)),
        [
            "Calendar [calendar] ›",
            "  Connect Calendar… [calendar.badge.plus]",
            "  ---",
            "  Show Next Meeting Alert ›",
            "    Never",
            "    At Meeting Start",
            "    One Minute Before ✓",
            "    Two Minutes Before",
            "    Three Minutes Before",
            "    Five Minutes Before",
            "    Ten Minutes Before",
            "  Show Calendar Preview ✓",
            "  Show Time to Next Meeting ✓",
            "  Active Calendars (off)",
            "  ---",
            "  Calendar Settings… [gearshape]",
        ]
    );
}

#[test]
fn plugin_rows_honour_both_whens_and_fold_past_two() {
    use crate::plugins::model::PluginMenuEntry;
    use crate::plugins::when::WhenContext;
    use crate::popovers::tab_menu_extras::plugin_entries;
    let entry = |plugin: &str, command: &str, when: Option<&str>| PluginMenuEntry {
        plugin: plugin.into(),
        plugin_title: format!("{plugin} title"),
        plugin_icon: None,
        command: command.into(),
        title: format!("Run {command}"),
        icon: Some("puzzlepiece".into()),
        when: None,
        command_when: when.map(str::to_owned),
    };
    let https = WhenContext {
        url_scheme: "https".into(),
        ..WhenContext::default()
    };
    let entries = vec![
        entry("reader", "summarize", Some("urlScheme == 'https'")),
        entry("many", "a", None),
        entry("many", "b", None),
        entry("many", "c", None),
    ];
    let rows = plugin_entries("tab", &entries, &https, &serde_json::Map::new());
    assert_eq!(
        deep(&rows),
        [
            "Run summarize [puzzlepiece]",
            "many title [puzzlepiece] ›",
            "  Run a [puzzlepiece]",
            "  Run b [puzzlepiece]",
            "  Run c [puzzlepiece]",
        ]
    );
    match &rows[0] {
        MenuEntry::Item(item) => match &item.msgs[0] {
            Msg::PluginMenu { context, .. } => {
                assert_eq!(context["from"], "menu");
                assert_eq!(context["slot"], "tab");
            }
            other => panic!("{other:?}"),
        },
        other => panic!("{other:?}"),
    }
    let http = WhenContext {
        url_scheme: "http".into(),
        ..WhenContext::default()
    };
    assert_eq!(
        plugin_entries("tab", &entries[..1], &http, &serde_json::Map::new()).len(),
        0
    );
}

#[gpui::test]
fn clear_recently_closed_is_offered_and_empties_the_list(cx: &mut TestAppContext) {
    let browser = Browser::open(cx);
    let tab = browser.new_tab(cx, "https://closed.example/");
    browser.act(
        cx,
        ardia_state::Action::CloseTabs {
            tabs: vec![tab],
            last_closes_window: false,
        },
    );
    let state = browser.state();
    let window = window_of(&browser, &state);
    let entries = overflow_menu(&state, &window);
    let history = match crate::popovers::context_menu::find(&entries, &["Recently Closed"]) {
        Some(MenuEntry::Submenu(sub)) => sub.children.clone(),
        other => panic!("{other:?}"),
    };
    let clear = match history.last() {
        Some(MenuEntry::Item(item)) if item.title == "Clear Recently Closed" => item.clone(),
        other => panic!("{other:?}"),
    };
    for msg in clear.msgs {
        if let Msg::Store(action) = msg {
            browser.act(cx, action);
        }
    }
    assert!(browser.state().closed.tabs.is_empty());
}

#[gpui::test]
fn a_top_apps_tile_matches_the_old_reference_dump(cx: &mut TestAppContext) {
    use ardia_state::model::TabPin;
    let browser = Browser::open(cx);
    let a = browser.new_tab(cx, "https://a.com/");
    browser.new_tab(cx, "https://b.com/");
    browser.act(
        cx,
        ardia_state::Action::SetPin {
            tab: a.clone(),
            pin: Some(TabPin::TILE),
        },
    );
    browser.act(
        cx,
        ardia_state::Action::UpdateSettings {
            patch: ardia_state::settings::SettingsPatch::new().set("topAppFolders", true),
            from_sync: false,
        },
    );
    let state = browser.state();
    let profile = state
        .profile_order
        .first()
        .and_then(|id| state.profile(id.as_str()))
        .map(|p| p.name.clone())
        .unwrap_or_default();
    let lines = deep(&tab_or_selection(&state, &window_of(&browser, &state), &a));
    let mut expected: Vec<String> = [
        "Copy Link [link]",
        "Copy Link as Markdown [link] ⌥ (alt)",
        "Duplicate [plus.square.on.square]",
        "Mute Tab [speaker.slash]",
        "Mute Site [speaker.slash] ⌥ (alt)",
        "---",
        "Unpin from Top Apps [pin.slash]",
        "Move to [arrow.up.forward.square] ›",
        &format!("  Pinned in {profile} [pin]"),
        "  ---",
        "  New Folder… [folder.badge.plus]",
        "  ---",
        "  Profile [person] ›",
        &format!("    {profile} ✓ (off)"),
        "  Window [macwindow] ›",
        "    New Window",
        "Bookmark Tab… [bookmark]",
        "---",
        "Customize [slider.horizontal.3] ›",
        "  Rename… [pencil]",
        "  Change Icon… [photo]",
        "  ---",
        "  Replace Pinned URL with Current [pin] (off)",
        "  Edit Pinned URL… [link]",
    ]
    .iter()
    .map(|s| (*s).to_owned())
    .collect();
    if cfg!(target_os = "macos") {
        expected.push("  ---".into());
        expected.push("  Open in WebKit [globe]".into());
    }
    assert_eq!(lines, expected);
}

#[gpui::test]
fn edit_pinned_url_asks_like_the_old_sheet_and_saves_the_answer(cx: &mut TestAppContext) {
    use ardia_state::model::TabPin;
    let browser = Browser::open(cx);
    let a = browser.new_tab(cx, "https://a.com/");
    browser.act(
        cx,
        ardia_state::Action::SetPin {
            tab: a.clone(),
            pin: Some(TabPin::TILE),
        },
    );
    browser
        .host
        .set_prompt_answer(Some(Some("b.com/start".into())));
    browser
        .handle
        .update(cx, |view, window, cx| {
            view.handle(Msg::EditPinnedUrl(a.clone()), window, cx)
        })
        .expect("edit");
    cx.run_until_parked();
    let asked = browser
        .host
        .calls()
        .into_iter()
        .find_map(|call| match call {
            HostCall::Prompt(p) => Some(p),
            _ => None,
        })
        .expect("a prompt");
    assert_eq!(asked.title, "Edit Pinned Page");
    assert_eq!(asked.value, "https://a.com/");
    assert_eq!(asked.placeholder, "Enter Pinned URL");
    assert_eq!(asked.confirm, "Save");
    let tab = browser.state().tab(a.as_str()).cloned().expect("tab");
    assert_eq!(tab.pinned_url.as_deref(), Some("https://b.com/start"));
    assert_eq!(tab.url, "https://b.com/start");
}

#[gpui::test]
fn new_folder_makes_a_folder_and_asks_for_its_name(cx: &mut TestAppContext) {
    use ardia_state::model::TabPin;
    let browser = Browser::open(cx);
    let a = browser.new_tab(cx, "https://a.com/");
    browser.act(
        cx,
        ardia_state::Action::SetPin {
            tab: a.clone(),
            pin: Some(TabPin::TILE),
        },
    );
    browser.host.set_prompt_answer(Some(Some("Work".into())));
    browser
        .handle
        .update(cx, |view, window, cx| {
            view.handle(Msg::NewTileFolder(a.clone()), window, cx)
        })
        .expect("new folder");
    cx.run_until_parked();
    let asked = browser
        .host
        .calls()
        .into_iter()
        .find_map(|call| match call {
            HostCall::Prompt(p) => Some(p),
            _ => None,
        })
        .expect("a prompt");
    assert_eq!(
        (asked.title.as_str(), asked.confirm.as_str()),
        ("Name Folder", "Update")
    );
    let state = browser.state();
    let folder = state
        .tab(a.as_str())
        .and_then(|t| t.pin.as_ref().and_then(TabPin::folder).cloned());
    assert_eq!(folder.map(|f| f.name), Some("Work".to_owned()));
    let lines = deep(&tab_or_selection(&state, &window_of(&browser, &state), &a));
    assert!(
        lines.contains(&"  Remove from Folder [folder.badge.minus]".to_owned()),
        "{lines:#?}"
    );
}

#[gpui::test]
fn a_tile_away_from_home_offers_reset_and_replace(cx: &mut TestAppContext) {
    use ardia_state::model::TabPin;
    let browser = Browser::open(cx);
    let a = browser.new_tab(cx, "https://a.com/");
    browser.new_tab(cx, "https://b.com/");
    browser.act(
        cx,
        ardia_state::Action::SetPin {
            tab: a.clone(),
            pin: Some(TabPin::TILE),
        },
    );
    browser.act(
        cx,
        ardia_state::Action::UpdatePage {
            tab: a.clone(),
            update: ardia_state::PageUpdate {
                url: Some("https://a.com/elsewhere".into()),
                ..ardia_state::PageUpdate::default()
            },
        },
    );
    let state = browser.state();
    let lines = deep(&tab_or_selection(&state, &window_of(&browser, &state), &a));
    let unpin = lines
        .iter()
        .position(|l| l == "Unpin from Top Apps [pin.slash]")
        .expect("unpin");
    assert_eq!(lines[unpin + 1], "Reset Pinned Tab [arrow.uturn.backward]");
    assert!(
        lines.contains(&"  Replace Pinned URL with Current [pin]".to_owned()),
        "{lines:#?}"
    );
}
