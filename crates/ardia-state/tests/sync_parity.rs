use ardia_state::actions::{Action, NewTab, ProfilePatch};
use ardia_state::ids::IdGen;
use ardia_state::persistence::session::{LoadOptions, SessionData, session_from_doc};
use ardia_state::windows::WindowKind;
use ardia_state::{BrowserState, BrowserStore, ProfileId};
use serde_json::Value;

fn store() -> BrowserStore {
    BrowserStore::in_memory(
        BrowserState::from_session(
            SessionData::fresh(LoadOptions::default()),
            1_795_000_000_000,
        ),
        IdGen::with_launch("parity"),
    )
}

#[test]
fn a_tab_closed_by_another_mac_leaves_no_recently_closed_entry() {
    let store = store();
    let window = store
        .dispatch(Action::OpenWindow {
            kind: WindowKind::Main,
            profile: Some(ProfileId::new("default")),
            url: Some("https://a.example/".into()),
            frame: None,
        })
        .unwrap()
        .window
        .unwrap();
    let first = store
        .dispatch(Action::NewTab {
            window: window.clone(),
            tab: NewTab {
                url: Some("https://b.example/".into()),
                ..NewTab::default()
            },
        })
        .unwrap()
        .tab
        .unwrap();
    let second = store
        .dispatch(Action::NewTab {
            window: window.clone(),
            tab: NewTab {
                url: Some("https://c.example/".into()),
                ..NewTab::default()
            },
        })
        .unwrap()
        .tab
        .unwrap();
    store
        .dispatch(Action::CloseSyncedTabs {
            tabs: vec![first.clone()],
        })
        .unwrap();
    let state = store.snapshot();
    assert!(state.tab(first.as_str()).is_none());
    assert!(state.newest_closed(Some(&window)).is_none());
    store
        .dispatch(Action::CloseTabs {
            tabs: vec![second],
            last_closes_window: false,
        })
        .unwrap();
    assert!(store.snapshot().newest_closed(Some(&window)).is_some());
}

#[test]
fn going_back_to_a_preset_theme_is_remembered_and_saved_as_null() {
    let store = store();
    let profile = ProfileId::new("default");
    assert!(!store.snapshot().profiles[&profile].theme_cleared);
    store
        .dispatch(Action::UpdateProfile {
            profile: profile.clone(),
            patch: ProfilePatch {
                theme: Some(None),
                ..ProfilePatch::default()
            },
        })
        .unwrap();
    let state = store.snapshot();
    assert!(state.profiles[&profile].theme_cleared);
    let saved = state.to_session_value();
    assert_eq!(
        saved["profiles"]["default"].get("theme"),
        Some(&Value::Null)
    );
    let back = BrowserState::from_session(
        session_from_doc(
            saved.as_object().cloned().unwrap_or_default(),
            LoadOptions::default(),
        )
        .0,
        1,
    );
    assert!(back.profiles[&profile].theme_cleared);
    let untouched = store_value_without_theme();
    assert!(
        !BrowserState::from_session(
            session_from_doc(
                untouched.as_object().cloned().unwrap_or_default(),
                LoadOptions::default()
            )
            .0,
            1
        )
        .profiles[&profile]
            .theme_cleared
    );
}

fn store_value_without_theme() -> Value {
    store().snapshot().to_session_value()
}
