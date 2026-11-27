mod common;

use ardia_state::actions::{Action, NewTab};
use ardia_state::persistence::DataDir;
use ardia_state::persistence::session::{LoadOptions, SESSION, SessionSource};
use ardia_state::store::load_state;
use common::{World, assert_same_document, check_invariants, data_dir_with};
use serde_json::{Value, json};
use std::path::Path;

const FIXTURE: &str = include_str!("fixtures/session-v11.json");
const NOW: i64 = 1_795_660_000_000;
const REAL_PROFILE: &str = "/tmp/webui-real-profile-copy";

fn fixture() -> Value {
    serde_json::from_str(FIXTURE).expect("the fixture is JSON")
}

fn load(
    doc: &Value,
) -> (
    ardia_state::state::BrowserState,
    ardia_state::persistence::session::LoadReport,
    tempfile::TempDir,
) {
    let bytes = serde_json::to_vec(doc).unwrap();
    let (dir, data) = data_dir_with(&[(SESSION, &bytes)]);
    let (state, report, _) = load_state(&data, LoadOptions::default(), NOW);
    (state, report, dir)
}

#[test]
fn a_real_shaped_session_loads_whole_and_saves_back_unchanged() {
    let doc = fixture();
    let (state, report, _dir) = load(&doc);
    assert_eq!(report.source, SessionSource::Primary);
    assert_eq!(report.dropped_rows, 0);
    assert_eq!(report.from_version, Some(11));
    assert_eq!(state.windows.len(), 1);
    assert_eq!(state.tabs.len(), doc["tabs"].as_array().unwrap().len());
    assert_eq!(state.groups.len(), 9);
    assert_eq!(state.profiles.len(), 4);
    assert!(
        state
            .groups
            .values()
            .filter(|g| g.parent_id.is_some())
            .count()
            >= 5,
        "nested pinned groups survive"
    );
    check_invariants(&state);
    assert_same_document(&doc, &state.to_session_value());
}

#[test]
fn table_shaped_rows_stay_tables() {
    let mut doc = fixture();
    for key in ["windows", "tabs", "groups", "splits"] {
        let rows = doc[key].as_array().unwrap().clone();
        doc[key] = Value::Object(
            rows.into_iter()
                .map(|row| (row["id"].as_str().unwrap().to_owned(), row))
                .collect(),
        );
    }
    let (state, report, _dir) = load(&doc);
    assert_eq!(report.dropped_rows, 0);
    assert!(state.persisted.row_tables);
    assert_same_document(&doc, &state.to_session_value());
}

#[test]
fn unknown_fields_from_newer_builds_survive_a_save() {
    let mut doc = fixture();
    doc["futureTopLevel"] = json!({"keep": [1, 2, 3]});
    doc["tabs"][0]["futureTabField"] = json!("kept");
    doc["windows"][0]["futureWindowField"] = json!({"nested": true});
    doc["groups"][0]["futureGroupField"] = json!(7);
    doc["profiles"]["default"]["futureProfileField"] = json!(null);
    doc["settings"]["futureSetting"] = json!("on");
    doc["closedTabs"][0]["tab"]["futureSnapshotField"] = json!(1.5);
    let (state, report, _dir) = load(&doc);
    assert_eq!(report.dropped_rows, 0);
    assert_same_document(&doc, &state.to_session_value());
}

#[test]
fn missing_fields_take_their_defaults() {
    let doc = json!({
        "version": 11,
        "windows": [{"id": "w-1", "profileId": "default", "tabIds": ["tab-1", "tab-2"], "activeTabIds": {}}, {"id": "w-2", "tabIds": ["tab-3"]}],
        "tabs": [
            {"id": "tab-1", "windowId": "w-1", "profileId": "default", "url": "https://a.example/"},
            {"id": "tab-2", "windowId": "w-1", "profileId": "default", "url": ""},
            {"id": "tab-3", "windowId": "w-2", "profileId": "default", "url": ""}
        ]
    });
    let (state, report, _dir) = load(&doc);
    assert_eq!(
        report.dropped_rows, 2,
        "the refused window row and the tab it took along both count as lost"
    );
    assert!(
        !state.tabs.contains_key("tab-3"),
        "tabs of a refused window go with it"
    );
    let w = &state.windows["w-1"];
    assert_eq!(w.tab_ids.len(), 2);
    assert_eq!(
        state.active_tab("w-1").map(|t| t.id.as_str()),
        Some("tab-1")
    );
    assert_eq!(state.tabs["tab-1"].zoom, 1.0);
    assert_eq!(state.profiles.len(), 1);
    check_invariants(&state);
}

#[test]
fn hostile_rows_are_dropped_one_by_one() {
    let mut doc = fixture();
    let window = doc["windows"][0]["id"].clone();
    let tabs = doc["tabs"].as_array_mut().unwrap();
    let good = tabs.len();
    tabs.push(json!({"id": "__proto__", "windowId": window, "profileId": "default", "url": ""}));
    tabs.push(json!({"id": "tab-x", "windowId": 7, "profileId": "default", "url": ""}));
    tabs.push(json!({"id": "tab-y", "profileId": "default", "url": ["not", "a", "string"]}));
    tabs.push(json!("just a string"));
    doc["profiles"]["constructor"] = json!({"id": "constructor", "name": "evil"});
    doc["windowOrder"] = json!(["__proto__", 12, null]);
    doc["closedTabs"]
        .as_array_mut()
        .unwrap()
        .push(json!({"kind": "tab", "id": 5}));
    let (state, report, _dir) = load(&doc);
    assert_eq!(report.dropped_rows, 6);
    assert_eq!(state.tabs.len(), good);
    assert!(!state.profiles.contains_key("constructor"));
    check_invariants(&state);
}

#[test]
fn nonsense_values_inside_good_rows_fall_back_quietly() {
    let mut doc = fixture();
    doc["tabs"][0]["zoom"] = json!("huge");
    doc["tabs"][0]["muted"] = json!("yes");
    doc["tabs"][0]["lastActiveAt"] = json!(-1e308);
    doc["windows"][0]["frame"] = json!([0, 0, -5, "tall"]);
    doc["settings"]["sidebarWidth"] = json!("1e309");
    doc["settings"]["tabLayout"] = json!({"nested": "object"});
    let (state, report, _dir) = load(&doc);
    assert_eq!(report.dropped_rows, 0);
    let first = doc["tabs"][0]["id"].as_str().unwrap();
    assert_eq!(state.tabs[first].zoom, 1.0);
    assert!(!state.tabs[first].muted);
    assert_eq!(state.windows.values().next().unwrap().frame, None);
    assert_eq!(
        state.settings.sidebar_width,
        ardia_state::settings::Settings::default().sidebar_width
    );
    check_invariants(&state);
}

#[test]
fn sessions_survive_actions_and_a_reload() {
    let doc = fixture();
    let (state, _, _dir) = load(&doc);
    let mut w = World::from_state(state);
    let win = w.state.window_order[0].clone();
    let tab = w
        .act(Action::NewTab {
            window: win.clone(),
            tab: NewTab {
                url: Some("rust lang".into()),
                ..NewTab::default()
            },
        })
        .tab
        .unwrap();
    w.close(&[&tab]);
    w.act(Action::ReopenClosed {
        window: Some(win.clone()),
    });
    let pinned = w.order(&win)[0].clone();
    w.act(Action::ActivateTab { tab: pinned });
    check_invariants(&w.state);
    let again = common::reloaded(&w.state, NOW + 1);
    check_invariants(&again);
    assert_eq!(
        again.session_json(),
        common::reloaded(&again, NOW + 2).session_json()
    );
}

fn copy_real_profile(names: &[&str]) -> Option<(tempfile::TempDir, DataDir)> {
    let source = Path::new(REAL_PROFILE);
    if !source.join(SESSION).exists() {
        eprintln!("skipping: no real profile copy at {REAL_PROFILE}");
        return None;
    }
    let dir = tempfile::tempdir().unwrap();
    for name in names {
        if source.join(name).exists() {
            std::fs::copy(source.join(name), dir.path().join(name)).unwrap();
        }
    }
    let data = DataDir::new(dir.path());
    Some((dir, data))
}

#[test]
fn the_owners_real_profile_round_trips_when_present() {
    let Some((_dir, data)) = copy_real_profile(&[
        SESSION,
        "downloads.json",
        "bookmarks-cache.json",
        "air-traffic.json",
    ]) else {
        return;
    };
    let original: Value =
        serde_json::from_slice(&std::fs::read(data.root().join(SESSION)).unwrap()).unwrap();
    let (state, report, _) = load_state(&data, LoadOptions::default(), NOW);
    assert_eq!(report.source, SessionSource::Primary);
    assert_eq!(report.dropped_rows, 0);
    check_invariants(&state);
    assert_same_document(&original, &state.to_session_value());
    let downloads: Value =
        serde_json::from_slice(&std::fs::read(data.root().join("downloads.json")).unwrap())
            .unwrap();
    assert_eq!(
        state.downloads.len(),
        downloads["downloads"].as_array().map_or(0, Vec::len)
    );
    let mut w = World::from_state(state);
    let win = w.state.window_order[0].clone();
    for _ in 0..20 {
        w.act(Action::CycleTab {
            window: win.clone(),
            delta: 1,
        });
    }
    w.act(Action::ClearUnpinned {
        window: win.clone(),
    });
    if w.state.cleared.contains_key(&win) {
        w.act(Action::UndoClear { window: win });
    }
    check_invariants(&w.state);
}

#[test]
fn a_clear_that_closes_nothing_leaves_nothing_to_undo() {
    let mut w = World::new();
    let win = w.open();
    w.act(Action::ClearUnpinned {
        window: win.clone(),
    });
    assert!(!w.state.cleared.contains_key(&win));
    assert!(w.try_act(Action::UndoClear { window: win }).is_err());
    check_invariants(&w.state);
}

#[test]
fn the_owners_backup_restores_a_broken_session_when_present() {
    let Some((_dir, data)) = copy_real_profile(&["session-backup-1.json"]) else {
        return;
    };
    std::fs::write(data.root().join(SESSION), b"{\"version\": 11, \"tabs\": [").unwrap();
    let backup: Value =
        serde_json::from_slice(&std::fs::read(data.root().join("session-backup-1.json")).unwrap())
            .unwrap();
    let (state, report, _) = load_state(&data, LoadOptions::default(), NOW);
    assert!(
        matches!(report.source, SessionSource::Backup { .. }),
        "{report:?}"
    );
    assert_eq!(report.problem, Some("invalid"));
    assert_eq!(
        state.tabs.len(),
        backup["session"]["tabs"].as_array().map_or_else(
            || backup["session"]["tabs"].as_object().map_or(0, |o| o.len()),
            Vec::len
        )
    );
    check_invariants(&state);
}

#[test]
fn an_active_tab_dropped_as_an_orphan_falls_back_to_a_surviving_tab() {
    let mut doc = fixture();
    let window = doc["windows"][0]["id"].as_str().unwrap().to_owned();
    let profile = doc["windows"][0]["profileId"].as_str().unwrap().to_owned();
    doc["tabs"].as_array_mut().unwrap().push(json!({
        "id": "tab-orphan",
        "windowId": window,
        "profileId": profile,
        "url": "https://example.com/",
    }));
    doc["windows"][0]["activeTabIds"][&profile] = json!("tab-orphan");
    doc["windows"][0]["activeTabIds"]["default"] = json!("tab-orphan");
    let (state, report, _dir) = load(&doc);
    assert_eq!(report.dropped_rows, 1);
    assert!(state.tab("tab-orphan").is_none());
    let w = state.window(&window).unwrap();
    let active = state
        .active_tab(&window)
        .expect("a surviving tab is active");
    assert_eq!(active.profile_id.as_str(), profile);
    assert!(w.tab_ids.contains(&active.id));
    for (p, t) in &w.active_tab_ids {
        let tab = state
            .tab(t.as_str())
            .expect("every remembered active tab survives");
        assert_eq!(&tab.profile_id, p);
        assert!(w.tab_ids.contains(t));
    }
    check_invariants(&state);
}
