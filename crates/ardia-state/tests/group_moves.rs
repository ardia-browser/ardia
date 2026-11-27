mod common;

use ardia_state::actions::{Action, can_move_group};
use common::{World, check_invariants};

fn group_of(w: &World, name: &str) -> ardia_state::GroupId {
    w.state
        .groups
        .values()
        .find(|g| g.name == name)
        .map(|g| g.id.clone())
        .expect("the group")
}

#[test]
fn a_dragged_group_moves_as_one_block_before_a_tab() {
    let mut w = World::new();
    let win = w.open();
    let a = w.open_tab(&win, "a.com");
    let b = w.open_tab(&win, "b.com");
    let c = w.open_tab(&win, "c.com");
    let d = w.open_tab(&win, "d.com");
    w.act(Action::CreateGroup {
        tabs: vec![c.clone(), d.clone()],
        name: "Late".into(),
    });
    let late = group_of(&w, "Late");
    w.act(Action::MoveGroup {
        group: late.clone(),
        before: Some(a.clone()),
        pinned: false,
        parent: None,
    });
    let order = w.order(&win);
    let at = |t| order.iter().position(|id| id == t).unwrap();
    assert_eq!(at(&d), at(&c) + 1);
    assert_eq!(at(&a), at(&d) + 1);
    assert!(at(&b) > at(&a));
    assert_eq!(w.state.groups[&late].tab_ids, vec![c, d]);
    check_invariants(&w.state);
}

#[test]
fn a_group_dropped_into_another_nests_and_pins_with_it() {
    let mut w = World::new();
    let win = w.open();
    let a = w.open_tab(&win, "a.com");
    let b = w.open_tab(&win, "b.com");
    let c = w.open_tab(&win, "c.com");
    w.act(Action::CreateGroup {
        tabs: vec![a],
        name: "Outer".into(),
    });
    w.act(Action::CreateGroup {
        tabs: vec![b.clone(), c],
        name: "Inner".into(),
    });
    let outer = group_of(&w, "Outer");
    let inner = group_of(&w, "Inner");
    w.act(Action::UpdateGroup {
        group: outer.clone(),
        patch: ardia_state::GroupPatch {
            pinned: Some(true),
            ..Default::default()
        },
    });
    w.act(Action::MoveGroup {
        group: inner.clone(),
        before: None,
        pinned: false,
        parent: Some(outer.clone()),
    });
    let g = &w.state.groups[&inner];
    assert_eq!(g.parent_id.as_ref(), Some(&outer));
    assert!(g.pinned, "a nested group takes its parent's pin");
    assert!(w.state.groups[&outer].tab_ids.contains(&b));
    assert!(
        !can_move_group(&w.state.groups, &outer, None, Some(&inner)),
        "no loops"
    );
    assert!(
        w.try_act(Action::MoveGroup {
            group: inner.clone(),
            before: Some(b),
            pinned: false,
            parent: None
        })
        .is_err()
    );
    check_invariants(&w.state);
}
