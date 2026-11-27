use std::collections::{HashMap, HashSet};
use std::sync::Arc;

use ardia_state::closed::{ParkedGroup, ParkedPins, ParkedTab};
use ardia_state::groups::{self, Groups, TabGroup};
use ardia_state::model::{TabPage, TabPin};
use ardia_state::sync_engine::scope::ApplyRecords;
use ardia_state::sync_engine::{IndexMap, IndexSet};
use ardia_state::tabs::Tab;
use ardia_state::windows::{BrowserWindow, WindowKind};
use ardia_state::{BrowserState, GroupId, ProfileId, TabId, WindowId};
use serde_json::{Map, Value, json};

use super::small::arrange_window;
use super::{
    GROUP_LOOK, PIN_GROUP, PIN_NEST_GROUP, PIN_NEST_TAB, PIN_ORDER, PIN_ROW, PIN_TAB, ROW,
    anchor_in, home_window, looked_color, marked_tile, new_group_id, new_tab_id, pin_sync,
    synced_home,
};
use crate::sync_engine::adapters::CycleContext;

#[derive(Clone, Debug)]
struct PinValue {
    g: Option<String>,
    u: String,
    t: Option<String>,
    i: Option<String>,
    ti: String,
    pos: String,
}

#[derive(Clone, Debug)]
struct Look {
    n: String,
    i: Option<String>,
    c: Option<Value>,
    pos: Option<String>,
    p: Option<String>,
}

fn text(v: &Value, key: &str) -> Option<String> {
    v.get(key).and_then(Value::as_str).map(str::to_owned)
}

fn pin_value(v: &Value) -> PinValue {
    PinValue {
        g: text(v, "g"),
        u: text(v, "u").unwrap_or_default(),
        t: text(v, "t"),
        i: text(v, "i"),
        ti: text(v, "ti").unwrap_or_default(),
        pos: text(v, "pos").unwrap_or_default(),
    }
}

fn look_value(v: &Value) -> Look {
    Look {
        n: text(v, "n").unwrap_or_default(),
        i: text(v, "i"),
        c: v.get("c").cloned(),
        pos: text(v, "pos"),
        p: text(v, "p"),
    }
}

#[derive(Clone, Debug)]
struct Slot {
    id: String,
    group: bool,
    pos: String,
}

fn by_slot(a: &Slot, z: &Slot) -> std::cmp::Ordering {
    a.pos.cmp(&z.pos).then(a.id.cmp(&z.id))
}

struct Ids {
    tab_of_key: HashMap<String, String>,
    group_of_key: HashMap<String, String>,
    key_of_local: HashMap<String, String>,
}

impl Ids {
    fn local(&mut self, groups: bool, taken: bool, key: &str) -> String {
        let map = if groups {
            &mut self.group_of_key
        } else {
            &mut self.tab_of_key
        };
        if let Some(known) = map.get(key) {
            return known.clone();
        }
        let id = if taken {
            if groups {
                new_group_id().to_string()
            } else {
                new_tab_id().to_string()
            }
        } else {
            key.to_owned()
        };
        map.insert(key.to_owned(), id.clone());
        if id != key {
            self.key_of_local.insert(id.clone(), key.to_owned());
        }
        id
    }

    fn key_of(&self, id: &str) -> String {
        self.key_of_local
            .get(id)
            .cloned()
            .unwrap_or_else(|| id.to_owned())
    }
}

fn tid(ids: &mut Ids, s: &BrowserState, profile: &ProfileId, key: &str) -> String {
    let taken = s.tabs.get(key).is_some_and(|t| t.profile_id != *profile);
    ids.local(false, taken, key)
}

fn gid(ids: &mut Ids, s: &BrowserState, profile: &ProfileId, key: &str) -> String {
    let taken = s
        .groups
        .get(key)
        .is_some_and(|g| g.profile_id != *profile || !g.pinned);
    ids.local(true, taken, key)
}

pub fn park_window_id(profile: &ProfileId) -> WindowId {
    WindowId::new(format!("park:{profile}"))
}

pub fn adopt_parked(
    s: &mut BrowserState,
    window: &WindowId,
    profile: &ProfileId,
    parked: &ParkedPins,
    now: i64,
) {
    let mut made: Vec<(Option<String>, TabId)> = Vec::new();
    for p in &parked.tabs {
        let id = new_tab_id();
        let mut tab = Tab::new(id.clone(), window.clone(), profile.clone(), "", now);
        tab.apply_snapshot(p.snapshot.clone(), now);
        tab.profile_id = profile.clone();
        tab.page = TabPage::ASLEEP;
        tab.pin_key = Some(p.id.clone());
        Arc::make_mut(&mut s.tabs).insert(id.clone(), Arc::new(tab));
        made.push((p.group_id.clone(), id));
    }
    let group_ids: HashMap<String, GroupId> = parked
        .groups
        .iter()
        .map(|g| (g.id.clone(), new_group_id()))
        .collect();
    for g in &parked.groups {
        let members: Vec<TabId> = made
            .iter()
            .filter(|(gid, _)| gid.as_deref() == Some(g.id.as_str()))
            .map(|(_, id)| id.clone())
            .collect();
        let mut group = TabGroup::new(
            group_ids[&g.id].clone(),
            window.clone(),
            profile.clone(),
            members,
            now,
        );
        group.name = g.name.clone();
        group.icon = g.icon.clone();
        group.color = g.color;
        group.collapsed = g.collapsed;
        group.pinned = true;
        group.pin_key = Some(g.id.clone());
        group.parent_id = g.parent_id.as_ref().and_then(|p| group_ids.get(p)).cloned();
        Arc::make_mut(&mut s.groups).insert(group.id.clone(), Arc::new(group));
    }
    if let Some(w) = Arc::make_mut(&mut s.windows).get_mut(window) {
        Arc::make_mut(w)
            .tab_ids
            .extend(made.into_iter().map(|(_, id)| id));
    }
}

pub fn park_back(
    s: &mut BrowserState,
    window: &WindowId,
    profile: &ProfileId,
    before: Option<&ParkedPins>,
) {
    let Some(w) = s.windows.get(window).cloned() else {
        return;
    };
    let pinned_groups: Vec<Arc<TabGroup>> = s
        .groups
        .values()
        .filter(|g| g.window_id == *window && g.pinned && g.profile_id == *profile)
        .cloned()
        .collect();
    let tabs: Vec<ParkedTab> = w
        .tab_ids
        .iter()
        .filter_map(|id| s.tabs.get(id))
        .map(|t| {
            let group_id = pinned_groups
                .iter()
                .filter(|g| g.tab_ids.contains(&t.id))
                .max_by_key(|g| groups::depth(&s.groups, g.id.as_str()))
                .map(|g| g.pin_key().to_owned());
            match before.and_then(|b| b.tabs.iter().find(|p| p.id == t.pin_key())) {
                Some(was) => {
                    let mut kept = was.clone();
                    if kept.snapshot.url != t.url {
                        kept.restore_from = None;
                    }
                    kept.snapshot.url = t.url.clone();
                    kept.snapshot.title = t.title.clone();
                    kept.snapshot.pin = t.pin.clone();
                    kept.snapshot.pinned_url = t.pinned_url.clone();
                    kept.snapshot.custom_title = t.custom_title.clone();
                    kept.snapshot.custom_icon = t.custom_icon.clone();
                    kept.snapshot.tile_letters = t.tile_letters.clone();
                    kept.group_id = group_id;
                    kept
                }
                None => ParkedTab {
                    snapshot: t.snapshot(),
                    id: t.pin_key().to_owned(),
                    group_id,
                    restore_from: None,
                },
            }
        })
        .collect();
    let parked_groups: Vec<ParkedGroup> = pinned_groups
        .iter()
        .map(|g| ParkedGroup {
            id: g.pin_key().to_owned(),
            name: g.name.clone(),
            icon: g.icon.clone(),
            color: g.color,
            collapsed: g.collapsed,
            parent_id: g
                .parent_id
                .as_ref()
                .and_then(|p| s.groups.get(p))
                .map(|p| p.pin_key().to_owned()),
        })
        .collect();
    let persisted = Arc::make_mut(&mut s.persisted);
    if tabs.is_empty() {
        persisted.parked_pins.shift_remove(profile);
    } else {
        let splits = persisted
            .parked_pins
            .get(profile)
            .and_then(|p| p.splits.clone());
        persisted.parked_pins.insert(
            profile.clone(),
            ParkedPins {
                tabs,
                groups: parked_groups,
                splits,
            },
        );
    }
    let tab_map = Arc::make_mut(&mut s.tabs);
    for id in &w.tab_ids {
        tab_map.shift_remove(id);
    }
    Arc::make_mut(&mut s.groups).retain(|_, g| g.window_id != *window);
    Arc::make_mut(&mut s.windows).shift_remove(window);
}

fn remove_quietly(s: &mut BrowserState, ids: &[TabId]) {
    let gone: HashSet<TabId> = ids
        .iter()
        .filter(|id| s.split_of(id.as_str()).is_none())
        .cloned()
        .collect();
    if gone.is_empty() {
        return;
    }
    let tabs = Arc::make_mut(&mut s.tabs);
    for id in &gone {
        tabs.shift_remove(id);
    }
    for w in Arc::make_mut(&mut s.windows).values_mut() {
        if w.tab_ids.iter().any(|t| gone.contains(t)) {
            Arc::make_mut(w).tab_ids.retain(|t| !gone.contains(t));
        }
    }
    s.groups = Arc::new(groups::leave_groups(&s.groups, &gone));
}

fn tab_mut<'a>(s: &'a mut BrowserState, id: &str) -> Option<&'a mut Tab> {
    Arc::make_mut(&mut s.tabs).get_mut(id).map(Arc::make_mut)
}

pub fn apply_pinned(
    cx: &CycleContext,
    profile: &ProfileId,
    visible: &IndexMap<String, Value>,
    changed: &IndexSet<String>,
    records: &ApplyRecords,
) -> bool {
    if changed.iter().all(|k| k.starts_with(PIN_ROW)) {
        return true;
    }
    let orig = cx.host.state();
    let Some(next) = pinned_state(&orig, profile, visible, changed, records) else {
        return false;
    };
    if next.changed {
        cx.host.replace_state(next.state);
    }
    true
}

pub struct Applied {
    pub state: BrowserState,
    pub changed: bool,
}

pub fn pinned_state(
    orig: &BrowserState,
    profile: &ProfileId,
    visible: &IndexMap<String, Value>,
    changed: &IndexSet<String>,
    records: &ApplyRecords,
) -> Option<Applied> {
    let now = records.now;
    let base = |k: &str| records.base(k);
    let sync = pin_sync(orig, profile);
    let mut s = orig.clone();
    let home = home_window(&s, profile)?;
    let marked = |key: &str| base(&format!("{PIN_ROW}{key}")).and_then(|v| v.as_i64()) == Some(ROW);
    let park = park_window_id(profile);
    let shown = s.windows.get(&home).is_some_and(|w| {
        w.tab_ids
            .iter()
            .any(|id| s.tabs.get(id).is_some_and(|t| t.profile_id == *profile))
    });
    let parked_before = s.persisted.parked_pins.get(profile).cloned();
    if parked_before.is_some() || !shown {
        let stand = BrowserWindow::new(park.clone(), WindowKind::Main, profile.clone(), 0);
        Arc::make_mut(&mut s.windows).insert(park.clone(), Arc::new(stand));
        if let Some(parked) = &parked_before {
            adopt_parked(&mut s, &park, profile, parked, now);
            Arc::make_mut(&mut s.persisted)
                .parked_pins
                .shift_remove(profile);
        }
    }
    let new_pin_window = if shown { home.clone() } else { park.clone() };
    let scope: HashSet<WindowId> = [home.clone(), park.clone()].into_iter().collect();
    let mut ids = Ids {
        tab_of_key: HashMap::new(),
        group_of_key: HashMap::new(),
        key_of_local: HashMap::new(),
    };
    let pinned_member: HashSet<TabId> = s
        .groups
        .values()
        .filter(|g| g.pinned && g.profile_id == *profile)
        .flat_map(|g| g.tab_ids.iter().cloned())
        .collect();
    let mut search: Vec<WindowId> = vec![home, park.clone()];
    search.extend(s.windows.keys().filter(|w| !scope.contains(*w)).cloned());
    let mut kept: IndexMap<String, Arc<Tab>> = IndexMap::new();
    for wid in &search {
        let Some(w) = s.windows.get(wid) else {
            continue;
        };
        for id in &w.tab_ids {
            let Some(t) = s.tabs.get(id) else { continue };
            if t.profile_id != *profile {
                continue;
            }
            if t.pin.is_some() || pinned_member.contains(id) {
                ids.tab_of_key
                    .entry(t.pin_key().to_owned())
                    .or_insert_with(|| id.to_string());
            } else if let Some(key) = &t.pin_key {
                let replace = kept
                    .get(key)
                    .is_none_or(|other| !other.page.has_page() && t.page.has_page());
                if replace {
                    kept.insert(key.clone(), t.clone());
                }
            }
        }
    }
    for (key, t) in &kept {
        ids.tab_of_key
            .entry(key.clone())
            .or_insert_with(|| t.id.to_string());
    }
    for g in s.groups.values() {
        if g.pinned && g.profile_id == *profile && scope.contains(&g.window_id) {
            ids.group_of_key
                .entry(g.pin_key().to_owned())
                .or_insert_with(|| g.id.to_string());
        }
    }
    let mut pins: IndexMap<String, PinValue> = IndexMap::new();
    let mut group_values: IndexMap<String, Look> = IndexMap::new();
    let mut nest_values: IndexMap<String, Look> = IndexMap::new();
    let mut awaiting: HashMap<String, String> = HashMap::new();
    let mut had_group: HashSet<String> = s
        .groups
        .values()
        .filter(|g| g.profile_id == *profile)
        .map(|g| g.pin_key().to_owned())
        .collect();
    if let Some(parked) = &parked_before {
        had_group.extend(parked.groups.iter().map(|g| g.id.clone()));
    }
    let expired = |key: &str, g: &str| {
        let entry = sync.get(key.strip_prefix(PIN_TAB).unwrap_or(key));
        entry.and_then(|e| e.get("g")).and_then(Value::as_str) == Some(g)
            && entry
                .and_then(|e| e.get("w"))
                .and_then(Value::as_f64)
                .map_or(0, |w| w as i64)
                <= now
    };
    let listed = |g: &str| {
        visible.contains_key(&format!("{PIN_GROUP}{g}"))
            || visible.contains_key(&format!("{PIN_NEST_GROUP}{g}"))
    };
    let unresolved = |k: &str, g: &str| {
        !listed(g)
            && !had_group.contains(g)
            && !records.known(&format!("{PIN_GROUP}{g}"))
            && !expired(k, g)
    };
    let contained = |s: &BrowserState, id: &str| {
        s.tabs
            .get(id)
            .is_some_and(|t| t.pin.is_some() || pinned_member.contains(id))
    };
    let retained_in = |s: &BrowserState, id: &str, g: &str| {
        !contained(s, id)
            && s.groups.values().any(|x| {
                !x.pinned
                    && x.profile_id == *profile
                    && x.pin_key() == g
                    && x.tab_ids.iter().any(|t| t == id)
            })
    };
    for (k, v) in visible {
        if let Some(key) = k.strip_prefix(PIN_TAB) {
            let value = pin_value(v);
            let id = tid(&mut ids, &s, profile, key);
            if let Some(g) = &value.g {
                if !listed(g) && retained_in(&s, &id, g) {
                    continue;
                }
                if unresolved(k, g) {
                    awaiting.insert(id.clone(), g.clone());
                }
            }
            let g = value.g.as_ref().map(|g| gid(&mut ids, &s, profile, g));
            pins.insert(id, PinValue { g, ..value });
        } else if let Some(key) = k.strip_prefix(PIN_GROUP) {
            let id = gid(&mut ids, &s, profile, key);
            group_values.insert(id, look_value(v));
        } else if let Some(key) = k.strip_prefix(PIN_NEST_GROUP) {
            let id = gid(&mut ids, &s, profile, key);
            nest_values.insert(id, look_value(v));
        }
    }
    let all: IndexSet<String> = group_values
        .keys()
        .chain(nest_values.keys())
        .cloned()
        .collect();
    let mut parent_group: HashMap<String, Option<String>> = HashMap::new();
    for id in &all {
        let p = nest_values.get(id).and_then(|n| n.p.clone());
        let parent = match p {
            Some(p) if listed(&p) => Some(gid(&mut ids, &s, profile, &p)),
            _ => None,
        };
        parent_group.insert(id.clone(), parent.filter(|p| p != id && all.contains(p)));
    }
    let mut sorted: Vec<&String> = all.iter().collect();
    sorted.sort_by_key(|id| ids.key_of(id));
    let mut rooted: HashSet<String> = HashSet::new();
    for start in sorted {
        let mut path: Vec<String> = Vec::new();
        let mut on_path: HashMap<String, usize> = HashMap::new();
        let mut at = Some(start.clone());
        while let Some(cur) = at.clone() {
            if rooted.contains(&cur) {
                break;
            }
            if let Some(&loop_at) = on_path.get(&cur) {
                let mut cycle: Vec<String> = path[loop_at..].to_vec();
                cycle.sort_by_key(|id| ids.key_of(id));
                parent_group.insert(cycle[0].clone(), None);
                break;
            }
            on_path.insert(cur.clone(), path.len());
            path.push(cur.clone());
            at = parent_group.get(&cur).cloned().flatten();
        }
        rooted.extend(path);
    }
    let chain_up = |id: &str| -> Vec<String> {
        let mut out: Vec<String> = Vec::new();
        let mut at = Some(id.to_owned());
        while let Some(g) = at {
            if out.contains(&g) {
                break;
            }
            out.push(g.clone());
            at = parent_group.get(&g).cloned().flatten();
        }
        out
    };
    let look_of = |id: &str| -> Option<Look> {
        if parent_group.get(id).cloned().flatten().is_some() {
            nest_values
                .get(id)
                .or_else(|| group_values.get(id))
                .cloned()
        } else {
            group_values
                .get(id)
                .or_else(|| nest_values.get(id))
                .cloned()
        }
    };
    for (k, v) in visible {
        let Some(key) = k.strip_prefix(PIN_NEST_TAB) else {
            continue;
        };
        let Some(inner) = text(v, "g") else { continue };
        if !visible.contains_key(&format!("{PIN_TAB}{key}")) || !listed(&inner) {
            continue;
        }
        let id = tid(&mut ids, &s, profile, key);
        let inner_id = gid(&mut ids, &s, profile, &inner);
        if let Some(pin) = pins.get(&id).cloned()
            && let Some(g) = &pin.g
            && all.contains(g)
            && all.contains(&inner_id)
            && chain_up(&inner_id).last() == chain_up(g).last()
        {
            pins.insert(
                id,
                PinValue {
                    g: Some(inner_id),
                    ..pin
                },
            );
        }
    }
    for v in pins.values_mut() {
        if v.g.as_ref().is_some_and(|g| !all.contains(g)) {
            v.g = None;
        }
    }
    let roots: Vec<String> = all
        .iter()
        .filter(|id| parent_group.get(*id).cloned().flatten().is_none())
        .cloned()
        .collect();
    let mut area_slots: Vec<Slot> = pins
        .iter()
        .filter(|(_, v)| v.g.is_none())
        .map(|(id, v)| Slot {
            id: id.clone(),
            group: false,
            pos: v.pos.clone(),
        })
        .collect();
    area_slots.extend(roots.iter().map(|id| {
        Slot {
            id: id.clone(),
            group: true,
            pos: group_values
                .get(id)
                .and_then(|g| g.pos.clone())
                .unwrap_or_else(|| format!("\u{ffff}{}", ids.key_of(id))),
        }
    }));
    area_slots.sort_by(by_slot);
    let mut kids: HashMap<String, Vec<Slot>> = HashMap::new();
    let mut placed_groups: HashSet<String> = HashSet::new();
    let mut members: Vec<(Slot, Vec<String>)> = pins
        .iter()
        .filter_map(|(id, v)| {
            let g = v.g.as_ref()?;
            let mut chain = chain_up(g);
            chain.reverse();
            Some((
                Slot {
                    id: id.clone(),
                    group: false,
                    pos: v.pos.clone(),
                },
                chain,
            ))
        })
        .collect();
    members.sort_by(|a, b| by_slot(&a.0, &b.0));
    for (slot, chain) in members {
        for (i, g) in chain.iter().enumerate() {
            if i == 0 || placed_groups.contains(g) {
                continue;
            }
            placed_groups.insert(g.clone());
            kids.entry(chain[i - 1].clone()).or_default().push(Slot {
                id: g.clone(),
                group: true,
                pos: String::new(),
            });
        }
        if let Some(last) = chain.last() {
            kids.entry(last.clone()).or_default().push(slot);
        }
    }
    let mut tree: Vec<Slot> = Vec::new();
    let mut member_ids: Vec<String> = Vec::new();
    let mut member_range: HashMap<String, (usize, usize)> = HashMap::new();
    let mut visiting: Vec<(Slot, bool)> = area_slots
        .iter()
        .rev()
        .map(|s| (s.clone(), false))
        .collect();
    while let Some((slot, closing)) = visiting.pop() {
        if closing {
            if let Some(range) = member_range.get_mut(&slot.id) {
                range.1 = member_ids.len();
            }
            continue;
        }
        tree.push(slot.clone());
        if !slot.group {
            member_ids.push(slot.id.clone());
            continue;
        }
        member_range.insert(slot.id.clone(), (member_ids.len(), member_ids.len()));
        visiting.push((slot.clone(), true));
        for inner in kids.get(&slot.id).into_iter().flatten().rev() {
            visiting.push((inner.clone(), false));
        }
    }
    let group_order: Vec<String> = tree
        .iter()
        .filter(|x| x.group)
        .map(|x| x.id.clone())
        .collect();
    let tile_order: Vec<String> = area_slots
        .iter()
        .filter(|x| !x.group)
        .map(|x| x.id.clone())
        .collect();
    let member_order: IndexMap<String, Vec<String>> = all
        .iter()
        .map(|g| {
            (
                g.clone(),
                member_range
                    .get(g)
                    .map_or_else(Vec::new, |(a, b)| member_ids[*a..*b].to_vec()),
            )
        })
        .collect();

    let gone_keys: Vec<String> = changed
        .iter()
        .filter(|k| k.starts_with(PIN_TAB) && !visible.contains_key(*k))
        .map(|k| k[PIN_TAB.len()..].to_owned())
        .collect();
    let mut gone_tabs: Vec<String> = Vec::new();
    for key in gone_keys {
        let id = tid(&mut ids, &s, profile, &key);
        if contained(&s, &id)
            && s.tabs
                .get(id.as_str())
                .is_some_and(|t| scope.contains(&t.window_id))
        {
            gone_tabs.push(id);
        }
    }
    let removable: Vec<TabId> = gone_tabs
        .iter()
        .filter(|id| {
            let Some(t) = s.tabs.get(id.as_str()) else {
                return false;
            };
            let Some(w) = s.windows.get(&t.window_id) else {
                return false;
            };
            let kept =
                t.page.has_page() || w.active_tab_ids.values().any(|a| a.as_str() == id.as_str());
            !kept
                && w.tab_ids.iter().any(|other| {
                    other.as_str() != id.as_str() && !gone_tabs.iter().any(|g| g == other.as_str())
                })
        })
        .map(|id| TabId::new(id.as_str()))
        .collect();
    remove_quietly(&mut s, &removable);
    for id in &gone_tabs {
        if let Some(tab) = tab_mut(&mut s, id) {
            tab.pin = None;
            tab.pinned_url = None;
            tab.pin_key = None;
        }
    }
    for k in changed {
        let key = k
            .strip_prefix(PIN_GROUP)
            .or_else(|| k.strip_prefix(PIN_NEST_GROUP));
        let Some(key) = key else { continue };
        let id = gid(&mut ids, &s, profile, key);
        if visible.contains_key(k) || all.contains(&id) {
            continue;
        }
        if s.groups
            .get(id.as_str())
            .is_some_and(|g| g.pinned && scope.contains(&g.window_id))
        {
            Arc::make_mut(&mut s.groups).shift_remove(id.as_str());
        }
    }
    for id in &group_order {
        let Some(v) = look_of(id) else { continue };
        let old = s.groups.get(id.as_str()).cloned();
        let look_key = old
            .as_ref()
            .map_or_else(|| ids.key_of(id), |o| o.pin_key().to_owned());
        let color = looked_color(
            v.c.as_ref(),
            base(&format!("{GROUP_LOOK}{look_key}")).as_ref(),
        );
        let mut made = match old {
            Some(old) => {
                let mut g = (*old).clone();
                g.name = v.n.clone();
                g.icon = v.i;
                g.color = color;
                g.pinned = true;
                g
            }
            None => {
                let mut g = TabGroup::new(
                    GroupId::new(id.as_str()),
                    new_pin_window.clone(),
                    profile.clone(),
                    Vec::new(),
                    now,
                );
                if let Some(key) = ids.key_of_local.get(id) {
                    g.pin_key = Some(key.clone());
                }
                g.name = v.n.clone();
                g.icon = v.i;
                g.color = color;
                g.pinned = true;
                g
            }
        };
        made.parent_id = parent_group.get(id).cloned().flatten().map(GroupId::new);
        Arc::make_mut(&mut s.groups).insert(GroupId::new(id.as_str()), Arc::new(made));
    }
    let mut noted: Map<String, Value> = Map::new();
    let mut note = |key: &str, id: &str| {
        let g = awaiting.get(id);
        let was = sync.get(key);
        let was_g = was.and_then(|w| w.get("g")).and_then(Value::as_str);
        if was_g == g.map(String::as_str) {
            return;
        }
        let entry = match g {
            Some(g) => {
                let w = match (was_g == Some(g.as_str()), was.and_then(|w| w.get("w"))) {
                    (true, Some(w)) => w.clone(),
                    _ => json!(now + records.horizon),
                };
                json!({ "g": g, "w": w })
            }
            None => json!({}),
        };
        noted.insert(key.to_owned(), entry);
    };
    for (id, v) in &pins {
        let group =
            v.g.as_ref()
                .filter(|g| all.contains(*g))
                .and_then(|g| s.groups.get(g.as_str()).cloned());
        if let Some(old) = s.tabs.get(id.as_str()).cloned() {
            let key = old.pin_key().to_owned();
            let home_synced = synced_home(base(&format!("{PIN_HOME_KEY}{key}")).as_ref());
            let tab = tab_mut(&mut s, id).expect("the tab exists");
            tab.pin = if group.is_some() {
                None
            } else {
                old.pin.clone().or_else(|| {
                    Some(if marked(&key) {
                        TabPin::Row
                    } else {
                        marked_tile(&base, &key)
                    })
                })
            };
            tab.pinned_url = if group.is_some() {
                let first = if pinned_member.contains(id.as_str()) {
                    old.pinned_url
                        .clone()
                        .filter(|u| !u.is_empty())
                        .or(home_synced)
                } else {
                    home_synced.or_else(|| old.pinned_url.clone().filter(|u| !u.is_empty()))
                };
                first.or_else(|| Some(v.u.clone()).filter(|u| !u.is_empty()))
            } else {
                Some(v.u.clone())
            };
            tab.custom_title = v.t.clone();
            tab.custom_icon = v.i.clone();
            if old.page.is_asleep() {
                tab.url = v.u.clone();
                tab.title = v.ti.clone();
            }
            let key = tab.pin_key().to_owned();
            note(&key, id);
            continue;
        }
        let window_id = group
            .as_ref()
            .map_or_else(|| new_pin_window.clone(), |g| g.window_id.clone());
        if !s.windows.contains_key(&window_id) {
            continue;
        }
        let key = ids.key_of(id);
        let mut tab = Tab::new(
            TabId::new(id.as_str()),
            window_id.clone(),
            profile.clone(),
            v.u.clone(),
            now,
        );
        tab.title = v.ti.clone();
        tab.pin = if group.is_some() {
            None
        } else {
            Some(if marked(&key) {
                TabPin::Row
            } else {
                marked_tile(&base, &key)
            })
        };
        tab.custom_title = v.t.clone();
        tab.custom_icon = v.i.clone();
        if key != *id {
            tab.pin_key = Some(key.clone());
        }
        let home_synced = if group.is_some() {
            synced_home(base(&format!("{PIN_HOME_KEY}{key}")).as_ref())
        } else {
            None
        };
        tab.pinned_url = home_synced.or_else(|| Some(v.u.clone()).filter(|u| !u.is_empty()));
        tab.page = TabPage::ASLEEP;
        note(&key, id);
        Arc::make_mut(&mut s.tabs).insert(TabId::new(id.as_str()), Arc::new(tab));
        if let Some(w) = Arc::make_mut(&mut s.windows).get_mut(&window_id) {
            Arc::make_mut(w).tab_ids.push(TabId::new(id.as_str()));
        }
    }
    let standalone: HashSet<TabId> = tile_order
        .iter()
        .filter(|id| s.tabs.get(id.as_str()).is_some_and(|t| t.pin.is_some()))
        .map(|id| TabId::new(id.as_str()))
        .collect();
    let regular: Groups = s
        .groups
        .iter()
        .filter(|(_, g)| !g.pinned)
        .map(|(k, g)| (k.clone(), g.clone()))
        .collect();
    let regular = groups::leave_groups(&regular, &standalone);
    let mut merged: Groups = s
        .groups
        .iter()
        .filter(|(_, g)| g.pinned)
        .map(|(k, g)| (k.clone(), g.clone()))
        .collect();
    merged.extend(regular);
    let in_group: HashSet<String> = member_order
        .values()
        .flatten()
        .filter(|id| s.tabs.contains_key(id.as_str()))
        .cloned()
        .collect();
    for g in merged.values_mut() {
        if g.profile_id != *profile {
            continue;
        }
        let wanted: Vec<TabId> = match member_order.get(g.id.as_str()).filter(|_| g.pinned) {
            Some(order) => order
                .iter()
                .filter(|id| s.tabs.contains_key(id.as_str()))
                .map(|id| TabId::new(id.as_str()))
                .collect(),
            None => g
                .tab_ids
                .iter()
                .filter(|id| !in_group.contains(id.as_str()))
                .cloned()
                .collect(),
        };
        if wanted != g.tab_ids {
            Arc::make_mut(g).tab_ids = wanted;
        }
    }
    merged.retain(|_, g| g.profile_id != *profile || !g.tab_ids.is_empty());
    s.groups = Arc::new(merged);
    let mut copied: HashMap<String, String> = HashMap::new();
    let mut pinned_here: Vec<(GroupId, usize)> = s
        .groups
        .values()
        .filter(|g| g.profile_id == *profile && g.pinned)
        .map(|g| (g.id.clone(), groups::depth(&s.groups, g.id.as_str())))
        .collect();
    pinned_here.sort_by_key(|(_, d)| *d);
    for (group_id, _) in pinned_here {
        let Some(g) = s.groups.get(&group_id).cloned() else {
            continue;
        };
        let parent = g.parent_id.as_ref().and_then(|p| s.groups.get(p)).cloned();
        let real = |s: &BrowserState, w: &WindowId| *w != park && s.windows.contains_key(w);
        let homes: Vec<Arc<Tab>> = g
            .tab_ids
            .iter()
            .filter_map(|id| {
                s.tabs
                    .get(copied.get(id.as_str()).map_or(id.as_str(), String::as_str))
                    .cloned()
            })
            .filter(|t| real(&s, &t.window_id))
            .collect();
        let window_id = match parent {
            Some(parent) => parent.window_id.clone(),
            None if homes.is_empty() || homes.iter().any(|t| t.window_id == g.window_id) => {
                g.window_id.clone()
            }
            None => homes
                .iter()
                .find(|t| t.page.has_page())
                .unwrap_or(&homes[0])
                .window_id
                .clone(),
        };
        let mut tab_ids: Vec<TabId> = Vec::new();
        let member_list: Vec<String> = g
            .tab_ids
            .iter()
            .map(|x| {
                copied
                    .get(x.as_str())
                    .cloned()
                    .unwrap_or_else(|| x.to_string())
            })
            .collect();
        for id in member_list {
            let Some(t) = s.tabs.get(id.as_str()).cloned() else {
                continue;
            };
            if t.window_id == window_id {
                tab_ids.push(TabId::new(id.as_str()));
            } else if t.window_id == park && s.windows.contains_key(&window_id) {
                if let Some(w) = Arc::make_mut(&mut s.windows).get_mut(&park) {
                    Arc::make_mut(w).tab_ids.retain(|x| x.as_str() != id);
                }
                if let Some(w) = Arc::make_mut(&mut s.windows).get_mut(&window_id) {
                    Arc::make_mut(w).tab_ids.push(TabId::new(id.as_str()));
                }
                if let Some(tab) = tab_mut(&mut s, &id) {
                    tab.window_id = window_id.clone();
                }
                tab_ids.push(TabId::new(id.as_str()));
            } else if s.windows.contains_key(&window_id) {
                let copy_id = new_tab_id();
                let mut copy = Tab::new(
                    copy_id.clone(),
                    window_id.clone(),
                    profile.clone(),
                    t.url.clone(),
                    now,
                );
                copy.title = t.title.clone();
                copy.favicon = t.favicon.clone();
                copy.custom_title = t.custom_title.clone();
                copy.custom_icon = t.custom_icon.clone();
                copy.pin_key = Some(t.pin_key().to_owned());
                copy.pinned_url = t.pinned_url.clone();
                copy.page = TabPage::ASLEEP;
                Arc::make_mut(&mut s.tabs).insert(copy_id.clone(), Arc::new(copy));
                if let Some(tab) = tab_mut(&mut s, &id) {
                    tab.pin_key = None;
                }
                if let Some(w) = Arc::make_mut(&mut s.windows).get_mut(&window_id) {
                    Arc::make_mut(w).tab_ids.push(copy_id.clone());
                }
                tab_ids.push(copy_id.clone());
                copied.insert(id.clone(), copy_id.to_string());
            }
        }
        if let Some(group) = Arc::make_mut(&mut s.groups).get_mut(&group_id) {
            let group = Arc::make_mut(group);
            group.window_id = window_id;
            group.tab_ids = tab_ids;
        }
    }
    let sequence: Vec<String> = tree
        .iter()
        .filter(|x| !x.group)
        .map(|x| copied.get(&x.id).cloned().unwrap_or_else(|| x.id.clone()))
        .collect();
    let rank: HashMap<&str, usize> = sequence
        .iter()
        .enumerate()
        .map(|(i, id)| (id.as_str(), i))
        .collect();
    let anchor = |group: &str| anchor_in(base(&format!("{PIN_ORDER}{group}")).as_ref());
    let window_ids: Vec<WindowId> = s.windows.keys().cloned().collect();
    for wid in window_ids {
        let Some(w) = s.windows.get(&wid).cloned() else {
            continue;
        };
        if w.kind == WindowKind::Incognito {
            continue;
        }
        let mut list: Vec<TabId> = w
            .tab_ids
            .iter()
            .filter(|id| s.tabs.contains_key(*id))
            .cloned()
            .collect();
        let slots: Vec<usize> = list
            .iter()
            .enumerate()
            .filter(|(_, id)| rank.contains_key(id.as_str()))
            .map(|(i, _)| i)
            .collect();
        let mut sorted: Vec<TabId> = slots.iter().map(|i| list[*i].clone()).collect();
        sorted.sort_by_key(|id| rank[id.as_str()]);
        for (slot, id) in slots.iter().zip(sorted) {
            list[*slot] = id;
        }
        arrange_window(&mut s, &wid, profile, &anchor, list);
    }
    if s.windows.contains_key(&park) {
        park_back(&mut s, &park, profile, parked_before.as_ref());
    }
    if !noted.is_empty() {
        let mut mine = sync.clone();
        mine.extend(noted);
        Arc::make_mut(&mut s.persisted)
            .pin_sync
            .insert(profile.as_str().to_owned(), Value::Object(mine));
    }
    let changed_state = !Arc::ptr_eq(&s.tabs, &orig.tabs)
        || !Arc::ptr_eq(&s.windows, &orig.windows)
        || !Arc::ptr_eq(&s.groups, &orig.groups)
        || !Arc::ptr_eq(&s.persisted, &orig.persisted);
    let same = changed_state
        && *s.tabs == *orig.tabs
        && *s.windows == *orig.windows
        && *s.groups == *orig.groups
        && *s.persisted == *orig.persisted;
    Some(Applied {
        state: s,
        changed: changed_state && !same,
    })
}

const PIN_HOME_KEY: &str = super::PIN_HOME;
