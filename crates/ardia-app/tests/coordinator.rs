use std::io::Cursor;
use std::rc::Rc;
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};

use ardia_app::{AppCoordinator, CoordinatorConfig, ShellEffect};
use ardia_engine::mock::MockCall;
use ardia_engine::{
    BrowserEngine, DownloadEvent, DownloadItem, EngineEvent, EngineTabId, MockBrowserEngine,
    PermissionRequest, PermissionResult, TabCommand, WindowCommand,
};
use ardia_state::actions::{Action, NewTab, PageUpdate};
use ardia_state::ids::IdGen;
use ardia_state::model::Orientation;
use ardia_state::persistence::session::{LoadOptions, SessionData};
use ardia_state::settings::SettingsPatch;
use ardia_state::tabs::{PermissionKind, SitePrompt};
use ardia_state::windows::{Popover, WindowKind};
use ardia_state::{BrowserState, BrowserStore, DataDir, ProfileId, TabId, WindowId};
use ardia_theme::IconTheme;
use ardia_ui::{UiHost, UtilityWindowKind};
use base64::Engine as _;
use serde_json::{Value, json};

struct Harness {
    engine: Arc<MockBrowserEngine>,
    app: Arc<AppCoordinator>,
    wakes: Arc<AtomicUsize>,
}

fn fresh_store() -> Arc<BrowserStore> {
    Arc::new(BrowserStore::in_memory(
        BrowserState::from_session(
            SessionData::fresh(LoadOptions::default()),
            1_795_000_000_000,
        ),
        IdGen::with_launch("e2e"),
    ))
}

impl Harness {
    fn new() -> Self {
        Self::build(fresh_store(), |_| {})
    }

    fn with_engine(setup: impl FnOnce(&MockBrowserEngine)) -> Self {
        Self::build(fresh_store(), setup)
    }

    fn build(store: Arc<BrowserStore>, setup: impl FnOnce(&MockBrowserEngine)) -> Self {
        let engine = Arc::new(MockBrowserEngine::started());
        setup(&engine);
        let shared: Arc<dyn BrowserEngine> = engine.clone();
        let app = AppCoordinator::new(store, shared, CoordinatorConfig::default());
        let wakes = Arc::new(AtomicUsize::new(0));
        let counter = wakes.clone();
        app.set_waker(move || {
            counter.fetch_add(1, Ordering::Relaxed);
        });
        app.start();
        let harness = Self { engine, app, wakes };
        harness.pump();
        harness
    }

    fn pump(&self) {
        for _ in 0..12 {
            if self.app.pump().rounds == 0 {
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

    fn active(&self, window: &WindowId) -> TabId {
        self.state()
            .active_tab(window.as_str())
            .map(|t| t.id.clone())
            .expect("an active tab")
    }

    fn open(&self, window: &WindowId, url: &str) -> TabId {
        let outcome = self
            .app
            .dispatch_action(Action::NewTab {
                window: window.clone(),
                tab: NewTab {
                    url: Some(url.into()),
                    ..NewTab::default()
                },
            })
            .unwrap();
        self.pump();
        outcome.tab.unwrap()
    }

    fn live(&self, tab: &TabId) -> EngineTabId {
        self.app
            .engine_tab(tab)
            .unwrap_or_else(|| panic!("{tab} has no engine tab"))
    }

    fn calls(&self) -> Vec<MockCall> {
        self.engine.calls()
    }

    fn effects(&self) -> Vec<ShellEffect> {
        self.app.take_effects()
    }
}

fn png(width: u32, height: u32, paint: impl Fn(u32, u32) -> [u8; 4]) -> Vec<u8> {
    let image = image::RgbaImage::from_fn(width, height, |x, y| image::Rgba(paint(x, y)));
    let mut out = Cursor::new(Vec::new());
    image.write_to(&mut out, image::ImageFormat::Png).unwrap();
    out.into_inner()
}

fn data_url(bytes: &[u8]) -> String {
    format!(
        "data:image/png;base64,{}",
        base64::engine::general_purpose::STANDARD.encode(bytes)
    )
}

#[test]
fn boot_opens_a_window_with_a_live_active_tab() {
    let h = Harness::new();
    let windows = h.windows(WindowKind::Main);
    assert_eq!(windows.len(), 1);
    let window = h.window();
    let engine_window = h.app.engine_window(&window).expect("an engine window");
    let tab = h.active(&window);
    let engine_tab = h.live(&tab);
    assert_eq!(h.engine.window_tabs(engine_window), [engine_tab]);
    assert_eq!(h.engine.active_tab(engine_window), Some(engine_tab));
    assert!(h.calls().contains(&MockCall::Tab(
        engine_tab,
        TabCommand::NoteShown { shown: true }
    )));
    assert_eq!(
        h.state().tab(tab.as_str()).unwrap().live.engine_tab_id,
        Some(engine_tab.to_string())
    );
    let effects = h.effects();
    assert!(effects.contains(&ShellEffect::OpenBrowserWindow {
        window,
        kind: WindowKind::Main,
        host: None
    }));
    assert!(effects.contains(&ShellEffect::InstallMenu));
    assert!(h.wakes.load(Ordering::Relaxed) > 0);
    let views = h.app.tab_native_views(tab.clone()).unwrap();
    assert!(
        views.page_view.is_none(),
        "mock pages never hand GPUI a fake NSView"
    );
    h.engine.emit(EngineEvent::UrlChanged {
        tab: engine_tab,
        url: "about:blank".into(),
    });
    h.engine.emit(EngineEvent::TitleChanged {
        tab: engine_tab,
        title: "about:blank".into(),
    });
    h.pump();
    let state = h.state();
    let blank = state.tab(tab.as_str()).unwrap();
    assert_eq!(blank.url, "", "an ahead-blank page keeps its tab a New Tab");
    assert_eq!(blank.display_title(), "New Tab");
}

#[test]
fn background_tabs_load_hidden_right_away() {
    let h = Harness::new();
    let window = h.window();
    let shown = h.active(&window);
    let background = h
        .app
        .dispatch_action(Action::NewTab {
            window: window.clone(),
            tab: NewTab {
                url: Some("https://later.example".into()),
                background: true,
                ..NewTab::default()
            },
        })
        .unwrap()
        .tab
        .unwrap();
    h.pump();
    let engine_tab = h.live(&background);
    assert_eq!(
        h.engine.tab_info(engine_tab).unwrap().url,
        "https://later.example"
    );
    assert_eq!(h.active(&window), shown);
    let engine_window = h.app.engine_window(&window).unwrap();
    assert_ne!(h.engine.active_tab(engine_window), Some(engine_tab));
    assert!(h.calls().contains(&MockCall::Tab(
        engine_tab,
        TabCommand::NoteShown { shown: false }
    )));
    h.app.dispatch(Action::ActivateTab { tab: background });
    h.pump();
    assert_eq!(h.engine.active_tab(engine_window), Some(engine_tab));
    let hidden = h.live(&shown);
    assert!(h.calls().contains(&MockCall::Tab(
        hidden,
        TabCommand::NoteShown { shown: false }
    )));
}

#[test]
fn a_tab_opens_navigates_reports_progress_and_closes() {
    let h = Harness::new();
    let window = h.window();
    let tab = h.open(&window, "https://example.com/a");
    assert_eq!(h.active(&window), tab);
    let engine_tab = h.live(&tab);
    let state = h.state();
    let listed = state.tab(tab.as_str()).unwrap();
    assert_eq!(listed.url, "https://example.com/a");
    assert_eq!(listed.title, "example.com");
    assert_eq!(listed.live.progress, 1.0);
    assert!(!listed.live.loading);
    h.app
        .navigate(window, tab.clone(), "https://example.org/b".into());
    h.pump();
    assert!(h.calls().contains(&MockCall::Tab(
        engine_tab,
        TabCommand::LoadUrl {
            url: "https://example.org/b".into(),
            user_initiated: true
        }
    )));
    let state = h.state();
    let listed = state.tab(tab.as_str()).unwrap();
    assert_eq!(listed.url, "https://example.org/b");
    assert!(listed.live.can_go_back);
    assert!(listed.live.navigation.is_none());
    h.app.go_back(tab.clone());
    h.pump();
    let state = h.state();
    assert_eq!(
        state.tab(tab.as_str()).unwrap().url,
        "https://example.com/a"
    );
    assert!(state.tab(tab.as_str()).unwrap().live.can_go_forward);
    h.app.dispatch(Action::CloseTabs {
        tabs: vec![tab.clone()],
        last_closes_window: false,
    });
    h.pump();
    assert!(h.state().tab(tab.as_str()).is_none());
    assert!(h.app.engine_tab(&tab).is_none());
    assert!(!h.engine.live_tabs().contains(&engine_tab));
    assert!(
        h.calls()
            .contains(&MockCall::Tab(engine_tab, TabCommand::Close))
    );
    assert_eq!(
        h.windows(WindowKind::Main).len(),
        1,
        "closing a tab keeps the window"
    );
}

#[test]
fn reopening_a_closed_tab_restores_its_history_through_the_engine() {
    let h = Harness::with_engine(|engine| {
        engine.set_service_handler("ac_tab_restore_take", |_, _| {
            Ok(json!({"state": "[\"https://a.example/1\",\"https://a.example/2\"]", "entry": 7}))
        });
        engine.set_service_handler("ac_tab_restore_tag", |_, _| Ok(json!({"ok": true})));
    });
    let window = h.window();
    let tab = h.open(&window, "https://a.example/2");
    let tagged = h.calls().into_iter().any(|call| {
        matches!(&call,
        MockCall::Service { name, args, profile_dir } if name == "ac_tab_restore_tag"
            && args["key"] == json!(tab.as_str())
            && profile_dir == "/mock/Default")
    });
    assert!(
        tagged,
        "live tabs are tagged so their history can come back"
    );
    h.app.dispatch(Action::CloseTabs {
        tabs: vec![tab.clone()],
        last_closes_window: false,
    });
    h.pump();
    h.engine.take_calls();
    h.app.run_command("reopenClosedTab", None).unwrap();
    h.pump();
    let state = h.state();
    let reopened = state
        .tabs
        .values()
        .find(|t| t.url == "https://a.example/2")
        .map(|t| t.id.clone())
        .expect("the tab is back");
    let engine_tab = h.live(&reopened);
    let took = h.calls().into_iter().any(|call| matches!(&call,
        MockCall::Service { name, args, .. } if name == "ac_tab_restore_take" && args["key"] == json!(tab.as_str())));
    assert!(took, "the engine's saved history was asked for");
    let history = h.engine.navigation_entries(engine_tab).unwrap();
    assert_eq!(history.len(), 2, "both pages came back");
    assert!(h.state().tab(reopened.as_str()).unwrap().live.can_go_back);
}

#[test]
fn split_panes_are_shown_together() {
    let h = Harness::new();
    let window = h.window();
    let left = h.open(&window, "https://left.example");
    let right = h.open(&window, "https://right.example");
    h.app.dispatch(Action::SplitTabs {
        tabs: vec![left.clone(), right.clone()],
        orientation: Orientation::Horizontal,
    });
    h.pump();
    let shown: Vec<EngineTabId> = vec![h.live(&left), h.live(&right)];
    let calls = h.calls();
    for engine_tab in shown {
        let last = calls.iter().rev().find_map(|call| match call {
            MockCall::Tab(id, TabCommand::NoteShown { shown }) if *id == engine_tab => {
                Some(shown.to_owned())
            }
            _ => None,
        });
        assert_eq!(last, Some(true), "{engine_tab} is on screen");
    }
}

#[test]
fn switching_profiles_loads_the_profile_and_shows_its_tabs() {
    let h = Harness::new();
    let window = h.window();
    let profile = h
        .app
        .dispatch_action(Action::CreateProfile {
            name: "Work".into(),
            color: None,
            icon: None,
        })
        .unwrap()
        .profile
        .unwrap();
    h.app.dispatch(Action::SwitchProfile {
        window: window.clone(),
        profile: profile.clone(),
    });
    h.pump();
    let engine_profile = h.app.engine_profile(&profile).expect("the profile loaded");
    let info = h.engine.profile_info(engine_profile).unwrap();
    assert_eq!(
        info.name,
        format!("Profile {}", h.state().engine_profile(&profile)),
        "non-default profiles live in Chromium's \"Profile <id>\" folder, as in the old app"
    );
    let engine_window = h.app.engine_window(&window).unwrap();
    assert!(h.calls().contains(&MockCall::Window(
        engine_window,
        WindowCommand::SetActiveProfile {
            profile: Some(engine_profile)
        }
    )));
    let tab = h.active(&window);
    assert_eq!(h.state().tab(tab.as_str()).unwrap().profile_id, profile);
    let engine_tab = h.live(&tab);
    assert_eq!(
        h.engine.tab_info(engine_tab).unwrap().profile,
        Some(engine_profile)
    );
}

#[test]
fn little_ardia_moves_its_live_page_into_the_main_window() {
    let h = Harness::new();
    let main = h.window();
    h.app.dispatch(Action::OpenWindow {
        kind: WindowKind::LittleArdia,
        profile: None,
        url: Some("https://little.example".into()),
        frame: None,
    });
    h.pump();
    let little = h.windows(WindowKind::LittleArdia)[0].clone();
    let little_engine = h.app.engine_window(&little).unwrap();
    let tab = h.active(&little);
    let engine_tab = h.live(&tab);
    assert!(h.effects().iter().any(|effect| matches!(effect,
        ShellEffect::OpenBrowserWindow { window, kind: WindowKind::LittleArdia, .. } if *window == little)));
    h.app.open_little_ardia_in_main(little.clone());
    h.pump();
    assert!(h.windows(WindowKind::LittleArdia).is_empty());
    assert_eq!(h.state().tab(tab.as_str()).unwrap().window_id, main);
    assert_eq!(
        h.live(&tab),
        engine_tab,
        "the same page moved, nothing reloaded"
    );
    let main_engine = h.app.engine_window(&main).unwrap();
    assert!(h.engine.window_tabs(main_engine).contains(&engine_tab));
    assert!(
        h.calls()
            .contains(&MockCall::Window(little_engine, WindowCommand::Close))
    );
    assert!(h.engine.live_tabs().contains(&engine_tab));
    assert!(
        h.effects()
            .contains(&ShellEffect::CloseWindow { window: little })
    );
}

#[test]
fn links_follow_air_traffic_and_the_little_ardia_setting() {
    let h = Harness::new();
    let main = h.window();
    h.app.open_url("https://from-mail.example");
    h.pump();
    let little = h.windows(WindowKind::LittleArdia);
    assert_eq!(
        little.len(),
        1,
        "links from other apps open in Little Ardia by default"
    );
    let tab = h.active(&little[0]);
    assert_eq!(
        h.engine.tab_info(h.live(&tab)).unwrap().url,
        "https://from-mail.example"
    );
    h.app.dispatch(Action::UpdateSettings {
        patch: SettingsPatch::new().set("openLinksInLittleArdia", false),
        from_sync: false,
    });
    h.app.open_url("https://docs.example");
    h.pump();
    assert_eq!(h.windows(WindowKind::LittleArdia).len(), 1);
    let tab = h.active(&main);
    assert_eq!(
        h.state().tab(tab.as_str()).unwrap().url,
        "https://docs.example"
    );
    h.app.dispatch(Action::SetAirTraffic {
        config: ardia_state::air_traffic::AirTrafficConfig::from_value(&json!({
            "rules": [{"id": "r", "enabled": true, "from": null, "when": {"kind": "site", "host": "news.example"}, "open": "window", "profileId": null}]
        })),
    });
    h.app.open_url("https://news.example/today");
    h.pump();
    assert_eq!(
        h.windows(WindowKind::Main).len(),
        2,
        "the rule opened its own window"
    );
    h.engine.emit(EngineEvent::OpenUrls {
        urls: vec!["https://apple-event.example".into()],
        sender: None,
    });
    h.pump();
    assert!(
        h.state()
            .tabs
            .values()
            .any(|t| t.url == "https://apple-event.example")
    );
}

#[test]
fn menu_commands_reach_the_state_the_engine_and_the_shell() {
    let h = Harness::new();
    let window = h.window();
    let tab = h.open(&window, "https://menu.example");
    let engine_tab = h.live(&tab);
    h.app.run_command("reload", None).unwrap();
    h.app.run_command("zoomIn", None).unwrap();
    h.pump();
    let calls = h.calls();
    assert!(calls.contains(&MockCall::Tab(engine_tab, TabCommand::Reload)));
    assert!(calls.contains(&MockCall::Tab(
        engine_tab,
        TabCommand::ZoomStep { direction: 1 }
    )));
    assert!(
        (h.state().tab(tab.as_str()).unwrap().zoom - 1.1).abs() < 1e-9,
        "engine zoom reaches state"
    );
    h.effects();
    h.app.run_command("copyUrl", None).unwrap();
    h.app.run_command("openSettings", None).unwrap();
    let effects = h.effects();
    assert!(effects.contains(&ShellEffect::Copy("https://menu.example".into())));
    assert!(effects.contains(&ShellEffect::OpenUtility(UtilityWindowKind::Settings)));
    h.app.run_command("newTab", None).unwrap();
    h.pump();
    let fresh = h.active(&window);
    assert_ne!(fresh, tab);
    assert!(
        h.state()
            .window(window.as_str())
            .unwrap()
            .chrome
            .command_bar
            .open
    );
    h.app.run_command("closeTab", None).unwrap();
    h.pump();
    assert!(h.state().tab(fresh.as_str()).is_none());
    h.app.run_command("setAppearance", Some("dark")).unwrap();
    assert_eq!(h.state().settings.get("appearance"), Some(json!("dark")));
    let compact = h.state().settings.get("compactToolbar");
    h.app.run_command("toggleCompactToolbar", None).unwrap();
    assert_ne!(h.state().settings.get("compactToolbar"), compact);
    assert_eq!(
        h.app.run_command("renameTab", None),
        Ok(ardia_app::menu_bridge::CommandOutcome::ForUi)
    );
    assert_eq!(
        h.state().window(window.as_str()).unwrap().chrome.popover,
        Some(Popover::Custom("command:renameTab".into()))
    );
    assert_eq!(
        h.app.run_command("focusCommandBar", None),
        Ok(ardia_app::menu_bridge::CommandOutcome::ForUi)
    );
    assert_eq!(
        h.state().window(window.as_str()).unwrap().chrome.popover,
        Some(Popover::Custom("command:focusCommandBar".into()))
    );
    assert!(h.app.run_command("selectTab:1", None).is_ok());
    assert!(h.app.run_command("bogus", None).is_err());
    h.app.run_command("newIncognitoWindow", None).unwrap();
    h.pump();
    let private = h.windows(WindowKind::Incognito);
    assert_eq!(private.len(), 1);
    let private_tab = h.active(&private[0]);
    let engine_profile = h
        .engine
        .tab_info(h.live(&private_tab))
        .unwrap()
        .profile
        .unwrap();
    assert!(
        h.engine
            .profile_info(engine_profile)
            .unwrap()
            .off_the_record
    );
    h.engine.emit(EngineEvent::MenuCommand {
        command: "newWindow".into(),
        arg: None,
    });
    h.pump();
    assert_eq!(h.windows(WindowKind::Main).len(), 2);
    h.app.run_command("quit", None).unwrap();
    assert!(h.app.is_shutting_down());
    assert!(h.effects().contains(&ShellEffect::Quit));
}

#[test]
fn dropped_events_resync_prompts_and_page_state() {
    let h = Harness::new();
    let window = h.window();
    let tab = h.open(&window, "https://camera.example");
    let engine_tab = h.live(&tab);
    h.engine.emit(EngineEvent::PermissionRequested {
        tab: Some(engine_tab),
        request: PermissionRequest {
            id: "p1".into(),
            origin: "https://camera.example".into(),
            permissions: vec!["camera".into()],
            ..PermissionRequest::default()
        },
    });
    h.pump();
    let camera = SitePrompt::Permission {
        kind: PermissionKind::Camera,
        origin: "https://camera.example".into(),
    };
    assert_eq!(
        h.state().tab(tab.as_str()).unwrap().live.prompts,
        std::slice::from_ref(&camera)
    );
    h.app.dispatch(Action::SetPrompts {
        tab: tab.clone(),
        prompts: Vec::new(),
    });
    h.app.dispatch(Action::UpdatePage {
        tab: tab.clone(),
        update: PageUpdate {
            title: Some("stale".into()),
            ..PageUpdate::default()
        },
    });
    h.engine.emit(EngineEvent::EventsDropped {
        count: 40,
        resync: true,
    });
    h.pump();
    let state = h.state();
    let listed = state.tab(tab.as_str()).unwrap();
    assert_eq!(listed.live.prompts, [camera], "open prompts came back");
    assert_eq!(listed.title, "camera.example", "page state was re-read");
    h.app
        .resolve_permission("p1".into(), PermissionResult::Accept, true);
    h.pump();
    assert!(h.state().tab(tab.as_str()).unwrap().live.prompts.is_empty());
    assert!(h.calls().iter().any(|call| matches!(call,
        MockCall::Global(ardia_engine::GlobalCommand::ResolvePermission { request_id, remember: true, .. }) if request_id == "p1")));
}

#[test]
fn favicons_become_icon_themes() {
    let h = Harness::new();
    let window = h.window();
    let tab = h.open(&window, "https://icons.example");
    let engine_tab = h.live(&tab);
    let flat = data_url(&png(16, 16, |_, _| [220, 20, 20, 255]));
    h.engine.emit(EngineEvent::FaviconChanged {
        tab: engine_tab,
        url: Some(flat.clone()),
    });
    h.pump();
    match h.app.icon_theme_for(tab.clone()) {
        Some(IconTheme::Template { mean, .. }) => assert!(mean.r > 0.8 && mean.g < 0.2),
        other => panic!("a flat icon should tint as a template, got {other:?}"),
    }
    let state = h.state();
    let listed = state.tab(tab.as_str()).unwrap();
    assert_eq!(listed.favicon.as_deref(), Some(flat.as_str()));
    assert!(matches!(
        listed.live.icon_theme,
        Some(IconTheme::Template { .. })
    ));
    let colorful = data_url(&png(32, 32, |x, _| {
        if x < 16 {
            [255, 0, 0, 255]
        } else {
            [0, 0, 255, 255]
        }
    }));
    h.engine.emit(EngineEvent::FaviconChanged {
        tab: engine_tab,
        url: Some(colorful),
    });
    h.pump();
    assert!(matches!(
        h.app.icon_theme_for(tab.clone()),
        Some(IconTheme::Blur { .. })
    ));
    h.engine.emit(EngineEvent::FaviconChanged {
        tab: engine_tab,
        url: Some("https://icons.example/favicon.ico".into()),
    });
    h.pump();
    assert_eq!(
        h.app.icon_theme_for(tab.clone()),
        Some(IconTheme::Default),
        "bytes that don't decode get the default look"
    );
    h.engine.emit(EngineEvent::FaviconChanged {
        tab: engine_tab,
        url: None,
    });
    h.pump();
    assert_eq!(h.app.icon_theme_for(tab), None);
}

#[test]
fn engine_events_update_downloads_audio_find_and_fullscreen() {
    let h = Harness::new();
    let window = h.window();
    let tab = h.open(&window, "https://media.example");
    let engine_tab = h.live(&tab);
    h.engine.emit(EngineEvent::Download(DownloadEvent::Changed {
        profile: Some("/mock/Default".into()),
        item: Box::new(DownloadItem {
            id: "d1".into(),
            url: "https://media.example/a.zip".into(),
            filename: "a.zip".into(),
            state: "downloading".into(),
            received: 10.0,
            total: 100.0,
            ..DownloadItem::default()
        }),
    }));
    h.engine.simulate_audio(engine_tab, true).unwrap();
    h.pump();
    let state = h.state();
    let download = state.downloads.get("d1").expect("the download is listed");
    assert_eq!(download.progress(), Some(0.1));
    assert!(state.tab(tab.as_str()).unwrap().live.audible);
    h.app.set_muted(tab.clone(), true);
    h.pump();
    assert!(h.calls().contains(&MockCall::Tab(
        engine_tab,
        TabCommand::SetMuted { muted: true }
    )));
    h.app.find_in_page(tab.clone(), "media".into(), true);
    h.pump();
    let find = h.state().tab(tab.as_str()).unwrap().live.find.clone();
    assert!(find.open);
    assert_eq!(find.count, Some(2));
    h.app.stop_finding(tab.clone());
    h.pump();
    assert!(!h.state().tab(tab.as_str()).unwrap().live.find.open);
    let engine_window = h.app.engine_window(&window).unwrap();
    h.engine.emit(EngineEvent::FullscreenChanged {
        window: engine_window,
        tab: engine_tab,
        fullscreen: true,
    });
    h.engine.emit(EngineEvent::Download(DownloadEvent::Removed {
        profile: None,
        id: "d1".into(),
        off_the_record: false,
    }));
    h.pump();
    let state = h.state();
    assert!(state.tab(tab.as_str()).unwrap().live.fullscreen);
    assert!(!state.window(window.as_str()).unwrap().is_full_screen());
    assert!(state.downloads.get("d1").is_none());
}

#[test]
fn tabs_the_engine_opens_join_their_window() {
    let h = Harness::new();
    let window = h.window();
    let opener = h.open(&window, "https://opener.example");
    let engine_window = h.app.engine_window(&window).unwrap();
    let profile = h.engine.default_profile().unwrap();
    let popup = h
        .engine
        .open_tab(
            engine_window,
            ardia_engine::OpenTab {
                url: "https://child.example".into(),
                profile,
                foreground: false,
            },
        )
        .unwrap();
    h.pump();
    let state = h.state();
    let child = state
        .tabs
        .values()
        .find(|t| t.live.engine_tab_id.as_deref() == Some(popup.to_string().as_str()))
        .expect("the engine's tab is listed");
    assert_eq!(child.window_id, window);
    assert_eq!(child.url, "https://child.example");
    assert_eq!(
        h.active(&window),
        opener,
        "a background tab doesn't take focus"
    );
    h.engine.close(popup).unwrap();
    h.pump();
    assert!(
        h.state().tab(child.id.as_str()).is_none(),
        "a page that closes itself leaves the list"
    );
}

#[test]
fn closing_a_window_goes_through_the_engine_and_is_remembered() {
    let h = Harness::new();
    let first = h.window();
    h.app.run_command("newWindow", None).unwrap();
    h.pump();
    let second = h.windows(WindowKind::Main)[1].clone();
    h.open(&second, "https://keep.example");
    let engine_window = h.app.engine_window(&second).unwrap();
    h.app.request_window_close(second.clone());
    assert!(
        h.state().window(second.as_str()).is_some(),
        "the engine closes first"
    );
    h.pump();
    assert!(h.state().window(second.as_str()).is_none());
    assert!(
        h.calls()
            .contains(&MockCall::Window(engine_window, WindowCommand::Close))
    );
    assert!(h.state().closed.windows.iter().any(|w| {
        w.tabs
            .iter()
            .any(|t| t.snapshot.url == "https://keep.example")
    }));
    h.app.run_command("reopenClosedWindow", None).unwrap();
    h.pump();
    assert_eq!(h.windows(WindowKind::Main).len(), 2);
    assert!(
        h.state()
            .tabs
            .values()
            .any(|t| t.url == "https://keep.example")
    );
    assert!(h.state().window(first.as_str()).is_some());
}

#[test]
fn shutting_down_flushes_the_session_and_keeps_its_windows() {
    let dir = tempfile::tempdir().unwrap();
    let (store, _) = BrowserStore::open(DataDir::new(dir.path()), LoadOptions::default()).unwrap();
    let store = Arc::new(store);
    let h = Harness::build(store.clone(), |_| {});
    let window = h.window();
    h.open(&window, "https://persist.example");
    h.engine.quit().unwrap();
    assert!(h.app.is_shutting_down());
    assert!(
        !store.has_unsaved_changes(),
        "the session was written before the engine went away"
    );
    h.pump();
    assert!(
        h.state().window(window.as_str()).is_some(),
        "quitting doesn't close windows in the session"
    );
    let saved = std::fs::read_to_string(dir.path().join("session.json")).unwrap();
    assert!(saved.contains("https://persist.example"));
    let reloaded = BrowserStore::open(DataDir::new(dir.path()), LoadOptions::default())
        .unwrap()
        .0;
    assert!(
        reloaded
            .snapshot()
            .tabs
            .values()
            .any(|t| t.url == "https://persist.example")
    );
}

#[test]
fn imports_land_in_ardias_bookmarks() {
    let h = Harness::new();
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("b.html");
    std::fs::write(
        &file,
        "<!DOCTYPE NETSCAPE-Bookmark-file-1>\n<DL><p><DT><A HREF=\"https://imported.example/\">Imported</A></DL><p>",
    )
    .unwrap();
    h.app.start_import(
        format!("html:{}", file.display()),
        ProfileId::default_profile(),
    );
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
    while !h.app.import_progress().is_some_and(|p| p.finished)
        && std::time::Instant::now() < deadline
    {
        h.pump();
        std::thread::sleep(std::time::Duration::from_millis(5));
    }
    let state = h.state();
    let tree = state
        .bookmarks_of(&ProfileId::default_profile())
        .expect("a bookmark tree");
    assert!(
        tree.rows()
            .any(|row| row.url == "https://imported.example/")
    );
}

#[cfg(unix)]
#[test]
fn the_control_socket_speaks_json_lines() {
    use std::io::{BufRead, BufReader, Write};
    use std::os::unix::net::UnixStream;

    let h = Harness::new();
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("ArdiaControl.sock");
    let server = ardia_app::ipc::socket::ControlServer::start(path.clone(), &h.app).unwrap();
    let mode = std::fs::metadata(&path).unwrap();
    assert_eq!(
        std::os::unix::fs::PermissionsExt::mode(&mode.permissions()) & 0o777,
        0o600
    );
    assert!(
        ardia_app::ipc::socket::ControlServer::start(path.clone(), &h.app).is_err(),
        "a second server doesn't steal a live socket"
    );
    let client = std::thread::spawn(move || {
        let stream = UnixStream::connect(&path).unwrap();
        let mut writer = stream.try_clone().unwrap();
        let mut reader = BufReader::new(stream);
        let mut ask = |line: &str| -> Value {
            writeln!(writer, "{line}").unwrap();
            let mut reply = String::new();
            reader.read_line(&mut reply).unwrap();
            serde_json::from_str(&reply).unwrap()
        };
        let mut replies = vec![
            ask(r#"{"id": 1, "method": "status"}"#),
            ask(r#"{"id": 2, "method": "new_tab", "params": {"url": "https://ipc.example"}}"#),
        ];
        let tab = replies[1]["result"]["tab"]
            .as_str()
            .unwrap_or_default()
            .to_owned();
        replies.push(ask(&json!({"id": 3, "method": "navigate", "params": {"tab": tab, "url": "https://ipc.example/next"}}).to_string()));
        replies.push(ask(r#"{"id": 4, "method": "list_tabs"}"#));
        replies.push(ask(
            r#"{"id": 5, "method": "eval_command", "params": {"command": "reload"}}"#,
        ));
        replies.push(ask(r#"{"id": 6, "method": "navigate", "params": {"tab": "missing", "url": "https://x.example"}}"#));
        replies.push(ask(r#"{"id": 7, "method": "teleport"}"#));
        replies.push(ask("{not json"));
        replies.push(ask(r#"{"id": 9, "method": "status", "params": [1]}"#));
        replies.push(ask(r#"{"id": 10, "method": "open_url", "params": {}}"#));
        replies.push(ask(
            &json!({"id": 11, "method": "close_tab", "params": {"tab": tab}}).to_string(),
        ));
        replies.push(ask(r#"{"id": 12, "method": "quit"}"#));
        replies
    });
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(20);
    while !client.is_finished() && std::time::Instant::now() < deadline {
        h.pump();
        std::thread::sleep(std::time::Duration::from_millis(2));
    }
    let replies = client.join().unwrap();
    assert_eq!(replies[0]["id"], 1);
    assert_eq!(replies[0]["result"]["engine"], "mock");
    assert_eq!(replies[0]["result"]["windows"], 1);
    let tab = replies[1]["result"]["tab"].as_str().unwrap().to_owned();
    assert_eq!(replies[2]["result"]["tab"], json!(tab));
    let listed = replies[3]["result"].as_array().unwrap();
    let row = listed
        .iter()
        .find(|row| row["id"] == json!(tab))
        .expect("the new tab is listed");
    assert_eq!(row["url"], "https://ipc.example/next");
    assert_eq!(row["canGoBack"], true);
    assert_eq!(row["live"], true);
    assert_eq!(replies[4]["result"]["ran"], true);
    assert_eq!(replies[5]["error"]["code"], "no_window");
    assert_eq!(replies[6]["error"]["code"], "unknown_method");
    assert_eq!(replies[7]["error"]["code"], "bad_request");
    assert_eq!(replies[8]["error"]["code"], "bad_request");
    assert_eq!(replies[9]["error"]["code"], "bad_request");
    assert_eq!(replies[10]["result"]["closed"], json!(tab));
    assert_eq!(replies[11]["result"]["quitting"], true);
    assert!(h.app.is_shutting_down());
    assert!(h.state().tab(tab.as_str()).is_none());
    assert!(
        h.calls()
            .iter()
            .any(|call| matches!(call, MockCall::Tab(_, TabCommand::Reload)))
    );
    let socket = server.path().to_path_buf();
    drop(server);
    assert!(
        !socket.exists(),
        "the socket file goes away with the server"
    );
}

fn private_harness() -> (Harness, WindowId, EngineTabId) {
    let h = Harness::new();
    h.app.run_command("newIncognitoWindow", None).unwrap();
    h.pump();
    let private = h.windows(WindowKind::Incognito)[0].clone();
    let tab = h.active(&private);
    let engine_tab = h.live(&tab);
    (h, private, engine_tab)
}

#[test]
fn popups_from_private_pages_stay_private() {
    let (h, _, engine_tab) = private_harness();
    let private_profile = h.engine.tab_info(engine_tab).unwrap().profile.unwrap();
    let popup_window = h
        .engine
        .simulate_new_browser(Some(private_profile), ardia_engine::NewBrowserKind::Popup)
        .expect("the policy lets popups open");
    h.pump();
    h.engine
        .open_tab(
            popup_window,
            ardia_engine::OpenTab {
                url: "https://secret.example/".into(),
                profile: private_profile,
                foreground: true,
            },
        )
        .unwrap();
    h.pump();
    let state = h.state();
    let tab = state
        .tabs
        .values()
        .find(|t| t.url == "https://secret.example/")
        .expect("the popup's page is listed");
    assert!(
        tab.is_incognito(),
        "the popup's tab keeps a private profile"
    );
    assert_eq!(
        state.window(tab.window_id.as_str()).unwrap().kind,
        WindowKind::Incognito
    );
    let listed = h.app.answer_control("list_tabs", &Value::Null).unwrap();
    assert!(
        !listed.to_string().contains("secret.example"),
        "private pages never leave through the control socket"
    );
    let history = state.history_of(&ProfileId::default_profile());
    assert!(history.is_none_or(|h| !format!("{h:?}").contains("secret.example")));
}

#[test]
fn two_private_windows_share_one_engine_profile_quietly() {
    let (h, first, _) = private_harness();
    h.app.run_command("newIncognitoWindow", None).unwrap();
    h.pump();
    let windows = h.windows(WindowKind::Incognito);
    assert_eq!(windows.len(), 2);
    for window in &windows {
        let tab = h.active(window);
        h.live(&tab);
    }
    assert!(windows.contains(&first));
    let settled = (0..4).map(|_| h.app.pump().rounds).sum::<usize>();
    assert_eq!(settled, 0, "nothing churns once both windows are shown");
}

#[test]
fn quitting_still_asks_before_cancelling_downloads() {
    let engine = Arc::new(MockBrowserEngine::started());
    let shared: Arc<dyn BrowserEngine> = engine.clone();
    let app = AppCoordinator::new(
        fresh_store(),
        shared,
        CoordinatorConfig {
            hosts_native_windows: true,
            ..CoordinatorConfig::default()
        },
    );
    app.start();
    app.pump();
    let window = app.focused_window().unwrap();
    let engine_window = app.engine_window(&window).unwrap();
    app.request_quit();
    app.take_effects();
    engine.emit(EngineEvent::ConfirmCloseWithDownloads {
        window: engine_window,
        count: 2,
        request: 41,
    });
    app.pump();
    let answered = |engine: &MockBrowserEngine| {
        engine.calls().into_iter().find_map(|call| match call {
            MockCall::Global(ardia_engine::GlobalCommand::ResolveCloseWithDownloads {
                request: 41,
                close_anyway,
            }) => Some(close_anyway),
            _ => None,
        })
    };
    assert_eq!(
        answered(&engine),
        None,
        "a quit never cancels downloads without asking"
    );
    assert!(
        app.take_effects()
            .contains(&ShellEffect::ConfirmCloseWithDownloads {
                window: Some(window),
                request: 41,
                count: 2,
                quitting: true,
            }),
        "the shell asks in the window the engine named"
    );
    assert_eq!(
        app.held_prompts().len(),
        1,
        "the question waits for an answer"
    );
    app.answer_close_with_downloads(41, false);
    assert_eq!(answered(&engine), Some(false));
    assert!(app.held_prompts().is_empty());
}

#[test]
fn background_instances_answer_the_downloads_question_themselves() {
    let engine = Arc::new(MockBrowserEngine::started());
    let shared: Arc<dyn BrowserEngine> = engine.clone();
    let app = AppCoordinator::new(
        fresh_store(),
        shared,
        CoordinatorConfig {
            hosts_native_windows: true,
            background: true,
            ..CoordinatorConfig::default()
        },
    );
    app.start();
    app.pump();
    let engine_window = app.engine_window(&app.focused_window().unwrap()).unwrap();
    engine.emit(EngineEvent::ConfirmCloseWithDownloads {
        window: engine_window,
        count: 1,
        request: 7,
    });
    app.pump();
    assert!(engine.calls().contains(&MockCall::Global(
        ardia_engine::GlobalCommand::ResolveCloseWithDownloads {
            request: 7,
            close_anyway: true,
        }
    )));
    assert!(
        !app.take_effects()
            .iter()
            .any(|effect| matches!(effect, ShellEffect::ConfirmCloseWithDownloads { .. })),
        "a hidden instance never shows the question"
    );
}

#[test]
fn menu_commands_follow_the_window_the_platform_focused() {
    let h = Harness::new();
    let first = h.window();
    h.app.run_command("newWindow", None).unwrap();
    h.pump();
    let second = h
        .windows(WindowKind::Main)
        .into_iter()
        .find(|w| *w != first)
        .expect("a second window");
    assert_eq!(h.state().focus_order.first(), Some(&second));
    h.app.follow_platform_focus(Some(&first));
    assert_eq!(h.state().focus_order.first(), Some(&first));
    let tabs = |window: &WindowId| h.state().window(window.as_str()).unwrap().tab_ids.len();
    let (before_first, before_second) = (tabs(&first), tabs(&second));
    h.app.run_command("newTab", None).unwrap();
    h.pump();
    assert_eq!(
        tabs(&first),
        before_first + 1,
        "the new tab lands in the window on screen"
    );
    assert_eq!(tabs(&second), before_second);
    h.app.follow_platform_focus(None);
    assert_eq!(
        h.state().focus_order.first(),
        Some(&first),
        "losing platform focus keeps the last window"
    );
}

#[test]
fn a_private_page_that_lands_in_a_regular_window_moves_to_a_private_one() {
    let (h, private, engine_tab) = private_harness();
    let private_profile = h.engine.tab_info(engine_tab).unwrap().profile.unwrap();
    let regular = h.window();
    let regular_engine_window = h.app.engine_window(&regular).unwrap();
    let stray = h
        .engine
        .open_tab(
            regular_engine_window,
            ardia_engine::OpenTab {
                url: "https://stray.example/".into(),
                profile: private_profile,
                foreground: false,
            },
        )
        .unwrap();
    h.pump();
    let state = h.state();
    assert!(
        state
            .window(regular.as_str())
            .unwrap()
            .tab_ids
            .iter()
            .all(|tab| state
                .tab(tab.as_str())
                .is_some_and(|t| t.url != "https://stray.example/")),
        "the regular window never lists the private page"
    );
    let sheltered = state
        .tabs
        .values()
        .find(|t| t.url == "https://stray.example/")
        .expect("the private page is listed somewhere");
    assert!(sheltered.is_incognito());
    assert_ne!(
        sheltered.window_id, private,
        "it gets its own private window"
    );
    assert_eq!(
        state.window(sheltered.window_id.as_str()).unwrap().kind,
        WindowKind::Incognito
    );
    assert_eq!(
        h.app.engine_tab(&sheltered.id),
        Some(stray),
        "the same page moved, nothing reloaded"
    );
    let home = h.app.engine_window(&sheltered.window_id).unwrap();
    assert!(h.engine.window_tabs(home).contains(&stray));
    assert!(!h.engine.window_tabs(regular_engine_window).contains(&stray));
    let settled = (0..4).map(|_| h.app.pump().rounds).sum::<usize>();
    assert_eq!(settled, 0);
}

#[cfg(unix)]
#[test]
fn a_second_launch_hands_its_links_to_the_running_one() {
    let h = Harness::new();
    let dir = tempfile::tempdir().unwrap();
    let held = match ardia_app::instance::claim(dir.path()).unwrap() {
        ardia_app::instance::Claim::Ours(lock) => lock,
        ardia_app::instance::Claim::Taken { .. } => panic!("the folder starts free"),
    };
    let socket = dir.path().join("ArdiaControl.sock");
    let _server = ardia_app::ipc::socket::ControlServer::start(socket.clone(), &h.app).unwrap();
    let pid = match ardia_app::instance::claim(dir.path()).unwrap() {
        ardia_app::instance::Claim::Taken { pid } => pid,
        ardia_app::instance::Claim::Ours(_) => panic!("the running instance holds the folder"),
    };
    assert_eq!(pid, Some(std::process::id()));
    let urls = vec!["https://handed.example/".to_owned()];
    let forwarding = std::thread::spawn(move || {
        ardia_app::instance::forward(&socket, &urls, std::time::Duration::from_secs(5))
    });
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
    while !forwarding.is_finished() && std::time::Instant::now() < deadline {
        h.pump();
        std::thread::sleep(std::time::Duration::from_millis(5));
    }
    assert_eq!(forwarding.join().unwrap().unwrap(), 1);
    h.pump();
    assert!(
        h.state()
            .tabs
            .values()
            .any(|t| t.url == "https://handed.example/"),
        "the running instance opened the link"
    );
    drop(held);
}

#[test]
fn a_navigation_made_while_a_restore_is_pending_wins() {
    let h = Harness::with_engine(|engine| {
        engine.set_service_handler("ac_tab_restore_take", |_, _| {
            Ok(json!({"state": "[\"https://old.example/1\",\"https://old.example/2\"]"}))
        });
    });
    let parked = Rc::new(std::cell::RefCell::new(Vec::new()));
    let queue = parked.clone();
    h.app
        .attach_spawner(move |task| queue.borrow_mut().push(task));
    let window = h.window();
    let tab = h.open(&window, "https://old.example/2");
    for task in parked.borrow_mut().drain(..) {
        drop(task);
    }
    h.app.dispatch(Action::CloseTabs {
        tabs: vec![tab],
        last_closes_window: false,
    });
    h.pump();
    h.app.run_command("reopenClosedTab", None).unwrap();
    h.pump();
    let reopened = h.active(&window);
    assert!(
        h.app.engine_tab(&reopened).is_none(),
        "the restore is still pending"
    );
    h.app
        .navigate(window, reopened.clone(), "https://new.example/".into());
    h.pump();
    let tasks: Vec<_> = parked.borrow_mut().drain(..).collect();
    for mut task in tasks {
        let waker = futures::task::noop_waker();
        let mut context = std::task::Context::from_waker(&waker);
        let _ = task.as_mut().poll(&mut context);
    }
    h.pump();
    let engine_tab = h.live(&reopened);
    assert_eq!(
        h.engine.tab_info(engine_tab).unwrap().url,
        "https://new.example/"
    );
    assert_eq!(
        h.state().tab(reopened.as_str()).unwrap().url,
        "https://new.example/"
    );
}

#[cfg(unix)]
#[test]
fn the_control_socket_never_deletes_a_regular_file_or_hangs_on_drop() {
    let h = Harness::new();
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("ArdiaControl.sock");
    std::fs::write(&path, b"keep me").unwrap();
    assert!(ardia_app::ipc::socket::ControlServer::start(path.clone(), &h.app).is_err());
    assert_eq!(std::fs::read(&path).unwrap(), b"keep me");
    std::fs::remove_file(&path).unwrap();
    let server = ardia_app::ipc::socket::ControlServer::start(path.clone(), &h.app).unwrap();
    std::fs::remove_file(&path).unwrap();
    let (done, finished) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        drop(server);
        let _ = done.send(());
    });
    assert!(
        finished
            .recv_timeout(std::time::Duration::from_secs(3))
            .is_ok(),
        "dropping the server returns even when its socket file is gone"
    );
}

#[cfg(unix)]
#[test]
fn a_second_launch_waits_for_a_first_one_that_is_still_starting() {
    let h = Harness::new();
    let dir = tempfile::tempdir().unwrap();
    let socket = dir.path().join("ArdiaControl.sock");
    let target = socket.clone();
    let urls = vec!["https://early.example/".to_owned()];
    let forwarding = std::thread::spawn(move || {
        ardia_app::instance::forward(&target, &urls, std::time::Duration::from_secs(5))
    });
    std::thread::sleep(std::time::Duration::from_millis(400));
    assert!(
        !forwarding.is_finished(),
        "the second launch keeps trying while the first starts"
    );
    let _server = ardia_app::ipc::socket::ControlServer::start(socket, &h.app).unwrap();
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
    while !forwarding.is_finished() && std::time::Instant::now() < deadline {
        h.pump();
        std::thread::sleep(std::time::Duration::from_millis(5));
    }
    assert_eq!(forwarding.join().unwrap().unwrap(), 1);
    h.pump();
    assert!(
        h.state()
            .tabs
            .values()
            .any(|t| t.url == "https://early.example/")
    );
}

#[cfg(unix)]
#[test]
fn the_control_socket_leaves_a_file_that_replaced_it() {
    let h = Harness::new();
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("ArdiaControl.sock");
    let server = ardia_app::ipc::socket::ControlServer::start(path.clone(), &h.app).unwrap();
    std::fs::remove_file(&path).unwrap();
    std::fs::write(&path, b"not a socket").unwrap();
    let started = std::time::Instant::now();
    drop(server);
    assert!(
        started.elapsed() < std::time::Duration::from_secs(1),
        "the listener stopped at once"
    );
    assert_eq!(std::fs::read(&path).unwrap(), b"not a socket");
}

fn downloading(h: &Harness) {
    let profile = h
        .app
        .service_profile_dir(&ProfileId::default_profile())
        .expect("the default profile has a folder");
    h.engine.emit(EngineEvent::Download(DownloadEvent::Changed {
        profile: Some(profile),
        item: Box::new(DownloadItem {
            id: "slow".into(),
            url: "https://files.example/big.iso".into(),
            filename: "big.iso".into(),
            state: "downloading".into(),
            received: 10.0,
            total: 1_000.0,
            ..DownloadItem::default()
        }),
    }));
    h.pump();
}

#[test]
fn quitting_with_no_window_asks_before_cancelling_downloads() {
    let h = Harness::new();
    downloading(&h);
    let window = h.window();
    h.app.dispatch(Action::CloseWindow { window });
    h.pump();
    assert!(
        h.windows(WindowKind::Main).is_empty(),
        "every browser window closed"
    );
    h.app.take_effects();
    h.app.request_quit();
    let effects = h.app.take_effects();
    assert!(effects.contains(&ShellEffect::ConfirmQuitWithDownloads { count: 1 }));
    assert!(
        !effects.contains(&ShellEffect::Quit),
        "nothing quits before the answer"
    );
    assert!(!h.app.is_shutting_down());
    h.app.quit_now();
    assert!(h.app.take_effects().contains(&ShellEffect::Quit));
    assert!(h.app.is_shutting_down());
}

#[test]
fn quitting_with_a_window_leaves_the_downloads_question_to_the_engine() {
    let h = Harness::new();
    downloading(&h);
    h.app.take_effects();
    h.app.request_quit();
    assert!(h.app.take_effects().contains(&ShellEffect::Quit));
}

#[test]
fn the_control_socket_doesnt_act_on_a_private_window_in_front() {
    let (h, private, _) = private_harness();
    let regular = h.window();
    assert_eq!(h.state().focus_order.first(), Some(&private));
    let refused = h
        .app
        .answer_control("eval_command", &json!({"command": "copyUrlAsMarkdown"}))
        .unwrap_err();
    assert_eq!(refused.code, "refused");
    assert!(
        !h.app
            .take_effects()
            .iter()
            .any(|effect| matches!(effect, ShellEffect::Copy(_))),
        "nothing reached the pasteboard"
    );
    let status = h.app.answer_control("status", &Value::Null).unwrap();
    assert_eq!(status["focusedWindow"], json!(regular.as_str()));
    let opened = h
        .app
        .answer_control("new_tab", &json!({"url": "https://regular.example/"}))
        .unwrap();
    assert_eq!(opened["window"], json!(regular.as_str()));
    assert!(
        h.app
            .answer_control("eval_command", &json!({"command": "newWindow"}))
            .is_ok(),
        "commands that leave the front window alone still run"
    );
}

#[test]
fn menu_validation_and_menu_commands_use_the_platform_window() {
    let h = Harness::new();
    let first = h.window();
    let engine_tab = h.live(&h.active(&first));
    h.engine.emit(EngineEvent::NavigationStateChanged {
        tab: engine_tab,
        can_go_back: true,
        can_go_forward: false,
    });
    h.pump();
    h.app.run_command("newWindow", None).unwrap();
    h.pump();
    let second = h
        .windows(WindowKind::Main)
        .into_iter()
        .find(|w| *w != first)
        .expect("a second window");
    assert!(
        !h.app.command_enabled("back", None),
        "the new window has nowhere to go back to"
    );
    h.app.follow_platform_focus(Some(&first));
    assert_eq!(h.state().focus_order.first(), Some(&first));
    h.app.dispatch(Action::FocusWindow {
        window: second.clone(),
    });
    h.app.follow_platform_focus(Some(&first));
    assert_eq!(
        h.state().focus_order.first(),
        Some(&second),
        "focus Ardia moved itself isn't undone while the platform catches up"
    );
    assert!(
        h.app.command_enabled("back", None),
        "menu validation asks about the platform's window"
    );
    let tabs = |window: &WindowId| h.state().window(window.as_str()).unwrap().tab_ids.len();
    let before = tabs(&first);
    h.engine.emit(EngineEvent::MenuCommand {
        command: "newTab".into(),
        arg: None,
    });
    h.pump();
    assert_eq!(
        tabs(&first),
        before + 1,
        "a menu command lands in the platform's window"
    );
}

#[test]
fn an_engine_private_window_belongs_to_the_profile_that_owns_its_folder() {
    let h = Harness::new();
    let window = h.window();
    let work = h
        .app
        .dispatch_action(Action::CreateProfile {
            name: "Work".into(),
            color: None,
            icon: None,
        })
        .unwrap()
        .profile
        .unwrap();
    h.app.dispatch(Action::SwitchProfile {
        window,
        profile: work.clone(),
    });
    h.pump();
    assert_eq!(
        h.state().last_active_profile(),
        work,
        "Work is the profile in use"
    );
    let default = h.app.engine_profile(&ProfileId::default_profile()).unwrap();
    let private = futures::executor::block_on(h.engine.off_the_record_profile(default)).unwrap();
    h.engine
        .simulate_new_browser(Some(private), ardia_engine::NewBrowserKind::Normal)
        .expect("the engine opens a window");
    h.pump();
    let state = h.state();
    let adopted = state
        .windows
        .values()
        .find(|w| w.kind == WindowKind::Incognito)
        .expect("the engine's private window is listed as private");
    assert_eq!(
        adopted.profile_id.incognito_original(),
        ProfileId::default_profile()
    );
    assert_eq!(h.app.engine_profile(&adopted.profile_id), Some(private));
}

#[cfg(unix)]
#[test]
fn the_control_socket_stops_listening_even_after_its_file_is_gone() {
    let h = Harness::new();
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("ArdiaControl.sock");
    let other_name = dir.path().join("still-here.sock");
    let server = ardia_app::ipc::socket::ControlServer::start(path.clone(), &h.app).unwrap();
    std::fs::hard_link(&path, &other_name).unwrap();
    std::fs::remove_file(&path).unwrap();
    assert!(
        std::os::unix::net::UnixStream::connect(&other_name).is_ok(),
        "the listener answers through the link"
    );
    drop(server);
    assert!(
        std::os::unix::net::UnixStream::connect(&other_name).is_err(),
        "nothing listens once the server is dropped"
    );
}

fn hosted(background: bool) -> (Arc<MockBrowserEngine>, Arc<AppCoordinator>) {
    let engine = Arc::new(MockBrowserEngine::started());
    let shared: Arc<dyn BrowserEngine> = engine.clone();
    let app = AppCoordinator::new(
        fresh_store(),
        shared,
        CoordinatorConfig {
            hosts_native_windows: true,
            background,
            ..CoordinatorConfig::default()
        },
    );
    app.start();
    app.pump();
    (engine, app)
}

#[test]
fn a_hosted_window_comes_on_screen_without_focus_in_the_background() {
    let (engine, app) = hosted(true);
    let window = app.focused_window().unwrap();
    let engine_window = app.engine_window(&window).unwrap();
    assert_eq!(
        app.present_window(&window),
        ardia_app::Presentation::ShowInactive
    );
    assert!(engine.calls().contains(&MockCall::Window(
        engine_window,
        WindowCommand::ShowInactive
    )));
    assert!(engine.window_info(engine_window).unwrap().visible);
}

#[test]
fn the_front_window_activates_and_the_others_show_behind_it() {
    let (engine, app) = hosted(false);
    let first = app.focused_window().unwrap();
    assert_eq!(
        app.present_window(&first),
        ardia_app::Presentation::Activate
    );
    app.run_command("newWindow", None).unwrap();
    app.pump();
    let second = app.focused_window().unwrap();
    assert_ne!(second, first);
    assert_eq!(
        app.present_window(&second),
        ardia_app::Presentation::Activate
    );
    let behind = app.engine_window(&first).unwrap();
    assert_eq!(
        app.present_window(&first),
        ardia_app::Presentation::ShowInactive
    );
    assert!(engine.window_info(behind).unwrap().visible);
}

#[test]
fn a_title_is_remembered_under_the_page_it_belongs_to() {
    let h = Harness::new();
    let window = h.window();
    let tab = h.open(&window, "https://first.example/");
    let engine_tab = h.live(&tab);
    h.engine.emit(EngineEvent::TitleChanged {
        tab: engine_tab,
        title: "First".into(),
    });
    h.pump();
    h.engine.emit(EngineEvent::UrlChanged {
        tab: engine_tab,
        url: "https://second.example/".into(),
    });
    h.engine.emit(EngineEvent::TitleChanged {
        tab: engine_tab,
        title: "Second".into(),
    });
    h.pump();
    let state = h.state();
    let history = state.history_of(&ProfileId::default_profile()).unwrap();
    let title_of = |url: &str| history.get(url).map(|entry| entry.title.clone());
    assert_eq!(title_of("https://first.example/").as_deref(), Some("First"));
    assert_eq!(
        title_of("https://second.example/").as_deref(),
        Some("Second")
    );
}

#[test]
fn a_new_tab_on_the_engines_blank_page_never_takes_about_blank_as_its_title() {
    let h = Harness::new();
    let window = h.window();
    let tab = h.open(&window, "");
    let engine_tab = h.live(&tab);
    h.engine.emit(EngineEvent::TitleChanged {
        tab: engine_tab,
        title: "about:blank".into(),
    });
    for url in ["about:blank", ""] {
        h.engine.emit(EngineEvent::ShownTitleChanged {
            tab: engine_tab,
            title: "about:blank".into(),
            url: url.into(),
        });
    }
    h.pump();
    let state = h.state();
    let shown = state.tab(tab.as_str()).unwrap();
    assert_ne!(shown.title, "about:blank");
    assert_eq!(shown.display_title(), "New Tab");
}

#[test]
fn an_untitled_page_shows_its_address_title_without_counting_a_visit() {
    let h = Harness::new();
    let window = h.window();
    let tab = h.open(&window, "http://127.0.0.1:9418/a.html");
    let engine_tab = h.live(&tab);
    h.engine.emit(EngineEvent::TitleChanged {
        tab: engine_tab,
        title: "Source".into(),
    });
    h.pump();
    let visits = |h: &Harness, url: &str| {
        h.state()
            .history_of(&ProfileId::default_profile())
            .and_then(|history| history.get(url).map(|entry| entry.visits))
            .unwrap_or(0)
    };
    let before = visits(&h, "http://127.0.0.1:9418/a.html");
    h.engine.emit(EngineEvent::UrlChanged {
        tab: engine_tab,
        url: "http://127.0.0.1:9418/b.html".into(),
    });
    h.engine.emit(EngineEvent::ShownTitleChanged {
        tab: engine_tab,
        title: String::new(),
        url: "http://127.0.0.1:9418/b.html".into(),
    });
    h.pump();
    assert_eq!(h.state().tab(tab.as_str()).unwrap().title, "");
    h.engine.emit(EngineEvent::ShownTitleChanged {
        tab: engine_tab,
        title: "127.0.0.1:9418/b.html".into(),
        url: "http://127.0.0.1:9418/b.html".into(),
    });
    h.pump();
    let state = h.state();
    let shown = state.tab(tab.as_str()).unwrap();
    assert_eq!(shown.title, "127.0.0.1:9418/b.html");
    assert_eq!(visits(&h, "http://127.0.0.1:9418/b.html"), 0);
    assert_eq!(visits(&h, "http://127.0.0.1:9418/a.html"), before);
}

#[test]
fn the_control_socket_wont_open_tabs_in_a_named_private_window() {
    let (h, private, _) = private_harness();
    let refused = h
        .app
        .answer_control(
            "new_tab",
            &json!({"window": private.as_str(), "url": "https://sneak.example/"}),
        )
        .unwrap_err();
    assert_eq!(refused.code, "refused");
    assert!(
        !h.state()
            .tabs
            .values()
            .any(|t| t.url == "https://sneak.example/")
    );
}

#[test]
fn closing_a_pinned_tab_lets_go_of_its_page() {
    let h = Harness::new();
    let window = h.window();
    let tab = h.open(&window, "https://pin.example/home");
    h.app.run_command("togglePin", None).unwrap();
    h.pump();
    assert!(
        h.state().tab(tab.as_str()).unwrap().is_pinned(),
        "the tab is pinned"
    );
    h.app
        .navigate(window, tab.clone(), "https://pin.example/away".into());
    h.pump();
    let old_page = h.live(&tab);
    assert_eq!(
        h.engine.tab_info(old_page).unwrap().url,
        "https://pin.example/away"
    );
    h.app.dispatch(Action::CloseTabs {
        tabs: vec![tab.clone()],
        last_closes_window: false,
    });
    h.pump();
    let listed = h
        .state()
        .tab(tab.as_str())
        .cloned()
        .expect("a pinned tab stays listed");
    assert_eq!(listed.url, "https://pin.example/home");
    assert!(h.app.engine_tab(&tab).is_none(), "its old page is let go");
    assert!(
        !h.engine.live_tabs().contains(&old_page),
        "the page that wandered away is closed"
    );
    h.app.dispatch(Action::ActivateTab { tab: tab.clone() });
    h.pump();
    let fresh = h.live(&tab);
    assert_ne!(fresh, old_page);
    assert_eq!(
        h.engine.tab_info(fresh).unwrap().url,
        "https://pin.example/home"
    );
}

#[test]
fn an_engine_private_window_finds_its_profile_by_folder() {
    let h = Harness::new();
    let work = h
        .app
        .dispatch_action(Action::CreateProfile {
            name: "Work".into(),
            color: None,
            icon: None,
        })
        .unwrap()
        .profile
        .unwrap();
    let folder = h.state().engine_profile(&work);
    let work_engine = futures::executor::block_on(h.engine.load_profile(&folder)).unwrap();
    assert_eq!(
        h.app.engine_profile(&work),
        None,
        "Ardia never loaded Work itself"
    );
    let private =
        futures::executor::block_on(h.engine.off_the_record_profile(work_engine)).unwrap();
    h.engine
        .simulate_new_browser(Some(private), ardia_engine::NewBrowserKind::Normal)
        .expect("the engine opens a window");
    h.pump();
    let state = h.state();
    let adopted = state
        .windows
        .values()
        .find(|w| w.kind == WindowKind::Incognito)
        .expect("the window is private");
    assert_eq!(adopted.profile_id.incognito_original(), work);
    assert_eq!(h.app.engine_profile(&adopted.profile_id), Some(private));
}

#[test]
fn an_unplaceable_private_profile_keeps_its_window_on_its_own_pages() {
    let h = Harness::new();
    let stranger = futures::executor::block_on(h.engine.load_profile("Stranger")).unwrap();
    let private = futures::executor::block_on(h.engine.off_the_record_profile(stranger)).unwrap();
    h.engine
        .simulate_new_browser(Some(private), ardia_engine::NewBrowserKind::Normal)
        .expect("the engine opens a window");
    h.pump();
    let state = h.state();
    let adopted = state
        .windows
        .values()
        .find(|w| w.kind == WindowKind::Incognito)
        .expect("the window is private");
    assert_eq!(
        h.app.engine_profile(&adopted.profile_id),
        Some(private),
        "more tabs in that window use the same private profile as its first page"
    );
    assert_eq!(
        h.app.window_for_new_tabs(Some(private)),
        None,
        "a guess never claims the profile for other windows"
    );
}

#[test]
fn private_tabs_only_join_windows_on_their_own_private_profile() {
    let (h, default_window, engine_tab) = private_harness();
    let default_private = h.engine.tab_info(engine_tab).unwrap().profile.unwrap();
    let stranger = futures::executor::block_on(h.engine.load_profile("Stranger")).unwrap();
    let stranger_private =
        futures::executor::block_on(h.engine.off_the_record_profile(stranger)).unwrap();
    h.engine
        .simulate_new_browser(Some(stranger_private), ardia_engine::NewBrowserKind::Normal)
        .expect("the engine opens a window");
    h.pump();
    let state = h.state();
    let stranger_window = state
        .windows
        .values()
        .find(|w| w.kind == WindowKind::Incognito && w.id != default_window)
        .expect("the stranger's window is private")
        .id
        .clone();
    assert_eq!(state.focus_order.first(), Some(&stranger_window));
    assert_eq!(
        h.app.window_for_new_tabs(Some(default_private)),
        h.app.engine_window(&default_window),
        "new private tabs go to the window on their own private profile"
    );
    let stranger_engine_window = h.app.engine_window(&stranger_window).unwrap();
    h.engine
        .open_tab(
            stranger_engine_window,
            ardia_engine::OpenTab {
                url: "https://mixed.example/".into(),
                profile: default_private,
                foreground: false,
            },
        )
        .unwrap();
    h.pump();
    let state = h.state();
    let mixed = state
        .tabs
        .values()
        .find(|t| t.url == "https://mixed.example/")
        .expect("the page is listed");
    assert_ne!(
        mixed.window_id, stranger_window,
        "two private sessions never share a window"
    );
    let home = state.window(mixed.window_id.as_str()).unwrap();
    assert_eq!(
        h.app.engine_profile(&home.profile_id),
        Some(default_private)
    );
}

#[test]
fn a_page_never_borrows_the_previous_pages_icon_in_history() {
    let h = Harness::new();
    let window = h.window();
    let tab = h.open(&window, "https://iconic.example/");
    let engine_tab = h.live(&tab);
    let icon = data_url(&png(4, 4, |_, _| [200, 30, 30, 255]));
    h.engine.emit(EngineEvent::FaviconChanged {
        tab: engine_tab,
        url: Some(icon.clone()),
    });
    h.engine.emit(EngineEvent::TitleChanged {
        tab: engine_tab,
        title: "Iconic".into(),
    });
    h.pump();
    h.engine.emit(EngineEvent::UrlChanged {
        tab: engine_tab,
        url: "https://plain.example/".into(),
    });
    h.pump();
    h.engine.emit(EngineEvent::TitleChanged {
        tab: engine_tab,
        title: "Plain".into(),
    });
    h.pump();
    let state = h.state();
    let history = state.history_of(&ProfileId::default_profile()).unwrap();
    assert_eq!(
        history
            .get("https://iconic.example/")
            .unwrap()
            .favicon
            .as_deref(),
        Some(icon.as_str())
    );
    assert_eq!(history.get("https://plain.example/").unwrap().favicon, None);
}

#[test]
fn video_upscaling_follows_its_setting_into_the_engine() {
    let h = Harness::new();
    let enabled = |h: &Harness| {
        h.engine
            .query(ardia_engine::EngineQuery::VideoUpscalingState)
            .unwrap()["enabled"]
            .as_bool()
    };
    assert_eq!(enabled(&h), Some(true));
    h.app.dispatch(Action::UpdateSettings {
        patch: SettingsPatch::new().set("videoUpscaling", false),
        from_sync: false,
    });
    h.pump();
    assert_eq!(enabled(&h), Some(false));
    h.app.dispatch(Action::UpdateSettings {
        patch: SettingsPatch::new().set("videoUpscaling", true),
        from_sync: false,
    });
    h.pump();
    assert_eq!(enabled(&h), Some(true));
}

#[test]
fn little_ardia_and_full_screen_hooks_never_touch_mock_windows() {
    use ardia_ui::UiHost;
    let h = Harness::new();
    h.window();
    h.app.dispatch(Action::OpenWindow {
        kind: WindowKind::LittleArdia,
        profile: None,
        url: Some("https://little.example".into()),
        frame: None,
    });
    h.pump();
    let little = h.windows(WindowKind::LittleArdia)[0].clone();
    assert_eq!(h.app.window_transitions(&little), 0);
    h.app.act_window_full_screen(little.clone(), true);
    h.app.move_window_to_display(
        little.clone(),
        "37D8832A-2D66-02CA-B9F7-8F30A301B230".into(),
    );
    h.app.act_window_full_screen(little.clone(), false);
    h.pump();
    assert_eq!(h.windows(WindowKind::LittleArdia), vec![little]);
}

#[test]
fn a_launch_with_urls_opens_them_without_touching_native_windows() {
    let h = Harness::new();
    h.window();
    h.app
        .queue_urls(vec!["https://launched.example/".to_owned()]);
    for _ in 0..5 {
        h.pump();
    }
    assert!(
        h.state()
            .tabs
            .values()
            .any(|t| t.url == "https://launched.example/"),
        "the launch link opened"
    );
}
