use std::sync::Arc;

use ardia_state::windows::WindowKind;
use gpui::{Modifiers, SharedString, TestAppContext, VisualTestContext, WindowHandle};
use serde_json::json;

use crate::mock::MockUiHost;
use crate::msg::Msg;
use crate::settings::SettingsWindowView;
use crate::settings::data::{SettingsCall, SettingsQuery};
use crate::settings::subpages::{Detail, Sheet};
use crate::{UiHost, bind_global_keybindings, open_settings_window};

fn settings(cx: &mut TestAppContext) -> (Arc<MockUiHost>, WindowHandle<SettingsWindowView>) {
    cx.update(bind_global_keybindings);
    let host = MockUiHost::fresh();
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

fn profile(host: &MockUiHost) -> ardia_state::ProfileId {
    ardia_state::ProfileId::from(host.store().snapshot().settings.default_profile_id.clone())
}

fn sheet(cx: &mut TestAppContext, handle: WindowHandle<SettingsWindowView>) -> Option<Sheet> {
    handle
        .read_with(cx, |view, _| view.sub.sheet.clone())
        .expect("open")
}

fn type_into_first_field(
    cx: &mut TestAppContext,
    handle: WindowHandle<SettingsWindowView>,
    text: &str,
) {
    let fields = handle
        .read_with(cx, |view, _| view.sub.fields.clone())
        .expect("open");
    let text = text.to_owned();
    cx.update(|cx| fields[0].update(cx, |input, cx| input.set_text(text, false, cx)));
    cx.run_until_parked();
}

fn extension(host: &MockUiHost, site_access: &str, sites: &[&str]) {
    host.set_settings_value(
        SettingsQuery::Extensions(profile(host)),
        json!({"extensions": [{"id": "abc", "name": "Dark Reader", "version": "4.9", "enabled": true,
            "fromWebStore": true, "mayModify": true, "permissions": ["storage"],
            "siteAccess": site_access, "sites": sites}]}),
    );
}

#[gpui::test]
fn the_extensions_more_menu_offers_link_and_unpacked(cx: &mut TestAppContext) {
    let (host, handle) = settings(cx);
    click(cx, handle.into(), "settings-pane:Profiles");
    handle
        .update(cx, |view, _, cx| view.reveal("profiles.extensions", cx))
        .expect("open");
    cx.run_until_parked();
    assert!(shown(cx, handle.into(), "extensions-more"));
    let titles: Vec<String> = crate::settings::subpages::more_menu_items()
        .into_iter()
        .map(|item| item.title)
        .collect();
    assert_eq!(titles, ["Add from a Link…", "Load Unpacked Extension…"]);
    host.set_menu_pick(Some(Some("link".into())));
    click(cx, handle.into(), "extensions-more");
    assert!(
        host.settings_calls()
            .contains(&SettingsCall::AddExtensionFromLink(profile(&host)))
    );
}

#[gpui::test]
fn a_bad_store_link_shows_the_old_error_dialog(cx: &mut TestAppContext) {
    let (host, handle) = settings(cx);
    host.reply_to_settings(
        "AddExtensionFromLink",
        json!({"error": ardia_state::extension_rules::NOT_A_STORE_LINK}),
    );
    host.set_menu_pick(Some(Some("link".into())));
    click(cx, handle.into(), "settings-pane:Profiles");
    send(cx, handle, "settings:sub:ext:more");
    assert!(shown(cx, handle.into(), "extension-install-error"));
    send(cx, handle, "settings:sub:sheetSave");
    assert_eq!(sheet(cx, handle), None);
}

#[gpui::test]
fn loading_unpacked_asks_then_installs_into_the_profile(cx: &mut TestAppContext) {
    let (host, handle) = settings(cx);
    host.reply_to_settings(
        "ChooseUnpackedExtension",
        json!({"name": "Tidy", "path": "/tmp/tidy", "warnings": ["Read your browsing history"]}),
    );
    host.set_menu_pick(Some(Some("unpacked".into())));
    click(cx, handle.into(), "settings-pane:Profiles");
    send(cx, handle, "settings:sub:ext:more");
    assert!(shown(cx, handle.into(), "extension-install-path"));
    assert!(matches!(
        sheet(cx, handle),
        Some(Sheet::ExtensionInstall { ref name, ref warnings, .. })
            if name == "Tidy" && warnings == &["Read your browsing history".to_owned()]
    ));
    send(cx, handle, "settings:sub:sheetSave");
    assert!(
        host.settings_calls()
            .contains(&SettingsCall::InstallUnpackedExtension {
                profile: profile(&host),
                path: "/tmp/tidy".into(),
            })
    );
    assert_eq!(sheet(cx, handle), None);
}

#[gpui::test]
fn add_site_validates_then_grants_the_site(cx: &mut TestAppContext) {
    let (host, handle) = settings(cx);
    extension(&host, "ON_SPECIFIC_SITES", &["*://a.com/*"]);
    click(cx, handle.into(), "settings-pane:Profiles");
    send(cx, handle, "settings:sub:open:extension:abc");
    assert_eq!(
        handle
            .read_with(cx, |view, _| view.detail().cloned())
            .expect("open"),
        Some(Detail::Extension("abc".into()))
    );
    send(cx, handle, "settings:sub:ext:addSite");
    assert!(shown(cx, handle.into(), "add-site-field"));
    type_into_first_field(cx, handle, "example.com:8080");
    send(cx, handle, "settings:sub:sheetSave");
    assert!(shown(cx, handle.into(), "add-site-error"));
    type_into_first_field(cx, handle, "https://*.example.com");
    send(cx, handle, "settings:sub:sheetSave");
    assert!(
        host.settings_calls()
            .contains(&SettingsCall::ConfigureExtension {
                profile: profile(&host),
                id: "abc".into(),
                options: json!({"siteAccess": "specificSites", "grantSite": "https://*.example.com/*"}),
            })
    );
    assert_eq!(sheet(cx, handle), None);
}

#[gpui::test]
fn removing_a_site_revokes_it_like_the_engine_expects(cx: &mut TestAppContext) {
    let (host, handle) = settings(cx);
    extension(&host, "ON_SPECIFIC_SITES", &["*://a.com/*"]);
    click(cx, handle.into(), "settings-pane:Profiles");
    send(cx, handle, "settings:sub:open:extension:abc");
    send(cx, handle, "settings:sub:ext:removeSite:*://a.com/*");
    assert!(
        host.settings_calls()
            .contains(&SettingsCall::ConfigureExtension {
                profile: profile(&host),
                id: "abc".into(),
                options: json!({"revokeSite": "*://a.com/*"}),
            })
    );
}

#[gpui::test]
fn hidden_elements_list_by_host_and_show_again_restores_them(cx: &mut TestAppContext) {
    let (host, handle) = settings(cx);
    let profile = profile(&host);
    host.set_settings_value(
        SettingsQuery::HiddenElements(profile.clone()),
        json!([
            "news.com##div.ad",
            "news.com##aside > p:nth-of-type(2)",
            "blog.org##.banner"
        ]),
    );
    send(
        cx,
        handle,
        crate::settings::general_subpages::OPEN_FILTER_LISTS,
    );
    assert!(shown(cx, handle.into(), "hidden-show:news.com"));
    send(cx, handle, "settings:sub:hidden:restore:news.com");
    assert!(
        host.settings_calls()
            .contains(&SettingsCall::RestoreHiddenElements {
                profile,
                filters: vec![
                    "news.com##div.ad".into(),
                    "news.com##aside > p:nth-of-type(2)".into()
                ],
            })
    );
}

#[test]
fn hidden_host_descriptions_read_like_the_old_rows() {
    use crate::settings::general_subpages::{hidden_by_host, hidden_host_description};
    let filters: Vec<String> = [
        "a.com##.x",
        "a.com##.y",
        "a.com##div > .z",
        "a.com##p:nth-of-type(3)",
    ]
    .iter()
    .map(|s| s.to_string())
    .collect();
    let hosts = hidden_by_host(&filters);
    assert_eq!(hosts.len(), 1);
    assert_eq!(
        hidden_host_description(&hosts[0].1),
        "4 elements: .x, .y, .z and 1 more"
    );
    let one = hidden_by_host(&["b.com##.solo".to_owned()]);
    assert_eq!(hidden_host_description(&one[0].1), "1 element: .solo");
}

#[test]
fn install_sheets_come_from_the_inspect_answer() {
    use crate::settings::subpages::install_sheet_for;
    assert_eq!(install_sheet_for(&Ok(json!({}))), None);
    assert!(matches!(
        install_sheet_for(&Ok(
            json!({"error": "Manifest file is missing or unreadable"})
        )),
        Some(Sheet::ExtensionInstall { error: Some(_), .. })
    ));
    assert!(matches!(
        install_sheet_for(&Ok(json!({"name": "", "path": "/x"}))),
        Some(Sheet::ExtensionInstall { ref name, error: None, .. }) if name == "Extension"
    ));
    assert_eq!(
        crate::settings::subpages::site_change_reason(" Not allowed. ", "x"),
        "Not allowed."
    );
    assert_eq!(
        crate::settings::subpages::site_change_reason("", "fallback"),
        "fallback"
    );
}
