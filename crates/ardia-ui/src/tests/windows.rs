use std::sync::Arc;

use ardia_state::windows::WindowKind;
use gpui::{Modifiers, TestAppContext, VisualTestContext, WindowHandle, px};

use crate::import::{ImportWindowView, Stage};
use crate::little_ardia::LittleArdiaWindowView;
use crate::mock::{HostCall, MockUiHost};
use crate::onboarding::OnboardingWindowView;
use crate::settings::SettingsWindowView;
use crate::settings::rows::Pane;
use crate::{
    OpenWindowTarget, UiHost, bind_global_keybindings, open_import_window,
    open_little_ardia_window, open_onboarding_window, open_settings_window,
};

fn host(cx: &mut TestAppContext) -> Arc<MockUiHost> {
    cx.update(bind_global_keybindings);
    let host = MockUiHost::fresh();
    host.open_window(WindowKind::Main, Some("https://example.com"))
        .expect("a main window");
    host
}

fn click(cx: &mut TestAppContext, window: gpui::AnyWindowHandle, selector: &'static str) {
    let mut visual = VisualTestContext::from_window(window, cx);
    visual.run_until_parked();
    let bounds = visual
        .debug_bounds(selector)
        .unwrap_or_else(|| panic!("{selector} is on screen"));
    visual.simulate_click(bounds.center(), Modifiers::none());
    visual.run_until_parked();
}

fn bounds(
    cx: &mut TestAppContext,
    window: gpui::AnyWindowHandle,
    selector: &'static str,
) -> Option<gpui::Bounds<gpui::Pixels>> {
    let mut visual = VisualTestContext::from_window(window, cx);
    visual.run_until_parked();
    visual.debug_bounds(selector)
}

fn settings(cx: &mut TestAppContext) -> (Arc<MockUiHost>, WindowHandle<SettingsWindowView>) {
    let host = host(cx);
    let shared: Arc<dyn UiHost> = host.clone();
    let handle = cx
        .update(|cx| open_settings_window(shared, cx))
        .expect("settings open")
        .downcast::<SettingsWindowView>()
        .expect("a settings window");
    cx.run_until_parked();
    (host, handle)
}

#[gpui::test]
fn settings_panes_switch_and_controls_write_to_the_store(cx: &mut TestAppContext) {
    let (host, handle) = settings(cx);
    assert_eq!(
        handle.read_with(cx, |view, _| view.pane()).expect("open"),
        Pane::General
    );
    click(cx, handle.into(), "settings-pane:Appearance");
    assert_eq!(
        handle.read_with(cx, |view, _| view.pane()).expect("open"),
        Pane::Appearance
    );
    assert!(host.store().snapshot().settings.element_outlines);
    click(cx, handle.into(), "toggle:elementOutlines");
    assert!(!host.store().snapshot().settings.element_outlines);
    assert!(!host.store().snapshot().settings.borderless_mode);
    handle
        .update(cx, |view, _, cx| view.reveal("appearance.pageFrame", cx))
        .expect("open");
    let slider = bounds(cx, handle.into(), "slider:pageFrame").expect("a page frame slider");
    let mut visual = VisualTestContext::from_window(handle.into(), cx);
    visual.simulate_click(
        gpui::point(slider.left() + px(8.), slider.center().y),
        Modifiers::none(),
    );
    visual.run_until_parked();
    assert!(host.store().snapshot().settings.borderless_mode);
    handle
        .update(cx, |view, _, cx| view.reveal("appearance.theme", cx))
        .expect("open");
    click(cx, handle.into(), "card:appearance.theme:dark");
    assert_eq!(
        host.store().snapshot().settings.appearance,
        ardia_state::settings::Appearance::Dark
    );
    click(cx, handle.into(), "settings-pane:Profiles");
    click(cx, handle.into(), "preset:green");
    let state = host.store().snapshot();
    let profile = state
        .profile(state.profile_order[0].as_str())
        .expect("profile");
    assert_eq!(profile.color.preset(), ardia_theme::ProfileColor::Green);
}

#[gpui::test]
fn settings_popups_pick_a_value_and_close(cx: &mut TestAppContext) {
    let (host, handle) = settings(cx);
    handle
        .update(cx, |view, _, cx| view.reveal("tabs.sleepingTabs", cx))
        .expect("open");
    assert!(bounds(cx, handle.into(), "popup-menu:tabs.sleepingTabs").is_none());
    click(cx, handle.into(), "popup:tabs.sleepingTabs");
    assert!(bounds(cx, handle.into(), "popup-menu:tabs.sleepingTabs").is_some());
    let item = bounds(cx, handle.into(), "popup-menu:tabs.sleepingTabs").expect("menu");
    let mut visual = VisualTestContext::from_window(handle.into(), cx);
    visual.simulate_click(
        gpui::point(item.center().x, item.bottom() - px(14.)),
        Modifiers::none(),
    );
    visual.run_until_parked();
    let settings = host.store().snapshot().settings.clone();
    assert!(settings.fade_unloaded_tabs && settings.strike_sleeping_tabs);
    assert!(bounds(cx, handle.into(), "popup-menu:tabs.sleepingTabs").is_none());
    handle
        .update(cx, |view, _, cx| view.reveal("tabs.buttons", cx))
        .expect("open");
    click(cx, handle.into(), "check:showClearButton");
    assert!(!host.store().snapshot().settings.show_clear_button);
}

#[gpui::test]
fn settings_popups_open_a_native_menu_at_the_pointer_when_one_exists(cx: &mut TestAppContext) {
    let (host, handle) = settings(cx);
    handle
        .update(cx, |view, _, cx| {
            view.reveal("appearance.selectedTabGlow", cx)
        })
        .expect("open");
    host.take_calls();
    host.set_menu_pick(Some(Some("soft".into())));
    click(cx, handle.into(), "popup:appearance.selectedTabGlow");
    assert!(bounds(cx, handle.into(), "popup-menu:appearance.selectedTabGlow").is_none());
    let menus: Vec<Vec<(String, String, bool)>> = host
        .take_calls()
        .into_iter()
        .filter_map(|call| match call {
            HostCall::ShowMenu(items) => Some(
                items
                    .into_iter()
                    .map(|item| (item.id, item.title, item.checked))
                    .collect(),
            ),
            _ => None,
        })
        .collect();
    assert_eq!(
        menus,
        vec![vec![
            ("full".to_owned(), "Full".to_owned(), true),
            ("soft".to_owned(), "Soft".to_owned(), false),
            ("off".to_owned(), "Off".to_owned(), false),
        ]]
    );
    assert_eq!(
        host.store().snapshot().settings.selected_tab_glow,
        ardia_state::settings::SelectedTabGlowSetting::Soft
    );
    host.set_menu_pick(Some(Some("soft".into())));
    click(cx, handle.into(), "popup:appearance.selectedTabGlow");
    assert_eq!(
        host.store().snapshot().settings.selected_tab_glow,
        ardia_state::settings::SelectedTabGlowSetting::Soft
    );
}

#[gpui::test]
fn settings_back_and_forward_walk_the_visited_panes(cx: &mut TestAppContext) {
    let (_, handle) = settings(cx);
    let pane = |cx: &mut TestAppContext| handle.read_with(cx, |view, _| view.pane()).expect("open");
    assert!(
        handle
            .read_with(cx, |view, _| !view.can_go_back())
            .expect("open")
    );
    click(cx, handle.into(), "settings-pane:Tabs");
    click(cx, handle.into(), "settings-pane:Advanced");
    click(cx, handle.into(), "settings-back");
    assert_eq!(pane(cx), Pane::Tabs);
    click(cx, handle.into(), "settings-back");
    assert_eq!(pane(cx), Pane::General);
    click(cx, handle.into(), "settings-forward");
    assert_eq!(pane(cx), Pane::Tabs);
    click(cx, handle.into(), "settings-pane:Shortcuts");
    assert!(
        handle
            .read_with(cx, |view, _| !view.can_go_forward())
            .expect("open")
    );
}

#[gpui::test]
fn the_custom_clean_up_sheet_checks_and_saves_its_time(cx: &mut TestAppContext) {
    let (host, handle) = settings(cx);
    handle
        .update(cx, |view, window, cx| view.open_clean_up_sheet(window, cx))
        .expect("open");
    cx.run_until_parked();
    click(cx, handle.into(), "clean-up-amount");
    cx.simulate_keystrokes(handle.into(), "cmd-a");
    cx.simulate_input(handle.into(), "0");
    let typed = handle
        .read_with(cx, |view, cx| {
            (
                view.sheet_amount.read(cx).text().to_owned(),
                view.clean_up_sheet,
            )
        })
        .expect("open");
    assert_eq!(typed, ("0".to_owned(), Some(("days", false))));
    click(cx, handle.into(), "clean-up-save");
    let after = handle
        .read_with(cx, |view, _| view.clean_up_sheet)
        .expect("open");
    assert_eq!(after, Some(("days", true)));
    assert!(bounds(cx, handle.into(), "clean-up-invalid").is_some());
    assert!(
        host.store()
            .snapshot()
            .settings
            .clean_up_inactive_tabs_after_minutes
            .is_none()
    );
    click(cx, handle.into(), "clean-up-amount");
    cx.simulate_keystrokes(handle.into(), "cmd-a");
    cx.simulate_input(handle.into(), "3");
    click(cx, handle.into(), "clean-up-save");
    assert_eq!(
        host.store()
            .snapshot()
            .settings
            .clean_up_inactive_tabs_after_minutes,
        Some(3.0 * 1440.0)
    );
    assert!(bounds(cx, handle.into(), "clean-up-save").is_none());
}

#[gpui::test]
fn the_profile_name_field_shows_and_renames_the_profile(cx: &mut TestAppContext) {
    let (host, handle) = settings(cx);
    click(cx, handle.into(), "settings-pane:Profiles");
    let shown = handle
        .read_with(cx, |view, cx| view.profile_name.read(cx).text().to_owned())
        .expect("open");
    let state = host.store().snapshot();
    let profile = state
        .profile(state.profile_order[0].as_str())
        .expect("profile");
    assert_eq!(shown, profile.name);
    click(cx, handle.into(), "profile-name");
    cx.simulate_keystrokes(handle.into(), "cmd-a");
    cx.simulate_input(handle.into(), "Work");
    cx.simulate_keystrokes(handle.into(), "enter");
    cx.run_until_parked();
    let state = host.store().snapshot();
    assert_eq!(
        state
            .profile(state.profile_order[0].as_str())
            .expect("profile")
            .name,
        "Work"
    );
}

#[gpui::test]
fn the_recorder_takes_a_middle_click_as_a_mouse_shortcut(cx: &mut TestAppContext) {
    let (host, handle) = settings(cx);
    click(cx, handle.into(), "settings-pane:Shortcuts");
    click(cx, handle.into(), "shortcut:newTab");
    let field = bounds(cx, handle.into(), "shortcut:newTab").expect("field");
    let mut visual = VisualTestContext::from_window(handle.into(), cx);
    visual.simulate_event(gpui::MouseDownEvent {
        button: gpui::MouseButton::Middle,
        position: field.center(),
        modifiers: Modifiers::command(),
        click_count: 1,
        first_mouse: false,
    });
    visual.run_until_parked();
    let state = host.store().snapshot();
    assert_eq!(
        state.settings.mouse_shortcuts.get("newTab").cloned(),
        Some(vec!["mouse:middle".to_owned(), "command".to_owned()])
    );
    assert!(bounds(cx, handle.into(), "shortcut-mouse:newTab").is_some());
    assert!(handle.read_with(cx, |view, _| view.recording().is_none()).expect("open"));
}

#[gpui::test]
fn settings_search_finds_commands_by_their_keys(cx: &mut TestAppContext) {
    let (_, handle) = settings(cx);
    click(cx, handle.into(), "settings-search");
    cx.simulate_input(handle.into(), "⌘T");
    cx.run_until_parked();
    assert!(bounds(cx, handle.into(), "settings-keys:newTab").is_some());
    cx.simulate_keystrokes(handle.into(), "enter");
    cx.run_until_parked();
    assert_eq!(
        handle.read_with(cx, |view, _| view.pane()).expect("open"),
        Pane::Shortcuts
    );
}

#[gpui::test]
fn search_by_keys_filters_the_shortcut_list_to_that_combo(cx: &mut TestAppContext) {
    let (_, handle) = settings(cx);
    click(cx, handle.into(), "settings-pane:Shortcuts");
    click(cx, handle.into(), "shortcuts-key-search");
    assert!(handle.read_with(cx, |view, _| view.key_searching).expect("open"));
    cx.simulate_keystrokes(handle.into(), "cmd-t");
    cx.run_until_parked();
    assert!(handle.read_with(cx, |view, _| !view.key_searching).expect("open"));
    assert_eq!(
        handle.read_with(cx, |view, _| view.shortcut_query.clone()).expect("open"),
        "⌘T"
    );
    assert!(bounds(cx, handle.into(), "shortcut:newTab").is_some());
    assert!(bounds(cx, handle.into(), "shortcut:newWindow").is_none());
}

#[gpui::test]
fn the_app_menu_group_lists_show_all_like_the_old_pane(cx: &mut TestAppContext) {
    let (_, handle) = settings(cx);
    click(cx, handle.into(), "settings-pane:Shortcuts");
    let ids: Vec<&str> = handle
        .read_with(cx, |view, _| {
            crate::settings::panes::shortcut_entries(view)
                .into_iter()
                .filter(|entry| entry.menu == "Ardia")
                .map(|entry| entry.id)
                .collect()
        })
        .expect("open");
    let hide = ids.iter().position(|id| *id == "std:hide:").expect("Hide Ardia");
    let show = ids
        .iter()
        .position(|id| *id == "std:unhideAllApplications:")
        .expect("Show All");
    let quit = ids.iter().position(|id| *id == "std:quit:").expect("Quit Ardia");
    assert!(hide < show && show < quit);
}

#[gpui::test]
fn settings_search_lists_results_in_the_sidebar_and_reveals_one(cx: &mut TestAppContext) {
    let (_, handle) = settings(cx);
    click(cx, handle.into(), "settings-search");
    cx.simulate_input(handle.into(), "borderless");
    cx.run_until_parked();
    assert!(bounds(cx, handle.into(), "settings-result:appearance.pageFrame").is_some());
    assert!(bounds(cx, handle.into(), "settings-pane:General").is_none());
    cx.simulate_keystrokes(handle.into(), "enter");
    cx.run_until_parked();
    assert_eq!(
        handle.read_with(cx, |view, _| view.pane()).expect("open"),
        Pane::Appearance
    );
    assert_eq!(
        handle
            .read_with(cx, |view, _| view.flashed())
            .expect("open"),
        Some("appearance.pageFrame")
    );
    cx.simulate_keystrokes(handle.into(), "escape");
    cx.run_until_parked();
    assert!(bounds(cx, handle.into(), "settings-pane:General").is_some());
    cx.simulate_keystrokes(handle.into(), "cmd-f");
    cx.simulate_input(handle.into(), "zzzz");
    cx.run_until_parked();
    assert!(bounds(cx, handle.into(), "settings-no-results").is_some());
}

#[gpui::test]
fn the_shortcut_recorder_rebinds_a_command(cx: &mut TestAppContext) {
    let (host, handle) = settings(cx);
    click(cx, handle.into(), "settings-pane:Shortcuts");
    click(cx, handle.into(), "shortcut:newTab");
    assert_eq!(
        handle
            .read_with(cx, |view, _| view.recording().map(|s| s.to_string()))
            .expect("open")
            .as_deref(),
        Some("newTab")
    );
    cx.simulate_keystrokes(handle.into(), "cmd-shift-y");
    cx.run_until_parked();
    let state = host.store().snapshot();
    let map = state.shortcut_map(ardia_state::shortcuts::Platform::current());
    assert_eq!(
        map.primary("newTab").copied(),
        ardia_state::shortcuts::Shortcut::parse_glyphs("⇧⌘Y")
    );
    assert!(
        handle
            .read_with(cx, |view, _| view.recording().is_none())
            .expect("open")
    );
}

#[gpui::test]
fn little_ardia_shows_its_page_and_promotes_to_the_main_window(cx: &mut TestAppContext) {
    let host = host(cx);
    let little = host
        .open_window(WindowKind::LittleArdia, Some("https://news.example"))
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
    assert_eq!(
        bounds(cx, handle.into(), "little-ardia-bar").map(|b| b.size.height),
        Some(px(38.))
    );
    let card = bounds(cx, handle.into(), "little-ardia-card").expect("a card");
    assert_eq!(card.origin.y, px(38.));
    click(cx, handle.into(), "little-ardia-address");
    assert!(
        handle
            .read_with(cx, |view, _| view.panel().is_open())
            .expect("open")
    );
    cx.simulate_keystrokes(handle.into(), "escape");
    cx.run_until_parked();
    assert!(
        !handle
            .read_with(cx, |view, _| view.panel().is_open())
            .expect("open")
    );
    click(cx, handle.into(), "little-open");
    assert!(host.calls().contains(&HostCall::LittleToMain(little)));
}

#[gpui::test]
fn import_walks_the_old_choose_and_profiles_steps(cx: &mut TestAppContext) {
    use crate::host_data::{ImportBrowser, ImportBrowserProfile};
    let host = host(cx);
    let profile = |id: &str, default: bool| ImportBrowserProfile {
        id: id.into(),
        name: id.into(),
        path: format!("/browsers/{id}"),
        email: None,
        is_default: default,
    };
    host.set_import_browsers(None);
    let shared: Arc<dyn UiHost> = host.clone();
    let handle = cx
        .update(|cx| open_import_window(shared, cx))
        .expect("import opens")
        .downcast::<ImportWindowView>()
        .expect("an import window");
    cx.run_until_parked();
    assert!(host.calls().contains(&HostCall::RefreshImportBrowsers));
    assert!(
        bounds(cx, handle.into(), "import-source:chrome").is_none(),
        "still looking"
    );
    host.set_import_browsers(Some(vec![
        ImportBrowser {
            id: "arc".into(),
            name: "Arc".into(),
            profiles: vec![profile("Default", true)],
            kinds: vec!["bookmarks".into()],
        },
        ImportBrowser {
            id: "chrome".into(),
            name: "Chrome".into(),
            profiles: vec![profile("Default", true), profile("Profile 1", false)],
            kinds: vec!["bookmarks".into()],
        },
    ]));
    cx.run_until_parked();
    assert!(bounds(cx, handle.into(), "import-data:bookmarks").is_some());
    click(cx, handle.into(), "import-source:chrome");
    click(cx, handle.into(), "import-start");
    assert_eq!(
        handle
            .read_with(cx, |view, _| view.stage().clone())
            .expect("open"),
        Stage::Profiles
    );
    click(cx, handle.into(), "import-profile:Profile 1");
    click(cx, handle.into(), "import-start");
    let plan = host
        .calls()
        .into_iter()
        .find_map(|call| match call {
            HostCall::RunImport(plan) => Some(plan),
            _ => None,
        })
        .expect("the import runs");
    assert_eq!(plan.source_name, "Chrome");
    assert_eq!(plan.kinds, vec!["bookmarks".to_owned()]);
    assert_eq!(
        plan.profiles
            .iter()
            .map(|p| p.id.as_str())
            .collect::<Vec<_>>(),
        ["Default", "Profile 1"]
    );
    assert_eq!(
        plan.target,
        Some(host.store().snapshot().last_active_profile())
    );
    click(cx, handle.into(), "import-cancel");
    assert!(
        host.calls().contains(&HostCall::CancelImport),
        "Cancel aborts the running import"
    );
}

#[gpui::test]
fn onboarding_opens_on_the_intro_and_lands_on_the_source_question(cx: &mut TestAppContext) {
    let host = host(cx);
    let shared: Arc<dyn UiHost> = host;
    let handle = cx
        .update(|cx| open_onboarding_window(shared, cx))
        .expect("onboarding opens")
        .downcast::<OnboardingWindowView>()
        .expect("an onboarding window");
    cx.run_until_parked();
    let intro = bounds(cx, handle.into(), "onboarding-intro");
    eprintln!("intro {intro:?}");
    assert!(intro.is_some_and(|b| b.size.width > px(100.)));
    cx.simulate_keystrokes(handle.into(), "escape");
    cx.executor()
        .advance_clock(std::time::Duration::from_millis(400));
    cx.run_until_parked();
    let mut visual = VisualTestContext::from_window(handle.into(), cx);
    visual.run_until_parked();
    visual.update(|window, _| window.refresh());
    visual.run_until_parked();
    eprintln!(
        "step {:?}",
        handle.read_with(cx, |view, _| view.step()).ok()
    );
    for selector in [
        "onboarding-active",
        "onboarding-actions",
        "onboarding-stage",
    ] {
        eprintln!("{selector} {:?}", bounds(cx, handle.into(), selector));
    }
}

#[gpui::test]
fn the_recorder_only_listens_to_its_own_window(cx: &mut TestAppContext) {
    let (host, handle) = settings(cx);
    click(cx, handle.into(), "settings-pane:Shortcuts");
    click(cx, handle.into(), "shortcut:newTab");
    let main = host.store().snapshot().window_order[0].clone();
    let shared: Arc<dyn UiHost> = host.clone();
    let browser = cx
        .update(|cx| {
            crate::open_browser_window(
                shared,
                OpenWindowTarget {
                    window_id: main,
                    background: true,
                    ..OpenWindowTarget::default()
                },
                cx,
            )
        })
        .expect("browser opens");
    cx.run_until_parked();
    cx.simulate_keystrokes(browser, "cmd-shift-y");
    cx.run_until_parked();
    let state = host.store().snapshot();
    let map = state.shortcut_map(ardia_state::shortcuts::Platform::current());
    assert_eq!(
        map.primary("newTab").copied(),
        ardia_state::shortcuts::Shortcut::parse_glyphs("⌘T")
    );
    assert!(
        handle
            .read_with(cx, |view, _| view.recording().is_some())
            .expect("open")
    );
    click(cx, handle.into(), "settings-pane:General");
    assert!(
        handle
            .read_with(cx, |view, _| view.recording().is_none())
            .expect("open")
    );
}

#[gpui::test]
fn crash_reports_start_out_shared_on_a_first_run(cx: &mut TestAppContext) {
    let host = host(cx);
    let shared: Arc<dyn UiHost> = host;
    let handle = cx
        .update(|cx| open_onboarding_window(shared, cx))
        .expect("onboarding opens")
        .downcast::<OnboardingWindowView>()
        .expect("an onboarding window");
    cx.run_until_parked();
    let on = handle
        .update(cx, |view, _, _| {
            view.flow.go_to(crate::onboarding::Step::SearchPrivacy, 1);
            view.share()
        })
        .expect("open");
    assert!(on);
}

#[gpui::test]
fn continuing_from_the_engine_keeps_sharing_on(cx: &mut TestAppContext) {
    let host = host(cx);
    let shared: Arc<dyn UiHost> = host;
    let handle = cx
        .update(|cx| open_onboarding_window(shared, cx))
        .expect("onboarding opens")
        .downcast::<OnboardingWindowView>()
        .expect("an onboarding window");
    cx.run_until_parked();
    let on = handle
        .update(cx, |view, window, cx| {
            view.flow.go_to(crate::onboarding::Step::SearchPrivacy, 0);
            view.forward(window, cx);
            (view.flow.sub, view.share(), view.flow.extras.share)
        })
        .expect("open");
    assert_eq!(on, (1, true, None));
}

#[gpui::test]
fn the_plugins_step_installs_the_picked_plugins_then_continues(cx: &mut TestAppContext) {
    use crate::host::{OfficialPlugin, OfficialPluginState};
    use crate::onboarding::plugins_step::Phase;
    let host = host(cx);
    host.set_official_plugins(
        Some(vec![OfficialPlugin {
            name: "cli".into(),
            title: "Command Line".into(),
            blurb: "Drive Ardia from your terminal or an agent.".into(),
            icon: "terminal.fill".into(),
            state: OfficialPluginState::Available,
            version: Some("0.7.0".into()),
            update: None,
            example: None,
        }]),
        Some("offline".into()),
    );
    let shared: Arc<dyn UiHost> = host.clone();
    let handle = cx
        .update(|cx| open_onboarding_window(shared, cx))
        .expect("onboarding opens")
        .downcast::<OnboardingWindowView>()
        .expect("an onboarding window");
    cx.run_until_parked();
    handle
        .update(cx, |view, _, cx| {
            view.flow.go_to(crate::onboarding::Step::Plugins, 0);
            cx.notify();
        })
        .expect("open");
    assert!(bounds(cx, handle.into(), "onboarding-plugin-cli").is_some());
    click(cx, handle.into(), "onboarding-next");
    assert_eq!(handle.read_with(cx, |view, _| view.plugins_step.phase).expect("open"), Phase::Failed);
    assert!(bounds(cx, handle.into(), "onboarding-plugin-retry-cli").is_some());
    host.set_official_plugins(
        Some(vec![OfficialPlugin {
            name: "cli".into(),
            title: "Command Line".into(),
            blurb: String::new(),
            icon: "terminal.fill".into(),
            state: OfficialPluginState::Available,
            version: None,
            update: None,
            example: None,
        }]),
        None,
    );
    for _ in 0..3 {
        handle.update(cx, |_, window, _| window.refresh()).expect("open");
        cx.run_until_parked();
    }
    click(cx, handle.into(), "onboarding-plugin-retry-cli");
    assert_eq!(handle.read_with(cx, |view, _| view.plugins_step.phase).expect("open"), Phase::Installed);
    assert!(bounds(cx, handle.into(), "onboarding-skip").is_none());
    click(cx, handle.into(), "onboarding-next");
    assert_eq!(
        handle.read_with(cx, |view, _| (view.flow.step, view.plugins_step.phase)).expect("open"),
        (crate::onboarding::Step::Outro, Phase::Offer)
    );
}
