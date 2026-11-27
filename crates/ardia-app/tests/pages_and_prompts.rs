use std::io::Cursor;
use std::path::PathBuf;
use std::sync::Arc;

use ardia_app::menu_bridge::{IDC_PRINT, IDC_SAVE_PAGE};
use ardia_app::{AppCoordinator, CoordinatorConfig};
use ardia_engine::mock::MockCall;
use ardia_engine::{
    BrowserEngine, EngineEvent, EngineTabId, MockBrowserEngine, TabAction, TabCommand,
};
use ardia_state::actions::{Action, NewTab};
use ardia_state::ids::IdGen;
use ardia_state::persistence::session::{LoadOptions, SessionData};
use ardia_state::windows::WindowKind;
use ardia_state::{BrowserState, BrowserStore, TabId, WindowId};
use ardia_theme::IconTheme;
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
            IdGen::with_launch("pages"),
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

    fn live(&self, tab: &TabId) -> EngineTabId {
        self.app.engine_tab(tab).expect("an engine tab")
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

    fn close(&self, tab: &TabId) {
        self.app
            .dispatch_action(Action::CloseTabs {
                tabs: vec![tab.clone()],
                last_closes_window: false,
            })
            .unwrap();
        self.pump();
    }
}

fn png(width: u32, height: u32, rgba: [u8; 4]) -> Vec<u8> {
    let image = image::RgbaImage::from_fn(width, height, |_, _| image::Rgba(rgba));
    let mut out = Cursor::new(Vec::new());
    image.write_to(&mut out, image::ImageFormat::Png).unwrap();
    out.into_inner()
}

#[test]
fn a_page_that_asks_before_closing_stays_or_goes_on_the_answer() {
    let h = Harness::new();
    let window = h.window();
    let tab = h.open(&window, "https://draft.example/");
    let live = h.live(&tab);
    h.engine.set_asks_before_leaving(live, true).unwrap();

    h.close(&tab);
    assert_eq!(h.engine.leave_prompts(), vec![live], "the page asks");
    assert!(h.state().tab(tab.as_str()).is_some(), "nothing closes yet");
    assert!(h.engine.answer_leave_prompt(live, false));
    h.pump();
    assert!(h.state().tab(tab.as_str()).is_some(), "Stay keeps the tab");
    assert!(h.engine.live_tabs().contains(&live));

    h.close(&tab);
    assert_eq!(h.engine.leave_prompts(), vec![live], "it asks again");
    assert!(h.engine.answer_leave_prompt(live, true));
    h.pump();
    assert!(
        h.state().tab(tab.as_str()).is_none(),
        "Leave closes the tab"
    );
    assert!(!h.engine.live_tabs().contains(&live));
}

#[test]
fn a_window_with_tabs_stays_open_while_its_warning_is_unanswered() {
    let h = Harness::new();
    let first = h.window();
    h.app
        .dispatch_action(Action::OpenWindow {
            kind: WindowKind::Main,
            profile: None,
            url: Some("https://one.example/".into()),
            frame: None,
        })
        .unwrap();
    h.pump();
    let second = h
        .windows(WindowKind::Main)
        .into_iter()
        .find(|window| *window != first)
        .expect("a second window");
    h.open(&second, "https://two.example/");
    h.app.request_window_close(second.clone());
    h.pump();
    assert!(
        h.state().window(second.as_str()).is_some(),
        "a warning that can't be shown never closes the window"
    );
    h.app
        .dispatch_action(Action::UpdateSettings {
            patch: ardia_state::settings::SettingsPatch::new()
                .set("warnBeforeClosingWindow", false),
            from_sync: false,
        })
        .unwrap();
    h.app.request_window_close(second.clone());
    h.pump();
    assert!(
        h.state().window(second.as_str()).is_none(),
        "with the warning off the window closes"
    );
}

#[test]
fn a_window_whose_page_asks_before_closing_stays_or_goes_on_the_answer() {
    let h = Harness::new();
    let first = h.window();
    h.app
        .dispatch_action(Action::OpenWindow {
            kind: WindowKind::Main,
            profile: None,
            url: Some("https://other.example/".into()),
            frame: None,
        })
        .unwrap();
    h.pump();
    let second = h
        .windows(WindowKind::Main)
        .into_iter()
        .find(|window| *window != first)
        .expect("a second window");
    let tab = h.open(&second, "https://upload.example/");
    let live = h.live(&tab);
    h.engine.set_asks_before_leaving(live, true).unwrap();
    h.app
        .dispatch_action(Action::UpdateSettings {
            patch: ardia_state::settings::SettingsPatch::new()
                .set("warnBeforeClosingWindow", false),
            from_sync: false,
        })
        .unwrap();

    h.app.request_window_close(second.clone());
    h.pump();
    assert_eq!(h.engine.leave_prompts(), vec![live]);
    assert!(h.engine.answer_leave_prompt(live, false));
    h.pump();
    assert!(
        h.state().window(second.as_str()).is_some(),
        "Stay keeps the window"
    );
    assert!(h.state().tab(tab.as_str()).is_some());

    h.app.request_window_close(second.clone());
    h.pump();
    assert_eq!(h.engine.leave_prompts(), vec![live]);
    assert!(h.engine.answer_leave_prompt(live, true));
    h.pump();
    assert!(
        h.state().window(second.as_str()).is_none(),
        "Leave closes the window"
    );
    assert!(h.state().window(first.as_str()).is_some());
}

#[test]
fn internal_pages_never_reach_the_engine() {
    let h = Harness::new();
    let window = h.window();
    let tab = h.open(&window, "https://news.example/");
    h.app
        .dispatch_action(Action::Navigate {
            tab: tab.clone(),
            input: "ardia://history".into(),
        })
        .unwrap();
    h.pump();
    let listed = h.state().tab(tab.as_str()).unwrap().clone();
    assert_eq!(listed.url, "ardia://history");
    assert_eq!(listed.title, "History");
    assert!(listed.live.navigation.is_none() && !listed.live.loading);
    assert!(listed.live.can_go_back, "the web page waits underneath");

    let live = h.live(&tab);
    h.engine.emit(EngineEvent::TitleChanged {
        tab: live,
        title: "Late title".into(),
    });
    h.engine.emit(EngineEvent::UrlChanged {
        tab: live,
        url: "https://news.example/".into(),
    });
    h.pump();
    assert_eq!(
        h.url(&tab),
        "ardia://history",
        "stale page events are ignored"
    );

    h.app.go_back(tab.clone());
    h.pump();
    assert_eq!(h.url(&tab), "https://news.example/");
    assert_eq!(
        h.loads(),
        Vec::<String>::new(),
        "going back reuses the page"
    );

    let bookmarks = h.open(&window, "ardia://bookmarks");
    assert_eq!(h.url(&bookmarks), "ardia://bookmarks");
    assert_eq!(
        h.engine.tab_info(h.live(&bookmarks)).unwrap().url,
        "",
        "the engine tab under an internal page stays blank"
    );
    h.app
        .dispatch_action(Action::Navigate {
            tab: bookmarks.clone(),
            input: "https://after.example/".into(),
        })
        .unwrap();
    h.pump();
    assert_eq!(h.url(&bookmarks), "https://after.example/");
    assert!(
        h.loads()
            .iter()
            .all(|url| !url.starts_with("ardia://") && !url.starts_with("chrome://"))
    );
}

#[test]
fn history_and_bookmarks_open_from_the_menu_without_duplicates() {
    let h = Harness::new();
    let window = h.window();
    h.open(&window, "https://a.example/");
    h.app.run_command("showHistory", None).unwrap();
    h.pump();
    let history = h.state().active_tab(window.as_str()).unwrap().id.clone();
    assert_eq!(h.url(&history), "ardia://history");
    h.open(&window, "https://b.example/");
    h.app.run_command("showHistory", None).unwrap();
    h.pump();
    assert_eq!(
        h.state().active_tab(window.as_str()).unwrap().id,
        history,
        "the open History tab comes forward"
    );
    let count = h.state().tabs.len();
    h.app.run_command("manageBookmarks", None).unwrap();
    h.pump();
    assert_eq!(h.state().tabs.len(), count + 1);
    let active = h.state().active_tab(window.as_str()).unwrap().url.clone();
    assert_eq!(active, "ardia://bookmarks");
}

#[test]
fn open_file_print_and_save_go_through_the_engine() {
    let h = Harness::new();
    let window = h.window();
    let tab = h.open(&window, "https://doc.example/");
    let live = h.live(&tab);
    h.engine.set_chosen_files([
        PathBuf::from("/tmp/ardia notes.html"),
        PathBuf::from("relative.txt"),
    ]);
    h.app.run_command("openFile", None).unwrap();
    h.pump();
    assert!(
        h.engine
            .calls()
            .contains(&MockCall::ChooseFilesToOpen(None))
    );
    let opened: Vec<String> = h.state().tabs.values().map(|t| t.url.clone()).collect();
    assert!(opened.contains(&"file:///tmp/ardia%20notes.html".to_owned()));
    assert!(opened.iter().all(|url| !url.contains("relative")));

    h.app
        .dispatch_action(Action::ActivateTab { tab: tab.clone() })
        .unwrap();
    h.pump();
    h.app.run_command("print", None).unwrap();
    h.app.run_command("savePage", None).unwrap();
    let actions: Vec<TabAction> = h
        .engine
        .calls()
        .into_iter()
        .filter_map(|call| match call {
            MockCall::TabAction(at, action) if at == live => Some(action),
            _ => None,
        })
        .collect();
    assert!(actions.contains(&TabAction::ExecuteChromeCommand { command: IDC_PRINT }));
    assert!(actions.contains(&TabAction::ExecuteChromeCommand {
        command: IDC_SAVE_PAGE
    }));

    h.app
        .dispatch_action(Action::Navigate {
            tab,
            input: "ardia://history".into(),
        })
        .unwrap();
    h.pump();
    assert!(h.app.run_command("print", None).is_err());
}

#[test]
fn remote_favicons_load_once_and_skip_private_windows() {
    let h = Harness::new();
    let window = h.window();
    let icon = "https://cdn.example/favicon.png";
    h.engine.set_icon(icon, png(16, 16, [220, 20, 20, 255]));
    let tab = h.open(&window, "https://site.example/");
    let profile = h.state().tab(tab.as_str()).unwrap().profile_id.clone();
    assert!(h.app.favicon_image(&profile, icon).is_none());
    h.engine.emit(EngineEvent::FaviconChanged {
        tab: h.live(&tab),
        url: Some(icon.into()),
    });
    h.pump();
    assert!(h.app.favicon_image(&profile, icon).is_some());
    assert!(matches!(
        h.app.icon_theme_for(tab),
        Some(IconTheme::Template { .. })
    ));
    let other = h.open(&window, "https://site.example/two");
    h.engine.emit(EngineEvent::FaviconChanged {
        tab: h.live(&other),
        url: Some(icon.into()),
    });
    h.pump();
    let fetched = |url: &str| {
        h.engine
            .icon_fetches()
            .iter()
            .filter(|(_, fetched)| fetched == url)
            .count()
    };
    assert_eq!(fetched(icon), 1, "the icon is fetched once");

    let history_icon = "https://history.example/icon.png";
    h.engine.set_icon(history_icon, png(8, 8, [0, 0, 200, 255]));
    assert!(h.app.favicon_image(&profile, history_icon).is_none());
    h.pump();
    assert!(
        h.app.favicon_image(&profile, history_icon).is_some(),
        "a list row's icon arrives after a pump"
    );

    h.app
        .dispatch_action(Action::OpenWindow {
            kind: WindowKind::Incognito,
            profile: None,
            url: Some("https://private.example/".into()),
            frame: None,
        })
        .unwrap();
    h.pump();
    let private_window = h.windows(WindowKind::Incognito)[0].clone();
    let private = h
        .state()
        .active_tab(private_window.as_str())
        .unwrap()
        .clone();
    let secret_icon = "https://private.example/icon.png";
    h.engine.set_icon(secret_icon, png(8, 8, [0, 200, 0, 255]));
    h.engine.emit(EngineEvent::FaviconChanged {
        tab: h.live(&private.id),
        url: Some(secret_icon.into()),
    });
    h.pump();
    assert!(
        h.app
            .favicon_image(&private.profile_id, secret_icon)
            .is_none()
    );
    h.pump();
    assert_eq!(fetched(secret_icon), 0, "private windows never fetch icons");
    assert_eq!(
        h.app.icon_theme_for(private.id.clone()),
        Some(IconTheme::Default)
    );

    let broken = "https://broken.example/x.ico";
    h.engine.set_icon(broken, b"<html>404</html>".to_vec());
    assert!(h.app.favicon_image(&profile, broken).is_none());
    h.pump();
    assert!(h.app.favicon_image(&profile, broken).is_none());
    h.pump();
    assert_eq!(
        fetched(broken),
        1,
        "a failed icon isn't refetched right away"
    );
}
