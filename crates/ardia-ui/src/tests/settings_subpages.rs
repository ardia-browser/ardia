use std::sync::Arc;

use ardia_state::windows::WindowKind;
use gpui::{Modifiers, SharedString, TestAppContext, VisualTestContext, WindowHandle};
use serde_json::json;

use crate::mock::MockUiHost;
use crate::msg::Msg;
use crate::settings::SettingsWindowView;
use crate::settings::data::{SettingsCall, SettingsQuery};
use crate::settings::rows::Pane;
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

fn detail(cx: &mut TestAppContext, handle: WindowHandle<SettingsWindowView>) -> Option<Detail> {
    handle
        .read_with(cx, |view, _| view.detail().cloned())
        .expect("open")
}

#[gpui::test]
fn the_passwords_row_opens_its_page_and_back_returns(cx: &mut TestAppContext) {
    let (_, handle) = settings(cx);
    click(cx, handle.into(), "settings-pane:Profiles");
    let link = crate::settings::rows::find("profiles.passwords").map(|row| row.control);
    assert_eq!(
        link,
        Some(crate::settings::rows::Control::Link(
            crate::settings::rows::Act::Command(crate::settings::subpages::OPEN_PASSWORDS)
        ))
    );
    send(cx, handle, crate::settings::subpages::OPEN_PASSWORDS);
    assert_eq!(detail(cx, handle), Some(Detail::Passwords));
    assert!(shown(cx, handle.into(), "passwords-locked"));
    click(cx, handle.into(), "settings-back");
    assert_eq!(detail(cx, handle), None);
    assert_eq!(
        handle.read_with(cx, |view, _| view.pane()).expect("open"),
        Pane::Profiles
    );
    click(cx, handle.into(), "settings-forward");
    assert_eq!(detail(cx, handle), Some(Detail::Passwords));
}

#[gpui::test]
fn unlocking_lists_passwords_and_a_click_opens_the_sheet(cx: &mut TestAppContext) {
    let (host, handle) = settings(cx);
    let profile = profile(&host);
    click(cx, handle.into(), "settings-pane:Profiles");
    send(cx, handle, "settings:sub:open:passwords");
    click(cx, handle.into(), "passwords-unlock");
    assert!(
        host.settings_calls()
            .contains(&SettingsCall::UnlockPasswords(profile.clone()))
    );
    host.set_settings_value(
        SettingsQuery::PasswordsUnlocked(profile.clone()),
        json!(true),
    );
    host.set_settings_value(
        SettingsQuery::Passwords(profile),
        json!({"passwords": [{"origin": "https://github.com", "username": "ada"}]}),
    );
    host.reply_to_settings("RevealPassword", json!({"password": "hunter2"}));
    send(cx, handle, "settings:sub:open:sites");
    send(cx, handle, "settings:sub:open:passwords");
    click(cx, handle.into(), "password:0");
    let sheet = handle
        .read_with(cx, |view, _| view.sub.sheet.clone())
        .expect("open");
    match sheet {
        Some(Sheet::Password {
            saved, revealed, ..
        }) => {
            assert_eq!(saved.username, "ada");
            assert_eq!(revealed.as_deref(), Some("hunter2"));
        }
        other => panic!("a password sheet, got {other:?}"),
    }
    send(cx, handle, "settings:sub:sheetClose");
    assert!(
        handle
            .read_with(cx, |view, _| view.sub.sheet.is_none())
            .expect("open")
    );
}

#[gpui::test]
fn site_pages_set_permissions_and_clear_data(cx: &mut TestAppContext) {
    let (host, handle) = settings(cx);
    let profile = profile(&host);
    host.set_settings_value(
        SettingsQuery::SiteOrigins(profile.clone()),
        json!({"origins": ["https://maps.example"]}),
    );
    host.set_settings_value(
        SettingsQuery::Site(profile.clone(), "https://maps.example".into()),
        json!({"location": {"value": "ask", "isDefault": true}}),
    );
    click(cx, handle.into(), "settings-pane:Profiles");
    click(cx, handle.into(), "setting:profiles.siteSettings");
    assert_eq!(detail(cx, handle), Some(Detail::Sites));
    click(cx, handle.into(), "site:https://maps.example");
    assert_eq!(
        detail(cx, handle),
        Some(Detail::Site("https://maps.example".into()))
    );
    send(cx, handle, "settings:sub:siteSet:location:allow");
    host.reply_to_settings("ClearSiteData", json!({"cookies": 2, "storage": true}));
    send(cx, handle, "settings:sub:siteClear");
    let calls = host.settings_calls();
    assert!(calls.contains(&SettingsCall::SetSiteSetting {
        profile,
        origin: "https://maps.example".into(),
        kind: "location".into(),
        value: "allow".into(),
    }));
    let status = handle
        .read_with(cx, |view, _| view.sub.site_status.clone())
        .expect("open");
    assert_eq!(
        status,
        Some((
            "https://maps.example".to_owned(),
            "Cleared 2 cookies and site data.".to_owned()
        ))
    );
}

#[gpui::test]
fn custom_search_engines_add_validate_and_delete(cx: &mut TestAppContext) {
    let (host, handle) = settings(cx);
    click(cx, handle.into(), "settings-pane:Profiles");
    send(cx, handle, crate::settings::subpages::OPEN_OTHER_ENGINES);
    assert_eq!(detail(cx, handle), Some(Detail::OtherEngines));
    send(cx, handle, "settings:sub:engine:new");
    send(cx, handle, "settings:sub:sheetSave");
    let error = handle
        .read_with(cx, |view, _| match &view.sub.sheet {
            Some(Sheet::Engine { error, .. }) => error.clone(),
            _ => None,
        })
        .expect("open");
    assert_eq!(error.as_deref(), Some("Enter a name."));
    let fields = handle
        .read_with(cx, |view, _| view.sub.fields.clone())
        .expect("open");
    let texts = ["Docs", "d", "https://docs.rs/releases/search?query=%s"];
    for (field, text) in fields.iter().zip(texts) {
        cx.update(|cx| field.update(cx, |input, cx| input.set_text(text, false, cx)));
    }
    send(cx, handle, "settings:sub:sheetSave");
    let engines = host
        .store()
        .snapshot()
        .settings
        .custom_search_engines
        .clone();
    assert_eq!(engines.len(), 1);
    assert_eq!(engines[0].keyword, "d");
    let id = engines[0].id.clone();
    send(cx, handle, &format!("settings:sub:engine:edit:{id}"));
    send(cx, handle, "settings:sub:engine:delete");
    assert!(
        host.store()
            .snapshot()
            .settings
            .custom_search_engines
            .is_empty()
    );
}

#[gpui::test]
fn addresses_save_through_the_sheet(cx: &mut TestAppContext) {
    let (host, handle) = settings(cx);
    let profile = profile(&host);
    host.set_settings_value(SettingsQuery::Addresses(profile), json!({"addresses": []}));
    click(cx, handle.into(), "settings-pane:Profiles");
    send(cx, handle, crate::settings::subpages::OPEN_ADDRESSES);
    send(cx, handle, "settings:sub:address:new");
    let fields = handle
        .read_with(cx, |view, _| view.sub.fields.clone())
        .expect("open");
    assert_eq!(fields.len(), 10);
    cx.update(|cx| fields[0].update(cx, |input, cx| input.set_text("Ada", false, cx)));
    cx.update(|cx| fields[2].update(cx, |input, cx| input.set_text("1 Main St", false, cx)));
    send(cx, handle, "settings:sub:sheetSave");
    let saved = host
        .settings_calls()
        .into_iter()
        .find_map(|call| match call {
            SettingsCall::SaveAddress { address, .. } => Some(address),
            _ => None,
        });
    let saved = saved.expect("an address was saved");
    assert_eq!(saved["name"], "Ada");
    assert_eq!(saved["street"], "1 Main St");
}

#[gpui::test]
fn extensions_list_in_profiles_and_open_their_page(cx: &mut TestAppContext) {
    let (host, handle) = settings(cx);
    let profile = profile(&host);
    host.set_settings_value(
        SettingsQuery::Extensions(profile.clone()),
        json!({"extensions": [{"id": "abc", "name": "Dark Reader", "version": "4.9", "enabled": true,
            "fromWebStore": true, "mayModify": true, "permissions": ["storage"]}]}),
    );
    click(cx, handle.into(), "settings-pane:Profiles");
    handle
        .update(cx, |view, _, cx| view.reveal("profiles.extensions", cx))
        .expect("open");
    cx.run_until_parked();
    assert!(shown(cx, handle.into(), "extension:abc"));
    send(cx, handle, "settings:sub:open:extension:abc");
    assert_eq!(detail(cx, handle), Some(Detail::Extension("abc".into())));
    send(cx, handle, "settings:sub:ext:configure:pinned:true");
    assert!(
        host.settings_calls()
            .contains(&SettingsCall::ConfigureExtension {
                profile,
                id: "abc".into(),
                options: json!({"pinned": true}),
            })
    );
}

#[gpui::test]
fn export_bookmarks_reports_where_it_saved(cx: &mut TestAppContext) {
    let (host, handle) = settings(cx);
    host.reply_to_settings(
        "ExportBookmarks",
        json!({"path": "/Users/me/Documents/Ardia Bookmarks.html"}),
    );
    click(cx, handle.into(), "settings-pane:Profiles");
    assert!(shown(cx, handle.into(), "button:profiles.exportBookmarks"));
    send(cx, handle, crate::settings::subpages::EXPORT_BOOKMARKS);
    let status = handle
        .read_with(cx, |view, _| view.sub.bookmarks_status.clone())
        .expect("open");
    assert_eq!(
        status.as_deref(),
        Some("Saved “Ardia Bookmarks.html” to “Documents”.")
    );
}

fn blocker_calls(host: &MockUiHost) -> Vec<crate::site::model::ContentBlockerCommand> {
    host.calls()
        .into_iter()
        .filter_map(|call| match call {
            crate::mock::HostCall::ContentBlocker(command) => Some(command),
            _ => None,
        })
        .collect()
}

#[gpui::test]
fn content_blocking_toggles_and_filter_lists_drive_the_blocker(cx: &mut TestAppContext) {
    use crate::site::model::{
        BlockerList, BlockerStats, ContentBlockerCommand, ContentBlockerView,
    };
    let (host, handle) = settings(cx);
    host.set_content_blocker(Some(ContentBlockerView {
        enabled: true,
        version: "1.60".into(),
        lists: vec![
            BlockerList {
                id: "easyprivacy".into(),
                title: "EasyPrivacy".into(),
                category: "trackers".into(),
                enabled: false,
                default_on: true,
                filters: 40,
                failed: false,
            },
            BlockerList {
                id: "easylist".into(),
                title: "EasyList".into(),
                category: "ads".into(),
                enabled: true,
                default_on: true,
                filters: 70,
                failed: false,
            },
        ],
        allowed_hosts: vec!["news.example".into()],
        stats: BlockerStats {
            ready: true,
            enabled: true,
            ..BlockerStats::default()
        },
    }));
    send(cx, handle, "settings:sub:blocker:category:trackers:true");
    assert!(
        blocker_calls(&host).contains(&ContentBlockerCommand::SetListEnabled {
            id: "easyprivacy".into(),
            enabled: true
        })
    );
    send(
        cx,
        handle,
        crate::settings::general_subpages::OPEN_FILTER_LISTS,
    );
    assert_eq!(detail(cx, handle), Some(Detail::FilterLists));
    assert!(shown(cx, handle.into(), "custom-list-field"));
    send(cx, handle, "settings:sub:blocker:blockAgain:news.example");
    assert!(
        blocker_calls(&host).contains(&ContentBlockerCommand::SetAllowed {
            host: "news.example".into(),
            allowed: false
        })
    );
}

#[gpui::test]
fn crash_details_show_the_identity_and_reset_it(cx: &mut TestAppContext) {
    let (host, handle) = settings(cx);
    host.set_settings_value(
        SettingsQuery::SavedInstallId,
        json!({"installId": "abc-123"}),
    );
    host.reply_to_settings("ResetAnonymousId", json!({"installId": "fresh-id"}));
    send(
        cx,
        handle,
        crate::settings::general_subpages::OPEN_CRASH_DETAILS,
    );
    assert_eq!(detail(cx, handle), Some(Detail::CrashDetails));
    click(cx, handle.into(), "identity-reset");
    click(cx, handle.into(), "reset-confirm");
    let sheet = handle
        .read_with(cx, |view, _| view.sub.sheet.clone())
        .expect("open");
    let name = crate::report::identity::anonymous_identity("fresh-id").name;
    assert_eq!(sheet, Some(Sheet::ResetId { done: Some(name) }));
    assert!(
        host.settings_calls()
            .contains(&SettingsCall::ResetAnonymousId)
    );
}

#[gpui::test]
fn allowed_programs_list_and_revoke(cx: &mut TestAppContext) {
    let (host, handle) = settings(cx);
    host.set_settings_value(
        SettingsQuery::ControlApprovals,
        json!({"approvals": [{"key": "k1", "name": "python3", "signedBy": "Not signed"}], "doorbell": true}),
    );
    click(cx, handle.into(), "settings-pane:Advanced");
    handle
        .update(cx, |view, _, cx| {
            view.reveal("advanced.allowedPrograms", cx)
        })
        .expect("open");
    cx.run_until_parked();
    assert!(shown(cx, handle.into(), "approval:k1"));
    send(cx, handle, "settings:sub:approval:revoke:k1");
    assert!(
        host.settings_calls()
            .contains(&SettingsCall::RevokeApproval("k1".into()))
    );
}

#[gpui::test]
fn an_extension_search_engine_shows_the_controlling_row(cx: &mut TestAppContext) {
    let (host, handle) = settings(cx);
    host.dispatch(ardia_state::Action::UpdateSettings {
        patch: ardia_state::settings::SettingsPatch::new().set(
            "extensionSearchEngines",
            json!([{"profile": "p", "extensionId": "ext1", "extensionName": "Bing Plus",
                "name": "Bing", "keyword": "b", "url": "https://bing.com/?q=%s", "isDefault": true}]),
        ),
        from_sync: false,
    });
    click(cx, handle.into(), "settings-pane:Profiles");
    handle
        .update(cx, |view, _, cx| view.reveal("profiles.searchEngine", cx))
        .expect("open");
    cx.run_until_parked();
    assert!(shown(
        cx,
        handle.into(),
        "setting:profiles.searchControlled"
    ));
    send(cx, handle, "settings:sub:ext:enable:false:ext1");
    let profile = profile(&host);
    assert!(
        host.settings_calls()
            .contains(&SettingsCall::SetExtensionEnabled {
                profile,
                id: "ext1".into(),
                enabled: false,
            })
    );
}
