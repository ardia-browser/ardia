use crate::ids::{GroupId, ProfileId, TabId, WindowId};
use crate::json::{self, Fields};
use crate::macros::string_enum;
use crate::model::Millis;
use indexmap::IndexMap;
use serde::{Deserialize, Deserializer, Serialize};
use serde_json::Value;
use std::collections::{HashMap, HashSet};
use std::sync::Arc;

string_enum!(GroupColor {
    Grey = "grey",
    Blue = "blue",
    Red = "red",
    Yellow = "yellow",
    Green = "green",
    Pink = "pink",
    Purple = "purple",
    Cyan = "cyan",
    Orange = "orange",
    NoColor = "none",
} default NoColor);

fn group_color<'de, D: Deserializer<'de>>(deserializer: D) -> Result<Option<GroupColor>, D::Error> {
    let value = Value::deserialize(deserializer)?;
    Ok(value.as_str().and_then(GroupColor::from_key))
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TabGroup {
    pub id: GroupId,
    pub window_id: WindowId,
    pub profile_id: ProfileId,
    #[serde(default, deserialize_with = "json::lenient")]
    pub name: String,
    #[serde(default, deserialize_with = "json::lenient")]
    pub icon: Option<String>,
    #[serde(default, deserialize_with = "group_color")]
    pub color: Option<GroupColor>,
    #[serde(default, deserialize_with = "json::lenient")]
    pub collapsed: bool,
    #[serde(default, deserialize_with = "json::lenient")]
    pub pinned: bool,
    pub tab_ids: Vec<TabId>,
    #[serde(default, deserialize_with = "json::millis")]
    pub created_at: Millis,
    #[serde(
        default,
        skip_serializing_if = "json::is_false",
        serialize_with = "json::serialize_true",
        deserialize_with = "json::true_flag"
    )]
    pub auto_ungroup: bool,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "json::lenient"
    )]
    pub pinned_opener_id: Option<TabId>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "json::lenient"
    )]
    pub pin_key: Option<String>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "json::lenient"
    )]
    pub parent_id: Option<GroupId>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "json::lenient"
    )]
    pub shown_tab_ids: Option<Vec<TabId>>,
    #[serde(flatten)]
    pub extra: Fields,
}

impl TabGroup {
    pub fn new(
        id: GroupId,
        window_id: WindowId,
        profile_id: ProfileId,
        tab_ids: Vec<TabId>,
        now: Millis,
    ) -> Self {
        TabGroup {
            id,
            window_id,
            profile_id,
            name: String::new(),
            icon: None,
            color: None,
            collapsed: false,
            pinned: false,
            tab_ids,
            created_at: now,
            auto_ungroup: false,
            pinned_opener_id: None,
            pin_key: None,
            parent_id: None,
            shown_tab_ids: None,
            extra: Fields::new(),
        }
    }

    pub fn pin_key(&self) -> &str {
        self.pin_key.as_deref().unwrap_or(self.id.as_str())
    }

    pub fn row_is_valid(row: &Value) -> bool {
        let Some(fields) = row.as_object() else {
            return false;
        };
        json::own_id(fields.get("id"))
            && json::own_id(fields.get("windowId"))
            && json::own_id(fields.get("profileId"))
            && json::string_list(fields.get("tabIds"))
    }

    pub fn info(&self) -> ClosedGroupInfo {
        ClosedGroupInfo {
            id: self.id.clone(),
            name: self.name.clone(),
            icon: self.icon.clone(),
            color: self.color,
            pinned: self.pinned,
            extra: Fields::new(),
        }
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClosedGroupInfo {
    pub id: GroupId,
    #[serde(default, deserialize_with = "json::lenient")]
    pub name: String,
    #[serde(default, deserialize_with = "json::lenient")]
    pub icon: Option<String>,
    #[serde(default, deserialize_with = "group_color")]
    pub color: Option<GroupColor>,
    #[serde(
        default,
        skip_serializing_if = "json::is_false",
        serialize_with = "json::serialize_true",
        deserialize_with = "json::true_flag"
    )]
    pub pinned: bool,
    #[serde(flatten)]
    pub extra: Fields,
}

pub type Groups = IndexMap<GroupId, Arc<TabGroup>>;

pub fn ancestors(groups: &Groups, id: &str) -> Vec<GroupId> {
    let mut seen: Vec<GroupId> = Vec::new();
    let mut at = groups.get(id);
    while let Some(group) = at {
        let Some(parent) = group
            .parent_id
            .as_ref()
            .filter(|p| groups.contains_key(p.as_str()))
        else {
            break;
        };
        if seen.contains(parent) || parent.as_str() == id {
            break;
        }
        seen.push(parent.clone());
        at = groups.get(parent.as_str());
    }
    seen
}

pub fn depth(groups: &Groups, id: &str) -> usize {
    ancestors(groups, id).len()
}

pub fn root(groups: &Groups, id: &str) -> Option<GroupId> {
    ancestors(groups, id)
        .pop()
        .or_else(|| groups.contains_key(id).then(|| GroupId::new(id)))
}

pub fn descendants(groups: &Groups, id: &str) -> Vec<GroupId> {
    let mut children: HashMap<&str, Vec<&GroupId>> = HashMap::new();
    for group in groups.values() {
        if let Some(parent) = &group.parent_id {
            children.entry(parent.as_str()).or_default().push(&group.id);
        }
    }
    let mut seen: HashSet<&str> = HashSet::from([id]);
    let mut out = Vec::new();
    let mut stack: Vec<&str> = vec![id];
    while let Some(at) = stack.pop() {
        for child in children.get(at).into_iter().flatten() {
            if seen.insert(child.as_str()) {
                out.push((*child).clone());
                stack.push(child.as_str());
            }
        }
    }
    out
}

pub fn innermost_group_of(groups: &Groups, tab: &str) -> Option<GroupId> {
    groups
        .values()
        .filter(|g| g.tab_ids.iter().any(|t| t == tab))
        .max_by_key(|g| depth(groups, g.id.as_str()))
        .map(|g| g.id.clone())
}

pub fn pinned_group_members(groups: &Groups) -> HashSet<TabId> {
    groups
        .values()
        .filter(|g| g.pinned)
        .flat_map(|g| g.tab_ids.iter().cloned())
        .collect()
}

pub fn reparent(next: &mut Groups, was: &Groups) {
    let orphans: Vec<(GroupId, Option<GroupId>)> = next
        .values()
        .filter_map(|g| {
            let parent = g.parent_id.as_ref()?;
            if next.contains_key(parent.as_str()) {
                return None;
            }
            let mut up = was.get(parent.as_str()).and_then(|p| p.parent_id.clone());
            let mut guard = 0;
            while let Some(candidate) = &up {
                if next.contains_key(candidate.as_str()) || guard > was.len() {
                    break;
                }
                up = was
                    .get(candidate.as_str())
                    .and_then(|p| p.parent_id.clone());
                guard += 1;
            }
            Some((g.id.clone(), up.filter(|u| next.contains_key(u.as_str()))))
        })
        .collect();
    for (id, parent) in orphans {
        if let Some(group) = next.get_mut(id.as_str()) {
            Arc::make_mut(group).parent_id = parent;
        }
    }
}

pub fn leave_groups(groups: &Groups, gone: &HashSet<TabId>) -> Groups {
    if !groups
        .values()
        .any(|g| g.tab_ids.iter().any(|t| gone.contains(t)))
    {
        return groups.clone();
    }
    let mut next = Groups::new();
    for (id, group) in groups {
        let tab_ids: Vec<TabId> = group
            .tab_ids
            .iter()
            .filter(|t| !gone.contains(*t))
            .cloned()
            .collect();
        let floor = if group.auto_ungroup && group.pinned_opener_id.is_none() {
            1
        } else {
            0
        };
        if tab_ids.len() == group.tab_ids.len() {
            next.insert(id.clone(), Arc::clone(group));
        } else if tab_ids.len() > floor {
            let mut kept = (**group).clone();
            kept.tab_ids = tab_ids;
            next.insert(id.clone(), Arc::new(kept));
        }
    }
    reparent(&mut next, groups);
    next
}

fn closes_loop(groups: &Groups, id: &str, parent: &str) -> bool {
    parent == id || ancestors(groups, parent).iter().any(|a| a.as_str() == id)
}

pub fn nest_groups(groups: &Groups) -> Groups {
    let mut next = groups.clone();
    let broken: Vec<GroupId> = groups
        .values()
        .filter(|g| {
            g.parent_id
                .as_ref()
                .is_some_and(|p| match groups.get(p.as_str()) {
                    Some(parent) => {
                        parent.window_id != g.window_id
                            || parent.profile_id != g.profile_id
                            || closes_loop(groups, g.id.as_str(), p.as_str())
                    }
                    None => true,
                })
        })
        .map(|g| g.id.clone())
        .collect();
    for id in &broken {
        if let Some(g) = next.get_mut(id) {
            Arc::make_mut(g).parent_id = None;
        }
    }
    let mut nested: Vec<(GroupId, usize)> = next
        .values()
        .filter(|g| g.parent_id.is_some())
        .map(|g| (g.id.clone(), depth(&next, g.id.as_str())))
        .collect();
    nested.sort_by_key(|(_, d)| std::cmp::Reverse(*d));
    for (id, _) in &nested {
        let child = Arc::clone(&next[id]);
        let Some(parent) = child.parent_id.as_ref().and_then(|p| next.get_mut(p)) else {
            continue;
        };
        let missing: Vec<TabId> = child
            .tab_ids
            .iter()
            .filter(|t| !parent.tab_ids.contains(t))
            .cloned()
            .collect();
        if !missing.is_empty() {
            Arc::make_mut(parent).tab_ids.extend(missing);
        }
    }
    for (id, _) in nested.iter().rev() {
        let pinned = next[id]
            .parent_id
            .as_ref()
            .and_then(|p| next.get(p))
            .is_some_and(|p| p.pinned);
        if next[id].pinned != pinned {
            Arc::make_mut(next.get_mut(id).expect("nested group")).pinned = pinned;
        }
    }
    let mut holders: IndexMap<TabId, Vec<GroupId>> = IndexMap::new();
    for g in next.values() {
        for t in &g.tab_ids {
            holders.entry(t.clone()).or_default().push(g.id.clone());
        }
    }
    let mut leaving: HashMap<GroupId, HashSet<TabId>> = HashMap::new();
    for (tab, ids) in holders.iter().filter(|(_, ids)| ids.len() > 1) {
        let deepest = ids
            .iter()
            .max_by_key(|g| depth(&next, g.as_str()))
            .cloned()
            .expect("a holder");
        let chain = ancestors(&next, deepest.as_str());
        for id in ids.iter().filter(|g| **g != deepest && !chain.contains(g)) {
            leaving.entry(id.clone()).or_default().insert(tab.clone());
        }
    }
    for (id, gone) in leaving {
        if let Some(g) = next.get_mut(&id) {
            Arc::make_mut(g).tab_ids.retain(|t| !gone.contains(t));
        }
    }
    let emptied: Vec<GroupId> = next
        .values()
        .filter(|g| g.tab_ids.is_empty())
        .map(|g| g.id.clone())
        .collect();
    if emptied.is_empty() {
        return next;
    }
    let settled = next.clone();
    for id in &emptied {
        next.shift_remove(id);
    }
    reparent(&mut next, &settled);
    next
}

pub fn sync_group_order(groups: &mut Groups, window: &WindowId, tab_order: &[TabId]) {
    let at: HashMap<&TabId, usize> = tab_order
        .iter()
        .enumerate()
        .map(|(i, id)| (id, i))
        .collect();
    for group in groups.values_mut() {
        if &group.window_id != window {
            continue;
        }
        let ordered =
            group
                .tab_ids
                .windows(2)
                .all(|pair| match (at.get(&pair[0]), at.get(&pair[1])) {
                    (Some(a), Some(b)) => a < b,
                    _ => false,
                })
                && group.tab_ids.iter().all(|t| at.contains_key(t));
        if ordered {
            continue;
        }
        let members: HashSet<&TabId> = group.tab_ids.iter().collect();
        let tab_ids = tab_order
            .iter()
            .filter(|t| members.contains(t))
            .cloned()
            .collect();
        Arc::make_mut(group).tab_ids = tab_ids;
    }
}

pub fn place_block(tab_ids: &[TabId], block: &[TabId]) -> Vec<TabId> {
    let members: HashSet<&TabId> = block.iter().collect();
    let Some(first) = tab_ids.iter().position(|t| members.contains(t)) else {
        return tab_ids.to_vec();
    };
    let mut rest: Vec<TabId> = tab_ids
        .iter()
        .filter(|t| !members.contains(t))
        .cloned()
        .collect();
    let before = tab_ids[..first]
        .iter()
        .filter(|t| !members.contains(t))
        .count();
    rest.splice(before..before, block.iter().cloned());
    rest
}

pub fn place_groups(mut tab_ids: Vec<TabId>, groups: &Groups, window: &WindowId) -> Vec<TabId> {
    let mut own: Vec<&Arc<TabGroup>> = groups.values().filter(|g| &g.window_id == window).collect();
    own.sort_by_key(|g| depth(groups, g.id.as_str()));
    for group in own {
        let at: HashMap<&TabId, usize> =
            tab_ids.iter().enumerate().map(|(i, id)| (id, i)).collect();
        let spots: Vec<usize> = group
            .tab_ids
            .iter()
            .filter_map(|t| at.get(t).copied())
            .collect();
        let (Some(low), Some(high)) = (spots.iter().min(), spots.iter().max()) else {
            continue;
        };
        if high - low + 1 == spots.len() {
            continue;
        }
        let members: HashSet<&TabId> = group.tab_ids.iter().collect();
        let block: Vec<TabId> = tab_ids
            .iter()
            .filter(|t| members.contains(t))
            .cloned()
            .collect();
        tab_ids = place_block(&tab_ids, &block);
    }
    tab_ids
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn group(id: &str, parent: Option<&str>, tabs: &[&str]) -> (GroupId, Arc<TabGroup>) {
        let mut g = TabGroup::new(
            GroupId::new(id),
            WindowId::new("w"),
            ProfileId::default_profile(),
            tabs.iter().map(|t| TabId::new(*t)).collect(),
            0,
        );
        g.parent_id = parent.map(GroupId::new);
        (GroupId::new(id), Arc::new(g))
    }

    fn ids(list: &[&str]) -> Vec<TabId> {
        list.iter().map(|t| TabId::new(*t)).collect()
    }

    #[test]
    fn real_group_rows_round_trip() {
        let row = json!({"collapsed": true, "color": null, "createdAt": 1795624452667u64, "icon": null, "id": "g-1", "name": "Kyrra", "parentId": "g-0", "pinned": true, "profileId": "default", "tabIds": ["tab-a", "tab-b"], "windowId": "w-1"});
        assert!(TabGroup::row_is_valid(&row));
        let g: TabGroup = serde_json::from_value(row.clone()).unwrap();
        assert_eq!(serde_json::to_value(&g).unwrap(), row);
        let bad: TabGroup = serde_json::from_value(
            json!({"id": "g", "windowId": "w", "profileId": "p", "tabIds": [], "color": "magenta"}),
        )
        .unwrap();
        assert_eq!(bad.color, None);
    }

    #[test]
    fn nesting_walks_survive_cycles() {
        let groups: Groups = [
            group("a", None, &["1"]),
            group("b", Some("a"), &["1"]),
            group("c", Some("b"), &["1"]),
            group("x", Some("y"), &[]),
            group("y", Some("x"), &[]),
        ]
        .into_iter()
        .collect();
        assert_eq!(depth(&groups, "c"), 2);
        assert_eq!(root(&groups, "c").unwrap().as_str(), "a");
        assert_eq!(descendants(&groups, "a").len(), 2);
        assert!(depth(&groups, "x") <= 2);
        assert_eq!(innermost_group_of(&groups, "1").unwrap().as_str(), "c");
    }

    #[test]
    fn leaving_groups_drops_empty_ones_and_reparents_children() {
        let groups: Groups = [
            group("a", None, &["1"]),
            group("b", Some("a"), &["2"]),
            group("c", Some("b"), &["3"]),
        ]
        .into_iter()
        .collect();
        let left = leave_groups(&groups, &HashSet::from([TabId::new("2")]));
        assert!(!left.contains_key("b"));
        assert_eq!(left["c"].parent_id.as_ref().unwrap().as_str(), "a");
    }

    #[test]
    fn group_blocks_stay_contiguous() {
        let groups: Groups = [group("a", None, &["2", "4"])].into_iter().collect();
        let placed = place_groups(
            ids(&["1", "2", "3", "4", "5"]),
            &groups,
            &WindowId::new("w"),
        );
        assert_eq!(placed, ids(&["1", "2", "4", "3", "5"]));
        let mut synced = groups;
        sync_group_order(&mut synced, &WindowId::new("w"), &ids(&["4", "1", "2"]));
        assert_eq!(synced["a"].tab_ids, ids(&["4", "2"]));
    }
}
