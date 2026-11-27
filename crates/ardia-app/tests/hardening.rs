use std::path::PathBuf;
use std::sync::Arc;

use ardia_app::{AppCoordinator, CoordinatorConfig};
use ardia_engine::mock::MockCall;
use ardia_engine::{BrowserEngine, MockBrowserEngine, TabCommand};
use ardia_state::actions::{Action, NewTab};
use ardia_state::ids::IdGen;
use ardia_state::persistence::session::{LoadOptions, SessionData};
use ardia_state::windows::WindowKind;
use ardia_state::{BrowserState, BrowserStore, TabId, WindowId};

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
            IdGen::with_launch("hardening"),
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

    fn state(&self) -> Arc<BrowserState> {
        self.app.store().snapshot()
    }

    fn windows(&self, kind: WindowKind) -> Vec<WindowId> {
        let state = self.state();
        state
            .window_order
            .iter()
            .filter(|id| state.window(id.as_str()).is_some_and(|w| w.kind == kind))
            .cloned()
            .collect()
    }

    fn window(&self) -> WindowId {
        self.windows(WindowKind::Main)[0].clone()
    }

    fn url(&self, tab: &TabId) -> String {
        self.state().tab(tab.as_str()).expect("the tab").url.clone()
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
}

#[test]
fn back_to_the_pinned_internal_page_stays_out_of_the_engine() {
    let h = Harness::new();
    let window = h.window();
    let tab = h
        .app
        .dispatch_action(Action::NewTab {
            window,
            tab: NewTab {
                url: Some("ardia://bookmarks".into()),
                pin: Some(ardia_state::model::TabPin::Row),
                ..NewTab::default()
            },
        })
        .unwrap()
        .tab
        .unwrap();
    h.pump();
    h.app
        .dispatch_action(Action::ActivateTab { tab: tab.clone() })
        .unwrap();
    h.app
        .dispatch_action(Action::Navigate {
            tab: tab.clone(),
            input: "https://away.example/".into(),
        })
        .unwrap();
    h.pump();
    assert_eq!(h.url(&tab), "https://away.example/");
    h.app.run_command("returnToPinnedUrl", None).unwrap();
    h.pump();
    assert_eq!(h.url(&tab), "ardia://bookmarks");
    assert_eq!(h.state().tab(tab.as_str()).unwrap().title, "Bookmarks");
    assert!(
        h.loads().iter().all(|url| !url.starts_with("ardia://")),
        "{:?}",
        h.loads()
    );
}

#[test]
fn files_chosen_for_a_closed_private_window_are_dropped() {
    let h = Harness::new();
    h.app
        .dispatch_action(Action::OpenWindow {
            kind: WindowKind::Incognito,
            profile: None,
            url: Some("https://private.example/".into()),
            frame: None,
        })
        .unwrap();
    h.pump();
    let private = h.windows(WindowKind::Incognito)[0].clone();
    h.app
        .dispatch_action(Action::CloseWindow {
            window: private.clone(),
        })
        .unwrap();
    h.pump();
    assert!(h.state().window(private.as_str()).is_none());
    let before = h.state().tabs.len();
    h.app.open_chosen_files(
        Some(&private),
        true,
        vec![PathBuf::from("/tmp/secret.html")],
    );
    h.pump();
    assert_eq!(h.state().tabs.len(), before);
    assert!(
        h.state()
            .tabs
            .values()
            .all(|tab| !tab.url.starts_with("file://")),
        "a private window's file never opens in a regular one"
    );
}

#[test]
fn files_for_a_closed_regular_window_open_in_the_front_window_as_before() {
    let h = Harness::new();
    let front = h.window();
    let gone = WindowId::new("w-gone");
    h.app.open_chosen_files(
        Some(&gone),
        false,
        vec![PathBuf::from("/tmp/a.html"), PathBuf::from("/tmp/b.html")],
    );
    h.pump();
    let active = h.state().active_tab(front.as_str()).unwrap().url.clone();
    assert_eq!(active, "file:///tmp/b.html", "the last file comes forward");
    assert!(
        h.state()
            .tabs
            .values()
            .any(|tab| tab.url == "file:///tmp/a.html")
    );
}

#[test]
fn move_pinned_tab_to_top_apps_only_moves_a_pinned_row() {
    let h = Harness::new();
    let window = h.window();
    let tab = h
        .app
        .dispatch_action(Action::NewTab {
            window,
            tab: NewTab {
                url: Some("https://row.example/".into()),
                ..NewTab::default()
            },
        })
        .unwrap()
        .tab
        .unwrap();
    h.pump();
    h.app
        .dispatch_action(Action::ActivateTab { tab: tab.clone() })
        .unwrap();
    assert!(!h.app.command_enabled("togglePin", Some("tile")));
    h.app.run_command("togglePin", Some("tile")).unwrap();
    assert_eq!(h.state().tab(tab.as_str()).unwrap().pin, None);
    h.app.run_command("togglePinnedRow", None).unwrap();
    h.pump();
    assert!(h.app.command_enabled("togglePin", Some("tile")));
    h.app.run_command("togglePin", Some("tile")).unwrap();
    h.pump();
    assert!(
        h.state()
            .tab(tab.as_str())
            .unwrap()
            .pin
            .as_ref()
            .is_some_and(|pin| pin.is_tile())
    );
}
