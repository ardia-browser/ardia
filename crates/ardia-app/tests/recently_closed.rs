use std::sync::Arc;

use ardia_app::{AppCoordinator, CoordinatorConfig};
use ardia_engine::{BrowserEngine, MockBrowserEngine};
use ardia_state::actions::{Action, NewTab, PageUpdate};
use ardia_state::ids::IdGen;
use ardia_state::persistence::session::{LoadOptions, SessionData};
use ardia_state::windows::WindowKind;
use ardia_state::{BrowserState, BrowserStore, TabId, WindowId};

fn coordinator() -> Arc<AppCoordinator> {
    let store = Arc::new(BrowserStore::in_memory(
        BrowserState::from_session(
            SessionData::fresh(LoadOptions::default()),
            1_795_000_000_000,
        ),
        IdGen::with_launch("closed"),
    ));
    let engine: Arc<dyn BrowserEngine> = Arc::new(MockBrowserEngine::started());
    let app = AppCoordinator::new(store, engine, CoordinatorConfig::default());
    app.set_waker(|| {});
    app.start();
    pump(&app);
    app
}

fn pump(app: &AppCoordinator) {
    for _ in 0..12 {
        if app.pump().rounds == 0 {
            break;
        }
    }
}

fn windows(app: &AppCoordinator, kind: WindowKind) -> Vec<WindowId> {
    let state = app.store().snapshot();
    state
        .window_order
        .iter()
        .filter(|id| state.window(id.as_str()).is_some_and(|w| w.kind == kind))
        .cloned()
        .collect()
}

fn titled_tab(app: &AppCoordinator, window: &WindowId, url: &str, title: &str) -> TabId {
    let tab = app
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
    app.dispatch_action(Action::UpdatePage {
        tab: tab.clone(),
        update: PageUpdate {
            url: Some(url.into()),
            title: Some(title.into()),
            ..PageUpdate::default()
        },
    })
    .unwrap();
    pump(app);
    tab
}

fn focus(app: &AppCoordinator, window: &WindowId) {
    app.dispatch_action(Action::FocusWindow {
        window: window.clone(),
    })
    .unwrap();
    pump(app);
}

fn close(app: &AppCoordinator, tab: &TabId) {
    app.dispatch_action(Action::CloseTabs {
        tabs: vec![tab.clone()],
        last_closes_window: false,
    })
    .unwrap();
    pump(app);
}

fn listed(app: &AppCoordinator) -> Vec<String> {
    app.recently_closed()
        .into_iter()
        .map(|(id, _)| id.to_string())
        .collect()
}

fn closed_entry(app: &AppCoordinator, url: &str) -> String {
    app.store()
        .snapshot()
        .closed
        .tabs
        .iter()
        .find(|closed| closed.tab.url == url)
        .map(|closed| closed.id.to_string())
        .unwrap_or_else(|| panic!("{url} is kept for undo"))
}

#[test]
fn private_tabs_stay_out_of_other_windows_recently_closed() {
    let app = coordinator();
    let regular = windows(&app, WindowKind::Main)[0].clone();
    app.dispatch_action(Action::OpenWindow {
        kind: WindowKind::Incognito,
        profile: None,
        url: Some("https://private-keep.example/".into()),
        frame: None,
    })
    .unwrap();
    pump(&app);
    let private = windows(&app, WindowKind::Incognito)[0].clone();
    let secret = titled_tab(&app, &private, "https://secret.example/", "Secret Page");
    let public = titled_tab(&app, &regular, "https://public.example/", "Public Page");
    close(&app, &secret);
    close(&app, &public);
    let secret_entry = closed_entry(&app, "https://secret.example/");
    let public_entry = closed_entry(&app, "https://public.example/");

    focus(&app, &regular);
    let shown = listed(&app);
    assert!(shown.contains(&public_entry), "{shown:?}");
    assert!(
        !shown.contains(&secret_entry),
        "a private tab leaked into a regular window's menu: {shown:?}"
    );
    assert!(
        app.run_command("restoreClosed", Some(secret_entry.as_str()))
            .is_err()
    );
    pump(&app);
    let state = app.store().snapshot();
    assert!(
        state
            .tabs
            .values()
            .all(|tab| tab.url != "https://secret.example/"),
        "a private entry reopened from another window"
    );

    focus(&app, &private);
    let shown = listed(&app);
    assert!(
        !shown.contains(&secret_entry),
        "private tabs are never listed, as in the old app: {shown:?}"
    );
    assert!(
        shown.contains(&public_entry),
        "a private window lists every profile's closed tabs, as in the old app: {shown:?}"
    );
}

#[test]
fn private_windows_are_never_listed() {
    let app = coordinator();
    let regular = windows(&app, WindowKind::Main)[0].clone();
    app.dispatch_action(Action::OpenWindow {
        kind: WindowKind::Incognito,
        profile: None,
        url: Some("https://private-window.example/".into()),
        frame: None,
    })
    .unwrap();
    pump(&app);
    let private = windows(&app, WindowKind::Incognito)[0].clone();
    titled_tab(&app, &private, "https://hidden.example/", "Hidden");
    app.dispatch_action(Action::CloseWindow { window: private })
        .unwrap();
    pump(&app);
    focus(&app, &regular);
    let state = app.store().snapshot();
    let private_windows: Vec<String> = state
        .closed
        .windows
        .iter()
        .filter(|closed| {
            closed
                .window
                .profile_id
                .as_ref()
                .is_some_and(|profile| profile.is_incognito())
        })
        .map(|closed| closed.id.to_string())
        .collect();
    let listed: Vec<String> = app
        .recently_closed()
        .into_iter()
        .map(|(id, _)| id.to_string())
        .collect();
    assert!(
        private_windows.iter().all(|id| !listed.contains(id)),
        "{listed:?}"
    );
}
