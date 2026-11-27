mod common;

use ardia_state::actions::Action;
use ardia_state::model::TabPin;
use ardia_state::settings::SettingsPatch;
use common::World;

fn cmd_click_groups(w: &mut World) {
    w.act(Action::UpdateSettings {
        patch: SettingsPatch::new().set("cmdClickCreatesTabGroup", true),
        from_sync: false,
    });
}

#[test]
fn a_background_link_groups_with_its_opener_only_when_asked() {
    let mut w = World::new();
    let window = w.open();
    let opener = w.open_tab(&window, "https://a.example");
    let plain = w.open_child(&window, &opener, "https://b.example", true);
    assert!(w.state.group_of(plain.as_str()).is_none());
    cmd_click_groups(&mut w);
    let grouped = w.open_child(&window, &opener, "https://c.example", true);
    let group = w.state.group_of(grouped.as_str()).expect("grouped").clone();
    assert!(group.tab_ids.contains(&opener));
    assert!(group.auto_ungroup);
    let loner = w.open_tab(&window, "https://e.example");
    let foreground = w.open_child(&window, &loner, "https://d.example", false);
    assert!(
        w.state.group_of(foreground.as_str()).is_none(),
        "a link opened in front never starts a group"
    );
}

#[test]
fn a_link_from_a_grouped_tab_joins_its_group_even_in_front() {
    let mut w = World::new();
    let window = w.open();
    let opener = w.open_tab(&window, "https://a.example");
    let sibling = w.open_tab(&window, "https://b.example");
    let group = w
        .act(Action::CreateGroup {
            tabs: vec![opener.clone(), sibling],
            name: "Work".into(),
        })
        .group
        .expect("group");
    let child = w.open_child(&window, &opener, "https://c.example", false);
    assert_eq!(
        w.state.group_of(child.as_str()).map(|g| g.id.clone()),
        Some(group)
    );
}

#[test]
fn a_pinned_opener_gathers_its_background_links_into_one_group() {
    let mut w = World::new();
    let window = w.open();
    let pinned = w.open_tab(&window, "https://mail.example");
    w.act(Action::SetPin {
        tab: pinned.clone(),
        pin: Some(TabPin::Row),
    });
    let ignored = w.open_child(&window, &pinned, "https://a.example", true);
    assert!(w.state.group_of(ignored.as_str()).is_none());
    cmd_click_groups(&mut w);
    let first = w.open_child(&window, &pinned, "https://b.example", true);
    let gathered = w.state.group_of(first.as_str()).expect("gathered").clone();
    assert_eq!(gathered.pinned_opener_id.as_ref(), Some(&pinned));
    assert!(!gathered.tab_ids.contains(&pinned));
    let second = w.open_child(&window, &pinned, "https://c.example", false);
    assert_eq!(
        w.state.group_of(second.as_str()).map(|g| g.id.clone()),
        Some(gathered.id.clone())
    );
}
