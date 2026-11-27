use std::cell::Cell;
use std::collections::{HashMap, HashSet};
use std::sync::Arc;

use ardia_state::groups::TabGroup;
use ardia_state::tabs::Tab;
use ardia_state::{BrowserState, ProfileId, TabId};
use serde_json::{Map, Value};

use super::adapters::pinned::area::{anchors_of, area_keys, pinned_blocks};
use super::adapters::pinned::{group_choice_key, home_window, order_choice_key, place_choice_key};

thread_local! {
    static WRITING_FROM_SYNC: Cell<bool> = const { Cell::new(false) };
}

pub fn writing_from_sync() -> bool {
    WRITING_FROM_SYNC.with(Cell::get)
}

pub fn from_sync<T>(write: impl FnOnce() -> T) -> T {
    let before = WRITING_FROM_SYNC.with(|w| w.replace(true));
    let out = write();
    WRITING_FROM_SYNC.with(|w| w.set(before));
    out
}

fn tab_key(tab: &Tab) -> String {
    tab.pin_key
        .clone()
        .unwrap_or_else(|| tab.id.as_str().to_owned())
}

fn group_key(group: &TabGroup) -> String {
    group
        .pin_key
        .clone()
        .unwrap_or_else(|| group.id.as_str().to_owned())
}

fn pinned_members(s: &BrowserState) -> HashMap<TabId, String> {
    let mut out = HashMap::new();
    for g in s.groups.values() {
        if g.pinned {
            for id in &g.tab_ids {
                out.insert(id.clone(), group_key(g));
            }
        }
    }
    out
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Spot {
    Tile,
    Row,
    Member,
    Loose,
}

fn spot(tab: &Tab, members: &HashMap<TabId, String>) -> Spot {
    if members.contains_key(&tab.id) {
        return Spot::Member;
    }
    match &tab.pin {
        Some(pin) if pin.is_tile() => Spot::Tile,
        Some(_) => Spot::Row,
        None => Spot::Loose,
    }
}

pub fn choice_marks(prev: &BrowserState, next: &BrowserState) -> Vec<(ProfileId, String)> {
    let mut marks: Vec<(ProfileId, String)> = Vec::new();
    let mut seen: HashSet<(ProfileId, String)> = HashSet::new();
    let mut mark = |profile: &ProfileId, key: String, marks: &mut Vec<(ProfileId, String)>| {
        if !profile.is_incognito() && seen.insert((profile.clone(), key.clone())) {
            marks.push((profile.clone(), key));
        }
    };
    let before = pinned_members(prev);
    let after = pinned_members(next);
    if !Arc::ptr_eq(&prev.tabs, &next.tabs) || !Arc::ptr_eq(&prev.groups, &next.groups) {
        for tab in next.tabs.values() {
            let now = spot(tab, &after);
            if now == Spot::Loose {
                continue;
            }
            let key = tab_key(tab);
            match prev.tabs.get(&tab.id) {
                Some(was) if was.profile_id == tab.profile_id => {
                    let then = spot(was, &before);
                    let group_changed = before.get(&tab.id) != after.get(&tab.id);
                    if then == now && !group_changed {
                        continue;
                    }
                    if then == Spot::Loose
                        || matches!(
                            (then, now),
                            (Spot::Tile, Spot::Row) | (Spot::Row, Spot::Tile)
                        )
                    {
                        mark(&tab.profile_id, key.clone(), &mut marks);
                    }
                    mark(&tab.profile_id, place_choice_key(&key), &mut marks);
                }
                Some(_) => {
                    mark(&tab.profile_id, key.clone(), &mut marks);
                    mark(&tab.profile_id, place_choice_key(&key), &mut marks);
                }
                None => {}
            }
        }
        for group in next.groups.values() {
            if !group.pinned || prev.groups.get(&group.id).is_some_and(|g| g.pinned) {
                continue;
            }
            mark(
                &group.profile_id,
                group_choice_key(&group_key(group)),
                &mut marks,
            );
            for id in &group.tab_ids {
                if let Some(tab) = next.tabs.get(id) {
                    mark(
                        &group.profile_id,
                        place_choice_key(&tab_key(tab)),
                        &mut marks,
                    );
                }
            }
        }
    }
    let reordered =
        !Arc::ptr_eq(&prev.groups, &next.groups) || !Arc::ptr_eq(&prev.windows, &next.windows);
    if reordered {
        let profiles: HashSet<ProfileId> = next
            .groups
            .values()
            .filter(|g| g.pinned && g.parent_id.is_none())
            .map(|g| g.profile_id.clone())
            .collect();
        for profile in profiles {
            if profile.is_incognito() {
                continue;
            }
            let (Some(home), Some(home_before)) =
                (home_window(next, &profile), home_window(prev, &profile))
            else {
                continue;
            };
            if home != home_before {
                continue;
            }
            let (Some(w_now), Some(w_then)) = (next.windows.get(&home), prev.windows.get(&home))
            else {
                continue;
            };
            let now_keys = area_keys(&pinned_blocks(&next.tabs, &next.groups, w_now, &profile));
            let then_keys = area_keys(&pinned_blocks(&prev.tabs, &prev.groups, w_then, &profile));
            let now_set: HashSet<_> = now_keys.iter().cloned().collect();
            let kept: HashSet<_> = then_keys
                .iter()
                .filter(|k| now_set.contains(*k))
                .cloned()
                .collect();
            let was = anchors_of(
                &then_keys
                    .iter()
                    .filter(|k| kept.contains(*k))
                    .cloned()
                    .collect::<Vec<_>>(),
            );
            for (group, anchor) in anchors_of(
                &now_keys
                    .iter()
                    .filter(|k| kept.contains(*k))
                    .cloned()
                    .collect::<Vec<_>>(),
            ) {
                if was.get(&group) != Some(&anchor) {
                    mark(&profile, order_choice_key(&group), &mut marks);
                }
            }
        }
    }
    marks
}

pub fn with_marks(
    state: &BrowserState,
    marks: &[(ProfileId, String)],
    stamp: &mut dyn FnMut() -> String,
) -> Option<BrowserState> {
    if marks.is_empty() {
        return None;
    }
    let mut next = state.clone();
    let persisted = Arc::make_mut(&mut next.persisted);
    for (profile, key) in marks {
        let entry = persisted
            .pin_choices
            .entry(profile.as_str().to_owned())
            .or_insert_with(|| Value::Object(Map::new()));
        if !entry.is_object() {
            *entry = Value::Object(Map::new());
        }
        if let Some(mine) = entry.as_object_mut() {
            mine.insert(key.clone(), Value::String(stamp()));
        }
    }
    Some(next)
}

#[cfg(test)]
mod tests {
    use super::*;
    use ardia_state::BrowserStore;
    use ardia_state::actions::{Action, NewTab};
    use ardia_state::ids::IdGen;
    use ardia_state::model::TabPin;
    use ardia_state::persistence::session::{LoadOptions, SessionData};

    #[test]
    fn pinning_and_switching_to_a_row_are_recorded_but_sync_writes_are_not() {
        let store = BrowserStore::in_memory(
            BrowserState::from_session(
                SessionData::fresh(LoadOptions::default()),
                1_795_000_000_000,
            ),
            IdGen::with_launch("pc"),
        );
        let outcome = store
            .dispatch(Action::OpenWindow {
                kind: ardia_state::windows::WindowKind::Main,
                profile: Some(ProfileId::new("default")),
                url: Some("https://a.example/".into()),
                frame: None,
            })
            .unwrap();
        let window = outcome.window.unwrap();
        let tab = store
            .dispatch(Action::NewTab {
                window,
                tab: NewTab {
                    url: Some("https://b.example/".into()),
                    ..NewTab::default()
                },
            })
            .unwrap()
            .tab
            .unwrap();
        let before = store.snapshot();
        store
            .dispatch(Action::SetPin {
                tab: tab.clone(),
                pin: Some(TabPin::TILE),
            })
            .unwrap();
        let pinned = store.snapshot();
        let marks = choice_marks(&before, &pinned);
        let keys: Vec<&str> = marks.iter().map(|(_, k)| k.as_str()).collect();
        assert!(keys.contains(&tab.as_str()));
        assert!(keys.contains(&format!("place:{}", tab.as_str()).as_str()));
        store
            .dispatch(Action::SetPin {
                tab: tab.clone(),
                pin: Some(TabPin::Row),
            })
            .unwrap();
        let row = store.snapshot();
        assert!(
            choice_marks(&pinned, &row)
                .iter()
                .any(|(_, k)| k == tab.as_str())
        );
        assert!(choice_marks(&row, &row).is_empty());
        let mut n = 0;
        let stamped = with_marks(&row, &marks, &mut || {
            n += 1;
            format!("0mwwsalis.000{n}.D")
        })
        .unwrap();
        assert_eq!(
            stamped.persisted.pin_choices["default"][tab.as_str()],
            Value::String("0mwwsalis.0001.D".into())
        );
        assert!(!writing_from_sync());
        assert!(from_sync(writing_from_sync));
        assert!(!writing_from_sync());
    }
}
