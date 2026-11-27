use std::collections::{HashMap, HashSet};

use indexmap::IndexMap;

use crate::group_names::{Member, site_key, site_name};
use crate::groups::{depth, innermost_group_of};
use crate::state::BrowserState;
use crate::tabs::Tab;
use crate::windows::WindowKind;
use crate::{GroupId, ProfileId, TabId, WindowId};

pub const TIDY_TABS_AFTER: usize = 6;

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum TidyScope {
    Pins,
    #[default]
    Tabs,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct TidyPlan {
    pub closes: Vec<(TabId, TabId)>,
    pub files: Vec<(TabId, GroupId)>,
    pub new_groups: Vec<(Vec<TabId>, String)>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Tidied {
    pub scope: TidyScope,
    pub window: WindowId,
    pub order: Vec<TabId>,
    pub moved: Vec<TabId>,
    pub homes: Vec<(TabId, Option<String>)>,
    pub closed: Vec<TabId>,
    pub groups: usize,
}

fn is_unpinned_tab(tab: Option<&Tab>) -> bool {
    tab.is_some_and(|t| t.pin.is_none() && t.live_item.is_none())
}

fn is_pinned_row(tab: Option<&Tab>) -> bool {
    tab.and_then(|t| t.pin.as_ref()).is_some_and(|p| p.is_row())
}

fn is_loose_in(state: &BrowserState, id: &TabId, scope: TidyScope) -> bool {
    let tab = state.tab(id.as_str()).map(|t| &**t);
    match scope {
        TidyScope::Pins => is_pinned_row(tab),
        TidyScope::Tabs => {
            is_unpinned_tab(tab) && innermost_group_of(&state.groups, id.as_str()).is_none()
        }
    }
}

pub fn split_row_panes(state: &BrowserState, id: &TabId) -> Vec<TabId> {
    let Some(split) = state.split_of(id.as_str()) else {
        return Vec::new();
    };
    let ids = split.tab_ids();
    let unpinned: Vec<TabId> = ids
        .iter()
        .filter(|t| state.tab(t.as_str()).is_some_and(|t| t.pin.is_none()))
        .cloned()
        .collect();
    if unpinned.len() >= 2 {
        return unpinned;
    }
    let rows: Vec<TabId> = ids
        .iter()
        .filter(|t| {
            state
                .tab(t.as_str())
                .and_then(|t| t.pin.as_ref())
                .is_some_and(|p| p.is_row())
        })
        .cloned()
        .collect();
    if rows.len() >= 2 { rows } else { Vec::new() }
}

pub fn with_split_rows(state: &BrowserState, ids: &[TabId]) -> Vec<TabId> {
    let mut out: Vec<TabId> = ids.to_vec();
    for id in ids {
        let panes = split_row_panes(state, id);
        if panes.contains(id) {
            for pane in panes {
                if !out.contains(&pane) {
                    out.push(pane);
                }
            }
        }
    }
    out
}

fn folders_of(
    state: &BrowserState,
    order: &[TabId],
    window: &WindowId,
    profile: &ProfileId,
    scope: TidyScope,
) -> Vec<GroupId> {
    let at: HashMap<&TabId, usize> = order.iter().enumerate().map(|(i, id)| (id, i)).collect();
    let mut folders: Vec<(usize, usize, GroupId)> = state
        .groups
        .values()
        .filter(|g| {
            g.pinned == (scope == TidyScope::Pins)
                && g.window_id == *window
                && g.profile_id == *profile
                && !g.tab_ids.is_empty()
        })
        .map(|g| {
            let top = g
                .tab_ids
                .iter()
                .map(|id| at.get(id).copied().unwrap_or(usize::MAX))
                .min()
                .unwrap_or(usize::MAX);
            (top, depth(&state.groups, g.id.as_str()), g.id.clone())
        })
        .collect();
    folders.sort_by_key(|(top, depth, _)| (*top, *depth));
    folders.into_iter().map(|(_, _, id)| id).collect()
}

fn folder_sites(state: &BrowserState, group: &GroupId) -> Vec<String> {
    let Some(g) = state.group(group.as_str()) else {
        return Vec::new();
    };
    let direct: Vec<&TabId> = g
        .tab_ids
        .iter()
        .filter(|id| {
            innermost_group_of(&state.groups, id.as_str()).as_ref() == Some(group)
                && state.tab(id.as_str()).is_some()
        })
        .collect();
    let mut counts: IndexMap<String, usize> = IndexMap::new();
    for id in &direct {
        if let Some(tab) = state.tab(id.as_str()) {
            let site = site_key(tab.pin_home());
            if !site.is_empty() {
                *counts.entry(site).or_default() += 1;
            }
        }
    }
    let most = counts.values().copied().max().unwrap_or(0);
    if most == 0 || most * 2 < direct.len() {
        return Vec::new();
    }
    counts
        .into_iter()
        .filter(|(_, n)| *n == most)
        .map(|(site, _)| site)
        .collect()
}

fn window_scope(
    state: &BrowserState,
    window: &str,
    profile: Option<&ProfileId>,
) -> Option<(WindowId, ProfileId, Vec<TabId>)> {
    let w = state.window(window)?;
    if w.kind != WindowKind::Main {
        return None;
    }
    let profile = profile.cloned().unwrap_or_else(|| w.profile_id.clone());
    let order: Vec<TabId> = w
        .tab_ids
        .iter()
        .filter(|id| {
            state
                .tab(id.as_str())
                .is_some_and(|t| t.profile_id == profile)
        })
        .cloned()
        .collect();
    Some((w.id.clone(), profile, order))
}

pub fn tidy_plan(
    state: &BrowserState,
    window: &str,
    profile: Option<&ProfileId>,
) -> Option<TidyPlan> {
    tidy_plan_in(state, window, profile, TidyScope::Tabs)
}

fn twin_of<'a>(home: &str, among: impl IntoIterator<Item = &'a Tab>) -> Option<TabId> {
    among
        .into_iter()
        .find(|t| !t.pin_home().is_empty() && crate::tabs::same_page_key(t.pin_home(), home))
        .map(|t| t.id.clone())
}

pub fn tidy_plan_in(
    state: &BrowserState,
    window: &str,
    profile: Option<&ProfileId>,
    scope: TidyScope,
) -> Option<TidyPlan> {
    let (window, profile, order) = window_scope(state, window, profile)?;
    let rows: Vec<TabId> = order
        .iter()
        .filter(|id| is_loose_in(state, id, scope))
        .cloned()
        .collect();
    if rows.is_empty() {
        return None;
    }
    let folders = folders_of(state, &order, &window, &profile, scope);
    let mut filed: Vec<&Tab> = Vec::new();
    for group in &folders {
        for id in state
            .group(group.as_str())
            .map(|g| g.tab_ids.clone())
            .unwrap_or_default()
        {
            if let Some(tab) = state.tab(id.as_str())
                && !filed.iter().any(|f| f.id == tab.id)
            {
                filed.push(tab);
            }
        }
    }
    let mut closes = Vec::new();
    let mut kept_rows: Vec<TabId> = Vec::new();
    for id in &rows {
        let Some(tab) = state.tab(id.as_str()) else {
            continue;
        };
        let home = tab.pin_home();
        let in_split_row = split_row_panes(state, id).contains(id);
        let twin = (scope == TidyScope::Pins && !home.is_empty() && !in_split_row)
            .then(|| {
                twin_of(home, filed.iter().copied()).or_else(|| {
                    twin_of(
                        home,
                        kept_rows
                            .iter()
                            .filter_map(|k| state.tab(k.as_str()).map(|t| &**t)),
                    )
                })
            })
            .flatten();
        match twin {
            Some(keeper) => closes.push((id.clone(), keeper)),
            None => kept_rows.push(id.clone()),
        }
    }
    let mut folder_for: HashMap<String, GroupId> = HashMap::new();
    for group in &folders {
        for site in folder_sites(state, group) {
            folder_for.entry(site).or_insert_with(|| group.clone());
        }
    }
    let kept: HashSet<&TabId> = kept_rows.iter().collect();
    let mut files = Vec::new();
    let mut loose: IndexMap<String, Vec<TabId>> = IndexMap::new();
    for id in &kept_rows {
        let panes = split_row_panes(state, id);
        if panes.contains(id) && panes.iter().find(|p| kept.contains(p)) != Some(id) {
            continue;
        }
        if scope == TidyScope::Tabs && panes.iter().any(|p| !is_loose_in(state, p, scope)) {
            continue;
        }
        let Some(tab) = state.tab(id.as_str()) else {
            continue;
        };
        let site = site_key(tab.pin_home());
        if site.is_empty() {
            continue;
        }
        match folder_for.get(&site) {
            Some(group) => files.push((id.clone(), group.clone())),
            None => loose.entry(site).or_default().push(id.clone()),
        }
    }
    let new_groups: Vec<(Vec<TabId>, String)> = loose
        .into_values()
        .filter(|same| same.len() >= 2)
        .map(|same| {
            let tabs: Vec<&Tab> = same
                .iter()
                .filter_map(|id| state.tab(id.as_str()).map(|t| &**t))
                .collect();
            let members: Vec<Member> = tabs
                .iter()
                .map(|t| Member {
                    url: t.pin_home(),
                    title: &t.title,
                })
                .collect();
            let name = site_name(&members);
            (same, name)
        })
        .collect();
    (!closes.is_empty() || !files.is_empty() || !new_groups.is_empty()).then_some(TidyPlan {
        closes,
        files,
        new_groups,
    })
}

pub fn can_tidy(state: &BrowserState, window: &str, profile: Option<&ProfileId>) -> bool {
    tidy_plan(state, window, profile).is_some()
}

pub fn can_tidy_pins(state: &BrowserState, window: &str) -> bool {
    tidy_plan_in(state, window, None, TidyScope::Pins).is_some()
}

fn unpinned_tab_count(state: &BrowserState, tab_ids: &[TabId], profile: &ProfileId) -> usize {
    let in_pinned_group = crate::groups::pinned_group_members(&state.groups);
    tab_ids
        .iter()
        .filter(|id| {
            state.tab(id.as_str()).is_some_and(|t| {
                t.profile_id == *profile
                    && is_unpinned_tab(Some(t))
                    && !in_pinned_group.contains(*id)
                    && !state.hidden_empty_card(t)
            })
        })
        .count()
}

pub fn offers_tidy_tabs(state: &BrowserState, window: &str, profile: Option<&ProfileId>) -> bool {
    let Some(w) = state.window(window) else {
        return false;
    };
    let profile = profile.unwrap_or(&w.profile_id);
    if unpinned_tab_count(state, &w.tab_ids, profile) <= TIDY_TABS_AFTER {
        return false;
    }
    can_tidy(state, window, Some(profile))
}

pub fn tidied_by(state: &BrowserState, window: &str, plan: &TidyPlan) -> Option<Tidied> {
    tidied_in(state, window, plan, TidyScope::Tabs)
}

pub fn tidied_in(
    state: &BrowserState,
    window: &str,
    plan: &TidyPlan,
    scope: TidyScope,
) -> Option<Tidied> {
    let w = state.window(window)?;
    let planned: Vec<TabId> = plan
        .files
        .iter()
        .map(|(id, _)| id.clone())
        .chain(
            plan.new_groups
                .iter()
                .flat_map(|(ids, _)| ids.iter().cloned()),
        )
        .collect();
    let groups: HashSet<&GroupId> = plan.files.iter().map(|(_, g)| g).collect();
    let moved = with_split_rows(state, &planned);
    let homes = moved
        .iter()
        .map(|id| {
            (
                id.clone(),
                state.tab(id.as_str()).and_then(|t| t.pinned_url.clone()),
            )
        })
        .collect();
    Some(Tidied {
        scope,
        window: w.id.clone(),
        order: w.tab_ids.clone(),
        moved,
        homes,
        closed: plan.closes.iter().map(|(id, _)| id.clone()).collect(),
        groups: groups.len() + plan.new_groups.len(),
    })
}

pub fn can_undo_tidy(state: &BrowserState, tidied: &Tidied) -> bool {
    tidied
        .moved
        .iter()
        .all(|id| state.tab(id.as_str()).is_none_or(|t| t.pin.is_none()))
}

fn plural(n: usize, word: &str) -> String {
    if n == 1 {
        format!("1 {word}")
    } else {
        format!("{n} {word}s")
    }
}

pub fn tidied_message(tidied: &Tidied) -> String {
    let moved = tidied.moved.len();
    if moved == 0 {
        return duplicates_message(tidied);
    }
    match tidied.scope {
        TidyScope::Pins => format!(
            "Tidied {} into {}",
            plural(moved, "Pin"),
            plural(tidied.groups, "Folder")
        ),
        TidyScope::Tabs => format!(
            "Tidied {} into {}",
            plural(moved, "Tab"),
            plural(tidied.groups, "Group")
        ),
    }
}

fn duplicates_message(tidied: &Tidied) -> String {
    if tidied.closed.is_empty() {
        return String::new();
    }
    let word = if tidied.moved.is_empty() {
        "Duplicate Pin"
    } else {
        "duplicate"
    };
    format!("Closed {}", plural(tidied.closed.len(), word))
}

pub fn tidied_detail(tidied: &Tidied) -> Option<String> {
    (!tidied.moved.is_empty() && !tidied.closed.is_empty()).then(|| duplicates_message(tidied))
}

pub fn untidied_order(state: &BrowserState, tidied: &Tidied) -> Option<Vec<TabId>> {
    let w = state.window(tidied.window.as_str())?;
    let in_window = |id: &TabId| w.tab_ids.contains(id);
    let returning: Vec<&TabId> = tidied
        .order
        .iter()
        .filter(|id| tidied.moved.contains(id) && in_window(id))
        .rev()
        .collect();
    let mut order = w.tab_ids.clone();
    let mut placed: HashSet<TabId> = HashSet::new();
    for id in returning {
        if placed.contains(id) {
            continue;
        }
        let block = with_split_rows(state, std::slice::from_ref(id));
        let at = tidied.order.iter().position(|o| o == id).unwrap_or(0);
        let before = tidied.order[at + 1..]
            .iter()
            .find(|o| in_window(o) && !block.contains(o))
            .cloned();
        let moving: Vec<TabId> = order
            .iter()
            .filter(|t| block.contains(t))
            .cloned()
            .collect();
        order.retain(|t| !block.contains(t));
        let index = before
            .and_then(|b| order.iter().position(|t| *t == b))
            .unwrap_or(order.len());
        for (offset, tab) in moving.into_iter().enumerate() {
            order.insert(index + offset, tab);
        }
        placed.extend(block);
    }
    Some(order)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::actions::{Action, NewTab};
    use crate::ids::IdGen;
    use crate::store::BrowserStore;

    fn store_with(urls: &[&str]) -> (BrowserStore, WindowId, Vec<TabId>) {
        let store = BrowserStore::in_memory(BrowserState::default(), IdGen::with_launch("t"));
        store
            .dispatch(Action::OpenWindow {
                kind: WindowKind::Main,
                profile: None,
                url: None,
                frame: None,
            })
            .ok();
        let window = store
            .read(|state| state.windows.keys().next().cloned())
            .expect("a window");
        let blank: Vec<TabId> = store.read(|state| {
            state
                .window(window.as_str())
                .map(|w| w.tab_ids.clone())
                .unwrap_or_default()
        });
        let ids = urls
            .iter()
            .map(|url| {
                store
                    .dispatch(Action::NewTab {
                        window: window.clone(),
                        tab: NewTab {
                            url: Some((*url).to_owned()),
                            background: true,
                            ..NewTab::default()
                        },
                    })
                    .expect("a tab")
                    .tab
                    .expect("a new tab")
            })
            .collect();
        if !blank.is_empty() {
            store
                .dispatch(Action::CloseTabs {
                    tabs: blank,
                    last_closes_window: false,
                })
                .ok();
        }
        (store, window, ids)
    }

    fn order(store: &BrowserStore, window: &WindowId) -> Vec<TabId> {
        store.read(|s| {
            s.window(window.as_str())
                .map(|w| w.tab_ids.clone())
                .unwrap_or_default()
        })
    }

    #[test]
    fn the_plan_groups_sites_with_two_or_more_loose_tabs() {
        let (store, window, ids) = store_with(&[
            "https://github.com/a",
            "https://news.ycombinator.com/",
            "https://github.com/b",
            "https://example.com/",
        ]);
        let state = store.snapshot();
        let plan = tidy_plan(&state, window.as_str(), None).expect("a plan");
        assert!(plan.files.is_empty());
        assert_eq!(
            plan.new_groups,
            vec![(vec![ids[0].clone(), ids[2].clone()], "Github".to_owned())]
        );
    }

    #[test]
    fn loose_tabs_join_a_folder_already_holding_their_site() {
        let (store, window, ids) = store_with(&[
            "https://github.com/a",
            "https://github.com/b",
            "https://example.com/",
            "https://github.com/c",
        ]);
        let group = store
            .dispatch(Action::CreateGroup {
                tabs: vec![ids[0].clone(), ids[1].clone()],
                name: "Code".into(),
            })
            .expect("a group")
            .group
            .expect("a group id");
        let state = store.snapshot();
        let plan = tidy_plan(&state, window.as_str(), None).expect("a plan");
        assert_eq!(plan.files, vec![(ids[3].clone(), group)]);
        assert!(plan.new_groups.is_empty());
        assert!(tidy_plan(&state, window.as_str(), Some(&ProfileId::new("nobody"))).is_none());
    }

    #[test]
    fn the_divider_offers_tidy_only_past_six_unpinned_tabs() {
        let urls = [
            "https://github.com/a",
            "https://github.com/b",
            "https://a.com/",
            "https://b.com/",
            "https://c.com/",
            "https://d.com/",
        ];
        let (store, window, _) = store_with(&urls);
        assert!(can_tidy(&store.snapshot(), window.as_str(), None));
        assert!(!offers_tidy_tabs(&store.snapshot(), window.as_str(), None));
        store
            .dispatch(Action::NewTab {
                window: window.clone(),
                tab: NewTab {
                    url: Some("https://e.com/".into()),
                    background: true,
                    ..NewTab::default()
                },
            })
            .ok();
        assert!(offers_tidy_tabs(&store.snapshot(), window.as_str(), None));
    }

    #[test]
    fn tidying_then_undoing_restores_the_order_and_drops_the_groups() {
        let (store, window, ids) = store_with(&[
            "https://github.com/a",
            "https://a.com/",
            "https://github.com/b",
            "https://b.com/",
            "https://b.com/two",
        ]);
        let before = order(&store, &window);
        let state = store.snapshot();
        let plan = tidy_plan(&state, window.as_str(), None).expect("a plan");
        let tidied = tidied_by(&state, window.as_str(), &plan).expect("a record");
        assert_eq!(tidied.moved.len(), 4);
        assert_eq!(tidied.groups, 2);
        assert_eq!(tidied_message(&tidied), "Tidied 4 Tabs into 2 Groups");
        store
            .dispatch(Action::TidyTabs {
                window: window.clone(),
                profile: None,
            })
            .expect("tidied");
        assert_eq!(store.read(|s| s.groups.len()), 2);
        assert_ne!(order(&store, &window), before);
        assert!(!can_tidy(&store.snapshot(), window.as_str(), None));
        assert!(can_undo_tidy(&store.snapshot(), &tidied));
        store
            .dispatch(Action::UntidyTabs { tidied })
            .expect("undone");
        assert_eq!(store.read(|s| s.groups.len()), 0);
        assert_eq!(order(&store, &window), before);
        assert_eq!(before[0], ids[0]);
    }

    #[test]
    fn undo_is_refused_once_a_moved_tab_was_pinned() {
        let (store, window, ids) = store_with(&["https://github.com/a", "https://github.com/b"]);
        let state = store.snapshot();
        let plan = tidy_plan(&state, window.as_str(), None).expect("a plan");
        let tidied = tidied_by(&state, window.as_str(), &plan).expect("a record");
        store
            .dispatch(Action::TidyTabs {
                window,
                profile: None,
            })
            .expect("tidied");
        store
            .dispatch(Action::SetPin {
                tab: ids[0].clone(),
                pin: Some(crate::model::TabPin::Row),
            })
            .ok();
        if store.read(|s| s.tab(ids[0].as_str()).is_some_and(|t| t.pin.is_some())) {
            assert!(!can_undo_tidy(&store.snapshot(), &tidied));
            assert!(store.dispatch(Action::UntidyTabs { tidied }).is_err());
        }
    }

    #[test]
    fn site_names_prefer_the_title_site() {
        let name = crate::group_names::site_name(&[
            Member {
                url: "https://www.youtube.com/watch?v=1",
                title: "Cats - YouTube",
            },
            Member {
                url: "https://www.youtube.com/watch?v=2",
                title: "Dogs - YouTube",
            },
        ]);
        assert_eq!(name, "YouTube");
        let bare = crate::group_names::site_name(&[Member {
            url: "https://docs.rs/",
            title: "",
        }]);
        assert_eq!(bare, "Docs");
    }

    fn pin_rows(store: &BrowserStore, ids: &[TabId]) {
        for id in ids {
            store
                .dispatch(Action::SetPin {
                    tab: id.clone(),
                    pin: Some(crate::model::TabPin::Row),
                })
                .expect("pinned");
        }
    }

    #[test]
    fn tidy_pins_closes_duplicate_pins_and_folds_sites_into_pinned_folders() {
        let (store, window, ids) = store_with(&[
            "https://github.com/a",
            "https://example.com/",
            "https://github.com/b",
            "https://github.com/a#top",
        ]);
        pin_rows(&store, &ids);
        let state = store.snapshot();
        assert!(can_tidy_pins(&state, window.as_str()));
        assert!(tidy_plan(&state, window.as_str(), None).is_none());
        let plan = tidy_plan_in(&state, window.as_str(), None, TidyScope::Pins).expect("a plan");
        assert_eq!(plan.closes, vec![(ids[3].clone(), ids[0].clone())]);
        assert_eq!(
            plan.new_groups,
            vec![(vec![ids[0].clone(), ids[2].clone()], "Github".to_owned())]
        );
        let tidied = tidied_in(&state, window.as_str(), &plan, TidyScope::Pins).expect("a record");
        assert_eq!(tidied_message(&tidied), "Tidied 2 Pins into 1 Folder");
        assert_eq!(
            tidied_detail(&tidied).as_deref(),
            Some("Closed 1 duplicate")
        );
        let before = order(&store, &window);
        store
            .dispatch(Action::TidyPins {
                window: window.clone(),
            })
            .expect("tidied");
        let after = store.snapshot();
        assert!(after.tab(ids[3].as_str()).is_none());
        let folder = after.group_of(ids[0].as_str()).expect("a folder");
        assert!(folder.pinned);
        assert_eq!(folder.name, "Github");
        assert_eq!(folder.tab_ids, vec![ids[0].clone(), ids[2].clone()]);
        let a = after.tab(ids[0].as_str()).expect("a");
        assert!(a.pin.is_none());
        assert_eq!(a.pinned_url.as_deref(), Some("https://github.com/a"));
        assert!(after.tab(ids[1].as_str()).is_some_and(|t| t.pin.is_some()));
        assert!(!can_tidy_pins(&after, window.as_str()));
        assert!(can_undo_tidy(&after, &tidied));
        store
            .dispatch(Action::UntidyTabs { tidied })
            .expect("undone");
        let undone = store.snapshot();
        assert_eq!(undone.groups.len(), 0);
        let restored = order(&store, &window);
        assert_eq!(restored.len(), before.len());
        assert_eq!(&restored[..3], &before[..3]);
        for id in &restored {
            let tab = undone.tab(id.as_str()).expect("a tab");
            assert!(tab.pin.as_ref().is_some_and(|p| p.is_row()));
        }
        assert_eq!(
            undone.tab(restored[3].as_str()).map(|t| t.url.clone()),
            Some("https://github.com/a#top".to_owned())
        );
    }

    #[test]
    fn pinned_rows_file_into_a_pinned_folder_holding_their_site() {
        let (store, window, ids) = store_with(&[
            "https://github.com/a",
            "https://github.com/b",
            "https://github.com/c",
        ]);
        pin_rows(&store, &ids);
        let folder = store
            .dispatch(Action::CreateGroup {
                tabs: vec![ids[0].clone(), ids[1].clone()],
                name: "Code".into(),
            })
            .expect("a folder")
            .group
            .expect("a folder id");
        let state = store.snapshot();
        assert!(state.group(folder.as_str()).is_some_and(|g| g.pinned));
        let plan = tidy_plan_in(&state, window.as_str(), None, TidyScope::Pins).expect("a plan");
        assert_eq!(plan.files, vec![(ids[2].clone(), folder.clone())]);
        let tidied = tidied_in(&state, window.as_str(), &plan, TidyScope::Pins).expect("a record");
        assert_eq!(tidied_message(&tidied), "Tidied 1 Pin into 1 Folder");
        store.dispatch(Action::TidyPins { window }).expect("tidied");
        assert!(
            store
                .snapshot()
                .group(folder.as_str())
                .is_some_and(|g| g.tab_ids.contains(&ids[2]))
        );
    }

    #[test]
    fn only_duplicate_pins_say_so() {
        let (store, window, ids) = store_with(&["https://example.com/", "https://example.com/"]);
        pin_rows(&store, &ids);
        let state = store.snapshot();
        let plan = tidy_plan_in(&state, window.as_str(), None, TidyScope::Pins).expect("a plan");
        let tidied = tidied_in(&state, window.as_str(), &plan, TidyScope::Pins).expect("a record");
        assert_eq!(tidied_message(&tidied), "Closed 1 Duplicate Pin");
        assert_eq!(tidied_detail(&tidied), None);
    }
}
