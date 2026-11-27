mod common;

use ardia_state::actions::Action;
use ardia_state::settings::SettingsPatch;
use common::World;

fn set(world: &mut World, key: &str, value: impl serde::Serialize) {
    world.act(Action::UpdateSettings {
        patch: SettingsPatch::new().set(key, value),
        from_sync: false,
    });
}

#[test]
fn empty_cards_hide_only_when_new_tab_opens_the_command_bar() {
    let mut world = World::new();
    let window = world.open();
    let page = world.open_tab(&window, "https://a.test/");
    let card = world.open_tab(&window, "");
    let shown = |w: &World| {
        let tab = w.state.tab(card.as_str()).expect("the card").clone();
        (
            w.state.is_empty_card_tab(&tab),
            w.state.hidden_empty_card(&tab),
        )
    };
    set(&mut world, "newTabOpens", "page");
    set(&mut world, "minimalismMode", false);
    assert_eq!(shown(&world), (true, false));
    set(&mut world, "newTabOpens", "commandBar");
    assert_eq!(shown(&world), (true, true));
    set(&mut world, "newTabOpens", "page");
    set(&mut world, "minimalismMode", true);
    assert_eq!(shown(&world), (true, true));
    let tab = world.state.tab(page.as_str()).expect("the page").clone();
    assert!(!world.state.hidden_empty_card(&tab));
}

#[test]
fn closing_never_lands_on_a_hidden_empty_card_and_numbers_skip_it() {
    let mut world = World::new();
    let window = world.open();
    set(&mut world, "newTabOpens", "commandBar");
    set(&mut world, "afterClosingTab", "tabBelow");
    let first = world.open_tab(&window, "https://a.test/");
    let card = world.open_tab(&window, "");
    let last = world.open_tab(&window, "https://c.test/");
    world.act(Action::ActivateTab { tab: first.clone() });
    world.close(&[&first]);
    assert_eq!(world.active(&window), last);
    world.act(Action::SelectTabAt {
        window: window.clone(),
        index: Some(0),
    });
    assert_ne!(world.active(&window), card);
}
