use std::sync::Arc;

use crate::groups::{self, Groups, TabGroup};
use crate::ids::{GroupId, TabId};
use crate::state::BrowserState;

fn with_shown(group: &TabGroup, ids: Vec<TabId>) -> Arc<TabGroup> {
    let mut next = group.clone();
    next.shown_tab_ids = (!ids.is_empty()).then_some(ids);
    Arc::new(next)
}

fn without_shown(groups: &mut Groups, ids: &[GroupId]) {
    for id in ids {
        if let Some(group) = groups.get(id).filter(|g| g.shown_tab_ids.is_some()) {
            let cleared = with_shown(group, Vec::new());
            groups.insert(id.clone(), cleared);
        }
    }
}

pub fn with_shown_tab(groups: &mut Groups, tab: &TabId) {
    let Some(inner) = groups::innermost_group_of(groups, tab.as_str()) else {
        return;
    };
    let mut chain = vec![inner.clone()];
    chain.extend(groups::ancestors(groups, inner.as_str()));
    for id in chain {
        let Some(group) = groups.get(&id) else {
            continue;
        };
        let shown = group.shown_tab_ids.as_deref().unwrap_or_default();
        if group.collapsed && !shown.contains(tab) {
            let mut ids = shown.to_vec();
            ids.push(tab.clone());
            let next = with_shown(group, ids);
            groups.insert(id, next);
        }
    }
}

fn shown_through(groups: &Groups, tab: &TabId, outer: &GroupId) -> bool {
    let mut at = groups::innermost_group_of(groups, tab.as_str());
    let mut hops = 0;
    while let Some(id) = at.filter(|id| id != outer) {
        let Some(group) = groups.get(&id) else {
            break;
        };
        if group.collapsed
            && !group
                .shown_tab_ids
                .as_ref()
                .is_some_and(|ids| ids.contains(tab))
        {
            return false;
        }
        hops += 1;
        if hops > groups.len() {
            break;
        }
        at = group.parent_id.clone();
    }
    true
}

fn active_of(state: &BrowserState, group: &TabGroup) -> Option<TabId> {
    state
        .windows
        .get(&group.window_id)?
        .active_tab_ids
        .get(&group.profile_id)
        .cloned()
}

fn in_pinned_container(state: &BrowserState, groups: &Groups, tab: &TabId) -> bool {
    state.tabs.get(tab).is_some_and(|t| {
        t.pin.is_some() || groups.values().any(|g| g.pinned && g.tab_ids.contains(tab))
    })
}

fn newly_shown(next: &BrowserState, prev: &BrowserState) -> Vec<TabId> {
    let mut out: Vec<TabId> = Vec::new();
    if !Arc::ptr_eq(&next.windows, &prev.windows) {
        for window in next.windows.values() {
            let was = prev.windows.get(&window.id);
            for (profile, tab) in &window.active_tab_ids {
                if was.and_then(|w| w.active_tab_ids.get(profile)) != Some(tab) {
                    out.push(tab.clone());
                }
            }
        }
    }
    if !Arc::ptr_eq(&next.groups, &prev.groups) {
        for group in next.groups.values() {
            for tab in &group.tab_ids {
                let now = groups::innermost_group_of(&next.groups, tab.as_str());
                if now.as_ref() == Some(&group.id)
                    && groups::innermost_group_of(&prev.groups, tab.as_str()) != now
                    && !out.contains(tab)
                {
                    out.push(tab.clone());
                }
            }
        }
    }
    out
}

pub fn settle_shown_tabs(next: &BrowserState, prev: &BrowserState) -> Option<Groups> {
    if Arc::ptr_eq(&next.groups, &prev.groups)
        && Arc::ptr_eq(&next.windows, &prev.windows)
        && !next.groups.values().any(|g| g.shown_tab_ids.is_some())
    {
        return None;
    }
    let mut groups: Groups = (*next.groups).clone();
    for tab in newly_shown(next, prev) {
        with_shown_tab(&mut groups, &tab);
    }
    let toggled: Vec<Arc<TabGroup>> = next
        .groups
        .values()
        .filter(|g| {
            prev.groups
                .get(&g.id)
                .is_some_and(|was| was.collapsed != g.collapsed)
        })
        .cloned()
        .collect();
    for group in &toggled {
        let below = groups::descendants(&next.groups, group.id.as_str());
        without_shown(&mut groups, &below);
    }
    for group in &toggled {
        if let Some(active) = active_of(next, group)
            && group.collapsed
            && group.tab_ids.contains(&active)
        {
            with_shown_tab(&mut groups, &active);
        }
    }
    let ids: Vec<GroupId> = groups.keys().cloned().collect();
    for id in ids {
        let Some(group) = groups.get(&id).cloned() else {
            continue;
        };
        let Some(shown) = group.shown_tab_ids.as_ref() else {
            continue;
        };
        if !group.collapsed {
            without_shown(&mut groups, std::slice::from_ref(&id));
            continue;
        }
        let active = active_of(next, &group);
        let moved_hidden = |tab: &TabId| {
            let was = groups::innermost_group_of(&prev.groups, tab.as_str());
            was.is_some()
                && was != groups::innermost_group_of(&groups, tab.as_str())
                && !shown_through(&groups, tab, &id)
        };
        let live: Vec<TabId> = shown
            .iter()
            .filter(|tab| {
                group.tab_ids.contains(tab)
                    && !moved_hidden(tab)
                    && !(Some(*tab) != active.as_ref()
                        && in_pinned_container(next, &groups, tab)
                        && next.tabs.get(*tab).is_some_and(|t| t.page.is_asleep()))
            })
            .cloned()
            .collect();
        if live.len() != shown.len() {
            let next_group = with_shown(&group, live);
            groups.insert(id, next_group);
        }
    }
    (groups != *next.groups).then_some(groups)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::actions::{Action, GroupPatch, NewTab};
    use crate::ids::IdGen;
    use crate::persistence::session::{LoadOptions, SessionData};
    use crate::windows::WindowKind;

    #[test]
    fn collapsing_keeps_the_active_tab_shown_until_the_group_opens() {
        let ids = IdGen::with_launch("shown");
        let mut state = BrowserState::from_session(SessionData::fresh(LoadOptions::default()), 0);
        let window = state
            .apply(
                Action::OpenWindow {
                    kind: WindowKind::Main,
                    profile: None,
                    url: Some("https://a.example".into()),
                    frame: None,
                },
                1,
                &ids,
            )
            .expect("window")
            .window
            .expect("a window");
        let tab = state
            .apply(
                Action::NewTab {
                    window,
                    tab: NewTab {
                        url: Some("https://b.example".into()),
                        ..NewTab::default()
                    },
                },
                2,
                &ids,
            )
            .expect("tab")
            .tab
            .expect("a tab");
        state
            .apply(
                Action::CreateGroup {
                    tabs: vec![tab.clone()],
                    name: "G".into(),
                },
                3,
                &ids,
            )
            .expect("group");
        let group = state.groups.keys().next().cloned().expect("a group");
        let collapse = |collapsed| Action::UpdateGroup {
            group: group.clone(),
            patch: GroupPatch {
                collapsed: Some(collapsed),
                ..GroupPatch::default()
            },
        };
        state.apply(collapse(true), 4, &ids).expect("collapse");
        assert_eq!(
            state.groups[&group].shown_tab_ids.as_deref(),
            Some(std::slice::from_ref(&tab))
        );
        state.apply(collapse(false), 5, &ids).expect("expand");
        assert_eq!(state.groups[&group].shown_tab_ids, None);
    }
}
