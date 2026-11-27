use std::time::Duration;

use ardia_state::TabId;
use gpui::{Modifiers, MouseButton, TestAppContext, VisualTestContext, point, px};

use super::support::Browser;

fn selector(prefix: &str, tab: &TabId) -> &'static str {
    Box::leak(format!("{prefix}:{}", tab.as_str()).into_boxed_str())
}

fn order(browser: &Browser) -> Vec<TabId> {
    browser
        .state()
        .window(browser.window.as_str())
        .map(|w| w.tab_ids.clone())
        .unwrap_or_default()
}

#[gpui::test]
fn the_close_button_on_a_hovered_row_closes_it(cx: &mut TestAppContext) {
    let browser = Browser::open(cx);
    let tab = browser.new_tab(cx, "https://example.org/");
    browser.settle_rows(cx);
    let before = browser.tab_count();
    let row = browser
        .bounds(cx, selector("tab-row", &tab))
        .expect("the row");
    let close = point(row.right() - px(6. + 11.), row.center().y);
    let mut visual = VisualTestContext::from_window(browser.handle.into(), cx);
    visual.simulate_mouse_move(close, None, Modifiers::none());
    visual.run_until_parked();
    visual.simulate_click(close, Modifiers::none());
    visual.run_until_parked();
    assert_eq!(browser.tab_count(), before - 1);
}

#[gpui::test]
fn the_hover_card_waits_for_the_pointer_to_rest(cx: &mut TestAppContext) {
    let browser = Browser::open(cx);
    let first = browser.new_tab(cx, "https://example.org/");
    let second = browser.new_tab(cx, "https://example.net/");
    let row = browser
        .bounds(cx, selector("tab-row", &first))
        .expect("the row");
    let other = browser
        .bounds(cx, selector("tab-row", &second))
        .expect("the row");
    let mut visual = VisualTestContext::from_window(browser.handle.into(), cx);
    visual.simulate_mouse_move(row.center(), None, Modifiers::none());
    visual.run_until_parked();
    visual.simulate_mouse_move(
        row.center() + point(px(2.), px(0.)),
        None,
        Modifiers::none(),
    );
    visual.executor().advance_clock(Duration::from_millis(500));
    visual.run_until_parked();
    assert!(visual.debug_bounds("tab-hover-card").is_none());
    visual.executor().advance_clock(Duration::from_millis(400));
    visual.run_until_parked();
    let card = visual.debug_bounds("tab-hover-card").expect("the card");
    assert!(card.origin.x >= row.right());
    visual.simulate_mouse_move(other.center(), None, Modifiers::none());
    visual.executor().advance_clock(Duration::from_millis(200));
    visual.run_until_parked();
    assert!(visual.debug_bounds("tab-hover-card").is_none());
}

#[gpui::test]
fn double_clicking_a_row_starts_renaming_it(cx: &mut TestAppContext) {
    let browser = Browser::open(cx);
    let tab = browser.new_tab(cx, "https://example.org/");
    let row = browser
        .bounds(cx, selector("tab-row", &tab))
        .expect("the row");
    let mut visual = VisualTestContext::from_window(browser.handle.into(), cx);
    visual.simulate_event(gpui::MouseDownEvent {
        button: MouseButton::Left,
        position: row.center(),
        modifiers: Modifiers::none(),
        click_count: 2,
        first_mouse: false,
    });
    visual.run_until_parked();
    assert!(visual.debug_bounds("rename-input").is_some());
}

#[gpui::test]
fn dragging_a_row_below_another_reorders_them(cx: &mut TestAppContext) {
    let browser = Browser::open(cx);
    let a = browser.new_tab(cx, "https://a.test/");
    let b = browser.new_tab(cx, "https://b.test/");
    let c = browser.new_tab(cx, "https://c.test/");
    let from = browser.bounds(cx, selector("tab-row", &a)).expect("row a");
    let onto = browser.bounds(cx, selector("tab-row", &c)).expect("row c");
    let mut visual = VisualTestContext::from_window(browser.handle.into(), cx);
    visual.simulate_mouse_down(from.center(), MouseButton::Left, Modifiers::none());
    visual.simulate_mouse_move(
        from.center() + point(px(0.), px(12.)),
        MouseButton::Left,
        Modifiers::none(),
    );
    visual.run_until_parked();
    let target = onto.center() + point(px(0.), px(8.));
    visual.simulate_mouse_move(target, MouseButton::Left, Modifiers::none());
    visual.run_until_parked();
    visual.simulate_mouse_move(target, MouseButton::Left, Modifiers::none());
    visual.run_until_parked();
    visual.simulate_mouse_up(target, MouseButton::Left, Modifiers::none());
    visual.run_until_parked();
    let order = order(&browser);
    let at = |t: &TabId| order.iter().position(|x| x == t).expect("listed");
    assert!(at(&b) < at(&a), "{order:?}");
    assert!(at(&c) < at(&a), "{order:?}");
}

#[gpui::test]
fn tile_letters_typed_in_the_panel_are_saved_cleaned(cx: &mut TestAppContext) {
    let browser = Browser::open(cx);
    let tab = browser.new_tab(cx, "https://github.com/");
    browser.act(
        cx,
        ardia_state::Action::SetPin {
            tab: tab.clone(),
            pin: Some(ardia_state::model::TabPin::TILE),
        },
    );
    browser
        .handle
        .update(cx, |view, window, cx| {
            view.handle(crate::msg::Msg::TileLetters(Some(tab.clone())), window, cx)
        })
        .expect("open");
    cx.run_until_parked();
    assert!(browser.bounds(cx, "tile-letters").is_some());
    browser.typed(cx, "gh x");
    browser.keys(cx, "enter");
    let letters = browser
        .state()
        .tab(tab.as_str())
        .and_then(|t| t.tile_letters.clone());
    assert_eq!(letters.as_deref(), Some("GH"));
    assert!(browser.bounds(cx, "tile-letters").is_none());
}

#[gpui::test]
fn a_selected_colourful_tile_asks_for_its_blurred_backdrop(cx: &mut TestAppContext) {
    let browser = Browser::open(cx);
    let colourful = browser.new_tab(cx, "https://www.google.com/");
    let plain = browser.new_tab(cx, "https://github.com/");
    for tab in [&colourful, &plain] {
        browser.act(
            cx,
            ardia_state::Action::SetPin {
                tab: tab.clone(),
                pin: Some(ardia_state::model::TabPin::TILE),
            },
        );
    }
    browser.host.set_icon_theme(
        colourful.clone(),
        ardia_theme::IconTheme::Blur {
            mean: ardia_theme::RgbaColor::new(0.4, 0.5, 0.6, 1.0),
            spread: 0.2,
        },
    );
    browser.host.set_icon_theme(
        plain.clone(),
        ardia_theme::IconTheme::Template {
            mean: ardia_theme::RgbaColor::new(0.1, 0.1, 0.1, 1.0),
            spread: 0.01,
        },
    );
    browser.act(cx, ardia_state::Action::ActivateTab { tab: plain });
    assert!(browser.host.pinned_backdrop_asks().is_empty());
    browser.act(cx, ardia_state::Action::ActivateTab { tab: colourful });
    let asks = browser.host.pinned_backdrop_asks();
    let (_, look) = asks.last().expect("asked for the backdrop");
    assert_eq!(
        look.height,
        ardia_theme::layout::sidebar::PINNED_TILE_HEIGHT
    );
    assert_eq!(
        look.radius,
        ardia_theme::layout::sidebar::PINNED_TILE_RADIUS
    );
    assert!(look.width > 0.0);
}

#[gpui::test]
fn a_tab_with_a_peek_open_shows_the_peeked_page_badge(cx: &mut TestAppContext) {
    let browser = Browser::open(cx);
    let source = browser.active();
    let mark: &'static str = Box::leak(format!("peek-mark:{}", source.as_str()).into_boxed_str());
    assert!(browser.bounds(cx, mark).is_none());
    browser.act(
        cx,
        ardia_state::Action::OpenPeek {
            window: browser.window.clone(),
            url: "https://peek.example/page".into(),
            source: Some(source),
        },
    );
    assert!(browser.bounds(cx, mark).is_some());
}

#[gpui::test]
fn switching_tabs_keeps_every_row_icon_in_place(cx: &mut TestAppContext) {
    let browser = Browser::open(cx);
    let first = browser.new_tab(cx, "https://example.org/");
    let second = browser.new_tab(cx, "https://example.com/");
    browser.settle_rows(cx);
    let inset = |browser: &Browser, cx: &mut TestAppContext, tab: &TabId| {
        let row = browser
            .bounds(cx, selector("tab-row", tab))
            .expect("the row");
        let icon = browser
            .bounds(cx, selector("tab-icon", tab))
            .expect("the icon");
        (icon.origin.x - row.origin.x, icon.origin.y - row.origin.y)
    };
    assert_eq!(browser.active(), second);
    let first_idle = inset(&browser, cx, &first);
    let second_active = inset(&browser, cx, &second);
    assert_eq!(first_idle, second_active);
    browser.click(cx, selector("tab-row", &first));
    assert_eq!(browser.active(), first);
    assert_eq!(inset(&browser, cx, &first), first_idle);
    assert_eq!(inset(&browser, cx, &second), second_active);
}

#[gpui::test]
fn a_pinned_tile_icon_lands_on_the_device_pixel_the_old_layout_rounds_to(cx: &mut TestAppContext) {
    let browser = Browser::open(cx);
    let tab = browser.new_tab(cx, "https://example.org/");
    browser.act(
        cx,
        ardia_state::Action::SetPin {
            tab: tab.clone(),
            pin: Some(ardia_state::model::TabPin::TILE),
        },
    );
    let tile = browser
        .bounds(cx, selector("tile", &tab))
        .expect("the tile");
    let icon = browser
        .bounds(cx, selector("tile-icon", &tab))
        .expect("the tile icon");
    let scale = crate::primitives::cap_letter::RETINA_PIXELS_PER_POINT;
    let half_up = |offset: f32| (offset * scale + 0.5).floor() / scale;
    let inset_x = (f32::from(tile.size.width) - f32::from(icon.size.width)) / 2.0;
    let shown_x = f32::from(icon.origin.x - tile.origin.x);
    assert!(
        (shown_x - half_up(inset_x)).abs() <= 0.5 / scale,
        "{shown_x} vs {inset_x}"
    );
    assert!(shown_x >= inset_x);
}

fn swipe_event(
    at: gpui::Point<gpui::Pixels>,
    dx: f32,
    phase: gpui::ScrollPhase,
) -> gpui::ScrollEvent {
    gpui::ScrollEvent {
        position: at,
        delta: gpui::ScrollDelta::Pixels(point(px(dx), px(0.))),
        gesture_phase: phase,
        ..gpui::ScrollEvent::default()
    }
}

#[gpui::test]
fn a_profile_swipe_that_ends_over_the_page_still_settles_on_a_page(cx: &mut TestAppContext) {
    let browser = Browser::open(cx);
    browser.act(
        cx,
        ardia_state::Action::CreateProfile {
            name: "Work".into(),
            color: Some(ardia_theme::ProfileColor::Green),
            icon: None,
        },
    );
    browser.redraw(cx);
    let sidebar = browser.bounds(cx, "sidebar").expect("the sidebar");
    let page = browser.bounds(cx, "page").expect("the page");
    let over_sidebar = sidebar.center();
    let over_page = page.center();
    let mut visual = VisualTestContext::from_window(browser.handle.into(), cx);
    visual.simulate_mouse_move(over_sidebar, None, Modifiers::none());
    visual.simulate_event(swipe_event(over_sidebar, 0.0, gpui::ScrollPhase::Began));
    visual.simulate_event(swipe_event(over_sidebar, -30.0, gpui::ScrollPhase::Changed));
    visual.simulate_event(swipe_event(over_sidebar, -30.0, gpui::ScrollPhase::Changed));
    visual.run_until_parked();
    let window = browser.window.as_str().to_owned();
    assert!(crate::sidebar::pager::with_pager(&window, |pager| pager.engaged()));
    visual.simulate_mouse_move(over_page, None, Modifiers::none());
    visual.simulate_event(swipe_event(over_page, 0.0, gpui::ScrollPhase::Ended));
    visual.run_until_parked();
    assert!(!crate::sidebar::pager::with_pager(&window, |pager| pager.engaged()));
    let deadline = std::time::Instant::now() + Duration::from_secs(3);
    while crate::sidebar::pager::paging(&window) && std::time::Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(8));
        browser.redraw(cx);
    }
    assert!(!crate::sidebar::pager::paging(&window));
    let index = browser
        .state()
        .profile_order
        .iter()
        .position(|p| {
            browser
                .state()
                .window(browser.window.as_str())
                .is_some_and(|w| w.profile_id == *p)
        })
        .expect("a profile");
    let resting = crate::sidebar::pager::with_pager(&window, |pager| {
        pager.position(std::time::Instant::now())
    });
    assert_eq!(resting, index as f32);
}

#[gpui::test]
fn a_tile_folder_is_one_cell_in_the_strip_dock(cx: &mut TestAppContext) {
    use ardia_state::Action;
    use ardia_state::model::TabPin;
    let browser = Browser::open(cx);
    let a = browser.new_tab(cx, "https://a.example/");
    let b = browser.new_tab(cx, "https://b.example/");
    let c = browser.new_tab(cx, "https://c.example/");
    for tab in [&a, &b, &c] {
        browser.act(
            cx,
            Action::SetPin {
                tab: tab.clone(),
                pin: Some(TabPin::TILE),
            },
        );
    }
    browser.act(
        cx,
        Action::AddToTileFolder {
            tabs: vec![b],
            onto: a.clone(),
            before: None,
        },
    );
    let entries =
        crate::sidebar::strip_layout::strip_entries(&browser.state(), browser.window.as_str());
    let dock = entries
        .iter()
        .find_map(|e| match e {
            crate::sidebar::strip_layout::Entry::Dock(ids) => Some(ids.clone()),
            _ => None,
        })
        .expect("a dock");
    assert_eq!(dock, vec![a, c]);
}

#[gpui::test]
fn one_move_straight_onto_the_page_shows_the_split_zone(cx: &mut TestAppContext) {
    let browser = Browser::open(cx);
    let first = browser.active();
    let other = browser.new_tab(cx, "https://other.test/");
    browser.act(cx, ardia_state::Action::ActivateTab { tab: first });
    let row = browser
        .bounds(cx, selector("tab-row", &other))
        .expect("the row");
    let page = browser.bounds(cx, "page").expect("the page");
    let mut visual = VisualTestContext::from_window(browser.handle.into(), cx);
    visual.simulate_mouse_down(row.center(), MouseButton::Left, Modifiers::none());
    let edge = point(page.origin.x + px(24.), page.center().y);
    visual.simulate_mouse_move(edge, MouseButton::Left, Modifiers::none());
    visual.run_until_parked();
    assert!(
        browser.bounds(cx, "pane-drop-preview").is_some(),
        "the zone shows after a single move"
    );
    let mut visual = VisualTestContext::from_window(browser.handle.into(), cx);
    visual.simulate_mouse_up(edge, MouseButton::Left, Modifiers::none());
    visual.run_until_parked();
    assert!(browser.state().split_of(other.as_str()).is_some());
}

#[gpui::test]
fn renaming_a_tile_folder_asks_and_saves_the_name(cx: &mut TestAppContext) {
    use ardia_state::Action;
    use ardia_state::model::TabPin;
    let browser = Browser::open(cx);
    let a = browser.new_tab(cx, "https://a.example/");
    let b = browser.new_tab(cx, "https://b.example/");
    for tab in [&a, &b] {
        browser.act(
            cx,
            Action::SetPin {
                tab: tab.clone(),
                pin: Some(TabPin::TILE),
            },
        );
    }
    browser.act(
        cx,
        Action::AddToTileFolder {
            tabs: vec![b.clone()],
            onto: a.clone(),
            before: None,
        },
    );
    let folder = browser
        .state()
        .tab(a.as_str())
        .and_then(|t| t.pin.as_ref().and_then(TabPin::folder).cloned())
        .expect("a folder");
    browser.host.set_prompt_answer(Some(Some("Reading".into())));
    browser
        .handle
        .update(cx, |view, window, cx| {
            view.handle(
                crate::msg::Msg::RenameTileFolder(folder.id.clone()),
                window,
                cx,
            )
        })
        .expect("rename");
    cx.run_until_parked();
    let asked = browser
        .host
        .calls()
        .into_iter()
        .find_map(|call| match call {
            crate::mock::HostCall::Prompt(p) => Some(p),
            _ => None,
        })
        .expect("a prompt");
    assert_eq!(
        (asked.title.as_str(), asked.value.as_str()),
        ("Rename Folder", "")
    );
    for tab in [&a, &b] {
        let name = browser.state().tab(tab.as_str()).and_then(|t| {
            t.pin
                .as_ref()
                .and_then(TabPin::folder)
                .map(|f| f.name.clone())
        });
        assert_eq!(name.as_deref(), Some("Reading"));
    }
}

fn drag_between(
    browser: &Browser,
    cx: &mut TestAppContext,
    from: gpui::Point<gpui::Pixels>,
    to: gpui::Point<gpui::Pixels>,
    shown_on_the_way: &'static str,
) -> bool {
    let mut visual = VisualTestContext::from_window(browser.handle.into(), cx);
    visual.simulate_mouse_down(from, MouseButton::Left, Modifiers::none());
    visual.simulate_mouse_move(
        from + point(px(0.), px(-12.)),
        MouseButton::Left,
        Modifiers::none(),
    );
    visual.run_until_parked();
    for _ in 0..3 {
        visual.simulate_mouse_move(to, MouseButton::Left, Modifiers::none());
        visual.run_until_parked();
    }
    let shown = visual.debug_bounds(shown_on_the_way).is_some();
    visual.simulate_mouse_up(to, MouseButton::Left, Modifiers::none());
    visual.run_until_parked();
    shown
}

fn pin_of(browser: &Browser, tab: &TabId) -> Option<ardia_state::model::TabPin> {
    browser
        .state()
        .tab(tab.as_str())
        .and_then(|t| t.pin.clone())
}

fn use_address_bar(browser: &Browser, cx: &mut TestAppContext, place: &str) {
    browser.act(
        cx,
        ardia_state::Action::UpdateSettings {
            patch: ardia_state::settings::SettingsPatch::new().set("addressBar", place),
            from_sync: false,
        },
    );
}

#[gpui::test]
fn dropping_a_row_on_the_sidebar_field_pins_it_when_nothing_is_pinned(cx: &mut TestAppContext) {
    let browser = Browser::open(cx);
    use_address_bar(&browser, cx, "sidebar");
    let tab = browser.new_tab(cx, "https://a.test/");
    browser.settle_rows(cx);
    let row = browser
        .bounds(cx, selector("tab-row", &tab))
        .expect("the row");
    let field = browser.bounds(cx, "arc-address").expect("the field");
    assert!(browser.bounds(cx, "pin-field-zone").is_none());
    let shown = drag_between(&browser, cx, row.center(), field.center(), "pin-field-zone");
    assert!(shown, "the field turns into the pin zone during the drag");
    assert!(matches!(
        pin_of(&browser, &tab),
        Some(ardia_state::model::TabPin::Tile { .. })
    ));
    assert!(browser.bounds(cx, "pin-field-zone").is_none());
}

#[gpui::test]
fn dropping_a_row_above_the_list_pins_it_into_the_slot(cx: &mut TestAppContext) {
    let browser = Browser::open(cx);
    use_address_bar(&browser, cx, "toolbar");
    let tab = browser.new_tab(cx, "https://b.test/");
    browser.settle_rows(cx);
    let first = order(&browser)[0].clone();
    let top = browser
        .bounds(cx, selector("tab-row", &first))
        .expect("the first row");
    let row = browser
        .bounds(cx, selector("tab-row", &tab))
        .expect("the row");
    let list_top = browser
        .bounds(cx, "clear-divider")
        .map_or(top.origin.y, |divider| divider.origin.y);
    let above = point(top.center().x, list_top - px(4.));
    let shown = drag_between(&browser, cx, row.center(), above, "pin-slot-zone");
    assert!(
        shown,
        "the slot shows at the top of the list during the drag"
    );
    assert!(matches!(
        pin_of(&browser, &tab),
        Some(ardia_state::model::TabPin::Tile { .. })
    ));
    assert!(browser.bounds(cx, "pin-slot-zone").is_none());
}

#[gpui::test]
fn dragging_a_tile_into_the_list_unpins_it(cx: &mut TestAppContext) {
    let browser = Browser::open(cx);
    use_address_bar(&browser, cx, "sidebar");
    let tab = browser.new_tab(cx, "https://a.test/");
    let other = browser.new_tab(cx, "https://b.test/");
    browser.act(
        cx,
        ardia_state::Action::SetPin {
            tab: tab.clone(),
            pin: Some(ardia_state::model::TabPin::Tile { folder: None }),
        },
    );
    browser.settle_rows(cx);
    let tile = browser
        .bounds(cx, selector("tile", &tab))
        .expect("the tile");
    let row = browser
        .bounds(cx, selector("tab-row", &other))
        .expect("the row");
    let below = point(row.center().x, row.bottom() + px(8.));
    drag_between(&browser, cx, tile.center(), below, "tab-row-ghost-none");
    assert_eq!(pin_of(&browser, &tab), None);
}

#[gpui::test]
fn one_move_from_the_tab_strip_onto_the_page_shows_the_split_zone(cx: &mut TestAppContext) {
    let browser = Browser::open(cx);
    let first = browser.active();
    let other = browser.new_tab(cx, "https://other.test/");
    browser.act(cx, ardia_state::Action::ActivateTab { tab: first });
    browser.keys(cx, "shift-cmd-s");
    let chip = browser
        .bounds(cx, selector("strip-tab", &other))
        .expect("the chip");
    let page = browser.bounds(cx, "page").expect("the page");
    let mut visual = VisualTestContext::from_window(browser.handle.into(), cx);
    visual.simulate_mouse_down(chip.center(), MouseButton::Left, Modifiers::none());
    let edge = point(page.origin.x + px(24.), page.center().y);
    visual.simulate_mouse_move(edge, MouseButton::Left, Modifiers::none());
    visual.run_until_parked();
    assert!(browser.bounds(cx, "pane-drop-preview").is_some());
    let mut visual = VisualTestContext::from_window(browser.handle.into(), cx);
    visual.simulate_mouse_up(edge, MouseButton::Left, Modifiers::none());
    visual.run_until_parked();
    assert!(browser.state().split_of(other.as_str()).is_some());
}

#[gpui::test]
fn dragging_a_dock_cell_slides_its_neighbours_and_reorders_on_release(cx: &mut TestAppContext) {
    use ardia_state::model::TabPin;
    let browser = Browser::open(cx);
    let a = browser.new_tab(cx, "https://a.example/");
    let b = browser.new_tab(cx, "https://b.example/");
    let c = browser.new_tab(cx, "https://c.example/");
    for tab in [&a, &b, &c] {
        browser.act(
            cx,
            ardia_state::Action::SetPin {
                tab: tab.clone(),
                pin: Some(TabPin::TILE),
            },
        );
    }
    browser.keys(cx, "shift-cmd-s");
    let pitch = px(crate::sidebar::dock_drag::DOCK_PITCH);
    let ids =
        crate::sidebar::strip_layout::strip_entries(&browser.state(), browser.window.as_str())
            .into_iter()
            .find_map(|e| match e {
                crate::sidebar::strip_layout::Entry::Dock(ids) => Some(ids),
                _ => None,
            })
            .expect("a dock");
    assert_eq!(ids, vec![a.clone(), b.clone(), c.clone()]);
    let window = browser.window.as_str().to_owned();
    let cell = browser
        .bounds(cx, selector("strip-pin", &a))
        .expect("the first cell");
    let first = cell.center();
    let mut visual = VisualTestContext::from_window(browser.handle.into(), cx);
    visual.simulate_mouse_down(first, MouseButton::Left, Modifiers::none());
    visual.simulate_mouse_move(
        first + point(px(4.), px(0.)),
        MouseButton::Left,
        Modifiers::none(),
    );
    visual.run_until_parked();
    assert!(
        crate::sidebar::dock_drag::active(&window),
        "the cell drag starts in the dock"
    );
    let past = first + point(pitch * 2.0, px(0.));
    visual.simulate_mouse_move(past, MouseButton::Left, Modifiers::none());
    visual.run_until_parked();
    let (_, _, sliding) =
        crate::sidebar::dock_drag::cell_offset(&window, 1, &b, std::time::Instant::now());
    let state = crate::sidebar::dock_drag::active(&window);
    assert!(state, "the drag is still in the dock");
    let _ = sliding;
    visual.simulate_mouse_up(past, MouseButton::Left, Modifiers::none());
    visual.run_until_parked();
    let order: Vec<TabId> = browser
        .state()
        .window(browser.window.as_str())
        .map(|w| {
            w.tab_ids
                .iter()
                .filter(|t| [&a, &b, &c].contains(t))
                .cloned()
                .collect()
        })
        .unwrap_or_default();
    assert_eq!(order, vec![b, c, a.clone()]);
    assert!(!crate::sidebar::dock_drag::active(&window));
}

fn strip_with_tile(cx: &mut TestAppContext) -> (Browser, TabId) {
    use ardia_state::model::TabPin;
    let browser = Browser::open(cx);
    let tile = browser.new_tab(cx, "https://mail.example/");
    browser.act(
        cx,
        ardia_state::Action::SetPin {
            tab: tile.clone(),
            pin: Some(TabPin::TILE),
        },
    );
    browser.act(
        cx,
        ardia_state::Action::UpdatePage {
            tab: tile.clone(),
            update: ardia_state::actions::PageUpdate {
                unread_count: Some(3),
                engine_tab_id: Some(Some("engine-1".into())),
                ..Default::default()
            },
        },
    );
    set_settings(
        &browser,
        cx,
        &[
            ("showUnreadCounts", serde_json::json!(true)),
            ("showTopAppBadges", serde_json::json!(true)),
        ],
    );
    browser.keys(cx, "shift-cmd-s");
    (browser, tile)
}

fn set_settings(browser: &Browser, cx: &mut TestAppContext, pairs: &[(&str, serde_json::Value)]) {
    let mut patch = ardia_state::settings::SettingsPatch::new();
    for (key, value) in pairs {
        patch = patch.set(key, value.clone());
    }
    browser.act(
        cx,
        ardia_state::Action::UpdateSettings {
            patch,
            from_sync: false,
        },
    );
}

#[gpui::test]
fn strip_tiles_follow_top_app_badges_and_minimalism_letters(cx: &mut TestAppContext) {
    let (browser, tile) = strip_with_tile(cx);
    assert!(browser.bounds(cx, selector("strip-pin", &tile)).is_some());
    assert!(
        browser
            .bounds(cx, selector("strip-pin-unread", &tile))
            .is_some()
    );
    assert!(
        browser
            .bounds(cx, selector("strip-pin-letters", &tile))
            .is_none()
    );
    set_settings(
        &browser,
        cx,
        &[
            ("showTopAppBadges", serde_json::json!(false)),
            ("minimalismMode", serde_json::json!(true)),
            ("minimalismPinnedIcons", serde_json::json!("letters")),
        ],
    );
    assert!(
        browser
            .bounds(cx, selector("strip-pin-unread", &tile))
            .is_none()
    );
    assert!(
        browser
            .bounds(cx, selector("strip-pin-letters", &tile))
            .is_some()
    );
    set_settings(
        &browser,
        cx,
        &[("minimalismPinnedIcons", serde_json::json!("logos"))],
    );
    assert!(
        browser
            .bounds(cx, selector("strip-pin-letters", &tile))
            .is_none()
    );
}

#[gpui::test]
fn the_strip_corner_radius_follows_the_tab_corner_setting(cx: &mut TestAppContext) {
    let (browser, _) = strip_with_tile(cx);
    use crate::sidebar::strip_layout::{pinned_face_radius, tab_close_radius, tab_radius};
    assert_eq!(tab_radius(), 10.0);
    assert_eq!(pinned_face_radius(), 8.0);
    set_settings(&browser, cx, &[("tabCornerRadius", serde_json::json!(4))]);
    assert_eq!(tab_radius(), 4.0);
    assert_eq!(pinned_face_radius(), 2.0);
    assert_eq!(tab_close_radius(), 0.0);
    set_settings(
        &browser,
        cx,
        &[("tabCornerRadius", serde_json::Value::Null)],
    );
    assert_eq!(tab_radius(), 10.0);
}

#[gpui::test]
fn dock_reorders_tick_once_per_new_slot_unless_haptics_are_off(cx: &mut TestAppContext) {
    use ardia_state::model::TabPin;
    let browser = Browser::open(cx);
    let a = browser.new_tab(cx, "https://a.example/");
    let b = browser.new_tab(cx, "https://b.example/");
    let c = browser.new_tab(cx, "https://c.example/");
    for tab in [&a, &b, &c] {
        browser.act(
            cx,
            ardia_state::Action::SetPin {
                tab: tab.clone(),
                pin: Some(TabPin::TILE),
            },
        );
    }
    browser.keys(cx, "shift-cmd-s");
    let pitch = px(crate::sidebar::dock_drag::DOCK_PITCH);
    let drag_two_slots = |browser: &Browser, cx: &mut TestAppContext, from: &TabId| -> usize {
        let before = crate::primitives::haptics::reorder_ticks();
        let first = browser
            .bounds(cx, selector("strip-pin", from))
            .expect("the cell")
            .center();
        let mut visual = VisualTestContext::from_window(browser.handle.into(), cx);
        visual.simulate_mouse_down(first, MouseButton::Left, Modifiers::none());
        for step in 1..=8 {
            let at = first + point(pitch * (step as f32 * 0.25), px(0.));
            visual.simulate_mouse_move(at, MouseButton::Left, Modifiers::none());
            visual.run_until_parked();
        }
        let end = first + point(pitch * 2.0, px(0.));
        visual.simulate_mouse_up(end, MouseButton::Left, Modifiers::none());
        visual.run_until_parked();
        crate::primitives::haptics::reorder_ticks() - before
    };
    assert_eq!(drag_two_slots(&browser, cx, &a), 2);
    set_settings(
        &browser,
        cx,
        &[("tabReorderHaptics", serde_json::json!(false))],
    );
    assert_eq!(drag_two_slots(&browser, cx, &b), 0);
}

fn strip_card_after_rest(browser: &Browser, cx: &mut TestAppContext, tab: &TabId) -> bool {
    let chip = browser
        .bounds(cx, selector("strip-tab", tab))
        .expect("the chip");
    let mut visual = VisualTestContext::from_window(browser.handle.into(), cx);
    visual.simulate_mouse_move(chip.center(), None, Modifiers::none());
    visual.run_until_parked();
    visual.simulate_mouse_move(
        chip.center() + point(px(1.), px(0.)),
        None,
        Modifiers::none(),
    );
    visual.executor().advance_clock(Duration::from_millis(1500));
    visual.run_until_parked();
    let shown = visual.debug_bounds("strip-hover-card").is_some();
    visual.simulate_mouse_move(point(px(400.), px(400.)), None, Modifiers::none());
    visual.executor().advance_clock(Duration::from_millis(500));
    visual.run_until_parked();
    shown
}

#[gpui::test]
fn the_strip_hover_card_follows_the_hover_menu_setting(cx: &mut TestAppContext) {
    let browser = Browser::open(cx);
    let first = browser.active();
    let other = browser.new_tab(cx, "https://other.test/a/b?c=d");
    browser.act(cx, ardia_state::Action::ActivateTab { tab: first });
    browser.keys(cx, "shift-cmd-s");
    assert!(strip_card_after_rest(&browser, cx, &other));
    set_settings(
        &browser,
        cx,
        &[("showTabHoverMenu", serde_json::json!(false))],
    );
    assert!(!strip_card_after_rest(&browser, cx, &other));
}

#[test]
fn the_strip_hover_card_shows_the_host_unless_the_full_url_is_chosen() {
    let url = "https://www.other.test/a/b?c=d";
    let host = crate::sidebar::hover_card::card_address(url, false);
    assert!(!host.contains("/a/b"));
    assert!(host.contains("other.test"));
    assert!(crate::sidebar::hover_card::card_address(url, true).contains("/a/b"));
}

fn strip_with_two_tabs(cx: &mut TestAppContext) -> (Browser, TabId, TabId) {
    let browser = Browser::open(cx);
    let first = browser.active();
    let a = browser.new_tab(cx, "https://a.test/");
    let b = browser.new_tab(cx, "https://b.test/");
    browser.act(cx, ardia_state::Action::ActivateTab { tab: first });
    browser.keys(cx, "shift-cmd-s");
    (browser, a, b)
}

fn hover_chip(visual: &mut VisualTestContext, chip: gpui::Bounds<gpui::Pixels>) {
    visual.simulate_mouse_move(chip.center(), None, Modifiers::none());
    visual.simulate_mouse_move(
        chip.center() + point(px(1.), px(0.)),
        None,
        Modifiers::none(),
    );
    visual.run_until_parked();
}

#[gpui::test]
fn the_strip_card_waits_half_a_second_and_sits_under_the_chip(cx: &mut TestAppContext) {
    let (browser, a, _) = strip_with_two_tabs(cx);
    let chip = browser
        .bounds(cx, selector("strip-tab", &a))
        .expect("the chip");
    let strip = browser.bounds(cx, "tab-strip").expect("the strip");
    let mut visual = VisualTestContext::from_window(browser.handle.into(), cx);
    hover_chip(&mut visual, chip);
    visual.executor().advance_clock(Duration::from_millis(450));
    visual.run_until_parked();
    assert!(visual.debug_bounds("strip-hover-card").is_none());
    visual.executor().advance_clock(Duration::from_millis(100));
    visual.run_until_parked();
    let card = visual.debug_bounds("strip-hover-card").expect("the card");
    assert_eq!(card.origin.x, chip.origin.x);
    assert_eq!(
        card.origin.y,
        strip.origin.y + px(crate::sidebar::strip_layout::STRIP_HEIGHT + 4.)
    );
    assert_eq!(card.size.width, px(264.));
}

#[gpui::test]
fn moving_to_another_chip_switches_the_strip_card_at_once(cx: &mut TestAppContext) {
    let (browser, a, b) = strip_with_two_tabs(cx);
    let chip_a = browser
        .bounds(cx, selector("strip-tab", &a))
        .expect("chip a");
    let chip_b = browser
        .bounds(cx, selector("strip-tab", &b))
        .expect("chip b");
    let window = browser.window.as_str().to_owned();
    let mut visual = VisualTestContext::from_window(browser.handle.into(), cx);
    hover_chip(&mut visual, chip_a);
    visual.executor().advance_clock(Duration::from_millis(600));
    visual.run_until_parked();
    assert_eq!(
        crate::sidebar::strip_hover::shown_tab(&window),
        Some(a.clone())
    );
    hover_chip(&mut visual, chip_b);
    assert_eq!(crate::sidebar::strip_hover::shown_tab(&window), Some(b));
    let card = visual.debug_bounds("strip-hover-card").expect("the card");
    assert_eq!(card.origin.x, chip_b.origin.x);
}

#[gpui::test]
fn pressing_a_chip_hides_the_strip_card_until_the_pointer_leaves(cx: &mut TestAppContext) {
    let (browser, a, _) = strip_with_two_tabs(cx);
    let chip = browser
        .bounds(cx, selector("strip-tab", &a))
        .expect("the chip");
    let window = browser.window.as_str().to_owned();
    let mut visual = VisualTestContext::from_window(browser.handle.into(), cx);
    hover_chip(&mut visual, chip);
    visual.executor().advance_clock(Duration::from_millis(600));
    visual.run_until_parked();
    assert!(crate::sidebar::strip_hover::shown_tab(&window).is_some());
    visual.simulate_mouse_down(chip.center(), MouseButton::Left, Modifiers::none());
    visual.simulate_mouse_up(chip.center(), MouseButton::Left, Modifiers::none());
    visual.run_until_parked();
    assert!(crate::sidebar::strip_hover::shown_tab(&window).is_none());
    hover_chip(&mut visual, chip);
    visual.executor().advance_clock(Duration::from_millis(600));
    visual.run_until_parked();
    assert!(crate::sidebar::strip_hover::shown_tab(&window).is_none());
}

#[gpui::test]
fn an_open_popover_holds_the_strip_and_sidebar_cards_back(cx: &mut TestAppContext) {
    let (browser, a, _) = strip_with_two_tabs(cx);
    let window = browser.window.as_str().to_owned();
    browser.act(
        cx,
        ardia_state::Action::SetPopover {
            window: browser.window.clone(),
            popover: Some(ardia_state::windows::Popover::SiteControls),
        },
    );
    assert!(crate::window::hover_hold::hover_held(&window));
    let chip = browser
        .bounds(cx, selector("strip-tab", &a))
        .expect("the chip");
    let mut visual = VisualTestContext::from_window(browser.handle.into(), cx);
    hover_chip(&mut visual, chip);
    visual.executor().advance_clock(Duration::from_millis(600));
    visual.run_until_parked();
    assert!(crate::sidebar::strip_hover::shown_tab(&window).is_none());
    browser.act(
        cx,
        ardia_state::Action::SetPopover {
            window: browser.window.clone(),
            popover: None,
        },
    );
    assert!(!crate::window::hover_hold::hover_held(&window));
    browser.keys(cx, "shift-cmd-s");
    browser.act(
        cx,
        ardia_state::Action::SetPopover {
            window: browser.window.clone(),
            popover: Some(ardia_state::windows::Popover::History),
        },
    );
    let row = browser
        .bounds(cx, selector("tab-row", &a))
        .expect("the row");
    let mut visual = VisualTestContext::from_window(browser.handle.into(), cx);
    visual.simulate_mouse_move(row.center(), None, Modifiers::none());
    visual.run_until_parked();
    visual.simulate_mouse_move(
        row.center() + point(px(2.), px(0.)),
        None,
        Modifiers::none(),
    );
    visual.executor().advance_clock(Duration::from_millis(1200));
    visual.run_until_parked();
    assert!(visual.debug_bounds("tab-hover-card").is_none());
}
