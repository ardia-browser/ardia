mod common;

use ardia_state::actions::{Action, ActionError, NewTab, PageUpdate, Topics};
use ardia_state::model::{Orientation, PageKind, TabPin};
use ardia_state::settings::{AfterClosingTab, NewTabPosition, SettingsPatch};
use ardia_state::splits::SplitSide;
use ardia_state::windows::WindowKind;
use ardia_state::{TabId, WindowId};
use common::{World, check_invariants, reloaded};

#[test]
fn a_new_window_opens_one_blank_active_tab() {
    let mut w = World::new();
    let win = w.open();
    let window = &w.state.windows[&win];
    assert_eq!(window.kind, WindowKind::Main);
    assert_eq!(window.tab_ids.len(), 1);
    assert_eq!(w.active_url(&win), "");
    assert_eq!(w.state.focus_order[0], win);
    assert_eq!(w.state.last_profile_id.as_ref(), Some(&w.default_profile()));
    check_invariants(&w.state);
}

#[test]
fn new_tabs_follow_the_position_setting_and_their_opener() {
    let mut w = World::new();
    let win = w.open();
    let a = w.open_tab(&win, "a.com");
    let b = w.open_tab(&win, "b.com");
    assert_eq!(w.urls(&win), ["", "https://a.com", "https://b.com"]);
    assert_eq!(w.active(&win), b);
    let c1 = w.open_child(&win, &a, "c1.com", true);
    let c2 = w.open_child(&win, &a, "c2.com", true);
    assert_eq!(w.order(&win)[1..4], [a.clone(), c1.clone(), c2]);
    assert_eq!(w.active(&win), b, "background links keep the current tab");
    let front = w.open_child(&win, &a, "front.com", false);
    assert_eq!(
        w.order(&win)[2],
        front,
        "a foreground link opens right after its opener"
    );
    assert_eq!(w.active(&win), front);
    w.act(Action::UpdateSettings {
        patch: SettingsPatch::new().set("newTabPosition", NewTabPosition::Top),
        from_sync: false,
    });
    let top = w.open_tab(&win, "top.com");
    assert_eq!(w.order(&win)[0], top);
    w.act(Action::UpdateSettings {
        patch: SettingsPatch::new().set("newTabPosition", NewTabPosition::NextToCurrent),
        from_sync: false,
    });
    w.act(Action::ActivateTab { tab: c1.clone() });
    let next = w.open_tab(&win, "next.com");
    let order = w.order(&win);
    assert_eq!(
        order[order.iter().position(|t| *t == c1).unwrap() + 1],
        next
    );
    check_invariants(&w.state);
}

#[test]
fn typed_text_becomes_a_search_or_an_address() {
    let mut w = World::new();
    let win = w.open();
    let t = w.open_tab(&win, "rust borrow checker");
    assert!(
        w.state.tabs[&t]
            .url
            .starts_with("https://www.google.com/search?q=rust"),
        "{}",
        w.state.tabs[&t].url
    );
    let searched = w.state.tabs[&t].url.clone();
    w.act(Action::Navigate {
        tab: t.clone(),
        input: "example.com/path".into(),
    });
    assert_eq!(
        w.state.tabs[&t].url, searched,
        "the address changes when the page commits"
    );
    assert_eq!(
        w.state.tabs[&t].live.navigation.as_deref(),
        Some("https://example.com/path")
    );
    assert_eq!(w.state.tabs[&t].page.kind, PageKind::Loaded);
    w.act(Action::UpdatePage {
        tab: t.clone(),
        update: PageUpdate {
            url: Some("https://example.com/path".into()),
            ..PageUpdate::default()
        },
    });
    assert_eq!(w.state.tabs[&t].url, "https://example.com/path");
    assert_eq!(w.state.tabs[&t].live.navigation, None);
    assert!(matches!(
        w.try_act(Action::Navigate {
            tab: t,
            input: "   ".into()
        }),
        Err(ActionError::Invalid(_))
    ));
}

#[test]
fn closing_the_active_tab_follows_after_closing_tab() {
    let mut w = World::new();
    let win = w.open();
    let first = w.active(&win);
    let a = w.open_tab(&win, "a.com");
    let b = w.open_tab(&win, "b.com");
    let c = w.open_tab(&win, "c.com");
    w.act(Action::ActivateTab { tab: a.clone() });
    w.act(Action::ActivateTab { tab: c.clone() });
    w.close(&[&c]);
    assert_eq!(w.active(&win), a, "previously active is the default");
    w.act(Action::UpdateSettings {
        patch: SettingsPatch::new().set("afterClosingTab", AfterClosingTab::TabAbove),
        from_sync: false,
    });
    w.act(Action::ActivateTab { tab: b.clone() });
    w.close(&[&b]);
    assert_eq!(w.active(&win), a);
    w.act(Action::UpdateSettings {
        patch: SettingsPatch::new().set("afterClosingTab", AfterClosingTab::TabBelow),
        from_sync: false,
    });
    w.close(&[&a]);
    assert_eq!(w.active(&win), first, "nothing below falls back to above");
    check_invariants(&w.state);
}

#[test]
fn the_last_tab_either_closes_the_window_or_leaves_a_blank_one() {
    let mut w = World::new();
    let win = w.open();
    let only = w.active(&win);
    w.act(Action::Navigate {
        tab: only.clone(),
        input: "example.com".into(),
    });
    w.close(&[&only]);
    assert!(w.state.windows.contains_key(&win));
    assert_eq!(w.urls(&win), [""]);
    assert_eq!(w.state.closed.tabs.len(), 1);
    let blank = w.active(&win);
    w.act(Action::Navigate {
        tab: blank.clone(),
        input: "example.org".into(),
    });
    let out = w.act(Action::CloseTabs {
        tabs: vec![blank],
        last_closes_window: true,
    });
    assert_eq!(out.closed_windows, vec![win]);
    assert!(w.state.windows.is_empty());
    assert_eq!(w.state.closed.windows.len(), 1);
    w.act(Action::ReopenClosed { window: None });
    let back = w.state.window_order[0].clone();
    assert_eq!(w.urls(&back), ["https://example.org"]);
    check_invariants(&w.state);
}

#[test]
fn closing_a_pinned_tab_unloads_it_and_returns_home() {
    let mut w = World::new();
    let win = w.open();
    let mail = w.open_tab(&win, "mail.com");
    w.act(Action::SetPin {
        tab: mail.clone(),
        pin: Some(TabPin::TILE),
    });
    assert_eq!(w.order(&win)[0], mail, "pins move above regular tabs");
    assert_eq!(
        w.state.tabs[&mail].pinned_url.as_deref(),
        Some("https://mail.com")
    );
    w.act(Action::UpdatePage {
        tab: mail.clone(),
        update: PageUpdate {
            url: Some("https://mail.com/inbox/42".into()),
            ..PageUpdate::default()
        },
    });
    w.close(&[&mail]);
    let tab = &w.state.tabs[&mail];
    assert!(tab.page.is_asleep());
    assert_eq!(tab.url, "https://mail.com");
    assert_ne!(w.active(&win), mail);
    assert!(w.state.closed.tabs[0].pinned_tile);
    assert_eq!(w.state.closed.tabs[0].tab.url, "https://mail.com/inbox/42");
    w.act(Action::ReturnToPinnedUrl { tab: mail.clone() });
    assert_eq!(w.state.tabs[&mail].page.kind, PageKind::Loaded);
    check_invariants(&w.state);
}

#[test]
fn reopening_a_closed_tab_puts_it_back_where_it_was() {
    let mut w = World::new();
    let win = w.open();
    let _a = w.open_tab(&win, "a.com");
    let b = w.open_tab(&win, "b.com");
    let _c = w.open_tab(&win, "c.com");
    w.act(Action::SetMuted {
        tab: b.clone(),
        muted: true,
    });
    w.close(&[&b]);
    assert_eq!(w.urls(&win), ["", "https://a.com", "https://c.com"]);
    w.act(Action::ReopenClosed {
        window: Some(win.clone()),
    });
    assert_eq!(
        w.urls(&win),
        ["", "https://a.com", "https://b.com", "https://c.com"]
    );
    let back = w.active(&win);
    assert!(w.state.tabs[&back].muted);
    assert_eq!(
        w.state.tabs[&back].page.wake.as_deref(),
        Some(format!("restore:{b}").as_str())
    );
    assert!(w.state.closed.tabs.is_empty());
    assert!(matches!(
        w.try_act(Action::ReopenClosed { window: None }),
        Err(ActionError::Invalid(_))
    ));
    check_invariants(&w.state);
}

#[test]
fn closing_a_window_saves_it_and_parks_its_pins_for_the_next_one() {
    let mut w = World::new();
    let win = w.open();
    let pin = w.open_tab(&win, "pinned.com");
    w.act(Action::SetPin {
        tab: pin,
        pin: Some(TabPin::TILE),
    });
    let a = w.open_tab(&win, "a.com");
    let b = w.open_tab(&win, "b.com");
    w.act(Action::CreateGroup {
        tabs: vec![a, b],
        name: "Work".into(),
    });
    w.act(Action::CloseWindow {
        window: win.clone(),
    });
    let closed = &w.state.closed.windows[0];
    assert_eq!(
        closed
            .tabs
            .iter()
            .map(|t| t.snapshot.url.as_str())
            .collect::<Vec<_>>(),
        ["", "https://a.com", "https://b.com"]
    );
    assert_eq!(closed.groups.len(), 1);
    assert_eq!(closed.groups[0].tab_indexes, [1, 2]);
    let profile = w.default_profile();
    assert_eq!(w.state.persisted.parked_pins[&profile].tabs.len(), 1);
    let next = w.open();
    assert!(w.state.persisted.parked_pins.is_empty());
    assert_eq!(w.urls(&next), ["https://pinned.com", ""]);
    let adopted = &w.state.tabs[&w.order(&next)[0]];
    assert!(adopted.page.is_asleep());
    assert!(adopted.is_pinned());
    w.act(Action::ReopenClosed { window: Some(next) });
    let restored = w.state.window_order.last().unwrap().clone();
    assert_eq!(
        w.urls(&restored),
        ["https://pinned.com", "", "https://a.com", "https://b.com"]
    );
    let group = w
        .state
        .groups
        .values()
        .find(|g| g.window_id == restored)
        .expect("the group came back");
    assert_eq!(group.name, "Work");
    assert_eq!(group.tab_ids.len(), 2);
    check_invariants(&w.state);
}

#[test]
fn splits_hold_two_to_four_panes_and_dissolve_below_two() {
    let mut w = World::new();
    let win = w.open();
    let a = w.open_tab(&win, "a.com");
    let _x = w.open_tab(&win, "x.com");
    let b = w.open_tab(&win, "b.com");
    let split = w
        .act(Action::SplitTabs {
            tabs: vec![a.clone(), b.clone()],
            orientation: Orientation::Horizontal,
        })
        .split
        .unwrap();
    let order = w.order(&win);
    let ia = order.iter().position(|t| *t == a).unwrap();
    assert_eq!(order[ia + 1], b, "split panes sit side by side");
    w.act(Action::OpenSplitPane {
        window: win.clone(),
        side: SplitSide::Right,
        url: Some("c.com".into()),
    });
    w.act(Action::OpenSplitPane {
        window: win.clone(),
        side: SplitSide::Bottom,
        url: Some("d.com".into()),
    });
    assert_eq!(w.state.splits[&split].pane_count(), 4);
    assert!(matches!(
        w.try_act(Action::OpenSplitPane {
            window: win.clone(),
            side: SplitSide::Right,
            url: None
        }),
        Err(ActionError::Invalid(_))
    ));
    let active = w.active(&win);
    w.act(Action::FocusPane {
        window: win.clone(),
        delta: 1,
    });
    assert_ne!(w.active(&win), active);
    w.close(&[&a]);
    assert_eq!(w.state.splits[&split].pane_count(), 3);
    check_invariants(&w.state);
    let panes = w.state.splits[&split].tab_ids();
    w.act(Action::RemoveFromSplit {
        tab: panes[0].clone(),
    });
    w.act(Action::RemoveFromSplit {
        tab: panes[1].clone(),
    });
    assert!(w.state.splits.is_empty());
    assert!(matches!(
        w.try_act(Action::SplitTabs {
            tabs: vec![b],
            orientation: Orientation::Vertical
        }),
        Err(ActionError::Invalid(_))
    ));
    check_invariants(&w.state);
}

#[test]
fn groups_gather_tabs_and_come_back_from_recently_closed() {
    let mut w = World::new();
    let win = w.open();
    let a = w.open_tab(&win, "a.com");
    let b = w.open_tab(&win, "b.com");
    let c = w.open_tab(&win, "c.com");
    let group = w
        .act(Action::CreateGroup {
            tabs: vec![a.clone(), c.clone()],
            name: " Reading ".into(),
        })
        .group
        .unwrap();
    assert_eq!(w.state.groups[&group].name, "Reading");
    let order = w.order(&win);
    let ia = order.iter().position(|t| *t == a).unwrap();
    assert_eq!(order[ia + 1], c, "grouped tabs are pulled together");
    w.act(Action::AddToGroup {
        group: group.clone(),
        tabs: vec![b.clone()],
    });
    assert_eq!(w.state.groups[&group].tab_ids.len(), 3);
    w.act(Action::RemoveFromGroups { tabs: vec![b] });
    assert_eq!(w.state.groups[&group].tab_ids, [a.clone(), c]);
    w.act(Action::CloseGroup { group });
    assert!(w.state.groups.is_empty());
    assert!(!w.state.tabs.contains_key(&a));
    assert_eq!(w.state.closed.groups.len(), 1);
    w.act(Action::ReopenClosed {
        window: Some(win.clone()),
    });
    let back = w.state.groups.values().next().expect("the group is back");
    assert_eq!(back.name, "Reading");
    assert_eq!(back.tab_ids.len(), 2);
    w.act(Action::Ungroup {
        group: back.id.clone(),
    });
    assert!(w.state.groups.is_empty());
    check_invariants(&w.state);
}

#[test]
fn profiles_switch_per_window_and_deleting_one_moves_windows_away() {
    let mut w = World::new();
    let win = w.open();
    let home = w.active(&win);
    let work = w
        .act(Action::CreateProfile {
            name: "Work".into(),
            color: None,
            icon: None,
        })
        .profile
        .unwrap();
    assert!(matches!(
        w.try_act(Action::CreateProfile {
            name: "  ".into(),
            color: None,
            icon: None
        }),
        Err(ActionError::Invalid(_))
    ));
    w.act(Action::SwitchProfile {
        window: win.clone(),
        profile: work.clone(),
    });
    assert_eq!(w.state.windows[&win].profile_id, work);
    let work_tab = w.active(&win);
    assert_ne!(work_tab, home);
    assert_eq!(w.state.tabs[&work_tab].profile_id, work);
    assert_eq!(w.state.last_active_profile(), work);
    let default = w.default_profile();
    w.act(Action::SwitchProfile {
        window: win.clone(),
        profile: default.clone(),
    });
    assert_eq!(
        w.active(&win),
        home,
        "each profile keeps its own active tab"
    );
    w.act(Action::SwitchProfile {
        window: win.clone(),
        profile: work.clone(),
    });
    w.act(Action::DeleteProfile { profile: work });
    assert_eq!(w.state.windows[&win].profile_id, default);
    assert!(!w.state.tabs.contains_key(&work_tab));
    assert!(matches!(
        w.try_act(Action::DeleteProfile { profile: default }),
        Err(ActionError::Invalid(_))
    ));
    check_invariants(&w.state);
}

#[test]
fn turning_auto_hide_on_everywhere_drops_window_overrides() {
    let mut w = World::new();
    let win = w.open();
    w.act(Action::ToggleSidebar {
        window: win.clone(),
    });
    assert_eq!(w.state.windows[&win].auto_hide_tabs, Some(true));
    assert!(!w.state.sidebar_shown(win.as_str()));
    w.act(Action::UpdateSettings {
        patch: SettingsPatch::new().set("autoHideTabs", true),
        from_sync: false,
    });
    assert_eq!(w.state.windows[&win].auto_hide_tabs, None);
    assert!(w.state.auto_hides_tabs(win.as_str()));
    let out = w.act(Action::UpdateSettings {
        patch: SettingsPatch::new().set("autoHideTabs", true),
        from_sync: false,
    });
    assert!(
        out.changes.is_empty(),
        "setting a value it already has changes nothing"
    );
    let rejected = w.act(Action::UpdateSettings {
        patch: SettingsPatch::new().set("sidebarWidth", "wide"),
        from_sync: false,
    });
    assert!(rejected.changes.is_empty());
}

#[test]
fn clearing_unpinned_tabs_keeps_the_current_and_playing_ones_and_undoes() {
    let mut w = World::new();
    let win = w.open();
    let pin = w.open_tab(&win, "pinned.com");
    w.act(Action::SetPin {
        tab: pin,
        pin: Some(TabPin::Row),
    });
    let music = w.open_tab(&win, "music.com");
    w.act(Action::UpdatePage {
        tab: music,
        update: PageUpdate {
            audible: Some(true),
            ..PageUpdate::default()
        },
    });
    let _a = w.open_tab(&win, "a.com");
    let current = w.open_tab(&win, "current.com");
    w.act(Action::ClearUnpinned {
        window: win.clone(),
    });
    assert_eq!(
        w.urls(&win),
        [
            "https://pinned.com",
            "https://music.com",
            "https://current.com"
        ]
    );
    assert_eq!(w.active(&win), current);
    w.act(Action::UndoClear {
        window: win.clone(),
    });
    assert_eq!(
        w.urls(&win),
        [
            "https://pinned.com",
            "https://music.com",
            "https://a.com",
            "https://current.com"
        ],
        "blank tabs aren't worth bringing back"
    );
    assert!(
        w.state.closed.tabs.is_empty(),
        "undo takes the entries back out of recently closed"
    );
    assert!(matches!(
        w.try_act(Action::UndoClear {
            window: win.clone()
        }),
        Err(ActionError::Invalid(_))
    ));
    check_invariants(&w.state);
}

#[test]
fn a_clear_stays_undoable_until_the_window_changes_or_its_entries_go() {
    let mut w = World::new();
    let win = w.open();
    let _a = w.open_tab(&win, "a.com");
    let _b = w.open_tab(&win, "b.com");
    let current = w.open_tab(&win, "current.com");
    w.act(Action::ClearUnpinned {
        window: win.clone(),
    });
    assert!(ardia_state::closed::can_undo_clear(&w.state, &win));
    w.act(Action::SetPin {
        tab: current,
        pin: Some(TabPin::Row),
    });
    assert!(
        !ardia_state::closed::can_undo_clear(&w.state, &win),
        "pinning a tab after the clear changes the window"
    );
    let mut w = World::new();
    let win = w.open();
    let _a = w.open_tab(&win, "a.com");
    let _current = w.open_tab(&win, "current.com");
    w.act(Action::ClearUnpinned {
        window: win.clone(),
    });
    assert!(ardia_state::closed::can_undo_clear(&w.state, &win));
    w.act(Action::ClearRecentlyClosed { window: None });
    assert!(!ardia_state::closed::can_undo_clear(&w.state, &win));
}

#[test]
fn peeks_float_over_the_page_until_promoted() {
    let mut w = World::new();
    let win = w.open();
    let source = w.open_tab(&win, "source.com");
    let peek = w
        .act(Action::OpenPeek {
            window: win.clone(),
            url: "peek.com".into(),
            source: Some(source.clone()),
        })
        .tab
        .unwrap();
    assert!(w.state.tabs[&peek].live.peek);
    assert!(!w.order(&win).contains(&peek));
    assert!(
        !w.state.session_json().contains("peek.com"),
        "a peek is never saved"
    );
    check_invariants(&w.state);
    w.act(Action::PromotePeek {
        window: win.clone(),
    });
    let order = w.order(&win);
    assert_eq!(
        order[order.iter().position(|t| *t == source).unwrap() + 1],
        peek
    );
    assert_eq!(w.active(&win), peek);
    assert!(w.state.windows[&win].chrome.peek.is_none());
    w.act(Action::OpenPeek {
        window: win.clone(),
        url: "again.com".into(),
        source: None,
    });
    w.act(Action::ClosePeek {
        window: win.clone(),
    });
    assert!(w.state.tabs.values().all(|t| !t.live.peek));
    check_invariants(&w.state);
}

#[test]
fn little_ardia_moves_its_page_into_a_main_window() {
    let mut w = World::new();
    let main = w.open();
    let little = w
        .act(Action::OpenWindow {
            kind: WindowKind::LittleArdia,
            profile: None,
            url: Some("link.com".into()),
            frame: None,
        })
        .window
        .unwrap();
    assert!(
        !w.state.session_json().contains("link.com"),
        "Little Ardia isn't saved"
    );
    let page = w.active(&little);
    w.act(Action::PromoteLittleArdia {
        window: little.clone(),
    });
    assert!(!w.state.windows.contains_key(&little));
    assert_eq!(w.state.tabs[&page].window_id, main);
    assert_eq!(w.active(&main), page);
    assert_eq!(w.state.focus_order[0], main);
    check_invariants(&w.state);
}

#[test]
fn closed_little_ardia_tabs_reopen_in_little_ardia() {
    let mut w = World::new();
    w.open();
    let little = w
        .act(Action::OpenWindow {
            kind: WindowKind::LittleArdia,
            profile: None,
            url: Some("link.com".into()),
            frame: None,
        })
        .window
        .unwrap();
    let page = w.active(&little);
    w.act(Action::CloseTabs {
        tabs: vec![page],
        last_closes_window: false,
    });
    assert!(
        !w.state.windows.contains_key(&little),
        "Little Ardia closes with its page"
    );
    w.act(Action::ReopenClosed { window: None });
    let back = w
        .state
        .windows
        .values()
        .find(|win| win.kind == WindowKind::LittleArdia)
        .expect("reopened in Little Ardia");
    assert_eq!(w.state.tabs[&back.tab_ids[0]].url, "https://link.com");
    check_invariants(&w.state);
}

#[test]
fn incognito_windows_stay_private() {
    let mut w = World::new();
    let main = w.open();
    let private = w
        .act(Action::OpenWindow {
            kind: WindowKind::Incognito,
            profile: None,
            url: Some("secret.com".into()),
            frame: None,
        })
        .window
        .unwrap();
    let window = &w.state.windows[&private];
    assert!(window.profile_id.is_incognito());
    assert_eq!(window.profile_id.incognito_original(), w.default_profile());
    let tab = w.active(&private);
    assert!(matches!(
        w.try_act(Action::SetPin {
            tab: tab.clone(),
            pin: Some(TabPin::TILE)
        }),
        Err(ActionError::Invalid(_))
    ));
    assert!(matches!(
        w.try_act(Action::MoveTab {
            tab: tab.clone(),
            window: main,
            index: 0
        }),
        Err(ActionError::Invalid(_))
    ));
    let profile = w.state.tabs[&tab].profile_id.clone();
    w.act(Action::RecordVisit {
        profile,
        url: "https://secret.com".into(),
        title: "Secret".into(),
        favicon: None,
    });
    assert!(w.state.history.is_empty());
    w.close(&[&tab]);
    assert!(!w.state.session_json().contains("secret.com"));
    assert_eq!(w.state.last_profile_id.as_ref(), Some(&w.default_profile()));
    check_invariants(&w.state);
}

#[test]
fn moving_a_tab_between_windows_closes_the_emptied_one() {
    let mut w = World::new();
    let one = w.open();
    let two = w.open();
    let moving = w.active(&two);
    w.act(Action::Navigate {
        tab: moving.clone(),
        input: "moving.com".into(),
    });
    assert_eq!(
        w.state.tabs[&moving].url, "https://moving.com",
        "a blank tab takes the typed address at once"
    );
    w.act(Action::MoveTab {
        tab: moving.clone(),
        window: one.clone(),
        index: 0,
    });
    assert!(!w.state.windows.contains_key(&two));
    assert_eq!(w.state.tabs[&moving].window_id, one);
    assert_eq!(w.active(&one), moving);
    check_invariants(&w.state);
}

#[test]
fn page_updates_are_cosmetic_unless_the_address_changes() {
    let mut w = World::new();
    let win = w.open();
    let t = w.open_tab(&win, "a.com");
    let title = w.act(Action::UpdatePage {
        tab: t.clone(),
        update: PageUpdate {
            title: Some("A".into()),
            ..PageUpdate::default()
        },
    });
    assert!(title.changes.persists_session());
    assert!(title.changes.cosmetic_only);
    let progress = w.act(Action::UpdatePage {
        tab: t.clone(),
        update: PageUpdate {
            progress: Some(0.5),
            loading: Some(true),
            ..PageUpdate::default()
        },
    });
    assert!(!progress.changes.persists_session());
    assert!(progress.changes.topics.contains(Topics::LIVE));
    assert_eq!(progress.changes.tabs, std::slice::from_ref(&t));
    let moved = w.act(Action::UpdatePage {
        tab: t.clone(),
        update: PageUpdate {
            url: Some("https://b.com".into()),
            ..PageUpdate::default()
        },
    });
    assert!(!moved.changes.cosmetic_only);
    let found = w.act(Action::SetFind {
        tab: t,
        find: Default::default(),
    });
    assert!(!found.changes.persists_session());
}

#[test]
fn failed_actions_leave_the_state_untouched() {
    let mut w = World::new();
    let win = w.open();
    let before = w.state.session_json();
    let ghost = ardia_state::ids::TabId::new("tab-ghost");
    let ghost_window = ardia_state::ids::WindowId::new("w-ghost");
    let failures = [
        Action::ActivateTab { tab: ghost.clone() },
        Action::CloseWindow {
            window: ghost_window.clone(),
        },
        Action::NewTab {
            window: ghost_window,
            tab: NewTab::default(),
        },
        Action::SetZoom {
            tab: w.active(&win),
            zoom: f64::NAN,
        },
        Action::SetZoom {
            tab: w.active(&win),
            zoom: 9.0,
        },
        Action::SplitTabs {
            tabs: vec![w.active(&win), ghost],
            orientation: Orientation::Horizontal,
        },
        Action::SwitchProfile {
            window: win.clone(),
            profile: ardia_state::ids::ProfileId::new("nobody"),
        },
        Action::RestoreClosed {
            id: ardia_state::ids::EntryId::new("ct-none"),
            window: None,
        },
        Action::UndoClear {
            window: win.clone(),
        },
    ];
    for action in failures {
        let shown = format!("{action:?}");
        assert!(w.try_act(action).is_err(), "{shown} should fail");
        assert_eq!(w.state.session_json(), before, "{shown} changed the state");
    }
}

#[test]
fn reducers_are_deterministic_and_saved_sessions_reload_identically() {
    let run = || {
        let mut w = World::new();
        let win = w.open();
        let a = w.open_tab(&win, "a.com");
        let b = w.open_tab(&win, "b.com");
        w.act(Action::SetPin {
            tab: a,
            pin: Some(TabPin::TILE),
        });
        w.act(Action::CreateGroup {
            tabs: vec![b.clone()],
            name: "G".into(),
        });
        let c = w.open_tab(&win, "c.com");
        w.act(Action::SplitTabs {
            tabs: vec![b, c.clone()],
            orientation: Orientation::Vertical,
        });
        w.act(Action::RenameTab {
            tab: c.clone(),
            title: Some("Line\nbreak".into()),
        });
        w.close(&[&c]);
        w.state
    };
    let one = run();
    let two = run();
    assert_eq!(one.session_json(), two.session_json());
    let again = reloaded(&one, common::T0 + 60_000);
    check_invariants(&again);
    assert_eq!(again.session_json(), one.session_json());
}

#[test]
fn closing_a_nested_group_tree_and_reopening_brings_the_tree_back() {
    let mut w = World::new();
    let win = w.open();
    let a = w.open_tab(&win, "a.com");
    let b = w.open_tab(&win, "b.com");
    let c = w.open_tab(&win, "c.com");
    let d = w.open_tab(&win, "d.com");
    let outer = w
        .act(Action::CreateGroup {
            tabs: vec![a, b.clone(), c.clone(), d],
            name: "Outer".into(),
        })
        .group
        .unwrap();
    let inner = w
        .act(Action::CreateGroup {
            tabs: vec![b, c],
            name: "Inner".into(),
        })
        .group
        .unwrap();
    assert_eq!(w.state.groups[&inner].parent_id.as_ref(), Some(&outer));
    w.act(Action::UpdateGroup {
        group: inner,
        patch: ardia_state::actions::GroupPatch {
            collapsed: Some(true),
            ..Default::default()
        },
    });
    w.act(Action::CloseGroup { group: outer });
    assert!(w.state.groups.is_empty());
    assert_eq!(w.state.closed.groups.last().unwrap().nested.len(), 1);
    w.act(Action::ReopenClosed {
        window: Some(win.clone()),
    });
    let root = w
        .state
        .groups
        .values()
        .find(|g| g.parent_id.is_none())
        .expect("a root");
    let child = w
        .state
        .groups
        .values()
        .find(|g| g.parent_id.is_some())
        .expect("a child");
    assert_eq!(child.parent_id.as_ref(), Some(&root.id));
    assert_eq!(
        (root.name.as_str(), child.name.as_str()),
        ("Outer", "Inner")
    );
    assert!(child.collapsed);
    assert_eq!(root.tab_ids.len(), 4);
    assert_eq!(child.tab_ids.len(), 2);
    check_invariants(&w.state);
}

#[test]
fn closing_a_group_that_fills_its_parent_closes_the_parent_too() {
    let mut w = World::new();
    let win = w.open();
    let _a = w.open_tab(&win, "a.com");
    let b = w.open_tab(&win, "b.com");
    let c = w.open_tab(&win, "c.com");
    w.act(Action::CreateGroup {
        tabs: vec![b.clone(), c.clone()],
        name: "Outer".into(),
    });
    let inner = w
        .act(Action::CreateGroup {
            tabs: vec![b, c],
            name: "Inner".into(),
        })
        .group
        .unwrap();
    w.act(Action::CloseGroup { group: inner });
    assert!(w.state.groups.is_empty(), "no empty Outer is left");
    let entry = w.state.closed.groups.last().unwrap();
    assert_eq!(entry.group.name, "Outer");
    w.act(Action::ReopenClosed { window: Some(win) });
    let root = w
        .state
        .groups
        .values()
        .find(|g| g.parent_id.is_none())
        .unwrap();
    let child = w
        .state
        .groups
        .values()
        .find(|g| g.parent_id.is_some())
        .unwrap();
    assert_eq!(
        (root.name.as_str(), child.name.as_str()),
        ("Outer", "Inner")
    );
    assert_eq!(child.tab_ids.len(), 2);
    check_invariants(&w.state);
}

#[test]
fn deleting_a_profile_forgets_everything_it_closed() {
    let mut w = World::new();
    let home = w.open();
    let work = w
        .act(Action::CreateProfile {
            name: "Work".into(),
            color: None,
            icon: None,
        })
        .profile
        .unwrap();
    let mixed = w.open();
    w.open_tab(&mixed, "personal.com");
    w.act(Action::SwitchProfile {
        window: mixed.clone(),
        profile: work.clone(),
    });
    let first = w.active(&mixed);
    w.act(Action::Navigate {
        tab: first,
        input: "work-one.com".into(),
    });
    let second = w.open_tab(&mixed, "work-two.com");
    w.act(Action::CreateGroup {
        tabs: vec![second],
        name: "W".into(),
    });
    w.act(Action::RecordVisit {
        profile: work.clone(),
        url: "https://work-one.com/".into(),
        title: "One".into(),
        favicon: None,
    });
    w.act(Action::CloseWindow { window: mixed });
    let closed = w.state.closed.windows.last().unwrap().clone();
    assert!(closed.tabs.iter().any(|t| t.snapshot.profile_id == work));
    w.act(Action::SwitchProfile {
        window: home.clone(),
        profile: work.clone(),
    });
    let gone = w.open_tab(&home, "gone.com");
    w.close(&[&gone]);
    w.act(Action::DeleteProfile {
        profile: work.clone(),
    });
    assert!(w.state.closed.tabs.iter().all(|c| c.tab.profile_id != work));
    let kept = w
        .state
        .closed
        .windows
        .last()
        .expect("the personal tabs stay reopenable");
    assert!(kept.tabs.iter().all(|t| t.snapshot.profile_id != work));
    assert!(
        kept.groups
            .iter()
            .all(|g| g.tab_indexes.iter().all(|i| *i < kept.tabs.len()))
    );
    assert!(
        w.state.history.is_empty(),
        "a deleted profile's history goes with it"
    );
    assert!(
        w.state
            .persisted
            .orphaned_profile_data
            .iter()
            .any(|e| e == work.as_str())
    );
    w.act(Action::ReopenClosed { window: None });
    assert!(
        w.state
            .tabs
            .values()
            .all(|t| t.profile_id != work && !t.url.contains("work-"))
    );
    check_invariants(&w.state);
}

#[test]
fn keeping_top_apps_running_switches_away_instead_of_unloading() {
    for keep in [true, false] {
        let mut w = World::new();
        let win = w.open();
        let app = w.open_tab(&win, "app.com");
        let other = w.open_tab(&win, "other.com");
        w.act(Action::SetPin {
            tab: app.clone(),
            pin: Some(TabPin::TILE),
        });
        w.act(Action::UpdatePage {
            tab: app.clone(),
            update: PageUpdate {
                url: Some("https://app.com/inbox".into()),
                ..PageUpdate::default()
            },
        });
        w.act(Action::UpdateSettings {
            patch: SettingsPatch::new().set("keepTopAppsRunning", keep),
            from_sync: false,
        });
        w.act(Action::ActivateTab { tab: app.clone() });
        let closed = w.state.closed.tabs.len();
        w.close(&[&app]);
        assert_eq!(w.active(&win), other, "the regular tab comes forward");
        assert_eq!(w.state.tabs[&app].page.kind == PageKind::Asleep, !keep);
        assert_eq!(w.state.closed.tabs.len(), closed + usize::from(!keep));
        check_invariants(&w.state);
    }
}

#[test]
fn a_peek_ends_with_its_source_page_but_survives_a_fragment_change() {
    let mut w = World::new();
    let win = w.open();
    let a = w.open_tab(&win, "a.com");
    let b = w.open_tab(&win, "b.com");
    w.act(Action::ActivateTab { tab: a.clone() });
    let peek = w
        .act(Action::OpenPeek {
            window: win.clone(),
            url: "peek.com".into(),
            source: None,
        })
        .tab
        .unwrap();
    assert!(w.state.shown_peek(win.as_str()).is_some());
    w.act(Action::ActivateTab { tab: b });
    assert!(
        w.state.shown_peek(win.as_str()).is_none(),
        "a peek shows with its own tab only"
    );
    w.act(Action::UpdatePage {
        tab: a.clone(),
        update: PageUpdate {
            url: Some("https://a.com#section".into()),
            ..PageUpdate::default()
        },
    });
    assert!(w.state.tabs.contains_key(&peek));
    w.act(Action::UpdatePage {
        tab: peek.clone(),
        update: PageUpdate {
            url: Some("https://peek.com/next".into()),
            ..PageUpdate::default()
        },
    });
    assert!(
        w.state.tabs.contains_key(&peek),
        "the peek may browse on its own"
    );
    w.act(Action::UpdatePage {
        tab: a.clone(),
        update: PageUpdate {
            url: Some("https://a.com/elsewhere".into()),
            ..PageUpdate::default()
        },
    });
    assert!(!w.state.tabs.contains_key(&peek));
    w.act(Action::ActivateTab { tab: a.clone() });
    let again = w
        .act(Action::OpenPeek {
            window: win.clone(),
            url: "peek.com".into(),
            source: None,
        })
        .tab
        .unwrap();
    w.close(&[&a]);
    assert!(!w.state.tabs.contains_key(&again));
    assert!(w.state.windows[&win].chrome.peek.is_none());
    assert!(matches!(
        w.try_act(Action::OpenPeek {
            window: win.clone(),
            url: "x.com".into(),
            source: Some(ardia_state::ids::TabId::new("tab-elsewhere")),
        }),
        Err(ActionError::Invalid(_))
    ));
    check_invariants(&w.state);
}

#[test]
fn the_last_window_reopens_from_the_dock_unless_launch_skips_restoring() {
    let mut w = World::new();
    let win = w.open();
    let only = w.active(&win);
    w.act(Action::Navigate {
        tab: only,
        input: "kept.com".into(),
    });
    w.act(Action::CloseWindow { window: win });
    assert!(w.state.closed.windows.last().unwrap().last_window);
    let mut skipped = w.state.to_session_value();
    skipped["settings"]["restoreSession"] = serde_json::json!(false);
    let (data, _) = ardia_state::persistence::session::session_from_doc(
        skipped.as_object().unwrap().clone(),
        ardia_state::persistence::session::LoadOptions::default(),
    );
    let mut fresh = World::from_state(ardia_state::state::BrowserState::from_session(data, w.now));
    assert!(fresh.state.closed.windows.iter().all(|c| !c.last_window));
    fresh.act(Action::OpenLastWindowOrNew);
    let opened = fresh.state.window_order[0].clone();
    assert_eq!(
        fresh.urls(&opened),
        [""],
        "a launch without restoring starts fresh"
    );
    w.act(Action::OpenLastWindowOrNew);
    let back = w.state.window_order[0].clone();
    assert_eq!(w.urls(&back), ["https://kept.com"]);
    let focused = w.act(Action::OpenLastWindowOrNew).window.unwrap();
    assert_eq!(focused, back, "with a window open it is just focused");
    check_invariants(&w.state);
}

#[test]
fn a_saved_group_cycle_neither_hangs_nor_survives_loading() {
    let mut w = World::new();
    let win = w.open();
    let a = w.open_tab(&win, "a.com");
    let b = w.open_tab(&win, "b.com");
    let one = w
        .act(Action::CreateGroup {
            tabs: vec![a.clone(), b.clone()],
            name: "One".into(),
        })
        .group
        .unwrap();
    let two = w
        .act(Action::CreateGroup {
            tabs: vec![a, b],
            name: "Two".into(),
        })
        .group
        .unwrap();
    let mut doc = w.state.to_session_value();
    for group in doc["groups"].as_array_mut().unwrap() {
        let parent = if group["id"] == serde_json::json!(one.as_str()) {
            two.as_str()
        } else {
            one.as_str()
        };
        group["parentId"] = serde_json::json!(parent);
    }
    let (data, _) = ardia_state::persistence::session::session_from_doc(
        doc.as_object().unwrap().clone(),
        ardia_state::persistence::session::LoadOptions::default(),
    );
    let mut looped = World::from_state(ardia_state::state::BrowserState::from_session(data, w.now));
    check_invariants(&looped.state);
    let any = looped.state.groups.keys().next().cloned().unwrap();
    looped.act(Action::CloseGroup { group: any });
    check_invariants(&looped.state);
}

#[test]
fn only_a_shown_page_holds_its_window_full_screen() {
    let mut w = World::new();
    let win = w.open();
    let video = w.open_tab(&win, "video.com");
    assert!(w.state.fullscreen_tab(win.as_str()).is_none());
    w.act(Action::UpdatePage {
        tab: video.clone(),
        update: PageUpdate {
            fullscreen: Some(true),
            ..PageUpdate::default()
        },
    });
    assert_eq!(
        w.state.fullscreen_tab(win.as_str()).map(|t| t.id.clone()),
        Some(video.clone())
    );
    let other = w.open_tab(&win, "other.com");
    assert_eq!(w.active(&win), other);
    assert!(w.state.fullscreen_tab(win.as_str()).is_none());
    w.act(Action::UpdatePage {
        tab: video.clone(),
        update: PageUpdate {
            fullscreen: Some(false),
            ..PageUpdate::default()
        },
    });
    assert!(!w.state.tabs[&video].live.fullscreen);
}

fn world_with_running_top_app(keep: bool) -> (World, WindowId, TabId) {
    let mut w = World::new();
    let win = w.open();
    let app = w.open_tab(&win, "app.com");
    w.act(Action::SetPin {
        tab: app.clone(),
        pin: Some(TabPin::TILE),
    });
    w.act(Action::UpdatePage {
        tab: app.clone(),
        update: PageUpdate {
            url: Some("https://app.com/inbox".into()),
            ..PageUpdate::default()
        },
    });
    w.act(Action::UpdateSettings {
        patch: SettingsPatch::new().set("keepTopAppsRunning", keep),
        from_sync: false,
    });
    (w, win, app)
}

fn blank_of(w: &World, win: &WindowId) -> TabId {
    w.order(win)
        .into_iter()
        .find(|t| w.state.tabs[t].url.is_empty())
        .unwrap()
}

#[test]
fn closing_a_tab_never_lands_on_a_kept_top_app() {
    for keep in [true, false] {
        let (mut w, win, app) = world_with_running_top_app(keep);
        let blank = blank_of(&w, &win);
        let page = w.open_tab(&win, "page.com");
        w.close(&[&blank]);
        w.act(Action::ActivateTab { tab: page.clone() });
        assert!(w.state.tabs[&app].page.has_page());
        w.close(&[&page]);
        let active = w.active(&win);
        if keep {
            assert_ne!(active, app, "a kept Top App is never the successor");
            assert_eq!(w.active_url(&win), "", "a fresh card comes forward instead");
        } else {
            assert_eq!(active, app);
        }
        check_invariants(&w.state);
    }
}

#[test]
fn closing_the_empty_card_beside_kept_top_apps_closes_the_window() {
    for keep in [true, false] {
        let (mut w, win, app) = world_with_running_top_app(keep);
        let blank = blank_of(&w, &win);
        w.act(Action::ActivateTab { tab: blank.clone() });
        w.act(Action::CloseTabs {
            tabs: vec![blank],
            last_closes_window: true,
        });
        assert_eq!(w.state.windows.contains_key(&win), !keep);
        if !keep {
            assert_eq!(w.active(&win), app);
        }
        check_invariants(&w.state);
    }
}

#[test]
fn closing_a_real_page_beside_kept_top_apps_keeps_the_window() {
    let (mut w, win, _) = world_with_running_top_app(true);
    let blank = blank_of(&w, &win);
    let page = w.open_tab(&win, "page.com");
    w.close(&[&blank]);
    w.act(Action::ActivateTab { tab: page.clone() });
    w.act(Action::CloseTabs {
        tabs: vec![page],
        last_closes_window: true,
    });
    assert!(w.state.windows.contains_key(&win));
    assert_eq!(w.active_url(&win), "");
    check_invariants(&w.state);
}

#[test]
fn unloading_a_kept_top_app_closes_its_page_even_with_top_apps_kept() {
    let (mut w, win, app) = world_with_running_top_app(true);
    let other = w.open_tab(&win, "other.com");
    w.act(Action::ActivateTab { tab: other.clone() });
    assert!(w.state.tabs[&app].page.has_page());
    let closed = w.state.closed.tabs.len();
    w.act(Action::UnloadTopApp { tab: app.clone() });
    assert_eq!(w.state.tabs[&app].page.kind, PageKind::Asleep);
    assert!(w.state.tabs[&app].is_pinned(), "the tile stays");
    assert_eq!(w.state.closed.tabs.len(), closed + 1);
    assert_eq!(w.active(&win), other);
    check_invariants(&w.state);
}

#[test]
fn forgetting_pages_leaves_loaded_tabs_idle_and_others_alone() {
    let mut w = World::new();
    let win = w.open();
    let loaded = w.open_tab(&win, "loaded.com");
    let asleep = w.open_tab(&win, "asleep.com");
    let shown = w.open_tab(&win, "shown.com");
    w.act(Action::SleepTabs {
        tabs: vec![asleep.clone()],
    });
    assert_eq!(w.state.tabs[&loaded].page.kind, PageKind::Loaded);
    w.act(Action::ForgetPages {
        tabs: vec![loaded.clone(), asleep.clone()],
    });
    assert_eq!(w.state.tabs[&loaded].page.kind, PageKind::Idle);
    assert_eq!(w.state.tabs[&asleep].page.kind, PageKind::Asleep);
    assert_eq!(w.active(&win), shown);
    check_invariants(&w.state);
}
