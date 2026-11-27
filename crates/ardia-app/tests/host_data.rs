use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::{Duration, Instant};

use ardia_app::{AppCoordinator, CoordinatorConfig};
use ardia_engine::mock::MockCall;
use ardia_engine::{
    BrowserEngine, CastDialog, CastSink, EngineEvent, GlobalCommand, MockBrowserEngine,
    ServiceEvent, TabCommand,
};
use ardia_state::actions::Action;
use ardia_state::ids::IdGen;
use ardia_state::persistence::session::{LoadOptions, SessionData};
use ardia_state::windows::Popover;
use ardia_state::{BrowserState, BrowserStore, ProfileId, TabId, WindowId};
use ardia_ui::UiHost;
use ardia_ui::host_data::{
    CastDeviceState, HostSubscription, HostTopics, StageState, SyncFolderState,
};
use serde_json::{Value, json};

fn fresh_store() -> Arc<BrowserStore> {
    Arc::new(BrowserStore::in_memory(
        BrowserState::from_session(
            SessionData::fresh(LoadOptions::default()),
            1_795_000_000_000,
        ),
        IdGen::with_launch("hostdata"),
    ))
}

struct Harness {
    engine: Arc<MockBrowserEngine>,
    app: Arc<AppCoordinator>,
}

impl Harness {
    fn new(config: CoordinatorConfig, setup: impl FnOnce(&MockBrowserEngine)) -> Self {
        let engine = Arc::new(MockBrowserEngine::started());
        setup(&engine);
        let shared: Arc<dyn BrowserEngine> = engine.clone();
        let app = AppCoordinator::new(fresh_store(), shared, config);
        app.start();
        app.pump();
        Harness { engine, app }
    }

    fn window(&self) -> WindowId {
        self.app.focused_window().expect("a window")
    }

    fn active(&self) -> TabId {
        let window = self.window();
        self.app
            .store()
            .snapshot()
            .active_tab(window.as_str())
            .map(|tab| tab.id.clone())
            .expect("an active tab")
    }

    fn counter(&self, topics: HostTopics) -> (Arc<AtomicUsize>, HostSubscription) {
        let hits = Arc::new(AtomicUsize::new(0));
        let seen = Arc::clone(&hits);
        let subscription =
            self.app
                .host_signal()
                .expect("the app signals")
                .subscribe(topics, move |_| {
                    seen.fetch_add(1, Ordering::SeqCst);
                });
        (hits, subscription)
    }

    fn pump_until(&self, done: impl Fn(&AppCoordinator) -> bool) {
        let deadline = Instant::now() + Duration::from_secs(10);
        while !done(&self.app) {
            assert!(Instant::now() < deadline, "timed out waiting");
            self.app.pump();
            std::thread::sleep(Duration::from_millis(5));
        }
    }

    fn service_calls(&self, name: &str) -> Vec<Value> {
        self.engine
            .calls()
            .into_iter()
            .filter_map(|call| match call {
                MockCall::Service {
                    name: called, args, ..
                } if called == name => Some(args),
                _ => None,
            })
            .collect()
    }
}

fn extensions_engine(engine: &MockBrowserEngine) {
    let pinned = Arc::new(parking_lot::Mutex::new(false));
    let listed = Arc::clone(&pinned);
    engine.set_service_handler("ac_extensions_list", move |_, _| {
        Ok(json!({"extensions": [
            {"id": "alpha", "name": "Alpha", "enabled": true, "pinned": true, "pinnedIndex": 0,
             "icon": "data:image/png;base64,iVBORw0KGgo=", "hasAction": true},
            {"id": "bravo", "name": "Bravo", "enabled": true, "pinned": *listed.lock(), "hasAction": true},
            {"id": "off", "name": "Off", "enabled": false}
        ]}))
    });
    engine.set_service_handler("ac_extensions_configure", move |_, args| {
        *pinned.lock() = args["options"]["pinned"].as_bool().unwrap_or(false);
        Ok(json!({"ok": true}))
    });
    engine.set_service_handler("ac_extensions_watch_actions", |_, _| {
        Ok(json!({"ok": true}))
    });
}

#[test]
fn extensions_list_with_icons_pin_and_follow_engine_changes() {
    let h = Harness::new(CoordinatorConfig::default(), extensions_engine);
    let window = h.window();
    let (hits, _subscription) = h.counter(HostTopics::EXTENSIONS);
    let first = h.app.extensions(&window);
    let list = if first.loaded {
        first
    } else {
        h.pump_until(|app| app.extensions(&window).loaded);
        h.app.extensions(&window)
    };
    assert!(
        hits.load(Ordering::SeqCst) >= 1,
        "the list arrival is signalled"
    );
    assert_eq!(list.items.len(), 3);
    assert!(list.find("alpha").unwrap().icon.is_some(), "icons decode");
    let toolbar: Vec<&str> = list.toolbar().iter().map(|x| x.id.as_str()).collect();
    assert_eq!(toolbar, ["alpha"]);
    assert_eq!(
        list.menu().len(),
        2,
        "disabled extensions stay out of the menu"
    );
    assert!(!h.service_calls("ac_extensions_watch_actions").is_empty());

    h.app
        .set_extension_pinned(window.clone(), "bravo".into(), true);
    h.app.pump();
    let configured = h.service_calls("ac_extensions_configure");
    assert_eq!(configured.last().unwrap()["id"], "bravo");
    let list = h.app.extensions(&window);
    assert!(list.find("bravo").unwrap().pinned);
    assert_eq!(list.toolbar().len(), 2);

    let listings = h.service_calls("ac_extensions_list").len();
    h.engine.emit(EngineEvent::Service(ServiceEvent {
        topic: "extensions.changed".into(),
        profile: None,
        off_the_record: false,
        payload: json!({}),
    }));
    h.app.pump();
    assert!(
        h.service_calls("ac_extensions_list").len() > listings,
        "a change refetches"
    );
    assert!(h.app.extensions(&window).loaded);
}

fn action_state_queries(engine: &MockBrowserEngine) -> usize {
    engine
        .calls()
        .iter()
        .filter(|call| matches!(call, MockCall::ExtensionActionStates(_)))
        .count()
}

fn loaded_list(h: &Harness, window: &WindowId) -> ardia_ui::host_data::ExtensionList {
    h.app.extensions(window);
    h.pump_until(|app| app.extensions(window).loaded);
    h.app.extensions(window)
}

#[test]
fn the_toolbar_reads_a_prepared_snapshot_and_never_queries_the_engine_while_drawing() {
    let h = Harness::new(CoordinatorConfig::default(), extensions_engine);
    let window = h.window();
    let first = loaded_list(&h, &window);
    let first_icon = first.find("alpha").unwrap().icon.clone().unwrap();
    let again = h.app.extensions(&window);
    assert!(
        Arc::ptr_eq(
            &first_icon,
            again.find("alpha").unwrap().icon.as_ref().unwrap()
        ),
        "drawing again reuses the decoded icon"
    );
    let other = h
        .app
        .dispatch_action(Action::NewTab {
            window: window.clone(),
            tab: ardia_state::NewTab {
                url: Some("https://other.example/".into()),
                ..ardia_state::NewTab::default()
            },
        })
        .unwrap()
        .tab
        .unwrap();
    h.app.pump();
    assert_eq!(h.active(), other);
    let queries = action_state_queries(&h.engine);
    let drawn = h.app.extensions(&window);
    assert!(drawn.loaded, "the previous snapshot stays on screen");
    assert_eq!(
        action_state_queries(&h.engine),
        queries,
        "a newly shown tab doesn't query the engine while drawing"
    );
    h.engine.emit(EngineEvent::Service(ServiceEvent {
        topic: "extensions.action".into(),
        profile: None,
        off_the_record: false,
        payload: json!({}),
    }));
    h.app.pump();
    let settled = action_state_queries(&h.engine);
    assert!(
        settled > queries,
        "the snapshot rebuilds off the drawing path"
    );
    h.app.extensions(&window);
    h.app.extensions(&window);
    assert_eq!(action_state_queries(&h.engine), settled);
}

#[test]
fn incognito_toolbars_keep_their_pinned_extensions() {
    let h = Harness::new(CoordinatorConfig::default(), |engine| {
        engine.set_service_handler("ac_extensions_list", |_, _| {
            Ok(json!({"extensions": [
                {"id": "alpha", "name": "Alpha", "enabled": true, "pinned": true, "pinnedIndex": 0,
                 "incognito": true, "hasAction": true},
                {"id": "bravo", "name": "Bravo", "enabled": true, "pinned": true, "pinnedIndex": 1,
                 "incognito": false, "hasAction": true}
            ]}))
        });
        engine.set_service_handler("ac_extensions_watch_actions", |_, _| {
            Ok(json!({"ok": true}))
        });
    });
    let private = h
        .app
        .dispatch_action(Action::OpenWindow {
            kind: ardia_state::windows::WindowKind::Incognito,
            profile: None,
            url: None,
            frame: None,
        })
        .unwrap()
        .window
        .unwrap();
    h.app.pump();
    loaded_list(&h, &private);
    let profile = h
        .app
        .store()
        .snapshot()
        .window(private.as_str())
        .map(|w| w.profile_id.clone())
        .unwrap();
    assert!(profile.is_incognito());
    let feed = ardia_ui::content::toolbar_extensions::feed_from_host(&*h.app, &private, None);
    let shown: Vec<&str> = feed
        .actions_of(&profile)
        .iter()
        .map(|action| action.id.as_str())
        .collect();
    assert_eq!(
        shown,
        ["alpha"],
        "only extensions allowed in private windows show"
    );
}

#[test]
fn a_toolbar_click_opens_the_popup_without_adding_a_tab_and_closes_it() {
    let h = Harness::new(CoordinatorConfig::default(), |engine| {
        extensions_engine(engine);
        engine.set_extension_popup("alpha", Some("chrome-extension://alpha/popup.html"));
    });
    let window = h.window();
    let tab = h.active();
    h.app.extensions(&window);
    h.app.pump();
    let tabs_before = h
        .app
        .store()
        .snapshot()
        .view_tabs(window.as_str(), None)
        .len();
    h.app.execute_extension_action(tab.clone(), "alpha".into());
    h.app.pump();
    let popup = h.app.extension_popup(&window).expect("the popup opens");
    assert_eq!(popup.extension_id, "alpha");
    assert_eq!(popup.name, "Alpha");
    assert_eq!(
        h.app
            .store()
            .snapshot()
            .view_tabs(window.as_str(), None)
            .len(),
        tabs_before,
        "the popup's page isn't a tab"
    );
    h.app.execute_extension_action(tab.clone(), "alpha".into());
    h.app.pump();
    assert!(
        h.app.extension_popup(&window).is_none(),
        "a second click closes it"
    );
    assert!(
        h.engine
            .calls()
            .iter()
            .any(|call| matches!(call, MockCall::Tab(_, TabCommand::CloseNow)))
    );

    h.app.execute_extension_action(tab.clone(), "bravo".into());
    h.app.pump();
    assert!(
        h.app.extension_popup(&window).is_none(),
        "an extension without a popup opens nothing"
    );

    h.app.execute_extension_action(tab, "alpha".into());
    h.app.pump();
    assert!(h.app.extension_popup(&window).is_some());
    h.app.dispatch(Action::SetPopover {
        window: window.clone(),
        popover: Some(Popover::Downloads),
    });
    assert!(
        h.app.extension_popup(&window).is_none(),
        "another popover replaces it"
    );
}

#[test]
fn cast_devices_list_and_casting_starts_and_stops() {
    let h = Harness::new(CoordinatorConfig::default(), |_| {});
    let window = h.window();
    let tab = h.active();
    let engine_tab = h.app.engine_tab(&tab).expect("a live page");
    let (hits, _subscription) = h.counter(HostTopics::CAST);
    h.app.show_cast(tab.clone());
    let dialog = |state: &str, route: &str| CastDialog {
        id: 7,
        open: true,
        header: "Cast tab".into(),
        sinks: vec![
            CastSink {
                id: "tv".into(),
                name: "Living Room".into(),
                state: state.into(),
                modes: 2 | 4,
                route_id: route.into(),
                ..CastSink::default()
            },
            CastSink {
                id: "speaker".into(),
                name: "Kitchen".into(),
                state: "available".into(),
                modes: 0,
                icon: 2,
                ..CastSink::default()
            },
            CastSink {
                id: "mirror".into(),
                name: "Screen Mirror".into(),
                state: "available".into(),
                modes: 4,
                icon: 6,
                ..CastSink::default()
            },
        ],
        ..CastDialog::default()
    };
    h.engine.emit(EngineEvent::CastDialog {
        tab: Some(engine_tab),
        dialog: dialog("available", ""),
    });
    h.app.pump();
    assert!(hits.load(Ordering::SeqCst) >= 1);
    assert_eq!(
        h.app
            .store()
            .snapshot()
            .window(window.as_str())
            .and_then(|w| w.chrome.popover.clone()),
        Some(Popover::Cast)
    );
    let panel = h.app.cast_panel(&tab).expect("the dialog is open");
    assert_eq!(panel.devices.len(), 3);
    assert_eq!(panel.devices[0].state, CastDeviceState::Available);

    h.app.start_casting(tab.clone(), "tv".into());
    assert!(
        h.engine
            .calls()
            .contains(&MockCall::Global(GlobalCommand::StartCasting {
                dialog_id: 7,
                sink_id: "tv".into(),
                mode: 2,
            }))
    );
    let starts = |engine: &MockBrowserEngine| {
        engine
            .calls()
            .iter()
            .filter(|call| matches!(call, MockCall::Global(GlobalCommand::StartCasting { .. })))
            .count()
    };
    h.app.start_casting(tab.clone(), "speaker".into());
    assert_eq!(
        starts(&h.engine),
        1,
        "a device that can't show the tab is left alone"
    );
    assert!(!h.app.cast_panel(&tab).unwrap().screen);
    h.app.start_casting(tab.clone(), "mirror".into());
    assert_eq!(
        starts(&h.engine),
        1,
        "a screen-only receiver clicked in tab mode starts nothing"
    );
    let switched = h.app.cast_panel(&tab).unwrap();
    assert!(switched.screen, "the click switches Sources to Cast Screen");
    assert_eq!(switched.title(), "Cast screen");
    h.app.start_casting(tab.clone(), "mirror".into());
    assert!(
        h.engine
            .calls()
            .contains(&MockCall::Global(GlobalCommand::StartCasting {
                dialog_id: 7,
                sink_id: "mirror".into(),
                mode: 4,
            })),
        "a second click in screen mode mirrors the screen on purpose"
    );
    h.app.set_cast_source(tab.clone(), false);

    h.engine.emit(EngineEvent::CastDialog {
        tab: Some(engine_tab),
        dialog: dialog("connected", "route-1"),
    });
    h.app.pump();
    assert!(h.app.cast_panel(&tab).unwrap().devices[0].casting());
    h.app.stop_casting(tab.clone(), "tv".into());
    assert!(
        h.engine
            .calls()
            .contains(&MockCall::Global(GlobalCommand::StopCasting {
                dialog_id: 7,
                route_id: "route-1".into(),
            }))
    );

    h.app.dispatch(Action::SetPopover {
        window,
        popover: None,
    });
    assert!(
        h.engine
            .calls()
            .contains(&MockCall::Global(GlobalCommand::CloseCastDialog {
                dialog_id: 7,
            }))
    );
    assert!(
        h.app.cast_panel(&tab).is_none(),
        "dismissing closes the dialog"
    );
}

#[test]
fn imports_stream_progress_per_stage_and_report_failures() {
    let h = Harness::new(CoordinatorConfig::default(), |_| {});
    let (hits, _subscription) = h.counter(HostTopics::IMPORT);
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("bookmarks.html");
    let links: String = (0..450)
        .map(|n| format!("<DT><A HREF=\"https://site{n}.example/\">Site {n}</A>\n"))
        .collect();
    std::fs::write(
        &path,
        format!("<!DOCTYPE NETSCAPE-Bookmark-file-1>\n<DL><p>\n{links}</DL><p>"),
    )
    .unwrap();
    let profile = ProfileId::default_profile();
    h.app
        .start_import(format!("html:{}", path.display()), profile.clone());
    let started = h.app.import_progress().expect("progress starts at once");
    assert_eq!(
        started.stage("bookmarks").unwrap().state,
        StageState::Running
    );
    h.pump_until(|app| app.import_progress().is_some_and(|p| p.finished));
    let done = h.app.import_progress().unwrap();
    assert!(done.succeeded(), "{done:?}");
    let bookmarks = done.stage("bookmarks").unwrap();
    assert_eq!(bookmarks.state, StageState::Done);
    assert_eq!((bookmarks.done, bookmarks.total), (450, Some(450)));
    assert!(
        hits.load(Ordering::SeqCst) >= 3,
        "each stage change is streamed"
    );

    h.app
        .start_import("chrome:passwords,cookies".into(), profile.clone());
    let skipped = h.app.import_progress().unwrap();
    assert!(skipped.finished && skipped.error.is_none());
    assert!(matches!(
        skipped.stage("passwords").unwrap().state,
        StageState::Failed(_)
    ));
    assert!(matches!(
        skipped.stage("cookies").unwrap().state,
        StageState::Failed(_)
    ));

    h.app.start_import("netscape:bookmarks".into(), profile);
    h.pump_until(|app| app.import_progress().is_some_and(|p| p.finished));
    let failed = h.app.import_progress().unwrap();
    assert!(failed.error.is_some());
    assert!(matches!(
        failed.stage("bookmarks").unwrap().state,
        StageState::Failed(_)
    ));
}

#[test]
fn sync_status_reads_the_data_folder() {
    let data = tempfile::tempdir().unwrap();
    std::fs::write(
        data.path().join("sync.json"),
        json!({"v": 1, "enabled": true, "folder": "/definitely/not/here", "deviceId": "dev",
               "lastSyncedAt": 1_795_000_000_000u64})
        .to_string(),
    )
    .unwrap();
    let h = Harness::new(
        CoordinatorConfig {
            data_dir: Some(data.path().to_path_buf()),
            ..CoordinatorConfig::default()
        },
        |_| {},
    );
    let (hits, _subscription) = h.counter(HostTopics::SYNC);
    assert!(!h.app.sync_status().loaded);
    h.app.refresh_sync_status();
    h.pump_until(|app| app.sync_status().loaded);
    let status = h.app.sync_status();
    assert!(status.enabled);
    assert_eq!(status.folder_state, SyncFolderState::Missing);
    assert_eq!(status.errors.len(), 1);
    assert_eq!(status.devices.len(), 1);
    assert!(hits.load(Ordering::SeqCst) >= 1);

    let unset = Harness::new(CoordinatorConfig::default(), |_| {});
    unset.app.refresh_sync_status();
    assert!(unset.app.sync_status().loaded && !unset.app.sync_status().enabled);
}

#[test]
fn imported_bookmarks_reach_the_bookmarks_page_tree() {
    let h = Harness::new(CoordinatorConfig::default(), |_| {});
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("bookmarks.html");
    std::fs::write(
        &path,
        "<!DOCTYPE NETSCAPE-Bookmark-file-1>\n<DL><p>\n<DT><H3>Work</H3>\n<DL><p>\n<DT><A HREF=\"https://work.example/\">Work site</A>\n</DL><p>\n<DT><A HREF=\"https://home.example/\">Home</A>\n<DT><A HREF=\"javascript:alert(1)\">Script</A>\n</DL><p>",
    )
    .unwrap();
    let profile = ProfileId::default_profile();
    h.app
        .start_import(format!("html:{}", path.display()), profile.clone());
    h.pump_until(|app| app.import_progress().is_some_and(|p| p.finished));
    let state = h.app.store().snapshot();
    let tree = state.bookmarks_of(&profile).expect("a bookmark tree");
    let urls: Vec<String> = tree.rows().map(|row| row.url.to_owned()).collect();
    assert!(
        urls.iter().any(|url| url == "https://work.example/"),
        "{urls:?}"
    );
    assert!(urls.iter().any(|url| url == "https://home.example/"));
    assert!(!urls.iter().any(|url| url.starts_with("javascript:")));
    let count = tree.rows().count();
    h.app
        .start_import(format!("html:{}", path.display()), profile.clone());
    h.pump_until(|app| app.import_progress().is_some_and(|p| p.finished));
    let again = h.app.store().snapshot();
    assert_eq!(
        again.bookmarks_of(&profile).unwrap().rows().count(),
        count,
        "importing the same file again adds nothing"
    );
    assert_eq!(
        h.app
            .import_progress()
            .unwrap()
            .stage("bookmarks")
            .unwrap()
            .done,
        0
    );
}

#[test]
fn cancelling_an_import_stops_it_before_anything_lands() {
    let h = Harness::new(CoordinatorConfig::default(), |_| {});
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("bookmarks.html");
    let links: String = (0..50)
        .map(|n| format!("<DT><A HREF=\"https://cancel{n}.example/\">C {n}</A>\n"))
        .collect();
    std::fs::write(
        &path,
        format!("<!DOCTYPE NETSCAPE-Bookmark-file-1>\n<DL><p>\n{links}</DL><p>"),
    )
    .unwrap();
    h.app.run_import(ardia_ui::host_data::ImportPlan {
        source_id: "html".into(),
        source_name: "bookmarks.html".into(),
        profiles: Vec::new(),
        kinds: vec!["bookmarks".into()],
        target: Some(ProfileId::default_profile()),
        file: Some(path.display().to_string()),
    });
    h.app.cancel_import();
    let cancelled = h.app.import_progress().unwrap();
    assert!(cancelled.finished);
    assert_eq!(cancelled.error.as_deref(), Some("Cancelled"));
    for _ in 0..40 {
        h.app.pump();
        std::thread::sleep(Duration::from_millis(5));
    }
    let state = h.app.store().snapshot();
    assert!(
        state
            .bookmarks_of(&ProfileId::default_profile())
            .is_none_or(|tree| !tree.rows().any(|row| row.url.starts_with("https://cancel"))),
        "nothing from the cancelled run lands"
    );
}

#[test]
fn other_browsers_are_found_with_their_profiles() {
    let home = tempfile::tempdir().unwrap();
    let chrome = home.path().join(if cfg!(target_os = "macos") {
        "Library/Application Support/Google/Chrome"
    } else {
        ".config/google-chrome"
    });
    for dir in ["Default", "Profile 1", "Profile 2"] {
        std::fs::create_dir_all(chrome.join(dir)).unwrap();
    }
    std::fs::write(chrome.join("Default/Bookmarks"), "{}").unwrap();
    std::fs::write(chrome.join("Profile 1/Bookmarks"), "{}").unwrap();
    std::fs::write(
        chrome.join("Local State"),
        json!({"profile": {"info_cache": {
            "Default": {"name": "Personal", "user_name": "me@example.com"},
            "Profile 1": {"name": "Work"},
            "Profile 2": {"name": "Empty"}
        }}})
        .to_string(),
    )
    .unwrap();
    let found = ardia_app::import::detect_browsers(home.path());
    assert_eq!(found.len(), 1);
    assert_eq!(found[0].name, "Chrome");
    let names: Vec<&str> = found[0].profiles.iter().map(|p| p.name.as_str()).collect();
    assert_eq!(
        names,
        ["Personal", "Work"],
        "profiles without bookmarks aren't offered"
    );
    assert_eq!(
        found[0].profiles[0].email.as_deref(),
        Some("me@example.com")
    );
    assert!(found[0].profiles[0].is_default);
}

#[test]
fn toolbar_extensions_reorder_and_open_their_side_panel_like_the_old_app() {
    let h = Harness::new(CoordinatorConfig::default(), |engine| {
        engine.set_service_handler("ac_extensions_list", |_, _| {
            Ok(json!({"extensions": [
                {"id": "a", "name": "A", "enabled": true, "pinned": true, "pinnedIndex": 0, "sidePanel": "panel.html"},
                {"id": "b", "name": "B", "enabled": true, "pinned": true, "pinnedIndex": 1},
                {"id": "c", "name": "C", "enabled": true, "pinned": true, "pinnedIndex": 2}
            ]}))
        });
        engine.set_service_handler("ac_extensions_configure", |_, _| Ok(json!({"ok": true})));
        engine.set_service_handler("ac_extensions_watch_actions", |_, _| {
            Ok(json!({"ok": true}))
        });
    });
    let window = h.window();
    h.app.extensions(&window);
    h.pump_until(|app| app.extensions(&window).loaded);
    assert!(h.app.extensions(&window).find("a").unwrap().side_panel);
    h.app.move_extension(window.clone(), "a".into(), 2);
    h.app.pump();
    let order: Vec<String> = h
        .app
        .extensions(&window)
        .toolbar()
        .iter()
        .map(|item| item.id.clone())
        .collect();
    assert_eq!(order, ["b", "c", "a"]);
    let configured = h.service_calls("ac_extensions_configure");
    assert_eq!(configured.last().unwrap()["options"]["pinnedIndex"], 2);

    h.app.toggle_side_panel(window.clone(), "a".into());
    h.app.pump();
    let panel = h.app.side_panel(&window).expect("the side panel opens");
    assert_eq!(panel.extension_id, "a");
    assert_eq!(panel.title, "A");
    h.app.toggle_side_panel(window.clone(), "a".into());
    h.app.pump();
    assert!(
        h.app.side_panel(&window).is_none(),
        "toggling again closes it"
    );
}

#[test]
fn cast_routes_show_in_the_toolbar_and_stop_from_its_menu() {
    let h = Harness::new(CoordinatorConfig::default(), |_| {});
    let window = h.window();
    assert!(!h.app.casting(&window));
    h.engine.emit(EngineEvent::CastRoutes {
        profile: None,
        routes: vec![ardia_engine::CastRoute {
            id: "route-1".into(),
            sink: "Living Room".into(),
            source: String::new(),
            description: "YouTube".into(),
        }],
    });
    h.app.pump();
    assert!(h.app.casting(&window));
    let routes = UiHost::cast_routes(&*h.app, &window);
    assert_eq!(
        ardia_ui::host_data::cast_routes_tooltip(&routes),
        "YouTube on Living Room"
    );
    h.app.stop_cast_route("route-1".into());
    assert!(
        h.engine
            .calls()
            .contains(&MockCall::Global(GlobalCommand::TerminateCastRoute {
                route_id: "route-1".into()
            }))
    );
}

#[test]
fn the_what_syncs_checklist_saves_each_choice() {
    let data = tempfile::tempdir().unwrap();
    std::fs::write(
        data.path().join("sync.json"),
        json!({"v": 1, "enabled": true, "folder": data.path(), "deviceId": "dev"}).to_string(),
    )
    .unwrap();
    let h = Harness::new(
        CoordinatorConfig {
            data_dir: Some(data.path().to_path_buf()),
            ..CoordinatorConfig::default()
        },
        |_| {},
    );
    h.app.set_sync_type("history".into(), false);
    h.pump_until(|app| app.sync_status().data_types.get("history") == Some(&false));
    let saved: Value =
        serde_json::from_str(&std::fs::read_to_string(data.path().join("sync.json")).unwrap())
            .unwrap();
    assert_eq!(saved["types"]["history"], false);
    assert_eq!(saved["deviceId"], "dev", "the rest of the document is kept");
    h.app.set_sync_type("not-a-type".into(), false);
    assert!(h.app.sync_status().folder_exists);
}
