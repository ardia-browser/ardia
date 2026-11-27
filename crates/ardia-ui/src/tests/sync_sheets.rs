use std::sync::Arc;

use ardia_state::windows::WindowKind;
use gpui::{Entity, SharedString, TestAppContext, VisualTestContext, WindowHandle};

use crate::host_data::{SyncDevice, SyncStatus, SyncedProfile};
use crate::mock::{HostCall, MockUiHost};
use crate::msg::Msg;
use crate::settings::SettingsWindowView;
use crate::sync_api::{
    DeviceKind, FolderInfo, PhraseProblem, RemoteProfile, SyncAction, SyncAnswer, SyncEngineView,
    SyncState, SyncedDevice,
};
use crate::{UiHost, bind_global_keybindings, open_settings_window};

fn open(cx: &mut TestAppContext, host: &Arc<MockUiHost>) -> WindowHandle<SettingsWindowView> {
    cx.update(bind_global_keybindings);
    host.open_window(WindowKind::Main, Some("https://example.com"));
    let shared: Arc<dyn UiHost> = host.clone();
    let handle = cx
        .update(|cx| open_settings_window(shared, cx))
        .expect("settings open")
        .downcast::<SettingsWindowView>()
        .expect("a settings window");
    cx.run_until_parked();
    handle
}

fn run(cx: &mut TestAppContext, handle: WindowHandle<SettingsWindowView>, command: &str) {
    handle
        .update(cx, |view, window, cx| {
            view.handle(
                Msg::Command(SharedString::from(format!("settings:sync:{command}"))),
                window,
                cx,
            )
        })
        .expect("open");
    cx.run_until_parked();
}

fn sheet(
    cx: &mut TestAppContext,
    handle: WindowHandle<SettingsWindowView>,
) -> Option<&'static str> {
    handle
        .read_with(cx, |view, _| view.sync.sheet_name())
        .expect("open")
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

fn folder() -> FolderInfo {
    FolderInfo {
        path: "/tmp/sync-test/Ardia Sync".into(),
        default_path: "/tmp/sync-test/Ardia Sync".into(),
        icloud_available: true,
        exists: true,
        writable: true,
        ..FolderInfo::default()
    }
}

fn on(state: SyncState) -> SyncStatus {
    SyncStatus {
        loaded: true,
        enabled: true,
        folder: Some(folder().path),
        engine: SyncEngineView {
            state,
            folder_info: Some(folder()),
            ..SyncEngineView::default()
        },
        ..SyncStatus::default()
    }
}

#[gpui::test]
fn turning_on_shows_the_recovery_kit(cx: &mut TestAppContext) {
    let host = MockUiHost::fresh();
    host.queue_sync_answer(SyncAnswer::Folder(Some(folder())));
    let handle = open(cx, &host);
    assert!(shown(cx, handle, "sync-turn-on"));
    assert!(shown(cx, handle, "sync-more"));
    run(cx, handle, "turnOn");
    assert_eq!(sheet(cx, handle), Some("recoveryKit"));
    assert!(
        matches!(host.sync_actions().iter().find(|a| matches!(a, SyncAction::TurnOn { .. })), Some(SyncAction::TurnOn { folder }) if folder == "/tmp/sync-test/Ardia Sync")
    );
    assert!(
        host.sync_actions()
            .iter()
            .any(|a| matches!(a, SyncAction::RecoveryKitPreview { width } if *width == 168.))
    );
    assert!(shown(cx, handle, "sync-kit-preview"));
    assert!(shown(cx, handle, "sync-kit-warning"));
    host.queue_sync_answer(SyncAnswer::Path(Some(
        "/Users/me/Desktop/Ardia Recovery Kit.pdf".into(),
    )));
    run(cx, handle, "kitSave");
    assert!(shown(cx, handle, "sync-kit-saved"));
    run(cx, handle, "close");
    assert_eq!(sheet(cx, handle), None);
}

#[gpui::test]
fn a_failed_turn_on_shows_the_reason_under_the_row(cx: &mut TestAppContext) {
    let host = MockUiHost::fresh();
    host.queue_sync_answer(SyncAnswer::Folder(Some(folder())));
    let handle = open(cx, &host);
    host.queue_sync_answer(SyncAnswer::Failed(
        "Couldn’t use that folder: denied".into(),
    ));
    run(cx, handle, "turnOn");
    assert_eq!(sheet(cx, handle), None);
    assert_eq!(
        handle
            .read_with(cx, |view, _| view.sync.failure.clone())
            .expect("open")
            .as_deref(),
        Some("Couldn’t use that folder: denied")
    );
    assert!(shown(cx, handle, "sync-failure"));
}

#[gpui::test]
fn the_phrase_sheet_counts_words_and_shows_errors(cx: &mut TestAppContext) {
    let host = MockUiHost::fresh();
    let mut found = folder();
    found.has_sync_data = true;
    host.queue_sync_answer(SyncAnswer::Folder(Some(found)));
    let handle = open(cx, &host);
    assert!(shown(cx, handle, "sync-phrase"));
    run(cx, handle, "phrase");
    assert_eq!(sheet(cx, handle), Some("phrase"));
    assert!(shown(cx, handle, "sync-phrase-folder"));
    assert!(shown(cx, handle, "sync-phrase-change"));
    let input: Entity<crate::primitives::text_input::TextInput> = handle
        .read_with(cx, |view, _| view.sync.phrase_input.clone())
        .expect("open")
        .expect("input");
    let words = ["abandon"; 24].join(" ");
    cx.update(|cx| input.update(cx, |input, cx| input.set_text(words.clone(), false, cx)));
    cx.run_until_parked();
    host.queue_sync_answer(SyncAnswer::Phrase(Err(PhraseProblem::Checksum)));
    run(cx, handle, "phraseConnect");
    let error = handle
        .read_with(cx, |view, _| match &view.sync.sheet {
            Some(crate::settings::sync_sheets::SyncSheet::Phrase { error, .. }) => error.clone(),
            _ => None,
        })
        .expect("open");
    assert_eq!(
        error.as_deref(),
        Some("This recovery phrase is not valid. Please check for typos.")
    );
    host.queue_sync_answer(SyncAnswer::Phrase(Ok(())));
    run(cx, handle, "phraseConnect");
    assert_eq!(sheet(cx, handle), Some("joined"));
    assert!(
        host.sync_actions()
            .iter()
            .any(|a| matches!(a, SyncAction::EnterPhrase { phrase, .. } if phrase.0 == words))
    );
}

#[gpui::test]
fn syncing_lists_devices_and_profiles_from_other_devices(cx: &mut TestAppContext) {
    let host = MockUiHost::fresh();
    let handle = open(cx, &host);
    let mut status = on(SyncState::Updated);
    status.profiles = vec![SyncedProfile {
        profile_id: ardia_state::ProfileId::new("default"),
        enabled: true,
    }];
    status.devices = vec![SyncDevice::default()];
    status.engine.devices = vec![
        SyncedDevice {
            id: "ME".into(),
            name: "Studio".into(),
            current: true,
            ..SyncedDevice::default()
        },
        SyncedDevice {
            id: "PH".into(),
            name: "iPhone".into(),
            kind: DeviceKind::Phone,
            last_seen: Some(1),
            ..SyncedDevice::default()
        },
    ];
    status.engine.remote_profiles = vec![
        RemoteProfile {
            sync_id: "A".into(),
            name: "Work".into(),
            color: "blue".into(),
            ..RemoteProfile::default()
        },
        RemoteProfile {
            sync_id: "B".into(),
            name: "Home".into(),
            color: "green".into(),
            ..RemoteProfile::default()
        },
    ];
    host.set_sync_status(status);
    cx.run_until_parked();
    assert!(shown(cx, handle, "sync-connect"));
    assert!(shown(cx, handle, "sync-advanced"));
    assert!(shown(cx, handle, "sync-device-remove"));
    assert!(shown(cx, handle, "sync-add-all"));
    assert!(shown(cx, handle, "sync-icon-on"));
    run(cx, handle, "addAll");
    let adds: Vec<String> = host
        .sync_actions()
        .into_iter()
        .filter_map(|a| match a {
            SyncAction::AddRemoteProfile(id) => Some(id),
            _ => None,
        })
        .collect();
    assert_eq!(adds, ["A", "B"]);
    host.set_confirm_answer(true);
    run(cx, handle, "removeDevice:PH");
    assert!(host.calls().iter().any(|c| matches!(c, HostCall::Confirm { question, .. } if question.title == "Remove “iPhone” from Sync?" && question.destructive)));
    assert!(
        host.sync_actions()
            .iter()
            .any(|a| matches!(a, SyncAction::RemoveDevice(id) if id == "PH"))
    );
}

#[gpui::test]
fn connecting_another_device_reveals_the_code_and_words(cx: &mut TestAppContext) {
    let host = MockUiHost::fresh();
    let handle = open(cx, &host);
    host.set_sync_status(on(SyncState::Updated));
    cx.run_until_parked();
    run(cx, handle, "connect");
    assert_eq!(sheet(cx, handle), Some("connect"));
    assert!(shown(cx, handle, "sync-show-code"));
    host.queue_sync_answer(SyncAnswer::Words(Some(
        (0..24).map(|i| format!("w{i}")).collect(),
    )));
    run(cx, handle, "toggleWords");
    assert!(shown(cx, handle, "sync-words"));
    run(cx, handle, "toggleWords");
    assert!(!shown(cx, handle, "sync-words"));
    run(cx, handle, "copyWords");
    assert!(
        host.sync_actions()
            .iter()
            .any(|a| matches!(a, SyncAction::CopyRecoveryPhrase))
    );
}

#[gpui::test]
fn stopping_asks_whether_to_delete_the_data(cx: &mut TestAppContext) {
    let host = MockUiHost::fresh();
    let handle = open(cx, &host);
    host.set_sync_status(on(SyncState::Updated));
    cx.run_until_parked();
    run(cx, handle, "stop");
    assert_eq!(sheet(cx, handle), Some("stop"));
    run(cx, handle, "stopConfirm");
    assert_eq!(sheet(cx, handle), Some("deleteData"));
    run(cx, handle, "deleteData");
    assert!(
        !host
            .sync_actions()
            .iter()
            .any(|a| matches!(a, SyncAction::Stop { .. })),
        "nothing is deleted until the box is ticked"
    );
    run(cx, handle, "understood");
    run(cx, handle, "deleteData");
    assert!(
        host.sync_actions()
            .iter()
            .any(|a| matches!(a, SyncAction::Stop { delete_data: true }))
    );
    assert_eq!(sheet(cx, handle), None);
}

#[gpui::test]
fn a_locked_mac_offers_the_phrase_and_shows_why(cx: &mut TestAppContext) {
    let host = MockUiHost::fresh();
    let handle = open(cx, &host);
    let mut status = on(SyncState::Locked);
    status.engine.error = Some("Enter your recovery phrase to keep syncing on this Mac.".into());
    host.set_sync_status(status);
    cx.run_until_parked();
    assert!(shown(cx, handle, "sync-phrase"));
    assert!(shown(cx, handle, "sync-error"));
    assert!(shown(cx, handle, "sync-icon-off"));
    run(cx, handle, "lockedPhrase");
    assert_eq!(sheet(cx, handle), Some("phrase"));
    assert!(!shown(cx, handle, "sync-phrase-change"));
}

#[test]
fn send_tab_and_your_devices_menus_read_like_the_old_ones() {
    use crate::popovers::context_menu::{MenuEntry, titles};
    use crate::popovers::menu_items::{send_tab_entry, tab_or_selection_with};
    use crate::sidebar::overflow_menu::overflow_menu_with;
    use crate::sync_api::{RemoteTab, RemoteTabs, SendTarget};
    let host = MockUiHost::fresh();
    let window_id = host
        .open_window(WindowKind::Main, Some("https://example.com"))
        .expect("window");
    let state = host.store().snapshot();
    let window = state.windows.get(&window_id).expect("window").clone();
    let tab = state
        .tabs
        .values()
        .find(|t| t.window_id == window_id)
        .expect("tab")
        .clone();
    let phone = SendTarget {
        id: "P".into(),
        name: "Mantra’s iPhone".into(),
        kind: DeviceKind::Phone,
    };
    let mac = SendTarget {
        id: "M".into(),
        name: "Studio".into(),
        kind: DeviceKind::Mac,
    };
    assert!(send_tab_entry(&tab, &[]).is_none());
    let one = send_tab_entry(&tab, std::slice::from_ref(&phone)).expect("one");
    assert_eq!(one.title(), Some("Send to Mantra’s iPhone"));
    let both = send_tab_entry(&tab, &[phone.clone(), mac]).expect("two");
    assert!(
        matches!(&both, MenuEntry::Submenu(sub) if sub.title.as_ref() == "Send to Device" && sub.children.len() == 2)
    );
    assert!(
        titles(&tab_or_selection_with(&state, &window, &tab.id, &[phone]))
            .iter()
            .any(|t| t == "Send to Mantra’s iPhone")
    );
    let devices = vec![RemoteTabs {
        device_id: "M".into(),
        name: "Ann’s MacBook Pro".into(),
        kind: DeviceKind::Mac,
        tabs: vec![RemoteTab {
            url: "https://a.com".into(),
            title: String::new(),
        }],
    }];
    let menu = titles(&overflow_menu_with(&state, &window, &devices));
    let at = menu
        .iter()
        .position(|t| t == "Your MacBook Pro Tabs")
        .expect("listed");
    assert_eq!(menu[at - 1], "Open Tabs");
    assert_eq!(menu[at + 1], "Recently Closed");
    let mut two = devices;
    two.push(RemoteTabs {
        device_id: "P".into(),
        name: "iPhone".into(),
        kind: DeviceKind::Phone,
        tabs: vec![RemoteTab {
            url: "https://b.com".into(),
            title: "B".into(),
        }],
    });
    assert!(
        titles(&overflow_menu_with(&state, &window, &two))
            .iter()
            .any(|t| t == "Your Devices")
    );
}
