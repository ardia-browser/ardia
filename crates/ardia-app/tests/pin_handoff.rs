use std::sync::Arc;

use ardia_app::{AppCoordinator, CoordinatorConfig};
use ardia_engine::{BrowserEngine, MockBrowserEngine};
use ardia_state::actions::Action;
use ardia_state::ids::IdGen;
use ardia_state::model::{PageKind, TabPage, TabPin};
use ardia_state::persistence::session::{LoadOptions, SessionData};
use ardia_state::tabs::Tab;
use ardia_state::windows::{BrowserWindow, WindowKind};
use ardia_state::{BrowserState, BrowserStore, TabId, WindowId};
use ardia_ui::UiHost;

fn shared_pin_state() -> (BrowserState, WindowId, WindowId) {
    let mut s = BrowserState::from_session(
        SessionData::fresh(LoadOptions::default()),
        1_795_000_000_000,
    );
    let ids = IdGen::with_launch("seed");
    let w1 = s
        .apply(
            Action::OpenWindow {
                kind: WindowKind::Main,
                profile: None,
                url: None,
                frame: None,
            },
            0,
            &ids,
        )
        .expect("a window opens")
        .window
        .expect("the new window");
    let profile = s.windows[&w1].profile_id.clone();
    let w2 = WindowId::new("w-second");
    let mut held = Tab::new(
        TabId::new("pin-a"),
        w1.clone(),
        profile.clone(),
        "https://mail.example.com/",
        10,
    );
    held.pin = Some(TabPin::TILE);
    held.title = "Mail".into();
    let mut copy = Tab::new(
        TabId::new("pin-b"),
        w2.clone(),
        profile.clone(),
        "https://mail.example.com/",
        0,
    );
    copy.pin = Some(TabPin::TILE);
    copy.pin_key = Some("pin-a".into());
    copy.page = TabPage::ASLEEP;
    let other = Tab::new(
        TabId::new("plain"),
        w2.clone(),
        profile.clone(),
        "https://x.example.com/",
        0,
    );
    let tabs = Arc::make_mut(&mut s.tabs);
    for t in [held, copy, other] {
        tabs.insert(t.id.clone(), Arc::new(t));
    }
    let mut first = (*s.windows[&w1]).clone();
    first.tab_ids.insert(0, TabId::new("pin-a"));
    first
        .active_tab_ids
        .insert(profile.clone(), TabId::new("pin-a"));
    let mut second = BrowserWindow::new(w2.clone(), WindowKind::Main, profile.clone(), 0);
    second.tab_ids = vec![TabId::new("pin-b"), TabId::new("plain")];
    second.active_tab_ids.insert(profile, TabId::new("plain"));
    let windows = Arc::make_mut(&mut s.windows);
    windows.insert(w1.clone(), Arc::new(first));
    windows.insert(w2.clone(), Arc::new(second));
    Arc::make_mut(&mut s.window_order).push(w2.clone());
    Arc::make_mut(&mut s.focus_order).push(w2.clone());
    (s, w1, w2)
}

fn pump(app: &AppCoordinator) {
    for _ in 0..16 {
        app.poll_parked();
        if app.pump().rounds == 0 && app.poll_parked() == 0 {
            break;
        }
    }
}

#[test]
fn activating_a_pinned_copy_moves_the_live_page_and_freezes_the_other_window() {
    let (state, w1, w2) = shared_pin_state();
    let store = Arc::new(BrowserStore::in_memory(state, IdGen::with_launch("pin")));
    let engine = Arc::new(MockBrowserEngine::started());
    let shared: Arc<dyn BrowserEngine> = engine;
    let app = AppCoordinator::new(store, shared, CoordinatorConfig::default());
    app.set_waker(|| {});
    app.start();
    pump(&app);
    let live = app
        .engine_tab(&TabId::new("pin-a"))
        .expect("the pin has a page");
    assert!(app.engine_tab(&TabId::new("pin-b")).is_none());

    app.dispatch(Action::ActivateTab {
        tab: TabId::new("pin-b"),
    });
    pump(&app);

    let s = app.store().snapshot();
    assert_eq!(s.tabs[&TabId::new("pin-a")].window_id, w2);
    assert_eq!(
        s.active_tab(w2.as_str()).map(|t| t.id.as_str()),
        Some("pin-a")
    );
    assert_eq!(s.tabs[&TabId::new("pin-b")].window_id, w1);
    assert_eq!(
        s.tabs[&TabId::new("pin-b")].page.kind,
        PageKind::Frozen {
            holder: TabId::new("pin-a")
        }
    );
    assert_eq!(app.engine_tab(&TabId::new("pin-a")), Some(live));
    assert!(
        app.engine_tab(&TabId::new("pin-b")).is_none(),
        "a frozen copy never opens its own page"
    );
    assert!(app.frozen_picture(&w2).is_none());
}
