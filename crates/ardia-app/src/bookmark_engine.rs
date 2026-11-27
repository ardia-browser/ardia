use std::collections::{HashMap, HashSet};
use std::sync::Arc;

use ardia_engine::Services;
use ardia_state::bookmarks::{BookmarkNode, BookmarkTree};
use ardia_state::ids::BookmarkId;
use ardia_state::sync_engine::IndexMap;
use ardia_state::{BrowserState, ProfileId};
use parking_lot::Mutex;
use serde_json::{Map, Value, json};

use crate::coordinator::AppCoordinator;

#[derive(Clone, Debug, PartialEq)]
pub struct FlatNode {
    pub folder: bool,
    pub parent: Option<String>,
    pub title: String,
    pub url: Option<String>,
    pub added_at: i64,
    pub key: Option<String>,
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct Flat {
    pub nodes: IndexMap<String, FlatNode>,
    pub children: HashMap<String, Vec<String>>,
}

pub fn roots_for(engine: &str) -> (String, String) {
    let name = if engine.is_empty() { "default" } else { engine };
    (format!("bar@{name}"), format!("other@{name}"))
}

pub fn flat_from_tree(tree: &BookmarkTree) -> Flat {
    let mut flat = Flat::default();
    let (bar, other) = roots_for(&tree.engine_profile);
    for root in [bar, other] {
        if tree.get(&root).is_none() || flat.nodes.contains_key(&root) {
            continue;
        }
        let mut stack: Vec<(String, Option<String>)> = vec![(root, None)];
        let mut order: Vec<String> = Vec::new();
        while let Some((id, parent)) = stack.pop() {
            if flat.nodes.contains_key(&id) {
                continue;
            }
            let Some(node) = tree.get(&id) else { continue };
            if let Some(parent) = &parent {
                flat.children
                    .entry(parent.clone())
                    .or_default()
                    .push(id.clone());
            }
            let (folder, url, added_at, key) = match node {
                BookmarkNode::Url {
                    url,
                    added_at,
                    sync_key,
                    ..
                } => (false, Some(url.clone()), *added_at, sync_key.clone()),
                BookmarkNode::Folder {
                    added_at, sync_key, ..
                } => (true, None, *added_at, sync_key.clone()),
            };
            flat.nodes.insert(
                id.clone(),
                FlatNode {
                    folder,
                    parent,
                    title: node.title().to_owned(),
                    url,
                    added_at,
                    key,
                },
            );
            order.push(id.clone());
            if folder {
                flat.children.entry(id.clone()).or_default();
                for child in tree.children(&id).iter().rev() {
                    if !flat.nodes.contains_key(child.as_str()) {
                        stack.push((child.as_str().to_owned(), Some(id.clone())));
                    }
                }
            }
        }
    }
    flat
}

fn engine_node(value: &Value, id: &str, parent: Option<&str>, flat: &mut Flat, depth: usize) {
    if depth > ardia_state::bookmarks::MAX_BOOKMARK_DEPTH + 1 || flat.nodes.contains_key(id) {
        return;
    }
    let folder = value.get("k").and_then(Value::as_str) != Some("u");
    flat.nodes.insert(
        id.to_owned(),
        FlatNode {
            folder,
            parent: parent.map(str::to_owned),
            title: value
                .get("t")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_owned(),
            url: (!folder).then(|| {
                value
                    .get("u")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_owned()
            }),
            added_at: value
                .get("a")
                .and_then(Value::as_f64)
                .filter(|a| a.is_finite())
                .map_or(0, |a| a as i64),
            key: value.get("key").and_then(Value::as_str).map(str::to_owned),
        },
    );
    if !folder {
        return;
    }
    let mut kids = Vec::new();
    for child in value
        .get("c")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        let Some(child_id) = child.get("id").and_then(Value::as_str) else {
            continue;
        };
        if flat.nodes.contains_key(child_id) {
            continue;
        }
        kids.push(child_id.to_owned());
        engine_node(child, child_id, Some(id), flat, depth + 1);
    }
    flat.children.insert(id.to_owned(), kids);
}

pub fn flat_from_engine(tree: &Value, engine: &str) -> Option<Flat> {
    let (bar, other) = roots_for(engine);
    let bar_node = tree.get("bar")?;
    let other_node = tree.get("other")?;
    let mut flat = Flat::default();
    engine_node(bar_node, &bar, None, &mut flat, 0);
    engine_node(other_node, &other, None, &mut flat, 0);
    Some(flat)
}

fn op_parent(engine: &str, id: &str) -> String {
    let (bar, other) = roots_for(engine);
    if id == bar {
        "bar".into()
    } else if id == other {
        "other".into()
    } else {
        id.to_owned()
    }
}

fn flat_parent(engine: &str, id: &str) -> String {
    let (bar, other) = roots_for(engine);
    match id {
        "bar" => bar,
        "other" => other,
        _ => id.to_owned(),
    }
}

fn longest_rising(values: &[i64]) -> Vec<bool> {
    let mut kept = vec![false; values.len()];
    let mut before = vec![usize::MAX; values.len()];
    let mut tails: Vec<usize> = Vec::new();
    for (i, value) in values.iter().enumerate() {
        if *value < 0 {
            continue;
        }
        let (mut low, mut high) = (0, tails.len());
        while low < high {
            let middle = (low + high) >> 1;
            if values[tails[middle]] < *value {
                low = middle + 1;
            } else {
                high = middle;
            }
        }
        if low > 0 {
            before[i] = tails[low - 1];
        }
        if low == tails.len() {
            tails.push(i);
        } else {
            tails[low] = i;
        }
    }
    let mut at = tails.last().copied().unwrap_or(usize::MAX);
    while at != usize::MAX {
        kept[at] = true;
        at = before[at];
    }
    kept
}

struct SlotCounts {
    sums: Vec<i64>,
}

impl SlotCounts {
    fn new(filled: &[bool]) -> Self {
        let mut sums = vec![0i64; filled.len() + 1];
        for i in 1..=filled.len() {
            sums[i] += i64::from(filled[i - 1]);
            let up = i + i.isolate_lowest_one();
            if up <= filled.len() {
                sums[up] += sums[i];
            }
        }
        SlotCounts { sums }
    }

    fn add(&mut self, slot: usize, by: i64) {
        let mut i = slot + 1;
        while i < self.sums.len() {
            self.sums[i] += by;
            i += i.isolate_lowest_one();
        }
    }

    fn before(&self, slot: usize) -> i64 {
        let mut count = 0;
        let mut i = slot;
        while i > 0 {
            count += self.sums[i];
            i -= i.isolate_lowest_one();
        }
        count
    }
}

struct Places {
    places: HashMap<String, usize>,
    have_at: HashMap<String, usize>,
    old_slot: Vec<usize>,
    new_slot: Vec<usize>,
    counts: SlotCounts,
}

impl Places {
    fn new(have: &[String], want: &[String]) -> Option<Places> {
        if have == want {
            return None;
        }
        let have_at: HashMap<String, usize> = have
            .iter()
            .enumerate()
            .map(|(i, id)| (id.clone(), i))
            .collect();
        let positions: Vec<i64> = want
            .iter()
            .map(|id| have_at.get(id).map_or(-1, |i| *i as i64))
            .collect();
        let kept = longest_rising(&positions);
        let kept_at: HashMap<&String, usize> = want
            .iter()
            .enumerate()
            .filter(|(i, _)| kept[*i])
            .map(|(i, id)| (id, i))
            .collect();
        let mut new_slot = vec![0usize; want.len()];
        let mut old_slot = vec![0usize; have.len()];
        let mut slots = 0usize;
        let run = |from: usize, slots: &mut usize, new_slot: &mut Vec<usize>| {
            let mut i = from;
            while i < want.len() && !kept[i] {
                new_slot[i] = *slots;
                *slots += 1;
                i += 1;
            }
        };
        run(0, &mut slots, &mut new_slot);
        for (i, id) in have.iter().enumerate() {
            old_slot[i] = slots;
            slots += 1;
            if let Some(at) = kept_at.get(id) {
                run(at + 1, &mut slots, &mut new_slot);
            }
        }
        let mut filled = vec![false; slots];
        for slot in &old_slot {
            filled[*slot] = true;
        }
        let places = want
            .iter()
            .enumerate()
            .filter(|(i, _)| !kept[*i])
            .map(|(i, id)| (id.clone(), i))
            .collect();
        Some(Places {
            places,
            have_at,
            old_slot,
            new_slot,
            counts: SlotCounts::new(&filled),
        })
    }

    fn take(&mut self, id: &str) -> Option<usize> {
        let i = *self.places.get(id)?;
        if let Some(was) = self.have_at.get(id) {
            self.counts.add(self.old_slot[*was], -1);
        }
        let index = self.counts.before(self.new_slot[i]);
        self.counts.add(self.new_slot[i], 1);
        Some(index.max(0) as usize)
    }
}

pub fn bookmark_ops(from: &Flat, to: &Flat, engine: &str) -> Vec<Value> {
    let (bar, other) = roots_for(engine);
    let mut parent_of: HashMap<String, Option<String>> = from
        .nodes
        .iter()
        .map(|(id, n)| (id.clone(), n.parent.clone()))
        .collect();
    let mut ops = Vec::new();
    let mut queue = vec![bar, other];
    let mut next = 0;
    while next < queue.len() {
        let folder = queue[next].clone();
        next += 1;
        let want = to.children.get(&folder).cloned().unwrap_or_default();
        let have: Vec<String> = from
            .children
            .get(&folder)
            .cloned()
            .unwrap_or_default()
            .into_iter()
            .filter(|id| parent_of.get(id).cloned().flatten().as_deref() == Some(folder.as_str()))
            .collect();
        let mut places = Places::new(&have, &want);
        for id in &want {
            let Some(node) = to.nodes.get(id) else {
                continue;
            };
            let was = from.nodes.get(id);
            let place = places.as_mut().and_then(|p| p.take(id));
            if !parent_of.contains_key(id) {
                let mut op = Map::new();
                op.insert("op".into(), "add".into());
                op.insert("id".into(), id.clone().into());
                op.insert("k".into(), if node.folder { "f" } else { "u" }.into());
                op.insert("t".into(), node.title.clone().into());
                if let Some(url) = &node.url {
                    op.insert("u".into(), url.clone().into());
                }
                op.insert("a".into(), node.added_at.into());
                if let Some(key) = &node.key {
                    op.insert("key".into(), key.clone().into());
                }
                op.insert("parent".into(), op_parent(engine, &folder).into());
                op.insert("index".into(), place.unwrap_or(0).into());
                ops.push(Value::Object(op));
                parent_of.insert(id.clone(), Some(folder.clone()));
            } else {
                if let Some(index) = place {
                    ops.push(json!({ "op": "move", "id": id, "parent": op_parent(engine, &folder), "index": index }));
                    parent_of.insert(id.clone(), Some(folder.clone()));
                }
                if let Some(was) = was
                    && (was.title != node.title || (node.url.is_some() && was.url != node.url))
                {
                    let mut op = Map::new();
                    op.insert("op".into(), "update".into());
                    op.insert("id".into(), id.clone().into());
                    op.insert("t".into(), node.title.clone().into());
                    if let Some(url) = &node.url {
                        op.insert("u".into(), url.clone().into());
                    }
                    ops.push(Value::Object(op));
                }
            }
            if node.folder {
                queue.push(id.clone());
            }
        }
    }
    for (id, node) in &from.nodes {
        if to.nodes.contains_key(id) || node.parent.is_none() {
            continue;
        }
        let mut under = false;
        let mut at = parent_of.get(id).cloned().flatten();
        let mut hops = 0;
        while let Some(parent) = at.filter(|_| !under && hops < 256) {
            under = !to.nodes.contains_key(&parent);
            at = parent_of.get(&parent).cloned().flatten();
            hops += 1;
        }
        if !under {
            ops.push(json!({ "op": "remove", "id": id }));
        }
    }
    ops
}

fn keeps_url(url: &str) -> bool {
    let Some((scheme, rest)) = url.split_once(':') else {
        return false;
    };
    let mut chars = scheme.chars();
    chars.next().is_some_and(|c| c.is_ascii_alphabetic())
        && chars.all(|c| c.is_ascii_alphanumeric() || "+.-".contains(c))
        && !rest.is_empty()
}

pub fn apply_ops(tree: &Flat, ops: &[Value], engine: &str) -> Flat {
    let mut flat = tree.clone();
    let text = |op: &Value, key: &str| op.get(key).and_then(Value::as_str).map(str::to_owned);
    let detach = |flat: &mut Flat, id: &str| {
        if let Some(parent) = flat.nodes.get(id).and_then(|n| n.parent.clone())
            && let Some(list) = flat.children.get_mut(&parent)
        {
            list.retain(|c| c != id);
        }
    };
    let attach = |flat: &mut Flat, id: &str, parent: &str, index: Option<usize>| {
        if let Some(list) = flat.children.get_mut(parent) {
            let at = index.unwrap_or(list.len()).min(list.len());
            list.insert(at, id.to_owned());
        }
        if let Some(node) = flat.nodes.get_mut(id) {
            node.parent = Some(parent.to_owned());
        }
    };
    let inside = |flat: &Flat, id: &str, of: &str| {
        let mut at = Some(of.to_owned());
        let mut hops = 0;
        while let Some(current) = at {
            if current == id || hops > 256 {
                return true;
            }
            at = flat.nodes.get(&current).and_then(|n| n.parent.clone());
            hops += 1;
        }
        false
    };
    for op in ops {
        let Some(id) = text(op, "id") else { break };
        let kind = text(op, "op").unwrap_or_default();
        let node = flat.nodes.get(&id).cloned();
        match kind.as_str() {
            "remove" => {
                if node.as_ref().is_none_or(|n| n.parent.is_none()) {
                    break;
                }
                detach(&mut flat, &id);
                let mut dropping = vec![id.clone()];
                while let Some(gone) = dropping.pop() {
                    if let Some(children) = flat.children.remove(&gone) {
                        dropping.extend(children);
                    }
                    flat.nodes.shift_remove(&gone);
                }
            }
            "update" => {
                let Some(mut node) = node.filter(|n| n.parent.is_some()) else {
                    break;
                };
                if let Some(t) = text(op, "t") {
                    node.title = t;
                }
                if let Some(u) = text(op, "u").filter(|u| !node.folder && keeps_url(u)) {
                    node.url = Some(u);
                }
                flat.nodes.insert(id, node);
            }
            _ => {
                let parent = flat_parent(engine, &text(op, "parent").unwrap_or_default());
                if !flat.nodes.get(&parent).is_some_and(|n| n.folder) {
                    break;
                }
                let index = op.get("index").and_then(Value::as_u64).map(|i| i as usize);
                if kind == "add" && node.is_some() && op.get("ifAbsent") == Some(&Value::Bool(true))
                {
                    continue;
                }
                if kind == "move" || node.is_some() {
                    let Some(node) = node.filter(|n| n.parent.is_some()) else {
                        break;
                    };
                    if inside(&flat, &id, &parent) {
                        break;
                    }
                    detach(&mut flat, &id);
                    attach(&mut flat, &id, &parent, index);
                    if kind == "add"
                        && let Some(current) = flat.nodes.get_mut(&id)
                    {
                        current.title = text(op, "t").unwrap_or_default();
                        if let Some(u) = text(op, "u").filter(|u| !node.folder && keeps_url(u)) {
                            current.url = Some(u);
                        }
                    }
                    continue;
                }
                let folder = text(op, "k").as_deref() != Some("u");
                let url = text(op, "u").unwrap_or_default();
                if !folder && !keeps_url(&url) {
                    continue;
                }
                flat.nodes.insert(
                    id.clone(),
                    FlatNode {
                        folder,
                        parent: Some(parent.clone()),
                        title: text(op, "t").unwrap_or_default(),
                        url: (!folder).then_some(url),
                        added_at: op.get("a").and_then(Value::as_f64).map_or(0, |a| a as i64),
                        key: text(op, "key"),
                    },
                );
                if folder {
                    flat.children.insert(id.clone(), Vec::new());
                }
                attach(&mut flat, &id, &parent, index);
            }
        }
    }
    flat
}

pub fn tree_from_flat(
    flat: &Flat,
    engine: &str,
    previous: Option<&BookmarkTree>,
    now: i64,
) -> BookmarkTree {
    let (bar, other) = roots_for(engine);
    let mut nodes = Vec::with_capacity(flat.nodes.len());
    for (id, node) in &flat.nodes {
        let bookmark = BookmarkId::new(id.as_str());
        let title = if *id == bar {
            "Bookmarks Bar".to_owned()
        } else if *id == other {
            "Other Bookmarks".to_owned()
        } else {
            node.title.clone()
        };
        if node.folder {
            nodes.push(BookmarkNode::Folder {
                id: bookmark,
                parent_id: node.parent.as_deref().map(BookmarkId::new),
                title,
                children: flat
                    .children
                    .get(id)
                    .into_iter()
                    .flatten()
                    .map(|c| BookmarkId::new(c.as_str()))
                    .collect(),
                added_at: node.added_at,
                sync_key: node.key.clone(),
            });
        } else {
            let favicon = previous.and_then(|t| t.get(id)).and_then(|n| match n {
                BookmarkNode::Url { favicon, .. } => favicon.clone(),
                BookmarkNode::Folder { .. } => None,
            });
            nodes.push(BookmarkNode::Url {
                id: bookmark,
                parent_id: BookmarkId::new(node.parent.as_deref().unwrap_or(&other)),
                title,
                url: node.url.clone().unwrap_or_default(),
                favicon,
                added_at: node.added_at,
                sync_key: node.key.clone(),
            });
        }
    }
    BookmarkTree::from_nodes(engine, nodes, now)
}

#[derive(Default)]
struct EngineState {
    shadow: Option<Flat>,
    shown: Option<Flat>,
    busy: bool,
    need_read: bool,
    need_push: bool,
    started: bool,
}

#[derive(Default)]
pub struct BookmarkSync {
    engines: HashMap<String, EngineState>,
}

static READ: Mutex<Option<HashSet<String>>> = Mutex::new(None);

pub fn engine_read(engine: &str) -> bool {
    READ.lock()
        .as_ref()
        .is_some_and(|read| read.contains(engine))
}

fn mark_read(engine: &str) {
    READ.lock()
        .get_or_insert_with(HashSet::new)
        .insert(engine.to_owned());
}

fn profile_of(state: &BrowserState, engine: &str) -> Option<ProfileId> {
    state
        .profile_order
        .iter()
        .find(|p| !p.is_incognito() && state.engine_profile(p) == engine)
        .cloned()
}

fn adopt(coordinator: &AppCoordinator, engine: &str, flat: &Flat) {
    let state = coordinator.store.snapshot();
    let previous = state.bookmarks.get(engine).cloned();
    let tree = tree_from_flat(
        flat,
        engine,
        previous.as_deref(),
        ardia_state::store::now_ms(),
    );
    if previous.as_deref() == Some(&tree) {
        return;
    }
    let mut next = (*state).clone();
    Arc::make_mut(&mut next.bookmarks).insert(engine.to_owned(), Arc::new(tree));
    coordinator.store.replace(next);
}

impl AppCoordinator {
    pub(crate) fn load_engine_bookmarks(&self) {
        let state = self.store.snapshot();
        for profile in state.profile_order.iter() {
            if profile.is_incognito() || self.engine_profile(profile).is_none() {
                continue;
            }
            let engine = state.engine_profile(profile);
            let start = {
                let mut bridge = self.bridge.lock();
                let entry = bridge
                    .bookmark_sync
                    .engines
                    .entry(engine.clone())
                    .or_default();
                let first = !std::mem::replace(&mut entry.started, true);
                if first {
                    entry.shown = state.bookmarks.get(&engine).map(|t| flat_from_tree(t));
                }
                first
            };
            if start {
                self.read_engine_bookmarks(&engine);
            }
        }
    }

    pub(crate) fn engine_bookmarks_changed(&self, event: &ardia_engine::ServiceEvent) {
        let engine = event
            .payload
            .get("profile")
            .and_then(Value::as_str)
            .or(event.profile.as_deref())
            .unwrap_or_default()
            .to_owned();
        let known = self
            .bridge
            .lock()
            .bookmark_sync
            .engines
            .get(&engine)
            .is_some_and(|e| e.shadow.is_some());
        if known {
            self.read_engine_bookmarks(&engine);
        }
    }

    pub(crate) fn push_engine_bookmarks(&self) {
        let engines: Vec<String> = self
            .bridge
            .lock()
            .bookmark_sync
            .engines
            .iter()
            .filter(|(_, e)| e.shadow.is_some())
            .map(|(k, _)| k.clone())
            .collect();
        for engine in engines {
            self.bridge
                .lock()
                .bookmark_sync
                .engines
                .entry(engine.clone())
                .or_default()
                .need_push = true;
            self.work_engine_bookmarks(&engine);
        }
    }

    fn read_engine_bookmarks(&self, engine: &str) {
        self.bridge
            .lock()
            .bookmark_sync
            .engines
            .entry(engine.to_owned())
            .or_default()
            .need_read = true;
        self.work_engine_bookmarks(engine);
    }

    fn work_engine_bookmarks(&self, engine: &str) {
        let take = {
            let mut bridge = self.bridge.lock();
            let state = bridge
                .bookmark_sync
                .engines
                .entry(engine.to_owned())
                .or_default();
            if state.busy || !(state.need_read || state.need_push) {
                None
            } else {
                state.busy = true;
                let read = state.need_read;
                if read {
                    state.need_read = false;
                    state.need_push = false;
                } else {
                    state.need_push = false;
                }
                Some(read)
            }
        };
        let Some(read) = take else { return };
        let Some(profile) = profile_of(&self.store.snapshot(), engine) else {
            self.finish_bookmark_work(engine, false);
            return;
        };
        let (Some(core), Some(dir)) = (self.engine(), self.service_profile_dir(&profile)) else {
            self.finish_bookmark_work(engine, false);
            return;
        };
        let me = self.weak();
        let engine = engine.to_owned();
        if read {
            let watch = Services::new(core.as_ref(), &dir).bookmarks().watch();
            let tree = Services::new(core.as_ref(), &dir).bookmarks().tree();
            let apply_core = core.clone();
            self.spawn(async move {
                let _ = watch.await;
                let answer = tree.await;
                let Some(me) = me.upgrade() else { return };
                let fetched = answer.ok().and_then(|t| flat_from_engine(&t, &engine));
                let Some(fetched) = fetched else {
                    log::warn!("[bookmarks] couldn't read {engine}'s bookmarks from Chrome");
                    me.finish_bookmark_work(&engine, false);
                    return;
                };
                let state = me.store.snapshot();
                let base = me
                    .bridge
                    .lock()
                    .bookmark_sync
                    .engines
                    .get(&engine)
                    .and_then(|e| e.shadow.clone().or_else(|| e.shown.clone()));
                let desired = state.bookmarks.get(&engine).map(|t| flat_from_tree(t));
                let edits = match (base, desired) {
                    (Some(base), Some(desired)) => bookmark_ops(&base, &desired, &engine),
                    _ => Vec::new(),
                };
                let merged = if edits.is_empty() {
                    fetched.clone()
                } else {
                    apply_ops(&fetched, &edits, &engine)
                };
                if let Some(entry) = me.bridge.lock().bookmark_sync.engines.get_mut(&engine) {
                    entry.shadow = Some(fetched);
                    entry.shown = None;
                }
                adopt(&me, &engine, &merged);
                mark_read(&engine);
                if edits.is_empty() {
                    me.finish_bookmark_work(&engine, false);
                    return;
                }
                let reply = Services::new(apply_core.as_ref(), &dir)
                    .bookmarks()
                    .apply(Value::Array(edits));
                let sent = reply.await.ok().is_some_and(|r| applied_cleanly(&r));
                if let Some(entry) = me.bridge.lock().bookmark_sync.engines.get_mut(&engine) {
                    if sent {
                        entry.shadow = Some(merged);
                    } else {
                        entry.need_read = true;
                    }
                }
                me.finish_bookmark_work(&engine, false);
            });
            return;
        }
        let shadow = self
            .bridge
            .lock()
            .bookmark_sync
            .engines
            .get(&engine)
            .and_then(|e| e.shadow.clone());
        let desired = self
            .store
            .snapshot()
            .bookmarks
            .get(&engine)
            .map(|t| flat_from_tree(t));
        let (Some(shadow), Some(desired)) = (shadow, desired) else {
            self.finish_bookmark_work(&engine, false);
            return;
        };
        let diff_started = std::time::Instant::now();
        let ops = bookmark_ops(&shadow, &desired, &engine);
        ardia_telemetry::counts::raise(
            "bookmark_sync_diff_ms_max",
            diff_started.elapsed().as_millis() as u64,
        );
        if ops.is_empty() {
            self.finish_bookmark_work(&engine, false);
            return;
        }
        let reply = Services::new(core.as_ref(), &dir)
            .bookmarks()
            .apply(Value::Array(ops));
        self.spawn(async move {
            let sent = reply.await.ok().is_some_and(|r| applied_cleanly(&r));
            let Some(me) = me.upgrade() else { return };
            if let Some(entry) = me.bridge.lock().bookmark_sync.engines.get_mut(&engine) {
                if sent {
                    entry.shadow = Some(desired);
                } else {
                    entry.need_read = true;
                }
            }
            me.finish_bookmark_work(&engine, false);
        });
    }

    fn finish_bookmark_work(&self, engine: &str, _failed: bool) {
        let again = {
            let mut bridge = self.bridge.lock();
            let state = bridge
                .bookmark_sync
                .engines
                .entry(engine.to_owned())
                .or_default();
            state.busy = false;
            state.need_read || state.need_push
        };
        if again {
            let me = self.weak();
            let engine = engine.to_owned();
            self.post(move |_| {
                if let Some(me) = me.upgrade() {
                    me.work_engine_bookmarks(&engine);
                }
            });
        }
    }
}

fn applied_cleanly(reply: &Value) -> bool {
    let skipped = reply.get("skipped").and_then(Value::as_u64).unwrap_or(0);
    let invalid = reply
        .get("invalid")
        .and_then(Value::as_array)
        .is_some_and(|i| !i.is_empty());
    skipped == 0 && !invalid
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ids() -> ardia_state::IdGen {
        ardia_state::IdGen::with_launch("bm")
    }

    fn tree() -> BookmarkTree {
        let ids = ids();
        let mut tree = BookmarkTree::new("", 1);
        let bar = tree.bar();
        let folder = tree.add_folder(&ids, &bar, None, "Work", 2).unwrap();
        tree.add_url(&ids, &folder, None, "Docs", "https://docs.example/", 3)
            .unwrap();
        tree.add_url(&ids, &bar, None, "A", "https://a.example/", 4)
            .unwrap();
        let other = tree.other();
        tree.add_url(&ids, &other, None, "O", "https://o.example/", 5)
            .unwrap();
        tree
    }

    fn engine_json(flat: &Flat, id: &str) -> Value {
        let node = &flat.nodes[id];
        let mut value = json!({ "id": id, "k": if node.folder { "f" } else { "u" }, "t": node.title, "a": node.added_at });
        if let Some(url) = &node.url {
            value["u"] = url.clone().into();
        }
        if node.folder {
            value["c"] = Value::Array(
                flat.children[id]
                    .iter()
                    .map(|c| engine_json(flat, c))
                    .collect(),
            );
        }
        value
    }

    #[test]
    fn a_store_tree_round_trips_through_the_engine_shape() {
        let flat = flat_from_tree(&tree());
        let (bar, other) = roots_for("");
        let engine =
            json!({ "bar": engine_json(&flat, &bar), "other": engine_json(&flat, &other) });
        let back = flat_from_engine(&engine, "").unwrap();
        assert_eq!(back.children, flat.children);
        assert_eq!(back.nodes.len(), flat.nodes.len());
        let rebuilt = tree_from_flat(&back, "", None, 9);
        assert_eq!(flat_from_tree(&rebuilt).children, flat.children);
    }

    #[test]
    fn ops_turn_the_old_tree_into_the_new_one_like_flat_bookmarks() {
        let before = tree();
        let mut after = before.clone();
        let bar = after.bar();
        let ids: Vec<BookmarkId> = after.children(bar.as_str()).to_vec();
        after.move_node(ids[1].as_str(), &bar, Some(0)).unwrap();
        after.rename(ids[0].as_str(), "Work 2").unwrap();
        let other = after.other();
        let added = after
            .add_url(
                &ardia_state::IdGen::with_launch("bm2"),
                &other,
                None,
                "New",
                "https://new.example/",
                7,
            )
            .unwrap();
        let docs = after.children(ids[0].as_str()).to_vec();
        after.remove(docs[0].as_str()).unwrap();
        let from = flat_from_tree(&before);
        let to = flat_from_tree(&after);
        let ops = bookmark_ops(&from, &to, "");
        let kinds: Vec<&str> = ops.iter().map(|o| o["op"].as_str().unwrap()).collect();
        assert_eq!(kinds, vec!["move", "update", "add", "remove"]);
        assert_eq!(ops[2]["id"], json!(added.as_str()));
        assert_eq!(ops[2]["parent"], json!("other"));
        let applied = apply_ops(&from, &ops, "");
        assert_eq!(applied.children, to.children);
        assert_eq!(
            applied.nodes.keys().collect::<HashSet<_>>(),
            to.nodes.keys().collect::<HashSet<_>>()
        );
        assert!(bookmark_ops(&to, &to, "").is_empty());
        assert!(!keeps_url("javascript"));
        assert!(keeps_url("https://x"));
    }
}
