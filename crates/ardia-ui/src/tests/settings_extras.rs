use std::sync::Arc;

use ardia_state::windows::WindowKind;
use gpui::{Modifiers, SharedString, TestAppContext, VisualTestContext, WindowHandle};

use crate::host::{
    OfficialPlugin, OfficialPluginState, PluginCommand, PluginDetail, UpdateChannel, UpdaterState,
};
use crate::mock::{HostCall, MockUiHost};
use crate::msg::Msg;
use crate::onboarding::setup_code::{self, SetupChoices};
use crate::settings::SettingsWindowView;
use crate::settings::subpages::Detail;
use crate::{UiHost, bind_global_keybindings, open_settings_window};

fn settings(cx: &mut TestAppContext, host: Arc<MockUiHost>) -> WindowHandle<SettingsWindowView> {
    cx.update(bind_global_keybindings);
    host.open_window(WindowKind::Main, Some("https://example.com"))
        .expect("a main window");
    let shared: Arc<dyn UiHost> = host;
    let handle = cx
        .update(|cx| open_settings_window(shared, cx))
        .expect("settings open")
        .downcast::<SettingsWindowView>()
        .expect("a settings window");
    cx.run_until_parked();
    handle
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

fn shown(cx: &mut TestAppContext, window: gpui::AnyWindowHandle, selector: &'static str) -> bool {
    let mut visual = VisualTestContext::from_window(window, cx);
    visual.run_until_parked();
    visual.debug_bounds(selector).is_some()
}

fn send(cx: &mut TestAppContext, handle: WindowHandle<SettingsWindowView>, command: &str) {
    let command = SharedString::from(command.to_owned());
    handle
        .update(cx, |view, window, cx| {
            view.handle(Msg::Command(command), window, cx)
        })
        .expect("open");
    cx.run_until_parked();
}

fn updater(configured: bool) -> UpdaterState {
    UpdaterState {
        configured,
        automatic_checks: true,
        automatic_downloads: true,
        can_check: true,
        session_in_progress: false,
        last_check_ms: None,
        version: "0.3.0-nightly.2".into(),
        display_version: "0.3.0 Nightly 2".into(),
        channel: UpdateChannel::Nightly,
        switch_check: None,
    }
}

#[gpui::test]
fn updates_rows_follow_the_old_unconfigured_build(cx: &mut TestAppContext) {
    let host = MockUiHost::fresh();
    host.set_updater(Some(updater(false)));
    let handle = settings(cx, host.clone());
    assert!(shown(cx, handle.into(), "toggle:autoUpdate"));
    assert!(shown(cx, handle.into(), "choice:updateChannel"));
    let title = handle
        .read_with(cx, |view, _| crate::settings::updates::version_title(view))
        .expect("open");
    assert_eq!(title.as_ref(), "Ardia 0.3.0 Nightly 2");
    let detail = handle
        .read_with(cx, |view, _| {
            crate::settings::updates::header_detail(view, "Updates")
        })
        .expect("open");
    assert_eq!(detail, Some(crate::settings::updates::NOT_SET_UP));
    host.take_calls();
    send(cx, handle, "settings:updates:auto:false");
    send(cx, handle, "settings:updates:channel:stable");
    assert!(!host.calls().iter().any(|call| matches!(
        call,
        HostCall::AutomaticUpdates(_) | HostCall::UpdateChannel(_)
    )));
    send(cx, handle, "settings:updates:check");
    assert!(host.calls().contains(&HostCall::CheckForUpdates));
}

#[gpui::test]
fn configured_updates_write_through_the_host(cx: &mut TestAppContext) {
    let host = MockUiHost::fresh();
    host.set_updater(Some(updater(true)));
    let handle = settings(cx, host.clone());
    let detail = handle
        .read_with(cx, |view, _| {
            crate::settings::updates::header_detail(view, "Updates")
        })
        .expect("open");
    assert_eq!(detail, None);
    host.take_calls();
    send(cx, handle, "settings:updates:auto:false");
    send(cx, handle, "settings:updates:channel:stable");
    let calls = host.calls();
    assert!(calls.contains(&HostCall::AutomaticUpdates(false)));
    assert!(calls.contains(&HostCall::UpdateChannel(UpdateChannel::Stable)));
}

#[gpui::test]
fn updates_rows_hide_without_an_updater(cx: &mut TestAppContext) {
    let host = MockUiHost::fresh();
    let handle = settings(cx, host);
    assert!(!shown(cx, handle.into(), "toggle:autoUpdate"));
    assert!(!shown(cx, handle.into(), "choice:updateChannel"));
}

fn details() -> Vec<PluginDetail> {
    vec![
        PluginDetail {
            name: "cli".into(),
            title: "Command Line".into(),
            loads: true,
            official: true,
            active: true,
            full_control: true,
            ..PluginDetail::default()
        },
        PluginDetail {
            name: "demo".into(),
            title: "Demo".into(),
            version: Some("1.0".into()),
            description: "Does things".into(),
            loads: true,
            ..PluginDetail::default()
        },
    ]
}

#[gpui::test]
fn the_plugins_pane_lists_official_plugins_apart_from_yours(cx: &mut TestAppContext) {
    let host = MockUiHost::fresh();
    host.set_official_plugins(
        Some(vec![OfficialPlugin {
            name: "cli".into(),
            title: "Command Line".into(),
            blurb: "Drive Ardia from your terminal or an agent.".into(),
            icon: "terminal.fill".into(),
            state: OfficialPluginState::Installed,
            version: Some("0.6.0".into()),
            update: None,
            example: None,
        }]),
        None,
    );
    host.set_plugin_details(details());
    let handle = settings(cx, host.clone());
    click(cx, handle.into(), "settings-pane:Plugins");
    assert!(shown(cx, handle.into(), "official:cli"));
    assert!(shown(cx, handle.into(), "plugin:demo"));
    assert!(!shown(cx, handle.into(), "plugin:cli"));
    click(cx, handle.into(), "plugin:demo");
    let detail = handle
        .read_with(cx, |view, _| view.detail().cloned())
        .expect("open");
    assert_eq!(detail, Some(Detail::Plugin("demo".into())));
    assert!(shown(cx, handle.into(), "plugin-state"));
    assert!(shown(cx, handle.into(), "plugin-remove"));
    let title = handle
        .read_with(cx, |view, _| crate::settings::extras::plugin_title(view))
        .expect("open");
    assert_eq!(title.as_ref().map(|t| t.as_ref()), Some("Demo"));
    host.take_calls();
    send(cx, handle, "settings:extras:restart:demo");
    assert!(host.calls().contains(&HostCall::PluginCommand(
        "demo".into(),
        PluginCommand::Restart
    )));
}

#[gpui::test]
fn no_plugins_shows_how_to_add_one(cx: &mut TestAppContext) {
    let host = MockUiHost::fresh();
    let handle = settings(cx, host);
    click(cx, handle.into(), "settings-pane:Plugins");
    assert!(shown(cx, handle.into(), "plugins-none"));
    send(cx, handle, "settings:extras:howToAdd");
    let how = handle
        .read_with(cx, |view, _| view.extras.how_to_add)
        .expect("open");
    assert!(how);
}

#[gpui::test]
fn a_setup_code_applies_its_settings(cx: &mut TestAppContext) {
    let host = MockUiHost::fresh();
    let handle = settings(cx, host.clone());
    assert!(shown(cx, handle.into(), "setup-code"));
    let mut choices = SetupChoices::default();
    choices
        .settings
        .insert("tabLayout".into(), serde_json::json!("top"));
    let code = setup_code::encode(&choices);
    handle
        .update(cx, |view, window, cx| {
            view.extras
                .setup_input
                .update(cx, |input, cx| input.set_text(&code, true, cx));
            view.extras.setup_typed = code.clone();
            let _ = window;
        })
        .expect("open");
    cx.run_until_parked();
    send(cx, handle, "settings:extras:setupCode:apply");
    let layout = host.store().snapshot().settings.tab_layout;
    assert_eq!(layout, ardia_state::model::TabLayout::Top);
    let result = handle
        .read_with(cx, |view, _| view.extras.setup_result.clone())
        .expect("open");
    assert!(matches!(result, Some(Ok(_))));
    send(cx, handle, "settings:extras:setupCode:apply");
    handle
        .update(cx, |view, _, cx| {
            view.extras
                .setup_input
                .update(cx, |input, cx| input.set_text("nope", true, cx));
            view.extras.setup_typed = "nope".into();
        })
        .expect("open");
    cx.run_until_parked();
    send(cx, handle, "settings:extras:setupCode:apply");
    let result = handle
        .read_with(cx, |view, _| view.extras.setup_result.clone())
        .expect("open");
    assert_eq!(result, Some(Err(setup_code::ERROR_SHAPE)));
}
