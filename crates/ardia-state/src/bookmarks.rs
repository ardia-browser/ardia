use crate::ids::{BookmarkId, IdGen};
use crate::json;
use crate::model::Millis;
use crate::omnibox::suggest::PageRow;
use indexmap::IndexMap;
use serde::{Deserialize, Serialize};
use serde_json::Value;

pub const BAR_ROOT: &str = "bar";
pub const OTHER_ROOT: &str = "other";
pub const MAX_BOOKMARK_DEPTH: usize = 64;

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum BookmarkNode {
    #[serde(rename_all = "camelCase")]
    Url {
        id: BookmarkId,
        parent_id: BookmarkId,
        #[serde(default, deserialize_with = "json::lenient")]
        title: String,
        url: String,
        #[serde(default, deserialize_with = "json::lenient")]
        favicon: Option<String>,
        #[serde(default, deserialize_with = "json::millis")]
        added_at: Millis,
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            deserialize_with = "json::lenient"
        )]
        sync_key: Option<String>,
    },
    #[serde(rename_all = "camelCase")]
    Folder {
        id: BookmarkId,
        #[serde(default, deserialize_with = "json::lenient")]
        parent_id: Option<BookmarkId>,
        #[serde(default, deserialize_with = "json::lenient")]
        title: String,
        #[serde(default, deserialize_with = "json::lenient")]
        children: Vec<BookmarkId>,
        #[serde(default, deserialize_with = "json::millis")]
        added_at: Millis,
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            deserialize_with = "json::lenient"
        )]
        sync_key: Option<String>,
    },
}

impl BookmarkNode {
    pub fn id(&self) -> &BookmarkId {
        match self {
            BookmarkNode::Url { id, .. } | BookmarkNode::Folder { id, .. } => id,
        }
    }

    pub fn parent(&self) -> Option<&BookmarkId> {
        match self {
            BookmarkNode::Url { parent_id, .. } => Some(parent_id),
            BookmarkNode::Folder { parent_id, .. } => parent_id.as_ref(),
        }
    }

    pub fn title(&self) -> &str {
        match self {
            BookmarkNode::Url { title, .. } | BookmarkNode::Folder { title, .. } => title,
        }
    }

    fn set_parent(&mut self, parent: BookmarkId) {
        match self {
            BookmarkNode::Url { parent_id, .. } => *parent_id = parent,
            BookmarkNode::Folder { parent_id, .. } => *parent_id = Some(parent),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum BookmarkError {
    #[error("no bookmark or folder has that id")]
    Missing,
    #[error("that bookmark can't hold children")]
    NotAFolder,
    #[error("a folder can't move inside itself")]
    Cycle,
    #[error("the bookmarks bar and other bookmarks can't be removed or moved")]
    Root,
}

#[derive(Clone, Debug, PartialEq)]
pub struct BookmarkTree {
    pub engine_profile: String,
    nodes: IndexMap<BookmarkId, BookmarkNode>,
}

fn root_id(root: &str, engine_profile: &str) -> BookmarkId {
    let profile = if engine_profile.is_empty() {
        crate::ids::DEFAULT_PROFILE_ID
    } else {
        engine_profile
    };
    BookmarkId::new(format!("{root}@{profile}"))
}

impl BookmarkTree {
    pub fn new(engine_profile: &str, now: Millis) -> Self {
        let mut tree = BookmarkTree {
            engine_profile: engine_profile.to_owned(),
            nodes: IndexMap::new(),
        };
        tree.ensure_roots(now);
        tree
    }

    pub fn from_nodes(engine_profile: &str, nodes: Vec<BookmarkNode>, now: Millis) -> Self {
        let mut tree = BookmarkTree {
            engine_profile: engine_profile.to_owned(),
            nodes: nodes.into_iter().map(|n| (n.id().clone(), n)).collect(),
        };
        tree.ensure_roots(now);
        tree.repair();
        tree
    }

    fn ensure_roots(&mut self, now: Millis) {
        for (root, title) in [(BAR_ROOT, "Bookmarks Bar"), (OTHER_ROOT, "Other Bookmarks")] {
            let id = root_id(root, &self.engine_profile);
            self.nodes
                .entry(id.clone())
                .or_insert(BookmarkNode::Folder {
                    id,
                    parent_id: None,
                    title: title.into(),
                    children: Vec::new(),
                    added_at: now,
                    sync_key: None,
                });
        }
    }

    fn repair(&mut self) {
        let ids: Vec<BookmarkId> = self.nodes.keys().cloned().collect();
        for id in ids {
            let children: Vec<BookmarkId> = match self.nodes.get(&id) {
                Some(BookmarkNode::Folder { children, .. }) => children
                    .iter()
                    .filter(|c| self.nodes.get(*c).is_some_and(|n| n.parent() == Some(&id)))
                    .cloned()
                    .collect(),
                _ => continue,
            };
            let mut seen = std::collections::HashSet::new();
            let unique: Vec<BookmarkId> = children
                .into_iter()
                .filter(|c| seen.insert(c.clone()))
                .collect();
            if let Some(BookmarkNode::Folder { children, .. }) = self.nodes.get_mut(&id) {
                *children = unique;
            }
        }
    }

    pub fn bar(&self) -> BookmarkId {
        root_id(BAR_ROOT, &self.engine_profile)
    }

    pub fn other(&self) -> BookmarkId {
        root_id(OTHER_ROOT, &self.engine_profile)
    }

    pub fn get(&self, id: &str) -> Option<&BookmarkNode> {
        self.nodes.get(id)
    }

    pub fn nodes(&self) -> impl Iterator<Item = &BookmarkNode> {
        self.nodes.values()
    }

    pub fn len(&self) -> usize {
        self.nodes.len()
    }

    pub fn is_empty(&self) -> bool {
        self.nodes.len() <= 2
    }

    pub fn children(&self, folder: &str) -> &[BookmarkId] {
        match self.nodes.get(folder) {
            Some(BookmarkNode::Folder { children, .. }) => children,
            _ => &[],
        }
    }

    fn is_root(&self, id: &str) -> bool {
        id == self.bar().as_str() || id == self.other().as_str()
    }

    fn insert_child(
        &mut self,
        parent: &BookmarkId,
        index: Option<usize>,
        node: BookmarkNode,
    ) -> Result<BookmarkId, BookmarkError> {
        let id = node.id().clone();
        match self.nodes.get_mut(parent) {
            Some(BookmarkNode::Folder { children, .. }) => {
                let at = index.unwrap_or(children.len()).min(children.len());
                children.insert(at, id.clone());
            }
            Some(_) => return Err(BookmarkError::NotAFolder),
            None => return Err(BookmarkError::Missing),
        }
        self.nodes.insert(id.clone(), node);
        Ok(id)
    }

    pub fn add_url(
        &mut self,
        ids: &IdGen,
        parent: &BookmarkId,
        index: Option<usize>,
        title: &str,
        url: &str,
        now: Millis,
    ) -> Result<BookmarkId, BookmarkError> {
        let id = BookmarkId::from(ids.next("bm"));
        self.insert_child(
            parent,
            index,
            BookmarkNode::Url {
                id,
                parent_id: parent.clone(),
                title: title.into(),
                url: url.into(),
                favicon: None,
                added_at: now,
                sync_key: None,
            },
        )
    }

    pub fn add_folder(
        &mut self,
        ids: &IdGen,
        parent: &BookmarkId,
        index: Option<usize>,
        title: &str,
        now: Millis,
    ) -> Result<BookmarkId, BookmarkError> {
        let id = BookmarkId::from(ids.next("bf"));
        self.insert_child(
            parent,
            index,
            BookmarkNode::Folder {
                id,
                parent_id: Some(parent.clone()),
                title: title.into(),
                children: Vec::new(),
                added_at: now,
                sync_key: None,
            },
        )
    }

    pub fn rename(&mut self, id: &str, new_title: &str) -> Result<(), BookmarkError> {
        match self.nodes.get_mut(id) {
            Some(BookmarkNode::Url { title, .. } | BookmarkNode::Folder { title, .. }) => {
                *title = new_title.to_owned();
                Ok(())
            }
            None => Err(BookmarkError::Missing),
        }
    }

    fn detach(&mut self, id: &str) {
        let parent = self.nodes.get(id).and_then(|n| n.parent().cloned());
        if let Some(BookmarkNode::Folder { children, .. }) =
            parent.and_then(|p| self.nodes.get_mut(&p))
        {
            children.retain(|c| c != id);
        }
    }

    pub fn remove(&mut self, id: &str) -> Result<usize, BookmarkError> {
        if self.is_root(id) {
            return Err(BookmarkError::Root);
        }
        if !self.nodes.contains_key(id) {
            return Err(BookmarkError::Missing);
        }
        self.detach(id);
        let mut stack = vec![BookmarkId::new(id)];
        let mut removed = 0;
        while let Some(at) = stack.pop() {
            if let Some(node) = self.nodes.shift_remove(&at) {
                removed += 1;
                if let BookmarkNode::Folder { children, .. } = node {
                    stack.extend(children);
                }
            }
        }
        Ok(removed)
    }

    pub fn ancestors(&self, id: &str) -> Vec<BookmarkId> {
        let mut out = Vec::new();
        let mut at = self.nodes.get(id).and_then(|n| n.parent().cloned());
        while let Some(parent) = at {
            if out.contains(&parent) || out.len() > MAX_BOOKMARK_DEPTH {
                break;
            }
            at = self.nodes.get(&parent).and_then(|n| n.parent().cloned());
            out.push(parent);
        }
        out
    }

    pub fn move_node(
        &mut self,
        id: &str,
        parent: &BookmarkId,
        index: Option<usize>,
    ) -> Result<(), BookmarkError> {
        if self.is_root(id) {
            return Err(BookmarkError::Root);
        }
        if !self.nodes.contains_key(id) {
            return Err(BookmarkError::Missing);
        }
        if parent.as_str() == id {
            return Err(BookmarkError::Cycle);
        }
        if !matches!(self.nodes.get(parent), Some(BookmarkNode::Folder { .. })) {
            return Err(BookmarkError::NotAFolder);
        }
        if self.ancestors(parent.as_str()).iter().any(|a| a == id) {
            return Err(BookmarkError::Cycle);
        }
        self.detach(id);
        if let Some(node) = self.nodes.get_mut(id) {
            node.set_parent(parent.clone());
        }
        if let Some(BookmarkNode::Folder { children, .. }) = self.nodes.get_mut(parent) {
            let at = index.unwrap_or(children.len()).min(children.len());
            children.insert(at, BookmarkId::new(id));
        }
        Ok(())
    }

    pub fn find_url(&self, url: &str) -> Option<&BookmarkNode> {
        self.nodes
            .values()
            .find(|n| matches!(n, BookmarkNode::Url { url: u, .. } if u == url))
    }

    pub fn rows(&self) -> impl Iterator<Item = PageRow<'_>> {
        self.nodes.values().filter_map(|n| match n {
            BookmarkNode::Url {
                url,
                title,
                favicon,
                ..
            } => Some(PageRow {
                url,
                title,
                favicon: favicon.as_deref(),
                visits: 0,
                last_visit: 0,
            }),
            BookmarkNode::Folder { .. } => None,
        })
    }

    pub fn import(
        &mut self,
        ids: &IdGen,
        parent: &BookmarkId,
        imported: &ardia_import_core::BookmarkNode,
        now: Millis,
    ) -> Result<usize, BookmarkError> {
        let mut added = 0;
        let mut stack: Vec<(BookmarkId, &ardia_import_core::BookmarkNode, usize)> = imported
            .children
            .iter()
            .flatten()
            .rev()
            .map(|c| (parent.clone(), c, 0))
            .collect();
        while let Some((into, node, depth)) = stack.pop() {
            let at = |ms: Option<f64>| ms.filter(|v| v.is_finite()).map_or(now, |v| v as Millis);
            match node.node_type {
                ardia_import_core::NodeType::Url => {
                    if let Some(url) = node
                        .url
                        .as_deref()
                        .filter(|u| !crate::omnibox::url::is_javascript_url(u))
                    {
                        self.add_url(ids, &into, None, &node.title, url, at(node.date_added))?;
                        added += 1;
                    }
                }
                ardia_import_core::NodeType::Folder => {
                    if depth >= MAX_BOOKMARK_DEPTH {
                        continue;
                    }
                    let folder =
                        self.add_folder(ids, &into, None, &node.title, at(node.date_added))?;
                    added += 1;
                    stack.extend(
                        node.children
                            .iter()
                            .flatten()
                            .rev()
                            .map(|c| (folder.clone(), c, depth + 1)),
                    );
                }
            }
        }
        Ok(added)
    }

    pub fn to_value(&self) -> Value {
        Value::Array(
            self.nodes
                .values()
                .map(|n| serde_json::to_value(n).unwrap_or(Value::Null))
                .collect(),
        )
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct BookmarkPlace {
    pub id: BookmarkId,
    pub parent: BookmarkId,
    pub index: usize,
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct RemovedBookmarks {
    pub nodes: Vec<BookmarkNode>,
    pub places: Vec<BookmarkPlace>,
}

impl BookmarkTree {
    pub fn is_folder(&self, id: &str) -> bool {
        matches!(self.nodes.get(id), Some(BookmarkNode::Folder { .. }))
    }

    pub fn depth_of(&self, id: &str) -> usize {
        self.ancestors(id).len()
    }

    pub fn height_of(&self, id: &str) -> usize {
        let mut deepest = 0;
        let mut stack = vec![(BookmarkId::new(id), 0usize)];
        while let Some((at, depth)) = stack.pop() {
            deepest = deepest.max(depth);
            if depth > MAX_BOOKMARK_DEPTH {
                break;
            }
            if let Some(BookmarkNode::Folder { children, .. }) = self.nodes.get(&at) {
                stack.extend(children.iter().map(|c| (c.clone(), depth + 1)));
            }
        }
        deepest
    }

    pub fn set_url(&mut self, id: &str, new_url: &str) -> Result<(), BookmarkError> {
        match self.nodes.get_mut(id) {
            Some(BookmarkNode::Url { url, .. }) => {
                *url = new_url.to_owned();
                Ok(())
            }
            Some(BookmarkNode::Folder { .. }) => Err(BookmarkError::NotAFolder),
            None => Err(BookmarkError::Missing),
        }
    }

    fn removable_tops(&self, ids: &[BookmarkId]) -> Vec<BookmarkId> {
        let removable: std::collections::HashSet<&BookmarkId> = ids
            .iter()
            .filter(|id| self.nodes.get(*id).and_then(BookmarkNode::parent).is_some())
            .collect();
        let mut tops: Vec<BookmarkId> = Vec::new();
        for id in ids {
            if removable.contains(id)
                && !tops.contains(id)
                && !self
                    .ancestors(id.as_str())
                    .iter()
                    .any(|a| removable.contains(a))
            {
                tops.push(id.clone());
            }
        }
        tops
    }

    pub fn removal_of(&self, ids: &[BookmarkId]) -> RemovedBookmarks {
        let mut removed = RemovedBookmarks::default();
        for id in self.removable_tops(ids) {
            let Some(parent) = self.nodes.get(&id).and_then(BookmarkNode::parent).cloned() else {
                continue;
            };
            let index = self
                .children(parent.as_str())
                .iter()
                .position(|c| c == &id)
                .unwrap_or(0);
            removed.places.push(BookmarkPlace {
                id: id.clone(),
                parent,
                index,
            });
            let mut stack = vec![id];
            while let Some(at) = stack.pop() {
                if let Some(node) = self.nodes.get(&at) {
                    if let BookmarkNode::Folder { children, .. } = node {
                        stack.extend(children.iter().cloned());
                    }
                    removed.nodes.push(node.clone());
                }
            }
        }
        removed
    }

    pub fn remove_many(&mut self, ids: &[BookmarkId]) -> usize {
        self.removable_tops(ids)
            .iter()
            .filter_map(|id| self.remove(id.as_str()).ok())
            .sum()
    }

    pub fn restore_removed(&mut self, removed: &RemovedBookmarks) -> usize {
        let mut by_parent: IndexMap<BookmarkId, Vec<&BookmarkPlace>> = IndexMap::new();
        for place in &removed.places {
            if self.nodes.contains_key(&place.id) {
                continue;
            }
            by_parent
                .entry(place.parent.clone())
                .or_default()
                .push(place);
        }
        let mut restored = 0;
        for (parent, mut list) in by_parent {
            let Some(BookmarkNode::Folder { children, .. }) = self.nodes.get(&parent) else {
                continue;
            };
            list.sort_by_key(|p| p.index);
            let staying = children.clone();
            let mut next: Vec<BookmarkId> = Vec::with_capacity(staying.len() + list.len());
            let mut kept = 0;
            for place in &list {
                while next.len() < place.index && kept < staying.len() {
                    next.push(staying[kept].clone());
                    kept += 1;
                }
                next.push(place.id.clone());
            }
            next.extend(staying[kept..].iter().cloned());
            if let Some(BookmarkNode::Folder { children, .. }) = self.nodes.get_mut(&parent) {
                *children = next;
            }
            let mut stack: Vec<BookmarkId> = list.iter().map(|p| p.id.clone()).collect();
            while let Some(id) = stack.pop() {
                if self.nodes.contains_key(&id) {
                    continue;
                }
                let Some(node) = removed.nodes.iter().find(|n| n.id() == &id) else {
                    continue;
                };
                if let BookmarkNode::Folder { children, .. } = node {
                    stack.extend(children.iter().cloned());
                }
                self.nodes.insert(id, node.clone());
                restored += 1;
            }
        }
        restored
    }

    pub fn move_many(
        &mut self,
        ids: &[BookmarkId],
        parent: &BookmarkId,
        index: Option<usize>,
    ) -> Result<usize, BookmarkError> {
        if !self.nodes.contains_key(parent) {
            return Err(BookmarkError::Missing);
        }
        if !self.is_folder(parent.as_str()) {
            return Err(BookmarkError::NotAFolder);
        }
        let mut above: std::collections::HashSet<BookmarkId> =
            self.ancestors(parent.as_str()).into_iter().collect();
        above.insert(parent.clone());
        let picked: Vec<BookmarkId> = ids
            .iter()
            .filter(|id| {
                self.nodes.get(*id).and_then(BookmarkNode::parent).is_some() && !above.contains(*id)
            })
            .fold(Vec::new(), |mut out, id| {
                if !out.contains(id) {
                    out.push(id.clone());
                }
                out
            });
        let picked_set: std::collections::HashSet<&BookmarkId> = picked.iter().collect();
        let moving: Vec<BookmarkId> = picked
            .iter()
            .filter(|id| {
                !self
                    .ancestors(id.as_str())
                    .iter()
                    .any(|a| picked_set.contains(a))
            })
            .cloned()
            .collect();
        if moving.is_empty() {
            return Ok(0);
        }
        for id in &moving {
            self.detach(id.as_str());
            if let Some(node) = self.nodes.get_mut(id) {
                node.set_parent(parent.clone());
            }
        }
        if let Some(BookmarkNode::Folder { children, .. }) = self.nodes.get_mut(parent) {
            let at = index.unwrap_or(children.len()).min(children.len());
            for (offset, id) in moving.iter().enumerate() {
                children.insert(at + offset, id.clone());
            }
        }
        Ok(moving.len())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn tree() -> BookmarkTree {
        let nodes: Vec<BookmarkNode> = serde_json::from_value(json!([
            {"kind": "folder", "id": "bar@default", "parentId": null, "title": "Bookmarks Bar", "children": ["a", "b", "ghost"], "addedAt": 1795525598667u64},
            {"kind": "url", "id": "a", "parentId": "bar@default", "title": "A", "url": "https://a.example/", "favicon": null, "addedAt": 1},
            {"kind": "folder", "id": "b", "parentId": "bar@default", "title": "B", "children": ["c"], "addedAt": 2},
            {"kind": "url", "id": "c", "parentId": "b", "title": "C", "url": "https://c.example/", "favicon": null, "addedAt": 3}
        ]))
        .unwrap();
        BookmarkTree::from_nodes("", nodes, 0)
    }

    #[test]
    fn cache_rows_round_trip_and_dangling_children_are_dropped() {
        let t = tree();
        assert_eq!(
            t.children("bar@default")
                .iter()
                .map(BookmarkId::as_str)
                .collect::<Vec<_>>(),
            vec!["a", "b"]
        );
        assert!(t.get("other@default").is_some());
        let value = t.to_value();
        let back: Vec<BookmarkNode> = serde_json::from_value(value).unwrap();
        assert_eq!(back.len(), t.len());
        assert_eq!(t.rows().count(), 2);
    }

    #[test]
    fn moves_refuse_cycles_and_roots() {
        let mut t = tree();
        assert_eq!(
            t.move_node("b", &BookmarkId::new("c"), None),
            Err(BookmarkError::NotAFolder)
        );
        assert_eq!(
            t.move_node("b", &BookmarkId::new("b"), None),
            Err(BookmarkError::Cycle)
        );
        assert_eq!(
            t.move_node("bar@default", &t.other(), None),
            Err(BookmarkError::Root)
        );
        let other = t.other();
        t.move_node("a", &other, Some(0)).unwrap();
        assert_eq!(t.children("other@default"), &[BookmarkId::new("a")]);
        assert_eq!(t.get("a").unwrap().parent(), Some(&other));
        assert_eq!(t.remove("b"), Ok(2));
        assert_eq!(t.remove("bar@default"), Err(BookmarkError::Root));
        assert_eq!(t.remove("zzz"), Err(BookmarkError::Missing));
    }

    #[test]
    fn adds_and_imports_into_folders() {
        let mut t = tree();
        let ids = IdGen::with_launch("t");
        let bar = t.bar();
        let folder = t.add_folder(&ids, &bar, Some(0), "New", 5).unwrap();
        let link = t
            .add_url(&ids, &folder, None, "Rust", "https://rust-lang.org/", 6)
            .unwrap();
        assert_eq!(t.children(folder.as_str()), &[link]);
        assert_eq!(
            t.add_url(&ids, &BookmarkId::new("a"), None, "x", "y", 0),
            Err(BookmarkError::NotAFolder)
        );
        let imported = ardia_import_core::BookmarkNode::folder(
            "Imported",
            vec![
                ardia_import_core::BookmarkNode::link("One", "https://one.example/", Some(1000.0)),
                ardia_import_core::BookmarkNode::link("Evil", "javascript:alert(1)", None),
                ardia_import_core::BookmarkNode::folder(
                    "Sub",
                    vec![ardia_import_core::BookmarkNode::link(
                        "Two",
                        "https://two.example/",
                        None,
                    )],
                    None,
                ),
            ],
            None,
        );
        let other = t.other();
        assert_eq!(t.import(&ids, &other, &imported, 9), Ok(3));
        assert!(t.find_url("https://two.example/").is_some());
        assert!(t.find_url("javascript:alert(1)").is_none());
        t.rename("a", "Renamed").unwrap();
        assert_eq!(t.get("a").unwrap().title(), "Renamed");
    }
}
