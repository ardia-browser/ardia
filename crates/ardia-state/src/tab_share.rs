use std::collections::{HashMap, HashSet};

use crate::ids::{ProfileId, TabId, WindowId};
use crate::model::{Millis, PageKind};
use crate::state::BrowserState;
use crate::tabs::Tab;
use crate::windows::WindowKind;

pub fn shares_tabs(s: &BrowserState) -> bool {
    s.settings.share_tabs_across_windows
}

pub fn family_key(t: &Tab) -> String {
    format!("{}\u{1}{}", t.profile_id.as_str(), t.pin_key())
}

pub fn has_own_or_shared_page(t: &Tab) -> bool {
    t.page.has_page() || matches!(t.page.kind, PageKind::Frozen { .. })
}

fn keeps_tabs(s: &BrowserState, id: &WindowId) -> bool {
    s.windows
        .get(id)
        .is_some_and(|w| w.kind == WindowKind::Main)
}

pub struct SharedTabs {
    here: HashSet<String>,
    used: HashMap<String, Millis>,
    window: WindowId,
}

impl SharedTabs {
    pub fn elsewhere(&self, t: &Tab) -> bool {
        t.pin.is_none() && t.window_id != self.window && self.here.contains(&family_key(t))
    }

    pub fn last_used(&self, t: &Tab) -> Millis {
        if t.pin.is_some() {
            return t.last_active_at;
        }
        self.used
            .get(&family_key(t))
            .copied()
            .unwrap_or(t.last_active_at)
    }
}

pub fn shared_tabs_in(s: &BrowserState, window: &WindowId) -> SharedTabs {
    let mut here = HashSet::new();
    let mut used: HashMap<String, Millis> = HashMap::new();
    for t in s.tabs.values() {
        if t.pin.is_some() {
            continue;
        }
        let key = family_key(t);
        if t.window_id == *window {
            here.insert(key.clone());
        }
        let at = used.entry(key).or_insert(t.last_active_at);
        *at = (*at).max(t.last_active_at);
    }
    SharedTabs {
        here,
        used,
        window: window.clone(),
    }
}

pub fn shared_view(s: &BrowserState, window: &WindowId) -> Option<SharedTabs> {
    shares_tabs(s).then(|| shared_tabs_in(s, window))
}

pub fn open_tabs_by_use<'a>(
    s: &'a BrowserState,
    profile: &ProfileId,
    window: &WindowId,
) -> Vec<(&'a Tab, Millis)> {
    let view = shared_view(s, window);
    s.tabs
        .values()
        .filter(|t| t.profile_id == *profile && !t.live.peek)
        .filter(|t| !view.as_ref().is_some_and(|v| v.elsewhere(t)))
        .map(|t| {
            let at = view.as_ref().map_or(t.last_active_at, |v| v.last_used(t));
            (&**t, at)
        })
        .collect()
}

pub fn heir_window(s: &BrowserState, window: &WindowId) -> Option<WindowId> {
    s.focus_order
        .iter()
        .chain(s.window_order.iter())
        .find(|id| *id != window && keeps_tabs(s, id))
        .cloned()
}

pub fn tabs_handed_over(s: &BrowserState, window: &WindowId) -> Vec<TabId> {
    let Some(w) = s.windows.get(window) else {
        return Vec::new();
    };
    if !shares_tabs(s) || w.kind != WindowKind::Main || heir_window(s, window).is_none() {
        return Vec::new();
    }
    let held: HashSet<&ProfileId> = s
        .windows
        .values()
        .filter(|o| o.id != *window && o.kind == WindowKind::Main)
        .flat_map(|o| o.tab_ids.iter().filter_map(|t| s.tabs.get(t)))
        .map(|t| &t.profile_id)
        .filter(|p| !p.is_incognito())
        .collect();
    w.tab_ids
        .iter()
        .filter(|id| {
            s.tabs.get(*id).is_some_and(|t| {
                !held.contains(&t.profile_id)
                    && !t.url.is_empty()
                    && t.live_item.is_none()
                    && !s.in_pinned_container(id.as_str())
                    && !t.live.peek
            })
        })
        .cloned()
        .collect()
}

pub fn shared_elsewhere(s: &BrowserState, t: &Tab) -> bool {
    if !shares_tabs(s)
        || t.pin.is_some()
        || t.url.is_empty()
        || t.live_item.is_some()
        || !keeps_tabs(s, &t.window_id)
        || s.in_pinned_container(t.id.as_str())
        || t.live.peek
    {
        return false;
    }
    let key = t.pin_key();
    s.tabs.values().any(|x| {
        x.id != t.id
            && x.window_id != t.window_id
            && x.profile_id == t.profile_id
            && x.pin_key() == key
            && keeps_tabs(s, &x.window_id)
    })
}
