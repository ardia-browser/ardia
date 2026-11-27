mod common;

use ardia_state::actions::Action;
use ardia_state::ids::{ProfileId, WindowId};
use ardia_state::windows::WindowKind;
use common::{World, check_invariants, reloaded};

fn open_in(w: &mut World, kind: WindowKind, profile: Option<ProfileId>) -> WindowId {
    w.act(Action::OpenWindow {
        kind,
        profile,
        url: Some("https://start.example/".into()),
        frame: None,
    })
    .window
    .expect("a window")
}

fn close_three(w: &mut World, window: &WindowId, prefix: &str) {
    for name in ["a", "b", "c"] {
        let tab = w.open_tab(window, &format!("{prefix}{name}.example"));
        w.close(&[&tab]);
    }
}

fn closed_for(w: &World, profile: &ProfileId) -> usize {
    w.state
        .closed
        .tabs
        .iter()
        .filter(|c| &c.tab.profile_id == profile)
        .count()
}

fn work_profile(w: &mut World) -> ProfileId {
    w.act(Action::CreateProfile {
        name: "Work".into(),
        color: None,
        icon: None,
    })
    .profile
    .expect("a profile")
}

#[test]
fn clearing_empties_the_windows_profile_list_saves_it_and_leaves_other_profiles() {
    let mut w = World::new();
    let home = w.open();
    let work = work_profile(&mut w);
    let other = open_in(&mut w, WindowKind::Main, Some(work.clone()));
    close_three(&mut w, &home, "home-");
    close_three(&mut w, &other, "work-");
    let home_profile = w.default_profile();
    assert_eq!(closed_for(&w, &home_profile), 3);
    let outcome = w.act(Action::ClearRecentlyClosed {
        window: Some(home.clone()),
    });
    assert!(outcome.changes.persists_session());
    assert_eq!(closed_for(&w, &home_profile), 0);
    assert_eq!(closed_for(&w, &work), 3);
    assert!(
        w.try_act(Action::ReopenClosed {
            window: Some(home.clone())
        })
        .is_err(),
        "⇧⌘T reopens nothing in the cleared profile"
    );
    let again = reloaded(&w.state, w.now);
    assert_eq!(again.closed.tabs.len(), w.state.closed.tabs.len());
    let quiet = w.act(Action::ClearRecentlyClosed {
        window: Some(home.clone()),
    });
    assert!(
        !quiet.changes.persists_session(),
        "an empty list changes nothing"
    );
    check_invariants(&w.state);
}

#[test]
fn a_private_window_clears_nothing() {
    let mut w = World::new();
    let home = w.open();
    close_three(&mut w, &home, "p-home-");
    let secret = open_in(&mut w, WindowKind::Incognito, None);
    let tab = w.open_tab(&secret, "secret-closed.example");
    w.close(&[&tab]);
    let before = w.state.closed.tabs.len();
    w.act(Action::ClearRecentlyClosed {
        window: Some(secret.clone()),
    });
    assert_eq!(w.state.closed.tabs.len(), before);
}

#[test]
fn little_ardia_clears_its_own_profiles_list_only() {
    let mut w = World::new();
    let main = w.open();
    let work = work_profile(&mut w);
    let little = open_in(&mut w, WindowKind::LittleArdia, Some(work.clone()));
    close_three(&mut w, &main, "l-main-");
    let work_window = open_in(&mut w, WindowKind::Main, Some(work.clone()));
    close_three(&mut w, &work_window, "l-work-");
    w.act(Action::CloseWindow {
        window: work_window.clone(),
    });
    let main_before = closed_for(&w, &w.default_profile());
    w.act(Action::ClearRecentlyClosed {
        window: Some(little),
    });
    assert_eq!(closed_for(&w, &work), 0);
    assert!(
        w.state
            .closed
            .windows
            .iter()
            .all(|c| c.window.profile_id.as_ref() != Some(&work))
    );
    assert_eq!(closed_for(&w, &w.default_profile()), main_before);
}

#[test]
fn with_no_window_open_the_window_the_dock_brings_back_is_kept() {
    let mut w = World::new();
    let last = w.open();
    let tab = w.open_tab(&last, "kept-closed.example");
    w.close(&[&tab]);
    w.act(Action::CloseWindow {
        window: last.clone(),
    });
    let kept = w
        .state
        .closed
        .windows
        .last()
        .map(|c| (c.id.clone(), c.last_window));
    let before = (w.state.closed.tabs.len(), w.state.closed.windows.len());
    w.act(Action::ClearRecentlyClosed { window: None });
    assert_eq!(
        (w.state.closed.tabs.len(), w.state.closed.windows.len()),
        before,
        "with no window there is nothing to clear"
    );
    assert_eq!(
        w.state
            .closed
            .windows
            .last()
            .map(|c| (c.id.clone(), c.last_window)),
        kept
    );
}
