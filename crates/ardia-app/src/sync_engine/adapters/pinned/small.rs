use std::collections::{HashMap, HashSet};
use std::sync::Arc;

use ardia_state::closed::ParkedPins;
use ardia_state::groups::GroupColor;
use ardia_state::model::{TabPin, TileFolder};
use ardia_state::state::order_sections;
use ardia_state::sync_engine::scope::{Adapter, ApplyRecords, ExtractContext, Extraction};
use ardia_state::sync_engine::{IndexMap, IndexSet};
use ardia_state::{BrowserState, ProfileId};
use ardia_ui::sidebar::tile_letters::clean_tile_letters;
use serde_json::{Value, json};

use super::area::{self, BlockKey};
use super::{
    FOLDER_NAME, GROUP_LOOK, NO_BOX, PIN_GROUP, PIN_HOME, PIN_LETTERS, PIN_NEST_GROUP, PIN_ORDER,
    PIN_ROW, PIN_TAB, ROW, TILE, TILE_FOLDER, anchor_in, choice_still_out, choices, home_window,
    is_row, legacy_color, looked_color, main_windows, order_choice_key, pinned_members,
    settle_choices, synced_folder_id, synced_home, synced_name, unpinned_remotely,
    windows_home_first,
};
use crate::sync_engine::adapters::CycleContext;

fn key_of<'a>(prefix: &str, k: &'a str) -> &'a str {
    k.get(prefix.len()..).unwrap_or_default()
}

fn tab_mut<'a>(
    s: &'a mut BrowserState,
    id: &ardia_state::TabId,
) -> Option<&'a mut ardia_state::tabs::Tab> {
    Arc::make_mut(&mut s.tabs).get_mut(id).map(Arc::make_mut)
}

fn set_parked(s: &mut BrowserState, profile: &ProfileId, park: ParkedPins) {
    Arc::make_mut(&mut s.persisted)
        .parked_pins
        .insert(profile.clone(), park);
}

pub fn tile_folder_of(pin: Option<&TabPin>) -> Option<&TileFolder> {
    pin.and_then(TabPin::folder)
}

pub fn with_tile_folder(pin: Option<&TabPin>, folder: Option<TileFolder>) -> Option<TabPin> {
    match pin {
        Some(TabPin::Tile { folder: current }) if *current != folder => {
            Some(TabPin::Tile { folder })
        }
        other => other.cloned(),
    }
}

pub struct TileFoldersAdapter {
    cx: CycleContext,
    profile: ProfileId,
}

impl TileFoldersAdapter {
    pub fn new(cx: &CycleContext, profile: &ProfileId) -> Self {
        TileFoldersAdapter {
            cx: cx.clone(),
            profile: profile.clone(),
        }
    }
}

#[derive(Default)]
struct LocalFolders(HashMap<String, HashSet<String>>);

impl Adapter for TileFoldersAdapter {
    fn prefix(&self) -> &str {
        TILE_FOLDER
    }

    fn extract(&mut self, cx: &ExtractContext) -> Option<Extraction> {
        let s = self.cx.host.state();
        let mut values = IndexMap::new();
        let mut known: HashSet<String> = HashSet::new();
        let mut local: IndexMap<String, TileFolder> = IndexMap::new();
        let mut mark = |key: &str,
                        folder: Option<&TileFolder>,
                        values: &mut IndexMap<String, Value>,
                        known: &mut HashSet<String>| {
            known.insert(key.to_owned());
            let Some(folder) = folder else { return };
            values.insert(format!("{TILE_FOLDER}{key}"), json!({ "f": folder.id }));
            let newer = local
                .get(&folder.id)
                .is_none_or(|was| folder.renamed_at.unwrap_or(-1) > was.renamed_at.unwrap_or(-1));
            if newer {
                local.insert(folder.id.clone(), folder.clone());
            }
        };
        let home = home_window(&s, &self.profile);
        for w in windows_home_first(&s, home.as_ref()) {
            for id in &w.tab_ids {
                let Some(t) = s.tabs.get(id) else { continue };
                if t.pin.is_some() && t.profile_id == self.profile && !known.contains(t.pin_key()) {
                    mark(
                        t.pin_key(),
                        tile_folder_of(t.pin.as_ref()),
                        &mut values,
                        &mut known,
                    );
                }
            }
        }
        if let Some(park) = s.persisted.parked_pins.get(&self.profile) {
            for p in &park.tabs {
                if p.group_id.is_none() && !known.contains(&p.id) {
                    mark(
                        &p.id,
                        tile_folder_of(p.snapshot.pin.as_ref()),
                        &mut values,
                        &mut known,
                    );
                }
            }
        }
        for (folder_id, folder) in &local {
            let k = format!("{FOLDER_NAME}{folder_id}");
            let synced = cx.base(&k);
            if folder.renamed_at.is_some()
                && synced_name(synced.as_ref()).as_deref() != Some(folder.name.as_str())
            {
                values.insert(k, json!({ "n": folder.name }));
            } else if let Some(synced) = synced {
                values.insert(k, synced);
            }
        }
        let had = {
            let mut memory = self.cx.memory.lock();
            let slot = memory.slot::<LocalFolders>("tile-folders");
            let had = slot
                .0
                .get(self.profile.as_str())
                .cloned()
                .unwrap_or_default();
            slot.0.insert(
                self.profile.as_str().to_owned(),
                local.keys().cloned().collect(),
            );
            had
        };
        let unpinned: HashSet<String> = cx
            .base_keys(TILE_FOLDER)
            .iter()
            .map(|k| key_of(TILE_FOLDER, k).to_owned())
            .filter(|k| unpinned_remotely(cx, k))
            .collect();
        let base_tabs: HashSet<String> = cx
            .base_keys(PIN_TAB)
            .iter()
            .map(|k| key_of(PIN_TAB, k).to_owned())
            .collect();
        Some(Extraction::of(values).ignoring(move |k| {
            if let Some(id) = k.strip_prefix(FOLDER_NAME) {
                return !had.contains(id);
            }
            let key = key_of(TILE_FOLDER, k);
            !known.contains(key) && !base_tabs.contains(key) && !unpinned.contains(key)
        }))
    }

    fn apply(
        &mut self,
        visible: &IndexMap<String, Value>,
        changed: &IndexSet<String>,
        _records: &ApplyRecords,
    ) -> bool {
        let s = self.cx.host.state();
        let touched: HashSet<&str> = changed
            .iter()
            .filter(|k| !k.starts_with(FOLDER_NAME))
            .map(|k| key_of(TILE_FOLDER, k))
            .collect();
        let names: HashMap<String, String> = visible
            .iter()
            .filter_map(|(k, v)| {
                k.strip_prefix(FOLDER_NAME)
                    .and_then(|id| synced_name(Some(v)).map(|n| (id.to_owned(), n)))
            })
            .collect();
        let wanted = |key: &str, current: Option<&TileFolder>| -> Option<TileFolder> {
            let id = if touched.contains(key) {
                synced_folder_id(visible.get(&format!("{TILE_FOLDER}{key}")))
            } else {
                current.map(|c| c.id.clone())
            }?;
            let name = names.get(&id);
            if let Some(current) = current
                && current.id == id
                && name.is_none_or(|n| *n == current.name)
            {
                return Some(current.clone());
            }
            Some(TileFolder {
                name: name.cloned().unwrap_or_else(|| {
                    current
                        .filter(|c| c.id == id)
                        .map(|c| c.name.clone())
                        .unwrap_or_default()
                }),
                id,
                renamed_at: None,
            })
        };
        let mut next = (*s).clone();
        let mut edited = false;
        for w in main_windows(&s) {
            for id in &w.tab_ids {
                let Some(t) = s.tabs.get(id) else { continue };
                if !t.pin.as_ref().is_some_and(TabPin::is_tile) || t.profile_id != self.profile {
                    continue;
                }
                let current = tile_folder_of(t.pin.as_ref());
                let folder = wanted(t.pin_key(), current);
                if folder.as_ref() != current
                    && let Some(tab) = tab_mut(&mut next, id)
                {
                    tab.pin = with_tile_folder(t.pin.as_ref(), folder);
                    edited = true;
                }
            }
        }
        if let Some(park) = s.persisted.parked_pins.get(&self.profile) {
            let mut park = park.clone();
            let mut park_edited = false;
            for p in park.tabs.iter_mut() {
                if p.group_id.is_some() || !p.snapshot.pin.as_ref().is_some_and(TabPin::is_tile) {
                    continue;
                }
                let current = tile_folder_of(p.snapshot.pin.as_ref()).cloned();
                let folder = wanted(&p.id, current.as_ref());
                if folder != current {
                    p.snapshot.pin = with_tile_folder(p.snapshot.pin.as_ref(), folder);
                    park_edited = true;
                }
            }
            if park_edited {
                set_parked(&mut next, &self.profile, park);
                edited = true;
            }
        }
        if edited {
            self.cx.host.replace_state(next);
        }
        true
    }
}

pub struct RowsAdapter {
    cx: CycleContext,
    profile: ProfileId,
}

impl RowsAdapter {
    pub fn new(cx: &CycleContext, profile: &ProfileId) -> Self {
        RowsAdapter {
            cx: cx.clone(),
            profile: profile.clone(),
        }
    }
}

pub fn arrange_window(
    next: &mut BrowserState,
    window: &ardia_state::WindowId,
    profile: &ProfileId,
    anchor_of: &area::AnchorOf,
    ids: Vec<ardia_state::TabId>,
) {
    let sectioned = order_sections(&ids, &next.tabs, &next.groups);
    let Some(w) = next.windows.get(window).cloned() else {
        return;
    };
    let mut w = (*w).clone();
    w.tab_ids = sectioned;
    w.tab_ids = area::arrange_pinned_area(&next.tabs, &next.groups, &w, profile, anchor_of);
    ardia_state::groups::sync_group_order(Arc::make_mut(&mut next.groups), &w.id, &w.tab_ids);
    Arc::make_mut(&mut next.windows).insert(window.clone(), Arc::new(w));
}

impl Adapter for RowsAdapter {
    fn prefix(&self) -> &str {
        PIN_ROW
    }

    fn extract(&mut self, cx: &ExtractContext) -> Option<Extraction> {
        let s = self.cx.host.state();
        let mut values = IndexMap::new();
        let mut known: HashSet<String> = HashSet::new();
        let chosen = choices(&s, &self.profile);
        let mark = |key: &str, row: bool, values: &mut IndexMap<String, Value>| {
            if row {
                values.insert(format!("{PIN_ROW}{key}"), json!(ROW));
            } else if chosen.contains_key(key) || cx.base(&format!("{PIN_ROW}{key}")).is_some() {
                values.insert(format!("{PIN_ROW}{key}"), json!(TILE));
            }
        };
        let home = home_window(&s, &self.profile);
        for w in windows_home_first(&s, home.as_ref()) {
            for id in &w.tab_ids {
                let Some(t) = s.tabs.get(id) else { continue };
                if t.pin.is_none() || t.profile_id != self.profile || known.contains(t.pin_key()) {
                    continue;
                }
                known.insert(t.pin_key().to_owned());
                mark(t.pin_key(), is_row(t.pin.as_ref()), &mut values);
            }
        }
        if let Some(park) = s.persisted.parked_pins.get(&self.profile) {
            for p in &park.tabs {
                if p.group_id.is_some() || known.contains(&p.id) {
                    continue;
                }
                known.insert(p.id.clone());
                mark(&p.id, is_row(p.snapshot.pin.as_ref()), &mut values);
            }
        }
        let base_tabs: HashSet<String> = cx
            .base_keys(PIN_TAB)
            .iter()
            .map(|k| key_of(PIN_TAB, k).to_owned())
            .collect();
        let republished: HashSet<String> = cx
            .base_keys(PIN_ROW)
            .into_iter()
            .chain(values.keys().cloned())
            .filter(|k| choice_still_out(&chosen, key_of(PIN_ROW, k), cx.stamp(k)) && !cx.queued(k))
            .collect();
        let cycle = self.cx.clone();
        let profile = self.profile.clone();
        Some(
            Extraction::of(values)
                .ignoring(move |k| {
                    !known.contains(key_of(PIN_ROW, k)) && !base_tabs.contains(key_of(PIN_ROW, k))
                })
                .republishing(move |k| republished.contains(k))
                .on_published(move |keys| {
                    let published = keys
                        .iter()
                        .map(|k| key_of(PIN_ROW, k).to_owned())
                        .filter_map(|k| {
                            chosen
                                .get(&k)
                                .and_then(Value::as_str)
                                .map(|v| (k.clone(), v.to_owned()))
                        })
                        .collect();
                    settle_choices(&cycle, &profile, published);
                }),
        )
    }

    fn apply(
        &mut self,
        visible: &IndexMap<String, Value>,
        changed: &IndexSet<String>,
        records: &ApplyRecords,
    ) -> bool {
        let s = self.cx.host.state();
        let rows: HashSet<&str> = visible
            .iter()
            .filter(|(_, v)| v.as_i64() == Some(ROW))
            .map(|(k, _)| key_of(PIN_ROW, k))
            .collect();
        let still: HashSet<&str> = visible.keys().map(|k| key_of(PIN_ROW, k)).collect();
        let touched: HashSet<&str> = changed
            .iter()
            .map(|k| key_of(PIN_ROW, k))
            .filter(|k| still.contains(k))
            .collect();
        let wants = |key: &str, row: bool| touched.contains(key) && row != rows.contains(key);
        let pos_of = |key: &str| {
            records
                .base(&format!("{PIN_TAB}{key}"))
                .and_then(|v| v.get("pos").and_then(Value::as_str).map(str::to_owned))
        };
        let anchor = |group: &str| anchor_in(records.base(&format!("{PIN_ORDER}{group}")).as_ref());
        let mut next = (*s).clone();
        let mut edited = false;
        for w in main_windows(&s) {
            let mut moved = false;
            for id in &w.tab_ids {
                let Some(t) = next.tabs.get(id).cloned() else {
                    continue;
                };
                if t.pin.is_none()
                    || t.profile_id != self.profile
                    || !wants(t.pin_key(), is_row(t.pin.as_ref()))
                {
                    continue;
                }
                if let Some(tab) = tab_mut(&mut next, id) {
                    tab.pin = Some(if rows.contains(t.pin_key()) {
                        TabPin::Row
                    } else {
                        TabPin::TILE
                    });
                }
                moved = true;
            }
            if !moved {
                continue;
            }
            let mut ids = w.tab_ids.clone();
            let slots: Vec<usize> = ids
                .iter()
                .enumerate()
                .filter(|(_, id)| {
                    next.tabs.get(*id).is_some_and(|t| {
                        t.pin.is_some()
                            && t.profile_id == self.profile
                            && pos_of(t.pin_key()).is_some()
                    })
                })
                .map(|(i, _)| i)
                .collect();
            let mut sorted: Vec<ardia_state::TabId> =
                slots.iter().map(|i| ids[*i].clone()).collect();
            sorted.sort_by_key(|id| {
                next.tabs
                    .get(id)
                    .and_then(|t| pos_of(t.pin_key()))
                    .unwrap_or_default()
            });
            for (slot, id) in slots.iter().zip(sorted) {
                ids[*slot] = id;
            }
            arrange_window(&mut next, &w.id, &self.profile, &anchor, ids);
            edited = true;
        }
        if let Some(park) = s.persisted.parked_pins.get(&self.profile) {
            let mut marked = park.clone();
            for p in marked.tabs.iter_mut() {
                if p.group_id.is_none() && wants(&p.id, is_row(p.snapshot.pin.as_ref())) {
                    p.snapshot.pin = Some(if rows.contains(p.id.as_str()) {
                        TabPin::Row
                    } else {
                        TabPin::TILE
                    });
                }
            }
            let parked = area::arrange_parked(&marked, &anchor);
            if parked != *park {
                set_parked(&mut next, &self.profile, parked);
                edited = true;
            }
        }
        if edited {
            self.cx.host.replace_state(next);
        }
        true
    }
}

pub struct OrderAdapter {
    cx: CycleContext,
    profile: ProfileId,
}

impl OrderAdapter {
    pub fn new(cx: &CycleContext, profile: &ProfileId) -> Self {
        OrderAdapter {
            cx: cx.clone(),
            profile: profile.clone(),
        }
    }

    fn shown_in(&self, s: &BrowserState) -> Vec<Arc<ardia_state::windows::BrowserWindow>> {
        main_windows(s)
            .into_iter()
            .filter(|w| {
                w.tab_ids
                    .iter()
                    .any(|id| s.tabs.get(id).is_some_and(|t| t.profile_id == self.profile))
            })
            .collect()
    }
}

impl Adapter for OrderAdapter {
    fn prefix(&self) -> &str {
        PIN_ORDER
    }

    fn extract(&mut self, cx: &ExtractContext) -> Option<Extraction> {
        let s = self.cx.host.state();
        let home = home_window(&s, &self.profile);
        let shown_windows = self.shown_in(&s);
        let home_window = home
            .as_ref()
            .and_then(|h| shown_windows.iter().find(|w| w.id == *h))
            .cloned();
        let gone: HashSet<String> = cx
            .base_keys(PIN_ORDER)
            .iter()
            .map(|k| key_of(PIN_ORDER, k).to_owned())
            .filter(|g| {
                cx.remote(&format!("{PIN_GROUP}{g}"))
                    .is_some_and(Value::is_null)
            })
            .collect();
        let ignore = move |k: &str| !gone.contains(key_of(PIN_ORDER, k));
        let park = s.persisted.parked_pins.get(&self.profile);
        if home_window.is_none() && park.is_none() {
            return Some(Extraction::of(IndexMap::new()).ignoring(ignore));
        }
        let keys: Vec<BlockKey> = match (&home_window, park) {
            (Some(w), _) => {
                area::area_keys(&area::pinned_blocks(&s.tabs, &s.groups, w, &self.profile))
            }
            (None, Some(park)) => area::area_keys(&area::parked_blocks(park)),
            (None, None) => Vec::new(),
        };
        let anchors = area::anchors_of(&keys);
        let rows: HashSet<String> = keys
            .iter()
            .filter_map(|k| match k {
                BlockKey::Row(id) => Some(id.clone()),
                BlockKey::Group(_) => None,
            })
            .collect();
        let chosen = choices(&s, &self.profile);
        let mut values = IndexMap::new();
        for (group, a) in &anchors {
            let key = format!("{PIN_ORDER}{group}");
            let was = cx.base(&key);
            let was_a = was
                .as_ref()
                .and_then(|w| w.get("a"))
                .and_then(Value::as_str)
                .map(str::to_owned);
            let since = cx.stamp(&key);
            let changed_since =
                |k: &str| since.is_some_and(|since| cx.stamp(k).unwrap_or("") > since);
            let pin = was_a
                .as_ref()
                .and_then(|a| cx.remote(&format!("{PIN_TAB}{a}")));
            let left_rows = was_a
                .as_ref()
                .is_some_and(|a| changed_since(&format!("{PIN_TAB}{a}")))
                && pin.is_some_and(|p| p.is_null() || !p.get("g").is_none_or(Value::is_null));
            let made_tile = was_a.as_ref().is_some_and(|a| {
                changed_since(&format!("{PIN_ROW}{a}"))
                    && cx.remote(&format!("{PIN_ROW}{a}")).and_then(Value::as_i64) != Some(ROW)
            });
            let settled = left_rows || made_tile;
            let waiting = !chosen.contains_key(&order_choice_key(group))
                && was_a
                    .as_ref()
                    .is_some_and(|w| Some(w) != a.as_ref() && !rows.contains(w))
                && !settled;
            let value = match (waiting, was) {
                (true, Some(was)) => was,
                _ => json!({ "a": a }),
            };
            values.insert(key, value);
        }
        let republished: HashSet<String> = values
            .keys()
            .filter(|k| {
                choice_still_out(
                    &chosen,
                    &order_choice_key(key_of(PIN_ORDER, k)),
                    cx.stamp(k),
                ) && !cx.queued(k)
            })
            .cloned()
            .collect();
        let cycle = self.cx.clone();
        let profile = self.profile.clone();
        Some(
            Extraction::of(values)
                .ignoring(ignore)
                .republishing(move |k| republished.contains(k))
                .on_published(move |keys| {
                    let published = keys
                        .iter()
                        .map(|k| order_choice_key(key_of(PIN_ORDER, k)))
                        .filter_map(|c| {
                            chosen
                                .get(&c)
                                .and_then(Value::as_str)
                                .map(|v| (c.clone(), v.to_owned()))
                        })
                        .collect();
                    settle_choices(&cycle, &profile, published);
                }),
        )
    }

    fn apply(
        &mut self,
        visible: &IndexMap<String, Value>,
        _changed: &IndexSet<String>,
        _records: &ApplyRecords,
    ) -> bool {
        let s = self.cx.host.state();
        let anchor = |group: &str| anchor_in(visible.get(&format!("{PIN_ORDER}{group}")));
        let mut next = (*s).clone();
        let mut edited = false;
        for w in self.shown_in(&s) {
            let tab_ids =
                area::arrange_pinned_area(&next.tabs, &next.groups, &w, &self.profile, &anchor);
            if tab_ids == w.tab_ids {
                continue;
            }
            let mut window = (*w).clone();
            window.tab_ids = tab_ids;
            ardia_state::groups::sync_group_order(
                Arc::make_mut(&mut next.groups),
                &window.id,
                &window.tab_ids,
            );
            Arc::make_mut(&mut next.windows).insert(w.id.clone(), Arc::new(window));
            edited = true;
        }
        if let Some(park) = s.persisted.parked_pins.get(&self.profile) {
            let parked = area::arrange_parked(park, &anchor);
            if parked != *park {
                set_parked(&mut next, &self.profile, parked);
                edited = true;
            }
        }
        if edited {
            self.cx.host.replace_state(next);
        }
        true
    }
}

pub struct GroupLooksAdapter {
    cx: CycleContext,
    profile: ProfileId,
}

impl GroupLooksAdapter {
    pub fn new(cx: &CycleContext, profile: &ProfileId) -> Self {
        GroupLooksAdapter {
            cx: cx.clone(),
            profile: profile.clone(),
        }
    }
}

impl Adapter for GroupLooksAdapter {
    fn prefix(&self) -> &str {
        GROUP_LOOK
    }

    fn extract(&mut self, cx: &ExtractContext) -> Option<Extraction> {
        let s = self.cx.host.state();
        let mut values = IndexMap::new();
        let mut known: HashSet<String> = HashSet::new();
        let mut offer =
            |key: &str, color: Option<GroupColor>, values: &mut IndexMap<String, Value>| {
                if !known.insert(key.to_owned()) {
                    return;
                }
                if color == Some(GroupColor::NoColor) {
                    values.insert(format!("{GROUP_LOOK}{key}"), json!(NO_BOX));
                }
            };
        for g in s.groups.values() {
            if g.pinned && g.profile_id == self.profile {
                offer(g.pin_key(), g.color, &mut values);
            }
        }
        if let Some(park) = s.persisted.parked_pins.get(&self.profile) {
            for g in &park.groups {
                offer(&g.id, g.color, &mut values);
            }
        }
        let records = |key: &str| {
            [
                format!("{PIN_GROUP}{key}"),
                format!("{PIN_NEST_GROUP}{key}"),
            ]
        };
        let gone: HashSet<String> = cx
            .base_keys(GROUP_LOOK)
            .iter()
            .map(|k| key_of(GROUP_LOOK, k).to_owned())
            .filter(|key| {
                let pair = records(key);
                pair.iter().any(|k| cx.known(k))
                    && pair.iter().all(|k| cx.remote(k).is_none_or(Value::is_null))
            })
            .collect();
        Some(Extraction::of(values).ignoring(move |k| {
            !known.contains(key_of(GROUP_LOOK, k)) && !gone.contains(key_of(GROUP_LOOK, k))
        }))
    }

    fn apply(
        &mut self,
        visible: &IndexMap<String, Value>,
        changed: &IndexSet<String>,
        _records: &ApplyRecords,
    ) -> bool {
        let touched: HashSet<&str> = changed.iter().map(|k| key_of(GROUP_LOOK, k)).collect();
        if touched.is_empty() {
            return true;
        }
        let wanted = |key: &str, color: Option<GroupColor>| -> Option<Option<GroupColor>> {
            if !touched.contains(key) {
                return None;
            }
            let legacy = legacy_color(color);
            let next = looked_color(Some(&legacy), visible.get(&format!("{GROUP_LOOK}{key}")));
            (next != color).then_some(next)
        };
        let s = self.cx.host.state();
        let mut next = (*s).clone();
        let mut edited = false;
        for g in s.groups.values() {
            if !g.pinned || g.profile_id != self.profile {
                continue;
            }
            if let Some(color) = wanted(g.pin_key(), g.color)
                && let Some(group) = Arc::make_mut(&mut next.groups).get_mut(&g.id)
            {
                Arc::make_mut(group).color = color;
                edited = true;
            }
        }
        if let Some(park) = s.persisted.parked_pins.get(&self.profile) {
            let mut park = park.clone();
            let mut park_edited = false;
            for g in park.groups.iter_mut() {
                if let Some(color) = wanted(&g.id, g.color) {
                    g.color = color;
                    park_edited = true;
                }
            }
            if park_edited {
                set_parked(&mut next, &self.profile, park);
                edited = true;
            }
        }
        if edited {
            self.cx.host.replace_state(next);
        }
        true
    }
}

pub struct HomesAdapter {
    cx: CycleContext,
    profile: ProfileId,
}

impl HomesAdapter {
    pub fn new(cx: &CycleContext, profile: &ProfileId) -> Self {
        HomesAdapter {
            cx: cx.clone(),
            profile: profile.clone(),
        }
    }
}

impl Adapter for HomesAdapter {
    fn prefix(&self) -> &str {
        PIN_HOME
    }

    fn publish_after_pull(&self) -> bool {
        true
    }

    fn extract(&mut self, cx: &ExtractContext) -> Option<Extraction> {
        let s = self.cx.host.state();
        let mut values = IndexMap::new();
        let mut known: HashSet<String> = HashSet::new();
        let mut held: HashSet<String> = HashSet::new();
        let mut offer =
            |key: &str, member: bool, home: Option<&str>, values: &mut IndexMap<String, Value>| {
                if !known.insert(key.to_owned()) || !member {
                    return;
                }
                let k = format!("{PIN_HOME}{key}");
                match home.filter(|h| !h.is_empty()) {
                    None => {
                        held.insert(key.to_owned());
                    }
                    Some(home) => {
                        if cx.base(&k).is_some() || cx.remote(&k).is_none_or(Value::is_null) {
                            values.insert(k, json!(home));
                        }
                    }
                }
            };
        let members = pinned_members(&s);
        let home = home_window(&s, &self.profile);
        for w in windows_home_first(&s, home.as_ref()) {
            for id in &w.tab_ids {
                let Some(t) = s.tabs.get(id) else { continue };
                if t.profile_id == self.profile && (t.pin.is_some() || members.contains(id)) {
                    offer(
                        t.pin_key(),
                        t.pin.is_none(),
                        t.pinned_url.as_deref(),
                        &mut values,
                    );
                }
            }
        }
        if let Some(park) = s.persisted.parked_pins.get(&self.profile) {
            for p in &park.tabs {
                let home = p
                    .snapshot
                    .pinned_url
                    .clone()
                    .filter(|u| !u.is_empty())
                    .unwrap_or_else(|| p.snapshot.url.clone());
                offer(&p.id, p.group_id.is_some(), Some(&home), &mut values);
            }
        }
        let base_tabs: HashSet<String> = cx
            .base_keys(PIN_TAB)
            .iter()
            .map(|k| key_of(PIN_TAB, k).to_owned())
            .collect();
        let unpinned: HashSet<String> = cx
            .base_keys(PIN_HOME)
            .iter()
            .map(|k| key_of(PIN_HOME, k).to_owned())
            .filter(|k| unpinned_remotely(cx, k))
            .collect();
        Some(Extraction::of(values).ignoring(move |k| {
            let key = key_of(PIN_HOME, k);
            held.contains(key)
                || (!known.contains(key) && !base_tabs.contains(key) && !unpinned.contains(key))
        }))
    }

    fn apply(
        &mut self,
        visible: &IndexMap<String, Value>,
        changed: &IndexSet<String>,
        records: &ApplyRecords,
    ) -> bool {
        let incoming: HashMap<&str, String> = changed
            .iter()
            .filter_map(|k| synced_home(visible.get(k)).map(|h| (key_of(PIN_HOME, k), h)))
            .collect();
        if incoming.is_empty() {
            return true;
        }
        let wanted = |key: &str, current: Option<&str>| -> Option<String> {
            let home = incoming.get(key)?;
            if Some(home.as_str()) == current {
                return None;
            }
            let synced = synced_home(records.base(&format!("{PIN_HOME}{key}")).as_ref());
            (current.is_none_or(str::is_empty) || synced.is_none() || synced.as_deref() == current)
                .then(|| home.clone())
        };
        let s = self.cx.host.state();
        let mut next = (*s).clone();
        let mut edited = false;
        for id in pinned_members(&s) {
            let Some(t) = s.tabs.get(&id) else { continue };
            if t.profile_id != self.profile || t.pin.is_some() {
                continue;
            }
            if let Some(home) = wanted(t.pin_key(), t.pinned_url.as_deref())
                && let Some(tab) = tab_mut(&mut next, &id)
            {
                tab.pinned_url = Some(home);
                edited = true;
            }
        }
        if let Some(park) = s.persisted.parked_pins.get(&self.profile) {
            let mut park = park.clone();
            let mut park_edited = false;
            for p in park.tabs.iter_mut() {
                if p.group_id.is_none() {
                    continue;
                }
                let current = p
                    .snapshot
                    .pinned_url
                    .clone()
                    .filter(|u| !u.is_empty())
                    .unwrap_or_else(|| p.snapshot.url.clone());
                if let Some(home) = wanted(&p.id, Some(&current)) {
                    if p.snapshot.url != home {
                        p.restore_from = None;
                        p.snapshot.url = home.clone();
                    }
                    p.snapshot.pinned_url = Some(home);
                    park_edited = true;
                }
            }
            if park_edited {
                set_parked(&mut next, &self.profile, park);
                edited = true;
            }
        }
        if edited {
            self.cx.host.replace_state(next);
        }
        true
    }
}

pub struct LettersAdapter {
    cx: CycleContext,
    profile: ProfileId,
    unpinned: HashSet<String>,
}

impl LettersAdapter {
    pub fn new(cx: &CycleContext, profile: &ProfileId) -> Self {
        LettersAdapter {
            cx: cx.clone(),
            profile: profile.clone(),
            unpinned: HashSet::new(),
        }
    }

    fn local_pin_keys(&self, s: &BrowserState) -> HashSet<String> {
        let members = pinned_members(s);
        let mut keys: HashSet<String> = s
            .tabs
            .values()
            .filter(|t| {
                t.profile_id == self.profile && (t.pin.is_some() || members.contains(&t.id))
            })
            .map(|t| t.pin_key().to_owned())
            .collect();
        if let Some(park) = s.persisted.parked_pins.get(&self.profile) {
            keys.extend(park.tabs.iter().map(|p| p.id.clone()));
        }
        keys
    }
}

fn clean_letters(value: Option<&Value>) -> Option<String> {
    value.and_then(Value::as_str).and_then(clean_tile_letters)
}

impl Adapter for LettersAdapter {
    fn prefix(&self) -> &str {
        PIN_LETTERS
    }

    fn extract(&mut self, cx: &ExtractContext) -> Option<Extraction> {
        let s = self.cx.host.state();
        let mut values = IndexMap::new();
        let mut known: HashSet<String> = HashSet::new();
        let mut offer = |key: &str, letters: Option<&str>, values: &mut IndexMap<String, Value>| {
            if !known.insert(key.to_owned()) {
                return;
            }
            let k = format!("{PIN_LETTERS}{key}");
            let base = cx.base(&k);
            match letters.filter(|l| !l.is_empty()) {
                Some(letters) => {
                    let kept = if clean_letters(base.as_ref()).as_deref() == Some(letters) {
                        base.unwrap_or(Value::Null)
                    } else {
                        json!(letters)
                    };
                    values.insert(k, kept);
                }
                None => {
                    if base.is_some() {
                        values.insert(k, json!(""));
                    }
                }
            }
        };
        let members = pinned_members(&s);
        for w in windows_home_first(&s, home_window(&s, &self.profile).as_ref()) {
            for id in &w.tab_ids {
                let Some(t) = s.tabs.get(id) else { continue };
                if t.profile_id == self.profile && (t.pin.is_some() || members.contains(id)) {
                    offer(t.pin_key(), t.tile_letters.as_deref(), &mut values);
                }
            }
        }
        if let Some(park) = s.persisted.parked_pins.get(&self.profile) {
            for p in &park.tabs {
                offer(&p.id, p.snapshot.tile_letters.as_deref(), &mut values);
            }
        }
        self.unpinned = cx
            .state()
            .records
            .keys()
            .filter_map(|k| k.strip_prefix(PIN_TAB))
            .filter(|k| unpinned_remotely(cx, k))
            .map(str::to_owned)
            .collect();
        let unpinned = self.unpinned.clone();
        let base_tabs: HashSet<String> = cx
            .base_keys(PIN_TAB)
            .iter()
            .map(|k| key_of(PIN_TAB, k).to_owned())
            .collect();
        Some(Extraction::of(values).ignoring(move |k| {
            let key = key_of(PIN_LETTERS, k);
            !known.contains(key) && !base_tabs.contains(key) && !unpinned.contains(key)
        }))
    }

    fn apply(
        &mut self,
        visible: &IndexMap<String, Value>,
        changed: &IndexSet<String>,
        records: &ApplyRecords,
    ) -> bool {
        let s = self.cx.host.state();
        let pins = self.local_pin_keys(&s);
        let mut incoming: HashMap<String, Option<String>> = HashMap::new();
        for k in changed {
            let letters = clean_letters(visible.get(k));
            let key = key_of(PIN_LETTERS, k);
            if !pins.contains(key) && letters.is_some() && !self.unpinned.contains(key) {
                records.defer(k);
            } else {
                incoming.insert(key.to_owned(), letters);
            }
        }
        if incoming.is_empty() {
            return true;
        }
        let members = pinned_members(&s);
        let mut next = (*s).clone();
        let mut edited = false;
        for t in s.tabs.values() {
            if t.profile_id != self.profile || !(t.pin.is_some() || members.contains(&t.id)) {
                continue;
            }
            let Some(letters) = incoming.get(t.pin_key()) else {
                continue;
            };
            if *letters != t.tile_letters
                && let Some(tab) = tab_mut(&mut next, &t.id)
            {
                tab.tile_letters = letters.clone();
                edited = true;
            }
        }
        if let Some(park) = s.persisted.parked_pins.get(&self.profile) {
            let mut park = park.clone();
            let mut park_edited = false;
            for p in park.tabs.iter_mut() {
                if let Some(letters) = incoming.get(&p.id)
                    && *letters != p.snapshot.tile_letters
                {
                    p.snapshot.tile_letters = letters.clone();
                    park_edited = true;
                }
            }
            if park_edited {
                set_parked(&mut next, &self.profile, park);
                edited = true;
            }
        }
        if edited {
            self.cx.host.replace_state(next);
        }
        true
    }
}
