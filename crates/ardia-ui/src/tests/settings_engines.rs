use std::sync::Arc;

use ardia_state::Action;
use ardia_state::model::PageEngine;
use ardia_state::settings::{EngineMode, SettingsPatch};
use ardia_state::windows::WindowKind;
use gpui::{Modifiers, SharedString, TestAppContext, VisualTestContext, WindowHandle};
use serde_json::json;

use super::support::Browser;
use crate::mock::{HostCall, MockUiHost};
use crate::msg::Msg;
use crate::settings::SettingsWindowView;
use crate::settings::engines::{RULE_ERROR, blocking_off};
use crate::settings::rows::Pane;
use crate::settings::subpages::Sheet;
use crate::site::model::ContentBlockerView;
use crate::{UiHost, bind_global_keybindings, open_settings_window};

fn settings_with(
    cx: &mut TestAppContext,
    webkit: bool,
) -> (Arc<MockUiHost>, WindowHandle<SettingsWindowView>) {
    cx.update(bind_global_keybindings);
    let host = MockUiHost::fresh();
    host.set_webkit(webkit, false, false);
    host.open_window(WindowKind::Main, Some("https://example.com"))
        .expect("a main window");
    let shared: Arc<dyn UiHost> = host.clone();
    let handle = cx
        .update(|cx| open_settings_window(shared, cx))
        .expect("settings open")
        .downcast::<SettingsWindowView>()
        .expect("a settings window");
    cx.run_until_parked();
    (host, handle)
}

fn shown(cx: &mut TestAppContext, window: gpui::AnyWindowHandle, selector: &'static str) -> bool {
    let mut visual = VisualTestContext::from_window(window, cx);
    visual.run_until_parked();
    visual.debug_bounds(selector).is_some()
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

fn send(cx: &mut TestAppContext, handle: WindowHandle<SettingsWindowView>, command: &str) {
    let command = SharedString::from(command.to_owned());
    handle
        .update(cx, |view, window, cx| {
            view.handle(Msg::Command(command), window, cx)
        })
        .expect("open");
    cx.run_until_parked();
}

fn set(host: &MockUiHost, cx: &mut TestAppContext, key: &str, value: serde_json::Value) {
    host.dispatch(Action::UpdateSettings {
        patch: SettingsPatch::new().set(key, value),
        from_sync: false,
    });
    cx.run_until_parked();
}

fn sheet(cx: &mut TestAppContext, handle: WindowHandle<SettingsWindowView>) -> Option<Sheet> {
    handle
        .read_with(cx, |view, _| view.sub.sheet.clone())
        .expect("open")
}

fn type_into_sheet(cx: &mut TestAppContext, handle: WindowHandle<SettingsWindowView>, text: &str) {
    let text = text.to_owned();
    handle
        .update(cx, |view, _, cx| {
            if let Some(field) = view.sub.fields.first().cloned() {
                field.update(cx, |input, cx| input.set_text(text, false, cx));
            }
        })
        .expect("open");
    cx.run_until_parked();
}

#[gpui::test]
fn the_engine_row_only_shows_where_webkit_is_offered(cx: &mut TestAppContext) {
    let (_, without) = settings_with(cx, false);
    assert!(!shown(cx, without.into(), "setting:general.engineMode"));
    let (_, with) = settings_with(cx, true);
    assert!(shown(cx, with.into(), "setting:general.engineMode"));
    assert!(shown(cx, with.into(), "engine-mode-about"));
}

#[gpui::test]
fn the_engine_footer_and_mode_follow_the_old_row(cx: &mut TestAppContext) {
    let (host, handle) = settings_with(cx, true);
    let footer = |cx: &mut TestAppContext| {
        handle
            .read_with(cx, |view, _| crate::settings::engines::mode_footer(view))
            .expect("open")
    };
    assert_eq!(
        footer(cx),
        "Most pages open in Chromium. Streaming sites open in WebKit to play protected video."
    );
    set(&host, cx, "protectedVideoInWebKit", json!(false));
    assert_eq!(footer(cx), "Most pages open in Chromium.");
    set(&host, cx, "engineMode", json!("chromium"));
    assert_eq!(
        footer(cx),
        "Opens every page in Chromium (no FairPlay video)."
    );
    send(cx, handle, "settings:sub:engines:mode:webkit");
    assert!(
        host.calls()
            .contains(&HostCall::SetEngineMode(EngineMode::Webkit))
    );
    host.set_webkit(true, true, false);
    assert_eq!(footer(cx), "Switching…");
    host.take_calls();
    send(cx, handle, "settings:sub:engines:mode:automatic");
    assert!(
        !host
            .calls()
            .iter()
            .any(|call| matches!(call, HostCall::SetEngineMode(_)))
    );
}

#[gpui::test]
fn the_advanced_pane_gates_engine_rows_by_mode(cx: &mut TestAppContext) {
    let (host, handle) = settings_with(cx, true);
    handle
        .update(cx, |view, _, cx| view.select(Pane::Advanced, cx))
        .expect("open");
    cx.run_until_parked();
    for id in [
        "setting:advanced.pageEngine",
        "setting:advanced.websiteEngines",
        "setting:advanced.engineSwitchKeepsPage",
        "setting:advanced.webKitFraudWarnings",
        "setting:advanced.enginesDiffer",
        "engine-add-rule",
    ] {
        assert!(shown(cx, handle.into(), id), "{id}");
    }
    assert!(!shown(cx, handle.into(), "engine-add-streaming"));
    set(
        &host,
        cx,
        "websiteEngines",
        json!({"https://example.com": "webkit"}),
    );
    assert!(shown(
        cx,
        handle.into(),
        "engine-rule-remove:https://example.com"
    ));
    assert!(shown(cx, handle.into(), "engine-streaming-remove"));
    handle
        .update(cx, |view, window, cx| {
            view.handle(
                crate::settings::panes::set("protectedVideoInWebKit", false),
                window,
                cx,
            )
        })
        .expect("open");
    cx.run_until_parked();
    assert!(!host.store().snapshot().settings.protected_video_in_webkit);
    assert!(shown(cx, handle.into(), "engine-add-streaming"));
    set(&host, cx, "engineMode", json!("chromium"));
    assert!(!shown(cx, handle.into(), "setting:advanced.pageEngine"));
    assert!(!shown(cx, handle.into(), "setting:advanced.enginesDiffer"));
    assert!(shown(
        cx,
        handle.into(),
        "setting:advanced.engineSwitchKeepsPage"
    ));
    assert!(!shown(
        cx,
        handle.into(),
        "engine-rule-remove:https://example.com"
    ));
    set(&host, cx, "engineMode", json!("webkit"));
    assert!(!shown(cx, handle.into(), "setting:advanced.websiteEngines"));
    assert!(shown(
        cx,
        handle.into(),
        "setting:advanced.webKitFraudWarnings"
    ));
}

#[gpui::test]
fn the_rule_sheet_validates_saves_and_renames(cx: &mut TestAppContext) {
    let (host, handle) = settings_with(cx, true);
    send(cx, handle, "settings:sub:engines:ruleNew");
    assert_eq!(
        sheet(cx, handle),
        Some(Sheet::EngineRule {
            site: None,
            engine: PageEngine::Webkit,
            error: None
        })
    );
    type_into_sheet(cx, handle, "not a site");
    send(cx, handle, "settings:sub:engines:ruleSave");
    assert!(matches!(
        sheet(cx, handle),
        Some(Sheet::EngineRule {
            error: Some(RULE_ERROR),
            ..
        })
    ));
    assert!(shown(cx, handle.into(), "engine-rule-error"));
    type_into_sheet(cx, handle, "netflix.com");
    send(cx, handle, "settings:sub:engines:ruleEngine:chromium");
    send(cx, handle, "settings:sub:engines:ruleSave");
    assert_eq!(sheet(cx, handle), None);
    let rules = host.store().snapshot().settings.website_engines.clone();
    assert_eq!(
        rules.get("https://netflix.com"),
        Some(&PageEngine::Chromium)
    );
    send(
        cx,
        handle,
        "settings:sub:engines:ruleEdit:https://netflix.com",
    );
    type_into_sheet(cx, handle, "hulu.com");
    send(cx, handle, "settings:sub:engines:ruleSave");
    let rules = host.store().snapshot().settings.website_engines.clone();
    assert_eq!(rules.len(), 1);
    assert_eq!(rules.get("https://hulu.com"), Some(&PageEngine::Chromium));
    send(cx, handle, "settings:sub:engines:ruleEdit:https://hulu.com");
    send(cx, handle, "settings:sub:engines:ruleRemove");
    assert!(host.store().snapshot().settings.website_engines.is_empty());
    assert_eq!(sheet(cx, handle), None);
}

#[gpui::test]
fn the_limits_sheet_hides_ad_blocking_when_blocking_is_off(cx: &mut TestAppContext) {
    let (host, handle) = settings_with(cx, true);
    click(cx, handle.into(), "engine-mode-about");
    assert_eq!(sheet(cx, handle), Some(Sheet::WebKitLimits));
    assert!(shown(cx, handle.into(), "webkit-limits:WebKit Ad Blocking"));
    host.set_content_blocker(Some(ContentBlockerView {
        enabled: false,
        ..ContentBlockerView::default()
    }));
    send(cx, handle, "settings:sub:engines:differ");
    send(cx, handle, "settings:sub:engines:limits");
    assert!(
        handle
            .read_with(cx, |view, _| blocking_off(view))
            .expect("open")
    );
    assert!(!shown(
        cx,
        handle.into(),
        "webkit-limits:WebKit Ad Blocking"
    ));
    assert!(shown(cx, handle.into(), "webkit-limits:WebKit Pages"));
    click(cx, handle.into(), "webkit-limits-done");
    assert_eq!(sheet(cx, handle), None);
}

#[gpui::test]
fn the_tab_menu_and_command_toggle_the_page_engine(cx: &mut TestAppContext) {
    let browser = Browser::open(cx);
    let tab = browser.active();
    let state = browser.state();
    let listed = state.tab(tab.as_str()).expect("tab").clone();
    assert_eq!(
        ardia_state::engines::tab_menu_engine_item(&state, &listed).as_deref(),
        Some("Open in WebKit")
    );
    browser
        .handle
        .update(cx, |view, window, cx| {
            view.run_command(&format!("togglePageEngine:{tab}"), window, cx)
        })
        .expect("open");
    cx.run_until_parked();
    assert!(
        browser
            .host
            .calls()
            .contains(&HostCall::TogglePageEngine(tab.clone()))
    );
}
