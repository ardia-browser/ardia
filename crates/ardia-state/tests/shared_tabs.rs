mod common;

use ardia_state::actions::Action;
use ardia_state::model::PageKind;
use ardia_state::settings::SettingsPatch;
use ardia_state::tab_share::{open_tabs_by_use, shared_view, tabs_handed_over};
use ardia_state::windows::WindowKind;
use ardia_state::{TabId, WindowId};
use common::{World, check_invariants};

fn share(w: &mut World, on: bool) {
    w.act(Action::UpdateSettings {
        patch: SettingsPatch::new().set("shareTabsAcrossWindows", on),
        from_sync: false,
    });
}

fn listed(w: &World, win: &WindowId) -> Vec<String> {
    w.order(win)
        .iter()
        .map(|id| &w.state.tabs[id])
        .filter(|t| t.pin.is_none() && !t.url.is_empty())
        .map(|t| t.url.clone())
        .collect()
}

fn copy_of(w: &World, win: &WindowId, url: &str) -> Option<TabId> {
    w.order(win)
        .into_iter()
        .find(|id| w.state.tabs[id].url == url)
}

#[test]
fn a_tab_opened_in_one_window_is_listed_in_every_window() {
    let mut w = World::new();
    let a = w.open();
    let b = w.open();
    share(&mut w, true);
    let page = w.open_tab(&a, "page.com");
    assert_eq!(listed(&w, &b), ["https://page.com"]);
    let copy = copy_of(&w, &b, "https://page.com").unwrap();
    assert_ne!(copy, page);
    assert_eq!(
        w.state.tabs[&copy].page.kind,
        PageKind::Frozen {
            holder: page.clone()
        },
        "the copy shows the page the other window holds"
    );
    assert_eq!(w.state.tabs[&copy].pin_key(), page.as_str());
    w.close(&[&page]);
    assert!(listed(&w, &b).is_empty(), "closing it closes it everywhere");
    check_invariants(&w.state);
}

#[test]
fn without_sharing_each_window_keeps_its_own_tabs() {
    let mut w = World::new();
    let a = w.open();
    let b = w.open();
    w.open_tab(&a, "page.com");
    assert!(listed(&w, &b).is_empty());
    check_invariants(&w.state);
}

#[test]
fn turning_sharing_on_merges_the_lists_and_off_keeps_one_of_each() {
    let mut w = World::new();
    let a = w.open();
    let b = w.open();
    w.open_tab(&a, "one.com");
    w.open_tab(&b, "two.com");
    share(&mut w, true);
    assert_eq!(listed(&w, &a), ["https://one.com", "https://two.com"]);
    assert_eq!(listed(&w, &b), ["https://one.com", "https://two.com"]);
    share(&mut w, false);
    let total = listed(&w, &a).len() + listed(&w, &b).len();
    assert_eq!(total, 2, "each shared tab survives once");
    assert!(
        w.state
            .tabs
            .values()
            .all(|t| t.pin_key.is_none() && !matches!(t.page.kind, PageKind::Frozen { .. }))
    );
    check_invariants(&w.state);
}

#[test]
fn closing_a_window_hands_its_tabs_to_the_next_window() {
    for on in [true, false] {
        let mut w = World::new();
        let a = w.open();
        let page = w.open_tab(&a, "page.com");
        let work = w
            .act(Action::CreateProfile {
                name: "Work".into(),
                color: None,
                icon: None,
            })
            .profile
            .unwrap();
        let b = w
            .act(Action::OpenWindow {
                kind: WindowKind::Main,
                profile: Some(work),
                url: None,
                frame: None,
            })
            .window
            .unwrap();
        share(&mut w, on);
        assert_eq!(tabs_handed_over(&w.state, &a).len(), usize::from(on));
        w.act(Action::CloseWindow { window: a.clone() });
        assert!(!w.state.windows.contains_key(&a));
        assert_eq!(
            w.state.tabs.get(&page).map(|t| t.window_id.clone()),
            on.then(|| b.clone()),
            "the heir window takes the tab only when tabs are shared"
        );
        check_invariants(&w.state);
    }
}

#[test]
fn search_and_start_rows_list_a_shared_tab_once() {
    let mut w = World::new();
    let a = w.open();
    let b = w.open();
    share(&mut w, true);
    let page = w.open_tab(&a, "page.com");
    let profile = w.state.windows[&b].profile_id.clone();
    let rows: Vec<String> = open_tabs_by_use(&w.state, &profile, &b)
        .into_iter()
        .filter(|(t, _)| !t.url.is_empty())
        .map(|(t, _)| t.url.clone())
        .collect();
    assert_eq!(rows, ["https://page.com"]);
    let view = shared_view(&w.state, &b).unwrap();
    let copy = copy_of(&w, &b, "https://page.com").unwrap();
    assert!(view.elsewhere(&w.state.tabs[&page]));
    assert!(!view.elsewhere(&w.state.tabs[&copy]));
    assert_eq!(
        view.last_used(&w.state.tabs[&copy]),
        w.state.tabs[&page]
            .last_active_at
            .max(w.state.tabs[&copy].last_active_at)
    );
}

#[test]
fn splitting_a_shared_copy_pulls_the_live_page_into_the_split() {
    let mut w = World::new();
    let a = w.open();
    let b = w.open();
    share(&mut w, true);
    let page = w.open_tab(&a, "page.com");
    let other = w.open_tab(&b, "other.com");
    let copy = copy_of(&w, &b, "https://page.com").unwrap();
    assert!(w.state.tabs[&page].page.has_page());
    let split = w
        .act(Action::SplitTabs {
            tabs: vec![copy.clone(), other],
            orientation: ardia_state::model::Orientation::Horizontal,
        })
        .split
        .unwrap();
    let panes = w.state.splits[&split].tab_ids();
    assert!(panes.contains(&page), "{panes:?}");
    assert!(!panes.contains(&copy));
    assert!(!w.state.tabs.contains_key(&copy), "the copy is gone");
    assert_eq!(w.state.tabs[&page].window_id, b);
    assert!(w.state.tabs[&page].page.has_page());
    check_invariants(&w.state);
}
