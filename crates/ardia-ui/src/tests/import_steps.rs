use std::sync::Arc;

use ardia_state::windows::WindowKind;
use gpui::{TestAppContext, VisualTestContext, WindowHandle};

use crate::host_data::{ImportBrowser, ImportBrowserProfile};
use crate::import::{ImportWindowView, Stage};
use crate::mock::{HostCall, MockUiHost};
use crate::{UiHost, bind_global_keybindings, open_import_window};

fn open(
    cx: &mut TestAppContext,
    browser: ImportBrowser,
) -> (Arc<MockUiHost>, WindowHandle<ImportWindowView>) {
    cx.update(bind_global_keybindings);
    let host = MockUiHost::fresh();
    host.open_window(WindowKind::Main, Some("https://example.com"));
    host.set_import_browsers(Some(vec![browser]));
    let shared: Arc<dyn UiHost> = host.clone();
    let handle = cx
        .update(|cx| open_import_window(shared, cx))
        .expect("import opens")
        .downcast::<ImportWindowView>()
        .expect("an import window");
    cx.run_until_parked();
    (host, handle)
}

fn click(cx: &mut TestAppContext, handle: WindowHandle<ImportWindowView>, selector: &'static str) {
    let mut visual = VisualTestContext::from_window(handle.into(), cx);
    visual.run_until_parked();
    let at = visual
        .debug_bounds(selector)
        .unwrap_or_else(|| panic!("{selector} is shown"));
    visual.simulate_click(at.center(), gpui::Modifiers::none());
    visual.run_until_parked();
}

fn stage(cx: &mut TestAppContext, handle: WindowHandle<ImportWindowView>) -> Stage {
    handle
        .read_with(cx, |view, _| view.stage().clone())
        .expect("open")
}

fn chrome() -> ImportBrowser {
    ImportBrowser {
        id: "chrome".into(),
        name: "Chrome".into(),
        profiles: vec![ImportBrowserProfile {
            id: "Default".into(),
            name: "Personal".into(),
            path: "/browsers/chrome".into(),
            email: None,
            is_default: true,
        }],
        kinds: vec!["bookmarks".into(), "passwords".into(), "cookies".into()],
    }
}

#[gpui::test]
fn encrypted_data_asks_to_unlock_and_skipping_leaves_it_out(cx: &mut TestAppContext) {
    let (host, handle) = open(cx, chrome());
    click(cx, handle, "import-start");
    assert_eq!(stage(cx, handle), Stage::Unlock { error: None });
    let mut visual = VisualTestContext::from_window(handle.into(), cx);
    assert!(visual.debug_bounds("import-unlock").is_some());
    click(cx, handle, "import-skip-encrypted");
    let plan = host
        .calls()
        .into_iter()
        .find_map(|call| match call {
            HostCall::RunImport(plan) => Some(plan),
            _ => None,
        })
        .expect("an import ran");
    assert_eq!(plan.kinds, vec!["bookmarks".to_owned()]);
}

#[gpui::test]
fn unlocking_imports_the_encrypted_kinds_too(cx: &mut TestAppContext) {
    let (host, handle) = open(cx, chrome());
    click(cx, handle, "import-start");
    click(cx, handle, "import-unlock");
    let plan = host
        .calls()
        .into_iter()
        .find_map(|call| match call {
            HostCall::RunImport(plan) => Some(plan),
            _ => None,
        })
        .expect("an import ran");
    assert!(
        plan.kinds.contains(&"passwords".to_owned()) && plan.kinds.contains(&"cookies".to_owned())
    );
}

#[gpui::test]
fn safari_asks_for_full_disk_access_and_offers_the_export_file(cx: &mut TestAppContext) {
    let (_host, handle) = open(
        cx,
        ImportBrowser {
            id: "safari".into(),
            name: "Safari".into(),
            profiles: Vec::new(),
            kinds: vec!["bookmarks".into(), "history".into()],
        },
    );
    click(cx, handle, "import-start");
    assert_eq!(stage(cx, handle), Stage::Safari { error: None });
    let mut visual = VisualTestContext::from_window(handle.into(), cx);
    assert!(visual.debug_bounds("import-safari-access").is_some());
    assert!(visual.debug_bounds("import-open-fda").is_some());
    assert!(visual.debug_bounds("import-drop").is_some());
    click(cx, handle, "import-back");
    assert_eq!(stage(cx, handle), Stage::Choosing);
}

fn safari() -> ImportBrowser {
    ImportBrowser {
        id: "safari".into(),
        name: "Safari".into(),
        profiles: Vec::new(),
        kinds: vec!["bookmarks".into(), "history".into()],
    }
}

fn send(cx: &mut TestAppContext, handle: WindowHandle<ImportWindowView>, command: &str) {
    let command = command.to_owned();
    handle
        .update(cx, |view, window, cx| {
            view.handle_command(&command, window, cx);
        })
        .expect("open");
    cx.run_until_parked();
}

fn last_plan(host: &MockUiHost) -> crate::host_data::ImportPlan {
    host.calls()
        .into_iter()
        .rev()
        .find_map(|call| match call {
            HostCall::RunImport(plan) => Some(plan),
            _ => None,
        })
        .expect("an import ran")
}

#[gpui::test]
fn a_dropped_safari_export_imports_bookmarks_history_passwords_and_cards(cx: &mut TestAppContext) {
    let (host, handle) = open(cx, safari());
    click(cx, handle, "import-start");
    send(cx, handle, "import:safariFile:/tmp/Safari Export.zip");
    let plan = last_plan(&host);
    assert_eq!(plan.source_id, "safari-export");
    assert_eq!(plan.file.as_deref(), Some("/tmp/Safari Export.zip"));
    assert_eq!(
        plan.kinds,
        vec!["bookmarks", "history", "passwords", "cards"]
    );
}

#[gpui::test]
fn safari_direct_brings_cookies_unless_unticked(cx: &mut TestAppContext) {
    let (host, handle) = open(cx, safari());
    click(cx, handle, "import-start");
    send(cx, handle, "import:safariDirect");
    assert!(last_plan(&host).kinds.contains(&"cookies".to_owned()));
    let (host, handle) = open(cx, safari());
    click(cx, handle, "import-start");
    send(cx, handle, "import:safariCookies");
    send(cx, handle, "import:safariDirect");
    assert!(!last_plan(&host).kinds.contains(&"cookies".to_owned()));
}

#[gpui::test]
fn a_refused_keychain_keeps_the_unlock_step_with_the_old_message(cx: &mut TestAppContext) {
    let (host, handle) = open(cx, chrome());
    host.refuse_unlock(true);
    click(cx, handle, "import-start");
    click(cx, handle, "import-unlock");
    match stage(cx, handle) {
        Stage::Unlock { error: Some(error) } => assert!(error.contains("Chrome's keychain item")),
        other => panic!("{other:?}"),
    }
    assert!(
        !host
            .calls()
            .iter()
            .any(|call| matches!(call, HostCall::RunImport(_)))
    );
}
