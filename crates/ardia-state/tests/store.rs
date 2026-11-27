mod common;

use ardia_state::actions::{Action, NewTab, PageUpdate, Topics};
use ardia_state::ids::{IdGen, WindowId};
use ardia_state::persistence::DataDir;
use ardia_state::persistence::session::{LoadOptions, SESSION, SessionData, SessionSource};
use ardia_state::state::BrowserState;
use ardia_state::store::{BrowserStore, Interest, Update};
use ardia_state::windows::WindowKind;
use parking_lot::Mutex;
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::Duration;

fn memory_store() -> BrowserStore {
    BrowserStore::in_memory(
        BrowserState::from_session(SessionData::fresh(LoadOptions::default()), common::T0),
        IdGen::with_launch("store"),
    )
}

fn open_window(store: &BrowserStore) -> WindowId {
    store
        .dispatch(Action::OpenWindow {
            kind: WindowKind::Main,
            profile: None,
            url: None,
            frame: None,
        })
        .unwrap()
        .window
        .unwrap()
}

fn new_tab(store: &BrowserStore, window: &WindowId, url: &str) -> ardia_state::ids::TabId {
    store
        .dispatch(Action::NewTab {
            window: window.clone(),
            tab: NewTab {
                url: Some(url.into()),
                ..NewTab::default()
            },
        })
        .unwrap()
        .tab
        .unwrap()
}

#[test]
fn revisions_count_real_changes_only() {
    let store = memory_store();
    assert_eq!(store.revision(), 0);
    let window = open_window(&store);
    assert_eq!(store.revision(), 1);
    assert!(
        store
            .dispatch(Action::CloseWindow {
                window: WindowId::new("w-ghost")
            })
            .is_err()
    );
    assert_eq!(store.revision(), 1, "a refused action is not a revision");
    let same = store
        .dispatch(Action::SetSidebarPeeking {
            window: window.clone(),
            peeking: false,
        })
        .unwrap();
    assert!(
        same.changes.is_empty(),
        "setting what is already set changes nothing"
    );
    let choose = || Action::UpdateSettings {
        patch: ardia_state::settings::SettingsPatch::new().set("autoHideTabs", false),
        from_sync: false,
    };
    store.dispatch(choose()).unwrap();
    assert_eq!(
        store.revision(),
        2,
        "choosing a value marks it as chosen even when it matches the default"
    );
    store.dispatch(choose()).unwrap();
    assert_eq!(store.revision(), 2, "choosing it again changes nothing");
    let peek = store
        .dispatch(Action::SetSidebarPeeking {
            window,
            peeking: true,
        })
        .unwrap();
    assert!(peek.changes.topics.contains(Topics::CHROME));
    assert!(!peek.changes.persists_session());
    assert_eq!(store.revision(), 3);
}

#[test]
fn snapshots_never_change_under_a_reader() {
    let store = memory_store();
    let window = open_window(&store);
    let before = store.snapshot();
    let tab = new_tab(&store, &window, "a.com");
    assert!(!before.tabs.contains_key(&tab));
    assert!(store.snapshot().tabs.contains_key(&tab));
    assert!(
        Arc::ptr_eq(&before.profiles, &store.snapshot().profiles),
        "untouched parts are shared, not copied"
    );
}

#[test]
fn listeners_hear_only_what_they_asked_for() {
    let store = memory_store();
    let window = open_window(&store);
    let first = new_tab(&store, &window, "a.com");
    let second = new_tab(&store, &window, "b.com");
    let tabs_heard = Arc::new(AtomicUsize::new(0));
    let first_heard = Arc::new(AtomicUsize::new(0));
    let settings_heard = Arc::new(AtomicUsize::new(0));
    let count = |n: &Arc<AtomicUsize>| {
        let n = Arc::clone(n);
        move |_: &Update| {
            n.fetch_add(1, Ordering::SeqCst);
        }
    };
    let _tabs = store.subscribe(Interest::Topics(Topics::TABS), count(&tabs_heard));
    let _first = store.subscribe(Interest::Tab(first.clone()), count(&first_heard));
    let settings = store.subscribe(Interest::Topics(Topics::SETTINGS), count(&settings_heard));
    let progress = PageUpdate {
        progress: Some(0.4),
        ..PageUpdate::default()
    };
    store
        .dispatch(Action::UpdatePage {
            tab: second.clone(),
            update: progress.clone(),
        })
        .unwrap();
    assert_eq!(
        first_heard.load(Ordering::SeqCst),
        0,
        "another tab's progress is not this tab's news"
    );
    assert_eq!(
        tabs_heard.load(Ordering::SeqCst),
        0,
        "live progress is not a tab-list change"
    );
    store
        .dispatch(Action::UpdatePage {
            tab: first,
            update: progress,
        })
        .unwrap();
    assert_eq!(first_heard.load(Ordering::SeqCst), 1);
    store
        .dispatch(Action::SetMuted {
            tab: second,
            muted: true,
        })
        .unwrap();
    assert_eq!(tabs_heard.load(Ordering::SeqCst), 1);
    assert_eq!(settings_heard.load(Ordering::SeqCst), 0);
    drop(settings);
    store
        .dispatch(Action::UpdateSettings {
            patch: ardia_state::settings::SettingsPatch::new().set("autoHideTabs", true),
            from_sync: false,
        })
        .unwrap();
    assert_eq!(
        settings_heard.load(Ordering::SeqCst),
        0,
        "a dropped subscription hears nothing"
    );
}

#[test]
fn listeners_may_dispatch_and_updates_stay_in_order() {
    let store = Arc::new(memory_store());
    let window = open_window(&store);
    let seen = Arc::new(Mutex::new(Vec::new()));
    let weak = Arc::downgrade(&store);
    let window_for_listener = window.clone();
    let log = Arc::clone(&seen);
    let _sub = store.subscribe(Interest::Topics(Topics::ALL), move |update| {
        log.lock().push(update.revision);
        if update.revision == 2
            && let Some(store) = weak.upgrade()
        {
            let _ = store.dispatch(Action::NewTab {
                window: window_for_listener.clone(),
                tab: NewTab::default(),
            });
        }
    });
    new_tab(&store, &window, "a.com");
    new_tab(&store, &window, "b.com");
    let seen = seen.lock().clone();
    assert_eq!(seen, vec![2, 3, 4]);
    assert_eq!(store.revision(), 4);
}

#[test]
fn a_panicking_listener_does_not_stop_the_others() {
    let store = memory_store();
    let heard = Arc::new(AtomicUsize::new(0));
    let _bad = store.subscribe(Interest::Topics(Topics::ALL), |_| panic!("listener bug"));
    let n = Arc::clone(&heard);
    let _good = store.subscribe(Interest::Topics(Topics::ALL), move |_| {
        n.fetch_add(1, Ordering::SeqCst);
    });
    open_window(&store);
    open_window(&store);
    assert_eq!(heard.load(Ordering::SeqCst), 2);
}

#[test]
fn many_threads_dispatch_without_losing_a_change() {
    let store = Arc::new(memory_store());
    let window = open_window(&store);
    let revisions = Arc::new(Mutex::new(Vec::new()));
    let log = Arc::clone(&revisions);
    let _sub = store.subscribe(Interest::Topics(Topics::TABS), move |u| {
        log.lock().push(u.revision)
    });
    let threads: Vec<_> = (0..8)
        .map(|n| {
            let store = Arc::clone(&store);
            let window = window.clone();
            std::thread::spawn(move || {
                for i in 0..50 {
                    store
                        .dispatch(Action::NewTab {
                            window: window.clone(),
                            tab: NewTab {
                                url: Some(format!("t{n}-{i}.com")),
                                background: true,
                                ..NewTab::default()
                            },
                        })
                        .unwrap();
                }
            })
        })
        .collect();
    for t in threads {
        t.join().unwrap();
    }
    assert_eq!(store.snapshot().tabs.len(), 1 + 8 * 50);
    assert_eq!(store.revision(), 1 + 8 * 50);
    let revisions = revisions.lock().clone();
    assert_eq!(revisions.len(), 8 * 50);
    assert!(
        revisions.windows(2).all(|pair| pair[0] < pair[1]),
        "updates arrive in revision order"
    );
    common::check_invariants(&store.snapshot());
}

#[test]
fn a_store_saves_after_a_pause_and_reopens_to_the_same_session() {
    let dir = tempfile::tempdir().unwrap();
    let (store, report) =
        BrowserStore::open(DataDir::new(dir.path()), LoadOptions::default()).unwrap();
    assert_eq!(report.source, SessionSource::Fresh);
    let window = open_window(&store);
    new_tab(&store, &window, "kept.com");
    assert!(store.has_unsaved_changes());
    assert!(
        !dir.path().join(SESSION).exists(),
        "nothing is written before the pause"
    );
    assert!(store.flush(Duration::from_secs(5)));
    assert!(!store.has_unsaved_changes());
    assert_eq!(store.saves(), 1, "both changes share one write");
    assert_eq!(store.last_save_error(), None);
    let saved = store.snapshot().session_json();
    drop(store);
    let (again, report) =
        BrowserStore::open(DataDir::new(dir.path()), LoadOptions::default()).unwrap();
    assert_eq!(report.source, SessionSource::Primary);
    assert_eq!(again.snapshot().session_json(), saved);
    assert!(
        dir.path().join("session-backup-1.json").exists(),
        "the first save of the day leaves a backup"
    );
}

#[test]
fn quitting_writes_what_is_still_pending() {
    let dir = tempfile::tempdir().unwrap();
    let (store, _) = BrowserStore::open(DataDir::new(dir.path()), LoadOptions::default()).unwrap();
    let window = open_window(&store);
    let tab = new_tab(&store, &window, "cosmetic.com");
    store.flush(Duration::from_secs(5));
    store
        .dispatch(Action::UpdatePage {
            tab,
            update: PageUpdate {
                title: Some("Only a title".into()),
                ..PageUpdate::default()
            },
        })
        .unwrap();
    assert!(
        store.has_unsaved_changes(),
        "a title waits for the long cosmetic pause"
    );
    drop(store);
    let text = std::fs::read_to_string(dir.path().join(SESSION)).unwrap();
    assert!(text.contains("Only a title"));
}

#[test]
fn live_only_changes_never_touch_the_disk() {
    let dir = tempfile::tempdir().unwrap();
    let (store, _) = BrowserStore::open(DataDir::new(dir.path()), LoadOptions::default()).unwrap();
    let window = open_window(&store);
    let tab = new_tab(&store, &window, "a.com");
    store.flush(Duration::from_secs(5));
    let saves = store.saves();
    for i in 0..20 {
        store
            .dispatch(Action::UpdatePage {
                tab: tab.clone(),
                update: PageUpdate {
                    progress: Some(i as f32 / 20.0),
                    loading: Some(true),
                    ..PageUpdate::default()
                },
            })
            .unwrap();
    }
    store
        .dispatch(Action::SetSidebarPeeking {
            window,
            peeking: true,
        })
        .unwrap();
    assert!(!store.has_unsaved_changes());
    assert!(store.flush(Duration::from_secs(1)));
    assert_eq!(store.saves(), saves);
}

#[test]
fn a_folder_that_cannot_be_written_reports_instead_of_crashing() {
    let dir = tempfile::tempdir().unwrap();
    let blocked = dir.path().join("not-a-folder");
    std::fs::write(&blocked, b"a file where the data folder should be").unwrap();
    let (store, report) =
        BrowserStore::open(DataDir::new(&blocked), LoadOptions::default()).unwrap();
    assert_eq!(report.source, SessionSource::Fresh);
    open_window(&store);
    assert!(!store.flush(Duration::from_secs(5)));
    assert!(
        store
            .last_save_error()
            .is_some_and(|e| e.starts_with("session"))
    );
    assert!(store.has_unsaved_changes(), "the change waits for a retry");
}

#[test]
fn replacing_the_state_tells_everyone_and_saves() {
    let dir = tempfile::tempdir().unwrap();
    let (store, _) = BrowserStore::open(DataDir::new(dir.path()), LoadOptions::default()).unwrap();
    let heard = Arc::new(AtomicUsize::new(0));
    let n = Arc::clone(&heard);
    let _sub = store.subscribe(Interest::Topics(Topics::PROFILES), move |_| {
        n.fetch_add(1, Ordering::SeqCst);
    });
    let mut next = (*store.snapshot()).clone();
    next.apply(
        Action::CreateProfile {
            name: "Work".into(),
            color: None,
            icon: None,
        },
        common::T0,
        store.ids(),
    )
    .unwrap();
    store.replace(next);
    assert_eq!(heard.load(Ordering::SeqCst), 1);
    assert!(store.flush(Duration::from_secs(5)));
    assert!(
        std::fs::read_to_string(dir.path().join(SESSION))
            .unwrap()
            .contains("\"Work\"")
    );
}

#[test]
fn reading_and_dispatching_from_inside_callbacks_never_deadlocks() {
    let store = Arc::new(memory_store());
    let window = open_window(&store);
    let opened = store.read(|state| {
        let _ = state;
        store.dispatch(Action::NewTab {
            window: window.clone(),
            tab: NewTab::default(),
        })
    });
    assert!(opened.is_ok());
    let inner = Arc::new(Mutex::new(None));
    let held = Arc::clone(&inner);
    let outer = store.subscribe(Interest::Topics(Topics::ALL), move |_| {
        let _ = &held;
    });
    *inner.lock() = Some(store.subscribe(Interest::Topics(Topics::ALL), |_| {}));
    let owner = Arc::clone(&inner);
    let nesting = store.subscribe(Interest::Topics(Topics::ALL), move |_| {
        let _ = &owner;
    });
    drop(inner);
    drop(nesting);
    drop(outer);
    store
        .dispatch(Action::NewTab {
            window,
            tab: NewTab::default(),
        })
        .unwrap();
}

#[test]
fn a_change_is_waiting_to_be_saved_before_anyone_hears_of_it() {
    let dir = tempfile::tempdir().unwrap();
    let (store, _) = BrowserStore::open(DataDir::new(dir.path()), LoadOptions::default()).unwrap();
    let store = Arc::new(store);
    let unsaved_when_heard = Arc::new(Mutex::new(Vec::new()));
    let log = Arc::clone(&unsaved_when_heard);
    let weak = Arc::downgrade(&store);
    let _sub = store.subscribe(Interest::Topics(Topics::SESSION), move |_| {
        if let Some(store) = weak.upgrade() {
            log.lock().push(store.has_unsaved_changes());
        }
    });
    let window = open_window(&store);
    new_tab(&store, &window, "a.com");
    assert!(!unsaved_when_heard.lock().is_empty());
    assert!(unsaved_when_heard.lock().iter().all(|unsaved| *unsaved));
    assert!(store.flush(Duration::from_secs(5)));
}
