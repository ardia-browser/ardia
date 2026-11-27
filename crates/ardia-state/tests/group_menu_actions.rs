mod common;

use ardia_state::actions::Action;
use common::{World, check_invariants};

fn grouped(w: &mut World) -> (ardia_state::WindowId, ardia_state::GroupId) {
    let win = w.open();
    let a = w.open_tab(&win, "a.com");
    let b = w.open_tab(&win, "b.com");
    w.act(Action::CreateGroup {
        tabs: vec![a, b],
        name: "Reading".into(),
    });
    let group = w.state.groups.keys().next().cloned().expect("a group");
    (win, group)
}

#[test]
fn deleting_a_group_files_it_under_recently_deleted() {
    let mut w = World::new();
    let (_, group) = grouped(&mut w);
    w.act(Action::DeleteGroup { group });
    assert!(w.state.groups.is_empty());
    assert!(w.state.closed.groups.is_empty());
    assert_eq!(w.state.closed.deleted_groups.len(), 1);
    check_invariants(&w.state);
}

#[test]
fn duplicating_a_group_copies_its_tabs_and_look() {
    let mut w = World::new();
    let (win, group) = grouped(&mut w);
    w.act(Action::UpdateGroup {
        group: group.clone(),
        patch: ardia_state::GroupPatch {
            color: Some(Some(ardia_state::groups::GroupColor::Blue)),
            ..Default::default()
        },
    });
    w.act(Action::DuplicateGroup {
        group: group.clone(),
    });
    assert_eq!(w.state.groups.len(), 2);
    let copy = w
        .state
        .groups
        .values()
        .find(|g| g.id != group)
        .expect("a copy");
    assert_eq!(copy.name, "Reading");
    assert_eq!(copy.color, Some(ardia_state::groups::GroupColor::Blue));
    assert_eq!(copy.tab_ids.len(), 2);
    assert_eq!(
        w.urls(&win),
        [
            "",
            "https://a.com",
            "https://b.com",
            "https://a.com",
            "https://b.com"
        ]
    );
    check_invariants(&w.state);
}

#[test]
fn a_nested_group_opens_one_new_tab_inside_its_parent() {
    let mut w = World::new();
    let (win, group) = grouped(&mut w);
    w.act(Action::NewNestedGroup {
        parent: group.clone(),
    });
    let child = w
        .state
        .groups
        .values()
        .find(|g| g.id != group)
        .expect("a nested group");
    assert_eq!(child.parent_id.as_ref(), Some(&group));
    assert_eq!(child.tab_ids.len(), 1);
    assert!(w.state.groups[&group].tab_ids.contains(&child.tab_ids[0]));
    assert_eq!(w.active(&win), child.tab_ids[0]);
    check_invariants(&w.state);
}

#[test]
fn duplicating_a_group_rebuilds_its_nested_groups() {
    let mut w = World::new();
    let (_, group) = grouped(&mut w);
    w.act(Action::NewNestedGroup {
        parent: group.clone(),
    });
    let child = w
        .state
        .groups
        .values()
        .find(|g| g.parent_id.as_ref() == Some(&group))
        .map(|g| g.id.clone())
        .expect("a child");
    w.act(Action::UpdateGroup {
        group: child,
        patch: ardia_state::GroupPatch {
            name: Some("Inner".into()),
            ..Default::default()
        },
    });
    w.act(Action::DuplicateGroup {
        group: group.clone(),
    });
    assert_eq!(w.state.groups.len(), 4);
    let copy = w
        .state
        .groups
        .values()
        .find(|g| g.id != group && g.parent_id.is_none())
        .expect("a copy");
    let inner = w
        .state
        .groups
        .values()
        .find(|g| g.parent_id.as_ref() == Some(&copy.id))
        .expect("a copied child");
    assert_eq!(inner.name, "Inner");
    assert_eq!(inner.tab_ids.len(), 1);
    assert!(copy.tab_ids.contains(&inner.tab_ids[0]));
    check_invariants(&w.state);
}

#[test]
fn moving_a_group_to_another_window_keeps_it_together() {
    let mut w = World::new();
    let (_, group) = grouped(&mut w);
    let other = w.open();
    w.act(Action::MoveGroupToWindow {
        group: group.clone(),
        window: other.clone(),
    });
    let moved = &w.state.groups[&group];
    assert_eq!(moved.window_id, other);
    assert_eq!(moved.tab_ids.len(), 2);
    assert!(
        moved
            .tab_ids
            .iter()
            .all(|t| w.state.tabs[t].window_id == other)
    );
    check_invariants(&w.state);
}
