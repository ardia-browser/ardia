use super::pin_mirror::{
    GroupSpec, Item, Section, chain_of, has_duplicates, innermost_pinned, is_regular, key_field,
    pinned_chain, signature, tree_order, union,
};
use super::*;
use crate::tab_share::{family_key, has_own_or_shared_page, shares_tabs};

#[derive(Clone, Copy, PartialEq, Eq)]
enum Leaving {
    Close,
    KeepPages,
}

fn listable(t: &Tab) -> bool {
    t.pin.is_none() && !t.url.is_empty() && t.live_item.is_none()
}

struct ListMember {
    pinned_members: HashSet<TabId>,
    in_split: HashSet<TabId>,
}

impl ListMember {
    fn of(s: &BrowserState) -> Self {
        ListMember {
            pinned_members: groups::pinned_group_members(&s.groups),
            in_split: s.splits.values().flat_map(|v| v.tab_ids()).collect(),
        }
    }

    fn holds(&self, t: &Tab) -> bool {
        listable(t)
            && !t.live.peek
            && !self.pinned_members.contains(&t.id)
            && !self.in_split.contains(&t.id)
    }
}

fn list_section(s: &BrowserState, w: &BrowserWindow, profile: &ProfileId) -> Section {
    let member = ListMember::of(s);
    list_section_with(s, w, profile, &member)
}

fn list_section_with(
    s: &BrowserState,
    w: &BrowserWindow,
    profile: &ProfileId,
    member: &ListMember,
) -> Section {
    let mine: Vec<Arc<TabGroup>> = s
        .groups
        .values()
        .filter(|g| !g.pinned && g.window_id == w.id && g.profile_id == *profile)
        .cloned()
        .collect();
    let own_ids: HashSet<GroupId> = mine.iter().map(|g| g.id.clone()).collect();
    let inner = innermost_pinned(&s.groups, &mine);
    let mut x = Section::default();
    let mut owned: HashSet<GroupId> = HashSet::new();
    for id in &w.tab_ids {
        let Some(t) = s.tabs.get(id) else {
            continue;
        };
        if t.profile_id != *profile || !member.holds(t) {
            continue;
        }
        let g = inner.get(id).cloned();
        if let Some(g) = g.as_ref() {
            for c in pinned_chain(&s.groups, g, &own_ids) {
                if !owned.insert(c.id.clone()) {
                    continue;
                }
                let key = c.pin_key().to_owned();
                if x.groups.contains_key(&key) {
                    x.duplicate = true;
                } else {
                    let parent = c
                        .parent_id
                        .as_ref()
                        .filter(|p| own_ids.contains(*p))
                        .and_then(|p| s.groups.get(p))
                        .map(|p| p.pin_key().to_owned());
                    x.groups.insert(
                        key,
                        GroupSpec {
                            group: Arc::clone(&c),
                            parent,
                        },
                    );
                }
                x.own.push(c);
            }
        }
        x.items.push(Item {
            tab: Arc::clone(t),
            group: g.map(|g| g.pin_key().to_owned()),
        });
    }
    x
}

fn list_may_differ(s: &BrowserState, prev: &BrowserState) -> bool {
    if !Arc::ptr_eq(&s.windows, &prev.windows)
        || !Arc::ptr_eq(&s.groups, &prev.groups)
        || !Arc::ptr_eq(&s.splits, &prev.splits)
    {
        return true;
    }
    if Arc::ptr_eq(&s.tabs, &prev.tabs) {
        return false;
    }
    let gone = prev.tabs.keys().any(|id| !s.tabs.contains_key(id));
    gone || s.tabs.iter().any(|(id, a)| match prev.tabs.get(id) {
        None => true,
        Some(b) if Arc::ptr_eq(a, b) => false,
        Some(b) => {
            a.pin != b.pin
                || a.profile_id != b.profile_id
                || a.window_id != b.window_id
                || a.pin_key != b.pin_key
                || a.custom_title != b.custom_title
                || a.custom_icon != b.custom_icon
                || a.tile_letters != b.tile_letters
                || a.live_item != b.live_item
                || crate::pin_share::holder_of_page(Some(a))
                    != crate::pin_share::holder_of_page(Some(b))
                || a.page.has_page() != b.page.has_page()
                || a.url.is_empty() != b.url.is_empty()
        }
    })
}

fn regular_order(s: &BrowserState) -> Vec<WindowId> {
    let mut order: Vec<WindowId> = Vec::new();
    for id in s.focus_order.iter().chain(s.window_order.iter()) {
        if !order.contains(id) && is_regular(s.windows.get(id)) {
            order.push(id.clone());
        }
    }
    order
}

fn by_profile(s: &BrowserState) -> IndexMap<ProfileId, Vec<WindowId>> {
    let mut out: IndexMap<ProfileId, Vec<WindowId>> = IndexMap::new();
    for id in regular_order(s) {
        let w = &s.windows[&id];
        let mut seen: HashSet<&ProfileId> = HashSet::new();
        for t in w.tab_ids.iter().filter_map(|t| s.tabs.get(t)) {
            if !t.profile_id.is_incognito() && seen.insert(&t.profile_id) {
                out.entry(t.profile_id.clone())
                    .or_default()
                    .push(id.clone());
            }
        }
    }
    out
}

impl Tx<'_> {
    fn list_copy(&mut self, src: &Tab, window: &WindowId, profile: &ProfileId) -> TabId {
        let id = self.ids.tab();
        let mut t = Tab::new(
            id.clone(),
            window.clone(),
            profile.clone(),
            src.url.clone(),
            self.now,
        );
        t.title = src.title.clone();
        t.favicon = src.favicon.clone();
        t.custom_title = src.custom_title.clone();
        t.custom_icon = src.custom_icon.clone();
        t.tile_letters = src.tile_letters.clone();
        t.muted = src.muted;
        t.zoom = src.zoom;
        t.pin_key = Some(src.pin_key().to_owned());
        t.page = TabPage::IDLE;
        t.last_active_at = src.last_active_at;
        t.restored_at = src.restored_at;
        t.unseen = false;
        Arc::make_mut(&mut self.s.tabs).insert(id.clone(), Arc::new(t));
        self.note_tab(&id, Topics::TABS, false);
        id
    }

    fn keep_shown_profile(&mut self, window: &WindowId, gone: &[TabId]) {
        let Some(w) = self.s.windows.get(window).cloned() else {
            return;
        };
        if !w.tab_ids.iter().any(|id| gone.contains(id)) {
            return;
        }
        let rest = w.tab_ids.iter().any(|id| !gone.contains(id));
        let awake_here = w.tab_ids.iter().any(|id| {
            !gone.contains(id)
                && self
                    .s
                    .tabs
                    .get(id)
                    .is_some_and(|t| t.profile_id == w.profile_id && !t.page.is_asleep())
        });
        if rest && awake_here {
            return;
        }
        let _ = self.new_tab(
            window,
            NewTab {
                profile: Some(w.profile_id.clone()),
                background: true,
                ..NewTab::default()
            },
        );
    }

    fn swap_places(&mut self, a: &TabId, b: &TabId) {
        let (Some(ta), Some(tb)) = (self.s.tabs.get(a).cloned(), self.s.tabs.get(b).cloned())
        else {
            return;
        };
        let key = ta.pin_key().to_owned();
        let moved = ta.window_id != tb.window_id;
        let swap = |ids: &[TabId]| -> Option<Vec<TabId>> {
            (ids.contains(a) || ids.contains(b)).then(|| {
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
                    .collect()
            })
        };
        let mut windows: Vec<WindowId> = vec![ta.window_id.clone()];
        if moved {
            windows.push(tb.window_id.clone());
        }
        for id in &windows {
            let Some(w) = self.s.windows.get(id).cloned() else {
                continue;
            };
            let tab_ids = swap(&w.tab_ids);
            if let Some(win) = self.window_mut(id) {
                if let Some(ids) = tab_ids {
                    win.tab_ids = ids;
                }
                if moved {
                    for x in win.active_tab_ids.values_mut() {
                        if x == a {
                            *x = b.clone();
                        } else if x == b {
                            *x = a.clone();
                        }
                    }
                }
            }
        }
        let mut groups = (*self.s.groups).clone();
        let mut regrouped = false;
        for g in self.s.groups.values() {
            if let Some(ids) = swap(&g.tab_ids) {
                let mut edited = (**g).clone();
                edited.tab_ids = ids;
                groups.insert(g.id.clone(), Arc::new(edited));
                regrouped = true;
            }
        }
        if regrouped {
            self.set_groups(groups);
        }
        let _ = self.edit_tab(a, Topics::TABS, false, |e| {
            e.window_id = tb.window_id.clone();
            e.pin = tb.pin.clone();
            e.pinned_url = tb.pinned_url.clone();
            e.pin_key = key_field(a.as_str(), &key);
        });
        let _ = self.edit_tab(b, Topics::TABS, false, |e| {
            e.window_id = ta.window_id.clone();
            e.pin = ta.pin.clone();
            e.pinned_url = ta.pinned_url.clone();
            e.pin_key = key_field(b.as_str(), &key);
        });
        let touched: Vec<SplitId> = self
            .s
            .splits
            .values()
            .filter(|v| v.tab_ids().iter().any(|t| t == a || t == b))
            .map(|v| v.id.clone())
            .collect();
        if !touched.is_empty() {
            let splits = Arc::make_mut(&mut self.s.splits);
            for id in &touched {
                if let Some(v) = splits.get_mut(id)
                    && let Some(ids) = swap(&v.tab_ids())
                {
                    *v = Arc::new(v.with_pane_ids(&ids));
                }
            }
            self.out.changes.note(Topics::SPLITS, false);
        }
    }

    fn keep_leaving_pages(
        &mut self,
        window: &WindowId,
        profile: &ProfileId,
        spec: &Section,
        source: Option<&WindowId>,
    ) {
        let Some(w) = self.s.windows.get(window).cloned() else {
            return;
        };
        let wanted: HashSet<String> = spec
            .items
            .iter()
            .map(|i| i.tab.pin_key().to_owned())
            .collect();
        let section = list_section(self.s, &w, profile);
        let in_list: HashSet<TabId> = section.items.iter().map(|i| i.tab.id.clone()).collect();
        for item in &section.items {
            let t = &item.tab;
            if !t.page.has_page() || wanted.contains(t.pin_key()) {
                continue;
            }
            let key = t.pin_key().to_owned();
            let pageless = |s: &BrowserState, id: &WindowId| -> Option<TabId> {
                s.windows.get(id)?.tab_ids.iter().find_map(|x| {
                    let u = s.tabs.get(x)?;
                    (u.id != t.id
                        && !in_list.contains(&u.id)
                        && u.profile_id == t.profile_id
                        && u.pin_key() == key
                        && !u.page.has_page())
                    .then(|| u.id.clone())
                })
            };
            let place = pageless(self.s, window).or_else(|| {
                source
                    .filter(|src| *src != window)
                    .and_then(|src| pageless(self.s, src))
            });
            if let Some(place) = place {
                self.swap_places(&t.id, &place);
            }
        }
    }

    pub(crate) fn pages_into_splits(&mut self, prev: &BrowserState) {
        if !shares_tabs(self.s) || Arc::ptr_eq(&self.s.splits, &prev.splits) {
            return;
        }
        let panes: Vec<TabId> = self.s.splits.values().flat_map(|v| v.tab_ids()).collect();
        for id in panes {
            let Some(t) = self.s.tabs.get(&id).cloned() else {
                continue;
            };
            let Some(holder_id) = crate::pin_share::holder_of_page(Some(&t)).cloned() else {
                continue;
            };
            let listed = crate::pin_share::shared_list_tab(self.s, &t)
                || prev
                    .tabs
                    .get(&id)
                    .is_some_and(|was| crate::pin_share::shared_list_tab(prev, was));
            if !listed {
                continue;
            }
            let Some(holder) = self.s.tabs.get(&holder_id).cloned() else {
                continue;
            };
            if holder.pin.is_some()
                || !holder.page.has_page()
                || holder.window_id == t.window_id
                || holder.profile_id != t.profile_id
                || holder.pin_key() != t.pin_key()
                || self.s.split_of(holder.id.as_str()).is_some()
            {
                continue;
            }
            let window = holder.window_id.clone();
            self.swap_places(&holder.id, &t.id);
            self.keep_shown_profile(&window, std::slice::from_ref(&t.id));
            self.remove_tabs(std::slice::from_ref(&t.id), false);
        }
    }

    fn conform_list(
        &mut self,
        window: &WindowId,
        profile: &ProfileId,
        spec: &Section,
        leaving: Leaving,
        source: Option<&WindowId>,
    ) {
        if leaving == Leaving::Close {
            self.keep_leaving_pages(window, profile, spec, source);
        }
        let Some(w) = self.s.windows.get(window).cloned() else {
            return;
        };
        let cur = list_section(self.s, &w, profile);
        let mine: Vec<Arc<Tab>> = cur.items.iter().map(|i| Arc::clone(&i.tab)).collect();
        let mut used: HashSet<TabId> = HashSet::new();
        let order = tree_order(spec);
        let mut placed: Vec<TabId> = Vec::new();
        for item in &order {
            let src = &item.tab;
            let key = src.pin_key().to_owned();
            let same: Vec<&Arc<Tab>> = mine
                .iter()
                .filter(|m| m.pin_key() == key && !used.contains(&m.id))
                .collect();
            let found = same
                .iter()
                .find(|m| m.page.has_page())
                .or_else(|| same.first())
                .map(|m| Arc::clone(m));
            let id = match found {
                None => self.list_copy(src, window, profile),
                Some(t) => {
                    let follows = !has_own_or_shared_page(&t);
                    let differs = key_field(t.id.as_str(), &key) != t.pin_key
                        || t.custom_title != src.custom_title
                        || t.custom_icon != src.custom_icon
                        || t.tile_letters != src.tile_letters
                        || (follows
                            && (t.url != src.url
                                || t.title != src.title
                                || t.favicon != src.favicon));
                    if differs {
                        let _ = self.edit_tab(&t.id, Topics::TABS, false, |e| {
                            e.pin_key = key_field(e.id.as_str(), &key);
                            e.custom_title = src.custom_title.clone();
                            e.custom_icon = src.custom_icon.clone();
                            e.tile_letters = src.tile_letters.clone();
                            if follows {
                                e.url = src.url.clone();
                                e.title = src.title.clone();
                                e.favicon = src.favicon.clone();
                            }
                        });
                    }
                    t.id.clone()
                }
            };
            used.insert(id.clone());
            placed.push(id);
        }
        let mut within: IndexMap<String, Vec<TabId>> = IndexMap::new();
        for (item, id) in order.iter().zip(placed.iter()) {
            for key in chain_of(spec, item.group.as_deref()) {
                within.entry(key).or_default().push(id.clone());
            }
        }
        let out: Vec<&Arc<Tab>> = mine.iter().filter(|t| !used.contains(&t.id)).collect();
        let demoted: HashSet<TabId> = if leaving == Leaving::KeepPages {
            out.iter()
                .filter(|t| t.page.has_page())
                .map(|t| t.id.clone())
                .collect()
        } else {
            HashSet::new()
        };
        let gone: Vec<TabId> = out
            .iter()
            .filter(|t| !demoted.contains(&t.id))
            .map(|t| t.id.clone())
            .collect();
        for id in &demoted {
            let _ = self.edit_tab(id, Topics::TABS, false, |e| e.pin_key = None);
        }
        let section: HashSet<TabId> = mine
            .iter()
            .filter(|t| !demoted.contains(&t.id))
            .map(|t| t.id.clone())
            .collect();
        let kept: HashSet<TabId> = placed.iter().cloned().collect();
        let mut followers: IndexMap<Option<TabId>, Vec<TabId>> = IndexMap::new();
        let mut anchor: Option<TabId> = None;
        let current = self.s.windows[window].tab_ids.clone();
        for id in &current {
            if section.contains(id) && kept.contains(id) {
                anchor = Some(id.clone());
            }
            if section.contains(id) && !gone.contains(id) {
                continue;
            }
            followers
                .entry(anchor.clone())
                .or_default()
                .push(id.clone());
        }
        let mut ids: Vec<TabId> = followers.get(&None).cloned().unwrap_or_default();
        for id in &placed {
            ids.push(id.clone());
            ids.extend(
                followers
                    .get(&Some(id.clone()))
                    .cloned()
                    .unwrap_or_default(),
            );
        }
        let mut groups = (*self.s.groups).clone();
        let mut used_groups: HashSet<GroupId> = HashSet::new();
        let mut group_of: HashMap<String, GroupId> = HashMap::new();
        for (key, members) in &within {
            let Some(src) = spec.groups.get(key) else {
                continue;
            };
            let own = cur
                .own
                .iter()
                .find(|g| !used_groups.contains(&g.id) && g.pin_key() == key)
                .cloned();
            let id = own
                .as_ref()
                .map_or_else(|| self.ids.group(), |g| g.id.clone());
            used_groups.insert(id.clone());
            group_of.insert(key.clone(), id.clone());
            let outside: Vec<TabId> = own
                .as_ref()
                .map(|g| {
                    g.tab_ids
                        .iter()
                        .filter(|x| !section.contains(*x) && ids.contains(*x))
                        .cloned()
                        .collect()
                })
                .unwrap_or_default();
            let mut g = own.map(|g| (*g).clone()).unwrap_or_else(|| {
                let mut g = TabGroup::new(
                    id.clone(),
                    window.clone(),
                    profile.clone(),
                    Vec::new(),
                    self.now,
                );
                g.collapsed = src.group.collapsed;
                g.auto_ungroup = src.group.auto_ungroup;
                g
            });
            g.pin_key = key_field(id.as_str(), key);
            g.name = src.group.name.clone();
            g.icon = src.group.icon.clone();
            g.color = src.group.color;
            g.pinned = false;
            g.tab_ids = members.iter().chain(outside.iter()).cloned().collect();
            g.parent_id = src.parent.as_ref().and_then(|p| group_of.get(p).cloned());
            groups.insert(id, Arc::new(g));
        }
        let mut leftover: HashSet<GroupId> = HashSet::new();
        for g in &cur.own {
            if used_groups.contains(&g.id) {
                continue;
            }
            let left: Vec<TabId> = g
                .tab_ids
                .iter()
                .filter(|x| (!section.contains(*x) || demoted.contains(*x)) && ids.contains(*x))
                .cloned()
                .collect();
            if left.is_empty() {
                groups.shift_remove(&g.id);
            } else {
                let mut edited = (**g).clone();
                edited.pin_key = None;
                edited.tab_ids = left;
                groups.insert(g.id.clone(), Arc::new(edited));
                leftover.insert(g.id.clone());
            }
        }
        for id in &leftover {
            if let Some(g) = groups.get(id).cloned()
                && g.parent_id
                    .as_ref()
                    .is_some_and(|p| !groups.contains_key(p))
            {
                let mut edited = (*g).clone();
                edited.parent_id = None;
                groups.insert(id.clone(), Arc::new(edited));
            }
        }
        if groups != *self.s.groups {
            self.set_groups(groups);
        }
        if ids != current
            && let Some(win) = self.window_mut(window)
        {
            win.tab_ids = ids;
        }
        self.reorder_window(window);
        if !gone.is_empty() {
            self.keep_shown_profile(window, &gone);
            self.remove_tabs(&gone, false);
            self.reorder_window(window);
        }
    }

    fn link_list_copies(&mut self, by_profile: &IndexMap<ProfileId, Vec<WindowId>>) {
        let member = ListMember::of(self.s);
        let mut holders: HashMap<String, Arc<Tab>> = HashMap::new();
        let mut copies: Vec<Arc<Tab>> = Vec::new();
        let mut asleep: Vec<Arc<Tab>> = Vec::new();
        for (profile, ids) in by_profile {
            for id in ids {
                let Some(w) = self.s.windows.get(id).cloned() else {
                    continue;
                };
                for item in list_section_with(self.s, &w, profile, &member).items {
                    let tab = item.tab;
                    if tab.page.is_asleep() {
                        asleep.push(Arc::clone(&tab));
                    }
                    if ids.len() < 2 {
                        continue;
                    }
                    if tab.page.has_page() {
                        let key = family_key(&tab);
                        if holders
                            .get(&key)
                            .is_none_or(|was| tab.last_active_at > was.last_active_at)
                        {
                            holders.insert(key, tab);
                        }
                    } else if !has_own_or_shared_page(&tab) {
                        copies.push(tab);
                    }
                }
            }
        }
        for t in asleep {
            let _ = self.edit_tab(&t.id, Topics::TABS, false, |e| {
                e.page = TabPage {
                    kind: PageKind::Idle,
                    wake: e.page.wake.clone(),
                };
            });
        }
        for c in copies {
            let Some(holder) = holders.get(&family_key(&c)).cloned() else {
                continue;
            };
            if holder.window_id == c.window_id {
                continue;
            }
            let _ = self.edit_tab(&c.id, Topics::TABS, false, |e| {
                e.url = holder.url.clone();
                e.title = holder.title.clone();
                e.favicon = holder.favicon.clone();
                e.muted = holder.muted;
                e.page = crate::pin_share::frozen_on(e, &holder.id);
            });
        }
    }

    pub(crate) fn mirror_tabs(&mut self, prev: &BrowserState) {
        if !shares_tabs(self.s) {
            return;
        }
        let turned_on = !shares_tabs(prev);
        if !turned_on && !list_may_differ(self.s, prev) {
            return;
        }
        let groups_by_profile = by_profile(self.s);
        for (profile, ids) in &groups_by_profile {
            for id in ids {
                let Some(w) = self.s.windows.get(id).cloned() else {
                    continue;
                };
                let x = list_section(self.s, &w, profile);
                if has_duplicates(&x) {
                    let spec = union(std::slice::from_ref(&x), false);
                    self.conform_list(id, profile, &spec, Leaving::KeepPages, None);
                }
            }
        }
        for (profile, ids) in &groups_by_profile {
            if ids.len() < 2 {
                continue;
            }
            let member = ListMember::of(self.s);
            let sections: Vec<(WindowId, Section)> = ids
                .iter()
                .filter_map(|id| {
                    let w = self.s.windows.get(id)?.clone();
                    Some((id.clone(), list_section_with(self.s, &w, profile, &member)))
                })
                .collect();
            let sigs: Vec<String> = sections.iter().map(|(_, x)| signature(x)).collect();
            if sigs.iter().all(|s| *s == sigs[0]) {
                continue;
            }
            let had = |id: &WindowId| {
                prev.windows.get(id).is_some_and(|w| {
                    w.kind == WindowKind::Main
                        && w.tab_ids
                            .iter()
                            .any(|t| prev.tabs.get(t).is_some_and(|t| &t.profile_id == profile))
                })
            };
            let before: Vec<usize> = if turned_on {
                Vec::new()
            } else {
                (0..sections.len())
                    .filter(|i| had(&sections[*i].0))
                    .collect()
            };
            let source = before.iter().copied().find(|i| {
                let id = &sections[*i].0;
                let was = signature(&list_section(prev, &prev.windows[id], profile));
                was != sigs[*i]
            });
            let spec = match source {
                Some(i) => sections[i].1.clone(),
                None => {
                    let mut ordered: Vec<usize> = if turned_on {
                        let mut all: Vec<usize> = (0..sections.len()).collect();
                        let rank = |i: &usize| {
                            self.s
                                .window_order
                                .iter()
                                .position(|w| *w == sections[*i].0)
                                .unwrap_or(usize::MAX)
                        };
                        all.sort_by_key(rank);
                        all
                    } else {
                        before.clone()
                    };
                    if !turned_on {
                        ordered.extend((0..sections.len()).filter(|i| !before.contains(i)));
                    }
                    let parts: Vec<Section> =
                        ordered.iter().map(|i| sections[*i].1.clone()).collect();
                    union(&parts, false)
                }
            };
            let want = source.map(|i| sigs[i].clone());
            let leaving = if source.is_some() {
                Leaving::Close
            } else {
                Leaving::KeepPages
            };
            let source_window = source.map(|i| sections[i].0.clone());
            for (i, (id, _)) in sections.iter().enumerate() {
                if Some(i) == source
                    || want.as_ref().is_some_and(|w| *w == sigs[i])
                    || !self.s.windows.contains_key(id)
                {
                    continue;
                }
                self.conform_list(id, profile, &spec, leaving, source_window.as_ref());
            }
        }
        let latest = by_profile(self.s);
        self.link_list_copies(&latest);
    }

    pub(crate) fn unshare_tabs(&mut self, prev: &BrowserState) {
        if shares_tabs(self.s) || !shares_tabs(prev) {
            return;
        }
        let member = ListMember::of(self.s);
        let rank: HashMap<WindowId, usize> = self
            .s
            .focus_order
            .iter()
            .chain(self.s.window_order.iter())
            .fold(Vec::<WindowId>::new(), |mut seen, id| {
                if !seen.contains(id) {
                    seen.push(id.clone());
                }
                seen
            })
            .into_iter()
            .enumerate()
            .map(|(i, id)| (id, i))
            .collect();
        let mut families: IndexMap<String, Vec<Arc<Tab>>> = IndexMap::new();
        for t in self.s.tabs.values() {
            if !is_regular(self.s.windows.get(&t.window_id)) || !member.holds(t) {
                continue;
            }
            families
                .entry(family_key(t))
                .or_default()
                .push(Arc::clone(t));
        }
        let at = |t: &Tab| rank.get(&t.window_id).copied().unwrap_or(usize::MAX);
        let mut gone: Vec<TabId> = Vec::new();
        let mut cleared: Vec<TabId> = Vec::new();
        for family in families.values() {
            let keeper = family
                .iter()
                .find(|t| t.page.has_page())
                .or_else(|| family.iter().min_by_key(|t| at(t)))
                .map(|t| t.id.clone());
            for t in family {
                if Some(&t.id) != keeper.as_ref() {
                    gone.push(t.id.clone());
                } else if t.pin_key.is_some() || matches!(t.page.kind, PageKind::Frozen { .. }) {
                    cleared.push(t.id.clone());
                }
            }
        }
        for id in &cleared {
            let _ = self.edit_tab(id, Topics::TABS, false, |e| {
                e.pin_key = None;
                if matches!(e.page.kind, PageKind::Frozen { .. }) {
                    e.page = TabPage {
                        kind: PageKind::Idle,
                        wake: e.page.wake.clone(),
                    };
                }
            });
        }
        let mut groups = (*self.s.groups).clone();
        let mut regrouped = false;
        for g in self.s.groups.values() {
            if !g.pinned && g.pin_key.is_some() {
                let mut edited = (**g).clone();
                edited.pin_key = None;
                groups.insert(g.id.clone(), Arc::new(edited));
                regrouped = true;
            }
        }
        if regrouped {
            self.set_groups(groups);
        }
        if gone.is_empty() {
            return;
        }
        let windows: Vec<WindowId> = self.s.windows.keys().cloned().collect();
        for w in &windows {
            self.keep_shown_profile(w, &gone);
        }
        self.remove_tabs(&gone, false);
    }

    pub(crate) fn hand_over_tabs(&mut self, window: &WindowId) {
        let ids = crate::tab_share::tabs_handed_over(self.s, window);
        let Some(heir) = crate::tab_share::heir_window(self.s, window) else {
            return;
        };
        let Some(w) = self.s.windows.get(window).cloned() else {
            return;
        };
        if ids.is_empty() {
            return;
        }
        let moving: HashSet<TabId> = ids.iter().cloned().collect();
        for id in &ids {
            let _ = self.edit_tab(id, Topics::TABS, false, |e| e.window_id = heir.clone());
        }
        let mut groups = (*self.s.groups).clone();
        let mut regrouped = false;
        for g in self.s.groups.values() {
            if g.window_id == *window
                && !g.pinned
                && !g.tab_ids.is_empty()
                && g.tab_ids.iter().all(|t| moving.contains(t))
            {
                let mut edited = (**g).clone();
                edited.window_id = heir.clone();
                groups.insert(g.id.clone(), Arc::new(edited));
                regrouped = true;
            }
        }
        if regrouped {
            self.set_groups(groups);
        }
        let moved_splits: Vec<SplitId> = self
            .s
            .splits
            .values()
            .filter(|v| v.window_id == *window && v.tab_ids().iter().all(|t| moving.contains(t)))
            .map(|v| v.id.clone())
            .collect();
        if !moved_splits.is_empty() {
            let splits = Arc::make_mut(&mut self.s.splits);
            for id in &moved_splits {
                if let Some(v) = splits.get_mut(id) {
                    let mut edited = (**v).clone();
                    edited.window_id = heir.clone();
                    *v = Arc::new(edited);
                }
            }
            self.out.changes.note(Topics::SPLITS, false);
        }
        let mut chosen: Vec<(ProfileId, TabId)> = Vec::new();
        for id in &ids {
            let Some(profile) = self.s.tabs.get(id).map(|t| t.profile_id.clone()) else {
                continue;
            };
            if chosen.iter().any(|(p, _)| *p == profile) {
                continue;
            }
            let was = w
                .active_tab_ids
                .get(&profile)
                .filter(|a| moving.contains(*a))
                .cloned();
            chosen.push((profile, was.unwrap_or_else(|| id.clone())));
        }
        if let Some(h) = self.window_mut(&heir) {
            h.tab_ids.extend(ids.iter().cloned());
            for (profile, tab) in chosen {
                h.active_tab_ids.entry(profile).or_insert(tab);
            }
        }
        if let Some(left) = self.window_mut(window) {
            left.tab_ids.retain(|t| !moving.contains(t));
            left.active_tab_ids.retain(|_, t| !moving.contains(t));
        }
        self.reorder_window(&heir);
    }
}

#[cfg(test)]
mod tests {
    use crate::actions::Tx;
    use crate::groups::TabGroup;
    use crate::model::PageKind;
    use crate::settings::SettingsPatch;
    use crate::windows::WindowKind;
    use crate::{Action, BrowserState, IdGen, NewTab, TabId, WindowId};
    use std::sync::Arc;

    fn act(s: &mut BrowserState, ids: &IdGen, action: Action) -> crate::actions::Outcome {
        s.apply(action, 0, ids).unwrap()
    }

    fn open(s: &mut BrowserState, ids: &IdGen) -> WindowId {
        act(
            s,
            ids,
            Action::OpenWindow {
                kind: WindowKind::Main,
                profile: None,
                url: None,
                frame: None,
            },
        )
        .window
        .unwrap()
    }

    #[test]
    fn a_page_leaving_the_list_moves_onto_its_pageless_twin() {
        let ids = IdGen::with_launch("leave");
        let mut s = BrowserState::default();
        let a = open(&mut s, &ids);
        let b = open(&mut s, &ids);
        act(
            &mut s,
            &ids,
            Action::UpdateSettings {
                patch: SettingsPatch::new().set("shareTabsAcrossWindows", true),
                from_sync: false,
            },
        );
        let page = act(
            &mut s,
            &ids,
            Action::NewTab {
                window: a.clone(),
                tab: NewTab {
                    url: Some("https://page.com".into()),
                    ..NewTab::default()
                },
            },
        )
        .tab
        .unwrap();
        let copy: TabId = s.windows[&b]
            .tab_ids
            .iter()
            .find(|t| s.tabs[*t].pin_key() == page.as_str() && **t != page)
            .cloned()
            .unwrap();
        assert!(s.tabs[&page].page.has_page());
        let prev = s.clone();
        let mut next = s.clone();
        let folder = ids.group();
        let profile = s.windows[&b].profile_id.clone();
        let mut group = TabGroup::new(folder.clone(), b.clone(), profile, vec![copy.clone()], 0);
        group.pinned = true;
        Arc::make_mut(&mut next.groups).insert(folder.clone(), Arc::new(group));
        let mut tx = Tx::new(&mut next, 0, &ids);
        tx.mirror_tabs(&prev);
        let moved = &next.tabs[&page];
        assert_eq!(moved.window_id, b, "the live page takes the folder's place");
        assert!(moved.page.has_page());
        assert!(next.groups[&folder].tab_ids.contains(&page));
        assert!(
            !next.tabs.contains_key(&copy)
                || !matches!(next.tabs[&copy].page.kind, PageKind::Loaded),
            "the pageless twin never keeps a page of its own"
        );
        assert!(
            next.windows[&a]
                .tab_ids
                .iter()
                .all(|t| next.tabs[t].pin_key() != page.as_str()),
            "the tab leaves the other window's list"
        );
    }
}
