use std::collections::HashMap;

use ardia_state::closed::ParkedPins;
use ardia_state::groups::{self, Groups};
use ardia_state::state::TabMap;
use ardia_state::sync_engine::IndexMap;
use ardia_state::windows::BrowserWindow;
use ardia_state::{ProfileId, TabId};

use super::is_row;

#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub enum BlockKey {
    Row(String),
    Group(String),
}

#[derive(Clone, Debug)]
pub struct Block<T> {
    pub key: BlockKey,
    pub ids: Vec<T>,
}

pub fn pinned_blocks(
    tabs: &TabMap,
    all_groups: &Groups,
    w: &BrowserWindow,
    profile: &ProfileId,
) -> Vec<Block<TabId>> {
    let mut blocks: Vec<Block<TabId>> = Vec::new();
    let mut by_root: HashMap<String, usize> = HashMap::new();
    let mut pinned_root: HashMap<TabId, (String, String)> = HashMap::new();
    for g in all_groups.values() {
        if !g.pinned || g.window_id != w.id || g.profile_id != *profile {
            continue;
        }
        let root_id = groups::root(all_groups, g.id.as_str()).unwrap_or_else(|| g.id.clone());
        let root = all_groups.get(&root_id).unwrap_or(g);
        for id in &g.tab_ids {
            pinned_root.insert(id.clone(), (root.id.to_string(), root.pin_key().to_owned()));
        }
    }
    for id in &w.tab_ids {
        let Some(t) = tabs.get(id) else { continue };
        if t.profile_id != *profile {
            continue;
        }
        if t.pin.is_some() {
            if is_row(t.pin.as_ref()) {
                blocks.push(Block {
                    key: BlockKey::Row(t.pin_key().to_owned()),
                    ids: vec![id.clone()],
                });
            }
            continue;
        }
        let Some((root_id, root_key)) = pinned_root.get(id) else {
            continue;
        };
        match by_root.get(root_id) {
            Some(&at) => blocks[at].ids.push(id.clone()),
            None => {
                by_root.insert(root_id.clone(), blocks.len());
                blocks.push(Block {
                    key: BlockKey::Group(root_key.clone()),
                    ids: vec![id.clone()],
                });
            }
        }
    }
    blocks
}

pub fn parked_blocks(park: &ParkedPins) -> Vec<Block<String>> {
    let parent_of: HashMap<&str, Option<&str>> = park
        .groups
        .iter()
        .map(|g| (g.id.as_str(), g.parent_id.as_deref()))
        .collect();
    let root_of = |id: &str| -> String {
        let mut seen = vec![id.to_owned()];
        let mut root = id.to_owned();
        while let Some(Some(up)) = parent_of.get(root.as_str()) {
            if !parent_of.contains_key(up) || seen.iter().any(|s| s == up) {
                break;
            }
            seen.push((*up).to_owned());
            root = (*up).to_owned();
        }
        root
    };
    let mut blocks: Vec<Block<String>> = Vec::new();
    let mut by_key: HashMap<BlockKey, usize> = HashMap::new();
    for t in &park.tabs {
        let key = match &t.group_id {
            Some(g) => BlockKey::Group(root_of(g)),
            None if is_row(t.snapshot.pin.as_ref()) => BlockKey::Row(t.id.clone()),
            None => continue,
        };
        match by_key.get(&key) {
            Some(&at) => blocks[at].ids.push(t.id.clone()),
            None => {
                by_key.insert(key.clone(), blocks.len());
                blocks.push(Block {
                    key,
                    ids: vec![t.id.clone()],
                });
            }
        }
    }
    blocks
}

pub fn area_keys<T>(blocks: &[Block<T>]) -> Vec<BlockKey> {
    blocks.iter().map(|b| b.key.clone()).collect()
}

pub fn anchors_of(keys: &[BlockKey]) -> IndexMap<String, Option<String>> {
    let mut anchors = IndexMap::new();
    let mut row: Option<String> = None;
    for key in keys {
        match key {
            BlockKey::Row(id) => row = Some(id.clone()),
            BlockKey::Group(id) => {
                anchors.insert(id.clone(), row.clone());
            }
        }
    }
    anchors
}

pub type AnchorOf<'a> = dyn Fn(&str) -> Option<Option<String>> + 'a;

fn order_blocks<T: Clone>(blocks: &[Block<T>], anchor_of: &AnchorOf) -> Option<Vec<T>> {
    let rows: Vec<&Block<T>> = blocks
        .iter()
        .filter(|b| matches!(b.key, BlockKey::Row(_)))
        .collect();
    let group_blocks: Vec<&Block<T>> = blocks
        .iter()
        .filter(|b| matches!(b.key, BlockKey::Group(_)))
        .collect();
    let row_keys: Vec<&str> = rows
        .iter()
        .filter_map(|r| match &r.key {
            BlockKey::Row(id) => Some(id.as_str()),
            BlockKey::Group(_) => None,
        })
        .collect();
    let id_of = |b: &Block<T>| match &b.key {
        BlockKey::Row(id) | BlockKey::Group(id) => id.clone(),
    };
    let mut placed: IndexMap<Option<String>, Vec<&Block<T>>> = IndexMap::new();
    let mut last: Vec<&Block<T>> = Vec::new();
    let mut any = false;
    for g in &group_blocks {
        let anchor = anchor_of(&id_of(g));
        if anchor.is_some() {
            any = true;
        }
        match anchor {
            Some(None) => placed.entry(None).or_default().push(g),
            Some(Some(row)) if row_keys.contains(&row.as_str()) => {
                placed.entry(Some(row)).or_default().push(g)
            }
            _ => last.push(g),
        }
    }
    if !any {
        return None;
    }
    let mut out: Vec<T> = Vec::new();
    for b in placed.get(&None).into_iter().flatten() {
        out.extend(b.ids.iter().cloned());
    }
    for r in &rows {
        out.extend(r.ids.iter().cloned());
        for b in placed.get(&Some(id_of(r))).into_iter().flatten() {
            out.extend(b.ids.iter().cloned());
        }
    }
    for b in last {
        out.extend(b.ids.iter().cloned());
    }
    Some(out)
}

fn rearranged<T: Clone + PartialEq>(ids: &[T], order: &[T]) -> Option<Vec<T>> {
    let at = ids.iter().position(|id| order.contains(id))?;
    let rest: Vec<T> = ids
        .iter()
        .filter(|id| !order.contains(id))
        .cloned()
        .collect();
    let before = ids[..at].iter().filter(|id| !order.contains(id)).count();
    let mut next = rest[..before].to_vec();
    next.extend(order.iter().cloned());
    next.extend(rest[before..].iter().cloned());
    (next != ids).then_some(next)
}

pub fn arrange_pinned_area(
    tabs: &TabMap,
    all_groups: &Groups,
    w: &BrowserWindow,
    profile: &ProfileId,
    anchor_of: &AnchorOf,
) -> Vec<TabId> {
    order_blocks(&pinned_blocks(tabs, all_groups, w, profile), anchor_of)
        .and_then(|order| rearranged(&w.tab_ids, &order))
        .unwrap_or_else(|| w.tab_ids.clone())
}

pub fn arrange_parked(park: &ParkedPins, anchor_of: &AnchorOf) -> ParkedPins {
    let Some(order) = order_blocks(&parked_blocks(park), anchor_of) else {
        return park.clone();
    };
    let ids: Vec<String> = park.tabs.iter().map(|t| t.id.clone()).collect();
    let Some(next) = rearranged(&ids, &order) else {
        return park.clone();
    };
    let mut out = park.clone();
    out.tabs = next
        .iter()
        .filter_map(|id| park.tabs.iter().find(|t| &t.id == id).cloned())
        .collect();
    out
}
