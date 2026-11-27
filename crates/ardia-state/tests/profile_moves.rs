mod common;

use ardia_state::actions::Action;
use common::{World, check_invariants};

#[test]
fn a_tab_moved_to_another_profile_keeps_its_page_and_lands_in_that_profile() {
    let mut w = World::new();
    let win = w.open();
    let tab = w.open_tab(&win, "https://a.test/");
    let home = w.default_profile();
    let work = w
        .act(Action::CreateProfile {
            name: "Work".into(),
            color: None,
            icon: None,
        })
        .profile
        .expect("a profile");
    w.act(Action::MoveTabsToProfile {
        tabs: vec![tab.clone()],
        profile: work.clone(),
        before: None,
        background: false,
    });
    assert!(!w.state.tabs.contains_key(&tab));
    let moved = w
        .state
        .tabs
        .values()
        .filter(|t| t.profile_id == work && t.url == "https://a.test/")
        .count();
    assert_eq!(moved, 1);
    assert_eq!(w.state.windows[&win].profile_id, work);
    assert!(
        !w.state
            .tabs
            .values()
            .any(|t| t.profile_id == home && t.url == "https://a.test/")
    );
    check_invariants(&w.state);
}

#[test]
fn moving_into_the_same_profile_changes_nothing() {
    let mut w = World::new();
    let win = w.open();
    let tab = w.open_tab(&win, "https://a.test/");
    let home = w.default_profile();
    w.act(Action::MoveTabsToProfile {
        tabs: vec![tab.clone()],
        profile: home,
        before: None,
        background: false,
    });
    assert!(w.state.tabs.contains_key(&tab));
}
