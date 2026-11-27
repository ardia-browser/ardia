use std::sync::Arc;

use ardia_state::live::{LiveCommand, LiveFolderKind, LiveSourceId};
use ardia_state::windows::WindowKind;
use ardia_state::{Action, BrowserStore, NewTab};
use serde_json::{Value, json};

use super::*;
use crate::net::stub::{StubTransport, json as reply};

fn github_stub() -> Arc<StubTransport> {
    let pr = json!({"id": "PR_1", "state": "OPEN", "number": 1, "title": "One", "url": "https://github.com/a/b/pull/1", "isDraft": false, "updatedAt": "2026-01-01T00:00:00Z", "headRefName": "h", "baseRefName": "main", "mergeable": "MERGEABLE", "repository": {"nameWithOwner": "a/b"}, "author": {"login": "me"}, "comments": {"totalCount": 0}, "commits": {"nodes": []}});
    StubTransport::new(Box::new(move |_, _, body| {
        let body: Value = serde_json::from_slice(body.unwrap_or_default()).unwrap_or_default();
        let query = body["query"].as_str().unwrap_or_default();
        if query.contains("viewer") {
            reply(
                200,
                json!({"data": {"viewer": {"login": "octo", "name": "Octo", "avatarUrl": "a"}}}),
            )
        } else if query.contains("LiveFolderSearch") {
            let q = body["variables"]["q"].as_str().unwrap_or_default();
            let nodes = if q.contains("author:@me") {
                json!([{"id": "PR_1", "updatedAt": "t"}])
            } else {
                json!([])
            };
            reply(200, json!({"data": {"search": {"nodes": nodes}}}))
        } else if query.contains("LiveFolderDirect") {
            reply(200, json!({"data": {"search": {"nodes": []}}}))
        } else {
            reply(200, json!({"data": {"nodes": [pr.clone()]}}))
        }
    }))
}

fn hub_with(
    dir: &std::path::Path,
    transport: Arc<StubTransport>,
    store: Option<Arc<BrowserStore>>,
) -> Arc<LiveHub> {
    LiveHub::new(
        Some(dir.to_path_buf()),
        SecretStore::isolated(dir.to_path_buf()),
        Some(transport as Arc<dyn Transport>),
        Endpoints {
            mock: Some("http://stub".into()),
        },
        store,
    )
}

#[test]
fn connect_create_refresh_and_open_an_item() {
    let dir = tempfile::tempdir().expect("dir");
    let store = Arc::new(BrowserStore::in_memory(
        ardia_state::BrowserState::from_session(
            ardia_state::persistence::session::SessionData::fresh(
                ardia_state::persistence::session::LoadOptions::default(),
            ),
            1_795_000_000_000,
        ),
        ardia_state::ids::IdGen::with_launch("live"),
    ));
    let window = store
        .dispatch(Action::OpenWindow {
            kind: WindowKind::Main,
            profile: None,
            url: None,
            frame: None,
        })
        .ok()
        .and_then(|o| o.window);
    let Some(window) = window else {
        return;
    };
    let hub = hub_with(dir.path(), github_stub(), Some(Arc::clone(&store)));
    hub.connect(LiveSourceId::Github, " tok ", None, None)
        .expect("connected");
    assert_eq!(hub.snapshot().accounts[&LiveSourceId::Github].login, "octo");
    hub.command(LiveCommand::CreateFolder {
        window: window.clone(),
        kind: LiveFolderKind::PullRequests,
        sources: None,
        name: None,
    });
    let folder = hub.snapshot().folder_order[0].clone();
    hub.refresh_folder(&folder, true);
    let live = hub.snapshot();
    assert_eq!(live.items[&folder].len(), 1);
    assert_eq!(hub.status_text(&folder), "Updated just now");
    hub.command(LiveCommand::OpenItem {
        window,
        folder: folder.clone(),
        item: "github:PR_1".into(),
        background: false,
    });
    let state = store.snapshot();
    let tab = state
        .tabs
        .values()
        .find(|t| t.live_item.is_some())
        .expect("a live tab");
    assert_eq!(
        tab.pinned_url.as_deref(),
        Some("https://github.com/a/b/pull/1")
    );
    hub.command(LiveCommand::RemoveFolder { folder });
    assert!(
        store
            .snapshot()
            .tabs
            .values()
            .all(|t| t.live_item.is_none())
    );
    let _ = NewTab::default();
}

#[test]
fn state_saves_to_the_canonical_document_and_loads_back() {
    let dir = tempfile::tempdir().expect("dir");
    std::fs::write(
        dir.path().join(CANONICAL_DOC),
        json!({"format": 1, "revision": 4, "epoch": "e", "payload": {"folders": {}, "folderOrder": [], "version": 1}}).to_string(),
    )
    .expect("write");
    let hub = hub_with(dir.path(), github_stub(), None);
    hub.update(false, |s| {
        s.create_folder("lf-x".into(), "default", LiveFolderKind::Documents, None, 1);
    });
    assert!(hub.save_now());
    let saved: Value =
        serde_json::from_slice(&std::fs::read(dir.path().join(CANONICAL_DOC)).expect("read"))
            .expect("json");
    assert_eq!(saved["revision"], 5);
    assert_eq!(saved["epoch"], "e");
    assert_eq!(saved["payload"]["folderOrder"][0], "lf-x");
    let again = hub_with(dir.path(), github_stub(), None);
    assert!(again.snapshot().folders.contains_key("lf-x"));
}

#[test]
fn signed_out_sources_report_an_error_on_first_fetch() {
    let dir = tempfile::tempdir().expect("dir");
    let hub = hub_with(dir.path(), github_stub(), None);
    hub.update(false, |s| {
        s.create_folder(
            "lf".into(),
            "p",
            LiveFolderKind::Documents,
            Some(vec![LiveSourceId::Notion]),
            0,
        );
    });
    hub.refresh_folder("lf", false);
    assert_eq!(hub.status_text("lf"), "Connect Notion in Settings");
    assert_eq!(radix36(35), "z");
}
