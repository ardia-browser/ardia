use ardia_state::model::TabPin;
use ardia_state::settings::BookmarksBar;
use ardia_state::{Action, BrowserState, GroupId, TabId};
use gpui::{TestAppContext, point, px};

use super::support::Browser;
use crate::msg::{MenuTarget, Msg};
use crate::popovers::context_menu::{MenuEntry, find, titles};
use crate::popovers::menu_items::{
    group_menu, multi_tab_menu, profile_menu, sidebar_menu, tab_or_selection,
};

fn window_of(browser: &Browser, state: &BrowserState) -> ardia_state::windows::BrowserWindow {
    state
        .window(browser.window.as_str())
        .map(|w| w.as_ref().clone())
        .expect("window")
}

fn tab_titles(browser: &Browser, tab: &TabId) -> Vec<String> {
    let state = browser.state();
    titles(&tab_or_selection(&state, &window_of(browser, &state), tab))
}

fn submenu_titles(entries: &[MenuEntry], path: &[&str]) -> Vec<String> {
    match find(entries, path) {
        Some(MenuEntry::Submenu(sub)) => titles(&sub.children),
        other => panic!("{path:?} is not a submenu: {other:?}"),
    }
}

#[gpui::test]
fn the_tab_menu_matches_the_old_sections(cx: &mut TestAppContext) {
    let browser = Browser::open(cx);
    let tab = browser.active();
    assert_eq!(
        tab_titles(&browser, &tab),
        [
            "Copy Link",
            "Duplicate",
            "Open in Split View",
            "Mute Tab",
            "-",
            "Pin Tab",
            "Move to",
            "Bookmark Tab…",
            "-",
            "Customize",
            "-",
            "Close Tab",
            "Close Tabs",
        ]
    );
    let state = browser.state();
    let entries = tab_or_selection(&state, &window_of(&browser, &state), &tab);
    assert_eq!(
        submenu_titles(&entries, &["Move to"]),
        ["Top Apps", "-", "New Group", "-", "Profile", "Window"]
    );
    let customize: &[&str] = if cfg!(target_os = "macos") {
        &["Rename…", "Change Icon…", "-", "Open in WebKit"]
    } else {
        &["Rename…", "Change Icon…"]
    };
    assert_eq!(submenu_titles(&entries, &["Customize"]), customize);
    assert_eq!(
        submenu_titles(&entries, &["Close Tabs"]),
        ["Close Other Tabs", "Close Tabs Below", "Close Tabs Above"]
    );
    match find(&entries, &["Close Tabs", "Close Other Tabs"]) {
        Some(MenuEntry::Item(item)) => assert!(!item.enabled),
        other => panic!("close others: {other:?}"),
    }
}

#[gpui::test]
fn a_top_app_offers_its_pinned_section_and_no_split(cx: &mut TestAppContext) {
    let browser = Browser::open(cx);
    let tab = browser.active();
    browser.act(
        cx,
        Action::SetPin {
            tab: tab.clone(),
            pin: Some(TabPin::TILE),
        },
    );
    let list = tab_titles(&browser, &tab);
    assert!(list.contains(&"Unpin from Top Apps".to_owned()));
    assert!(!list.contains(&"Open in Split View".to_owned()));
    assert!(!list.contains(&"Close Tab".to_owned()));
    let state = browser.state();
    let entries = tab_or_selection(&state, &window_of(&browser, &state), &tab);
    let moves = submenu_titles(&entries, &["Move to"]);
    assert!(moves[0].starts_with("Pinned in "), "{moves:?}");
}

#[gpui::test]
fn a_selection_gets_the_multi_tab_menu(cx: &mut TestAppContext) {
    let browser = Browser::open(cx);
    let first = browser.active();
    let second = browser.new_tab(cx, "https://example.org/b");
    browser.new_tab(cx, "https://example.net/c");
    browser.act(
        cx,
        Action::SelectTabs {
            window: browser.window.clone(),
            tabs: vec![first.clone(), second.clone()],
        },
    );
    assert_eq!(
        tab_titles(&browser, &second),
        [
            "Copy 2 Links",
            "Duplicate 2 Tabs",
            "-",
            "Pin 2 Tabs",
            "New Group with 2 Tabs",
            "Move to",
            "-",
            "Close 2 Tabs",
            "Close Other Tabs",
        ]
    );
    let state = browser.state();
    let entries = multi_tab_menu(&state, &window_of(&browser, &state), &[first, second]);
    match find(&entries, &["Copy 2 Links"]) {
        Some(MenuEntry::Item(item)) => {
            let alternate = item.alternate.as_ref().expect("markdown alternate");
            assert_eq!(&*alternate.title, "Copy 2 Links as Markdown");
            match &alternate.msgs[0] {
                Msg::Copy(text) => assert!(text.starts_with("- ["), "{text}"),
                other => panic!("{other:?}"),
            }
        }
        other => panic!("{other:?}"),
    }
}

#[gpui::test]
fn the_group_menu_matches_the_old_sections(cx: &mut TestAppContext) {
    let browser = Browser::open(cx);
    let tab = browser.active();
    browser.act(
        cx,
        Action::CreateGroup {
            tabs: vec![tab.clone()],
            name: "Work".into(),
        },
    );
    let state = browser.state();
    let group: GroupId = state.group_of(tab.as_str()).expect("grouped").id.clone();
    let entries = group_menu(&state, &window_of(&browser, &state), &group, false);
    assert_eq!(
        titles(&entries),
        [
            "New Tab in Group",
            "Copy All Links",
            "Duplicate Group",
            "-",
            "Pin Group",
            "Move to",
            "Customize",
            "Sort Tabs",
            "-",
            "Sleep Tabs",
            "Ungroup",
            "Close Group",
        ]
    );
    assert_eq!(
        submenu_titles(&entries, &["Customize", "Color"])[..3],
        ["None", "Neutral", "-"]
    );
}

#[gpui::test]
fn the_sidebar_and_profile_menus_match_the_old_ones(cx: &mut TestAppContext) {
    let browser = Browser::open(cx);
    let state = browser.state();
    let window = window_of(&browser, &state);
    let sidebar = sidebar_menu(&state, &window);
    assert_eq!(
        titles(&sidebar),
        [
            "New Tab",
            "New Tab in Split View",
            "Reopen Closed Tab",
            "-",
            "New Group",
            "Sort Tabs",
            "-",
            "Browser Layout",
            "-",
            "Close Duplicate Tabs",
            "Close All Tabs",
        ]
    );
    let layout = submenu_titles(&sidebar, &["Browser Layout"]);
    assert_eq!(
        layout[..3],
        ["Sidebar on Left", "Sidebar on Right", "Top Tab Bar"]
    );
    assert!(layout.contains(&"Minimalism Mode".to_owned()));
    let profiles = titles(&profile_menu(&state, &window));
    assert_eq!(
        profiles[profiles.len() - 3..],
        ["-", "New Profile…", "Manage Profiles…"]
    );
}

#[gpui::test]
fn clicking_a_menu_item_runs_it_and_closes_the_menu(cx: &mut TestAppContext) {
    let browser = Browser::open(cx);
    let tab = browser.active();
    let before = browser.tab_count();
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
    assert!(browser.bounds(cx, "context-menu").is_some());
    browser.click(cx, "menu-duplicate");
    assert_eq!(browser.tab_count(), before + 1);
    assert!(browser.bounds(cx, "context-menu").is_none());
}

#[gpui::test]
fn commands_follow_the_old_handlers(cx: &mut TestAppContext) {
    let browser = Browser::open(cx);
    let first = browser.active();
    let second = browser.new_tab(cx, "https://example.org/b");
    let run = |cx: &mut TestAppContext, id: &'static str| {
        browser
            .handle
            .update(cx, |view, window, cx| view.run_command(id, window, cx))
            .expect("run");
        cx.run_until_parked();
    };
    run(cx, "toggleBookmarksBar");
    assert_eq!(browser.state().settings.bookmarks_bar, BookmarksBar::Always);
    run(cx, "setBookmarksBar:never");
    assert_eq!(browser.state().settings.bookmarks_bar, BookmarksBar::Never);
    run(cx, "toggleMinimalism");
    assert!(browser.state().settings.minimalism_mode);
    let compact = browser.state().settings.compact_toolbar;
    run(cx, "toggleCompactToolbar");
    assert_eq!(browser.state().settings.compact_toolbar, compact);
    run(cx, "toggleMinimalism");
    let count = browser.tab_count();
    run(cx, "cleanUpTabs");
    assert_eq!(browser.tab_count(), count);
    browser.act(
        cx,
        Action::SelectTabs {
            window: browser.window.clone(),
            tabs: vec![first.clone(), second.clone()],
        },
    );
    run(cx, "closeTab");
    let state = browser.state();
    assert!(state.tab(first.as_str()).is_none() && state.tab(second.as_str()).is_none());
    assert!(
        state
            .window(browser.window.as_str())
            .is_none_or(|w| w.chrome.selection.is_empty())
    );
}

#[gpui::test]
fn prompt_buttons_send_the_answers_the_host_understands(cx: &mut TestAppContext) {
    let browser = Browser::open(cx);
    let tab = browser.active();
    browser.act(
        cx,
        Action::SetPrompts {
            tab: tab.clone(),
            prompts: vec![ardia_state::tabs::SitePrompt::Autofill {
                kind: ardia_state::tabs::AutofillKind::Address,
            }],
        },
    );
    browser.redraw(cx);
    browser.click(cx, "autofill-fill");
    assert!(browser.host.calls().iter().any(|call| matches!(
        call,
        crate::mock::HostCall::Autofill { action, .. } if action == "accept"
    )));
    browser.act(
        cx,
        Action::SetPrompts {
            tab,
            prompts: vec![ardia_state::tabs::SitePrompt::SavePassword {
                origin: "https://login.example".into(),
                username: "ada".into(),
            }],
        },
    );
    browser.redraw(cx);
    browser.click(cx, "password-not-now");
    assert!(browser.host.calls().iter().any(|call| matches!(
        call,
        crate::mock::HostCall::Password { action, .. } if action == "dismiss"
    )));
}

#[gpui::test]
fn site_controls_open_more_from_the_footer(cx: &mut TestAppContext) {
    let browser = Browser::open(cx);
    browser
        .handle
        .update(cx, |view, window, cx| {
            view.handle(
                Msg::TogglePopover(ardia_state::windows::Popover::SiteControls),
                window,
                cx,
            )
        })
        .expect("open");
    browser.redraw(cx);
    assert!(browser.bounds(cx, "site-share").is_some());
    assert!(browser.bounds(cx, "site-blocker").is_some());
    assert!(browser.bounds(cx, "site-settings").is_none());
    browser.click(cx, "site-more");
    assert!(browser.bounds(cx, "site-settings").is_some());
    browser.click(cx, "site-more");
    assert!(browser.bounds(cx, "site-settings").is_none());
}

#[gpui::test]
fn the_group_move_menu_keeps_the_group_together(cx: &mut TestAppContext) {
    let browser = Browser::open(cx);
    let tab = browser.active();
    browser.act(
        cx,
        Action::CreateGroup {
            tabs: vec![tab.clone()],
            name: "Work".into(),
        },
    );
    let state = browser.state();
    let group: GroupId = state.group_of(tab.as_str()).expect("grouped").id.clone();
    let entries = group_menu(&state, &window_of(&browser, &state), &group, false);
    assert_eq!(
        submenu_titles(&entries, &["Move to"]),
        ["Profile", "Window", "Bookmarks Bar"]
    );
    match find(&entries, &["Move to", "Window", "New Window"]) {
        Some(MenuEntry::Item(item)) => assert_eq!(
            item.msgs,
            [Msg::MoveGroupToWindow {
                group: group.clone(),
                window: None
            }]
        ),
        other => panic!("{other:?}"),
    }
    match find(&entries, &["Move to", "Bookmarks Bar"]) {
        Some(MenuEntry::Item(item)) => {
            assert_eq!(item.msgs, [Msg::GroupToBookmarksBar(group)])
        }
        other => panic!("{other:?}"),
    }
}
