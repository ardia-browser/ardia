use std::collections::HashSet;
use std::sync::Arc;

use ardia_state::BookmarkId;
use ardia_state::bookmarks::{BookmarkNode, BookmarkTree, MAX_BOOKMARK_DEPTH};

pub const ROW: f32 = 36.0;
pub const TREE_WIDTH: f32 = 230.0;
pub const TREE_ROW: f32 = 28.0;
pub const HEADER_HEIGHT: f32 = 40.0;
pub const DROP_LINE: f32 = 2.0;
pub const FOLDER_ICON: f32 = 14.0;
pub const FOLDER_ICON_BOX: f32 = 16.0;
pub const DRAG_OPACITY: f32 = 0.85;
pub const TREE_INDENT: f32 = 16.0;
pub const TREE_CHEVRON_BOX: f32 = 16.0;
pub const TREE_CHEVRON: f32 = 9.0;
pub const TREE_FOLDER_ICON: f32 = 13.0;
pub const TREE_FOLDER_BOX: f32 = 18.0;
pub const PICKER_HEIGHT: f32 = 180.0;
pub const PICKER_ROW: f32 = 24.0;
pub const UNDO_VISIBLE_MS: u64 = 8000;
pub const MANY_LINKS: usize = 15;
pub const FOLDER_MANY: &str = "This folder has a lot of bookmarks.";
pub const LINKS_MANY: &str = "That's a lot of pages.";

#[derive(Clone, Debug, Default, PartialEq)]
pub struct Selection {
    pub selected: Vec<BookmarkId>,
    pub anchor: Option<BookmarkId>,
    members: HashSet<BookmarkId>,
}

impl Selection {
    pub fn contains(&self, id: &BookmarkId) -> bool {
        self.members.contains(id)
    }

    pub fn is_empty(&self) -> bool {
        self.selected.is_empty()
    }

    pub fn in_order(&self, ids: &[BookmarkId]) -> Vec<BookmarkId> {
        if self.selected.is_empty() {
            return Vec::new();
        }
        ids.iter()
            .filter(|id| self.members.contains(*id))
            .cloned()
            .collect()
    }

    fn set(&mut self, selected: Vec<BookmarkId>) {
        self.members = selected.iter().cloned().collect();
        self.selected = selected;
    }

    pub fn click(&mut self, ids: &[BookmarkId], id: &BookmarkId, command: bool, shift: bool) {
        if shift && let Some(anchor) = self.anchor.clone() {
            let from = ids.iter().position(|x| x == &anchor);
            let to = ids.iter().position(|x| x == id);
            if let (Some(from), Some(to)) = (from, to) {
                self.set(ids[from.min(to)..=from.max(to)].to_vec());
                return;
            }
        }
        if !command {
            self.set(vec![id.clone()]);
        } else if self.members.remove(id) {
            self.selected.retain(|x| x != id);
        } else {
            self.members.insert(id.clone());
            self.selected.push(id.clone());
        }
        self.anchor = Some(id.clone());
    }

    pub fn select_all(&mut self, ids: &[BookmarkId]) {
        self.set(ids.to_vec());
        self.anchor = ids.first().cloned();
    }

    pub fn clear(&mut self) {
        self.selected.clear();
        self.members.clear();
        self.anchor = None;
    }
}

pub fn query_words(query: &str) -> Vec<String> {
    query
        .to_lowercase()
        .split_whitespace()
        .map(str::to_owned)
        .collect()
}

fn search_text(node: &BookmarkNode) -> String {
    let url = match node {
        BookmarkNode::Url { url, .. } => url.as_str(),
        BookmarkNode::Folder { .. } => "",
    };
    let shown = |field: &str| {
        if field.to_ascii_lowercase().contains("xn--") {
            format!("{field} {}", ardia_state::omnibox::url::display_url(field))
        } else {
            field.to_owned()
        }
    };
    format!("{} {}", shown(node.title()), shown(url)).to_lowercase()
}

pub struct SearchIndex {
    tree: Arc<BookmarkTree>,
    entries: Vec<(BookmarkId, String)>,
}

impl SearchIndex {
    pub fn build(tree: &Arc<BookmarkTree>) -> SearchIndex {
        let mut entries = Vec::new();
        for root in [tree.bar(), tree.other()] {
            let mut stack: Vec<(BookmarkId, usize)> = tree
                .children(root.as_str())
                .iter()
                .rev()
                .map(|c| (c.clone(), 0))
                .collect();
            while let Some((id, depth)) = stack.pop() {
                let Some(node) = tree.get(id.as_str()) else {
                    continue;
                };
                if let BookmarkNode::Folder { children, .. } = node
                    && depth < MAX_BOOKMARK_DEPTH
                {
                    stack.extend(children.iter().rev().map(|c| (c.clone(), depth + 1)));
                }
                entries.push((id, search_text(node)));
            }
        }
        SearchIndex {
            tree: Arc::clone(tree),
            entries,
        }
    }

    pub fn is_for(&self, tree: &Arc<BookmarkTree>) -> bool {
        Arc::ptr_eq(&self.tree, tree)
    }

    pub fn matching(&self, query: &str) -> Vec<BookmarkId> {
        let words = query_words(query);
        self.entries
            .iter()
            .filter(|(_, text)| words.iter().all(|word| text.contains(word.as_str())))
            .map(|(id, _)| id.clone())
            .collect()
    }
}

pub fn matching(tree: &BookmarkTree, query: &str) -> Vec<BookmarkId> {
    let words = query_words(query);
    let mut out = Vec::new();
    for root in [tree.bar(), tree.other()] {
        let mut stack: Vec<(BookmarkId, usize)> = tree
            .children(root.as_str())
            .iter()
            .rev()
            .map(|c| (c.clone(), 0))
            .collect();
        while let Some((id, depth)) = stack.pop() {
            let Some(node) = tree.get(id.as_str()) else {
                continue;
            };
            let text = search_text(node);
            if words.iter().all(|word| text.contains(word.as_str())) {
                out.push(id.clone());
            }
            if let BookmarkNode::Folder { children, .. } = node
                && depth < MAX_BOOKMARK_DEPTH
            {
                stack.extend(children.iter().rev().map(|c| (c.clone(), depth + 1)));
            }
        }
    }
    out
}

pub fn listed(tree: &BookmarkTree, folder: Option<&BookmarkId>, query: &str) -> Vec<BookmarkId> {
    if !query.trim().is_empty() {
        return matching(tree, query);
    }
    folder
        .map(|folder| tree.children(folder.as_str()).to_vec())
        .unwrap_or_default()
}

#[derive(Clone, Debug, PartialEq)]
pub struct FolderRow {
    pub id: BookmarkId,
    pub title: String,
    pub depth: usize,
    pub has_children: bool,
}

pub fn folder_rows(tree: &BookmarkTree, expanded: &HashSet<BookmarkId>) -> Vec<FolderRow> {
    let is_folder =
        |c: &BookmarkId| matches!(tree.get(c.as_str()), Some(BookmarkNode::Folder { .. }));
    let mut out = Vec::new();
    for root in [tree.bar(), tree.other()] {
        let mut stack = vec![(root, 0usize)];
        while let Some((id, depth)) = stack.pop() {
            let Some(BookmarkNode::Folder {
                title, children, ..
            }) = tree.get(id.as_str())
            else {
                continue;
            };
            let has_children = children.iter().any(is_folder);
            if has_children && depth < MAX_BOOKMARK_DEPTH && expanded.contains(&id) {
                stack.extend(
                    children
                        .iter()
                        .rev()
                        .filter(|c| is_folder(c))
                        .map(|c| (c.clone(), depth + 1)),
                );
            }
            out.push(FolderRow {
                id,
                title: title.clone(),
                depth,
                has_children,
            });
        }
    }
    out
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Drop {
    Into(BookmarkId),
    At { parent: BookmarkId, index: usize },
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Target {
    Folder(BookmarkId),
    Row {
        id: BookmarkId,
        index: usize,
        folder: bool,
    },
}

pub fn drop_for(
    target: &Target,
    fraction: f32,
    dragging: &[BookmarkId],
    folder: Option<&BookmarkId>,
    searching: bool,
) -> Option<Drop> {
    let folder = folder?;
    match target {
        Target::Folder(id) => (!dragging.contains(id)).then(|| Drop::Into(id.clone())),
        Target::Row {
            id,
            index,
            folder: is_folder,
        } => {
            if *is_folder && fraction > 0.25 && fraction < 0.75 && !dragging.contains(id) {
                return Some(Drop::Into(id.clone()));
            }
            if searching {
                return None;
            }
            Some(Drop::At {
                parent: folder.clone(),
                index: if fraction < 0.5 { *index } else { index + 1 },
            })
        }
    }
}

pub fn drop_index(ids: &[BookmarkId], moving: &[BookmarkId], index: usize) -> usize {
    let skipped = ids
        .iter()
        .take(index)
        .filter(|id| moving.contains(id))
        .count();
    index - skipped
}

pub fn plural(count: usize, noun: &str) -> String {
    if count == 1 {
        format!("1 {noun}")
    } else {
        format!("{count} {noun}s")
    }
}

pub fn host_label(url: &str) -> String {
    if let Some(origin) = ardia_state::omnibox::url::app_url_origin(url) {
        return origin;
    }
    let host = ardia_state::omnibox::url::host_of(url);
    if host.is_empty() {
        return url.to_owned();
    }
    let shown = ardia_state::omnibox::url::display_host(&host);
    shown.strip_prefix("www.").unwrap_or(&shown).to_owned()
}

#[cfg(test)]
mod tests {
    use super::*;
    use ardia_state::ids::IdGen;

    fn ids(names: &[&str]) -> Vec<BookmarkId> {
        names.iter().map(|n| BookmarkId::new(*n)).collect()
    }

    #[test]
    fn clicks_select_like_the_old_list() {
        let all = ids(&["a", "b", "c", "d"]);
        let mut s = Selection::default();
        s.click(&all, &all[1], false, false);
        assert_eq!(s.selected, ids(&["b"]));
        s.click(&all, &all[3], false, true);
        assert_eq!(s.in_order(&all), ids(&["b", "c", "d"]));
        s.click(&all, &all[2], true, false);
        assert_eq!(s.in_order(&all), ids(&["b", "d"]));
        s.select_all(&all);
        assert_eq!(s.selected.len(), 4);
    }

    #[test]
    fn drops_follow_the_old_rules() {
        let folder = BookmarkId::new("bar");
        let row = Target::Row {
            id: BookmarkId::new("f"),
            index: 3,
            folder: true,
        };
        assert_eq!(
            drop_for(&row, 0.5, &[], Some(&folder), false),
            Some(Drop::Into(BookmarkId::new("f")))
        );
        assert_eq!(
            drop_for(&row, 0.1, &[], Some(&folder), false),
            Some(Drop::At {
                parent: folder.clone(),
                index: 3
            })
        );
        assert_eq!(
            drop_for(&row, 0.9, &[], Some(&folder), false),
            Some(Drop::At {
                parent: folder.clone(),
                index: 4
            })
        );
        assert_eq!(drop_for(&row, 0.1, &[], Some(&folder), true), None);
        assert_eq!(
            drop_for(&row, 0.5, &ids(&["f"]), Some(&folder), false),
            Some(Drop::At {
                parent: folder.clone(),
                index: 4
            })
        );
        let tree = Target::Folder(BookmarkId::new("t"));
        assert_eq!(
            drop_for(&tree, 0.0, &ids(&["t"]), Some(&folder), false),
            None
        );
        assert_eq!(drop_index(&ids(&["a", "b", "c"]), &ids(&["a"]), 2), 1);
    }

    #[test]
    fn search_walks_both_roots_and_tree_rows_follow_expansion() {
        let made = IdGen::with_launch("m");
        let mut tree = BookmarkTree::new("p", 0);
        let bar = tree.bar();
        let folder = tree.add_folder(&made, &bar, None, "Work Stuff", 0).unwrap();
        tree.add_url(&made, &folder, None, "Docs", "https://docs.example/", 0)
            .unwrap();
        tree.add_url(
            &made,
            &tree.other(),
            None,
            "Recipes",
            "https://food.example/",
            0,
        )
        .unwrap();
        assert_eq!(matching(&tree, "work").len(), 1);
        assert_eq!(matching(&tree, "docs example").len(), 1);
        assert_eq!(matching(&tree, "example").len(), 2);
        let shared = Arc::new(tree.clone());
        let index = SearchIndex::build(&shared);
        for query in ["work", "docs example", "example", "zzz"] {
            assert_eq!(index.matching(query), matching(&tree, query));
        }
        let closed = folder_rows(&tree, &HashSet::new());
        assert_eq!(closed.len(), 2);
        assert!(closed[0].has_children);
        let open = folder_rows(&tree, &HashSet::from([bar.clone()]));
        assert_eq!(open[1].title, "Work Stuff");
        assert_eq!(open[1].depth, 1);
        assert_eq!(plural(1, "item"), "1 item");
        assert_eq!(plural(3, "item"), "3 items");
        assert_eq!(host_label("https://www.github.com/x"), "github.com");
    }
}
