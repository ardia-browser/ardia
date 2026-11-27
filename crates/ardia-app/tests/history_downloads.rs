use std::sync::Arc;

use ardia_app::{AppCoordinator, CoordinatorConfig};
use ardia_engine::mock::MockCall;
use ardia_engine::{
    BrowserEngine, DownloadEvent, DownloadItem, EngineEvent, MockBrowserEngine, TabCommand,
};
use ardia_state::actions::{Action, NewTab};
use ardia_state::ids::IdGen;
use ardia_state::persistence::session::{LoadOptions, SessionData};
use ardia_state::windows::WindowKind;
use ardia_state::{BrowserState, BrowserStore, ProfileId, WindowId};
use ardia_ui::{ClearBrowsingData, UiHost};

struct Harness {
    engine: Arc<MockBrowserEngine>,
    app: Arc<AppCoordinator>,
}

impl Harness {
    fn new() -> Self {
        let store = Arc::new(BrowserStore::in_memory(
            BrowserState::from_session(
                SessionData::fresh(LoadOptions::default()),
                1_795_000_000_000,
            ),
            IdGen::with_launch("library"),
        ));
        let engine = Arc::new(MockBrowserEngine::started());
        let shared: Arc<dyn BrowserEngine> = engine.clone();
        let app = AppCoordinator::new(store, shared, CoordinatorConfig::default());
        app.set_waker(|| {});
        app.start();
        let harness = Harness { engine, app };
        harness.pump();
        harness
    }

    fn pump(&self) {
        for _ in 0..12 {
            self.app.poll_parked();
            if self.app.pump().rounds == 0 && self.app.poll_parked() == 0 {
                break;
            }
        }
    }

    fn window(&self) -> WindowId {
        let state = self.app.store().snapshot();
        state
            .window_order
            .iter()
            .find(|id| {
                state
                    .window(id.as_str())
                    .is_some_and(|w| w.kind == WindowKind::Main)
            })
            .cloned()
            .expect("a window")
    }

    fn profile(&self) -> ProfileId {
        let state = self.app.store().snapshot();
        state
            .window(self.window().as_str())
            .unwrap()
            .profile_id
            .clone()
    }

    fn active_url(&self) -> String {
        let state = self.app.store().snapshot();
        state
            .active_tab(self.window().as_str())
            .map(|tab| tab.url.clone())
            .unwrap_or_default()
    }

    fn loads(&self) -> Vec<String> {
        self.engine
            .calls()
            .into_iter()
            .filter_map(|call| match call {
                MockCall::Tab(_, TabCommand::LoadUrl { url, .. }) => Some(url),
                _ => None,
            })
            .collect()
    }

    fn history(&self) -> Vec<String> {
        self.app
            .store()
            .snapshot()
            .history_of(&self.profile())
            .map(|h| h.entries().map(|e| e.url.clone()).collect())
            .unwrap_or_default()
    }
}

#[test]
fn the_downloads_page_stays_inside_the_app() {
    let h = Harness::new();
    let window = h.window();
    h.app
        .dispatch_action(Action::NewTab {
            window,
            tab: NewTab {
                url: Some("ardia://downloads".into()),
                ..NewTab::default()
            },
        })
        .unwrap();
    h.pump();
    assert_eq!(h.active_url(), "ardia://downloads");
    let state = h.app.store().snapshot();
    let tab = state.active_tab(h.window().as_str()).unwrap();
    assert_eq!(tab.title, "Downloads");
    assert!(h.loads().iter().all(|url| !url.contains("downloads")));
}

#[test]
fn clear_browsing_data_opens_history_and_clears_through_the_engine() {
    let h = Harness::new();
    let profile = h.profile();
    for url in ["https://old.example/", "https://new.example/"] {
        h.app
            .dispatch_action(Action::RecordVisit {
                profile: profile.clone(),
                url: url.into(),
                title: url.into(),
                favicon: None,
            })
            .unwrap();
    }
    h.app.run_command("clearBrowsingData", None).unwrap();
    h.pump();
    assert_eq!(h.active_url(), "ardia://history");
    let started_at = ardia_state::store::now_ms();
    let reply = h.app.clear_browsing_data(
        profile.clone(),
        ClearBrowsingData {
            history: true,
            site_data: true,
            since: Some(started_at - 3_600_000),
            started_at,
        },
    );
    h.pump();
    let mut reply = reply;
    assert_eq!(reply.try_recv(), Ok(Some(true)));
    assert!(h.history().is_empty(), "the last hour's pages are gone");
    h.app
        .dispatch_action(Action::RecordVisit {
            profile: profile.clone(),
            url: "https://later.example/".into(),
            title: "Later".into(),
            favicon: None,
        })
        .unwrap();
    let reply = h.app.clear_browsing_data(
        profile,
        ClearBrowsingData {
            history: true,
            site_data: false,
            since: None,
            started_at: 0,
        },
    );
    h.pump();
    let mut reply = reply;
    assert_eq!(reply.try_recv(), Ok(Some(true)));
    assert_eq!(
        h.history(),
        vec!["https://later.example/".to_owned()],
        "pages visited after the clear started stay"
    );
}

#[test]
fn removing_many_pages_is_one_change() {
    let h = Harness::new();
    let profile = h.profile();
    for n in 0..5 {
        h.app
            .dispatch_action(Action::RecordVisit {
                profile: profile.clone(),
                url: format!("https://p{n}.example/"),
                title: String::new(),
                favicon: None,
            })
            .unwrap();
    }
    h.app
        .dispatch_action(Action::RemoveHistoryPages {
            profile,
            urls: vec!["https://p1.example/".into(), "https://p3.example/".into()],
        })
        .unwrap();
    let left = h.history();
    assert_eq!(left.len(), 3);
    assert!(!left.contains(&"https://p1.example/".to_owned()));
}

#[test]
fn removed_pages_leave_the_engine_history_too() {
    let h = Harness::new();
    let profile = h.profile();
    h.app
        .dispatch_action(Action::RemoveHistoryPages {
            profile,
            urls: vec!["https://gone.example/".into()],
        })
        .unwrap();
    h.pump();
    assert!(h.engine.calls().iter().any(|call| matches!(call,
        MockCall::Service { name, args, .. }
            if name == "ac_history_delete_urls" && args["urls"][0] == "https://gone.example/")));
}

#[test]
fn open_when_done_is_used_up_when_the_download_ends() {
    let h = Harness::new();
    h.app.toggle_open_when_done("dl-1".into());
    assert!(h.app.opens_when_done("dl-1"));
    let item = |state: &str| DownloadItem {
        id: "dl-1".into(),
        url: "https://files.example/a.zip".into(),
        filename: "a.zip".into(),
        path: String::new(),
        state: state.into(),
        ..DownloadItem::default()
    };
    h.engine.emit(EngineEvent::Download(DownloadEvent::Changed {
        profile: None,
        item: Box::new(item("downloading")),
    }));
    h.pump();
    assert!(h.app.opens_when_done("dl-1"), "still waiting");
    h.engine.emit(EngineEvent::Download(DownloadEvent::Changed {
        profile: None,
        item: Box::new(item("finished")),
    }));
    h.pump();
    assert!(!h.app.opens_when_done("dl-1"));
}
