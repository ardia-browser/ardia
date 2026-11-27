pub mod apply;
pub mod area;
pub mod extract;
pub mod open_tabs;
pub mod small;

use std::collections::{HashMap, HashSet};
use std::sync::Arc;

use ardia_state::groups::GroupColor;
use ardia_state::model::{TabPin, TileFolder};
use ardia_state::sync_engine::scope::{
    Adapter, ApplyRecords, ExtractContext, Extraction, ScopeState,
};
use ardia_state::sync_engine::{IndexMap, IndexSet};
use ardia_state::windows::{BrowserWindow, WindowKind};
use ardia_state::{BrowserState, ProfileId, WindowId};
use serde_json::{Map, Value};

use super::{CycleContext, InTodaysNames};

pub const PIN_TAB: &str = "pin:t:";
pub const PIN_GROUP: &str = "pin:g:";
pub const PIN_NEST: &str = "pinn:";
pub const PIN_NEST_GROUP: &str = "pinn:g:";
pub const PIN_NEST_TAB: &str = "pinn:t:";
pub const GROUP_LOOK: &str = "pgc:";
pub const NO_BOX: &str = "none";
pub const PIN_ORDER: &str = "pord:g:";
pub const PIN_ROW: &str = "pinrow:";
pub const ROW: i64 = 1;
pub const TILE: i64 = 0;
pub const PIN_HOME: &str = "pgh:";
pub const PIN_LETTERS: &str = "plet:";
pub const TILE_FOLDER: &str = "tilefold:";
pub const FOLDER_NAME: &str = "tilefold:n:";

pub fn group_choice_key(key: &str) -> String {
    format!("group:{key}")
}

pub fn place_choice_key(key: &str) -> String {
    format!("place:{key}")
}

pub fn order_choice_key(key: &str) -> String {
    format!("order:{key}")
}

pub fn legacy_color(color: Option<GroupColor>) -> Value {
    match color {
        None | Some(GroupColor::NoColor) => Value::Null,
        Some(c) => Value::String(c.key().to_owned()),
    }
}

pub fn looked_color(color: Option<&Value>, look: Option<&Value>) -> Option<GroupColor> {
    let parsed = color.and_then(Value::as_str).and_then(GroupColor::from_key);
    if parsed.is_none() && look.and_then(Value::as_str) == Some(NO_BOX) {
        return Some(GroupColor::NoColor);
    }
    parsed
}

pub fn anchor_in(value: Option<&Value>) -> Option<Option<String>> {
    let a = value?.as_object()?.get("a")?;
    match a {
        Value::Null => Some(None),
        Value::String(s) => Some(Some(s.clone())),
        _ => None,
    }
}

pub fn synced_home(value: Option<&Value>) -> Option<String> {
    value
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .map(str::to_owned)
}

pub fn synced_folder_id(value: Option<&Value>) -> Option<String> {
    value?.as_object()?.get("f")?.as_str().map(str::to_owned)
}

pub fn synced_name(value: Option<&Value>) -> Option<String> {
    value?.as_object()?.get("n")?.as_str().map(str::to_owned)
}

pub fn marked_tile(base: &dyn Fn(&str) -> Option<Value>, key: &str) -> TabPin {
    match synced_folder_id(base(&format!("{TILE_FOLDER}{key}")).as_ref()) {
        Some(id) => {
            let name =
                synced_name(base(&format!("{FOLDER_NAME}{id}")).as_ref()).unwrap_or_default();
            TabPin::Tile {
                folder: Some(TileFolder {
                    id,
                    name,
                    renamed_at: None,
                }),
            }
        }
        None => TabPin::TILE,
    }
}

pub fn is_row(pin: Option<&TabPin>) -> bool {
    pin.is_some_and(TabPin::is_row)
}

pub fn main_windows(s: &BrowserState) -> Vec<Arc<BrowserWindow>> {
    s.window_order
        .iter()
        .filter_map(|id| s.windows.get(id))
        .filter(|w| w.kind == WindowKind::Main)
        .cloned()
        .collect()
}

pub fn home_window(s: &BrowserState, profile: &ProfileId) -> Option<WindowId> {
    let mut order: Vec<&WindowId> = Vec::new();
    for id in s.focus_order.iter().chain(s.window_order.iter()) {
        if !order.contains(&id) {
            order.push(id);
        }
    }
    let windows: Vec<&Arc<BrowserWindow>> = order
        .into_iter()
        .filter_map(|id| s.windows.get(id))
        .filter(|w| w.kind == WindowKind::Main)
        .collect();
    let shows = |w: &BrowserWindow| {
        w.tab_ids
            .iter()
            .any(|id| s.tabs.get(id).is_some_and(|t| t.profile_id == *profile))
    };
    windows
        .iter()
        .find(|w| w.profile_id == *profile && shows(w))
        .or_else(|| windows.iter().find(|w| shows(w)))
        .or_else(|| windows.iter().find(|w| w.profile_id == *profile))
        .or_else(|| windows.first())
        .map(|w| w.id.clone())
}

pub fn windows_home_first(s: &BrowserState, home: Option<&WindowId>) -> Vec<Arc<BrowserWindow>> {
    let all = main_windows(s);
    match home.and_then(|h| s.windows.get(h)) {
        Some(home) => std::iter::once(home.clone())
            .chain(all.into_iter().filter(|w| w.id != home.id))
            .collect(),
        None => all,
    }
}

pub fn choices(s: &BrowserState, profile: &ProfileId) -> Map<String, Value> {
    s.persisted
        .pin_choices
        .get(profile.as_str())
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default()
}

pub fn pin_sync(s: &BrowserState, profile: &ProfileId) -> Map<String, Value> {
    s.persisted
        .pin_sync
        .get(profile.as_str())
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default()
}

pub fn choice_still_out(chosen: &Map<String, Value>, choice: &str, stamp: Option<&str>) -> bool {
    match chosen.get(choice).and_then(Value::as_str) {
        Some(at) => stamp.is_none_or(|stamp| stamp < at),
        None => false,
    }
}

pub fn settle_choices(cx: &CycleContext, profile: &ProfileId, published: HashMap<String, String>) {
    if published.is_empty() {
        return;
    }
    let s = cx.host.state();
    let Some(mine) = s
        .persisted
        .pin_choices
        .get(profile.as_str())
        .and_then(Value::as_object)
    else {
        return;
    };
    let left: Map<String, Value> = mine
        .iter()
        .filter(|(k, v)| published.get(*k).map(String::as_str) != v.as_str())
        .map(|(k, v)| (k.clone(), v.clone()))
        .collect();
    if left.len() == mine.len() {
        return;
    }
    let mut next = (*s).clone();
    let persisted = Arc::make_mut(&mut next.persisted);
    if left.is_empty() {
        persisted.pin_choices.shift_remove(profile.as_str());
    } else {
        persisted
            .pin_choices
            .insert(profile.as_str().to_owned(), Value::Object(left));
    }
    cx.host.replace_state(next);
}

pub fn unpinned_remotely(cx: &ExtractContext, key: &str) -> bool {
    let k = format!("{PIN_TAB}{key}");
    cx.known(&k) && cx.remote(&k).is_some_and(Value::is_null)
}

pub fn pinned_members(s: &BrowserState) -> HashSet<ardia_state::TabId> {
    ardia_state::groups::pinned_group_members(&s.groups)
}

pub fn new_tab_id() -> ardia_state::TabId {
    ardia_state::TabId::new(format!("tab-{}", uuid::Uuid::new_v4().simple()))
}

pub fn new_group_id() -> ardia_state::GroupId {
    ardia_state::GroupId::new(format!("g-{}", uuid::Uuid::new_v4().simple()))
}

pub struct PinnedAdapter {
    cx: CycleContext,
    profile: ProfileId,
}

impl Adapter for PinnedAdapter {
    fn prefix(&self) -> &str {
        "pin"
    }

    fn extract(&mut self, cx: &ExtractContext) -> Option<Extraction> {
        Some(extract::extract_pinned(&self.cx, &self.profile, cx))
    }

    fn apply(
        &mut self,
        visible: &IndexMap<String, Value>,
        changed: &IndexSet<String>,
        records: &ApplyRecords,
    ) -> bool {
        let before = self.cx.host.state();
        let ok = apply::apply_pinned(&self.cx, &self.profile, visible, changed, records);
        let after = self.cx.host.state();
        open_tabs::note_pin_pages(&self.cx, &self.profile, &before, &after);
        ok
    }
}

pub fn adapters(
    cx: &CycleContext,
    profile: &ProfileId,
    synced_pinned: bool,
) -> Vec<Box<dyn Adapter>> {
    let mut list: Vec<Box<dyn Adapter>> = Vec::new();
    if synced_pinned {
        list.push(Box::new(small::TileFoldersAdapter::new(cx, profile)));
        list.push(Box::new(small::RowsAdapter::new(cx, profile)));
        list.push(Box::new(small::OrderAdapter::new(cx, profile)));
        list.push(Box::new(small::GroupLooksAdapter::new(cx, profile)));
        list.push(Box::new(InTodaysNames(small::HomesAdapter::new(
            cx, profile,
        ))));
        list.push(Box::new(InTodaysNames(PinnedAdapter {
            cx: cx.clone(),
            profile: profile.clone(),
        })));
        list.push(Box::new(small::LettersAdapter::new(cx, profile)));
    }
    list.extend(open_tabs::adapters(cx, profile));
    list
}

pub fn prepare_scope(cx: &CycleContext, profile: &ProfileId, state: &mut ScopeState) {
    open_tabs::prepare(cx, profile, state);
}

#[cfg(test)]
mod tests;
