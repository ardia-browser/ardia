mod common;

use ardia_state::actions::Action;
use ardia_state::model::TabPin;
use common::{World, check_invariants, reloaded};

fn folder_id(w: &World, tab: &ardia_state::TabId) -> Option<String> {
    match &w.state.tabs[tab].pin {
        Some(TabPin::Tile { folder }) => folder.as_ref().map(|f| f.id.clone()),
        _ => None,
    }
}

#[test]
fn holding_a_tab_on_a_tile_makes_an_unnamed_folder_of_both() {
    let mut w = World::new();
    let win = w.open();
    let tile = w.open_tab(&win, "a.com");
    let other = w.open_tab(&win, "b.com");
    let row = w.open_tab(&win, "c.com");
    w.act(Action::SetPin {
        tab: tile.clone(),
        pin: Some(TabPin::TILE),
    });
    w.act(Action::SetPin {
        tab: other.clone(),
        pin: Some(TabPin::TILE),
    });
    w.act(Action::AddToTileFolder {
        tabs: vec![row.clone()],
        onto: tile.clone(),
        before: None,
    });
    let made = folder_id(&w, &tile).expect("the tile holds a folder");
    assert_eq!(folder_id(&w, &row).as_deref(), Some(made.as_str()));
    assert_eq!(folder_id(&w, &other), None);
    match &w.state.tabs[&tile].pin {
        Some(TabPin::Tile { folder: Some(f) }) => assert!(f.name.is_empty()),
        pin => panic!("{pin:?}"),
    }
    assert_eq!(
        w.state.tabs[&row].pinned_url.as_deref(),
        Some("https://c.com")
    );
    let order = w.order(&win);
    let at = |t| order.iter().position(|id| id == t).unwrap();
    assert_eq!(
        at(&row),
        at(&tile) + 1,
        "joins right after the folder's last member"
    );
    check_invariants(&w.state);
    let back = reloaded(&w.state, 10_000);
    assert_eq!(
        match &back.tabs[&row].pin {
            Some(TabPin::Tile { folder }) => folder.as_ref().map(|f| f.id.clone()),
            _ => None,
        },
        Some(made)
    );
}

#[test]
fn dropping_onto_a_folder_joins_it_and_rows_cannot_hold_folders() {
    let mut w = World::new();
    let win = w.open();
    let tile = w.open_tab(&win, "a.com");
    let first = w.open_tab(&win, "b.com");
    let second = w.open_tab(&win, "c.com");
    w.act(Action::SetPin {
        tab: tile.clone(),
        pin: Some(TabPin::TILE),
    });
    w.act(Action::AddToTileFolder {
        tabs: vec![first.clone()],
        onto: tile.clone(),
        before: None,
    });
    let folder = folder_id(&w, &tile).expect("a folder");
    w.act(Action::AddToTileFolder {
        tabs: vec![second.clone()],
        onto: first.clone(),
        before: Some(first.clone()),
    });
    assert_eq!(folder_id(&w, &second).as_deref(), Some(folder.as_str()));
    let order = w.order(&win);
    let at = |t| order.iter().position(|id| id == t).unwrap();
    assert_eq!(at(&second) + 1, at(&first), "lands before the asked member");
    let plain = w.open_tab(&win, "d.com");
    let loose = w.open_tab(&win, "e.com");
    assert!(
        w.try_act(Action::AddToTileFolder {
            tabs: vec![loose],
            onto: plain,
            before: None
        })
        .is_err()
    );
    check_invariants(&w.state);
}
