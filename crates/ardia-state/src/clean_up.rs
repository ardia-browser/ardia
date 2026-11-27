use std::collections::{HashMap, HashSet};

use crate::groups::pinned_group_members;
use crate::model::Millis;
use crate::state::BrowserState;
use crate::tabs::Tab;
use crate::{ProfileId, TabId};

pub const CLEAN_UP_AFTER_MS: Millis = 12 * 60 * 60 * 1000;
pub const DAILY_CLEAN_UP_MINUTES: f64 = 24.0 * 60.0;
pub const UPSELL_MIN: usize = 10;

fn without_fragment(url: &str) -> &str {
    url.split_once('#').map_or(url, |(page, _)| page)
}

fn protected_tabs(state: &BrowserState) -> HashSet<TabId> {
    let showing: HashSet<&ProfileId> = state.windows.values().map(|w| &w.profile_id).collect();
    let mut out = HashSet::new();
    for w in state.windows.values() {
        for (profile, id) in &w.active_tab_ids {
            if *profile != w.profile_id && showing.contains(profile) {
                continue;
            }
            if state.tab(id.as_str()).is_some_and(|t| t.window_id == w.id) {
                out.insert(id.clone());
            }
        }
    }
    out
}

pub fn inactive_after_ms(state: &BrowserState) -> Millis {
    state
        .settings
        .clean_up_inactive_tabs_after_minutes
        .filter(|m| *m > 0.0)
        .map_or(CLEAN_UP_AFTER_MS, |m| (m * 60_000.0) as Millis)
}

pub fn clean_up_candidates(
    state: &BrowserState,
    window: &str,
    inactive_for: Millis,
    now: Millis,
) -> Vec<TabId> {
    let view: Vec<&Tab> = state
        .view_tabs(window, None)
        .into_iter()
        .map(|t| t.as_ref())
        .collect();
    let active = state.active_tab(window).map(|t| t.id.clone());
    let grouped: HashSet<&TabId> = state.groups.values().flat_map(|g| &g.tab_ids).collect();
    let in_split: HashSet<TabId> = state.splits.values().flat_map(|s| s.tab_ids()).collect();
    let kept = protected_tabs(state);
    let pinned_members = pinned_group_members(&state.groups);
    let keep = |t: &Tab| {
        Some(&t.id) == active.as_ref()
            || kept.contains(&t.id)
            || t.pin.is_some()
            || pinned_members.contains(&t.id)
            || t.live.audible
    };
    let expires = |t: &Tab| !keep(t) && !grouped.contains(&t.id) && !in_split.contains(&t.id);
    let mut out: HashSet<TabId> = HashSet::new();
    let mut by_page: HashMap<&str, Vec<&Tab>> = HashMap::new();
    for t in &view {
        if !t.url.is_empty() {
            by_page.entry(without_fragment(&t.url)).or_default().push(t);
        }
    }
    for same in by_page.values() {
        if same.len() < 2 {
            continue;
        }
        let keeper = same
            .iter()
            .find(|t| t.pin.is_some())
            .or_else(|| same.iter().find(|t| Some(&t.id) == active.as_ref()))
            .or_else(|| same.iter().max_by_key(|t| t.last_active_at))
            .map(|t| t.id.clone());
        for t in same {
            if Some(&t.id) != keeper.as_ref() && !keep(t) && !in_split.contains(&t.id) {
                out.insert(t.id.clone());
            }
        }
    }
    for t in &view {
        if expires(t) && now - t.last_active_at >= inactive_for {
            out.insert(t.id.clone());
        }
    }
    view.iter()
        .filter(|t| out.contains(&t.id))
        .map(|t| t.id.clone())
        .collect()
}

pub fn clean_up_candidate_count(state: &BrowserState, window: &str, now: Millis) -> usize {
    clean_up_candidates(state, window, inactive_after_ms(state), now).len()
}

pub fn upsell_wanted(state: &BrowserState) -> bool {
    state.settings.suggest_clean_up
        && state
            .settings
            .clean_up_inactive_tabs_after_minutes
            .is_none()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::actions::{Action, NewTab};
    use crate::ids::IdGen;
    use crate::store::BrowserStore;
    use crate::windows::WindowKind;

    fn store_with(urls: &[&str]) -> (BrowserStore, String) {
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
            .map(|w| w.as_str().to_owned())
            .unwrap_or_default();
        for url in urls {
            store
                .dispatch(Action::NewTab {
                    window: crate::WindowId::new(&window),
                    tab: NewTab {
                        url: Some((*url).to_owned()),
                        ..NewTab::default()
                    },
                })
                .ok();
        }
        (store, window)
    }

    #[test]
    fn fragments_do_not_make_pages_different() {
        assert_eq!(without_fragment("https://a.test/x#y"), "https://a.test/x");
        assert_eq!(without_fragment("https://a.test/x"), "https://a.test/x");
    }

    #[test]
    fn old_unused_tabs_and_duplicates_are_candidates_but_the_active_tab_is_not() {
        let (store, window) =
            store_with(&["https://a.test/", "https://a.test/#2", "https://b.test/"]);
        assert!(!window.is_empty());
        let state = store.snapshot();
        let active = state.active_tab(&window).map(|t| t.id.clone());
        let fresh = clean_up_candidates(&state, &window, CLEAN_UP_AFTER_MS, 0);
        assert!(!fresh.iter().any(|id| Some(id) == active.as_ref()));
        assert_eq!(fresh.len(), 1, "one of the two a.test tabs is a duplicate");
        let later = clean_up_candidates(&state, &window, CLEAN_UP_AFTER_MS, Millis::MAX / 2);
        assert!(!later.iter().any(|id| Some(id) == active.as_ref()));
        assert!(later.len() >= fresh.len());
    }

    #[test]
    fn the_upsell_waits_for_ten_and_stops_once_auto_clean_up_is_on() {
        assert_eq!(UPSELL_MIN, 10);
        let mut state = BrowserState::default();
        assert!(upsell_wanted(&state));
        std::sync::Arc::make_mut(&mut state.settings).clean_up_inactive_tabs_after_minutes =
            Some(DAILY_CLEAN_UP_MINUTES);
        assert!(!upsell_wanted(&state));
    }

    #[test]
    fn cleaning_up_moves_tabs_to_the_cleaned_list_and_undo_brings_them_back() {
        let (store, window) =
            store_with(&["https://a.test/", "https://a.test/#2", "https://b.test/"]);
        let before = store.read(|s| s.view_tabs(&window, None).len());
        let tabs = store.read(|s| clean_up_candidates(s, &window, CLEAN_UP_AFTER_MS, 0));
        assert_eq!(tabs.len(), 1);
        store.dispatch(Action::CleanUpTabs { tabs }).ok();
        let (left, cleaned) = store.read(|s| {
            (
                s.view_tabs(&window, None).len(),
                s.closed.cleaned_tabs.clone(),
            )
        });
        assert_eq!(left, before - 1);
        assert_eq!(cleaned.len(), 1);
        assert!(store.read(|s| s.closed.tabs.iter().all(|c| c.id != cleaned[0].id)));
        store
            .dispatch(Action::RestoreClosed {
                id: cleaned[0].id.clone(),
                window: Some(crate::WindowId::new(&window)),
            })
            .ok();
        assert_eq!(store.read(|s| s.view_tabs(&window, None).len()), before);
        assert!(store.read(|s| s.closed.cleaned_tabs.is_empty()));
    }
}
