use crate::groups::{ClosedGroupInfo, GroupColor, TabGroup};
use crate::ids::{EntryId, GroupId, ProfileId, SplitId, TabId, WindowId};
use crate::json::{self, Fields};
use crate::model::{Frame, Millis, Orientation, TabLayout};
use crate::splits::{SplitSlot, SplitView};
use crate::tabs::TabSnapshot;
use serde::{Deserialize, Deserializer, Serialize};
use serde_json::Value;

pub const MAX_CLOSED_TABS: usize = 50;
pub const MAX_CLOSED_WINDOWS: usize = 10;
pub const MAX_CLOSED_GROUPS: usize = 20;
pub const PURGED_AFTER_MS: Millis = 7 * 86_400_000;
pub const MAX_CLEANED: usize = 100;

fn tab_kind<'de, D: Deserializer<'de>>(deserializer: D) -> Result<ClosedKind, D::Error> {
    let _ = Value::deserialize(deserializer)?;
    Ok(ClosedKind::Tab)
}

fn window_kind<'de, D: Deserializer<'de>>(deserializer: D) -> Result<ClosedKind, D::Error> {
    let _ = Value::deserialize(deserializer)?;
    Ok(ClosedKind::Window)
}

fn group_kind<'de, D: Deserializer<'de>>(deserializer: D) -> Result<ClosedKind, D::Error> {
    let _ = Value::deserialize(deserializer)?;
    Ok(ClosedKind::Group)
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ClosedKind {
    #[default]
    Tab,
    Window,
    Group,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClosedTab {
    #[serde(default, deserialize_with = "tab_kind")]
    pub kind: ClosedKind,
    pub id: EntryId,
    pub tab: TabSnapshot,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "json::lenient"
    )]
    pub tab_id: Option<TabId>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "json::lenient"
    )]
    pub restore_from: Option<String>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "json::lenient"
    )]
    pub close_batch: Option<String>,
    #[serde(default, deserialize_with = "json::lenient")]
    pub window_id: WindowId,
    #[serde(default, deserialize_with = "json::lenient")]
    pub index: usize,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "json::lenient"
    )]
    pub profile_index: Option<usize>,
    #[serde(default, deserialize_with = "json::lenient_option")]
    pub group: Option<ClosedGroupInfo>,
    #[serde(
        default,
        skip_serializing_if = "Vec::is_empty",
        deserialize_with = "json::lenient"
    )]
    pub parents: Vec<ClosedGroupInfo>,
    #[serde(default, deserialize_with = "json::millis")]
    pub closed_at: Millis,
    #[serde(
        default,
        skip_serializing_if = "json::is_false",
        serialize_with = "json::serialize_true",
        deserialize_with = "json::true_flag"
    )]
    pub pinned_tile: bool,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "json::lenient"
    )]
    pub pin_key: Option<String>,
    #[serde(
        default,
        skip_serializing_if = "json::is_false",
        serialize_with = "json::serialize_true",
        deserialize_with = "json::true_flag"
    )]
    pub small: bool,
    #[serde(flatten)]
    pub extra: Fields,
}

impl ClosedTab {
    pub fn row_is_valid(row: &Value) -> bool {
        row.as_object().is_some_and(|f| {
            json::string(f.get("id")) && f.get("tab").is_some_and(TabSnapshot::row_is_valid)
        })
    }
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClosedWindowFrame {
    #[serde(default, deserialize_with = "json::lenient")]
    pub profile_id: Option<ProfileId>,
    #[serde(default, deserialize_with = "json::lenient_option")]
    pub frame: Option<Frame>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "json::lenient_option"
    )]
    pub restored_frame: Option<Frame>,
    #[serde(
        default,
        skip_serializing_if = "json::is_false",
        serialize_with = "json::serialize_true",
        deserialize_with = "json::true_flag"
    )]
    pub maximized: bool,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "json::lenient_option"
    )]
    pub tab_layout: Option<TabLayout>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "json::lenient_option"
    )]
    pub auto_hide_tabs: Option<bool>,
    #[serde(flatten)]
    pub extra: Fields,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClosedWindowTab {
    #[serde(flatten)]
    pub snapshot: TabSnapshot,
    #[serde(default, deserialize_with = "json::lenient")]
    pub active: bool,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "json::lenient"
    )]
    pub tab_id: Option<TabId>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClosedWindowGroup {
    pub id: GroupId,
    #[serde(default, deserialize_with = "json::lenient")]
    pub name: String,
    #[serde(default, deserialize_with = "json::lenient")]
    pub icon: Option<String>,
    #[serde(default, deserialize_with = "json::lenient_option")]
    pub color: Option<GroupColor>,
    #[serde(default, deserialize_with = "json::lenient")]
    pub collapsed: bool,
    #[serde(default, deserialize_with = "json::lenient")]
    pub pinned: bool,
    #[serde(default, deserialize_with = "json::millis")]
    pub created_at: Millis,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "json::lenient"
    )]
    pub parent_id: Option<GroupId>,
    #[serde(default, deserialize_with = "json::lenient")]
    pub tab_indexes: Vec<usize>,
    #[serde(flatten)]
    pub extra: Fields,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct SplitShape {
    pub orientation: Orientation,
    #[serde(deserialize_with = "slot_list", serialize_with = "slot_values")]
    pub slots: Vec<SplitSlot>,
}

fn slot_list<'de, D: Deserializer<'de>>(deserializer: D) -> Result<Vec<SplitSlot>, D::Error> {
    let value = Value::deserialize(deserializer)?;
    crate::splits::slots_from_disk(Some(&value))
        .ok_or_else(|| serde::de::Error::custom("bad split slots"))
}

fn slot_values<S: serde::Serializer>(
    slots: &[SplitSlot],
    serializer: S,
) -> Result<S::Ok, S::Error> {
    Value::Array(slots.iter().map(SplitSlot::to_value).collect()).serialize(serializer)
}

fn split_shapes<'de, D: Deserializer<'de>>(
    deserializer: D,
) -> Result<Option<Vec<SplitShape>>, D::Error> {
    let value = Value::deserialize(deserializer)?;
    let Some(list) = value.as_array() else {
        return Ok(None);
    };
    Ok(Some(
        list.iter()
            .filter_map(|v| SplitShape::deserialize(v).ok())
            .collect(),
    ))
}

impl SplitShape {
    pub fn of(view: &SplitView) -> Self {
        SplitShape {
            orientation: view.orientation,
            slots: view.slots.clone(),
        }
    }

    pub fn into_view(self, id: SplitId, window: WindowId) -> SplitView {
        SplitView::new(id, window, self.orientation, self.slots)
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClosedWindow {
    #[serde(default, deserialize_with = "window_kind")]
    pub kind: ClosedKind,
    pub id: EntryId,
    #[serde(default, deserialize_with = "json::lenient")]
    pub window: ClosedWindowFrame,
    pub tabs: Vec<ClosedWindowTab>,
    #[serde(default, deserialize_with = "json::lenient")]
    pub groups: Vec<ClosedWindowGroup>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "split_shapes"
    )]
    pub splits: Option<Vec<SplitShape>>,
    #[serde(default, deserialize_with = "json::millis")]
    pub closed_at: Millis,
    #[serde(
        default,
        skip_serializing_if = "json::is_false",
        serialize_with = "json::serialize_true",
        deserialize_with = "json::true_flag"
    )]
    pub last_window: bool,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "json::lenient"
    )]
    pub active_pin: Option<String>,
    #[serde(flatten)]
    pub extra: Fields,
}

impl ClosedWindow {
    pub fn without_profile(&self, profile: &crate::ids::ProfileId) -> Option<ClosedWindow> {
        let kept: Vec<usize> = (0..self.tabs.len())
            .filter(|i| self.tabs[*i].snapshot.profile_id != *profile)
            .collect();
        if kept.is_empty() {
            return None;
        }
        if kept.len() == self.tabs.len() {
            return Some(self.clone());
        }
        let moved = |old: usize| kept.iter().position(|k| *k == old);
        let groups = self
            .groups
            .iter()
            .filter_map(|g| {
                let tab_indexes: Vec<usize> =
                    g.tab_indexes.iter().filter_map(|i| moved(*i)).collect();
                (!tab_indexes.is_empty()).then(|| ClosedWindowGroup {
                    tab_indexes,
                    ..g.clone()
                })
            })
            .collect();
        let splits: Vec<SplitShape> = self
            .splits
            .iter()
            .flatten()
            .filter_map(|shape| {
                let view = shape.clone().into_view(SplitId::new(""), WindowId::new(""));
                let panes: Option<Vec<TabId>> = view
                    .tab_ids()
                    .iter()
                    .map(|t| {
                        t.as_str()
                            .parse::<usize>()
                            .ok()
                            .and_then(moved)
                            .map(|i| TabId::new(i.to_string()))
                    })
                    .collect();
                panes.map(|panes| SplitShape::of(&view.with_pane_ids(&panes)))
            })
            .collect();
        let tabs: Vec<ClosedWindowTab> = kept.iter().map(|i| self.tabs[*i].clone()).collect();
        let mut window = self.window.clone();
        if window.profile_id.as_ref() == Some(profile) {
            window.profile_id = Some(tabs[0].snapshot.profile_id.clone());
        }
        Some(ClosedWindow {
            window,
            tabs,
            groups,
            splits: (!splits.is_empty()).then_some(splits),
            ..self.clone()
        })
    }

    pub fn row_is_valid(row: &Value) -> bool {
        row.as_object().is_some_and(|f| {
            json::string(f.get("id"))
                && f.get("tabs")
                    .and_then(Value::as_array)
                    .is_some_and(|tabs| tabs.iter().all(TabSnapshot::row_is_valid))
        })
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NestedGroupSnapshot {
    pub id: GroupId,
    #[serde(default, deserialize_with = "json::lenient")]
    pub name: String,
    #[serde(default, deserialize_with = "json::lenient")]
    pub icon: Option<String>,
    #[serde(default, deserialize_with = "json::lenient_option")]
    pub color: Option<GroupColor>,
    #[serde(default, deserialize_with = "json::lenient")]
    pub collapsed: bool,
    pub parent_id: GroupId,
    #[serde(default, deserialize_with = "json::lenient")]
    pub tab_indexes: Vec<usize>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClosedGroupHeader {
    pub id: GroupId,
    #[serde(default, deserialize_with = "json::lenient")]
    pub name: String,
    #[serde(default, deserialize_with = "json::lenient")]
    pub icon: Option<String>,
    #[serde(default, deserialize_with = "json::lenient_option")]
    pub color: Option<GroupColor>,
    #[serde(default, deserialize_with = "json::lenient")]
    pub pinned: bool,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "json::lenient"
    )]
    pub parent_id: Option<GroupId>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClosedGroup {
    #[serde(default, deserialize_with = "group_kind")]
    pub kind: ClosedKind,
    pub id: EntryId,
    pub group: ClosedGroupHeader,
    pub tabs: Vec<TabSnapshot>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "json::lenient"
    )]
    pub tab_ids: Option<Vec<String>>,
    #[serde(
        default,
        skip_serializing_if = "Vec::is_empty",
        deserialize_with = "json::lenient"
    )]
    pub nested: Vec<NestedGroupSnapshot>,
    #[serde(default, deserialize_with = "json::lenient")]
    pub window_id: WindowId,
    #[serde(default, deserialize_with = "json::lenient")]
    pub index: usize,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "json::lenient"
    )]
    pub profile_index: Option<usize>,
    #[serde(default, deserialize_with = "json::millis")]
    pub closed_at: Millis,
    #[serde(flatten)]
    pub extra: Fields,
}

impl ClosedGroup {
    pub fn row_is_valid(row: &Value) -> bool {
        ClosedWindow::row_is_valid(row)
    }

    pub fn header_of(group: &TabGroup) -> ClosedGroupHeader {
        ClosedGroupHeader {
            id: group.id.clone(),
            name: group.name.clone(),
            icon: group.icon.clone(),
            color: group.color,
            pinned: group.pinned,
            parent_id: group.parent_id.clone(),
        }
    }
}

#[derive(Clone, Debug, PartialEq)]
pub enum ClosedEntry<'a> {
    Tab(&'a ClosedTab),
    Window(&'a ClosedWindow),
    Group(&'a ClosedGroup),
}

impl ClosedEntry<'_> {
    pub fn id(&self) -> &EntryId {
        match self {
            ClosedEntry::Tab(c) => &c.id,
            ClosedEntry::Window(c) => &c.id,
            ClosedEntry::Group(c) => &c.id,
        }
    }

    pub fn closed_at(&self) -> Millis {
        match self {
            ClosedEntry::Tab(c) => c.closed_at,
            ClosedEntry::Window(c) => c.closed_at,
            ClosedEntry::Group(c) => c.closed_at,
        }
    }
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct ClosedLists {
    pub tabs: Vec<ClosedTab>,
    pub windows: Vec<ClosedWindow>,
    pub groups: Vec<ClosedGroup>,
    pub deleted_groups: Vec<ClosedGroup>,
    pub cleaned_tabs: Vec<ClosedTab>,
}

impl ClosedLists {
    pub fn push_tabs(&mut self, entries: impl IntoIterator<Item = ClosedTab>) {
        self.tabs.extend(entries);
        let over = self.tabs.len().saturating_sub(MAX_CLOSED_TABS);
        self.tabs.drain(..over);
    }

    pub fn push_cleaned(&mut self, entries: impl IntoIterator<Item = ClosedTab>) {
        self.cleaned_tabs.extend(entries);
        let over = self.cleaned_tabs.len().saturating_sub(MAX_CLEANED);
        self.cleaned_tabs.drain(..over);
    }

    pub fn push_window(&mut self, entry: ClosedWindow) {
        self.windows.push(entry);
        let over = self.windows.len().saturating_sub(MAX_CLOSED_WINDOWS);
        self.windows.drain(..over);
    }

    pub fn push_group(&mut self, entry: ClosedGroup) {
        self.groups.push(entry);
        let over = self.groups.len().saturating_sub(MAX_CLOSED_GROUPS);
        self.groups.drain(..over);
    }

    pub fn purge_week_old(&mut self, now: Millis) {
        self.deleted_groups
            .retain(|c| now - c.closed_at < PURGED_AFTER_MS);
        self.cleaned_tabs
            .retain(|c| now - c.closed_at < PURGED_AFTER_MS);
    }

    pub fn newest(&self, accepts: impl Fn(&ClosedEntry<'_>) -> bool) -> Option<ClosedEntry<'_>> {
        let last_tab = self.tabs.iter().rev().map(ClosedEntry::Tab).find(&accepts);
        let last_window = self
            .windows
            .iter()
            .rev()
            .map(ClosedEntry::Window)
            .find(&accepts);
        let last_group = self
            .groups
            .iter()
            .rev()
            .map(ClosedEntry::Group)
            .find(&accepts);
        [last_window, last_group, last_tab]
            .into_iter()
            .flatten()
            .fold(None, |best: Option<ClosedEntry<'_>>, e| match &best {
                Some(b) if b.closed_at() >= e.closed_at() => best,
                _ => Some(e),
            })
    }

    pub fn remove(&mut self, id: &str) -> bool {
        let before = self.tabs.len()
            + self.windows.len()
            + self.groups.len()
            + self.deleted_groups.len()
            + self.cleaned_tabs.len();
        self.tabs.retain(|c| c.id != id);
        self.windows.retain(|c| c.id != id);
        self.groups.retain(|c| c.id != id);
        self.deleted_groups.retain(|c| c.id != id);
        self.cleaned_tabs.retain(|c| c.id != id);
        before
            != self.tabs.len()
                + self.windows.len()
                + self.groups.len()
                + self.deleted_groups.len()
                + self.cleaned_tabs.len()
    }

    pub fn forget_launch_hints(&mut self) {
        self.windows.retain(|c| !c.tabs.is_empty());
        for c in &mut self.windows {
            c.last_window = false;
            c.active_pin = None;
        }
    }

    pub fn drop_last_window_marks(&mut self) {
        self.windows
            .retain(|c| !c.last_window || !c.tabs.is_empty());
        for c in &mut self.windows {
            c.last_window = false;
            c.active_pin = None;
        }
    }

    pub fn is_empty(&self) -> bool {
        self.tabs.is_empty() && self.windows.is_empty() && self.groups.is_empty()
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ParkedTab {
    #[serde(flatten)]
    pub snapshot: TabSnapshot,
    pub id: String,
    #[serde(default, deserialize_with = "json::lenient")]
    pub group_id: Option<String>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "json::lenient"
    )]
    pub restore_from: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ParkedGroup {
    pub id: String,
    #[serde(default, deserialize_with = "json::lenient")]
    pub name: String,
    #[serde(default, deserialize_with = "json::lenient")]
    pub icon: Option<String>,
    #[serde(default, deserialize_with = "json::lenient_option")]
    pub color: Option<GroupColor>,
    #[serde(default, deserialize_with = "json::lenient")]
    pub collapsed: bool,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "json::lenient"
    )]
    pub parent_id: Option<String>,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct ParkedPins {
    pub tabs: Vec<ParkedTab>,
    pub groups: Vec<ParkedGroup>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "split_shapes"
    )]
    pub splits: Option<Vec<SplitShape>>,
}

impl ParkedPins {
    pub fn row_is_valid(row: &Value) -> bool {
        row.as_object().is_some_and(|f| {
            f.get("tabs")
                .and_then(Value::as_array)
                .is_some_and(|tabs| tabs.iter().all(TabSnapshot::row_is_valid))
                && f.get("groups")
                    .and_then(Value::as_array)
                    .is_some_and(|groups| {
                        groups
                            .iter()
                            .all(|g| g.as_object().is_some_and(|g| json::string(g.get("id"))))
                    })
        })
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct ClearedTabs {
    pub window_id: WindowId,
    pub profile_id: ProfileId,
    pub entries: Vec<ClosedTab>,
    pub closed_entry_ids: Vec<EntryId>,
    pub tab_order: Vec<TabId>,
    pub groups: Vec<TabGroup>,
    pub splits: Vec<SplitView>,
    pub selected: Option<TabId>,
    pub fingerprint: u64,
    pub cleared_at: Millis,
}

pub fn window_fingerprint(
    state: &crate::state::BrowserState,
    window: &WindowId,
    profile: &ProfileId,
) -> u64 {
    use std::hash::{DefaultHasher, Hash, Hasher};
    let Some(w) = state.window(window.as_str()) else {
        return 0;
    };
    let in_window = |id: &TabId| {
        state
            .tab(id.as_str())
            .is_some_and(|t| t.window_id == *window && t.profile_id == *profile)
    };
    let tabs: Vec<String> = w
        .tab_ids
        .iter()
        .filter(|id| {
            state
                .tab(id.as_str())
                .is_none_or(|t| t.profile_id == *profile)
        })
        .map(|id| match state.tab(id.as_str()) {
            Some(t) => format!("{id} {:?}", t.pin),
            None => id.to_string(),
        })
        .collect();
    let mut groups: Vec<String> = state
        .groups
        .values()
        .filter(|g| g.window_id == *window && g.profile_id == *profile)
        .map(|g| {
            format!(
                "{} {} {} {:?}",
                g.id,
                g.parent_id.as_ref().map_or("", |p| p.as_str()),
                g.pinned,
                g.tab_ids
            )
        })
        .collect();
    groups.sort();
    let mut splits: Vec<String> = state
        .splits
        .values()
        .filter(|v| v.tab_ids().iter().any(in_window))
        .map(|v| format!("{} {:?} {:?}", v.id, v.orientation, v.slots))
        .collect();
    splits.sort();
    let mut hasher = DefaultHasher::new();
    (tabs, groups, splits).hash(&mut hasher);
    hasher.finish()
}

pub fn fingerprint_fresh_clears(
    next: &mut crate::state::BrowserState,
    prev: &crate::state::BrowserState,
) {
    let fresh: Vec<(WindowId, ProfileId)> = next
        .cleared
        .iter()
        .filter(|(window, cleared)| prev.cleared.get(*window) != Some(*cleared))
        .map(|(window, cleared)| (window.clone(), cleared.profile_id.clone()))
        .collect();
    for (window, profile) in fresh {
        let print = window_fingerprint(next, &window, &profile);
        if let Some(cleared) = std::sync::Arc::make_mut(&mut next.cleared).get_mut(&window) {
            cleared.fingerprint = print;
        }
    }
}

pub fn can_undo_clear(state: &crate::state::BrowserState, window: &WindowId) -> bool {
    state.cleared.get(window).is_some_and(|cleared| {
        cleared
            .closed_entry_ids
            .iter()
            .all(|id| state.closed.tabs.iter().any(|c| c.id == *id))
            && window_fingerprint(state, window, &cleared.profile_id) == cleared.fingerprint
    })
}

pub const RECENTLY_CLOSED_SHOWN: usize = 10;

pub fn recently_closed_to_clear(
    state: &crate::state::BrowserState,
    window: Option<&WindowId>,
) -> std::collections::HashSet<EntryId> {
    use crate::windows::WindowKind;
    let mut gone = std::collections::HashSet::new();
    let regular = |kind: WindowKind| kind != WindowKind::LittleArdia && kind.has_tabs();
    let target = window.and_then(|id| state.windows.get(id)).or_else(|| {
        state
            .focus_order
            .iter()
            .chain(state.window_order.iter())
            .filter_map(|id| state.windows.get(id))
            .find(|w| regular(w.kind))
    });
    let Some(w) = target.filter(|w| w.kind != WindowKind::Incognito) else {
        return gone;
    };
    let default_profile = ProfileId::new(&state.settings.default_profile_id);
    let listed = |profile: Option<&ProfileId>| {
        profile
            .filter(|p| state.profiles.contains_key(*p))
            .unwrap_or(&default_profile)
            == &w.profile_id
    };
    let closed = &state.closed;
    let tabs: Vec<&ClosedTab> = closed
        .tabs
        .iter()
        .filter(|c| !c.tab.profile_id.is_incognito() && listed(Some(&c.tab.profile_id)))
        .collect();
    let windows: Vec<&ClosedWindow> = closed
        .windows
        .iter()
        .filter(|c| listed(c.window.profile_id.as_ref()))
        .collect();
    let any_regular_open = state
        .windows
        .values()
        .any(|o| matches!(o.kind, WindowKind::Main | WindowKind::Incognito));
    let reopens_next = closed
        .windows
        .last()
        .filter(|c| c.last_window && !any_regular_open)
        .map(|c| c.id.clone());
    let mut newest: Vec<(Millis, &EntryId)> = tabs
        .iter()
        .map(|c| (c.closed_at, &c.id))
        .chain(windows.iter().map(|c| (c.closed_at, &c.id)))
        .collect();
    newest.sort_by_key(|(at, _)| std::cmp::Reverse(*at));
    let shown: std::collections::HashSet<&EntryId> = newest
        .iter()
        .take(RECENTLY_CLOSED_SHOWN)
        .map(|(_, id)| *id)
        .collect();
    gone.extend(tabs.iter().map(|c| c.id.clone()));
    gone.extend(
        windows
            .iter()
            .filter(|c| reopens_next.as_ref() != Some(&c.id) || shown.contains(&c.id))
            .map(|c| c.id.clone()),
    );
    gone.extend(
        closed
            .groups
            .iter()
            .filter(|g| g.tabs.first().is_some_and(|t| t.profile_id == w.profile_id))
            .map(|g| g.id.clone()),
    );
    gone
}

pub fn group_info(group: &TabGroup) -> ClosedGroupInfo {
    group.info()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn snapshot() -> Value {
        json!({"customIcon": null, "customTitle": null, "engine": "chromium", "favicon": null, "lastActiveAt": 1795622986760u64, "muted": false, "pin": null, "pinnedUrl": null, "profileId": "default", "title": "t", "url": "https://a.example/", "zoom": 1})
    }

    #[test]
    fn real_closed_tab_rows_round_trip() {
        let row = json!({"closeBatch": "batch-1", "closedAt": 1795623407415u64, "group": null, "id": "ct-1", "index": 465, "kind": "tab", "tab": snapshot(), "tabId": "tab-1", "windowId": "w-1"});
        assert!(ClosedTab::row_is_valid(&row));
        let closed: ClosedTab = serde_json::from_value(row.clone()).unwrap();
        assert_eq!(serde_json::to_value(&closed).unwrap(), row);
        assert!(!ClosedTab::row_is_valid(
            &json!({"id": "x", "tab": {"url": 1}})
        ));
    }

    #[test]
    fn real_closed_window_rows_round_trip() {
        let mut tab = snapshot();
        tab["active"] = json!(true);
        tab["tabId"] = json!("tab-9");
        let row = json!({"closedAt": 1795618197906u64, "groups": [], "id": "cw-1", "kind": "window", "tabs": [tab], "window": {"frame": [0, 90, 1512, 859], "profileId": "default", "tabLayout": "sidebar"}});
        assert!(ClosedWindow::row_is_valid(&row));
        let closed: ClosedWindow = serde_json::from_value(row.clone()).unwrap();
        assert!(closed.tabs[0].active);
        assert_eq!(serde_json::to_value(&closed).unwrap(), row);
    }

    #[test]
    fn lists_stay_bounded_and_pick_the_newest_entry() {
        let mut lists = ClosedLists::default();
        let closed = |id: &str, at: Millis| -> ClosedTab {
            let mut c: ClosedTab = serde_json::from_value(json!({"id": id, "tab": snapshot(), "windowId": "w", "index": 0, "group": null, "closedAt": at})).unwrap();
            c.closed_at = at;
            c
        };
        lists.push_tabs((0..60).map(|i| closed(&format!("c{i}"), i)));
        assert_eq!(lists.tabs.len(), MAX_CLOSED_TABS);
        assert_eq!(lists.tabs[0].id.as_str(), "c10");
        assert_eq!(lists.newest(|_| true).unwrap().id().as_str(), "c59");
        assert!(lists.remove("c59"));
        assert!(!lists.remove("c59"));
        lists.cleaned_tabs.push(closed("old", 0));
        lists.purge_week_old(PURGED_AFTER_MS + 1);
        assert!(lists.cleaned_tabs.is_empty());
    }

    #[test]
    fn parked_pins_validate_like_the_shell() {
        let mut parked = snapshot();
        parked["id"] = json!("tab-1");
        parked["groupId"] = json!(null);
        let row = json!({"tabs": [parked], "groups": [{"id": "g", "name": "x", "icon": null, "color": null, "collapsed": false}]});
        assert!(ParkedPins::row_is_valid(&row));
        let pins: ParkedPins = serde_json::from_value(row).unwrap();
        assert_eq!(pins.tabs[0].id, "tab-1");
        assert!(!ParkedPins::row_is_valid(&json!({"tabs": []})));
    }
}
