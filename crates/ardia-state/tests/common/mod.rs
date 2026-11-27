#![allow(dead_code)]

use ardia_state::actions::{Action, ActionError, NewTab, Outcome};
use ardia_state::ids::{IdGen, ProfileId, TabId, WindowId};
use ardia_state::model::Millis;
use ardia_state::persistence::session::{LoadOptions, SessionData, session_from_doc};
use ardia_state::state::BrowserState;
use ardia_state::windows::WindowKind;
use std::collections::HashSet;

pub const T0: Millis = 1_795_624_452_665;

pub struct World {
    pub state: BrowserState,
    pub ids: IdGen,
    pub now: Millis,
}

impl World {
    pub fn new() -> World {
        World {
            state: BrowserState::from_session(SessionData::fresh(LoadOptions::default()), T0),
            ids: IdGen::with_launch("test"),
            now: T0,
        }
    }

    pub fn from_state(state: BrowserState) -> World {
        World {
            state,
            ids: IdGen::with_launch("test"),
            now: T0,
        }
    }

    pub fn try_act(&mut self, action: Action) -> Result<Outcome, ActionError> {
        self.now += 1_000;
        self.state.apply(action, self.now, &self.ids)
    }

    pub fn act(&mut self, action: Action) -> Outcome {
        let shown = format!("{action:?}");
        self.try_act(action)
            .unwrap_or_else(|e| panic!("{shown} failed: {e}"))
    }

    pub fn open(&mut self) -> WindowId {
        self.act(Action::OpenWindow {
            kind: WindowKind::Main,
            profile: None,
            url: None,
            frame: None,
        })
        .window
        .expect("a window")
    }

    pub fn open_tab(&mut self, window: &WindowId, url: &str) -> TabId {
        self.act(Action::NewTab {
            window: window.clone(),
            tab: NewTab {
                url: Some(url.into()),
                ..NewTab::default()
            },
        })
        .tab
        .expect("a tab")
    }

    pub fn open_child(
        &mut self,
        window: &WindowId,
        opener: &TabId,
        url: &str,
        background: bool,
    ) -> TabId {
        let tab = NewTab {
            url: Some(url.into()),
            opener: Some(opener.clone()),
            background,
            ..NewTab::default()
        };
        self.act(Action::NewTab {
            window: window.clone(),
            tab,
        })
        .tab
        .expect("a tab")
    }

    pub fn urls(&self, window: &WindowId) -> Vec<String> {
        self.state
            .view_tabs(window.as_str(), None)
            .iter()
            .map(|t| t.url.clone())
            .collect()
    }

    pub fn order(&self, window: &WindowId) -> Vec<TabId> {
        self.state.windows[window].tab_ids.clone()
    }

    pub fn active(&self, window: &WindowId) -> TabId {
        self.state
            .active_tab(window.as_str())
            .map(|t| t.id.clone())
            .expect("an active tab")
    }

    pub fn active_url(&self, window: &WindowId) -> String {
        self.state
            .active_tab(window.as_str())
            .map(|t| t.url.clone())
            .expect("an active tab")
    }

    pub fn default_profile(&self) -> ProfileId {
        self.state.profile_order[0].clone()
    }

    pub fn close(&mut self, tabs: &[&TabId]) -> Outcome {
        self.act(Action::CloseTabs {
            tabs: tabs.iter().map(|t| (*t).clone()).collect(),
            last_closes_window: false,
        })
    }
}

pub fn reloaded(state: &BrowserState, now: Millis) -> BrowserState {
    let doc = match state.to_session_value() {
        serde_json::Value::Object(doc) => doc,
        other => panic!("session is not an object: {other}"),
    };
    let (data, dropped) = session_from_doc(doc, LoadOptions::default());
    assert_eq!(dropped, 0, "a saved session dropped rows on reload");
    BrowserState::from_session(data, now)
}

pub fn check_invariants(state: &BrowserState) {
    let mut placed: HashSet<&TabId> = HashSet::new();
    for (id, w) in state.windows.iter() {
        assert_eq!(&w.id, id);
        for t in &w.tab_ids {
            let tab = state
                .tabs
                .get(t)
                .unwrap_or_else(|| panic!("window {id} lists missing tab {t}"));
            assert_eq!(
                &tab.window_id, id,
                "tab {t} thinks it lives in {}",
                tab.window_id
            );
            assert!(placed.insert(t), "tab {t} is listed twice");
            assert!(!tab.live.peek, "peek tab {t} sits in the tab strip");
        }
        for (profile, active) in &w.active_tab_ids {
            let tab = state
                .tabs
                .get(active)
                .unwrap_or_else(|| panic!("window {id} activates missing tab {active}"));
            assert_eq!(
                &tab.profile_id, profile,
                "active tab {active} belongs to another profile"
            );
            assert_eq!(&tab.window_id, id);
        }
        if w.kind.has_tabs() {
            assert!(!w.tab_ids.is_empty(), "window {id} has no tabs");
            assert!(
                state.active_tab(id.as_str()).is_some(),
                "window {id} shows no tab"
            );
        }
        if w.kind == WindowKind::Incognito {
            assert!(w.profile_id.is_incognito());
        }
        let mut seen_regular = false;
        for t in &w.tab_ids {
            let pinned = state.in_pinned_container(t.as_str());
            if !pinned && state.tabs[t].profile_id == w.profile_id {
                seen_regular = true;
            }
            assert!(
                !(pinned && seen_regular && state.tabs[t].profile_id == w.profile_id),
                "pinned tab {t} sits below regular tabs in {id}"
            );
        }
        if let Some(peek) = &w.chrome.peek {
            assert!(
                state.tabs.get(&peek.tab_id).is_some_and(|t| t.live.peek),
                "window {id} peeks at a missing tab"
            );
            if let Some(source) = &peek.source_tab_id {
                assert!(
                    w.tab_ids.contains(source),
                    "window {id} peeks from a tab that isn't in it"
                );
            }
        }
    }
    for (id, tab) in state.tabs.iter() {
        assert!(
            placed.contains(id) || tab.live.peek,
            "tab {id} is in no window"
        );
        assert!(state.windows.contains_key(&tab.window_id));
        assert!(
            state.profiles.contains_key(&tab.profile_id) || tab.profile_id.is_incognito(),
            "tab {id} has unknown profile {}",
            tab.profile_id
        );
    }
    let mut in_split: HashSet<TabId> = HashSet::new();
    for (id, split) in state.splits.iter() {
        let panes = split.tab_ids();
        assert!(
            (2..=4).contains(&panes.len()),
            "split {id} has {} panes",
            panes.len()
        );
        let first = &state.tabs[&panes[0]];
        for p in &panes {
            let tab = state
                .tabs
                .get(p)
                .unwrap_or_else(|| panic!("split {id} holds missing tab {p}"));
            assert_eq!(tab.window_id, split.window_id);
            assert_eq!(tab.profile_id, first.profile_id);
            assert!(in_split.insert(p.clone()), "tab {p} is in two splits");
        }
        let order = &state.windows[&split.window_id].tab_ids;
        let members = ardia_state::groups::pinned_group_members(&state.groups);
        for rank in [1, 2] {
            let mut at: Vec<usize> = panes
                .iter()
                .filter(|p| ardia_state::state::section_rank(&state.tabs[*p], &members) == rank)
                .map(|p| order.iter().position(|t| t == p).expect("pane in strip"))
                .collect();
            at.sort_unstable();
            if let (Some(first), Some(last)) = (at.first(), at.last()) {
                assert_eq!(
                    last - first + 1,
                    at.len(),
                    "split {id} panes are not side by side"
                );
            }
        }
    }
    for (id, group) in state.groups.iter() {
        assert!(!group.tab_ids.is_empty(), "group {id} is empty");
        for t in &group.tab_ids {
            let tab = state
                .tabs
                .get(t)
                .unwrap_or_else(|| panic!("group {id} holds missing tab {t}"));
            assert_eq!(tab.window_id, group.window_id);
            assert!(tab.pin.is_none(), "pinned tab {t} is in group {id}");
        }
        if let Some(parent) = &group.parent_id {
            let p = state
                .groups
                .get(parent)
                .unwrap_or_else(|| panic!("group {id} has missing parent {parent}"));
            assert!(
                group.tab_ids.iter().all(|t| p.tab_ids.contains(t)),
                "parent {parent} lacks tabs of {id}"
            );
            assert_eq!(
                p.pinned, group.pinned,
                "nested group {id} disagrees with its parent about pinning"
            );
        }
    }
    for tab in state.tabs.keys() {
        let holders: Vec<&ardia_state::ids::GroupId> = state
            .groups
            .values()
            .filter(|g| g.tab_ids.contains(tab))
            .map(|g| &g.id)
            .collect();
        if let Some(deepest) = holders
            .iter()
            .max_by_key(|g| ardia_state::groups::depth(&state.groups, g.as_str()))
        {
            let chain = ardia_state::groups::ancestors(&state.groups, deepest.as_str());
            assert!(
                holders.iter().all(|g| g == deepest || chain.contains(g)),
                "tab {tab} sits in unrelated groups {holders:?}"
            );
        }
    }
    for id in state.window_order.iter() {
        assert!(state.windows.contains_key(id));
    }
    for id in state.focus_order.iter() {
        assert!(state.windows.contains_key(id));
    }
    assert_eq!(state.profile_order.len(), state.profiles.len());
}

pub fn differences(
    path: &str,
    was: &serde_json::Value,
    now: &serde_json::Value,
    out: &mut Vec<String>,
) {
    use serde_json::Value;
    match (was, now) {
        (Value::Object(a), Value::Object(b)) => {
            for (key, value) in a {
                match b.get(key) {
                    Some(other) => differences(&format!("{path}.{key}"), value, other, out),
                    None => out.push(format!("{path}.{key} was dropped")),
                }
            }
            for key in b.keys().filter(|k| !a.contains_key(*k)) {
                out.push(format!("{path}.{key} was added"));
            }
        }
        (Value::Array(a), Value::Array(b)) if a.len() == b.len() => {
            for (i, (value, other)) in a.iter().zip(b).enumerate() {
                differences(&format!("{path}[{i}]"), value, other, out);
            }
        }
        _ if was == now => {}
        _ => out.push(format!("{path}: {was} became {now}")),
    }
}

pub fn assert_same_document(was: &serde_json::Value, now: &serde_json::Value) {
    let mut out = Vec::new();
    differences("$", was, now, &mut out);
    assert!(
        out.is_empty(),
        "the saved session differs:\n{}",
        out.iter().take(40).cloned().collect::<Vec<_>>().join("\n")
    );
}

pub fn data_dir_with(
    files: &[(&str, &[u8])],
) -> (tempfile::TempDir, ardia_state::persistence::DataDir) {
    let dir = tempfile::tempdir().expect("a temp dir");
    for (name, bytes) in files {
        std::fs::write(dir.path().join(name), bytes).expect("a fixture file");
    }
    let data = ardia_state::persistence::DataDir::new(dir.path());
    (dir, data)
}
