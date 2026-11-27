use super::*;
use crate::omnibox::url::same_page;

#[derive(Clone, Debug)]
pub(crate) struct Item {
    pub tab: Arc<Tab>,
    pub group: Option<String>,
}

#[derive(Clone, Debug)]
pub(crate) struct GroupSpec {
    pub group: Arc<TabGroup>,
    pub parent: Option<String>,
}

#[derive(Clone, Debug, Default)]
pub(crate) struct Section {
    pub items: Vec<Item>,
    pub groups: IndexMap<String, GroupSpec>,
    pub own: Vec<Arc<TabGroup>>,
    pub duplicate: bool,
}

pub(crate) fn pin_home(tab: &Tab) -> &str {
    tab.pinned_url
        .as_deref()
        .filter(|u| !u.is_empty())
        .unwrap_or(tab.url.as_str())
}

pub(super) fn is_regular(w: Option<&Arc<BrowserWindow>>) -> bool {
    w.is_some_and(|w| w.kind == WindowKind::Main)
}

fn group_depth(groups: &groups::Groups, id: &GroupId) -> usize {
    let mut depth = 0;
    let mut at = groups.get(id).and_then(|g| g.parent_id.clone());
    while let Some(parent) = at {
        depth += 1;
        if depth > 64 {
            break;
        }
        at = groups.get(&parent).and_then(|g| g.parent_id.clone());
    }
    depth
}

pub(super) fn innermost_pinned(
    groups: &groups::Groups,
    own: &[Arc<TabGroup>],
) -> HashMap<TabId, Arc<TabGroup>> {
    let mut sorted: Vec<&Arc<TabGroup>> = own.iter().collect();
    sorted.sort_by_key(|g| group_depth(groups, &g.id));
    let mut inner = HashMap::new();
    for g in sorted {
        for id in &g.tab_ids {
            inner.insert(id.clone(), Arc::clone(g));
        }
    }
    inner
}

pub(super) fn pinned_chain(
    groups: &groups::Groups,
    g: &Arc<TabGroup>,
    own_ids: &HashSet<GroupId>,
) -> Vec<Arc<TabGroup>> {
    let mut chain = vec![Arc::clone(g)];
    let mut at = g.parent_id.clone();
    let mut guard = 0;
    while let Some(parent) = at {
        guard += 1;
        if guard > 64 {
            break;
        }
        let Some(p) = groups.get(&parent) else {
            break;
        };
        if own_ids.contains(&parent) {
            chain.insert(0, Arc::clone(p));
        }
        at = p.parent_id.clone();
    }
    chain
}

pub(crate) fn section_of(s: &BrowserState, w: &BrowserWindow, profile: &ProfileId) -> Section {
    let mine: Vec<Arc<TabGroup>> = s
        .groups
        .values()
        .filter(|g| g.pinned && g.window_id == w.id && g.profile_id == *profile)
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
        if t.profile_id != *profile {
            continue;
        }
        let g = if t.pin.is_some() {
            None
        } else {
            inner.get(id).cloned()
        };
        if t.pin.is_none() && g.is_none() {
            continue;
        }
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

pub(crate) fn chain_of(x: &Section, key: Option<&str>) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    let mut at = key.map(str::to_owned);
    while let Some(k) = at {
        if out.contains(&k) {
            break;
        }
        let Some(spec) = x.groups.get(&k) else {
            break;
        };
        out.insert(0, k.clone());
        at = spec.parent.clone();
    }
    out
}

fn tile_sig(t: &Tab) -> String {
    let folder = t.pin.as_ref().and_then(TabPin::folder);
    format!(
        "{}\u{1}{}\u{1}{}\u{1}{}\u{1}{}\u{1}{}\u{1}{}\u{1}{}\u{1}{}",
        t.pin_key(),
        t.pinned_url.as_deref().unwrap_or(""),
        t.custom_title.as_deref().unwrap_or(""),
        t.custom_icon.as_deref().unwrap_or(""),
        t.tile_letters.as_deref().unwrap_or(""),
        if t.pin == Some(TabPin::Row) { "r" } else { "" },
        folder.map(|f| f.id.as_str()).unwrap_or(""),
        folder.map(|f| f.name.as_str()).unwrap_or(""),
        folder
            .and_then(|f| f.renamed_at)
            .map(|r| r.to_string())
            .unwrap_or_default(),
    )
}

fn member_sig(t: &Tab) -> String {
    format!(
        "{}\u{1}{}\u{1}{}\u{1}{}\u{1}{}",
        t.pin_key(),
        t.pinned_url.as_deref().unwrap_or(""),
        t.custom_title.as_deref().unwrap_or(""),
        t.custom_icon.as_deref().unwrap_or(""),
        t.tile_letters.as_deref().unwrap_or(""),
    )
}

pub(crate) fn signature(x: &Section) -> String {
    let mut shown: HashSet<String> = HashSet::new();
    let mut lines: Vec<String> = Vec::new();
    for item in &x.items {
        for key in chain_of(x, item.group.as_deref()) {
            if !shown.insert(key.clone()) {
                continue;
            }
            let spec = &x.groups[&key];
            let g = &spec.group;
            lines.push(format!(
                "G{key}\u{1}{}\u{1}{}\u{1}{}\u{1}{}",
                g.name,
                g.icon.as_deref().unwrap_or(""),
                g.color.map(|c| format!("{c:?}")).unwrap_or_default(),
                spec.parent.as_deref().unwrap_or(""),
            ));
        }
        lines.push(match item.group.as_deref() {
            Some(group) => format!("{}\u{2}{group}", member_sig(&item.tab)),
            None => tile_sig(&item.tab),
        });
    }
    lines.join("\n")
}

pub(super) fn has_duplicates(x: &Section) -> bool {
    let keys: HashSet<&str> = x.items.iter().map(|i| i.tab.pin_key()).collect();
    x.duplicate || keys.len() < x.items.len()
}

pub(crate) fn union(sections: &[Section], same_pages: bool) -> Section {
    let mut spec = Section::default();
    let mut keys: HashSet<String> = HashSet::new();
    for x in sections {
        let earlier: Vec<String> = spec
            .items
            .iter()
            .filter(|i| i.group.is_none())
            .map(|i| pin_home(&i.tab).to_owned())
            .collect();
        for (key, g) in &x.groups {
            if !spec.groups.contains_key(key) {
                spec.groups.insert(key.clone(), g.clone());
            }
        }
        let mut anchor: Option<usize> = None;
        for item in &x.items {
            let key = item.tab.pin_key().to_owned();
            if keys.contains(&key) {
                anchor = spec.items.iter().position(|i| i.tab.pin_key() == key);
                continue;
            }
            if same_pages
                && item.group.is_none()
                && earlier
                    .iter()
                    .any(|home| same_page(home, pin_home(&item.tab)))
            {
                continue;
            }
            keys.insert(key);
            let within =
                |i: &Item, k: &str| chain_of(&spec, i.group.as_deref()).iter().any(|c| c == k);
            let last_in = |k: &str| spec.items.iter().rposition(|i| within(i, k));
            let host = chain_of(&spec, item.group.as_deref())
                .into_iter()
                .rev()
                .find(|k| last_in(k).is_some());
            let at: Option<usize> = match host {
                Some(host) => match anchor {
                    Some(a) if within(&spec.items[a], &host) => Some(a),
                    _ => last_in(&host),
                },
                None => match anchor {
                    Some(a) => Some(a),
                    None if item.group.is_some() => spec.items.len().checked_sub(1),
                    None => spec.items.iter().rposition(|i| i.group.is_none()),
                },
            };
            let place = at.map_or(0, |a| a + 1);
            spec.items.insert(place, item.clone());
            anchor = Some(place);
        }
    }
    spec
}

pub(super) fn tree_order(x: &Section) -> Vec<Item> {
    enum Node {
        Leaf(usize),
        Group(String),
    }
    let mut kids: IndexMap<Option<String>, Vec<Node>> = IndexMap::new();
    let mut seen: HashSet<String> = HashSet::new();
    for (index, item) in x.items.iter().enumerate() {
        let chain = chain_of(x, item.group.as_deref());
        kids.entry(chain.last().cloned())
            .or_default()
            .push(Node::Leaf(index));
        for i in (0..chain.len()).rev() {
            if !seen.insert(chain[i].clone()) {
                break;
            }
            let parent = if i == 0 {
                None
            } else {
                Some(chain[i - 1].clone())
            };
            kids.entry(parent)
                .or_default()
                .push(Node::Group(chain[i].clone()));
        }
    }
    fn flat(
        parent: Option<String>,
        kids: &IndexMap<Option<String>, Vec<Node>>,
        x: &Section,
        out: &mut Vec<Item>,
        depth: usize,
    ) {
        if depth > 64 {
            return;
        }
        for node in kids.get(&parent).map(Vec::as_slice).unwrap_or_default() {
            match node {
                Node::Leaf(i) => out.push(x.items[*i].clone()),
                Node::Group(k) => flat(Some(k.clone()), kids, x, out, depth + 1),
            }
        }
    }
    let mut out = Vec::new();
    flat(None, &kids, x, &mut out, 0);
    out
}

pub(super) fn key_field(id: &str, key: &str) -> Option<String> {
    (id != key).then(|| key.to_owned())
}

pub(crate) fn pins_may_differ(s: &BrowserState, prev: &BrowserState) -> bool {
    if !Arc::ptr_eq(&s.groups, &prev.groups) {
        return true;
    }
    if !Arc::ptr_eq(&s.windows, &prev.windows) {
        let alike = s.windows.len() == prev.windows.len()
            && s.windows.iter().all(|(id, w)| {
                prev.windows.get(id).is_some_and(|b| {
                    Arc::ptr_eq(w, b)
                        || (w.tab_ids == b.tab_ids
                            && w.profile_id == b.profile_id
                            && w.kind == b.kind)
                })
            });
        if !alike {
            return true;
        }
    }
    if Arc::ptr_eq(&s.tabs, &prev.tabs) {
        return false;
    }
    let members = groups::pinned_group_members(&s.groups);
    let changed = s
        .tabs
        .iter()
        .filter(|(id, t)| prev.tabs.get(*id).is_none_or(|b| !Arc::ptr_eq(t, b)))
        .map(|(id, _)| id.clone())
        .chain(
            prev.tabs
                .keys()
                .filter(|id| !s.tabs.contains_key(*id))
                .cloned(),
        );
    for id in changed {
        match (s.tabs.get(&id), prev.tabs.get(&id)) {
            (Some(a), Some(b)) => {
                if a.pin != b.pin
                    || a.pinned_url != b.pinned_url
                    || a.custom_title != b.custom_title
                    || a.custom_icon != b.custom_icon
                    || a.tile_letters != b.tile_letters
                    || a.profile_id != b.profile_id
                    || a.window_id != b.window_id
                    || a.pin_key != b.pin_key
                {
                    return true;
                }
            }
            (a, b) => {
                if a.is_some_and(|t| t.pin.is_some())
                    || b.is_some_and(|t| t.pin.is_some())
                    || members.contains(&id)
                {
                    return true;
                }
            }
        }
    }
    false
}

impl Tx<'_> {
    fn copy_of(&mut self, src: &Tab, window: &WindowId, profile: &ProfileId, tile: bool) -> TabId {
        let url = if tile {
            pin_home(src).to_owned()
        } else {
            src.url.clone()
        };
        let at_source = same_page(&src.url, &url);
        let id = self.ids.tab();
        let mut t = Tab::new(id.clone(), window.clone(), profile.clone(), url, self.now);
        t.title = if at_source {
            src.title.clone()
        } else {
            String::new()
        };
        t.favicon = if at_source { src.favicon.clone() } else { None };
        t.pin = if tile {
            Some(src.pin.clone().unwrap_or(TabPin::TILE))
        } else {
            None
        };
        t.pinned_url = src
            .pinned_url
            .clone()
            .filter(|u| !u.is_empty())
            .or_else(|| tile.then(|| src.url.clone()))
            .filter(|u| !u.is_empty());
        t.custom_title = src.custom_title.clone();
        t.custom_icon = src.custom_icon.clone();
        t.tile_letters = src.tile_letters.clone();
        t.muted = src.muted;
        t.zoom = src.zoom;
        t.pin_key = Some(src.pin_key().to_owned());
        t.page = TabPage::ASLEEP;
        t.unseen = false;
        Arc::make_mut(&mut self.s.tabs).insert(id.clone(), Arc::new(t));
        self.note_tab(&id, Topics::TABS, false);
        id
    }

    fn conform(&mut self, window: &WindowId, profile: &ProfileId, spec: &Section) {
        let Some(w) = self.s.windows.get(window).cloned() else {
            return;
        };
        let cur = section_of(self.s, &w, profile);
        let mine: Vec<Arc<Tab>> = cur.items.iter().map(|i| Arc::clone(&i.tab)).collect();
        let wanted: HashSet<String> = spec
            .items
            .iter()
            .map(|i| i.tab.pin_key().to_owned())
            .collect();
        let mut used: HashSet<TabId> = HashSet::new();
        let order = tree_order(spec);
        let mut local: Vec<TabId> = Vec::new();
        for item in &order {
            let tile = item.group.is_none();
            let src = &item.tab;
            let key = src.pin_key().to_owned();
            let same: Vec<&Arc<Tab>> = mine
                .iter()
                .filter(|m| m.pin_key() == key && !used.contains(&m.id))
                .collect();
            let mut found = same
                .iter()
                .find(|m| m.page.has_page())
                .or_else(|| same.first())
                .map(|m| Arc::clone(m));
            if found.is_none() && tile {
                found = mine
                    .iter()
                    .find(|m| {
                        m.pin.is_some()
                            && !used.contains(&m.id)
                            && !wanted.contains(m.pin_key())
                            && same_page(pin_home(m), pin_home(src))
                    })
                    .cloned();
            }
            let id = match found {
                None => {
                    let id = self.copy_of(src, window, profile, tile);
                    used.insert(id.clone());
                    id
                }
                Some(t) => {
                    used.insert(t.id.clone());
                    let pinned_url = src
                        .pinned_url
                        .clone()
                        .filter(|u| !u.is_empty())
                        .or_else(|| tile.then(|| src.url.clone()))
                        .filter(|u| !u.is_empty());
                    let relocate = tile && !t.page.has_page() && !same_page(&t.url, pin_home(src));
                    let home = pin_home(src).to_owned();
                    let _ = self.edit_tab(&t.id, Topics::TABS, false, |e| {
                        e.pin_key = key_field(e.id.as_str(), &key);
                        e.pin = if tile {
                            Some(src.pin.clone().unwrap_or(TabPin::TILE))
                        } else {
                            None
                        };
                        e.custom_title = src.custom_title.clone();
                        e.custom_icon = src.custom_icon.clone();
                        e.tile_letters = src.tile_letters.clone();
                        e.pinned_url = pinned_url;
                        if relocate {
                            e.url = home;
                            e.title = src.title.clone();
                            e.favicon = src.favicon.clone();
                        }
                    });
                    t.id.clone()
                }
            };
            local.push(id);
        }
        let mut within: IndexMap<String, Vec<TabId>> = IndexMap::new();
        for (item, id) in order.iter().zip(local.iter()) {
            for key in chain_of(spec, item.group.as_deref()) {
                within.entry(key).or_default().push(id.clone());
            }
        }
        let mut groups = (*self.s.groups).clone();
        let mut used_groups: HashSet<GroupId> = HashSet::new();
        let mut group_of: HashMap<String, GroupId> = HashMap::new();
        for (key, tab_ids) in &within {
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
            let mut g = own.map(|g| (*g).clone()).unwrap_or_else(|| {
                let mut g = TabGroup::new(
                    id.clone(),
                    window.clone(),
                    profile.clone(),
                    Vec::new(),
                    self.now,
                );
                g.collapsed = src.group.collapsed;
                g
            });
            g.pin_key = key_field(id.as_str(), key);
            g.name = src.group.name.clone();
            g.icon = src.group.icon.clone();
            g.color = src.group.color;
            g.pinned = true;
            g.tab_ids = tab_ids.clone();
            g.parent_id = src.parent.as_ref().and_then(|p| group_of.get(p).cloned());
            groups.insert(id, Arc::new(g));
        }
        let shown: HashSet<TabId> = w.active_tab_ids.values().cloned().collect();
        let leaving: Vec<Arc<Tab>> = mine
            .iter()
            .filter(|t| !used.contains(&t.id))
            .cloned()
            .collect();
        let off_screen_copy = |t: &Tab| {
            matches!(t.page.kind, PageKind::Frozen { .. }) && t.profile_id != w.profile_id
        };
        let demoted: Vec<TabId> = leaving
            .iter()
            .filter(|t| t.page.has_page() || (shown.contains(&t.id) && !off_screen_copy(t)))
            .map(|t| t.id.clone())
            .collect();
        let gone: Vec<TabId> = leaving
            .iter()
            .filter(|t| !demoted.contains(&t.id))
            .map(|t| t.id.clone())
            .collect();
        for id in &demoted {
            let _ = self.edit_tab(id, Topics::TABS, false, |e| {
                e.pin = None;
                e.pinned_url = None;
                e.pin_key = None;
            });
        }
        let stays: HashSet<TabId> = demoted.iter().cloned().collect();
        let mut kept: HashSet<GroupId> = HashSet::new();
        for g in &cur.own {
            if used_groups.contains(&g.id) {
                continue;
            }
            let left: Vec<TabId> = g
                .tab_ids
                .iter()
                .filter(|t| stays.contains(*t))
                .cloned()
                .collect();
            if left.is_empty() {
                groups.shift_remove(&g.id);
            } else {
                let mut edited = (**g).clone();
                edited.pinned = false;
                edited.pin_key = None;
                edited.tab_ids = left;
                groups.insert(g.id.clone(), Arc::new(edited));
                kept.insert(g.id.clone());
            }
        }
        for id in &kept {
            let parent = groups.get(id).and_then(|g| g.parent_id.clone());
            if parent.is_some_and(|p| !kept.contains(&p))
                && let Some(g) = groups.get(id).cloned()
            {
                let mut edited = (*g).clone();
                edited.parent_id = None;
                groups.insert(id.clone(), Arc::new(edited));
            }
        }
        if groups != *self.s.groups {
            self.set_groups(groups);
        }
        let section: HashSet<TabId> = mine
            .iter()
            .map(|t| t.id.clone())
            .chain(local.iter().cloned())
            .collect();
        let current = self.s.windows[window].tab_ids.clone();
        let mut ids: Vec<TabId> = local.clone();
        ids.extend(demoted.iter().cloned());
        ids.extend(current.into_iter().filter(|id| !section.contains(id)));
        ids.extend(gone.iter().cloned());
        if let Some(win) = self.window_mut(window) {
            win.tab_ids = ids;
        }
        self.reorder_window(window);
        if !gone.is_empty() {
            self.remove_tabs(&gone, false);
            self.reorder_window(window);
        }
    }

    pub(crate) fn mirror_pins(&mut self, prev: &BrowserState) {
        if !pins_may_differ(self.s, prev) {
            return;
        }
        let mut order: Vec<WindowId> = Vec::new();
        for id in self.s.focus_order.iter().chain(self.s.window_order.iter()) {
            if !order.contains(id) && is_regular(self.s.windows.get(id)) {
                order.push(id.clone());
            }
        }
        let mut by_profile: IndexMap<ProfileId, Vec<WindowId>> = IndexMap::new();
        for id in &order {
            let w = &self.s.windows[id];
            let mut seen: HashSet<&ProfileId> = HashSet::new();
            for t in w.tab_ids.iter().filter_map(|t| self.s.tabs.get(t)) {
                if !t.profile_id.is_incognito() && seen.insert(&t.profile_id) {
                    by_profile
                        .entry(t.profile_id.clone())
                        .or_default()
                        .push(id.clone());
                }
            }
        }
        for (profile, ids) in &by_profile {
            for id in ids {
                let Some(w) = self.s.windows.get(id).cloned() else {
                    continue;
                };
                let x = section_of(self.s, &w, profile);
                if has_duplicates(&x) {
                    let spec = union(std::slice::from_ref(&x), true);
                    self.conform(id, profile, &spec);
                }
            }
        }
        for (profile, ids) in &by_profile {
            if ids.len() < 2 {
                continue;
            }
            let sections: Vec<(WindowId, Section)> = ids
                .iter()
                .filter_map(|id| {
                    let w = self.s.windows.get(id)?.clone();
                    Some((id.clone(), section_of(self.s, &w, profile)))
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
            let before: Vec<usize> = (0..sections.len())
                .filter(|i| had(&sections[*i].0))
                .collect();
            let source = before.iter().copied().find(|i| {
                let id = &sections[*i].0;
                let was = signature(&section_of(prev, &prev.windows[id], profile));
                was != sigs[*i]
            });
            let spec = match source {
                Some(i) => sections[i].1.clone(),
                None => {
                    let ordered: Vec<Section> = before
                        .iter()
                        .copied()
                        .chain((0..sections.len()).filter(|i| !before.contains(i)))
                        .map(|i| sections[i].1.clone())
                        .collect();
                    union(&ordered, true)
                }
            };
            let want = source.map(|i| sigs[i].clone());
            for (i, (id, _)) in sections.iter().enumerate() {
                if Some(i) == source
                    || want.as_ref().is_some_and(|w| *w == sigs[i])
                    || !self.s.windows.contains_key(id)
                {
                    continue;
                }
                self.conform(id, profile, &spec);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use crate::model::{PageKind, TabPin};
    use crate::windows::WindowKind;
    use crate::{Action, BrowserState, IdGen, NewTab, TabId, WindowId};

    fn tiles(s: &BrowserState, window: &WindowId) -> Vec<(String, String)> {
        s.windows[window]
            .tab_ids
            .iter()
            .filter_map(|t| s.tabs.get(t))
            .filter(|t| t.pin.is_some())
            .map(|t| (t.pin_key().to_owned(), t.url.clone()))
            .collect()
    }

    fn open(s: &mut BrowserState, ids: &IdGen) -> WindowId {
        s.apply(
            Action::OpenWindow {
                kind: WindowKind::Main,
                profile: None,
                url: None,
                frame: None,
            },
            0,
            ids,
        )
        .unwrap()
        .window
        .unwrap()
    }

    fn pin(s: &mut BrowserState, ids: &IdGen, window: &WindowId, url: &str) -> TabId {
        s.apply(
            Action::NewTab {
                window: window.clone(),
                tab: NewTab {
                    url: Some(url.into()),
                    pin: Some(TabPin::TILE),
                    background: true,
                    ..NewTab::default()
                },
            },
            0,
            ids,
        )
        .unwrap()
        .tab
        .unwrap()
    }

    #[test]
    fn a_new_window_gets_asleep_copies_of_the_pins() {
        let ids = IdGen::new(0);
        let (mut s, _) = BrowserState::hydrate(
            crate::persistence::session::SessionData::fresh(Default::default()),
            0,
        );
        let w1 = open(&mut s, &ids);
        let mail = pin(&mut s, &ids, &w1, "https://mail.example.com/");
        let w2 = open(&mut s, &ids);
        let copied = tiles(&s, &w2);
        assert_eq!(copied, tiles(&s, &w1));
        assert_eq!(copied.len(), 1);
        let copy = s.windows[&w2]
            .tab_ids
            .iter()
            .find(|t| s.tabs[*t].pin.is_some())
            .unwrap();
        assert_ne!(*copy, mail);
        assert_eq!(s.tabs[copy].page.kind, PageKind::Asleep);
        assert_eq!(s.tabs[copy].pin_key(), mail.as_str());
        let news = pin(&mut s, &ids, &w2, "https://news.example.com/");
        assert_eq!(tiles(&s, &w1).len(), 2);
        assert_eq!(tiles(&s, &w1), tiles(&s, &w2));
        s.apply(
            Action::CloseTabs {
                tabs: vec![news],
                last_closes_window: false,
            },
            0,
            &ids,
        )
        .ok();
        assert_eq!(tiles(&s, &w1), tiles(&s, &w2));
    }

    #[test]
    fn activating_the_copy_hands_the_live_page_over() {
        let ids = IdGen::new(0);
        let (mut s, _) = BrowserState::hydrate(
            crate::persistence::session::SessionData::fresh(Default::default()),
            0,
        );
        let w1 = open(&mut s, &ids);
        let mail = pin(&mut s, &ids, &w1, "https://mail.example.com/");
        s.apply(Action::ActivateTab { tab: mail.clone() }, 1, &ids)
            .unwrap();
        let w2 = open(&mut s, &ids);
        let copy = s.windows[&w2]
            .tab_ids
            .iter()
            .find(|t| s.tabs[*t].pin.is_some())
            .cloned()
            .unwrap();
        s.apply(Action::ActivateTab { tab: copy.clone() }, 2, &ids)
            .unwrap();
        assert_eq!(s.tabs[&mail].window_id, w2);
        assert!(matches!(s.tabs[&copy].page.kind, PageKind::Frozen { .. }));
        assert_eq!(tiles(&s, &w1).len(), 1);
        assert_eq!(tiles(&s, &w2).len(), 1);
    }
}
