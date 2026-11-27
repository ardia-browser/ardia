use std::collections::HashSet;

use indexmap::IndexMap;

use crate::TabId;
use crate::state::BrowserState;

pub fn same_page_key(url: &str) -> &str {
    let page = url.split_once('#').map_or(url, |(page, _)| page);
    page.strip_suffix('/').unwrap_or(page)
}

#[derive(Default)]
struct SamePageTabs {
    held: bool,
    closable: Vec<TabId>,
}

fn same_page_tabs<'a>(state: &'a BrowserState, window: &str) -> IndexMap<&'a str, SamePageTabs> {
    let mut pages: IndexMap<&str, SamePageTabs> = IndexMap::new();
    for tab in state.view_tabs(window, None) {
        if tab.url.is_empty() || tab.live.peek {
            continue;
        }
        let pinned = state.in_pinned_container(tab.id.as_str());
        if pinned && tab.pin.as_ref().is_some_and(|pin| pin.is_tile()) {
            continue;
        }
        let page = pages.entry(same_page_key(&tab.url)).or_default();
        if pinned || state.split_of(tab.id.as_str()).is_some() || tab.live.audible {
            page.held = true;
        } else {
            page.closable.push(tab.id.clone());
        }
    }
    pages
}

fn kept_copy(state: &BrowserState, page: &SamePageTabs, selected: Option<&TabId>) -> Option<TabId> {
    if let Some(selected) = selected.filter(|s| page.closable.contains(s)) {
        return Some(selected.clone());
    }
    if page.held {
        return None;
    }
    let last_active = |id: &TabId| state.tab(id.as_str()).map_or(0, |t| t.last_active_at);
    page.closable
        .iter()
        .fold(None::<&TabId>, |best, id| match best {
            Some(best) if last_active(id) <= last_active(best) => Some(best),
            _ => Some(id),
        })
        .cloned()
}

pub fn duplicate_tab_ids(state: &BrowserState, window: &str) -> Vec<TabId> {
    let selected = state.active_tab(window).map(|t| t.id.clone());
    let mut closing: HashSet<TabId> = HashSet::new();
    for page in same_page_tabs(state, window).values() {
        if page.closable.len() + usize::from(page.held) < 2 {
            continue;
        }
        let kept = kept_copy(state, page, selected.as_ref());
        closing.extend(
            page.closable
                .iter()
                .filter(|id| Some(*id) != kept.as_ref())
                .cloned(),
        );
    }
    if closing.is_empty() {
        return Vec::new();
    }
    state
        .view_tabs(window, None)
        .into_iter()
        .filter(|t| closing.contains(&t.id))
        .map(|t| t.id.clone())
        .collect()
}

pub fn has_duplicate_tabs(state: &BrowserState, window: &str) -> bool {
    !duplicate_tab_ids(state, window).is_empty()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::actions::{Action, NewTab};
    use crate::ids::IdGen;
    use crate::model::TabPin;
    use crate::store::BrowserStore;
    use crate::windows::WindowKind;
    use crate::{TabId, WindowId};

    fn store_with(urls: &[&str]) -> (BrowserStore, WindowId, Vec<TabId>) {
        let store = BrowserStore::in_memory(BrowserState::default(), IdGen::with_launch("d"));
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
        let mut ids = Vec::new();
        for url in urls {
            let outcome = store
                .dispatch(Action::NewTab {
                    window: window.clone(),
                    tab: NewTab {
                        url: Some((*url).to_owned()),
                        ..NewTab::default()
                    },
                })
                .expect("a tab");
            ids.push(outcome.tab.expect("a new tab"));
        }
        (store, window, ids)
    }

    #[test]
    fn page_keys_ignore_the_fragment_and_a_trailing_slash() {
        assert_eq!(same_page_key("https://a.test/x/#top"), "https://a.test/x");
        assert_eq!(same_page_key("https://a.test/"), "https://a.test");
        assert_eq!(
            same_page_key("https://a.test/x?y=1"),
            "https://a.test/x?y=1"
        );
    }

    #[test]
    fn the_selected_copy_stays_and_the_others_close_in_list_order() {
        let (store, window, ids) = store_with(&[
            "https://a.test/",
            "https://b.test/",
            "https://a.test/#2",
            "https://a.test",
        ]);
        store
            .dispatch(Action::ActivateTab {
                tab: ids[2].clone(),
            })
            .expect("activate");
        let state = store.snapshot();
        assert_eq!(
            duplicate_tab_ids(&state, window.as_str()),
            vec![ids[0].clone(), ids[3].clone()]
        );
        assert!(has_duplicate_tabs(&state, window.as_str()));
    }

    #[test]
    fn a_pinned_copy_holds_the_page_and_its_loose_copies_close() {
        let (store, window, ids) =
            store_with(&["https://a.test/", "https://a.test/", "https://c.test/"]);
        store
            .dispatch(Action::SetPin {
                tab: ids[0].clone(),
                pin: Some(TabPin::Row),
            })
            .expect("pin");
        store
            .dispatch(Action::ActivateTab {
                tab: ids[2].clone(),
            })
            .expect("activate");
        let state = store.snapshot();
        assert_eq!(
            duplicate_tab_ids(&state, window.as_str()),
            vec![ids[1].clone()]
        );
    }

    #[test]
    fn top_apps_neither_close_nor_count() {
        let (store, window, ids) =
            store_with(&["https://a.test/", "https://a.test/", "https://c.test/"]);
        store
            .dispatch(Action::SetPin {
                tab: ids[0].clone(),
                pin: Some(TabPin::TILE),
            })
            .expect("pin");
        store
            .dispatch(Action::ActivateTab {
                tab: ids[2].clone(),
            })
            .expect("activate");
        let state = store.snapshot();
        assert!(duplicate_tab_ids(&state, window.as_str()).is_empty());
        assert!(!has_duplicate_tabs(&state, window.as_str()));
    }

    #[test]
    fn closing_duplicates_keeps_one_copy_and_undo_brings_them_back() {
        let (store, window, ids) = store_with(&[
            "https://a.test/",
            "https://a.test/",
            "https://b.test/",
            "https://a.test/",
        ]);
        store
            .dispatch(Action::ActivateTab {
                tab: ids[2].clone(),
            })
            .expect("activate");
        store
            .dispatch(Action::CloseDuplicateTabs {
                window: window.clone(),
            })
            .expect("close duplicates");
        let state = store.snapshot();
        let left = ids
            .iter()
            .filter(|id| state.tab(id.as_str()).is_some())
            .count();
        assert_eq!(left, 2);
        assert!(state.tab(ids[2].as_str()).is_some());
        assert!(!has_duplicate_tabs(&state, window.as_str()));
        assert_eq!(
            state.active_tab(window.as_str()).map(|t| t.id.clone()),
            Some(ids[2].clone())
        );
        store.dispatch(Action::UndoClear { window }).expect("undo");
        let state = store.snapshot();
        assert!(ids.iter().all(|id| state.tab(id.as_str()).is_some()));
    }
}
