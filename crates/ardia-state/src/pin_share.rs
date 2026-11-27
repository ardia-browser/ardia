use std::collections::HashSet;
use std::sync::Arc;

use crate::ids::{ProfileId, TabId, WindowId};
use crate::model::{PageKind, TabPage, TabPin};
use crate::state::{BrowserState, TabMap};
use crate::tabs::Tab;
use crate::windows::{BrowserWindow, WindowKind};

pub fn holder_of_page(tab: Option<&Tab>) -> Option<&TabId> {
    match &tab?.page.kind {
        PageKind::Frozen { holder } => Some(holder),
        _ => None,
    }
}

fn has_page(tab: &Tab) -> bool {
    tab.page.has_page()
}

fn is_frozen(tab: &Tab) -> bool {
    matches!(tab.page.kind, PageKind::Frozen { .. })
}

pub fn frozen_on(tab: &Tab, holder: &TabId) -> TabPage {
    TabPage {
        kind: PageKind::Frozen {
            holder: holder.clone(),
        },
        wake: tab.page.wake.clone(),
    }
}

pub fn asleep_from(tab: &Tab) -> TabPage {
    TabPage {
        kind: PageKind::Asleep,
        wake: tab.page.wake.clone(),
    }
}

pub fn woken_page(tab: &Tab) -> TabPage {
    TabPage {
        kind: PageKind::Loaded,
        wake: tab.page.wake.clone(),
    }
}

fn is_regular(window: Option<&Arc<BrowserWindow>>) -> bool {
    window.is_some_and(|w| w.kind == WindowKind::Main)
}

pub fn is_top_app(tab: &Tab) -> bool {
    tab.pin.as_ref().is_some_and(TabPin::is_tile)
}

fn sharing_data_of<'a>(s: &'a BrowserState, profile: &ProfileId) -> Option<&'a str> {
    let p = s.profiles.get(profile)?;
    p.share_top_apps
        .then(|| p.data_id.as_deref().unwrap_or(p.id.as_str()))
}

pub fn top_apps_shared(s: &BrowserState, a: &ProfileId, b: &ProfileId) -> bool {
    if a == b {
        return false;
    }
    sharing_data_of(s, a).is_some_and(|data| Some(data) == sharing_data_of(s, b))
}

pub fn same_top_app(s: &BrowserState, a: &Tab, b: &Tab) -> bool {
    is_top_app(a) && is_top_app(b) && top_apps_shared(s, &a.profile_id, &b.profile_id)
}

fn circles_key(s: &BrowserState) -> String {
    let mut groups: Vec<(String, Vec<String>)> = Vec::new();
    for id in s.profile_order.iter() {
        let Some(p) = s.profiles.get(id) else {
            continue;
        };
        let data = p.data_id.clone().unwrap_or_else(|| p.id.to_string());
        let at = match groups.iter().position(|(d, _)| *d == data) {
            Some(at) => at,
            None => {
                groups.push((data, Vec::new()));
                groups.len() - 1
            }
        };
        if p.share_top_apps {
            groups[at].1.push(p.id.to_string());
        }
    }
    let mut circles: Vec<String> = groups
        .into_iter()
        .filter(|(_, ids)| ids.len() > 1)
        .map(|(_, mut ids)| {
            ids.sort();
            ids.join(",")
        })
        .collect();
    circles.sort();
    circles.join("|")
}

pub fn sharing_changed(s: &BrowserState, prev: &BrowserState) -> bool {
    if Arc::ptr_eq(&s.profiles, &prev.profiles)
        && Arc::ptr_eq(&s.profile_order, &prev.profile_order)
    {
        return false;
    }
    circles_key(s) != circles_key(prev)
}

pub(crate) fn shared_list_tab(s: &BrowserState, tab: &Tab) -> bool {
    s.settings.share_tabs_across_windows
        && tab.pin.is_none()
        && !tab.url.is_empty()
        && tab.live_item.is_none()
        && is_regular(s.windows.get(&tab.window_id))
        && !s.in_pinned_container(tab.id.as_str())
        && !tab.live.peek
}

pub fn shares(s: &BrowserState, tab: Option<&Tab>) -> bool {
    let Some(t) = tab else {
        return false;
    };
    !t.profile_id.is_incognito()
        && is_regular(s.windows.get(&t.window_id))
        && (s.in_pinned_container(t.id.as_str()) || shared_list_tab(s, t))
        && s.split_of(t.id.as_str()).is_none()
}

fn family_of(s: &BrowserState, holder: &Tab, copy: &Tab) -> bool {
    if holder.profile_id == copy.profile_id {
        holder.window_id != copy.window_id
    } else {
        same_top_app(s, holder, copy)
    }
}

fn holds(s: &BrowserState, holder: Option<&Tab>, copy: &Tab) -> bool {
    let Some(h) = holder else {
        return false;
    };
    shares(s, Some(h))
        && h.id != copy.id
        && family_of(s, h, copy)
        && h.pin_key() == copy.pin_key()
        && has_page(h)
}

pub fn open_pages(s: &BrowserState, id: &TabId) -> Vec<TabId> {
    let Some(t) = s.tabs.get(id) else {
        return Vec::new();
    };
    if has_page(t) || is_frozen(t) {
        return vec![id.clone()];
    }
    holder_of(s, id).map_or_else(Vec::new, |holder| vec![id.clone(), holder.id.clone()])
}

pub fn holder_of<'a>(s: &'a BrowserState, id: &TabId) -> Option<&'a Arc<Tab>> {
    let t = s.tabs.get(id)?;
    if !shares(s, Some(t)) || has_page(t) {
        return None;
    }
    if let Some(named) = holder_of_page(Some(t)).and_then(|h| s.tabs.get(h))
        && holds(s, Some(named), t)
    {
        return Some(named);
    }
    let key = t.pin_key();
    let mut best: Option<&Arc<Tab>> = None;
    for x in s.tabs.values() {
        if x.pin_key() != key || !holds(s, Some(x), t) {
            continue;
        }
        if best.is_none_or(|b| x.last_active_at > b.last_active_at) {
            best = Some(x);
        }
    }
    best
}

pub fn is_page_unloaded(s: &BrowserState, id: &TabId) -> bool {
    let Some(t) = s.tabs.get(id) else {
        return false;
    };
    let needs_page = !t.url.is_empty() && !has_page(t) && !is_frozen(t);
    if !needs_page {
        return false;
    }
    let key = t.pin_key();
    let live = s.tabs.values().any(|x| has_page(x) && x.pin_key() == key);
    !live || holder_of(s, id).is_none()
}

pub fn frozen_ids(s: &BrowserState) -> Vec<TabId> {
    s.tabs
        .values()
        .filter(|t| is_frozen(t))
        .map(|t| t.id.clone())
        .collect()
}

pub fn frozen_copies_of(s: &BrowserState, holder: &TabId) -> Vec<Arc<Tab>> {
    s.tabs
        .values()
        .filter(|t| holder_of_page(Some(t)) == Some(holder))
        .cloned()
        .collect()
}

pub fn with_shared_family(s: &BrowserState, ids: &[TabId]) -> Vec<TabId> {
    let frozen = frozen_ids(s);
    if frozen.is_empty() {
        return ids.to_vec();
    }
    let mut out: Vec<TabId> = ids.to_vec();
    let push = |out: &mut Vec<TabId>, id: &TabId| {
        if !out.contains(id) {
            out.push(id.clone());
        }
    };
    for id in ids {
        if let Some(holder) = holder_of_page(s.tabs.get(id).map(|t| &**t)) {
            push(&mut out, holder);
        }
    }
    for f in &frozen {
        if let Some(holder) = holder_of_page(s.tabs.get(f).map(|t| &**t))
            && out.contains(holder)
        {
            push(&mut out, f);
        }
    }
    out
}

fn swap_ids(ids: &[TabId], a: &TabId, b: &TabId) -> Option<Vec<TabId>> {
    if !ids.contains(a) && !ids.contains(b) {
        return None;
    }
    Some(
        ids.iter()
            .map(|x| {
                if x == a {
                    b.clone()
                } else if x == b {
                    a.clone()
                } else {
                    x.clone()
                }
            })
            .collect(),
    )
}

fn swap_window(w: &BrowserWindow, a: &TabId, b: &TabId) -> BrowserWindow {
    let mut next = w.clone();
    if let Some(ids) = swap_ids(&w.tab_ids, a, b) {
        next.tab_ids = ids;
    }
    for id in next.active_tab_ids.values_mut() {
        if id == a {
            *id = b.clone();
        } else if id == b {
            *id = a.clone();
        }
    }
    if let Some(ids) = swap_ids(&w.chrome.selection, a, b) {
        next.chrome.selection = ids;
    }
    next
}

fn take_shown_fields(into: &mut Tab, from: &Tab) {
    into.url = from.url.clone();
    into.title = from.title.clone();
    into.favicon = from.favicon.clone();
    into.muted = from.muted;
    into.live.security = from.live.security;
}

fn shown_fields_differ(a: &Tab, b: &Tab) -> bool {
    a.url != b.url
        || a.title != b.title
        || a.favicon != b.favicon
        || a.muted != b.muted
        || a.live.security != b.live.security
}

pub struct Swapped {
    pub state: BrowserState,
    pub holder: TabId,
}

pub fn swap_pin_page(s: &BrowserState, id: &TabId) -> Option<Swapped> {
    let copy = s.tabs.get(id)?.clone();
    let holder = holder_of(s, id)?.clone();
    let from = holder.window_id.clone();
    let to = copy.window_id.clone();
    let a = holder.id.clone();
    let b = copy.id.clone();
    let one_window = from == to;
    let holder_side = |window: &WindowId, profile: &ProfileId| {
        *window == from && (!one_window || *profile == holder.profile_id)
    };
    let copy_side = |window: &WindowId, profile: &ProfileId| {
        *window == to && (!one_window || *profile == copy.profile_id)
    };
    let mut next = s.clone();
    {
        let windows = Arc::make_mut(&mut next.windows);
        if let Some(w) = s.windows.get(&from) {
            windows.insert(from.clone(), Arc::new(swap_window(w, &a, &b)));
        }
        if !one_window && let Some(w) = s.windows.get(&to) {
            windows.insert(to.clone(), Arc::new(swap_window(w, &a, &b)));
        }
    }
    {
        let tabs = Arc::make_mut(&mut next.tabs);
        let mut moved = (*holder).clone();
        moved.window_id = to.clone();
        moved.profile_id = copy.profile_id.clone();
        tabs.insert(a.clone(), Arc::new(moved));
        let mut frozen = (*copy).clone();
        take_shown_fields(&mut frozen, &holder);
        frozen.window_id = from.clone();
        frozen.profile_id = holder.profile_id.clone();
        frozen.page = frozen_on(&copy, &a);
        tabs.insert(b.clone(), Arc::new(frozen));
        for t in s.tabs.values() {
            if t.id == a || t.id == b {
                continue;
            }
            let Some(opener) = t.opener_id.as_ref() else {
                continue;
            };
            let swapped = if holder_side(&t.window_id, &t.profile_id) && *opener == a {
                Some(b.clone())
            } else if copy_side(&t.window_id, &t.profile_id) && *opener == b {
                Some(a.clone())
            } else {
                None
            };
            if let Some(opener) = swapped {
                let mut edited = (**t).clone();
                edited.opener_id = Some(opener);
                tabs.insert(t.id.clone(), Arc::new(edited));
            }
        }
    }
    let mut groups = None;
    for g in s.groups.values() {
        let holder_group = holder_side(&g.window_id, &g.profile_id);
        if !holder_group && !copy_side(&g.window_id, &g.profile_id) {
            continue;
        }
        let tab_ids = swap_ids(&g.tab_ids, &a, &b);
        let (mine, theirs) = if holder_group { (&a, &b) } else { (&b, &a) };
        let opener = if g.pinned_opener_id.as_ref() == Some(mine) {
            Some(theirs.clone())
        } else {
            g.pinned_opener_id.clone()
        };
        if tab_ids.is_none() && opener == g.pinned_opener_id {
            continue;
        }
        let mut edited = (**g).clone();
        if let Some(ids) = tab_ids {
            edited.tab_ids = ids;
        }
        edited.pinned_opener_id = opener;
        groups
            .get_or_insert_with(|| (*s.groups).clone())
            .insert(g.id.clone(), Arc::new(edited));
    }
    if let Some(groups) = groups {
        next.groups = Arc::new(groups);
    }
    Some(Swapped {
        state: next,
        holder: a,
    })
}

fn changed_ids(now: &TabMap, was: &TabMap) -> Vec<TabId> {
    let mut out: Vec<TabId> = now
        .iter()
        .filter(|(id, t)| was.get(*id).is_none_or(|w| !Arc::ptr_eq(t, w)))
        .map(|(id, _)| id.clone())
        .collect();
    out.extend(was.keys().filter(|id| !now.contains_key(*id)).cloned());
    out
}

fn shown_in(s: &BrowserState, t: &Tab) -> bool {
    s.windows.get(&t.window_id).is_some_and(|w| {
        w.profile_id == t.profile_id && w.active_tab_ids.get(&t.profile_id) == Some(&t.id)
    })
}

fn split_leavers(s: &BrowserState, prev: &BrowserState) -> Vec<TabId> {
    if Arc::ptr_eq(&s.splits, &prev.splits) {
        return Vec::new();
    }
    let now: HashSet<TabId> = s.splits.values().flat_map(|v| v.tab_ids()).collect();
    prev.splits
        .values()
        .flat_map(|v| v.tab_ids())
        .filter(|id| !now.contains(id))
        .collect()
}

fn one_owner_per_pin(
    s: &BrowserState,
    prev: &BrowserState,
    rejoined: bool,
) -> Option<BrowserState> {
    let changed = if Arc::ptr_eq(&s.tabs, &prev.tabs) {
        Vec::new()
    } else {
        changed_ids(&s.tabs, &prev.tabs)
    };
    let gained: Vec<TabId> = changed
        .iter()
        .filter(|id| {
            let Some(t) = s.tabs.get(*id) else {
                return false;
            };
            let kept = prev
                .tabs
                .get(*id)
                .is_some_and(|was| has_page(was) && prev.split_of(id.as_str()).is_none());
            has_page(t) && !kept
        })
        .cloned()
        .collect();
    let joined: HashSet<TabId> = if rejoined {
        s.tabs
            .values()
            .filter(|t| has_page(t) && is_top_app(t))
            .map(|t| t.id.clone())
            .collect()
    } else {
        changed
            .iter()
            .filter(|id| match (s.tabs.get(*id), prev.tabs.get(*id)) {
                (Some(t), Some(was)) => has_page(t) && t.pin_key() != was.pin_key(),
                _ => false,
            })
            .cloned()
            .collect()
    };
    let mut candidates: Vec<TabId> = Vec::new();
    for id in gained
        .iter()
        .chain(joined.iter())
        .chain(split_leavers(s, prev).iter())
    {
        if !candidates.contains(id) {
            candidates.push(id.clone());
        }
    }
    if candidates.is_empty() {
        return None;
    }
    let mut view = s.clone();
    let mut touched = false;
    for id in &candidates {
        let Some(c) = view.tabs.get(id).cloned() else {
            continue;
        };
        if !shares(&view, Some(&c)) || !has_page(&c) {
            continue;
        }
        let family: Vec<Arc<Tab>> = view
            .tabs
            .values()
            .filter(|x| x.id != c.id && holds(&view, Some(x), &c))
            .cloned()
            .collect();
        if family.is_empty() {
            continue;
        }
        let newcomer = gained.contains(&c.id) && prev.split_of(c.id.as_str()).is_none();
        let mut all: Vec<Arc<Tab>> = Vec::new();
        if !newcomer {
            all.push(c.clone());
        }
        all.extend(family.iter().cloned());
        let rank = |t: &Tab| {
            if joined.contains(&c.id) && shown_in(&view, t) {
                i64::MAX
            } else {
                t.last_active_at
            }
        };
        let Some(keeper) = all
            .iter()
            .fold(None::<&Arc<Tab>>, |best, y| match best {
                Some(x) if rank(y) <= rank(x) => Some(x),
                _ => Some(y),
            })
            .cloned()
        else {
            continue;
        };
        let losers: Vec<Arc<Tab>> = std::iter::once(c.clone())
            .chain(family)
            .filter(|t| t.id != keeper.id)
            .collect();
        for loser in losers {
            let tabs = Arc::make_mut(&mut view.tabs);
            let current = tabs.get(&loser.id).cloned().unwrap_or(loser.clone());
            let mut frozen = (*current).clone();
            take_shown_fields(&mut frozen, &keeper);
            frozen.page = frozen_on(&current, &keeper.id);
            tabs.insert(loser.id.clone(), Arc::new(frozen));
            let leaning: Vec<Arc<Tab>> = tabs
                .values()
                .filter(|t| holder_of_page(Some(t)) == Some(&loser.id))
                .cloned()
                .collect();
            for t in leaning {
                let mut moved = (*t).clone();
                moved.page = frozen_on(&t, &keeper.id);
                tabs.insert(t.id.clone(), Arc::new(moved));
            }
            touched = true;
        }
    }
    touched.then_some(view)
}

pub fn settle_shared_pins(next: &BrowserState, prev: &BrowserState) -> Option<BrowserState> {
    let rejoined = sharing_changed(next, prev);
    if !rejoined
        && Arc::ptr_eq(&next.tabs, &prev.tabs)
        && Arc::ptr_eq(&next.windows, &prev.windows)
        && Arc::ptr_eq(&next.groups, &prev.groups)
        && Arc::ptr_eq(&next.splits, &prev.splits)
    {
        return None;
    }
    let owned = one_owner_per_pin(next, prev, rejoined);
    let s = owned.as_ref().unwrap_or(next);
    let frozen = frozen_ids(s);
    if frozen.is_empty() {
        return owned;
    }
    let mut out = s.clone();
    let mut edited = false;
    for id in &frozen {
        let Some(t) = s.tabs.get(id).cloned() else {
            continue;
        };
        let holder = holder_of_page(Some(&t))
            .and_then(|h| s.tabs.get(h))
            .cloned();
        if let Some(h) = holder.as_ref().filter(|h| {
            shares(s, Some(h))
                && h.window_id == t.window_id
                && h.profile_id == t.profile_id
                && h.pin_key() == t.pin_key()
                && has_page(h)
        }) {
            if let Some(w) = s.windows.get(&t.window_id)
                && w.active_tab_ids.values().any(|x| *x == t.id)
            {
                let mut moved = (**w).clone();
                for x in moved.active_tab_ids.values_mut() {
                    if *x == t.id {
                        *x = h.id.clone();
                    }
                }
                Arc::make_mut(&mut out.windows).insert(w.id.clone(), Arc::new(moved));
            }
            let mut asleep = (*t).clone();
            asleep.page = asleep_from(&t);
            Arc::make_mut(&mut out.tabs).insert(id.clone(), Arc::new(asleep));
            edited = true;
            continue;
        }
        if !holds(s, holder.as_deref(), &t) || !shares(s, Some(&t)) {
            let shown = shown_in(s, &t) && !t.url.is_empty();
            let mut freed = (*t).clone();
            freed.page = if shown {
                woken_page(&t)
            } else {
                asleep_from(&t)
            };
            Arc::make_mut(&mut out.tabs).insert(id.clone(), Arc::new(freed));
            edited = true;
            continue;
        }
        if let Some(h) = holder.as_ref()
            && shown_fields_differ(&t, h)
        {
            let mut mirrored = (*t).clone();
            take_shown_fields(&mut mirrored, h);
            Arc::make_mut(&mut out.tabs).insert(id.clone(), Arc::new(mirrored));
            edited = true;
        }
    }
    if edited { Some(out) } else { owned }
}

pub fn return_shared_pages(s: &BrowserState, window: &WindowId) -> BrowserState {
    let Some(w) = s.windows.get(window).filter(|w| w.kind == WindowKind::Main) else {
        return s.clone();
    };
    if frozen_ids(s).is_empty() {
        return s.clone();
    }
    let mut next = s.clone();
    for id in w.tab_ids.iter() {
        let Some(t) = next.tabs.get(id) else {
            continue;
        };
        if !has_page(t) {
            continue;
        }
        let order = next.focus_order.clone();
        let rank = |c: &Tab| {
            order
                .iter()
                .position(|w| *w == c.window_id)
                .unwrap_or(usize::MAX)
        };
        let target = frozen_copies_of(&next, id)
            .into_iter()
            .filter(|c| c.window_id != *window && next.windows.contains_key(&c.window_id))
            .min_by_key(|c| rank(c));
        if let Some(target) = target
            && let Some(swapped) = swap_pin_page(&next, &target.id)
        {
            next = swapped.state;
        }
    }
    next
}

pub fn handed_off(s: &BrowserState, id: &TabId) -> Option<(BrowserState, TabId)> {
    let tab = s.tabs.get(id)?;
    if has_page(tab) {
        return None;
    }
    holder_of(s, id)?;
    swap_pin_page(s, id).map(|swapped| (swapped.state, swapped.holder))
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use crate::ProfileId;
    use crate::profiles::Profile;
    use crate::windows::BrowserWindow;

    fn window(id: &str, profile: &ProfileId, tabs: &[&str]) -> BrowserWindow {
        let mut w = BrowserWindow::new(WindowId::new(id), WindowKind::Main, profile.clone(), 0);
        w.tab_ids = tabs.iter().map(TabId::new).collect();
        if let Some(first) = tabs.first() {
            w.active_tab_ids.insert(profile.clone(), TabId::new(first));
        }
        w
    }

    fn pinned(id: &str, window: &str, profile: &ProfileId, key: &str, page: TabPage) -> Tab {
        let mut t = Tab::new(
            TabId::new(id),
            WindowId::new(window),
            profile.clone(),
            "https://mail.example.com/",
            0,
        );
        t.pin = Some(TabPin::TILE);
        t.pin_key = (key != id).then(|| key.to_owned());
        t.page = page;
        t
    }

    pub(crate) fn two_windows() -> BrowserState {
        let profile = ProfileId::default_profile();
        let mut s = BrowserState::default();
        Arc::make_mut(&mut s.profiles)
            .insert(profile.clone(), Arc::new(Profile::default_profile()));
        Arc::make_mut(&mut s.profile_order).push(profile.clone());
        let mut held = pinned("a", "w1", &profile, "a", TabPage::LOADED);
        held.title = "Inbox (3)".into();
        held.live.security = crate::tabs::SecurityState::Secure;
        held.last_active_at = 10;
        let copy = pinned("b", "w2", &profile, "a", TabPage::ASLEEP);
        let other = Tab::new(
            TabId::new("c"),
            WindowId::new("w2"),
            profile.clone(),
            "https://x.com/",
            0,
        );
        let tabs = Arc::make_mut(&mut s.tabs);
        for t in [held, copy, other] {
            tabs.insert(t.id.clone(), Arc::new(t));
        }
        let windows = Arc::make_mut(&mut s.windows);
        windows.insert(
            WindowId::new("w1"),
            Arc::new(window("w1", &profile, &["a"])),
        );
        windows.insert(
            WindowId::new("w2"),
            Arc::new(window("w2", &profile, &["b", "c"])),
        );
        Arc::make_mut(&mut s.window_order).extend([WindowId::new("w1"), WindowId::new("w2")]);
        Arc::make_mut(&mut s.focus_order).extend([WindowId::new("w2"), WindowId::new("w1")]);
        s
    }

    fn page(s: &BrowserState, id: &str) -> PageKind {
        s.tabs[&TabId::new(id)].page.kind.clone()
    }

    #[test]
    fn a_pinned_copy_without_a_page_is_held_by_the_window_that_has_it() {
        let s = two_windows();
        assert_eq!(
            holder_of(&s, &TabId::new("b")).map(|t| t.id.as_str()),
            Some("a")
        );
        assert!(holder_of(&s, &TabId::new("a")).is_none());
        assert!(holder_of(&s, &TabId::new("c")).is_none());
        assert!(!is_page_unloaded(&s, &TabId::new("b")));
    }

    #[test]
    fn the_newest_holder_wins_and_incognito_never_shares() {
        let mut s = two_windows();
        let profile = ProfileId::default_profile();
        let mut third = pinned("d", "w3", &profile, "a", TabPage::LOADED);
        third.last_active_at = 99;
        Arc::make_mut(&mut s.tabs).insert(third.id.clone(), Arc::new(third));
        Arc::make_mut(&mut s.windows).insert(
            WindowId::new("w3"),
            Arc::new(window("w3", &profile, &["d"])),
        );
        assert_eq!(
            holder_of(&s, &TabId::new("b")).map(|t| t.id.as_str()),
            Some("d")
        );
        Arc::make_mut(&mut s.windows).insert(
            WindowId::new("w3"),
            Arc::new(BrowserWindow::new(
                WindowId::new("w3"),
                WindowKind::Incognito,
                profile,
                0,
            )),
        );
        assert_eq!(
            holder_of(&s, &TabId::new("b")).map(|t| t.id.as_str()),
            Some("a")
        );
    }

    #[test]
    fn handing_off_swaps_places_and_freezes_the_source_window() {
        let s = two_windows();
        let swapped = swap_pin_page(&s, &TabId::new("b")).unwrap();
        let next = swapped.state;
        assert_eq!(swapped.holder.as_str(), "a");
        assert_eq!(next.tabs[&TabId::new("a")].window_id.as_str(), "w2");
        assert_eq!(next.tabs[&TabId::new("b")].window_id.as_str(), "w1");
        assert_eq!(
            page(&next, "b"),
            PageKind::Frozen {
                holder: TabId::new("a")
            }
        );
        assert_eq!(next.tabs[&TabId::new("b")].title, "Inbox (3)");
        assert_eq!(
            next.tabs[&TabId::new("b")].live.security,
            crate::tabs::SecurityState::Secure
        );
        assert_eq!(
            next.windows[&WindowId::new("w1")].tab_ids,
            vec![TabId::new("b")]
        );
        assert_eq!(
            next.windows[&WindowId::new("w2")].tab_ids,
            vec![TabId::new("a"), TabId::new("c")]
        );
        assert_eq!(
            next.windows[&WindowId::new("w1")]
                .active_tab()
                .map(TabId::as_str),
            Some("b")
        );
        assert_eq!(
            holder_of(&next, &TabId::new("b")).map(|t| t.id.as_str()),
            Some("a")
        );
        assert_eq!(
            with_shared_family(&next, &[TabId::new("a")]),
            vec![TabId::new("a"), TabId::new("b")]
        );
        assert_eq!(frozen_copies_of(&next, &TabId::new("a")).len(), 1);
    }

    #[test]
    fn openers_follow_the_page_they_were_opened_from() {
        let mut s = two_windows();
        let profile = ProfileId::default_profile();
        let mut child = Tab::new(
            TabId::new("k"),
            WindowId::new("w1"),
            profile,
            "https://y.com/",
            0,
        );
        child.opener_id = Some(TabId::new("a"));
        Arc::make_mut(&mut s.tabs).insert(child.id.clone(), Arc::new(child));
        let next = swap_pin_page(&s, &TabId::new("b")).unwrap().state;
        assert_eq!(
            next.tabs[&TabId::new("k")]
                .opener_id
                .as_ref()
                .map(TabId::as_str),
            Some("b")
        );
    }

    #[test]
    fn a_second_live_copy_freezes_onto_the_page_already_held() {
        let s = two_windows();
        let mut next = s.clone();
        let mut woke = (*next.tabs[&TabId::new("b")]).clone();
        woke.page = TabPage::LOADED;
        woke.last_active_at = 50;
        Arc::make_mut(&mut next.tabs).insert(woke.id.clone(), Arc::new(woke));
        let settled = settle_shared_pins(&next, &s).unwrap();
        assert_eq!(page(&settled, "a"), PageKind::Loaded);
        assert_eq!(
            page(&settled, "b"),
            PageKind::Frozen {
                holder: TabId::new("a")
            }
        );
        assert_eq!(settled.tabs[&TabId::new("b")].title, "Inbox (3)");
        assert!(settle_shared_pins(&settled, &settled).is_none());
    }

    #[test]
    fn activating_a_copy_brings_the_page_into_its_window() {
        let s = two_windows();
        let ids = crate::IdGen::new(0);
        let (next, out) = s
            .reduce(
                crate::Action::ActivateTab {
                    tab: TabId::new("b"),
                },
                100,
                &ids,
            )
            .unwrap();
        assert_eq!(next.tabs[&TabId::new("a")].window_id.as_str(), "w2");
        assert_eq!(
            next.windows[&WindowId::new("w2")]
                .active_tab()
                .map(TabId::as_str),
            Some("a")
        );
        assert_eq!(
            page(&next, "b"),
            PageKind::Frozen {
                holder: TabId::new("a")
            }
        );
        assert!(out.changes.touches_tab("a") && out.changes.touches_tab("b"));
        let (closed, _) = next
            .reduce(
                crate::Action::CloseWindow {
                    window: WindowId::new("w2"),
                },
                200,
                &ids,
            )
            .unwrap();
        assert_eq!(closed.tabs[&TabId::new("a")].window_id.as_str(), "w1");
    }

    #[test]
    fn typing_into_a_shown_copy_brings_the_page_here_and_loads_it_there() {
        let s = two_windows();
        let ids = crate::IdGen::new(0);
        let (next, _) = s
            .reduce(
                crate::Action::Navigate {
                    tab: TabId::new("b"),
                    input: "https://news.example.com/".into(),
                },
                100,
                &ids,
            )
            .unwrap();
        let held = &next.tabs[&TabId::new("a")];
        assert_eq!(held.window_id.as_str(), "w2");
        assert_eq!(
            held.live.navigation.as_deref(),
            Some("https://news.example.com/")
        );
        assert!(matches!(page(&next, "b"), PageKind::Frozen { .. }));
    }

    #[test]
    fn a_copy_whose_holder_is_gone_wakes_when_shown_and_sleeps_otherwise() {
        let s = swap_pin_page(&two_windows(), &TabId::new("b"))
            .unwrap()
            .state;
        let mut next = s.clone();
        Arc::make_mut(&mut next.tabs).shift_remove(&TabId::new("a"));
        let settled = settle_shared_pins(&next, &s).unwrap();
        assert_eq!(page(&settled, "b"), PageKind::Loaded);
        let mut hidden = next.clone();
        let mut w = (*hidden.windows[&WindowId::new("w1")]).clone();
        w.active_tab_ids.clear();
        Arc::make_mut(&mut hidden.windows).insert(w.id.clone(), Arc::new(w));
        let settled = settle_shared_pins(&hidden, &s).unwrap();
        assert_eq!(page(&settled, "b"), PageKind::Asleep);
    }

    #[test]
    fn frozen_copies_take_the_holders_title_as_it_changes() {
        let s = swap_pin_page(&two_windows(), &TabId::new("b"))
            .unwrap()
            .state;
        let mut next = s.clone();
        let mut held = (*next.tabs[&TabId::new("a")]).clone();
        held.title = "Inbox (4)".into();
        Arc::make_mut(&mut next.tabs).insert(held.id.clone(), Arc::new(held));
        let settled = settle_shared_pins(&next, &s).unwrap();
        assert_eq!(settled.tabs[&TabId::new("b")].title, "Inbox (4)");
    }

    #[test]
    fn closing_a_window_hands_its_pages_back_to_the_most_recent_window() {
        let s = swap_pin_page(&two_windows(), &TabId::new("b"))
            .unwrap()
            .state;
        let back = return_shared_pages(&s, &WindowId::new("w2"));
        assert_eq!(back.tabs[&TabId::new("a")].window_id.as_str(), "w1");
        assert!(back.tabs[&TabId::new("a")].page.has_page());
        assert_eq!(
            page(&back, "b"),
            PageKind::Frozen {
                holder: TabId::new("a")
            }
        );
    }

    #[test]
    fn top_apps_share_only_between_profiles_on_the_same_data() {
        let mut s = two_windows();
        let work = ProfileId::new("work");
        let mut p = Profile::new(work.clone(), "Work", ardia_theme::ProfileColor::Plum, 0);
        p.share_top_apps = true;
        p.data_id = Some("default".into());
        Arc::make_mut(&mut s.profiles).insert(work.clone(), Arc::new(p));
        let mut me = (*s.profiles[&ProfileId::default_profile()]).clone();
        me.share_top_apps = true;
        Arc::make_mut(&mut s.profiles).insert(me.id.clone(), Arc::new(me));
        Arc::make_mut(&mut s.profile_order).push(work.clone());
        assert!(top_apps_shared(&s, &ProfileId::default_profile(), &work));
        let prev = two_windows();
        assert!(sharing_changed(&s, &prev));
    }
}
