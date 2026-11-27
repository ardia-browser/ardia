use std::collections::{HashMap, HashSet};
use std::sync::Arc;

use ardia_state::actions::Action;
use ardia_state::groups::{self, GroupColor, Groups, TabGroup};
use ardia_state::model::{PageKind, TabPage};
use ardia_state::state::order_sections;
use ardia_state::sync_engine::canonical;
use ardia_state::sync_engine::scope::{
    Adapter, ApplyRecords, ExtractContext, Extraction, ScopeState,
};
use ardia_state::sync_engine::{IndexMap, IndexSet, assign_positions};
use ardia_state::tabs::Tab;
use ardia_state::windows::WindowKind;
use ardia_state::{BrowserState, GroupId, ProfileId, TabId, WindowId};
use serde_json::{Value, json};

use super::{home_window, main_windows, new_group_id, new_tab_id, pinned_members};
use crate::sync_engine::adapters::{CycleContext, PROFILE_OPEN_TABS};
use crate::sync_engine::files::profile_scope;

pub const OPEN_TABS: &str = "otab:";
pub const OPEN_TAB: &str = "otab:t:";
pub const OPEN_GROUP: &str = "otab:g:";
pub const OPEN_TABS_ON: &str = "otab:on";
const MINUTE: i64 = 60_000;
const MAX_GROUP_DEPTH: usize = 32;
const TABS_RETIRE: &str = "tabsRetire";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Mode {
    On,
    Off,
    Retire,
}

#[derive(Clone, Debug, PartialEq)]
pub struct OpenTabValue {
    pub u: String,
    pub t: String,
    pub pos: String,
    pub g: Option<String>,
    pub a: i64,
}

#[derive(Clone, Debug, PartialEq)]
pub struct OpenGroupValue {
    pub n: String,
    pub i: Option<String>,
    pub c: Option<GroupColor>,
    pub p: Option<String>,
}

pub fn syncs_as_open_tab(url: &str) -> bool {
    let lower = url.get(..8).unwrap_or(url).to_ascii_lowercase();
    lower.starts_with("http://") || lower.starts_with("https://")
}

pub fn open_tab_value(v: Option<&Value>) -> Option<OpenTabValue> {
    let v = v?.as_object()?;
    let u = v.get("u")?.as_str()?;
    let pos = v.get("pos")?.as_str().filter(|p| !p.is_empty())?;
    if !syncs_as_open_tab(u) {
        return None;
    }
    Some(OpenTabValue {
        u: u.to_owned(),
        t: v.get("t")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned(),
        pos: pos.to_owned(),
        g: v.get("g").and_then(Value::as_str).map(str::to_owned),
        a: v.get("a")
            .and_then(Value::as_f64)
            .filter(|n| n.is_finite())
            .map_or(0, |n| n as i64),
    })
}

pub fn open_group_value(v: Option<&Value>) -> Option<OpenGroupValue> {
    let v = v?.as_object()?;
    Some(OpenGroupValue {
        n: v.get("n")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned(),
        i: v.get("i").and_then(Value::as_str).map(str::to_owned),
        c: v.get("c")
            .and_then(Value::as_str)
            .and_then(GroupColor::from_key),
        p: v.get("p").and_then(Value::as_str).map(str::to_owned),
    })
}

pub fn open_tabs_on(v: Option<&Value>) -> Option<bool> {
    v?.as_object()?.get("on")?.as_bool()
}

fn tab_json(v: &OpenTabValue) -> Value {
    json!({ "u": v.u, "t": v.t, "pos": v.pos, "g": v.g, "a": v.a })
}

fn group_json(g: &TabGroup, parent: Option<&str>) -> Value {
    json!({ "n": g.name, "i": g.icon, "c": g.color.map(GroupColor::key), "p": parent })
}

pub fn regular_open_tab(s: &BrowserState, t: &Tab, members: &HashSet<TabId>) -> bool {
    t.pin.is_none()
        && t.live_item.is_none()
        && !members.contains(&t.id)
        && s.windows
            .get(&t.window_id)
            .is_some_and(|w| w.kind == WindowKind::Main)
        && !t.live.peek
}

pub fn synced_open_tab(s: &BrowserState, t: &Tab, members: &HashSet<TabId>) -> bool {
    regular_open_tab(s, t, members) && syncs_as_open_tab(&t.url)
}

pub fn holds_open_tabs(s: &BrowserState, profile: &ProfileId) -> bool {
    s.windows.values().any(|w| {
        w.kind == WindowKind::Main
            && (w.profile_id == *profile
                || w.tab_ids
                    .iter()
                    .any(|id| s.tabs.get(id).is_some_and(|t| t.profile_id == *profile)))
    })
}

pub struct LocalOpenTabs {
    pub synced: Vec<(String, Arc<Tab>)>,
    pub by_key: IndexMap<String, Vec<Arc<Tab>>>,
    pub held: HashSet<String>,
    pub pinned: HashSet<String>,
}

pub fn local_open_tabs(s: &BrowserState, profile: &ProfileId) -> LocalOpenTabs {
    let members = pinned_members(s);
    let mut held = HashSet::new();
    let mut pinned = HashSet::new();
    for t in s.tabs.values() {
        if t.profile_id != *profile {
            continue;
        }
        held.insert(t.pin_key().to_owned());
        if t.pin.is_some() || members.contains(&t.id) {
            pinned.insert(t.pin_key().to_owned());
        }
    }
    if let Some(park) = s.persisted.parked_pins.get(profile) {
        for p in &park.tabs {
            held.insert(p.id.clone());
            pinned.insert(p.id.clone());
        }
    }
    let mut synced = Vec::new();
    let mut by_key: IndexMap<String, Vec<Arc<Tab>>> = IndexMap::new();
    for w in main_windows(s) {
        for id in &w.tab_ids {
            let Some(t) = s.tabs.get(id) else { continue };
            if t.profile_id != *profile
                || !synced_open_tab(s, t, &members)
                || pinned.contains(t.pin_key())
            {
                continue;
            }
            let key = t.pin_key().to_owned();
            match by_key.get_mut(&key) {
                Some(copies) => copies.push(t.clone()),
                None => {
                    by_key.insert(key.clone(), vec![t.clone()]);
                    synced.push((key, t.clone()));
                }
            }
        }
    }
    LocalOpenTabs {
        synced,
        by_key,
        held,
        pinned,
    }
}

pub fn regular_chain(all: &Groups, tab: &str) -> Vec<Arc<TabGroup>> {
    let Some(inner) = groups::innermost_group_of(all, tab).and_then(|g| all.get(&g).cloned())
    else {
        return Vec::new();
    };
    if inner.pinned {
        return Vec::new();
    }
    #[expect(
        clippy::needless_collect,
        reason = "the chain gains the inner group before it is filtered"
    )]
    let mut chain: Vec<Arc<TabGroup>> = groups::ancestors(all, inner.id.as_str())
        .into_iter()
        .rev()
        .filter_map(|id| all.get(&id).cloned())
        .collect();
    chain.push(inner);
    chain.into_iter().filter(|g| !g.pinned).collect()
}

#[derive(Default)]
pub struct Pages {
    pub seen: HashMap<String, String>,
    pub from_sync: HashMap<String, HashSet<String>>,
}

#[derive(Default)]
struct AllPages(HashMap<String, Pages>);

fn with_pages<T>(cx: &CycleContext, profile: &ProfileId, f: impl FnOnce(&mut Pages) -> T) -> T {
    let mut memory = cx.memory.lock();
    let all = memory.slot::<AllPages>("open-tab-pages");
    f(all.0.entry(profile.as_str().to_owned()).or_default())
}

fn forget_pages(cx: &CycleContext, profile: &ProfileId) {
    let mut memory = cx.memory.lock();
    memory
        .slot::<AllPages>("open-tab-pages")
        .0
        .remove(profile.as_str());
}

pub fn mode(cx: &CycleContext, profile: &ProfileId) -> Mode {
    let syncs = cx
        .host
        .state()
        .profiles
        .get(profile)
        .is_some_and(|p| p.sync_tabs);
    if syncs {
        cx.set_link_extra(profile, TABS_RETIRE, None);
        return if cx.types_synced("tabs") {
            Mode::On
        } else {
            Mode::Off
        };
    }
    if cx.link_extra(profile, TABS_RETIRE) == Some(Value::Bool(true)) {
        Mode::Retire
    } else {
        Mode::Off
    }
}

fn scope_of(cx: &CycleContext, profile: &ProfileId) -> Option<String> {
    cx.doc
        .lock()
        .profiles
        .get(profile.as_str())
        .map(|l| profile_scope(&l.sync_id))
}

fn flag(cx: &CycleContext, profile: &ProfileId) -> Option<String> {
    let sync_id = cx
        .doc
        .lock()
        .profiles
        .get(profile.as_str())
        .map(|l| l.sync_id.clone())?;
    cx.app_records
        .get(&format!("{PROFILE_OPEN_TABS}{sync_id}"))
        .map(|r| r.h.clone())
}

pub fn closes(cx: &CycleContext, profile: &ProfileId) -> Vec<String> {
    let Some(scope) = scope_of(cx, profile) else {
        return Vec::new();
    };
    cx.doc_extra("tabCloses")
        .and_then(|c| c.get(&scope).cloned())
        .and_then(|v| v.as_array().cloned())
        .unwrap_or_default()
        .iter()
        .filter_map(|k| k.as_str().map(str::to_owned))
        .collect()
}

pub fn settle_closes(cx: &CycleContext, profile: &ProfileId, done: &[String]) {
    if done.is_empty() {
        return;
    }
    let Some(scope) = scope_of(cx, profile) else {
        return;
    };
    cx.edit_doc_extra("tabCloses", |all| {
        let left: Vec<Value> = all
            .get(&scope)
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter(|k| !k.as_str().is_some_and(|k| done.iter().any(|d| d == k)))
            .cloned()
            .collect();
        if left.is_empty() {
            all.shift_remove(&scope);
        } else {
            all.insert(scope.clone(), Value::Array(left));
        }
    });
}

fn switched_later(state: &ScopeState, on: bool, flag: Option<&str>) -> bool {
    state.records.get(OPEN_TABS_ON).is_some_and(|marker| {
        open_tabs_on(Some(&marker.v)) == Some(on) && flag.is_none_or(|f| marker.h.as_str() > f)
    })
}

fn orphans(
    s: &BrowserState,
    profile: &ProfileId,
    state: &ScopeState,
    closed: &HashSet<String>,
) -> Vec<(String, OpenTabValue)> {
    let held = local_open_tabs(s, profile).held;
    state
        .records_with(OPEN_TAB)
        .into_iter()
        .filter_map(|(k, r)| {
            let key = k[OPEN_TAB.len()..].to_owned();
            let value = open_tab_value(Some(&r.v))?;
            (!held.contains(&key) && !closed.contains(&key)).then_some((key, value))
        })
        .collect()
}

fn adopt_matching_tabs(
    cx: &CycleContext,
    profile: &ProfileId,
    state: &ScopeState,
    missing: &[(String, OpenTabValue)],
) {
    let s = cx.host.state();
    let local = local_open_tabs(&s, profile);
    let mut waiting: HashMap<String, Vec<String>> = HashMap::new();
    for (key, value) in missing {
        waiting
            .entry(value.u.clone())
            .or_default()
            .push(key.clone());
    }
    let mut renamed: HashMap<String, String> = HashMap::new();
    for (key, tab) in &local.synced {
        let k = format!("{OPEN_TAB}{key}");
        if state.base.contains_key(&k) || state.records.contains_key(&k) {
            continue;
        }
        if let Some(list) = waiting.get_mut(&tab.url)
            && !list.is_empty()
        {
            renamed.insert(key.clone(), list.remove(0));
        }
    }
    if renamed.is_empty() {
        return;
    }
    let mut next = (*s).clone();
    let tabs = Arc::make_mut(&mut next.tabs);
    for t in s.tabs.values() {
        if t.profile_id != *profile {
            continue;
        }
        let Some(to) = renamed.get(t.pin_key()) else {
            continue;
        };
        if let Some(tab) = tabs.get_mut(&t.id) {
            Arc::make_mut(tab).pin_key = if *to == t.id.as_str() {
                None
            } else {
                Some(to.clone())
            };
        }
    }
    cx.host.replace_state(next);
}

pub fn prepare(cx: &CycleContext, profile: &ProfileId, state: &mut ScopeState) {
    let mode = mode(cx, profile);
    let closed = closes(cx, profile);
    if mode != Mode::On && !closed.is_empty() {
        settle_closes(cx, profile, &closed);
    }
    let flag = flag(cx, profile);
    match mode {
        Mode::Off => {
            forget_pages(cx, profile);
            for k in state.base_keys_with(OPEN_TABS) {
                state.drop_base(&k);
            }
            state.unapplied.retain(|k| !k.starts_with(OPEN_TABS));
        }
        Mode::Retire => {
            if switched_later(state, true, flag.as_deref()) {
                return;
            }
            forget_pages(cx, profile);
            let live: Vec<(String, String)> = state
                .records_with(OPEN_TABS)
                .into_iter()
                .filter(|(_, r)| !r.v.is_null())
                .map(|(k, r)| (k.clone(), canonical(&r.v)))
                .collect();
            for (k, json) in live {
                state.put_base(&k, json);
            }
        }
        Mode::On => {
            if switched_later(state, false, flag.as_deref()) {
                return;
            }
            let s = cx.host.state();
            let held = local_open_tabs(&s, profile).held;
            let mut done = Vec::new();
            for key in &closed {
                let k = format!("{OPEN_TAB}{key}");
                let record = state.records.get(&k).cloned();
                if held.contains(key) {
                    done.push(key.clone());
                } else if let Some(record) =
                    record.filter(|r| !r.v.is_null() && !state.base.contains_key(&k))
                {
                    state.put_base(&k, canonical(&record.v));
                } else if !state.base.contains_key(&k) {
                    done.push(key.clone());
                }
            }
            settle_closes(cx, profile, &done);
            if !holds_open_tabs(&s, profile) {
                return;
            }
            let closed: HashSet<String> = closes(cx, profile).into_iter().collect();
            let missing = orphans(&s, profile, state, &closed);
            if missing.is_empty() {
                return;
            }
            adopt_matching_tabs(cx, profile, state, &missing);
            ardia_telemetry::counts::count("sync_open_tabs_wakes");
            let keys: Vec<String> = orphans(&cx.host.state(), profile, state, &closed)
                .into_iter()
                .map(|(k, _)| format!("{OPEN_TAB}{k}"))
                .collect();
            for k in keys {
                if !state.unapplied.contains(&k) {
                    state.unapplied.push(k);
                }
            }
        }
    }
}

pub struct OpenTabsAdapter {
    cx: CycleContext,
    profile: ProfileId,
    mode: Mode,
    flag: Option<String>,
}

pub fn adapters(cx: &CycleContext, profile: &ProfileId) -> Vec<Box<dyn Adapter>> {
    let mode = mode(cx, profile);
    if mode == Mode::Off {
        return Vec::new();
    }
    vec![Box::new(OpenTabsAdapter {
        cx: cx.clone(),
        profile: profile.clone(),
        mode,
        flag: flag(cx, profile),
    })]
}

fn keys_in_use(s: &BrowserState) -> HashSet<String> {
    let mut keys: HashSet<String> = s.tabs.keys().map(|k| k.to_string()).collect();
    keys.extend(s.tabs.values().map(|t| t.pin_key().to_owned()));
    for park in s.persisted.parked_pins.values() {
        keys.extend(park.tabs.iter().map(|p| p.id.clone()));
    }
    keys
}

fn forget_closed_pages(
    s: &BrowserState,
    state: &ScopeState,
    pages: &mut Pages,
    base_tab: &dyn Fn(&str) -> Option<OpenTabValue>,
) {
    let mut in_use: Option<HashSet<String>> = None;
    let keys: Vec<String> = pages.seen.keys().cloned().collect();
    for key in keys {
        let gone = base_tab(&key).is_none()
            || open_tab_value(state.records.get(&format!("{OPEN_TAB}{key}")).map(|r| &r.v))
                .is_none();
        if !gone || in_use.get_or_insert_with(|| keys_in_use(s)).contains(&key) {
            continue;
        }
        pages.seen.remove(&key);
        pages.from_sync.remove(&key);
    }
}

fn forget_pin_pages_no_copy_shows(s: &BrowserState, profile: &ProfileId, pages: &mut Pages) {
    if pages.from_sync.is_empty() {
        return;
    }
    let mut shown: HashMap<String, HashSet<String>> = HashMap::new();
    for t in s.tabs.values().filter(|t| t.profile_id == *profile) {
        if pages.from_sync.contains_key(t.pin_key()) {
            shown
                .entry(t.pin_key().to_owned())
                .or_default()
                .insert(t.url.clone());
        }
    }
    if let Some(park) = s.persisted.parked_pins.get(profile) {
        for p in &park.tabs {
            if pages.from_sync.contains_key(&p.id) {
                shown
                    .entry(p.id.clone())
                    .or_default()
                    .insert(p.snapshot.url.clone());
            }
        }
    }
    pages.from_sync.retain(|key, urls| {
        let here = shown.get(key);
        urls.retain(|u| here.is_some_and(|h| h.contains(u)));
        !urls.is_empty()
    });
}

fn to_minute(ms: i64) -> i64 {
    ms.div_euclid(MINUTE) * MINUTE
}

pub fn note_pin_pages(
    cx: &CycleContext,
    profile: &ProfileId,
    prev: &BrowserState,
    next: &BrowserState,
) {
    if mode(cx, profile) != Mode::On {
        return;
    }
    let mut written: HashMap<String, HashSet<String>> = HashMap::new();
    for t in next.tabs.values() {
        if t.profile_id == *profile && prev.tabs.get(&t.id).is_none_or(|p| p.url != t.url) {
            written
                .entry(t.pin_key().to_owned())
                .or_default()
                .insert(t.url.clone());
        }
    }
    let parked_before: HashMap<&str, &str> = prev
        .persisted
        .parked_pins
        .get(profile)
        .map(|p| {
            p.tabs
                .iter()
                .map(|t| (t.id.as_str(), t.snapshot.url.as_str()))
                .collect()
        })
        .unwrap_or_default();
    if let Some(park) = next.persisted.parked_pins.get(profile) {
        for p in &park.tabs {
            if parked_before.get(p.id.as_str()) != Some(&p.snapshot.url.as_str()) {
                written
                    .entry(p.id.clone())
                    .or_default()
                    .insert(p.snapshot.url.clone());
            }
        }
    }
    with_pages(cx, profile, |pages| {
        for (key, urls) in written {
            for url in urls {
                match pages.seen.get(&key) {
                    None => {
                        pages.seen.insert(key.clone(), url);
                    }
                    Some(baseline) if *baseline != url => {
                        pages.from_sync.entry(key.clone()).or_default().insert(url);
                    }
                    Some(_) => {}
                }
            }
        }
        forget_pin_pages_no_copy_shows(next, profile, pages);
    });
}

impl OpenTabsAdapter {
    fn off(&self, state: &ScopeState) -> bool {
        switched_later(state, false, self.flag.as_deref())
    }

    fn extract_tabs(&self, cx: &ExtractContext) -> Extraction {
        let s = self.cx.host.state();
        let local = local_open_tabs(&s, &self.profile);
        let closed: HashSet<String> = closes(&self.cx, &self.profile).into_iter().collect();
        let base_tab = |key: &str| open_tab_value(cx.base(&format!("{OPEN_TAB}{key}")).as_ref());
        let mut values: IndexMap<String, Value> = IndexMap::new();
        values.insert(OPEN_TABS_ON.to_owned(), json!({ "on": true }));
        with_pages(&self.cx, &self.profile, |pages| {
            forget_closed_pages(&s, cx.state(), pages, &base_tab);
            forget_pin_pages_no_copy_shows(&s, &self.profile, pages);
            let mut positions: HashMap<String, String> = HashMap::new();
            let mut windows: Vec<WindowId> = Vec::new();
            for (_, t) in &local.synced {
                if !windows.contains(&t.window_id) {
                    windows.push(t.window_id.clone());
                }
            }
            for w in windows {
                let here: Vec<&(String, Arc<Tab>)> = local
                    .synced
                    .iter()
                    .filter(|(_, t)| t.window_id == w)
                    .collect();
                let existing: Vec<Option<String>> = here
                    .iter()
                    .map(|(key, _)| base_tab(key).map(|b| b.pos))
                    .collect();
                let assigned =
                    assign_positions(&existing.iter().map(Option::as_deref).collect::<Vec<_>>());
                for ((key, _), pos) in here.iter().zip(assigned) {
                    positions.insert(key.clone(), pos);
                }
            }
            for (key, tab) in &local.synced {
                let was = base_tab(key);
                let before = pages.seen.get(key).cloned();
                let navigated_here = before.as_ref().is_some_and(|b| *b != tab.url)
                    && !pages
                        .from_sync
                        .get(key)
                        .is_some_and(|p| p.contains(&tab.url));
                pages.seen.insert(key.clone(), tab.url.clone());
                pages.from_sync.remove(key);
                let u = match &was {
                    Some(was) if !navigated_here => was.u.clone(),
                    _ => tab.url.clone(),
                };
                let chain = regular_chain(&s.groups, tab.id.as_str());
                for (j, g) in chain.iter().enumerate() {
                    let parent = j.checked_sub(1).map(|p| chain[p].pin_key().to_owned());
                    values.insert(
                        format!("{OPEN_GROUP}{}", g.pin_key()),
                        group_json(g, parent.as_deref()),
                    );
                }
                let t = match &was {
                    Some(was) if u != tab.url => was.t.clone(),
                    _ => tab.title.clone(),
                };
                let value = OpenTabValue {
                    t,
                    pos: positions.get(key).cloned().unwrap_or_default(),
                    g: chain.last().map(|g| g.pin_key().to_owned()),
                    a: to_minute(tab.last_active_at).max(was.as_ref().map_or(0, |w| w.a)),
                    u,
                };
                values.insert(format!("{OPEN_TAB}{key}"), tab_json(&value));
            }
        });
        let mut referenced: HashSet<String> = HashSet::new();
        let reference = |group: Option<String>,
                         referenced: &mut HashSet<String>,
                         values: &IndexMap<String, Value>| {
            let mut at = group;
            let mut n = 0;
            while let Some(g) = at {
                if n >= MAX_GROUP_DEPTH || referenced.contains(&g) {
                    break;
                }
                referenced.insert(g.clone());
                let k = format!("{OPEN_GROUP}{g}");
                at = open_group_value(values.get(&k).or_else(|| cx.remote(&k))).and_then(|v| v.p);
                n += 1;
            }
        };
        let tab_groups: Vec<Option<String>> = values
            .iter()
            .filter(|(k, _)| k.starts_with(OPEN_TAB))
            .map(|(_, v)| v.get("g").and_then(Value::as_str).map(str::to_owned))
            .collect();
        for g in tab_groups {
            reference(g, &mut referenced, &values);
        }
        for (k, record) in cx.state().records_with(OPEN_TAB) {
            if record.v.is_null() || values.contains_key(k) {
                continue;
            }
            let key = &k[OPEN_TAB.len()..];
            if !closed.contains(key) && !local.pinned.contains(key) {
                reference(
                    open_tab_value(Some(&record.v)).and_then(|v| v.g),
                    &mut referenced,
                    &values,
                );
            }
        }
        let pinned = local.pinned;
        let closed_for_ignore = closed.clone();
        let deletes = move |k: &str| {
            if let Some(key) = k.strip_prefix(OPEN_TAB) {
                return closed_for_ignore.contains(key) || pinned.contains(key);
            }
            k.strip_prefix(OPEN_GROUP)
                .is_some_and(|g| !referenced.contains(g))
        };
        let cycle = self.cx.clone();
        let profile = self.profile.clone();
        Extraction::of(values)
            .ignoring(move |k| !deletes(k))
            .on_published(move |keys| {
                ardia_telemetry::counts::add(
                    "sync_open_tabs_published",
                    keys.iter().filter(|k| k.starts_with(OPEN_TAB)).count() as u64,
                );
                let done: Vec<String> = keys
                    .iter()
                    .filter_map(|k| k.strip_prefix(OPEN_TAB))
                    .filter(|k| closed.contains(*k))
                    .map(str::to_owned)
                    .collect();
                settle_closes(&cycle, &profile, &done);
            })
    }

    fn closes_only(&self, cx: &ExtractContext) -> Option<Extraction> {
        let s = self.cx.host.state();
        with_pages(&self.cx, &self.profile, |pages| {
            forget_closed_pages(&s, cx.state(), pages, &|key| {
                open_tab_value(cx.base(&format!("{OPEN_TAB}{key}")).as_ref())
            });
            forget_pin_pages_no_copy_shows(&s, &self.profile, pages);
        });
        let closed: HashSet<String> = closes(&self.cx, &self.profile).into_iter().collect();
        if closed.is_empty() {
            return None;
        }
        let ignore_set = closed.clone();
        let cycle = self.cx.clone();
        let profile = self.profile.clone();
        Some(
            Extraction::of(IndexMap::new())
                .ignoring(move |k| {
                    !k.strip_prefix(OPEN_TAB)
                        .is_some_and(|key| ignore_set.contains(key))
                })
                .on_published(move |keys| {
                    let done: Vec<String> = keys
                        .iter()
                        .filter_map(|k| k.strip_prefix(OPEN_TAB))
                        .filter(|k| closed.contains(*k))
                        .map(str::to_owned)
                        .collect();
                    settle_closes(&cycle, &profile, &done);
                }),
        )
    }
}

impl Adapter for OpenTabsAdapter {
    fn prefix(&self) -> &str {
        OPEN_TABS
    }

    fn extract(&mut self, cx: &ExtractContext) -> Option<Extraction> {
        match self.mode {
            Mode::Off => None,
            Mode::Retire => {
                if switched_later(cx.state(), true, self.flag.as_deref()) {
                    return None;
                }
                let mut values = IndexMap::new();
                values.insert(OPEN_TABS_ON.to_owned(), json!({ "on": false }));
                Some(Extraction::of(values))
            }
            Mode::On => {
                if self.off(cx.state()) {
                    return None;
                }
                if !holds_open_tabs(&self.cx.host.state(), &self.profile) {
                    return self.closes_only(cx);
                }
                Some(self.extract_tabs(cx))
            }
        }
    }

    fn apply(
        &mut self,
        visible: &IndexMap<String, Value>,
        changed: &IndexSet<String>,
        records: &ApplyRecords,
    ) -> bool {
        match self.mode {
            Mode::Off => false,
            Mode::Retire => !switched_later(records.state(), true, self.flag.as_deref()),
            Mode::On => {
                if self.off(records.state())
                    || !holds_open_tabs(&self.cx.host.state(), &self.profile)
                {
                    return false;
                }
                let closed: HashSet<String> = closes(&self.cx, &self.profile).into_iter().collect();
                apply_open_tabs(
                    &self.cx,
                    &self.profile,
                    visible,
                    changed,
                    &closed,
                    records.now,
                )
            }
        }
    }
}

fn synced(t: &Tab, v: &OpenTabValue) -> Option<Tab> {
    let unloaded = matches!(t.page.kind, PageKind::Idle | PageKind::Asleep);
    let mut next = t.clone();
    let mut changed = false;
    if unloaded && t.url != v.u {
        next.url = v.u.clone();
        next.title = v.t.clone();
        next.page.wake = None;
        changed = true;
    } else if unloaded && t.title != v.t {
        next.title = v.t.clone();
        changed = true;
    }
    if v.a > next.last_active_at {
        next.last_active_at = v.a;
        changed = true;
    }
    changed.then_some(next)
}

pub fn open_tabs_state(
    s: &BrowserState,
    profile: &ProfileId,
    visible: &IndexMap<String, Value>,
    changed: &IndexSet<String>,
    closed: &HashSet<String>,
    now: i64,
    seen: &mut HashMap<String, String>,
) -> Option<(BrowserState, Vec<TabId>)> {
    let home = home_window(s, profile)?;
    let mut tab_values: IndexMap<String, OpenTabValue> = IndexMap::new();
    let mut group_values: IndexMap<String, OpenGroupValue> = IndexMap::new();
    for (k, v) in visible {
        if let Some(key) = k.strip_prefix(OPEN_TAB) {
            if let Some(value) = open_tab_value(Some(v)) {
                tab_values.insert(key.to_owned(), value);
            }
        } else if let Some(key) = k.strip_prefix(OPEN_GROUP)
            && let Some(value) = open_group_value(Some(v))
        {
            group_values.insert(key.to_owned(), value);
        }
    }
    let local = local_open_tabs(s, profile);
    let changed_tabs: Vec<String> = changed
        .iter()
        .filter_map(|k| k.strip_prefix(OPEN_TAB))
        .map(str::to_owned)
        .collect();
    let mut next = s.clone();
    let mut opened = Vec::new();
    let mut updated_tabs = 0u64;
    for key in &changed_tabs {
        let Some(v) = tab_values.get(key) else {
            continue;
        };
        if let Some(here) = local.by_key.get(key) {
            for t in here {
                if let Some(updated) = synced(t, v) {
                    updated_tabs += 1;
                    if updated.url != t.url {
                        seen.insert(key.clone(), updated.url.clone());
                    }
                    Arc::make_mut(&mut next.tabs).insert(t.id.clone(), Arc::new(updated));
                }
            }
            continue;
        }
        if local.held.contains(key) || closed.contains(key) {
            continue;
        }
        let id = if next.tabs.contains_key(key.as_str()) {
            new_tab_id()
        } else {
            TabId::new(key.as_str())
        };
        let mut tab = Tab::new(id.clone(), home.clone(), profile.clone(), v.u.clone(), now);
        tab.title = v.t.clone();
        if id.as_str() != key {
            tab.pin_key = Some(key.clone());
        }
        tab.page = TabPage::IDLE;
        tab.last_active_at = if v.a != 0 { v.a } else { now };
        Arc::make_mut(&mut next.tabs).insert(id.clone(), Arc::new(tab));
        opened.push(id);
        seen.insert(key.clone(), v.u.clone());
    }
    let opened_tabs = opened.len() as u64;
    if !opened.is_empty()
        && let Some(w) = Arc::make_mut(&mut next.windows).get_mut(&home)
    {
        Arc::make_mut(w).tab_ids.extend(opened);
    }
    let gone: Vec<TabId> = changed_tabs
        .iter()
        .filter(|k| !tab_values.contains_key(*k))
        .flat_map(|k| local.by_key.get(k).cloned().unwrap_or_default())
        .map(|t| t.id.clone())
        .collect();
    if !changed.is_empty() {
        arrange(&mut next, profile, &tab_values, &group_values, now);
    }
    ardia_telemetry::counts::add("sync_open_tabs_opened", opened_tabs);
    ardia_telemetry::counts::add("sync_open_tabs_closed", gone.len() as u64);
    ardia_telemetry::counts::add("sync_open_tabs_updated", updated_tabs);
    if gone.len() >= 5 {
        ardia_telemetry::counts::count("sync_open_tabs_mass_closes");
    }
    ardia_telemetry::counts::raise("sync_open_tabs_cycle_max", opened_tabs + gone.len() as u64);
    Some((next, gone))
}

fn apply_open_tabs(
    cx: &CycleContext,
    profile: &ProfileId,
    visible: &IndexMap<String, Value>,
    changed: &IndexSet<String>,
    closed: &HashSet<String>,
    now: i64,
) -> bool {
    let s = cx.host.state();
    let Some((next, gone)) = with_pages(cx, profile, |pages| {
        open_tabs_state(&s, profile, visible, changed, closed, now, &mut pages.seen)
    }) else {
        return false;
    };
    if *next.tabs != *s.tabs || *next.windows != *s.windows || *next.groups != *s.groups {
        cx.host.replace_state(next);
    }
    if !gone.is_empty() {
        let _ = cx.host.dispatch(Action::CloseSyncedTabs { tabs: gone });
    }
    true
}

fn arrange(
    s: &mut BrowserState,
    profile: &ProfileId,
    tab_values: &IndexMap<String, OpenTabValue>,
    group_values: &IndexMap<String, OpenGroupValue>,
    now: i64,
) {
    let members = pinned_members(s);
    let chain_of = |group: Option<&String>| -> Vec<String> {
        let mut out: Vec<String> = Vec::new();
        let mut at = group.cloned();
        while let Some(g) = at {
            if !group_values.contains_key(&g) || out.contains(&g) || out.len() >= MAX_GROUP_DEPTH {
                break;
            }
            out.insert(0, g.clone());
            at = group_values[&g].p.clone();
        }
        out
    };
    let before: Groups = (*s.groups).clone();
    let mut all: Groups = (*s.groups).clone();
    let mut touched: Vec<WindowId> = Vec::new();
    let mut edited = false;
    for w in main_windows(s) {
        let ranked: Vec<TabId> = w
            .tab_ids
            .iter()
            .filter(|id| {
                s.tabs.get(*id).is_some_and(|t| {
                    t.profile_id == *profile
                        && synced_open_tab(s, t, &members)
                        && tab_values.contains_key(t.pin_key())
                })
            })
            .cloned()
            .collect();
        if ranked.is_empty() {
            continue;
        }
        let value_of = |id: &TabId| &tab_values[s.tabs[id].pin_key()];
        let mut sorted = ranked.clone();
        sorted.sort_by(|a, z| {
            value_of(a)
                .pos
                .cmp(&value_of(z).pos)
                .then_with(|| s.tabs[a].pin_key().cmp(s.tabs[z].pin_key()))
        });
        let ranked_set: HashSet<&TabId> = ranked.iter().collect();
        let mut slot = 0;
        let tab_ids: Vec<TabId> = w
            .tab_ids
            .iter()
            .map(|id| {
                if ranked_set.contains(id) {
                    slot += 1;
                    sorted[slot - 1].clone()
                } else {
                    id.clone()
                }
            })
            .collect();
        let local: Vec<Arc<TabGroup>> = all
            .values()
            .filter(|g| g.window_id == w.id && g.profile_id == *profile && !g.pinned)
            .cloned()
            .collect();
        let mut id_of_key: HashMap<String, GroupId> = local
            .iter()
            .map(|g| (g.pin_key().to_owned(), g.id.clone()))
            .collect();
        let mut wanted: IndexMap<String, Vec<TabId>> = IndexMap::new();
        for id in &sorted {
            for key in chain_of(value_of(id).g.as_ref()) {
                wanted.entry(key).or_default().push(id.clone());
            }
        }
        for g in &local {
            let key = g.pin_key().to_owned();
            let mut ids: Vec<TabId> = g
                .tab_ids
                .iter()
                .filter(|id| !ranked_set.contains(id))
                .cloned()
                .collect();
            ids.extend(wanted.get(&key).cloned().unwrap_or_default());
            let look = wanted
                .contains_key(&key)
                .then(|| group_values.get(&key))
                .flatten();
            let restyled = look.is_some_and(|l| l.n != g.name || l.i != g.icon || l.c != g.color);
            if ids.is_empty() {
                all.shift_remove(&g.id);
                edited = true;
            } else {
                let mut a = ids.clone();
                a.sort();
                let mut b = g.tab_ids.clone();
                b.sort();
                if restyled || a != b {
                    let mut group = (**g).clone();
                    group.tab_ids = ids;
                    if let Some(look) = look {
                        group.name = look.n.clone();
                        group.icon = look.i.clone();
                        group.color = look.c;
                    }
                    all.insert(g.id.clone(), Arc::new(group));
                    edited = true;
                }
            }
        }
        for (key, ids) in &wanted {
            if id_of_key.contains_key(key) {
                continue;
            }
            let look = &group_values[key];
            let id = if all.contains_key(key.as_str()) || before.contains_key(key.as_str()) {
                new_group_id()
            } else {
                GroupId::new(key.as_str())
            };
            let mut group =
                TabGroup::new(id.clone(), w.id.clone(), profile.clone(), ids.clone(), now);
            if id.as_str() != key {
                group.pin_key = Some(key.clone());
            }
            group.name = look.n.clone();
            group.icon = look.i.clone();
            group.color = look.c;
            all.insert(id.clone(), Arc::new(group));
            id_of_key.insert(key.clone(), id);
            edited = true;
        }
        for key in wanted.keys() {
            let id = id_of_key[key].clone();
            let parent = group_values[key]
                .p
                .as_ref()
                .filter(|p| wanted.contains_key(*p))
                .map(|p| id_of_key[p].clone());
            if let Some(g) = all.get_mut(&id)
                && g.parent_id != parent
            {
                Arc::make_mut(g).parent_id = parent;
                edited = true;
            }
        }
        if tab_ids != w.tab_ids {
            let mut window = (*w).clone();
            window.tab_ids = tab_ids;
            Arc::make_mut(&mut s.windows).insert(w.id.clone(), Arc::new(window));
            edited = true;
        }
        touched.push(w.id.clone());
    }
    if !edited {
        return;
    }
    groups::reparent(&mut all, &before);
    for id in touched {
        let Some(w) = s.windows.get(&id).cloned() else {
            continue;
        };
        let placed = groups::place_groups(w.tab_ids.clone(), &all, &id);
        let tab_ids = order_sections(&placed, &s.tabs, &all);
        groups::sync_group_order(&mut all, &id, &tab_ids);
        if tab_ids != w.tab_ids {
            let mut window = (*w).clone();
            window.tab_ids = tab_ids;
            Arc::make_mut(&mut s.windows).insert(id, Arc::new(window));
        }
    }
    s.groups = Arc::new(all);
}

pub fn closed_open_tabs(
    prev: &BrowserState,
    next: &BrowserState,
    quitting: bool,
) -> Vec<(ProfileId, String)> {
    if quitting || Arc::ptr_eq(&prev.tabs, &next.tabs) {
        return Vec::new();
    }
    let members = pinned_members(prev);
    let families: HashSet<(ProfileId, String)> = next
        .tabs
        .values()
        .map(|t| (t.profile_id.clone(), t.pin_key().to_owned()))
        .collect();
    let mut out = Vec::new();
    let mut ids: Vec<&TabId> = prev.tabs.keys().collect();
    ids.extend(next.tabs.keys().filter(|k| !prev.tabs.contains_key(*k)));
    for id in ids {
        let was = prev.tabs.get(id);
        let now = next.tabs.get(id);
        if let (Some(a), Some(b)) = (was, now)
            && Arc::ptr_eq(a, b)
        {
            continue;
        }
        let Some(was) = was else { continue };
        if !next
            .profiles
            .get(&was.profile_id)
            .is_some_and(|p| p.sync_tabs)
            || !regular_open_tab(prev, was, &members)
        {
            continue;
        }
        if let Some(now) = now
            && now.profile_id == was.profile_id
            && now.pin_key() == was.pin_key()
        {
            continue;
        }
        let key = was.pin_key().to_owned();
        if families.contains(&(was.profile_id.clone(), key.clone())) {
            continue;
        }
        if now.is_some()
            || next.windows.contains_key(&was.window_id)
            || holds_open_tabs(next, &was.profile_id)
        {
            out.push((was.profile_id.clone(), key));
        }
    }
    out
}
