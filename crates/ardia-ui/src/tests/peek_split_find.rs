use ardia_state::Action;
use ardia_state::model::Orientation;
use ardia_state::settings::PeekButtons;
use gpui::TestAppContext;

use super::support::Browser;
use crate::content::split_view::{DropContext, PaneDrop, PaneDropSide, drop_actions, drop_rules};
use crate::window::layout::Rect;

fn find_open(browser: &Browser) -> bool {
    browser
        .state()
        .tab(browser.active().as_str())
        .is_some_and(|t| t.live.find.open)
}

#[gpui::test]
fn find_steps_only_on_enter_and_reopens_from_find_next(cx: &mut TestAppContext) {
    let browser = Browser::open(cx);
    browser.keys(cx, "cmd-g");
    assert!(find_open(&browser));
    assert!(browser.bounds(cx, "find-bar").is_some());
    browser.typed(cx, "docs");
    let active = |browser: &Browser| {
        browser
            .state()
            .tab(browser.active().as_str())
            .expect("tab")
            .live
            .find
            .active
    };
    assert_eq!(active(&browser), 1);
    browser.keys(cx, "down");
    browser.keys(cx, "up");
    assert_eq!(active(&browser), 1);
    browser.keys(cx, "enter");
    assert_eq!(active(&browser), 2);
    let width = browser.bounds(cx, "find-bar").expect("bar").size.width;
    assert_eq!(
        width,
        crate::scale::px(crate::content::find_bar::FIND_WIDTH)
    );
}

#[gpui::test]
fn the_peek_bar_offers_split_open_and_close(cx: &mut TestAppContext) {
    let browser = Browser::open(cx);
    let source = browser.active();
    browser.act(
        cx,
        Action::OpenPeek {
            window: browser.window.clone(),
            url: "https://peek.example/page".into(),
            source: Some(source.clone()),
        },
    );
    assert!(browser.bounds(cx, "peek-bar").is_some());
    assert!(browser.bounds(cx, "peek-side-buttons").is_none());
    let card = browser.bounds(cx, "peek-card").expect("a card");
    let page = browser.bounds(cx, "peek-page").expect("a page");
    assert!(page.origin.y > card.origin.y);
    browser.click(cx, "peek-split");
    let state = browser.state();
    assert!(state.shown_peek(browser.window.as_str()).is_none());
    let split = state.split_of(source.as_str()).expect("a split");
    assert_eq!(split.pane_count(), 2);
    let peeked = browser.active();
    assert_ne!(peeked, source);
    assert!(split.contains(peeked.as_str()));
}

#[gpui::test]
fn peek_buttons_move_beside_the_card_and_the_scrim_closes_it(cx: &mut TestAppContext) {
    let browser = Browser::open(cx);
    browser.act(
        cx,
        Action::UpdateSettings {
            patch: ardia_state::settings::SettingsPatch::new().set("peekButtons", "right"),
            from_sync: false,
        },
    );
    assert_eq!(browser.state().settings.peek_buttons, PeekButtons::Right);
    browser.act(
        cx,
        Action::OpenPeek {
            window: browser.window.clone(),
            url: "https://peek.example".into(),
            source: None,
        },
    );
    let side = browser
        .bounds(cx, "peek-side-buttons")
        .expect("side buttons");
    let card = browser.bounds(cx, "peek-card").expect("a card");
    assert!(side.origin.x > card.origin.x + card.size.width);
    browser.open_peek_fully(cx);
    let scrim = browser.bounds(cx, "peek-scrim").expect("a scrim");
    let mut visual = gpui::VisualTestContext::from_window(browser.handle.into(), cx);
    visual.simulate_click(
        scrim.origin + gpui::point(crate::scale::px(4.), crate::scale::px(4.)),
        gpui::Modifiers::none(),
    );
    visual.run_until_parked();
    browser.settle_peek(cx);
    assert!(browser.bounds(cx, "peek-overlay").is_none());
}

#[gpui::test]
fn dropping_a_tab_on_a_page_edge_splits_beside_it(cx: &mut TestAppContext) {
    let browser = Browser::open(cx);
    let first = browser.active();
    let second = browser.new_tab(cx, "https://second.example");
    browser.act(cx, Action::ActivateTab { tab: first.clone() });
    let state = browser.state();
    let window = state
        .window(browser.window.as_str())
        .expect("window")
        .clone();
    let panes = vec![(first.clone(), Rect::new(0.0, 0.0, 1000.0, 600.0))];
    let ctx = DropContext::new(&state, &window);
    let rules = drop_rules(&ctx, &panes, &second).expect("droppable");
    assert!(!rules.sides.contains(&PaneDropSide::Center));
    let actions = drop_actions(
        &second,
        &PaneDrop {
            tab: first.clone(),
            side: PaneDropSide::Left,
        },
    );
    for action in actions {
        browser.act(cx, action);
    }
    let state = browser.state();
    let split = state.split_of(first.as_str()).expect("a split");
    assert_eq!(split.tab_ids(), vec![second.clone(), first.clone()]);
    assert_eq!(split.orientation, Orientation::Horizontal);
    assert_eq!(browser.active(), second);
    assert!(browser.bounds(cx, "split-focus-ring").is_some());
    assert!(browser.bounds(cx, "split-handle-0").is_some());
}

#[gpui::test]
fn little_ardia_has_history_buttons_and_icon_actions(cx: &mut TestAppContext) {
    use std::sync::Arc;

    use ardia_state::windows::WindowKind;

    use crate::little_ardia::LittleArdiaWindowView;
    use crate::{OpenWindowTarget, UiHost, open_little_ardia_window};

    cx.update(crate::bind_global_keybindings);
    let host = crate::mock::MockUiHost::fresh();
    let little = host
        .open_window(WindowKind::LittleArdia, Some("https://news.example/story"))
        .expect("a little window");
    let shared: Arc<dyn UiHost> = host;
    let handle = cx
        .update(|cx| {
            open_little_ardia_window(
                shared,
                OpenWindowTarget {
                    window_id: little.clone(),
                    ..OpenWindowTarget::default()
                },
                cx,
            )
        })
        .expect("little ardia opens")
        .downcast::<LittleArdiaWindowView>()
        .expect("a little ardia window");
    cx.run_until_parked();
    let mut visual = gpui::VisualTestContext::from_window(handle.into(), cx);
    visual.run_until_parked();
    let back = visual.debug_bounds("little-back").expect("a back button");
    let forward = visual
        .debug_bounds("little-forward")
        .expect("a forward button");
    let field = visual
        .debug_bounds("little-ardia-address")
        .expect("an address field");
    let copy = visual.debug_bounds("little-copy").expect("a copy button");
    let open = visual.debug_bounds("little-open").expect("an open button");
    let x = |b: gpui::Bounds<gpui::Pixels>| crate::scale::logical_point(b.origin).0;
    assert_eq!(x(back), crate::little_ardia::nav_left());
    assert_eq!(x(forward) - x(back), crate::little_ardia::nav_pitch());
    assert_eq!(x(field), crate::little_ardia::field_left());
    assert_eq!(x(open) - x(copy), 30.0);
    assert!(visual.debug_bounds("little-profile").is_none());
    visual.simulate_click(copy.center(), gpui::Modifiers::none());
    visual.run_until_parked();
    assert_eq!(
        visual.read_from_clipboard().and_then(|c| c.text()),
        Some("https://news.example/story".to_owned())
    );
}

#[gpui::test]
fn drops_keep_the_split_orientation_and_stack_across_it(cx: &mut TestAppContext) {
    let browser = Browser::open(cx);
    let first = browser.active();
    let second = browser.new_tab(cx, "https://second.example");
    let third = browser.new_tab(cx, "https://third.example");
    browser.act(
        cx,
        Action::SplitTabs {
            tabs: vec![first.clone(), second.clone()],
            orientation: Orientation::Horizontal,
        },
    );
    for action in drop_actions(
        &third,
        &PaneDrop {
            tab: second,
            side: PaneDropSide::Bottom,
        },
    ) {
        browser.act(cx, action);
    }
    let state = browser.state();
    let split = state.split_of(first.as_str()).expect("a split");
    assert_eq!(split.orientation, Orientation::Horizontal);
    assert_eq!(split.pane_count(), 3);
    assert!(split.is_stacked(third.as_str()));
    assert_eq!(browser.active(), third);
}

#[gpui::test]
fn an_empty_split_pane_offers_tabs_and_takes_one(cx: &mut TestAppContext) {
    let browser = Browser::open(cx);
    let first = browser.active();
    let other = browser.new_tab(cx, "https://other.example");
    browser.act(cx, Action::ActivateTab { tab: first.clone() });
    browser.act(
        cx,
        Action::OpenSplitPane {
            window: browser.window.clone(),
            side: ardia_state::splits::SplitSide::Right,
            url: None,
        },
    );
    browser.redraw(cx);
    assert!(browser.bounds(cx, "split-empty").is_some());
    let empty = browser.active();
    assert_ne!(empty, first);
    let state = browser.state();
    let offered = crate::content::split_empty::split_suggestions(&state, &empty);
    assert_eq!(offered, vec![other.clone()]);
    browser.act(
        cx,
        Action::ReplaceSplitPane {
            pane: empty.clone(),
            tab: other.clone(),
        },
    );
    let state = browser.state();
    assert!(state.tab(empty.as_str()).is_none());
    let split = state.split_of(first.as_str()).expect("a split");
    assert_eq!(split.tab_ids(), vec![first.clone(), other.clone()]);
    assert_eq!(browser.active(), other);
}

#[gpui::test]
fn escape_closes_an_empty_split_pane(cx: &mut TestAppContext) {
    let browser = Browser::open(cx);
    let first = browser.active();
    browser.act(
        cx,
        Action::OpenSplitPane {
            window: browser.window.clone(),
            side: ardia_state::splits::SplitSide::Right,
            url: None,
        },
    );
    browser.redraw(cx);
    browser.keys(cx, "escape");
    let state = browser.state();
    assert!(state.split_of(first.as_str()).is_none());
    assert_eq!(browser.active(), first);
}

#[gpui::test]
fn find_and_replace_shows_the_replace_row_and_asks_the_page(cx: &mut TestAppContext) {
    let browser = Browser::open(cx);
    let tab = browser.active();
    browser
        .handle
        .update(cx, |view, window, cx| {
            view.handle(
                crate::msg::Msg::Find(crate::msg::FindMsg::OpenReplace),
                window,
                cx,
            )
        })
        .expect("open");
    cx.run_until_parked();
    browser.typed(cx, "docs");
    assert!(browser.bounds(cx, "find-replace-all").is_some());
    browser.click(cx, "find-replace-all");
    assert!(
        browser
            .host
            .calls()
            .contains(&crate::mock::HostCall::Replace {
                tab,
                query: "docs".into(),
                replacement: String::new(),
                all: true,
            })
    );
}

#[test]
fn replace_notes_follow_the_old_copy() {
    use crate::host::ReplaceNote;
    assert_eq!(
        ReplaceNote::of(false, 0, false, 5).map(|n| (n.text, n.error)),
        Some(("Not in a text field".to_owned(), true))
    );
    assert_eq!(ReplaceNote::of(true, 1, false, 5), None);
    assert_eq!(
        ReplaceNote::of(true, 3, true, 5).map(|n| (n.text, n.error)),
        Some(("3 replaced".to_owned(), false))
    );
    assert_eq!(
        ReplaceNote::of(true, 0, false, 5).map(|n| (n.text, n.error)),
        Some(("No matches".to_owned(), true))
    );
    let note = ReplaceNote::of(true, 0, true, 1000).expect("note");
    assert!(note.shown_at(1000) && note.shown_at(3199) && !note.shown_at(3200));
}

#[test]
fn a_spread_pinch_opens_little_ardia_in_the_main_window() {
    use ardia_state::windows::WindowKind;

    use crate::UiHost;
    use crate::primitives::pinch::pinch_step;

    let host = crate::mock::MockUiHost::fresh();
    let little = host
        .open_window(WindowKind::LittleArdia, Some("https://news.example"))
        .expect("a little window");
    let shared: std::sync::Arc<dyn UiHost> = host.clone();
    let mut leaving = false;
    let mut zoom = crate::little_ardia::gestures::LittleZoom::default();
    let mut motion = crate::little_ardia::LittlePinch {
        host: shared,
        window: little.clone(),
        full_screen: false,
        reduce: false,
        leaving: &mut leaving,
        zoom: &mut zoom,
        now: std::time::Instant::now(),
    };
    pinch_step(&mut motion, gpui::TouchPhase::Started, 0.0);
    pinch_step(&mut motion, gpui::TouchPhase::Ended, 0.1);
    assert!(
        !host
            .calls()
            .contains(&crate::mock::HostCall::LittleToMain(little.clone()))
    );
    pinch_step(&mut motion, gpui::TouchPhase::Ended, 0.35);
    assert!(
        host.calls()
            .contains(&crate::mock::HostCall::LittleToMain(little))
    );
}

#[gpui::test]
fn a_peek_opened_at_a_click_remembers_the_point(cx: &mut TestAppContext) {
    let browser = Browser::open(cx);
    let source = browser.active();
    browser.act(
        cx,
        Action::OpenPeekAt {
            window: browser.window.clone(),
            url: "https://peek.example".into(),
            source: Some(source),
            click_px: [240.0, f32::NAN],
        },
    );
    let state = browser.state();
    let peek = state.shown_peek(browser.window.as_str()).expect("a peek");
    assert_eq!(peek.click_px, None);
    browser.keys(cx, "escape");
    let source = browser.active();
    browser.act(
        cx,
        Action::OpenPeekAt {
            window: browser.window.clone(),
            url: "https://peek.example".into(),
            source: Some(source),
            click_px: [240.0, 96.0],
        },
    );
    let state = browser.state();
    let peek = state.shown_peek(browser.window.as_str()).expect("a peek");
    assert_eq!(peek.click_px, Some([240.0, 96.0]));
    assert!(browser.bounds(cx, "peek-overlay").is_some());
}

#[gpui::test]
fn dragging_a_pane_onto_the_far_side_of_its_neighbour_moves_it(cx: &mut TestAppContext) {
    let browser = Browser::open(cx);
    let first = browser.active();
    let second = browser.new_tab(cx, "https://second.example");
    browser.act(
        cx,
        Action::SplitTabs {
            tabs: vec![first.clone(), second.clone()],
            orientation: Orientation::Horizontal,
        },
    );
    let state = browser.state();
    let window = state
        .window(browser.window.as_str())
        .expect("window")
        .clone();
    let panes = vec![
        (first.clone(), Rect::new(0.0, 0.0, 500.0, 600.0)),
        (second.clone(), Rect::new(504.0, 0.0, 500.0, 600.0)),
    ];
    let ctx = DropContext::new(&state, &window);
    let rules = drop_rules(&ctx, &panes, &first).expect("its own pane can move");
    assert!(rules.sides.contains(&PaneDropSide::Center));
    let target = crate::content::split_view::pane_drop_target(
        &rules.candidates,
        990.0,
        300.0,
        None,
        rules.sides,
    )
    .expect("a target");
    assert_eq!(target.side, PaneDropSide::Right);
    for action in drop_actions(&first, &target) {
        browser.act(cx, action);
    }
    let state = browser.state();
    let split = state.split_of(first.as_str()).expect("still split");
    assert_eq!(split.tab_ids(), vec![second, first.clone()]);
    let swap = crate::content::split_view::pane_drop_target(
        &rules.candidates,
        754.0,
        300.0,
        None,
        rules.sides,
    )
    .expect("a target");
    assert_eq!(swap.side, PaneDropSide::Center);
}

#[gpui::test]
fn escape_cancels_a_pane_drag_without_moving_anything(cx: &mut TestAppContext) {
    let browser = Browser::open(cx);
    let first = browser.active();
    let second = browser.new_tab(cx, "https://second.example");
    browser.act(
        cx,
        Action::SplitTabs {
            tabs: vec![first.clone(), second.clone()],
            orientation: Orientation::Horizontal,
        },
    );
    browser.act(cx, Action::ActivateTab { tab: first.clone() });
    let look = crate::content::pane_drag::PaneButtonLook {
        size: 30.0,
        radius: 7.0,
        glyph: crate::primitives::icons::Icon::Split,
        glyph_size: 13.0,
        fill: gpui::black(),
        ink: gpui::white(),
    };
    browser
        .handle
        .update(cx, |_, window, cx| {
            let down = gpui::MouseDownEvent {
                button: gpui::MouseButton::Left,
                position: gpui::point(crate::scale::px(400.), crate::scale::px(20.)),
                modifiers: gpui::Modifiers::none(),
                click_count: 1,
                first_mouse: false,
            };
            crate::content::pane_drag::press(first.clone(), look, &down, window, cx);
        })
        .expect("open");
    cx.run_until_parked();
    assert!(browser.bounds(cx, "pane-drag-layer").is_some());
    let mut visual = gpui::VisualTestContext::from_window(browser.handle.into(), cx);
    visual.simulate_mouse_move(
        gpui::point(crate::scale::px(1100.), crate::scale::px(400.)),
        Some(gpui::MouseButton::Left),
        gpui::Modifiers::none(),
    );
    visual.run_until_parked();
    assert!(browser.bounds(cx, "pane-drag-ghost").is_some());
    browser.keys(cx, "escape");
    assert!(browser.bounds(cx, "pane-drag-ghost").is_none());
    let mut visual = gpui::VisualTestContext::from_window(browser.handle.into(), cx);
    visual.simulate_mouse_up(
        gpui::point(crate::scale::px(1100.), crate::scale::px(400.)),
        gpui::MouseButton::Left,
        gpui::Modifiers::none(),
    );
    visual.run_until_parked();
    let state = browser.state();
    let split = state.split_of(first.as_str()).expect("still split");
    assert_eq!(split.tab_ids(), vec![first, second]);
}

#[gpui::test]
fn open_as_tab_from_the_menu_runs_the_peek_motion(cx: &mut TestAppContext) {
    let browser = Browser::open(cx);
    browser.act(
        cx,
        Action::OpenPeek {
            window: browser.window.clone(),
            url: "https://menu.example".into(),
            source: None,
        },
    );
    browser.open_peek_fully(cx);
    browser.act(
        cx,
        Action::SetPopover {
            window: browser.window.clone(),
            popover: Some(ardia_state::windows::Popover::Custom(
                "command:openFile".into(),
            )),
        },
    );
    assert_eq!(
        browser.view(cx, |view| view.peek_motion.motion().phase()),
        crate::content::peek_motion::PeekPhase::Promoting
    );
    assert!(
        browser
            .state()
            .shown_peek(browser.window.as_str())
            .is_some()
    );
    let before = browser.tab_count();
    browser.settle_peek(cx);
    assert!(
        browser
            .state()
            .shown_peek(browser.window.as_str())
            .is_none()
    );
    assert_eq!(browser.tab_count(), before + 1);
}

fn pinch_at(
    visual: &mut gpui::VisualTestContext,
    at: gpui::Point<gpui::Pixels>,
    phase: gpui::TouchPhase,
    delta: f32,
) -> bool {
    visual.simulate_mouse_move(at, None, gpui::Modifiers::none());
    let propagates = visual.update(|window, cx| {
        window
            .dispatch_event(
                gpui::PlatformInput::Pinch(gpui::PinchEvent {
                    position: at,
                    delta,
                    modifiers: gpui::Modifiers::none(),
                    phase,
                    ..Default::default()
                }),
                cx,
            )
            .propagate
    });
    visual.run_until_parked();
    propagates
}

#[gpui::test]
fn a_pinch_on_the_open_peek_card_is_consumed_and_the_page_keeps_its_zoom(cx: &mut TestAppContext) {
    use crate::content::peek_motion::PeekPhase;
    use gpui::TouchPhase;

    let browser = Browser::open(cx);
    browser.act(
        cx,
        Action::OpenPeek {
            window: browser.window.clone(),
            url: "https://pinch.example".into(),
            source: None,
        },
    );
    let card = browser.bounds(cx, "peek-card").expect("a card");
    let mut visual = gpui::VisualTestContext::from_window(browser.handle.into(), cx);
    assert!(
        pinch_at(&mut visual, card.center(), TouchPhase::Started, 0.0),
        "a peek still waiting to paint leaves the pinch to the page"
    );
    pinch_at(&mut visual, card.center(), TouchPhase::Ended, 0.0);
    browser.open_peek_fully(cx);
    let card = browser.bounds(cx, "peek-card").expect("a card");
    let scrim = browser.bounds(cx, "peek-scrim").expect("a scrim");
    let mut visual = gpui::VisualTestContext::from_window(browser.handle.into(), cx);
    let corner = scrim.origin + gpui::point(crate::scale::px(4.), crate::scale::px(4.));
    assert!(
        pinch_at(&mut visual, corner, TouchPhase::Started, 0.0),
        "a pinch beside the card reaches the page beneath"
    );
    pinch_at(&mut visual, corner, TouchPhase::Ended, 0.0);
    assert!(!pinch_at(
        &mut visual,
        card.center(),
        TouchPhase::Started,
        0.0
    ));
    assert_eq!(
        browser.view(cx, |view| view.peek_motion.motion().phase()),
        PeekPhase::Gesture
    );
    let mut visual = gpui::VisualTestContext::from_window(browser.handle.into(), cx);
    assert!(!pinch_at(
        &mut visual,
        card.center(),
        TouchPhase::Moved,
        -0.1
    ));
    assert!(!pinch_at(
        &mut visual,
        card.center(),
        TouchPhase::Ended,
        0.0
    ));
    assert_eq!(
        browser.view(cx, |view| view.peek_motion.motion().phase()),
        PeekPhase::Settling
    );
}

#[gpui::test]
fn a_pinch_in_little_ardia_is_consumed_and_a_spread_opens_it_in_the_main_window(
    cx: &mut TestAppContext,
) {
    use std::sync::Arc;

    use ardia_state::windows::WindowKind;
    use gpui::TouchPhase;

    use crate::little_ardia::LittleArdiaWindowView;
    use crate::{OpenWindowTarget, UiHost, open_little_ardia_window};

    let host = crate::mock::MockUiHost::fresh();
    let little = host
        .open_window(WindowKind::LittleArdia, Some("https://news.example/pinch"))
        .expect("a little window");
    let shared: Arc<dyn UiHost> = host.clone();
    let handle = cx
        .update(|cx| {
            open_little_ardia_window(
                shared,
                OpenWindowTarget {
                    window_id: little.clone(),
                    ..OpenWindowTarget::default()
                },
                cx,
            )
        })
        .expect("little ardia opens")
        .downcast::<LittleArdiaWindowView>()
        .expect("a little ardia window");
    cx.run_until_parked();
    let mut visual = gpui::VisualTestContext::from_window(handle.into(), cx);
    visual.run_until_parked();
    let card = visual
        .debug_bounds("little-ardia-card")
        .expect("a page card");
    assert!(!pinch_at(
        &mut visual,
        card.center(),
        TouchPhase::Started,
        0.0
    ));
    assert!(!pinch_at(
        &mut visual,
        card.center(),
        TouchPhase::Moved,
        0.2
    ));
    assert!(!pinch_at(
        &mut visual,
        card.center(),
        TouchPhase::Moved,
        0.15
    ));
    assert!(!pinch_at(
        &mut visual,
        card.center(),
        TouchPhase::Ended,
        0.0
    ));
    assert!(
        host.calls()
            .contains(&crate::mock::HostCall::LittleToMain(little))
    );
}
