use std::sync::Arc;

use parking_lot::Mutex;

use ardia_app::{AppCoordinator, CoordinatorConfig};
use ardia_engine::mock::MockCall;
use ardia_engine::{BrowserEngine, MockBrowserEngine, TabCommand};
use ardia_state::actions::{Action, NewTab};
use ardia_state::ids::IdGen;
use ardia_state::persistence::session::{LoadOptions, SessionData};
use ardia_state::windows::WindowKind;
use ardia_state::{BrowserState, BrowserStore, TabId, WindowId};
use ardia_ui::UiHost;

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
            IdGen::with_launch("reader"),
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

    fn open(&self, window: &WindowId, url: &str) -> TabId {
        let tab = self
            .app
            .dispatch_action(Action::NewTab {
                window: window.clone(),
                tab: NewTab {
                    url: Some(url.into()),
                    ..NewTab::default()
                },
            })
            .unwrap()
            .tab
            .unwrap();
        self.pump();
        tab
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

#[derive(Default)]
struct FakePage {
    shown: bool,
    article: bool,
    looks: Vec<String>,
    calls: Vec<String>,
}

fn reader_page(h: &Harness, article: bool) -> Arc<Mutex<FakePage>> {
    let page = Arc::new(Mutex::new(FakePage {
        article,
        ..FakePage::default()
    }));
    let seen = page.clone();
    h.engine.set_evaluator(move |_, script| {
        let at = script.rfind("return JSON.stringify(").unwrap_or(0);
        let code = &script[at..];
        let mut page = seen.lock();
        let report = if code.contains(".check(") {
            page.calls.push("check".into());
            format!(
                "{{\"active\":{},\"readerable\":{}}}",
                page.shown, page.article
            )
        } else if code.contains(".toggle(") {
            page.calls.push("toggle".into());
            if !page.shown && !page.article {
                "{\"active\":false,\"noArticle\":true}".to_owned()
            } else {
                page.shown = !page.shown;
                format!("{{\"active\":{}}}", page.shown)
            }
        } else if code.contains(".hide()") {
            page.calls.push("hide".into());
            page.shown = false;
            "{\"active\":false}".to_owned()
        } else if code.contains(".setLook(") {
            page.looks
                .push(code.lines().next().unwrap_or_default().to_owned());
            format!("{{\"active\":{}}}", page.shown)
        } else {
            page.calls.push("state".into());
            format!("{{\"active\":{}}}", page.shown)
        };
        Ok(Some(serde_json::Value::String(report)))
    });
    page
}

fn settle(h: &Harness) {
    for _ in 0..6 {
        std::thread::sleep(std::time::Duration::from_millis(320));
        h.pump();
    }
}

fn devtools(h: &Harness, method: &str) -> Vec<Option<serde_json::Value>> {
    h.engine
        .calls()
        .into_iter()
        .filter_map(|call| match call {
            MockCall::DevTools(_, called, params) if called == method => Some(params),
            _ => None,
        })
        .collect()
}

#[test]
fn reader_opens_inside_the_page_and_closes_again() {
    let h = Harness::new();
    let page = reader_page(&h, true);
    let window = h.window();
    let tab = h.open(&window, "https://reads.example/story");
    settle(&h);
    assert!(
        h.app.reader_status(&tab).available,
        "the page is checked once it settles"
    );
    assert!(!h.app.reader_status(&tab).active);
    assert!(h.app.menu_titles(&h.state()).is_empty());
    h.app.run_command("toggleReader", None).unwrap();
    h.pump();
    assert!(h.app.reader_status(&tab).active);
    assert_eq!(
        h.app.menu_titles(&h.state()),
        vec![("toggleReader", "Hide Reader")]
    );
    assert_eq!(h.url(&tab), "https://reads.example/story");
    assert!(h.loads().is_empty(), "Reader never navigates the tab");
    assert!(!devtools(&h, "Page.createIsolatedWorld").is_empty());
    assert!(
        devtools(&h, "Runtime.evaluate")
            .iter()
            .all(|params| params.as_ref().and_then(|p| p.get("contextId")).is_some()),
        "the reader script runs in its own world"
    );
    h.app
        .dispatch_action(Action::UpdateSettings {
            patch: ardia_state::settings::SettingsPatch::new().set("readerTextSize", "large"),
            from_sync: false,
        })
        .unwrap();
    h.pump();
    assert!(
        page.lock()
            .looks
            .iter()
            .any(|look| look.contains("\"size\":2")),
        "{:?}",
        page.lock().looks
    );
    page.lock().shown = false;
    settle(&h);
    assert!(
        !h.app.reader_status(&tab).active,
        "closing the reader inside the page is noticed"
    );
    h.app.run_command("toggleReader", None).unwrap();
    h.pump();
    assert!(h.app.reader_status(&tab).active);
    h.app.run_command("toggleReader", None).unwrap();
    h.pump();
    assert!(!h.app.reader_status(&tab).active);
}

#[test]
fn a_page_without_an_article_says_so() {
    let h = Harness::new();
    reader_page(&h, false);
    let window = h.window();
    let tab = h.open(&window, "https://short.example/");
    h.app.toggle_reader(tab.clone());
    h.pump();
    let status = h.app.reader_status(&tab);
    assert!(!status.active && !status.available);
    let toasts: Vec<(String, Option<String>)> = h
        .state()
        .window(window.as_str())
        .unwrap()
        .chrome
        .toasts
        .iter()
        .map(|toast| (toast.message.clone(), toast.icon.clone()))
        .collect();
    assert!(
        toasts.contains(&(
            "No article found on this page".to_owned(),
            Some("doc.plaintext".to_owned())
        )),
        "{toasts:?}"
    );
}

#[test]
fn leaving_the_page_hides_the_reader() {
    let h = Harness::new();
    let page = reader_page(&h, true);
    let window = h.window();
    let tab = h.open(&window, "https://reads.example/a");
    h.app.toggle_reader(tab.clone());
    h.pump();
    assert!(h.app.reader_status(&tab).active);
    h.app
        .dispatch_action(Action::Navigate {
            tab: tab.clone(),
            input: "https://reads.example/a#part-2".into(),
        })
        .unwrap();
    h.pump();
    assert!(
        h.app.reader_status(&tab).active,
        "a jump within the page keeps it"
    );
    h.app
        .dispatch_action(Action::Navigate {
            tab: tab.clone(),
            input: "https://elsewhere.example/".into(),
        })
        .unwrap();
    h.pump();
    assert!(!h.app.reader_status(&tab).active);
    assert!(page.lock().calls.contains(&"hide".to_owned()));
}

#[test]
fn an_oversized_reply_is_ignored() {
    let h = Harness::new();
    let huge = format!(
        "{{\"active\":true{}}}",
        " ".repeat(ardia_app::reader::MAX_REPORT_BYTES)
    );
    h.engine
        .set_evaluator(move |_, _| Ok(Some(serde_json::Value::String(huge.clone()))));
    let window = h.window();
    let tab = h.open(&window, "https://big.example/");
    h.app.toggle_reader(tab.clone());
    h.pump();
    assert!(!h.app.reader_status(&tab).active);
}

#[test]
fn reader_only_answers_for_web_pages() {
    let h = Harness::new();
    reader_page(&h, true);
    let window = h.window();
    let tab = h.open(&window, "ardia://history");
    h.app.toggle_reader(tab);
    h.pump();
    assert!(devtools(&h, "Runtime.evaluate").is_empty());
}
