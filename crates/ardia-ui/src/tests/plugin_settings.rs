use std::sync::Arc;

use ardia_state::WindowId;
use ardia_state::windows::WindowKind;
use gpui::{Modifiers, SharedString, TestAppContext, VisualTestContext, WindowHandle};
use parking_lot::Mutex;

use crate::host::PluginDetail;
use crate::mock::MockUiHost;
use crate::msg::Msg;
use crate::plugins::PluginHost;
use crate::plugins::model::{
    PluginBarAction, PluginNode, SettingKind, SettingRow, SettingValue, SurfaceMount,
};
use crate::settings::SettingsWindowView;
use crate::settings::plugin_values::value_command;
use crate::{UiHost, bind_global_keybindings, open_settings_window};

#[derive(Default)]
struct Plugins {
    rows: Mutex<Vec<SettingRow>>,
    writes: Mutex<Vec<(String, SettingValue)>>,
    secrets: Mutex<Vec<(String, Option<String>)>>,
    secret_set: Mutex<bool>,
    approved: Mutex<bool>,
    consent_asked: Mutex<u32>,
    commands: Mutex<Vec<String>>,
    pages: Mutex<Vec<String>>,
}

impl PluginHost for Plugins {
    fn window_eligible(&self, _: &WindowId) -> bool {
        true
    }

    fn surface_tree(&self, _: &str, _: &str) -> Option<PluginNode> {
        None
    }

    fn mount_surface(&self, _: SurfaceMount) {}

    fn unmount_surface(&self, _: &str, _: &str, _: &WindowId) {}

    fn fire(
        &self,
        _: &str,
        _: &str,
        _: &WindowId,
        _: &str,
        _: Vec<serde_json::Value>,
        _: bool,
    ) -> bool {
        false
    }

    fn open_url(&self, _: &WindowId, _: &str) {}

    fn setting_rows(&self, plugin: &str) -> Vec<SettingRow> {
        if plugin == "demo" {
            self.rows.lock().clone()
        } else {
            Vec::new()
        }
    }

    fn set_setting(&self, _: &str, key: &str, value: SettingValue) -> bool {
        self.writes.lock().push((key.to_owned(), value.clone()));
        if let Some(row) = self.rows.lock().iter_mut().find(|r| r.key == key) {
            row.value = value;
        }
        true
    }

    fn secret_row_is_set(&self, _: &str, _: &str) -> bool {
        *self.secret_set.lock()
    }

    fn set_secret_row(&self, _: &str, key: &str, value: Option<&str>) -> Result<(), String> {
        self.secrets
            .lock()
            .push((key.to_owned(), value.map(str::to_owned)));
        *self.secret_set.lock() = value.is_some();
        Ok(())
    }

    fn turn_on_approved(&self, _: &str) -> bool {
        *self.approved.lock()
    }

    fn ask_consent(&self, _: &str, _: crate::plugins::model::ConsentOwner) -> bool {
        *self.consent_asked.lock() += 1;
        true
    }

    fn bar_actions(&self) -> Vec<PluginBarAction> {
        vec![
            PluginBarAction {
                plugin: "demo".into(),
                action: ":page".into(),
                title: "Open Demo".into(),
                icon: None,
                keywords: vec!["Demo".into(), "plugin".into()],
                when: None,
            },
            PluginBarAction {
                plugin: "demo".into(),
                action: "never".into(),
                title: "Never".into(),
                icon: None,
                keywords: Vec::new(),
                when: Some("urlHost == 'nowhere.invalid'".into()),
            },
        ]
    }

    fn run_command(&self, _: &WindowId, _: &str, command: &str) -> bool {
        self.commands.lock().push(command.to_owned());
        true
    }

    fn open_plugin_page(&self, _: &WindowId, plugin: &str) {
        self.pages.lock().push(plugin.to_owned());
    }
}

fn rows() -> Vec<SettingRow> {
    vec![
        SettingRow {
            key: "loud".into(),
            title: "Loud".into(),
            description: Some("Speak up".into()),
            kind: SettingKind::Toggle,
            value: SettingValue::Bool(false),
        },
        SettingRow {
            key: "side".into(),
            title: "Side".into(),
            description: None,
            kind: SettingKind::Choice {
                choices: vec![
                    ("left".into(), "Left".into()),
                    ("right".into(), "Right".into()),
                ],
            },
            value: SettingValue::Text("left".into()),
        },
        SettingRow {
            key: "count".into(),
            title: "Count".into(),
            description: None,
            kind: SettingKind::Number {
                min: Some(1.0),
                max: Some(10.0),
                step: None,
            },
            value: SettingValue::Number(3.0),
        },
        SettingRow {
            key: "name".into(),
            title: "Name".into(),
            description: None,
            kind: SettingKind::Text,
            value: SettingValue::Text("Ada".into()),
        },
        SettingRow {
            key: "token".into(),
            title: "Token".into(),
            description: None,
            kind: SettingKind::Secret {
                placeholder: Some("sk-…".into()),
            },
            value: SettingValue::Text(String::new()),
        },
    ]
}

fn detail(active: bool) -> PluginDetail {
    PluginDetail {
        name: "demo".into(),
        title: "Demo".into(),
        loads: true,
        active,
        ..PluginDetail::default()
    }
}

fn open_page(
    cx: &mut TestAppContext,
    active: bool,
) -> (
    Arc<MockUiHost>,
    Arc<Plugins>,
    WindowHandle<SettingsWindowView>,
) {
    cx.update(bind_global_keybindings);
    let host = MockUiHost::fresh();
    host.open_window(WindowKind::Main, Some("https://example.com"))
        .expect("a main window");
    let plugins = Arc::new(Plugins::default());
    *plugins.rows.lock() = rows();
    host.set_plugins(Some(plugins.clone() as Arc<dyn PluginHost>));
    host.set_plugin_details(vec![detail(active)]);
    let shared: Arc<dyn UiHost> = host.clone();
    let handle = cx
        .update(|cx| open_settings_window(shared, cx))
        .expect("settings open")
        .downcast::<SettingsWindowView>()
        .expect("a settings window");
    cx.run_until_parked();
    send_msg(
        cx,
        handle,
        Msg::SettingsPane(crate::settings::rows::Pane::Plugins.index()),
    );
    send(cx, handle, "settings:extras:open:demo");
    (host, plugins, handle)
}

fn send(cx: &mut TestAppContext, handle: WindowHandle<SettingsWindowView>, command: &str) {
    send_msg(
        cx,
        handle,
        Msg::Command(SharedString::from(command.to_owned())),
    );
}

fn send_msg(cx: &mut TestAppContext, handle: WindowHandle<SettingsWindowView>, msg: Msg) {
    handle
        .update(cx, |view, window, cx| view.handle(msg, window, cx))
        .expect("open");
    cx.run_until_parked();
}

fn shown(
    cx: &mut TestAppContext,
    handle: WindowHandle<SettingsWindowView>,
    selector: &'static str,
) -> bool {
    let mut visual = VisualTestContext::from_window(handle.into(), cx);
    visual.run_until_parked();
    visual.debug_bounds(selector).is_some()
}

fn click(
    cx: &mut TestAppContext,
    handle: WindowHandle<SettingsWindowView>,
    selector: &'static str,
) {
    let mut visual = VisualTestContext::from_window(handle.into(), cx);
    visual.run_until_parked();
    let bounds = visual
        .debug_bounds(selector)
        .unwrap_or_else(|| panic!("{selector} is on screen"));
    visual.simulate_click(bounds.center(), Modifiers::none());
    visual.run_until_parked();
}

fn type_into(
    cx: &mut TestAppContext,
    handle: WindowHandle<SettingsWindowView>,
    key: &str,
    text: &str,
) {
    handle
        .update(cx, |view, _, cx| {
            let field = view
                .extras
                .plugin_values
                .fields
                .get(key)
                .expect("a field")
                .input
                .clone();
            field.update(cx, |input, cx| input.set_text(text.to_owned(), false, cx));
        })
        .expect("open");
    handle
        .update(cx, |view, _, _| {
            if let Some(field) = view.extras.plugin_values.fields.get_mut(key) {
                field.draft = text.to_owned();
            }
        })
        .expect("open");
    cx.run_until_parked();
}

fn draft(cx: &mut TestAppContext, handle: WindowHandle<SettingsWindowView>, key: &str) -> String {
    handle
        .read_with(cx, |view, _| {
            view.extras
                .plugin_values
                .fields
                .get(key)
                .map(|f| f.draft.clone())
                .unwrap_or_default()
        })
        .expect("open")
}

fn page_has_plugin(cx: &mut TestAppContext, handle: WindowHandle<SettingsWindowView>) -> bool {
    handle
        .read_with(cx, |view, _| {
            matches!(
                view.detail(),
                Some(crate::settings::subpages::Detail::Plugin(name)) if name == "demo"
            )
        })
        .expect("open")
}

#[gpui::test]
fn an_active_plugin_shows_every_settings_row_in_manifest_order(cx: &mut TestAppContext) {
    let (_host, _plugins, handle) = open_page(cx, true);
    assert!(page_has_plugin(cx, handle));
    for selector in [
        "plugin-value:loud",
        "plugin-value:side",
        "plugin-value:count",
        "plugin-value:name",
        "plugin-value:token",
        "toggle:pluginValue:loud",
        "popup:pluginValue:side",
        "field:pluginValue:count",
        "field:pluginValue:name",
        "field:pluginValue:token",
    ] {
        assert!(shown(cx, handle, selector), "{selector}");
    }
    let mut visual = VisualTestContext::from_window(handle.into(), cx);
    let order: Vec<f32> = [
        "plugin-value:loud",
        "plugin-value:side",
        "plugin-value:count",
    ]
    .iter()
    .map(|s| f32::from(visual.debug_bounds(s).expect("row").origin.y))
    .collect();
    assert!(order.windows(2).all(|w| w[0] < w[1]));
}

#[gpui::test]
fn a_plugin_that_is_off_shows_no_settings(cx: &mut TestAppContext) {
    let (_host, _plugins, handle) = open_page(cx, false);
    assert!(!shown(cx, handle, "plugin-value:loud"));
}

#[gpui::test]
fn toggles_and_choices_write_through_the_plugin_host(cx: &mut TestAppContext) {
    let (host, plugins, handle) = open_page(cx, true);
    click(cx, handle, "toggle:pluginValue:loud");
    assert_eq!(
        plugins.writes.lock().clone(),
        vec![("loud".to_owned(), SettingValue::Bool(true))]
    );
    host.set_menu_pick(Some(Some("right".into())));
    click(cx, handle, "popup:pluginValue:side");
    assert_eq!(
        plugins.writes.lock().last().cloned(),
        Some(("side".to_owned(), SettingValue::Text("right".into())))
    );
    let before = plugins.writes.lock().len();
    send_msg(
        cx,
        handle,
        value_command("demo", "side", &SettingValue::Bool(true)),
    );
    send_msg(
        cx,
        handle,
        value_command("other", "side", &SettingValue::Text("left".into())),
    );
    send(
        cx,
        handle,
        "settings:extras:value:demo\u{1f}side\u{1f}{\"x\":1}",
    );
    send(cx, handle, "settings:extras:value:demo");
    assert_eq!(plugins.writes.lock().len(), before);
}

#[gpui::test]
fn numbers_check_their_range_and_reset_when_wrong(cx: &mut TestAppContext) {
    let (_host, plugins, handle) = open_page(cx, true);
    assert_eq!(draft(cx, handle, "count"), "3");
    type_into(cx, handle, "count", "11");
    send(
        cx,
        handle,
        "settings:extras:saveField:demo\u{1f}count\u{1f}",
    );
    assert!(plugins.writes.lock().is_empty());
    assert_eq!(draft(cx, handle, "count"), "3");
    type_into(cx, handle, "count", " 7 ");
    send(
        cx,
        handle,
        "settings:extras:saveField:demo\u{1f}count\u{1f}",
    );
    assert_eq!(
        plugins.writes.lock().clone(),
        vec![("count".to_owned(), SettingValue::Number(7.0))]
    );
    assert_eq!(draft(cx, handle, "count"), "7");
    type_into(cx, handle, "count", "9");
    send(
        cx,
        handle,
        "settings:extras:resetField:demo\u{1f}count\u{1f}",
    );
    assert_eq!(draft(cx, handle, "count"), "7");
}

#[gpui::test]
fn text_saves_only_when_it_changed(cx: &mut TestAppContext) {
    let (_host, plugins, handle) = open_page(cx, true);
    send(cx, handle, "settings:extras:saveField:demo\u{1f}name\u{1f}");
    assert!(plugins.writes.lock().is_empty());
    type_into(cx, handle, "name", "Grace");
    send(cx, handle, "settings:extras:saveField:demo\u{1f}name\u{1f}");
    assert_eq!(
        plugins.writes.lock().clone(),
        vec![("name".to_owned(), SettingValue::Text("Grace".into()))]
    );
}

#[gpui::test]
fn secrets_save_clear_and_never_show_their_value(cx: &mut TestAppContext) {
    let (_host, plugins, handle) = open_page(cx, true);
    let status = |cx: &mut TestAppContext| {
        handle
            .read_with(cx, |view, _| {
                view.extras.plugin_values.secrets.get("token").cloned()
            })
            .expect("open")
            .unwrap_or_default()
    };
    assert_eq!(status(cx).saved, Some(false));
    assert!(!shown(cx, handle, "pluginSecret-clear:token"));
    send(
        cx,
        handle,
        "settings:extras:saveSecret:demo\u{1f}token\u{1f}",
    );
    assert!(plugins.secrets.lock().is_empty());
    type_into(cx, handle, "token", "hunter2");
    send(
        cx,
        handle,
        "settings:extras:saveSecret:demo\u{1f}token\u{1f}",
    );
    assert_eq!(
        plugins.secrets.lock().clone(),
        vec![("token".to_owned(), Some("hunter2".to_owned()))]
    );
    assert_eq!(status(cx).saved, Some(true));
    assert_eq!(draft(cx, handle, "token"), "");
    assert!(shown(cx, handle, "pluginSecret-clear:token"));
    send(
        cx,
        handle,
        "settings:extras:clearSecret:demo\u{1f}token\u{1f}",
    );
    assert_eq!(
        plugins.secrets.lock().last().cloned(),
        Some(("token".to_owned(), None))
    );
    assert_eq!(status(cx).saved, Some(false));
}

#[gpui::test]
fn turning_on_an_approved_plugin_skips_the_consent_sheet(cx: &mut TestAppContext) {
    let (_host, plugins, handle) = open_page(cx, false);
    *plugins.approved.lock() = true;
    send(cx, handle, "settings:extras:on:demo");
    assert_eq!(*plugins.consent_asked.lock(), 0);
    *plugins.approved.lock() = false;
    send(cx, handle, "settings:extras:on:demo");
    assert_eq!(*plugins.consent_asked.lock(), 1);
}

#[gpui::test]
fn plugin_commands_join_the_command_bar(cx: &mut TestAppContext) {
    let host = MockUiHost::fresh();
    let window = host
        .open_window(WindowKind::Main, Some("https://example.com"))
        .expect("a main window");
    let plugins = Arc::new(Plugins::default());
    let state = host.store().snapshot();
    let actions = crate::plugins::bar_actions::bar_actions(plugins.as_ref(), &state, &window);
    let ids: Vec<&str> = actions.iter().map(|a| a.id.as_str()).collect();
    assert_eq!(ids, vec!["plugin:demo/:page"]);
    assert!(crate::plugins::bar_actions::run_action(
        plugins.as_ref(),
        &state,
        &window,
        "plugin:demo/:page"
    ));
    assert_eq!(plugins.pages.lock().clone(), vec!["demo".to_owned()]);
    assert!(!crate::plugins::bar_actions::run_action(
        plugins.as_ref(),
        &state,
        &window,
        "plugin:demo/never"
    ));
    assert!(plugins.commands.lock().is_empty());
    let _ = cx;
}

#[gpui::test]
fn an_official_plugin_that_updated_itself_says_so(cx: &mut TestAppContext) {
    let (host, _plugins, handle) = open_page(cx, true);
    assert!(!shown(cx, handle, "plugin-auto-update"));
    host.set_plugin_details(vec![PluginDetail {
        official: true,
        auto_update: Some((
            "Updated by itself to 0.7.0".into(),
            "Its permissions didn't change.".into(),
        )),
        ..detail(true)
    }]);
    send(cx, handle, "settings:extras:open:demo");
    assert!(shown(cx, handle, "plugin-auto-update"));
}
