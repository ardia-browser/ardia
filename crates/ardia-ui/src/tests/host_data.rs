use std::sync::Arc;

use ardia_state::Action;
use ardia_state::settings::SettingsPatch;
use ardia_state::windows::{Popover, WindowKind};
use gpui::{TestAppContext, VisualTestContext};

use super::support::Browser;
use crate::host_data::{
    CastDevice, CastDeviceKind, CastDeviceState, CastPanel, ExtensionItem, ExtensionPopupView,
    StageState, SyncFolderState, SyncStatus,
};
use crate::import::ImportWindowView;
use crate::mock::{HostCall, MockUiHost};
use crate::msg::{MenuTarget, Msg};
use crate::settings::SettingsWindowView;
use crate::settings::rows::Pane;
use crate::{UiHost, bind_global_keybindings, open_import_window, open_settings_window};

fn extension(id: &str, name: &str, pinned: bool) -> ExtensionItem {
    ExtensionItem {
        id: id.into(),
        name: name.into(),
        enabled: true,
        pinned,
        pinned_index: pinned.then_some(0),
        has_action: true,
        ..ExtensionItem::default()
    }
}

fn show(browser: &Browser, cx: &mut TestAppContext, popover: Option<Popover>) {
    browser.act(
        cx,
        Action::SetPopover {
            window: browser.window.clone(),
            popover,
        },
    );
    browser.redraw(cx);
}

fn menu(browser: &Browser, cx: &mut TestAppContext, target: MenuTarget) {
    browser
        .handle
        .update(cx, |view, window, cx| {
            view.handle(
                Msg::Menu(Some((target, gpui::point(gpui::px(400.), gpui::px(60.))))),
                window,
                cx,
            )
        })
        .expect("open");
    browser.redraw(cx);
}

fn cast_panel(tab: &ardia_state::TabId, devices: Vec<CastDevice>) -> CastPanel {
    CastPanel {
        tab: Some(tab.clone()),
        dialog_id: 7,
        header: String::new(),
        devices,
        permission_rejected: false,
        screen: false,
    }
}

fn sink(id: &str, modes: i32) -> CastDevice {
    CastDevice {
        id: id.into(),
        name: id.to_uppercase(),
        kind: CastDeviceKind::Tv,
        modes,
        ..CastDevice::default()
    }
}

#[gpui::test]
fn the_extensions_menu_matches_the_old_overflow_menu(cx: &mut TestAppContext) {
    let browser = Browser::open_with(cx, |host| {
        host.set_extensions(vec![
            extension("b", "Bravo", false),
            extension("a", "Alpha", true),
        ])
    });
    menu(&browser, cx, MenuTarget::Extensions);
    let bravo = browser
        .bounds(cx, "menu-extension:b")
        .expect("bravo is listed");
    let alpha = browser
        .bounds(cx, "menu-extension:a")
        .expect("alpha is listed");
    assert!(
        bravo.origin.y < alpha.origin.y,
        "the menu keeps the extension order"
    );
    assert!(browser.bounds(cx, "menu-manage").is_some());
    assert!(browser.bounds(cx, "menu-add").is_some());
    let tab = browser.active();
    browser.click(cx, "menu-extension:a");
    assert!(browser.host.calls().contains(&HostCall::Extension {
        tab,
        extension: "a".into(),
    }));
    assert!(
        browser.view(cx, |view| view.ui().menu.is_none()),
        "choosing closes the menu"
    );
}

#[gpui::test]
fn an_extensions_own_menu_pins_and_unpins_it(cx: &mut TestAppContext) {
    let browser = Browser::open_with(cx, |host| {
        host.set_extensions(vec![ExtensionItem {
            options_url: Some("chrome-extension://a/options.html".into()),
            may_modify: true,
            ..extension("a", "Alpha", true)
        }])
    });
    menu(&browser, cx, MenuTarget::Extension("a".into()));
    assert!(browser.bounds(cx, "menu-options").is_some());
    assert!(browser.bounds(cx, "menu-manage").is_some());
    assert!(browser.bounds(cx, "menu-remove").is_some());
    browser.click(cx, "menu-pin");
    assert!(browser.host.calls().contains(&HostCall::PinExtension {
        window: browser.window.clone(),
        extension: "a".into(),
        pinned: false,
    }));
}

#[gpui::test]
fn an_extension_popup_waits_for_its_size_and_closes_on_escape(cx: &mut TestAppContext) {
    let browser = Browser::open(cx);
    let popup = |sized| ExtensionPopupView {
        extension_id: "a".into(),
        name: "Alpha".into(),
        view: None,
        size: (2000.0, 300.0),
        sized,
    };
    browser
        .host
        .set_extension_popup(browser.window.clone(), Some(popup(false)));
    cx.run_until_parked();
    browser.redraw(cx);
    let hidden = browser
        .bounds(cx, "extension-popup")
        .expect("the popup is laid out");
    assert_eq!(hidden.size.width, gpui::px(26.0));
    browser
        .host
        .set_extension_popup(browser.window.clone(), Some(popup(true)));
    cx.run_until_parked();
    browser.redraw(cx);
    let shown = browser
        .bounds(cx, "extension-popup")
        .expect("the popup shows");
    assert_eq!(shown.size.width, gpui::px(801.0));
    assert_eq!(shown.size.height, gpui::px(301.0));
    browser.keys(cx, "escape");
    assert!(
        browser
            .host
            .calls()
            .contains(&HostCall::CloseExtensionPopup(browser.window.clone()))
    );
}

#[gpui::test]
fn the_cast_picker_matches_the_old_one(cx: &mut TestAppContext) {
    let browser = Browser::open(cx);
    let tab = browser.active();
    show(&browser, cx, Some(Popover::Cast));
    assert!(
        browser.bounds(cx, "cast-popover").is_none(),
        "no dialog, no picker"
    );
    browser
        .host
        .set_cast_panel(tab.clone(), Some(cast_panel(&tab, vec![])));
    cx.run_until_parked();
    browser.redraw(cx);
    assert!(browser.bounds(cx, "cast-looking").is_some());
    assert!(
        browser.bounds(cx, "cast-sources").is_none(),
        "no screen sink, no Sources"
    );
    let mut gone = sink("gone", 2);
    gone.state = CastDeviceState::Unavailable;
    browser.host.set_cast_panel(
        tab.clone(),
        Some(cast_panel(
            &tab,
            vec![sink("tv", 2 | 4), sink("mirror", 4), gone],
        )),
    );
    cx.run_until_parked();
    browser.redraw(cx);
    assert_eq!(
        browser.bounds(cx, "cast-popover").map(|b| b.size.width),
        Some(gpui::px(340.0))
    );
    assert!(browser.bounds(cx, "cast-sources").is_some());
    assert!(browser.bounds(cx, "cast-done").is_some());
    assert!(browser.bounds(cx, "cast-device:gone").is_none());
    let mut permission = cast_panel(&tab, vec![]);
    permission.permission_rejected = true;
    browser.host.set_cast_panel(tab, Some(permission));
    cx.run_until_parked();
    browser.redraw(cx);
    assert!(browser.bounds(cx, "cast-network-settings").is_some());
}

#[gpui::test]
fn a_screen_only_sink_in_tab_mode_switches_to_cast_screen_instead_of_mirroring(
    cx: &mut TestAppContext,
) {
    let browser = Browser::open(cx);
    let tab = browser.active();
    show(&browser, cx, Some(Popover::Cast));
    browser.host.set_cast_panel(
        tab.clone(),
        Some(cast_panel(
            &tab,
            vec![sink("tv", 1 | 2 | 4), sink("mirror", 4)],
        )),
    );
    cx.run_until_parked();
    browser.redraw(cx);
    browser.click(cx, "cast-device:mirror");
    assert!(
        !browser
            .host
            .calls()
            .iter()
            .any(|call| matches!(call, HostCall::StartCasting { .. })),
        "nothing starts casting"
    );
    assert!(browser.host.cast_panel(&tab).unwrap().screen);
    assert_eq!(
        browser.host.cast_panel(&tab).unwrap().title(),
        "Cast screen"
    );
    browser.click(cx, "cast-device:mirror");
    assert!(browser.host.calls().contains(&HostCall::StartCasting {
        tab: tab.clone(),
        device: "mirror".into(),
        mode: 4,
    }));
    browser.redraw(cx);
    browser.click(cx, "cast-stop:mirror");
    assert!(browser.host.calls().contains(&HostCall::StopCasting {
        tab: tab.clone(),
        device: "mirror".into(),
    }));
    menu(&browser, cx, MenuTarget::CastSource(tab.clone()));
    browser.click(cx, "menu-tab");
    assert!(!browser.host.cast_panel(&tab).unwrap().screen);
    browser.click(cx, "cast-device:tv");
    assert!(
        browser.host.calls().contains(&HostCall::StartCasting {
            tab,
            device: "tv".into(),
            mode: 1,
        }),
        "tab mode uses the preferred non-screen mode"
    );
}

#[gpui::test]
fn the_import_window_shows_the_old_progress_and_done_steps(cx: &mut TestAppContext) {
    cx.update(bind_global_keybindings);
    let host = MockUiHost::fresh();
    host.open_window(WindowKind::Main, Some("https://example.com"));
    host.set_import_browsers(Some(vec![crate::host_data::ImportBrowser {
        id: "chrome".into(),
        name: "Chrome".into(),
        profiles: vec![crate::host_data::ImportBrowserProfile {
            id: "Default".into(),
            name: "Personal".into(),
            path: "/browsers/chrome".into(),
            email: None,
            is_default: true,
        }],
        kinds: vec!["bookmarks".into(), "history".into()],
    }]));
    let shared: Arc<dyn UiHost> = host.clone();
    let handle = cx
        .update(|cx| open_import_window(shared, cx))
        .expect("import opens")
        .downcast::<ImportWindowView>()
        .expect("an import window");
    cx.run_until_parked();
    let mut visual = VisualTestContext::from_window(handle.into(), cx);
    let start = visual.debug_bounds("import-start").expect("Continue");
    visual.simulate_click(start.center(), gpui::Modifiers::none());
    visual.run_until_parked();
    let running = handle
        .read_with(cx, |view, _| view.progress().cloned())
        .expect("open")
        .expect("progress arrives");
    assert_eq!(
        running.stage("bookmarks").unwrap().state,
        StageState::Running
    );
    let mut visual = VisualTestContext::from_window(handle.into(), cx);
    visual.run_until_parked();
    assert!(visual.debug_bounds("import-stage:bookmarks").is_some());
    assert!(visual.debug_bounds("import-cancel").is_some());
    host.update_import(|progress| {
        for stage in &mut progress.stages {
            stage.state = if stage.key == "bookmarks" {
                StageState::Done
            } else {
                StageState::Failed("Not available yet".into())
            };
            stage.done = 3;
        }
        progress.finished = true;
    });
    cx.run_until_parked();
    cx.executor().advance_clock(crate::import::DONE_DELAY);
    cx.run_until_parked();
    assert!(
        handle
            .read_with(cx, |view, _| view.showing_done())
            .expect("open")
    );
    let mut visual = VisualTestContext::from_window(handle.into(), cx);
    visual.run_until_parked();
    assert!(
        visual.debug_bounds("import-again").is_some(),
        "a failed step offers Try Again"
    );
    assert!(visual.debug_bounds("import-done").is_some());
}

#[gpui::test]
fn the_general_pane_shows_the_old_sync_section(cx: &mut TestAppContext) {
    cx.update(bind_global_keybindings);
    let host = MockUiHost::fresh();
    host.open_window(WindowKind::Main, Some("https://example.com"));
    let shared: Arc<dyn UiHost> = host.clone();
    let handle = cx
        .update(|cx| open_settings_window(shared, cx))
        .expect("settings open")
        .downcast::<SettingsWindowView>()
        .expect("a settings window");
    cx.run_until_parked();
    assert!(host.calls().contains(&HostCall::RefreshSync));
    assert_eq!(
        handle.read_with(cx, |view, _| view.pane()).expect("open"),
        Pane::General
    );
    host.set_sync_status(SyncStatus {
        loaded: true,
        enabled: true,
        folder: Some("/Volumes/Gone/Sync".into()),
        folder_state: SyncFolderState::Missing,
        errors: vec!["The sync folder is missing.".into()],
        engine: crate::sync_api::SyncEngineView {
            state: crate::sync_api::SyncState::Offline,
            error: Some("The sync folder can’t be read. Check that it’s still there and that Ardia can open it.".into()),
            ..Default::default()
        },
        ..SyncStatus::default()
    });
    cx.run_until_parked();
    let mut visual = VisualTestContext::from_window(handle.into(), cx);
    visual.run_until_parked();
    assert!(visual.debug_bounds("sync-section").is_some());
    assert!(visual.debug_bounds("sync-error").is_some());
    assert!(visual.debug_bounds("sync-type:bookmarks").is_some());
}

#[gpui::test]
fn interface_size_is_a_pop_up_of_steps_that_resizes_the_chrome_live(cx: &mut TestAppContext) {
    let browser = Browser::open(cx);
    let tab = browser.active();
    browser
        .host
        .set_cast_panel(tab.clone(), Some(cast_panel(&tab, vec![sink("tv", 2)])));
    show(&browser, cx, Some(Popover::Cast));
    let before = browser.bounds(cx, "cast-popover").expect("shown");
    assert_eq!(before.size.width, gpui::px(340.0));
    browser.act(
        cx,
        Action::UpdateSettings {
            patch: SettingsPatch::new().set("interfaceScale", serde_json::json!(1.25)),
            from_sync: false,
        },
    );
    browser.redraw(cx);
    assert_eq!(crate::scale::current(), 1.25);
    let after = browser.bounds(cx, "cast-popover").expect("shown");
    assert_eq!(after.size.width, gpui::px(425.0));
    let card = browser.bounds(cx, "content-card").expect("the card");
    let viewport = browser
        .handle
        .update(cx, |_, window, _| window.viewport_size())
        .expect("open");
    assert!(card.origin.x + card.size.width <= viewport.width + gpui::px(0.5));
    browser.act(
        cx,
        Action::UpdateSettings {
            patch: SettingsPatch::new().set("interfaceScale", serde_json::json!(1.0)),
            from_sync: false,
        },
    );
    browser.redraw(cx);
    assert_eq!(crate::scale::current(), 1.0);
    let shared: Arc<dyn UiHost> = browser.host.clone();
    let settings = cx
        .update(|cx| open_settings_window(shared, cx))
        .expect("settings open")
        .downcast::<SettingsWindowView>()
        .expect("a settings window");
    settings
        .update(cx, |view, _, cx| {
            view.select(Pane::Appearance, cx);
            view.query = "interface size".into();
            cx.notify();
        })
        .expect("open");
    let mut visual = VisualTestContext::from_window(settings.into(), cx);
    visual.run_until_parked();
    assert!(
        visual.debug_bounds("interface-size").is_some(),
        "the pop-up shows"
    );
    assert!(
        visual.debug_bounds("interface-size-reset").is_none(),
        "no reset at 100%"
    );
    settings
        .update(cx, |view, window, cx| {
            view.handle(
                Msg::Command(gpui::SharedString::new_static("settings:interfaceSizeMenu")),
                window,
                cx,
            )
        })
        .expect("open");
    let mut visual = VisualTestContext::from_window(settings.into(), cx);
    visual.run_until_parked();
    assert!(
        visual.debug_bounds("interface-size:125").is_some(),
        "125% is offered"
    );
    settings
        .update(cx, |view, window, cx| {
            view.handle(
                crate::settings::panes::set("interfaceScale", 1.25),
                window,
                cx,
            )
        })
        .expect("open");
    let mut visual = VisualTestContext::from_window(settings.into(), cx);
    visual.run_until_parked();
    assert_eq!(browser.state().settings.interface_scale, 1.25);
    assert!(visual.debug_bounds("interface-size-reset").is_some());
    browser.act(
        cx,
        Action::UpdateSettings {
            patch: SettingsPatch::new().set("interfaceScale", serde_json::json!(1.0)),
            from_sync: false,
        },
    );
}

#[gpui::test]
fn little_ardia_fits_its_window_when_scaled(cx: &mut TestAppContext) {
    cx.update(bind_global_keybindings);
    let host = MockUiHost::fresh();
    host.open_window(WindowKind::Main, Some("https://example.com"));
    let little = host
        .open_window(WindowKind::LittleArdia, Some("https://news.example"))
        .expect("a little window");
    host.dispatch(Action::UpdateSettings {
        patch: SettingsPatch::new().set("interfaceScale", serde_json::json!(1.25)),
        from_sync: false,
    });
    let shared: Arc<dyn UiHost> = host;
    let handle = cx
        .update(|cx| {
            crate::open_little_ardia_window(
                shared,
                crate::OpenWindowTarget {
                    window_id: little,
                    ..crate::OpenWindowTarget::default()
                },
                cx,
            )
        })
        .expect("little ardia opens");
    cx.run_until_parked();
    let mut visual = VisualTestContext::from_window(handle, cx);
    visual.run_until_parked();
    let card = visual.debug_bounds("little-ardia-card").expect("a card");
    let viewport = handle
        .update(cx, |_, window, _| window.viewport_size())
        .expect("open");
    assert_eq!(crate::scale::current(), 1.25);
    assert!(
        card.origin.x + card.size.width <= viewport.width + gpui::px(0.5)
            && card.origin.y + card.size.height <= viewport.height + gpui::px(0.5),
        "card {card:?} overflows {viewport:?}"
    );
}

#[gpui::test]
fn an_open_tab_menu_follows_new_send_targets(cx: &mut TestAppContext) {
    use crate::sync_api::{DeviceKind, SendTarget};
    let browser = Browser::open(cx);
    let tab = browser.active();
    let profile = browser
        .state()
        .tab(tab.as_str())
        .expect("tab")
        .profile_id
        .clone();
    menu(&browser, cx, MenuTarget::Tab(tab));
    assert!(browser.bounds(cx, "menu-sendTo:P").is_none());
    let mut status = SyncStatus::default();
    status.engine.send_targets.insert(
        profile,
        vec![SendTarget {
            id: "P".into(),
            name: "Phone".into(),
            kind: DeviceKind::Phone,
        }],
    );
    browser.host.set_sync_status(status);
    browser.redraw(cx);
    assert!(
        browser.bounds(cx, "menu-sendTo:P").is_some(),
        "the open menu offers the new device"
    );
    browser.host.set_sync_status(SyncStatus::default());
    browser.redraw(cx);
    assert!(
        browser.bounds(cx, "menu-sendTo:P").is_none(),
        "the open menu drops a device that left"
    );
}
