use ardia_state::Action;
use ardia_state::windows::WindowKind;
use gpui::{BackdropAppearance, TestAppContext, WindowBackgroundAppearance, point, px};

use super::support::Browser;
use crate::UiHost;
use crate::mock::HostCall;

#[gpui::test]
fn the_browser_window_mounts_with_the_profile_backdrop(cx: &mut TestAppContext) {
    let browser = Browser::open(cx);
    let spec = browser
        .view(cx, |view| view.backdrop().shown().copied())
        .expect("a backdrop layer");
    let dark = browser.view(cx, |view| view.look().dark);
    assert_eq!(
        spec.appearance,
        if dark {
            BackdropAppearance::Dark
        } else {
            BackdropAppearance::Light
        }
    );
    assert!(spec.top.a > 0.0);
    let options = crate::window::window_options(crate::window::WindowSpec {
        bounds: gpui::Bounds::default(),
        title: "Ardia",
        lights: point(px(18.), px(23.)),
        min: gpui::size(px(500.), px(400.)),
        background: true,
        host_window: None,
        resizable: true,
    });
    assert_eq!(
        options.window_background,
        WindowBackgroundAppearance::LiquidGlass
    );
    assert!(!options.focus);
    assert!(
        browser
            .host
            .calls()
            .contains(&HostCall::Register(browser.window.clone()))
    );
}

#[gpui::test]
fn the_docked_layout_matches_the_dia_frame(cx: &mut TestAppContext) {
    let browser = Browser::open(cx);
    let sidebar = browser.bounds(cx, "sidebar").expect("a sidebar");
    assert_eq!(sidebar.origin.x, px(0.));
    assert_eq!(sidebar.size.width, px(190.));
    let card = browser.bounds(cx, "content-card").expect("a card");
    assert_eq!(card.origin, point(px(190.), px(9.)));
    let toolbar = browser.bounds(cx, "toolbar").expect("a toolbar");
    assert_eq!(toolbar.size.height, px(41.));
    let lights = browser.view(cx, |view| view.backdrop().lights());
    assert_eq!(lights, Some(point(px(18.), px(23.))));
}

#[gpui::test]
fn closing_a_window_in_the_store_removes_the_gpui_window(cx: &mut TestAppContext) {
    let browser = Browser::open(cx);
    browser.act(
        cx,
        Action::CloseWindow {
            window: browser.window.clone(),
        },
    );
    assert!(browser.handle.read_with(cx, |_, _| ()).is_err());
    assert!(
        browser
            .host
            .calls()
            .contains(&HostCall::Unregister(browser.window.clone()))
    );
}

#[gpui::test]
fn command_t_opens_a_new_tab_and_the_command_panel(cx: &mut TestAppContext) {
    let browser = Browser::open(cx);
    let before = browser.tab_count();
    browser.keys(cx, "cmd-t");
    assert_eq!(browser.tab_count(), before + 1);
    assert!(browser.view(cx, |view| view.panel().is_open()));
    assert!(browser.bounds(cx, "command-panel").is_some());
    assert!(browser.bounds(cx, "new-tab-page").is_some());
    browser.typed(cx, "ardia.dev");
    browser.keys(cx, "enter");
    assert!(!browser.view(cx, |view| view.panel().is_open()));
    let tab = browser.active();
    let navigated = browser.host.calls().into_iter().any(|call| {
        matches!(call, HostCall::Navigate { tab: ref t, ref input, .. } if *t == tab && input.contains("ardia.dev"))
    });
    assert!(navigated, "{:?}", browser.host.calls());
    assert!(
        browser
            .state()
            .tab(tab.as_str())
            .expect("tab")
            .url
            .contains("ardia.dev")
    );
}

#[gpui::test]
fn command_l_preselects_the_url_and_escape_closes_the_panel(cx: &mut TestAppContext) {
    let browser = Browser::open(cx);
    browser.keys(cx, "cmd-l");
    let (open, text, selection) = browser.view(cx, |view| {
        let panel = view.panel();
        (panel.is_open(), String::new(), panel.selected)
    });
    assert!(open);
    let input = browser.view(cx, |view| view.panel().input.clone());
    let (shown, range) = cx.read(|cx| {
        let input = input.read(cx);
        (input.text().to_owned(), input.selection())
    });
    assert_eq!(text, "");
    assert_eq!(selection, None);
    assert_eq!(shown, "https://example.com/docs/start");
    assert_eq!(range, 0..shown.len());
    browser.keys(cx, "escape");
    assert!(!browser.view(cx, |view| view.panel().is_open()));
    let bar = browser
        .state()
        .window(browser.window.as_str())
        .expect("window")
        .chrome
        .command_bar
        .clone();
    assert!(!bar.open);
}

#[gpui::test]
fn the_menu_bar_command_bar_item_opens_the_panel_with_the_url_selected(cx: &mut TestAppContext) {
    let browser = Browser::open(cx);
    browser.act(
        cx,
        Action::SetPopover {
            window: browser.window.clone(),
            popover: Some(ardia_state::windows::Popover::Custom(
                "command:focusCommandBar".into(),
            )),
        },
    );
    assert!(browser.view(cx, |view| view.panel().is_open()));
    let input = browser.view(cx, |view| view.panel().input.clone());
    let shown = cx.read(|cx| input.read(cx).text().to_owned());
    assert_eq!(shown, "https://example.com/docs/start");
    browser.keys(cx, "escape");
    assert!(!browser.view(cx, |view| view.panel().is_open()));
}

#[gpui::test]
fn suggestions_complete_inline_and_navigate_with_the_keyboard(cx: &mut TestAppContext) {
    let browser = Browser::open(cx);
    let profile = browser
        .state()
        .window(browser.window.as_str())
        .expect("window")
        .profile_id
        .clone();
    browser.act(
        cx,
        Action::RecordVisit {
            profile,
            url: "https://github.com/ardia-browser/ardia".into(),
            title: "Ardia on GitHub".into(),
            favicon: None,
        },
    );
    browser.keys(cx, "cmd-l");
    browser.typed(cx, "githu");
    let (items, completion) = browser.view(cx, |view| {
        (
            view.panel().result.items.len(),
            view.panel().result.completion.clone(),
        )
    });
    assert!(items >= 1);
    assert!(
        !completion.is_empty(),
        "inline completion for a history hit"
    );
    let input = browser.view(cx, |view| view.panel().input.clone());
    let (typed, has_completion) = cx.read(|cx| {
        let input = input.read(cx);
        (input.typed().to_owned(), input.has_completion())
    });
    assert_eq!(typed, "githu");
    assert!(has_completion);
    browser.keys(cx, "backspace");
    let has_completion = cx.read(|cx| input.read(cx).has_completion());
    assert!(!has_completion, "deleting removes the inline completion");
    browser.typed(cx, "b");
    let has_completion = cx.read(|cx| input.read(cx).has_completion());
    assert!(has_completion, "typing again brings the completion back");
    browser.keys(cx, "down");
    browser.keys(cx, "up");
    browser.keys(cx, "enter");
    let tab = browser.active();
    let url = browser.state().tab(tab.as_str()).expect("tab").url.clone();
    assert!(
        url.contains("github.com"),
        "{url} after {:?}",
        browser.host.calls()
    );
}

#[gpui::test]
fn late_rows_wait_while_the_pointer_is_over_the_list(cx: &mut TestAppContext) {
    let browser = Browser::open(cx);
    let profile = browser
        .state()
        .window(browser.window.as_str())
        .expect("window")
        .profile_id
        .clone();
    browser.act(
        cx,
        Action::RecordVisit {
            profile,
            url: "https://github.com/ardia-browser/ardia".into(),
            title: "Ardia on GitHub".into(),
            favicon: None,
        },
    );
    browser.keys(cx, "cmd-l");
    browser.typed(cx, "githu");
    let keys = |view: &crate::window::browser_window::BrowserWindowView| {
        view.panel()
            .result
            .items
            .iter()
            .map(|s| s.key())
            .collect::<Vec<_>>()
    };
    let before = browser.view(cx, keys);
    assert!(!before.is_empty());
    let late = |handle: &gpui::WindowHandle<_>, cx: &mut TestAppContext, body: &'static str| {
        handle
            .update(
                cx,
                |view: &mut crate::window::browser_window::BrowserWindowView, _, cx| {
                    let state = std::sync::Arc::clone(&view.state);
                    let window = view.window_id.clone();
                    let (_, _, key) = view
                        .panel
                        .remote_request(&state, &window)
                        .expect("remote suggestions are asked for");
                    view.panel.take_remote(&key, body, &state, &window, 0, cx);
                },
            )
            .expect("open");
    };
    browser
        .handle
        .update(cx, |view, window, cx| {
            view.panel_msg(crate::omnibox::PanelMsg::RowsHovered(true), window, cx)
        })
        .expect("open");
    late(
        &browser.handle,
        cx,
        r#"["githu",["github desktop","github copilot"]]"#,
    );
    assert_eq!(
        browser.view(cx, keys),
        before,
        "rows hold under the pointer"
    );
    assert!(browser.view(cx, |view| view.panel().rows_held()));
    browser.keys(cx, "down");
    let released = browser.view(cx, keys);
    assert_ne!(released, before, "the first arrow shows the waiting rows");
    assert_eq!(browser.view(cx, |view| view.panel().selected_index()), 0);
    late(&browser.handle, cx, r#"["githu",["github desktop"]]"#);
    assert!(
        !browser.view(cx, |view| view.panel().rows_held()),
        "released rows stay free while the pointer rests"
    );
    browser
        .handle
        .update(cx, |view, window, cx| {
            view.panel_msg(crate::omnibox::PanelMsg::RowsHovered(false), window, cx);
            view.panel_msg(crate::omnibox::PanelMsg::RowsHovered(true), window, cx)
        })
        .expect("open");
    let shown = browser.view(cx, keys);
    late(
        &browser.handle,
        cx,
        r#"["githu",["github desktop","github copilot","github status"]]"#,
    );
    assert_eq!(browser.view(cx, keys), shown);
    browser
        .handle
        .update(cx, |view, window, cx| {
            view.panel_msg(crate::omnibox::PanelMsg::RowsHovered(false), window, cx)
        })
        .expect("open");
    assert_ne!(
        browser.view(cx, keys),
        shown,
        "leaving the list shows the waiting rows"
    );
    assert!(!browser.view(cx, |view| view.panel().rows_held()));
}

#[gpui::test]
fn the_folder_title_box_starts_where_the_old_measurer_did(cx: &mut TestAppContext) {
    let browser = Browser::open(cx);
    let first = browser.new_tab(cx, "https://one.example");
    let second = browser.new_tab(cx, "https://two.example");
    browser.act(
        cx,
        Action::CreateGroup {
            tabs: vec![first, second],
            name: "Kyrra".into(),
        },
    );
    browser.redraw(cx);
    let header = browser.bounds(cx, "group-header").expect("folder header");
    let title = browser.bounds(cx, "folder-title").expect("folder title");
    let from_row = f32::from(title.origin.x - header.origin.x);
    use ardia_theme::layout::sidebar;
    assert_eq!(
        from_row,
        sidebar::ROW_CONTENT_LEFT + sidebar::ROW_FAVICON + sidebar::ROW_TITLE_GAP
    );
    assert_eq!(
        sidebar::ROW_TITLE_GAP + crate::primitives::fade_label::LABEL_CELL_INSET,
        sidebar::DIA_ROW_TITLE_GAP,
        "the ink stays where the old label drew it"
    );
}

#[gpui::test]
fn closing_and_reopening_tabs_from_the_keyboard(cx: &mut TestAppContext) {
    let browser = Browser::open(cx);
    browser.new_tab(cx, "https://one.example");
    browser.new_tab(cx, "https://two.example");
    assert_eq!(browser.tab_count(), 3);
    browser.keys(cx, "cmd-w");
    assert_eq!(browser.tab_count(), 2);
    browser.keys(cx, "shift-cmd-t");
    assert_eq!(browser.tab_count(), 3);
    assert!(
        browser
            .state()
            .active_tab(browser.window.as_str())
            .expect("active")
            .url
            .contains("two.example")
    );
    browser.keys(cx, "cmd-1");
    assert!(
        browser
            .state()
            .active_tab(browser.window.as_str())
            .expect("active")
            .url
            .contains("example.com")
    );
    browser.keys(cx, "ctrl-tab");
    browser
        .handle
        .update(cx, |view, window, cx| {
            view.handle(
                crate::msg::Msg::command(crate::sidebar::tab_switcher::COMMIT_ID),
                window,
                cx,
            )
        })
        .expect("open");
    cx.run_until_parked();
    assert!(
        browser
            .state()
            .active_tab(browser.window.as_str())
            .expect("active")
            .url
            .contains("two.example")
    );
}

#[gpui::test]
fn command_s_hides_the_sidebar_and_the_edge_peeks_it_back(cx: &mut TestAppContext) {
    let browser = Browser::open(cx);
    browser.keys(cx, "cmd-s");
    assert!(!browser.state().sidebar_shown(browser.window.as_str()));
    browser
        .handle
        .update(cx, |view, _, _| view.dock.snap(0.0))
        .expect("open");
    browser.redraw(cx);
    assert!(browser.bounds(cx, "sidebar").is_none());
    let card = browser.bounds(cx, "content-card").expect("card");
    assert_eq!(card.origin.x, px(9.));
    let lights = browser
        .view(cx, |view| view.backdrop().lights())
        .expect("lights");
    assert!(lights.x < px(-100.));
    browser
        .handle
        .update(cx, |view, window, cx| {
            view.handle(crate::msg::Msg::EdgeHover(true), window, cx);
            assert!(!view.sidebar_edge.peek.gate.is_out());
            view.handle(crate::msg::Msg::EdgeHover(false), window, cx);
            view.handle(crate::msg::Msg::EdgeHover(true), window, cx);
            view.peek.snap(1.0);
        })
        .expect("open");
    browser.redraw(cx);
    let peek = browser
        .bounds(cx, "peek-sidebar")
        .expect("the floating sidebar");
    assert_eq!(peek.origin, point(px(9.), px(9.)));
    assert!(
        browser
            .state()
            .window(browser.window.as_str())
            .expect("window")
            .chrome
            .sidebar_peeking
    );
    browser.keys(cx, "cmd-s");
    assert!(browser.state().sidebar_shown(browser.window.as_str()));
}

#[gpui::test]
fn the_sidebar_peek_closes_two_hundred_ms_after_the_pointer_leaves(cx: &mut TestAppContext) {
    let browser = Browser::open(cx);
    browser.keys(cx, "cmd-s");
    browser
        .handle
        .update(cx, |view, _, _| view.dock.snap(0.0))
        .expect("open");
    browser.redraw(cx);
    let peeking = || {
        browser
            .state()
            .window(browser.window.as_str())
            .expect("window")
            .chrome
            .sidebar_peeking
    };
    browser
        .handle
        .update(cx, |view, window, cx| {
            view.handle(crate::msg::Msg::EdgeHover(false), window, cx);
            view.handle(crate::msg::Msg::EdgeHover(true), window, cx);
            view.handle(crate::msg::Msg::EdgeHover(false), window, cx);
        })
        .expect("open");
    cx.run_until_parked();
    assert!(peeking());
    cx.executor()
        .advance_clock(std::time::Duration::from_millis(150));
    cx.run_until_parked();
    assert!(peeking());
    browser
        .handle
        .update(cx, |view, window, cx| {
            view.handle(crate::msg::Msg::EdgeHover(true), window, cx);
            view.handle(crate::msg::Msg::EdgeHover(false), window, cx);
        })
        .expect("open");
    cx.executor()
        .advance_clock(std::time::Duration::from_millis(150));
    cx.run_until_parked();
    assert!(peeking());
    cx.executor()
        .advance_clock(std::time::Duration::from_millis(60));
    cx.run_until_parked();
    assert!(!peeking());
}

#[gpui::test]
fn the_tab_layouts_swap_between_sidebar_top_strip_and_arc(cx: &mut TestAppContext) {
    let browser = Browser::open(cx);
    browser.keys(cx, "shift-cmd-s");
    assert!(browser.bounds(cx, "tab-strip").is_some());
    assert!(browser.bounds(cx, "sidebar").is_none());
    let card = browser.bounds(cx, "content-card").expect("card");
    assert_eq!(card.origin.y, px(42.));
    browser.keys(cx, "shift-cmd-s");
    assert!(browser.bounds(cx, "sidebar").is_some());
    browser.act(
        cx,
        Action::UpdateSettings {
            patch: ardia_state::settings::SettingsPatch::new().set("addressBar", "sidebar"),
            from_sync: false,
        },
    );
    assert!(browser.bounds(cx, "toolbar").is_none());
    let card = browser.bounds(cx, "content-card").expect("card");
    assert_eq!(card.origin.y, px(9.));
    assert_eq!(
        browser.view(cx, |view| view.chrome_layout().map(|l| l.layout)),
        Some(ardia_state::model::EffectiveLayout::ArcSidebar)
    );
}

#[gpui::test]
fn switching_profiles_repaints_the_backdrop_and_the_tabs(cx: &mut TestAppContext) {
    let browser = Browser::open(cx);
    browser.act(
        cx,
        Action::CreateProfile {
            name: "Work".into(),
            color: Some(ardia_theme::ProfileColor::Green),
            icon: None,
        },
    );
    let before = browser
        .view(cx, |view| view.backdrop().target().copied())
        .expect("a backdrop");
    browser.keys(cx, "ctrl-2");
    let state = browser.state();
    let window = state.window(browser.window.as_str()).expect("window");
    assert_eq!(window.profile_id, state.profile_order[1]);
    let after = browser
        .view(cx, |view| view.backdrop().target().copied())
        .expect("a backdrop");
    assert_ne!(before.top, after.top);
    assert_eq!(state.view_tabs(browser.window.as_str(), None).len(), 1);
    browser.keys(cx, "ctrl-1");
    assert_eq!(
        browser
            .state()
            .window(browser.window.as_str())
            .expect("window")
            .profile_id,
        state.profile_order[0]
    );
}

#[gpui::test]
fn clearing_unpinned_tabs_offers_an_undo_toast(cx: &mut TestAppContext) {
    let browser = Browser::open(cx);
    browser.new_tab(cx, "https://one.example");
    browser.new_tab(cx, "https://two.example");
    browser.new_tab(cx, "https://three.example");
    assert_eq!(browser.tab_count(), 4);
    let divider = browser.bounds(cx, "clear-divider").expect("the divider");
    let mut visual = gpui::VisualTestContext::from_window(browser.handle.into(), cx);
    visual.simulate_mouse_move(divider.center(), None, gpui::Modifiers::none());
    visual.run_until_parked();
    browser.click(cx, "clear-unpinned");
    assert_eq!(browser.tab_count(), 1);
    let toasts = browser
        .state()
        .window(browser.window.as_str())
        .expect("window")
        .chrome
        .toasts
        .clone();
    assert_eq!(toasts.len(), 1);
    assert_eq!(toasts[0].message, "Cleared 3 Tabs");
    assert!(browser.bounds(cx, "toasts").is_some());
    browser.keys(cx, "shift-cmd-k");
    assert_eq!(browser.tab_count(), 1, "nothing left to clear");
    browser
        .handle
        .update(cx, |view, window, cx| {
            view.handle(
                crate::msg::Msg::ToastAction {
                    id: toasts[0].id,
                    command: "undoClearTabs".into(),
                },
                window,
                cx,
            )
        })
        .expect("open");
    cx.run_until_parked();
    assert_eq!(browser.tab_count(), 4);
    assert!(
        browser
            .state()
            .window(browser.window.as_str())
            .expect("window")
            .chrome
            .toasts
            .is_empty()
    );
}

#[gpui::test]
fn toasts_expire_on_their_own(cx: &mut TestAppContext) {
    let browser = Browser::open(cx);
    browser.keys(cx, "shift-cmd-c");
    assert_eq!(
        browser
            .state()
            .window(browser.window.as_str())
            .expect("window")
            .chrome
            .toasts
            .len(),
        1
    );
    assert_eq!(
        cx.read_from_clipboard()
            .and_then(|item| item.text())
            .as_deref(),
        Some("https://example.com/docs/start")
    );
    cx.executor()
        .advance_clock(std::time::Duration::from_millis(
            crate::popovers::toast::TOAST_MS as u64 + 500,
        ));
    cx.run_until_parked();
    assert!(
        browser
            .state()
            .window(browser.window.as_str())
            .expect("window")
            .chrome
            .toasts
            .is_empty()
    );
}

#[gpui::test]
fn a_focused_toast_button_keeps_a_two_button_toast_open(cx: &mut TestAppContext) {
    let browser = Browser::open(cx);
    let now = ardia_state::store::now_ms();
    let toast = ardia_state::windows::Toast {
        id: 4242,
        kind: ardia_state::windows::ToastKind::Info,
        message: "“Spinner” is using a lot of power".into(),
        action: Some("busyTab:4242".into()),
        icon: Some("bolt.fill".into()),
        created_at: now,
        expires_at: Some(now + 20_000),
    };
    let window = browser.window.clone();
    let shown = |browser: &Browser| {
        browser
            .state()
            .window(browser.window.as_str())
            .expect("window")
            .chrome
            .toasts
            .iter()
            .any(|t| t.id == 4242)
    };
    browser
        .handle
        .update(cx, |view, window_ref, cx| {
            window_ref.focus(&view.focus, cx);
            view.handle(
                crate::msg::Msg::Store(ardia_state::actions::Action::PushToast {
                    window: window.clone(),
                    toast: toast.clone(),
                }),
                window_ref,
                cx,
            )
        })
        .expect("open");
    cx.run_until_parked();
    assert!(shown(&browser));
    browser.keys(cx, "tab");
    assert_eq!(
        browser.view(cx, |view| view.ui().toast_hold.focused),
        Some(4242),
        "Tab moves focus onto the toast's first button"
    );
    cx.executor()
        .advance_clock(std::time::Duration::from_millis(30_000));
    cx.run_until_parked();
    assert!(shown(&browser), "a focused button holds the toast open");
    browser.keys(cx, "tab");
    assert_eq!(
        browser.view(cx, |view| view.ui().toast_hold.focused),
        Some(4242)
    );
    browser
        .handle
        .update(cx, |view, window_ref, cx| window_ref.focus(&view.focus, cx))
        .expect("open");
    cx.run_until_parked();
    let hold = browser.view(cx, |view| view.ui().toast_hold);
    assert_eq!(hold.focused, None);
    assert!(hold.restarted.is_some_and(|(id, _)| id == 4242));
    assert!(shown(&browser), "leaving restarts the full hold");
    cx.executor()
        .advance_clock(std::time::Duration::from_millis(30_000));
    cx.run_until_parked();
    assert!(!shown(&browser), "the toast closes once nothing holds it");
}

#[gpui::test]
fn pins_groups_and_splits_reshape_the_sidebar(cx: &mut TestAppContext) {
    let browser = Browser::open(cx);
    let first = browser.active();
    let second = browser.new_tab(cx, "https://two.example");
    let third = browser.new_tab(cx, "https://three.example");
    browser.keys(cx, "cmd-1");
    assert_eq!(browser.active(), first);
    browser
        .handle
        .update(cx, |view, window, cx| {
            view.run_command("togglePin", window, cx)
        })
        .expect("open");
    cx.run_until_parked();
    assert!(
        browser
            .state()
            .tab(first.as_str())
            .expect("tab")
            .is_pinned()
    );
    assert!(browser.bounds(cx, "pinned-grid").is_some() || browser.bounds(cx, "sidebar").is_some());
    browser.act(
        cx,
        Action::CreateGroup {
            tabs: vec![second.clone(), third.clone()],
            name: "Reading".into(),
        },
    );
    let sections = crate::sidebar::model::sections(&browser.state(), browser.window.as_str());
    assert_eq!(sections.tiles.len(), 1);
    assert!(sections
        .unpinned
        .iter()
        .any(|entry| matches!(entry, crate::sidebar::model::Entry::Group { group, .. } if group.name == "Reading")));
    browser.act(
        cx,
        Action::RemoveFromGroups {
            tabs: vec![second.clone(), third.clone()],
        },
    );
    browser.act(
        cx,
        Action::SplitTabs {
            tabs: vec![second.clone(), third],
            orientation: ardia_state::model::Orientation::Horizontal,
        },
    );
    browser.act(
        cx,
        Action::ActivateTab {
            tab: second.clone(),
        },
    );
    let split = browser.bounds(cx, "split-view").expect("a split view");
    let card = browser.bounds(cx, "content-card").expect("card");
    assert_eq!(split.origin.x, card.origin.x);
    let split_id = browser
        .state()
        .split_of(second.as_str())
        .expect("split")
        .id
        .clone();
    browser
        .handle
        .update(cx, |view, window, cx| {
            view.handle(
                crate::msg::Msg::SplitDrag {
                    split: split_id.clone(),
                    handle: 0,
                    fraction: 0.7,
                },
                window,
                cx,
            )
        })
        .expect("open");
    cx.run_until_parked();
    let sizes: Vec<f64> = browser
        .state()
        .split(split_id.as_str())
        .expect("split")
        .slots
        .iter()
        .map(|slot| slot.size())
        .collect();
    assert!((sizes[0] - 0.7).abs() < 1e-6, "{sizes:?}");
}

#[gpui::test]
fn popovers_open_from_the_toolbar_and_the_sidebar(cx: &mut TestAppContext) {
    let browser = Browser::open(cx);
    browser.act(
        cx,
        Action::UpsertDownload {
            download: Box::new(ardia_state::downloads::Download {
                id: ardia_state::DownloadId::new("d-1"),
                url: "https://example.com/file.zip".into(),
                filename: "file.zip".into(),
                path: "/tmp/file.zip".into(),
                state: ardia_state::downloads::DownloadState::Downloading,
                paused: false,
                dangerous: None,
                received: 5_000_000.0,
                total: 10_000_000.0,
                speed: 1_000_000.0,
                mime_type: "application/zip".into(),
                profile: None,
                off_the_record: None,
                staging: None,
                start_time: None,
                extra: Default::default(),
            }),
        },
    );
    browser.click(cx, "downloads-button");
    assert!(browser.bounds(cx, "downloads-popover").is_some());
    browser
        .handle
        .update(cx, |view, window, cx| {
            view.handle(
                crate::msg::Msg::Download {
                    id: "d-1".into(),
                    command: ardia_engine::DownloadCommand::Pause,
                },
                window,
                cx,
            )
        })
        .expect("open");
    assert!(browser.host.calls().contains(&HostCall::Download {
        id: "d-1".into(),
        command: ardia_engine::DownloadCommand::Pause,
    }));
    browser.keys(cx, "escape");
    assert!(
        browser
            .state()
            .window(browser.window.as_str())
            .expect("window")
            .chrome
            .popover
            .is_none()
    );
    browser
        .handle
        .update(cx, |view, window, cx| {
            view.handle(
                crate::msg::Msg::TogglePopover(ardia_state::windows::Popover::SiteControls),
                window,
                cx,
            )
        })
        .expect("open");
    cx.run_until_parked();
    assert!(browser.bounds(cx, "site-controls").is_some());
    let tab = browser.active();
    browser
        .handle
        .update(cx, |view, window, cx| {
            view.handle(
                crate::msg::Msg::Zoom {
                    tab: tab.clone(),
                    step: 1,
                },
                window,
                cx,
            )
        })
        .expect("open");
    cx.run_until_parked();
    assert_eq!(browser.state().tab(tab.as_str()).expect("tab").zoom, 1.1);
    browser.keys(cx, "cmd-0");
    assert_eq!(browser.state().tab(tab.as_str()).expect("tab").zoom, 1.0);
}

#[gpui::test]
fn find_in_page_counts_matches_and_steps_through_them(cx: &mut TestAppContext) {
    let browser = Browser::open(cx);
    browser.keys(cx, "cmd-f");
    assert!(browser.bounds(cx, "find-bar").is_some());
    browser.typed(cx, "docs");
    let tab = browser.active();
    let find = browser
        .state()
        .tab(tab.as_str())
        .expect("tab")
        .live
        .find
        .clone();
    assert!(find.open);
    assert_eq!(find.query, "docs");
    assert_eq!(find.count, Some(3));
    assert_eq!(find.active, 1);
    browser.keys(cx, "enter");
    assert_eq!(
        browser
            .state()
            .tab(tab.as_str())
            .expect("tab")
            .live
            .find
            .active,
        2
    );
    browser.keys(cx, "shift-enter");
    assert_eq!(
        browser
            .state()
            .tab(tab.as_str())
            .expect("tab")
            .live
            .find
            .active,
        1
    );
    browser.keys(cx, "escape");
    assert!(
        !browser
            .state()
            .tab(tab.as_str())
            .expect("tab")
            .live
            .find
            .open
    );
    assert!(browser.host.calls().contains(&HostCall::StopFinding(tab)));
}

#[gpui::test]
fn the_tab_context_menu_renames_and_mutes(cx: &mut TestAppContext) {
    let browser = Browser::open(cx);
    let tab = browser.active();
    browser
        .handle
        .update(cx, |view, window, cx| {
            view.handle(
                crate::msg::Msg::Menu(Some((
                    crate::msg::MenuTarget::Tab(tab.clone()),
                    point(px(60.), px(80.)),
                ))),
                window,
                cx,
            )
        })
        .expect("open");
    cx.run_until_parked();
    assert!(browser.bounds(cx, "context-menu").is_some());
    browser
        .handle
        .update(cx, |view, window, cx| {
            view.handle(
                crate::msg::Msg::Rename(Some(crate::msg::RenameTarget::Tab(tab.clone()))),
                window,
                cx,
            )
        })
        .expect("open");
    cx.run_until_parked();
    assert!(browser.bounds(cx, "context-menu").is_none());
    browser.typed(cx, "Docs Home");
    browser.keys(cx, "enter");
    assert_eq!(
        browser
            .state()
            .tab(tab.as_str())
            .expect("tab")
            .custom_title
            .as_deref(),
        Some("Docs Home")
    );
    browser
        .handle
        .update(cx, |view, window, cx| {
            view.handle(
                crate::msg::Msg::Mute {
                    tab: tab.clone(),
                    muted: true,
                },
                window,
                cx,
            )
        })
        .expect("open");
    assert!(browser.state().tab(tab.as_str()).expect("tab").muted);
}

#[gpui::test]
fn site_prompts_resolve_through_the_host(cx: &mut TestAppContext) {
    let browser = Browser::open(cx);
    let tab = browser.active();
    browser.act(
        cx,
        Action::SetPrompts {
            tab: tab.clone(),
            prompts: vec![ardia_state::tabs::SitePrompt::Permission {
                kind: ardia_state::tabs::PermissionKind::Camera,
                origin: "https://meet.example".into(),
            }],
        },
    );
    assert!(browser.bounds(cx, "site-prompts").is_some());
    browser
        .handle
        .update(cx, |view, window, cx| {
            view.handle(
                crate::msg::Msg::Permission {
                    request: crate::popovers::prompts::request_id(
                        &view.state().tab(tab.as_str()).cloned().expect("tab"),
                        0,
                    ),
                    result: ardia_engine::PermissionResult::Accept,
                    remember: true,
                },
                window,
                cx,
            )
        })
        .expect("open");
    assert!(browser.host.calls().iter().any(|call| matches!(
        call,
        HostCall::Permission { request, result: ardia_engine::PermissionResult::Accept, .. } if request.ends_with("#0")
    )));
}

#[gpui::test]
fn dragging_the_sidebar_edge_resizes_it_within_limits(cx: &mut TestAppContext) {
    let browser = Browser::open(cx);
    browser
        .handle
        .update(cx, |view, window, cx| {
            view.handle(crate::msg::Msg::SidebarWidth(260.0), window, cx);
            view.handle(crate::msg::Msg::SidebarResized, window, cx)
        })
        .expect("open");
    cx.run_until_parked();
    assert_eq!(browser.state().settings.sidebar_width, 260.0);
    assert_eq!(
        browser.bounds(cx, "sidebar").expect("sidebar").size.width,
        px(260.)
    );
    browser
        .handle
        .update(cx, |view, window, cx| {
            view.handle(crate::msg::Msg::SidebarWidth(20.0), window, cx);
            view.handle(crate::msg::Msg::SidebarResized, window, cx)
        })
        .expect("open");
    cx.run_until_parked();
    assert_eq!(
        browser.state().settings.sidebar_width,
        f64::from(ardia_theme::layout::SIDEBAR_MIN_WIDTH)
    );
}

#[gpui::test]
fn the_peek_card_opens_over_the_page_and_closes_with_escape(cx: &mut TestAppContext) {
    let browser = Browser::open(cx);
    browser.act(
        cx,
        Action::OpenPeek {
            window: browser.window.clone(),
            url: "https://peek.example".into(),
            source: None,
        },
    );
    assert!(browser.bounds(cx, "peek-overlay").is_some());
    browser.keys(cx, "escape");
    assert!(browser.bounds(cx, "peek-overlay").is_none());
    let before = browser.tab_count();
    browser.act(
        cx,
        Action::OpenPeek {
            window: browser.window.clone(),
            url: "https://kept.example".into(),
            source: None,
        },
    );
    browser.keys(cx, "cmd-o");
    browser.settle_peek(cx);
    assert!(browser.bounds(cx, "peek-overlay").is_none());
    assert_eq!(browser.tab_count(), before + 1);
    assert!(
        browser
            .state()
            .active_tab(browser.window.as_str())
            .expect("active")
            .url
            .contains("kept.example")
    );
}

#[gpui::test]
fn native_page_views_mount_with_the_frame_radius(cx: &mut TestAppContext) {
    let browser = Browser::open_with(cx, |_| {});
    let tab = browser.active();
    browser.host.set_native_views(
        tab.clone(),
        Some(ardia_engine::NativeViewHandle(
            std::ptr::NonNull::<u8>::dangling().as_ptr().cast(),
        )),
        None,
    );
    browser.redraw(cx);
    let corners = browser
        .handle
        .read_with(cx, |view, cx| view.natives.corners(&tab, cx))
        .expect("open");
    assert_eq!(
        corners,
        Some(gpui::Corners {
            top_left: px(0.),
            top_right: px(0.),
            bottom_right: px(8.5),
            bottom_left: px(8.5),
        })
    );
    assert!(browser.bounds(cx, "web-placeholder").is_none());
}

#[gpui::test]
fn every_core_shortcut_reaches_its_command(cx: &mut TestAppContext) {
    let browser = Browser::open(cx);
    let tab = browser.active();
    let windows = |browser: &Browser| browser.state().window_order.len();
    let before = windows(&browser);
    browser.keys(cx, "cmd-n");
    assert_eq!(windows(&browser), before + 1);
    browser.keys(cx, "shift-cmd-n");
    assert!(
        browser
            .state()
            .windows
            .values()
            .any(|w| w.kind == WindowKind::Incognito)
    );
    browser.keys(cx, "alt-cmd-n");
    assert!(
        browser
            .state()
            .windows
            .values()
            .any(|w| w.kind == WindowKind::LittleArdia)
    );
    browser.keys(cx, "cmd-r");
    browser.keys(cx, "shift-cmd-r");
    browser.keys(cx, "cmd-[");
    browser.keys(cx, "cmd-]");
    browser.keys(cx, "alt-cmd-i");
    browser.keys(cx, "cmd-,");
    let calls = browser.host.calls();
    for expected in [
        HostCall::Reload {
            tab: tab.clone(),
            hard: false,
        },
        HostCall::Reload {
            tab: tab.clone(),
            hard: true,
        },
        HostCall::Back(tab.clone()),
        HostCall::Forward(tab.clone()),
        HostCall::DevTools(tab.clone()),
        HostCall::Utility(crate::UtilityWindowKind::Settings),
    ] {
        assert!(
            calls.contains(&expected),
            "{expected:?} missing from {calls:?}"
        );
    }
    browser.keys(cx, "cmd-=");
    assert_eq!(browser.state().tab(tab.as_str()).expect("tab").zoom, 1.1);
    browser.keys(cx, "cmd--");
    assert_eq!(browser.state().tab(tab.as_str()).expect("tab").zoom, 1.0);
    browser.keys(cx, "cmd-d");
    let profile = browser
        .state()
        .tab(tab.as_str())
        .expect("tab")
        .profile_id
        .clone();
    assert!(
        browser
            .state()
            .bookmarks_of(&profile)
            .is_some_and(|tree| tree.find_url("https://example.com/docs/start").is_some())
    );
    browser.keys(cx, "shift-cmd-w");
    assert!(
        browser
            .host
            .calls()
            .contains(&HostCall::CloseWindow(browser.window.clone()))
    );
}

#[gpui::test]
fn control_arrows_step_through_profiles(cx: &mut TestAppContext) {
    let browser = Browser::open(cx);
    browser.act(
        cx,
        Action::CreateProfile {
            name: "Work".into(),
            color: Some(ardia_theme::ProfileColor::Blue),
            icon: None,
        },
    );
    let order = browser.state().profile_order.clone();
    browser.keys(cx, "alt-cmd-right");
    assert_eq!(
        browser
            .state()
            .window(browser.window.as_str())
            .expect("window")
            .profile_id,
        order[1]
    );
    browser.keys(cx, "alt-cmd-left");
    assert_eq!(
        browser
            .state()
            .window(browser.window.as_str())
            .expect("window")
            .profile_id,
        order[0]
    );
}

#[gpui::test]
fn a_click_outside_a_popover_closes_it_and_the_popover_itself_stays_clickable(
    cx: &mut TestAppContext,
) {
    let browser = Browser::open(cx);
    browser
        .handle
        .update(cx, |view, window, cx| {
            view.handle(
                crate::msg::Msg::TogglePopover(ardia_state::windows::Popover::SiteControls),
                window,
                cx,
            )
        })
        .expect("open");
    cx.run_until_parked();
    let tab = browser.active();
    browser.click(cx, "site-controls");
    assert!(
        browser.bounds(cx, "site-controls").is_some(),
        "clicking the panel keeps it open"
    );
    browser.click(cx, "sidebar-empty");
    assert!(
        browser
            .state()
            .window(browser.window.as_str())
            .is_some_and(|w| w.chrome.popover.is_none())
    );
    assert!(
        browser.bounds(cx, "site-controls").is_some(),
        "the closed panel stays on screen while it fades out"
    );
    std::thread::sleep(
        crate::primitives::tokens::duration::FAST + std::time::Duration::from_millis(20),
    );
    browser.redraw(cx);
    assert!(browser.bounds(cx, "site-controls").is_none());
    assert_eq!(browser.active(), tab);
}

#[gpui::test]
fn double_clicking_empty_sidebar_space_opens_a_new_tab(cx: &mut TestAppContext) {
    let browser = Browser::open(cx);
    let before = browser.tab_count();
    let empty = browser
        .bounds(cx, "sidebar-empty")
        .expect("empty space below the tabs");
    let mut visual = gpui::VisualTestContext::from_window(browser.handle.into(), cx);
    visual.simulate_event(gpui::MouseDownEvent {
        button: gpui::MouseButton::Left,
        position: empty.center(),
        modifiers: gpui::Modifiers::none(),
        click_count: 2,
        first_mouse: false,
    });
    visual.run_until_parked();
    assert_eq!(browser.tab_count(), before + 1);
}

#[gpui::test]
fn hiding_tabs_in_the_top_strip_layout_hides_the_strip(cx: &mut TestAppContext) {
    let browser = Browser::open(cx);
    browser.keys(cx, "shift-cmd-s");
    assert!(browser.bounds(cx, "tab-strip").is_some());
    browser.keys(cx, "cmd-s");
    assert!(browser.bounds(cx, "tab-strip").is_none());
    assert_eq!(
        browser.bounds(cx, "content-card").expect("card").origin.y,
        px(9.)
    );
    assert!(
        browser
            .view(cx, |view| view.backdrop().lights())
            .expect("lights")
            .x
            < px(-100.)
    );
}

fn handle_of(raw: usize) -> ardia_engine::NativeViewHandle {
    ardia_engine::NativeViewHandle(raw as *mut std::ffi::c_void)
}

#[gpui::test]
fn clicks_on_the_page_reach_its_native_view(cx: &mut TestAppContext) {
    let browser = Browser::open(cx);
    let tab = browser.active();
    let raw = std::ptr::NonNull::<u16>::dangling().as_ptr() as usize;
    browser
        .host
        .set_native_views(tab, Some(handle_of(raw)), None);
    browser.redraw(cx);
    let page = browser.bounds(cx, "page").expect("the page is laid out");
    assert!(
        cx.hit_test_native_view(browser.handle.into(), page.center())
            .is_some(),
        "a press on the page goes to its web view, not to GPUI"
    );
}

#[gpui::test]
fn a_native_view_moves_between_windows_without_being_torn_out(cx: &mut TestAppContext) {
    let browser = Browser::open(cx);
    let tab = browser.active();
    let raw = std::ptr::NonNull::<u64>::dangling().as_ptr() as usize;
    browser
        .host
        .set_native_views(tab.clone(), Some(handle_of(raw)), None);
    browser.redraw(cx);
    let first = browser
        .handle
        .update(cx, |_, window, _| window.window_handle().window_id())
        .expect("open");
    assert_eq!(
        cx.read(|cx| crate::window::native_views::NativeViews::owner_of(handle_of(raw), cx)),
        Some(first)
    );
    browser.new_tab(cx, "https://stays.example");
    browser.act(cx, Action::ActivateTab { tab: tab.clone() });
    let other = browser
        .host
        .open_window(WindowKind::Main, Some("https://two.example"))
        .expect("a window");
    let shared: std::sync::Arc<dyn crate::UiHost> = browser.host.clone();
    let second = cx
        .update(|cx| {
            crate::open_browser_window(
                shared,
                crate::OpenWindowTarget {
                    window_id: other.clone(),
                    ..crate::OpenWindowTarget::default()
                },
                cx,
            )
        })
        .expect("opens")
        .downcast::<crate::BrowserWindowView>()
        .expect("browser");
    cx.run_until_parked();
    browser
        .host
        .store()
        .dispatch(Action::MoveTab {
            tab: tab.clone(),
            window: other,
            index: 0,
        })
        .expect("moves");
    let second_id = second
        .update(cx, |view, window, cx| {
            view.handle(
                crate::msg::Msg::Store(Action::ActivateTab { tab: tab.clone() }),
                window,
                cx,
            );
            window.refresh();
            window.window_handle().window_id()
        })
        .expect("open");
    cx.run_until_parked();
    assert_eq!(
        cx.read(|cx| crate::window::native_views::NativeViews::owner_of(handle_of(raw), cx)),
        Some(second_id)
    );
    browser.redraw(cx);
    assert_eq!(
        cx.read(|cx| crate::window::native_views::NativeViews::owner_of(handle_of(raw), cx)),
        Some(second_id),
        "the old window lets go without taking the view back"
    );
}

#[gpui::test]
fn focusing_a_native_pane_makes_it_the_active_tab(cx: &mut TestAppContext) {
    let browser = Browser::open(cx);
    let left = browser.active();
    let right = browser.new_tab(cx, "https://right.example");
    let raw = std::ptr::NonNull::<u32>::dangling().as_ptr() as usize;
    browser
        .host
        .set_native_views(left.clone(), Some(handle_of(raw)), None);
    browser
        .host
        .set_native_views(right.clone(), Some(handle_of(raw + 64)), None);
    browser.act(
        cx,
        Action::SplitTabs {
            tabs: vec![left.clone(), right.clone()],
            orientation: ardia_state::model::Orientation::Horizontal,
        },
    );
    browser.act(cx, Action::ActivateTab { tab: left });
    browser.redraw(cx);
    browser
        .handle
        .update(cx, |view, window, cx| {
            let handle = view
                .natives
                .focus_handle(&right, cx)
                .expect("the right pane is attached");
            window.focus(&handle, cx);
        })
        .expect("open");
    cx.run_until_parked();
    browser.redraw(cx);
    assert_eq!(browser.active(), right);
}

#[gpui::test]
fn shift_ranges_keep_their_original_anchor(cx: &mut TestAppContext) {
    let browser = Browser::open(cx);
    let a = browser.active();
    let b = browser.new_tab(cx, "https://b.example");
    let c = browser.new_tab(cx, "https://c.example");
    let d = browser.new_tab(cx, "https://d.example");
    let e = browser.new_tab(cx, "https://e.example");
    browser.act(cx, Action::ActivateTab { tab: c.clone() });
    let pick = |browser: &Browser, cx: &mut TestAppContext, tab: &ardia_state::TabId| {
        browser
            .handle
            .update(cx, |view, window, cx| {
                view.handle(
                    crate::msg::Msg::PickTab {
                        tab: tab.clone(),
                        toggle: false,
                        range: true,
                    },
                    window,
                    cx,
                )
            })
            .expect("open");
        cx.run_until_parked();
    };
    pick(&browser, cx, &a);
    let selection = browser
        .state()
        .window(browser.window.as_str())
        .expect("window")
        .chrome
        .selection
        .clone();
    assert_eq!(selection.len(), 3);
    assert!(selection.contains(&a) && selection.contains(&b) && selection.contains(&c));
    pick(&browser, cx, &e);
    let selection = browser
        .state()
        .window(browser.window.as_str())
        .expect("window")
        .chrome
        .selection
        .clone();
    assert_eq!(selection, vec![c, d, e]);
}

#[gpui::test]
fn dropping_a_grouped_tab_elsewhere_lands_where_it_was_dropped(cx: &mut TestAppContext) {
    let browser = Browser::open(cx);
    let b = browser.new_tab(cx, "https://b.example");
    let c = browser.new_tab(cx, "https://c.example");
    let _d = browser.new_tab(cx, "https://d.example");
    let _e = browser.new_tab(cx, "https://e.example");
    let f = browser.new_tab(cx, "https://f.example");
    browser.act(
        cx,
        Action::CreateGroup {
            tabs: vec![b, c.clone()],
            name: "Pair".into(),
        },
    );
    browser
        .handle
        .update(cx, |view, window, cx| {
            view.handle(
                crate::msg::Msg::DropTab {
                    tab: c.clone(),
                    before: Some(f.clone()),
                    group: None,
                    pin: Some(false),
                },
                window,
                cx,
            )
        })
        .expect("open");
    cx.run_until_parked();
    let state = browser.state();
    let order = &state
        .window(browser.window.as_str())
        .expect("window")
        .tab_ids;
    let at = |id: &ardia_state::TabId| order.iter().position(|t| t == id).expect("listed");
    assert_eq!(at(&c) + 1, at(&f), "{order:?}");
    assert!(state.group_of(c.as_str()).is_none());
}

#[gpui::test]
fn the_command_bar_honours_the_tab_it_was_opened_for(cx: &mut TestAppContext) {
    let browser = Browser::open(cx);
    let blank = browser.new_tab(cx, "");
    let count = browser.tab_count();
    browser.act(
        cx,
        Action::SetCommandBar {
            window: browser.window.clone(),
            state: ardia_state::windows::CommandBarState {
                open: true,
                initial_text: String::new(),
                new_tab: Some(ardia_state::windows::NewTabTarget::Into(blank.clone())),
                placement: ardia_state::windows::CommandBarPlacementState::Field,
            },
        },
    );
    assert!(browser.view(cx, |view| view.panel().is_open()));
    browser.typed(cx, "into.example");
    browser.keys(cx, "enter");
    assert_eq!(browser.tab_count(), count, "no extra tab");
    assert!(
        browser
            .state()
            .tab(blank.as_str())
            .expect("tab")
            .url
            .contains("into.example")
    );
}

#[gpui::test]
fn a_new_command_bar_request_replaces_the_open_one(cx: &mut TestAppContext) {
    let browser = Browser::open(cx);
    browser.keys(cx, "cmd-l");
    browser.act(
        cx,
        Action::SetCommandBar {
            window: browser.window.clone(),
            state: ardia_state::windows::CommandBarState {
                open: true,
                initial_text: "replaced".into(),
                new_tab: None,
                placement: ardia_state::windows::CommandBarPlacementState::Field,
            },
        },
    );
    let input = browser.view(cx, |view| view.panel().input.clone());
    assert_eq!(cx.read(|cx| input.read(cx).text().to_owned()), "replaced");
}

#[gpui::test]
fn find_follows_the_active_tab_and_clears_cleanly(cx: &mut TestAppContext) {
    let browser = Browser::open(cx);
    let first = browser.active();
    browser.keys(cx, "cmd-f");
    browser.typed(cx, "alpha");
    let second = browser.new_tab(cx, "https://second.example");
    browser.keys(cx, "cmd-f");
    browser.typed(cx, "beta");
    browser.act(cx, Action::ActivateTab { tab: first.clone() });
    let input = browser.view(cx, |view| view.find_input.clone());
    assert_eq!(cx.read(|cx| input.read(cx).text().to_owned()), "alpha");
    browser.keys(cx, "cmd-f");
    browser.keys(cx, "backspace");
    let find = browser
        .state()
        .tab(first.as_str())
        .expect("tab")
        .live
        .find
        .clone();
    assert!(find.open && find.query.is_empty());
    let calls = browser.host.calls();
    let stop = calls
        .iter()
        .rposition(|call| *call == HostCall::StopFinding(first.clone()));
    assert!(stop.is_some());
    assert_eq!(
        browser
            .state()
            .tab(second.as_str())
            .expect("tab")
            .live
            .find
            .query,
        "beta"
    );
}

#[gpui::test]
fn renaming_in_the_top_strip_shows_the_editor(cx: &mut TestAppContext) {
    let browser = Browser::open(cx);
    browser.keys(cx, "shift-cmd-s");
    let tab = browser.active();
    browser
        .handle
        .update(cx, |view, window, cx| {
            view.handle(
                crate::msg::Msg::Rename(Some(crate::msg::RenameTarget::Tab(tab.clone()))),
                window,
                cx,
            )
        })
        .expect("open");
    cx.run_until_parked();
    assert!(browser.bounds(cx, "rename-input").is_some());
    browser.typed(cx, "Strip");
    browser.keys(cx, "enter");
    assert_eq!(
        browser
            .state()
            .tab(tab.as_str())
            .expect("tab")
            .custom_title
            .as_deref(),
        Some("Strip")
    );
}

#[gpui::test]
fn closing_with_a_download_in_flight_asks_first(cx: &mut TestAppContext) {
    let browser = Browser::open(cx);
    browser.act(
        cx,
        Action::UpsertDownload {
            download: Box::new(ardia_state::downloads::Download {
                id: ardia_state::DownloadId::new("d-2"),
                url: "https://example.com/big.iso".into(),
                filename: "big.iso".into(),
                path: String::new(),
                state: ardia_state::downloads::DownloadState::Downloading,
                paused: false,
                dangerous: None,
                received: 1.0,
                total: 10.0,
                speed: 0.0,
                mime_type: String::new(),
                profile: None,
                off_the_record: None,
                staging: None,
                start_time: None,
                extra: Default::default(),
            }),
        },
    );
    let mut visual = gpui::VisualTestContext::from_window(browser.handle.into(), cx);
    assert!(
        !visual.simulate_close(),
        "the red button waits for the store"
    );
    visual.run_until_parked();
    assert!(
        !browser
            .host
            .calls()
            .contains(&HostCall::CloseWindow(browser.window.clone()))
    );
    assert!(browser.view(cx, |view| view.confirm_close));
    browser
        .handle
        .update(cx, |view, window, cx| {
            view.handle(crate::msg::Msg::ConfirmClose(true), window, cx)
        })
        .expect("open");
    cx.run_until_parked();
    assert!(
        browser
            .host
            .calls()
            .contains(&HostCall::CloseWindow(browser.window.clone()))
    );
}

#[gpui::test]
fn multiline_names_render_on_one_line(cx: &mut TestAppContext) {
    let browser = Browser::open(cx);
    let tab = browser.new_tab(cx, "https://lines.example");
    browser.act(
        cx,
        Action::CreateGroup {
            tabs: vec![tab],
            name: "Work\nReading".into(),
        },
    );
    browser.redraw(cx);
    assert!(browser.bounds(cx, "sidebar").is_some());
}

#[gpui::test]
fn tidy_tabs_on_the_divider_groups_by_site_and_undoes(cx: &mut TestAppContext) {
    let browser = Browser::open(cx);
    for url in [
        "https://github.com/a",
        "https://github.com/b",
        "https://one.example",
        "https://two.example",
        "https://three.example",
        "https://four.example",
        "https://five.example",
    ] {
        browser.new_tab(cx, url);
    }
    assert!(browser.bounds(cx, "tidy-tabs").is_none(), "off by default");
    browser.act(
        cx,
        Action::UpdateSettings {
            patch: ardia_state::settings::SettingsPatch::new().set("tidyTabs", true),
            from_sync: false,
        },
    );
    let divider = browser.bounds(cx, "clear-divider").expect("the divider");
    let mut visual = gpui::VisualTestContext::from_window(browser.handle.into(), cx);
    visual.simulate_mouse_move(divider.center(), None, gpui::Modifiers::none());
    visual.run_until_parked();
    browser.click(cx, "tidy-tabs");
    let state = browser.state();
    assert_eq!(state.groups.len(), 1);
    let toasts = state
        .window(browser.window.as_str())
        .expect("window")
        .chrome
        .toasts
        .clone();
    assert_eq!(toasts.len(), 1);
    assert_eq!(toasts[0].message, "Tidied 2 Tabs into 1 Group");
    assert!(
        browser.bounds(cx, "tidy-tabs").is_none(),
        "nothing left to tidy"
    );
    browser
        .handle
        .update(cx, |view, window, cx| {
            view.handle(
                crate::msg::Msg::ToastAction {
                    id: toasts[0].id,
                    command: toasts[0].action.clone().unwrap_or_default().into(),
                },
                window,
                cx,
            )
        })
        .expect("open");
    cx.run_until_parked();
    assert!(browser.state().groups.is_empty());
}
