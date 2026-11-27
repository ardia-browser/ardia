use std::collections::HashSet;
use std::sync::Arc;

use ardia_state::bookmarks::{BookmarkNode, BookmarkTree};
use ardia_state::sync_engine::canon::utf16_order;
use ardia_state::sync_engine::scope::{Adapter, ApplyRecords, ExtractContext, Extraction};
use ardia_state::sync_engine::{IndexMap, IndexSet, assign_positions, folder_children};
use ardia_state::{BookmarkId, BrowserState, ProfileId};
use serde_json::{Map, Value};

use super::{BOOKMARK, CycleContext, InTodaysNames, data_engine, record_id};

pub const LEGACY_BOOKMARK_SEED: &str = "netnyahoo-bookmark:";
pub const BAR_KEY: &str = "bar";
pub const OTHER_KEY: &str = "other";

pub fn is_bookmark_uuid(id: &str) -> bool {
    let groups = [8, 4, 4, 4, 12];
    let parts: Vec<&str> = id.split('-').collect();
    parts.len() == 5
        && parts.iter().zip(groups).all(|(p, n)| {
            p.len() == n
                && p.bytes()
                    .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        })
}

fn uuid_from(words: [u32; 4]) -> String {
    let hex: String = words.iter().map(|w| format!("{w:08x}")).collect();
    let nibble = u8::from_str_radix(&hex[16..17], 16).unwrap_or(0);
    let v = format!("{:x}", (nibble & 0x3) | 0x8);
    format!(
        "{}-{}-4{}-{}{}-{}",
        &hex[0..8],
        &hex[8..12],
        &hex[13..16],
        v,
        &hex[17..20],
        &hex[20..32]
    )
}

pub fn bookmark_uuid_for(id: &str) -> String {
    if is_bookmark_uuid(id) {
        return id.to_owned();
    }
    let text = format!("{LEGACY_BOOKMARK_SEED}{id}");
    let (mut h1, mut h2, mut h3, mut h4): (u32, u32, u32, u32) =
        (1779033703, 3144134277, 1013904242, 2773480762);
    for k in text.encode_utf16() {
        let k = u32::from(k);
        h1 = h2 ^ (h1 ^ k).wrapping_mul(597399067);
        h2 = h3 ^ (h2 ^ k).wrapping_mul(2869860233);
        h3 = h4 ^ (h3 ^ k).wrapping_mul(951274213);
        h4 = h1 ^ (h4 ^ k).wrapping_mul(2716044179);
    }
    h1 = (h3 ^ (h1 >> 18)).wrapping_mul(597399067);
    h2 = (h4 ^ (h2 >> 22)).wrapping_mul(2869860233);
    h3 = (h1 ^ (h3 >> 17)).wrapping_mul(951274213);
    h4 = (h2 ^ (h4 >> 19)).wrapping_mul(2716044179);
    h1 ^= h2 ^ h3 ^ h4;
    h2 ^= h1;
    h3 ^= h1;
    h4 ^= h1;
    uuid_from([h1, h2, h3, h4])
}

#[derive(Clone, Debug, PartialEq)]
pub struct BookmarkValue {
    pub k: String,
    pub p: String,
    pub t: String,
    pub u: Option<String>,
    pub a: Value,
    pub pos: String,
}

pub fn bookmark_value(value: Option<&Value>) -> Option<BookmarkValue> {
    let v = value?.as_object()?;
    let k = v
        .get("k")?
        .as_str()
        .filter(|k| *k == "u" || *k == "f")?
        .to_owned();
    let u = match v.get("u") {
        None => None,
        Some(Value::String(u)) => Some(u.clone()),
        Some(_) => return None,
    };
    let a = v.get("a").filter(|a| a.is_number())?.clone();
    Some(BookmarkValue {
        k,
        p: v.get("p")?.as_str()?.to_owned(),
        t: v.get("t")?.as_str()?.to_owned(),
        u,
        a,
        pos: v.get("pos")?.as_str()?.to_owned(),
    })
}

fn node_value(node: &BookmarkNode, parent: &str, pos: &str) -> Value {
    let mut out = Map::new();
    match node {
        BookmarkNode::Url {
            title,
            url,
            added_at,
            ..
        } => {
            out.insert("k".into(), "u".into());
            out.insert("p".into(), parent.into());
            out.insert("t".into(), title.clone().into());
            out.insert("u".into(), url.clone().into());
            out.insert("a".into(), (*added_at).into());
        }
        BookmarkNode::Folder {
            title, added_at, ..
        } => {
            out.insert("k".into(), "f".into());
            out.insert("p".into(), parent.into());
            out.insert("t".into(), title.clone().into());
            out.insert("a".into(), (*added_at).into());
        }
    }
    out.insert("pos".into(), pos.into());
    Value::Object(out)
}

fn sync_key(node: &BookmarkNode) -> Option<&String> {
    match node {
        BookmarkNode::Url { sync_key, .. } | BookmarkNode::Folder { sync_key, .. } => {
            sync_key.as_ref()
        }
    }
}

pub fn extract_values(
    tree: &BookmarkTree,
    base: &dyn Fn(&str) -> Option<Value>,
) -> IndexMap<String, Value> {
    let (bar, other) = (tree.bar(), tree.other());
    let key_of = |id: &BookmarkId| -> String {
        if *id == bar {
            return BAR_KEY.to_owned();
        }
        if *id == other {
            return OTHER_KEY.to_owned();
        }
        match tree.get(id.as_str()).and_then(sync_key) {
            Some(key) if bookmark_uuid_for(key) == id.as_str() => key.clone(),
            _ => id.as_str().to_owned(),
        }
    };
    let mut values = IndexMap::new();
    let mut seen: HashSet<BookmarkId> = HashSet::new();
    let open = |folder: &BookmarkId,
                seen: &mut HashSet<BookmarkId>|
     -> Option<(String, Vec<BookmarkId>, Vec<String>, usize)> {
        if !matches!(tree.get(folder.as_str()), Some(BookmarkNode::Folder { .. }))
            || !seen.insert(folder.clone())
        {
            return None;
        }
        let parent = key_of(folder);
        let children: Vec<BookmarkId> = tree
            .children(folder.as_str())
            .iter()
            .filter(|id| tree.get(id.as_str()).is_some())
            .cloned()
            .collect();
        let known: Vec<Option<String>> = children
            .iter()
            .map(|id| {
                bookmark_value(base(&format!("{BOOKMARK}{}", key_of(id))).as_ref())
                    .filter(|v| v.p == parent)
                    .map(|v| v.pos)
            })
            .collect();
        let refs: Vec<Option<&str>> = known.iter().map(Option::as_deref).collect();
        let positions = assign_positions(&refs);
        Some((parent, children, positions, 0))
    };
    for root in [&bar, &other] {
        let mut stack: Vec<(String, Vec<BookmarkId>, Vec<String>, usize)> =
            open(root, &mut seen).into_iter().collect();
        while let Some(top) = stack.last_mut() {
            if top.3 == top.1.len() {
                stack.pop();
                continue;
            }
            let i = top.3;
            top.3 += 1;
            let id = top.1[i].clone();
            let parent = top.0.clone();
            let pos = top.2[i].clone();
            let Some(node) = tree.get(id.as_str()) else {
                continue;
            };
            values.insert(
                format!("{BOOKMARK}{}", key_of(&id)),
                node_value(node, &parent, &pos),
            );
            if matches!(node, BookmarkNode::Folder { .. })
                && let Some(inner) = open(&id, &mut seen)
            {
                stack.push(inner);
            }
        }
    }
    values
}

pub fn applied_tree(
    tree: &BookmarkTree,
    visible: &IndexMap<String, Value>,
    now: i64,
) -> Option<BookmarkTree> {
    let (bar, other) = (tree.bar(), tree.other());
    let mut values: IndexMap<String, BookmarkValue> = IndexMap::new();
    let mut keys: IndexMap<String, String> = IndexMap::new();
    for (k, v) in visible {
        let value = bookmark_value(Some(v))?;
        let key = record_id(BOOKMARK, k).to_owned();
        let id = bookmark_uuid_for(&key);
        values.insert(id.clone(), value);
        keys.insert(id, key);
    }
    let root_of = |key: &str| match key {
        BAR_KEY => Some(bar.as_str().to_owned()),
        OTHER_KEY => Some(other.as_str().to_owned()),
        _ => None,
    };
    let mut parent_of: IndexMap<String, String> = IndexMap::new();
    for (id, v) in &values {
        let parent = match root_of(&v.p) {
            Some(root) => root,
            None => {
                let parent = bookmark_uuid_for(&v.p);
                if values.get(&parent).is_some_and(|p| p.k == "f") {
                    parent
                } else {
                    other.as_str().to_owned()
                }
            }
        };
        parent_of.insert(id.clone(), parent);
    }
    let mut sorted: Vec<String> = values.keys().cloned().collect();
    sorted.sort_by(|a, b| utf16_order(a, b));
    let mut children = folder_children(&mut parent_of, &sorted, other.as_str());
    for root in [&bar, &other] {
        children.entry(root.as_str().to_owned()).or_default();
    }
    let by_position = |a: &String, z: &String| {
        let (pa, pz) = (&values[a].pos, &values[z].pos);
        pa.cmp(pz).then_with(|| utf16_order(&keys[a], &keys[z]))
    };
    let mut dropped: HashSet<String> = HashSet::new();
    let mut stack: Vec<BookmarkId> = vec![bar.clone(), other.clone()];
    while let Some(id) = stack.pop() {
        if let Some(BookmarkNode::Folder { children, .. }) = tree.get(id.as_str()) {
            stack.extend(children.iter().cloned());
        }
        if id != bar && id != other {
            dropped.insert(id.as_str().to_owned());
        }
    }
    let mut nodes: Vec<BookmarkNode> = tree
        .nodes()
        .filter(|n| !dropped.contains(n.id().as_str()) && !values.contains_key(n.id().as_str()))
        .cloned()
        .collect();
    let added = |a: &Value| ardia_state::json::as_millis(a).unwrap_or(0);
    for (id, v) in &values {
        let key = &keys[id];
        let sync_key = (!is_bookmark_uuid(key)).then(|| key.clone());
        let parent = BookmarkId::new(parent_of[id].as_str());
        let node = if v.k == "u" {
            let favicon = match tree.get(id) {
                Some(BookmarkNode::Url { favicon, .. }) => favicon.clone(),
                _ => None,
            };
            BookmarkNode::Url {
                id: BookmarkId::new(id.as_str()),
                parent_id: parent,
                title: v.t.clone(),
                url: v.u.clone().unwrap_or_default(),
                favicon,
                added_at: added(&v.a),
                sync_key,
            }
        } else {
            BookmarkNode::Folder {
                id: BookmarkId::new(id.as_str()),
                parent_id: Some(parent),
                title: v.t.clone(),
                children: Vec::new(),
                added_at: added(&v.a),
                sync_key,
            }
        };
        nodes.push(node);
    }
    for node in nodes.iter_mut() {
        if let BookmarkNode::Folder {
            id, children: kids, ..
        } = node
            && let Some(list) = children.get(id.as_str())
        {
            let mut list = list.clone();
            list.sort_by(&by_position);
            *kids = list
                .into_iter()
                .map(|c| BookmarkId::new(c.as_str()))
                .collect();
        }
    }
    Some(BookmarkTree::from_nodes(&tree.engine_profile, nodes, now))
}

pub struct BookmarksAdapter {
    cx: CycleContext,
    profile: ProfileId,
}

pub fn adapter(cx: &CycleContext, profile: &ProfileId) -> Box<dyn Adapter> {
    Box::new(InTodaysNames(BookmarksAdapter {
        cx: cx.clone(),
        profile: profile.clone(),
    }))
}

fn replaced(
    state: &BrowserState,
    profile: &ProfileId,
    visible: &IndexMap<String, Value>,
) -> Option<BrowserState> {
    let engine = state.engine_profile(profile);
    let tree = state.bookmarks.get(&engine)?;
    let next_tree = applied_tree(tree, visible, ardia_state::store::now_ms())?;
    if next_tree == **tree {
        return None;
    }
    let mut next = state.clone();
    Arc::make_mut(&mut next.bookmarks).insert(engine, Arc::new(next_tree));
    Some(next)
}

impl BookmarksAdapter {
    fn read_from_chrome(&self, state: &ardia_state::BrowserState) -> bool {
        !self.cx.host.has_main()
            || crate::bookmark_engine::engine_read(&state.engine_profile(&self.profile))
    }
}

impl Adapter for BookmarksAdapter {
    fn prefix(&self) -> &str {
        BOOKMARK
    }

    fn extract_uses_base(&self) -> bool {
        true
    }

    fn saves_whole(&self) -> bool {
        true
    }

    fn extracts_only_from(&self) -> Option<u64> {
        self.cx
            .host
            .state()
            .bookmarks_of(&self.profile)
            .map(|t| Arc::as_ptr(t) as u64)
    }

    fn extract(&mut self, cx: &ExtractContext) -> Option<Extraction> {
        let state = self.cx.host.state();
        if !self.read_from_chrome(&state) {
            return None;
        }
        let tree = state.bookmarks_of(&self.profile)?.clone();
        Some(Extraction::of(extract_values(&tree, &|key| cx.base(key))))
    }

    fn apply(
        &mut self,
        visible: &IndexMap<String, Value>,
        _changed: &IndexSet<String>,
        _records: &ApplyRecords,
    ) -> bool {
        let state = self.cx.host.state();
        if !self.read_from_chrome(&state) {
            return false;
        }
        let Some(tree) = state.bookmarks_of(&self.profile) else {
            return false;
        };
        if applied_tree(tree, visible, 0).is_none() {
            return false;
        }
        let profile = self.profile.clone();
        let visible = visible.clone();
        data_engine::edit_state(&self.cx, move |state| replaced(state, &profile, &visible));
        true
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sync_engine::adapters::data_engine::fake;
    use crate::sync_engine::adapters::tests_support::{MemoryTransport, run_cycle};
    use ardia_state::sync_engine::scope::ScopeState;
    use serde_json::json;

    fn state_with(tree: BookmarkTree) -> BrowserState {
        let mut state = BrowserState::default();
        let engine = state.engine_profile(&ProfileId::default_profile());
        Arc::make_mut(&mut state.bookmarks).insert(engine, Arc::new(tree));
        state
    }

    fn tree(nodes: Vec<(&str, &str, Option<&str>, &str)>) -> BookmarkTree {
        let mut list = Vec::new();
        let mut kids: IndexMap<String, Vec<BookmarkId>> = IndexMap::new();
        for (id, parent, url, title) in &nodes {
            kids.entry((*parent).to_owned())
                .or_default()
                .push(BookmarkId::new(*id));
            list.push(match url {
                Some(url) => BookmarkNode::Url {
                    id: BookmarkId::new(*id),
                    parent_id: BookmarkId::new(*parent),
                    title: (*title).into(),
                    url: (*url).into(),
                    favicon: None,
                    added_at: 7,
                    sync_key: None,
                },
                None => BookmarkNode::Folder {
                    id: BookmarkId::new(*id),
                    parent_id: Some(BookmarkId::new(*parent)),
                    title: (*title).into(),
                    children: Vec::new(),
                    added_at: 7,
                    sync_key: None,
                },
            });
        }
        for root in ["bar@default", "other@default"] {
            list.push(BookmarkNode::Folder {
                id: BookmarkId::new(root),
                parent_id: None,
                title: root.into(),
                children: Vec::new(),
                added_at: 0,
                sync_key: None,
            });
        }
        for node in list.iter_mut() {
            if let BookmarkNode::Folder { id, children, .. } = node {
                *children = kids.get(id.as_str()).cloned().unwrap_or_default();
            }
        }
        BookmarkTree::from_nodes("", list, 0)
    }

    const A: &str = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const F: &str = "ffffffff-ffff-4fff-8fff-ffffffffffff";
    const C: &str = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

    #[test]
    fn legacy_ids_map_to_the_same_uuid_as_the_old_app() {
        assert_eq!(
            bookmark_uuid_for("bm-b"),
            "e8085a08-2431-4049-b984-ba2bc415c202"
        );
        assert_eq!(
            bookmark_uuid_for("bm-1700000000000-abc"),
            "0e40fc91-44fb-47eb-826c-39814ef50957"
        );
        assert_eq!(
            bookmark_uuid_for("é😀x"),
            "8be08075-7c2c-4f0c-8ce1-df7804725a16"
        );
        assert_eq!(bookmark_uuid_for(A), A);
    }

    #[test]
    fn values_have_the_old_shape_and_order() {
        let t = tree(vec![
            (A, "bar@default", Some("https://a.com"), "A"),
            (F, "bar@default", None, "Folder"),
            (C, F, Some("https://c.com"), "C"),
        ]);
        let values = extract_values(&t, &|_| None);
        let keys: Vec<&String> = values.keys().collect();
        assert_eq!(
            keys,
            vec![&format!("bm:{A}"), &format!("bm:{F}"), &format!("bm:{C}")]
        );
        assert_eq!(
            serde_json::to_string(&values[&format!("bm:{A}")]).unwrap(),
            r#"{"k":"u","p":"bar","t":"A","u":"https://a.com","a":7,"pos":"V"}"#
        );
        assert_eq!(
            values[&format!("bm:{F}")],
            json!({ "k": "f", "p": "bar", "t": "Folder", "a": 7, "pos": "l" })
        );
        assert_eq!(values[&format!("bm:{C}")]["p"], json!(F));
    }

    #[test]
    fn cycles_and_orphans_land_in_other_bookmarks() {
        let t = tree(vec![]);
        let visible: IndexMap<String, Value> = [
            (format!("bm:{A}"), json!({ "k": "f", "p": F, "t": "A", "a": 1, "pos": "V" })),
            (format!("bm:{F}"), json!({ "k": "f", "p": A, "t": "F", "a": 1, "pos": "V" })),
            ("bm:bm-legacy".to_owned(), json!({ "k": "u", "p": "gone", "t": "L", "u": "https://l.com", "a": 1, "pos": "k" })),
        ]
        .into_iter()
        .collect();
        let next = applied_tree(&t, &visible, 0).unwrap();
        let other = next.children(next.other().as_str());
        assert!(other.iter().any(|id| id.as_str() == A));
        let legacy = bookmark_uuid_for("bm-legacy");
        assert!(other.iter().any(|id| id.as_str() == legacy));
        assert!(
            matches!(next.get(&legacy), Some(BookmarkNode::Url { sync_key: Some(k), .. }) if k == "bm-legacy")
        );
        assert_eq!(next.children(A), &[BookmarkId::new(F)]);
    }

    #[test]
    fn two_macs_merge_bookmarks_and_deletions() {
        let transport = MemoryTransport::default();
        let (a, _) = fake::context(
            state_with(tree(vec![(A, "bar@default", Some("https://a.com"), "A")])),
            "AAAA",
        );
        let (b, _) = fake::context(
            state_with(tree(vec![(C, "other@default", Some("https://c.com"), "C")])),
            "BBBB",
        );
        let profile = ProfileId::default_profile();
        let mut sa = ScopeState {
            joined: true,
            ..ScopeState::default()
        };
        let mut sb = ScopeState {
            joined: true,
            ..ScopeState::default()
        };
        run_cycle(
            &transport,
            "p:x",
            &mut sa,
            "AAAA",
            vec![adapter(&a, &profile)],
        );
        run_cycle(
            &transport,
            "p:x",
            &mut sb,
            "BBBB",
            vec![adapter(&b, &profile)],
        );
        run_cycle(
            &transport,
            "p:x",
            &mut sa,
            "AAAA",
            vec![adapter(&a, &profile)],
        );
        let ta = a.host.state().bookmarks_of(&profile).unwrap().clone();
        let tb = b.host.state().bookmarks_of(&profile).unwrap().clone();
        assert!(ta.get(C).is_some() && tb.get(A).is_some());
        let mut removed = (*tb).clone();
        removed.remove(A).unwrap();
        let mut next = (*b.host.state()).clone();
        Arc::make_mut(&mut next.bookmarks).insert(String::new(), Arc::new(removed));
        b.host.store().replace(next);
        run_cycle(
            &transport,
            "p:x",
            &mut sb,
            "BBBB",
            vec![adapter(&b, &profile)],
        );
        run_cycle(
            &transport,
            "p:x",
            &mut sa,
            "AAAA",
            vec![adapter(&a, &profile)],
        );
        assert!(
            a.host
                .state()
                .bookmarks_of(&profile)
                .unwrap()
                .get(A)
                .is_none()
        );
        assert!(
            a.host
                .state()
                .bookmarks_of(&profile)
                .unwrap()
                .get(C)
                .is_some()
        );
    }
}
