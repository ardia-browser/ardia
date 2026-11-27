mod common;

use ardia_state::actions::{Action, ActionError, PageUpdate};
use ardia_state::ids::TabId;
use ardia_state::model::TabPin;
use common::{World, check_invariants, reloaded};

fn go(w: &mut World, tab: &TabId, url: &str) {
    w.act(Action::UpdatePage {
        tab: tab.clone(),
        update: PageUpdate {
            url: Some(url.into()),
            ..PageUpdate::default()
        },
    });
}

fn tile(w: &mut World, tab: &TabId) {
    w.act(Action::SetPin {
        tab: tab.clone(),
        pin: Some(TabPin::TILE),
    });
}

#[test]
fn replace_pin_takes_the_current_page_and_back_to_pinned_returns_to_it() {
    let mut w = World::new();
    let win = w.open();
    let a = w.open_tab(&win, "a.com");
    tile(&mut w, &a);
    go(&mut w, &a, "https://a.com/login");
    w.act(Action::SetPinnedUrl {
        tab: a.clone(),
        url: None,
    });
    assert_eq!(
        w.state.tabs[&a].pinned_url.as_deref(),
        Some("https://a.com/login")
    );
    go(&mut w, &a, "https://a.com/elsewhere");
    w.act(Action::ReturnToPinnedUrl { tab: a.clone() });
    assert_eq!(w.state.tabs[&a].url, "https://a.com/login");
    check_invariants(&w.state);
}

#[test]
fn editing_the_pinned_url_saves_it_and_goes_there_unless_it_is_the_same_page() {
    let mut w = World::new();
    let win = w.open();
    let a = w.open_tab(&win, "a.com");
    tile(&mut w, &a);
    w.act(Action::SetPinnedUrl {
        tab: a.clone(),
        url: Some("https://b.com/home".into()),
    });
    assert_eq!(
        w.state.tabs[&a].pinned_url.as_deref(),
        Some("https://b.com/home")
    );
    assert_eq!(w.state.tabs[&a].url, "https://b.com/home");
    go(&mut w, &a, "https://b.com/home#top");
    w.act(Action::SetPinnedUrl {
        tab: a.clone(),
        url: Some("https://b.com/home/".into()),
    });
    assert_eq!(
        w.state.tabs[&a].url, "https://b.com/home#top",
        "the same page isn't loaded again"
    );
    let again = reloaded(&w.state, w.now);
    assert_eq!(
        again.tabs[&a].pinned_url.as_deref(),
        Some("https://b.com/home/")
    );
}

#[test]
fn an_unpinned_tab_has_no_pinned_url_to_set() {
    let mut w = World::new();
    let win = w.open();
    let a = w.open_tab(&win, "a.com");
    assert!(matches!(
        w.try_act(Action::SetPinnedUrl {
            tab: a.clone(),
            url: None
        }),
        Err(ActionError::Invalid(_))
    ));
    assert_eq!(w.state.tabs[&a].pinned_url, None);
}

#[test]
fn a_tile_leaves_its_folder_after_the_last_member_and_folders_rename() {
    let mut w = World::new();
    let win = w.open();
    let a = w.open_tab(&win, "a.com");
    let b = w.open_tab(&win, "b.com");
    let c = w.open_tab(&win, "c.com");
    for t in [&a, &b, &c] {
        tile(&mut w, t);
    }
    w.act(Action::AddToTileFolder {
        tabs: vec![b.clone()],
        onto: a.clone(),
        before: None,
    });
    let folder = w.state.tabs[&a]
        .pin
        .as_ref()
        .and_then(TabPin::folder)
        .cloned()
        .unwrap();
    w.act(Action::RenameTileFolder {
        window: win.clone(),
        folder: folder.id,
        name: "  Work ".into(),
    });
    for t in [&a, &b] {
        let f = w.state.tabs[t]
            .pin
            .as_ref()
            .and_then(TabPin::folder)
            .unwrap();
        assert_eq!(f.name, "Work");
        assert!(f.renamed_at.is_some());
    }
    w.act(Action::LeaveTileFolder {
        tabs: vec![a.clone()],
    });
    assert!(
        w.state.tabs[&a]
            .pin
            .as_ref()
            .is_some_and(|p| p.is_tile() && p.folder().is_none())
    );
    assert!(
        w.state.tabs[&b]
            .pin
            .as_ref()
            .and_then(TabPin::folder)
            .is_some()
    );
    let order = w.order(&win);
    let at = |t: &TabId| order.iter().position(|x| x == t).unwrap();
    assert_eq!(
        at(&a),
        at(&b) + 1,
        "it lands right after the folder's last member"
    );
    assert!(at(&a) < at(&c));
    check_invariants(&w.state);
}
