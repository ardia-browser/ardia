use std::collections::{HashMap, HashSet};
use std::rc::Rc;

use ardia_import_core::{BookmarkNode as ImportedNode, NodeType};
use ardia_state::bookmarks::{BookmarkNode, BookmarkTree};
use ardia_state::ids::{BookmarkId, IdGen};
use ardia_state::model::Millis;

pub const EDGE_WORK_BUDGET: usize = 200_000;
const CARDINALITY_FIRST: i64 = 1_000_000;
const EXACT_WORK_LIMIT: usize = 4_000_000;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ImportedFolder {
    pub source: String,
    pub engine: String,
    pub wrapper: bool,
    pub adopted: bool,
}

pub type ImportedFolders = HashMap<String, ImportedFolder>;

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct BookmarkMerge {
    pub links: usize,
    pub folders: usize,
    pub skipped: usize,
    pub into_earlier: bool,
    pub made: ImportedFolders,
}

pub struct Placement {
    pub root: BookmarkId,
    pub nodes: Vec<ImportedNode>,
}

pub struct MergeFrom<'a> {
    pub source: &'a str,
    pub engine: &'a str,
    pub made: &'a ImportedFolders,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct FolderEdge {
    pub source: usize,
    pub candidate: usize,
    pub shared: usize,
}

#[derive(Clone, Debug)]
struct Candidate {
    id: BookmarkId,
    earlier: bool,
    needs_evidence: bool,
}

#[derive(Clone)]
enum PlaceKind {
    Nested,
    Root { wrapper: Option<BookmarkId> },
}

#[derive(Clone)]
struct Place {
    id: BookmarkId,
    kind: PlaceKind,
}

fn default_port(scheme: &str) -> Option<&'static str> {
    match scheme {
        "http://" | "ws://" => Some("80"),
        "https://" | "wss://" => Some("443"),
        _ => None,
    }
}

fn canonical_host(scheme: &str, host: &str) -> String {
    let lower = host.to_lowercase();
    let Some(colon) = lower.rfind(':') else {
        return lower;
    };
    let digits = &lower[colon + 1..];
    if !digits.bytes().all(|b| b.is_ascii_digit()) {
        return lower;
    }
    let trimmed = digits.trim_start_matches('0');
    let port = if trimmed.is_empty() && !digits.is_empty() {
        "0"
    } else {
        trimmed
    };
    let name = &lower[..colon];
    if port.is_empty() || Some(port) == default_port(scheme) {
        name.to_owned()
    } else {
        format!("{name}:{port}")
    }
}

pub fn page_key(url: &str) -> String {
    let cleaned: String = url
        .trim()
        .chars()
        .filter(|c| !matches!(c, '\t' | '\n' | '\r'))
        .collect();
    let Some(scheme_end) = cleaned.find("://") else {
        return url.to_owned();
    };
    let scheme = &cleaned[..scheme_end];
    let valid_scheme = scheme
        .chars()
        .next()
        .is_some_and(|c| c.is_ascii_alphabetic())
        && scheme
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '+' | '.' | '-'));
    if !valid_scheme {
        return url.to_owned();
    }
    let after = scheme_end + 3;
    let authority_end = cleaned[after..]
        .find(['/', '?', '#'])
        .map_or(cleaned.len(), |at| after + at);
    let authority = &cleaned[after..authority_end];
    let rest = &cleaned[authority_end..];
    let scheme = format!("{}://", scheme.to_ascii_lowercase());
    let (user, host) = match authority.rfind('@') {
        Some(at) => (&authority[..=at], &authority[at + 1..]),
        None => ("", authority),
    };
    let host = format!("{user}{}", canonical_host(&scheme, host));
    let rest = if rest.starts_with('/') {
        rest.to_owned()
    } else {
        format!("/{rest}")
    };
    let rest = rest.strip_suffix('#').unwrap_or(&rest);
    format!("{scheme}{host}{rest}")
}

pub fn counted_pages(
    pages_of: &[Vec<String>],
    holders: &HashMap<String, Vec<usize>>,
) -> HashSet<String> {
    let mut uses: Vec<(String, usize)> = Vec::new();
    let mut at: HashMap<&str, usize> = HashMap::new();
    for pages in pages_of {
        for page in pages {
            if !holders.contains_key(page) {
                continue;
            }
            match at.get(page.as_str()) {
                Some(index) => uses[*index].1 += 1,
                None => {
                    at.insert(page.as_str(), uses.len());
                    uses.push((page.clone(), 1));
                }
            }
        }
    }
    let mut by_cost: Vec<(String, usize)> = uses
        .into_iter()
        .map(|(page, n)| {
            let cost = n * holders.get(&page).map_or(0, Vec::len);
            (page, cost)
        })
        .collect();
    by_cost.sort_by(|a, z| a.1.cmp(&z.1).then_with(|| a.0.cmp(&z.0)));
    let mut counted = HashSet::new();
    let mut work = 0;
    for (page, cost) in by_cost {
        if work + cost > EDGE_WORK_BUDGET {
            continue;
        }
        work += cost;
        counted.insert(page);
    }
    counted
}

fn best_pairs(rows: &[usize], cols: &[usize], edges: &[FolderEdge]) -> Vec<(usize, usize)> {
    let row_at: HashMap<usize, usize> = rows.iter().enumerate().map(|(i, r)| (*r, i + 1)).collect();
    let col_at: HashMap<usize, usize> = cols
        .iter()
        .enumerate()
        .map(|(i, c)| (*c, rows.len() + i + 1))
        .collect();
    let sink = rows.len() + cols.len() + 1;
    let mut head = vec![usize::MAX; sink + 1];
    let mut to: Vec<usize> = Vec::new();
    let mut cap: Vec<i64> = Vec::new();
    let mut cost: Vec<i64> = Vec::new();
    let mut next: Vec<usize> = Vec::new();
    let mut link = |a: usize, b: usize, c: i64| {
        for (x, y, k, w) in [(a, b, 1, c), (b, a, 0, -c)] {
            to.push(y);
            cap.push(k);
            cost.push(w);
            next.push(head[x]);
            head[x] = to.len() - 1;
        }
    };
    for r in rows {
        link(0, row_at[r], 0);
    }
    for e in edges {
        link(
            row_at[&e.source],
            col_at[&e.candidate],
            -(CARDINALITY_FIRST + e.shared as i64),
        );
    }
    for c in cols {
        link(col_at[c], sink, 0);
    }
    let mut distance = vec![i64::MAX; sink + 1];
    let mut via = vec![usize::MAX; sink + 1];
    let mut queued = vec![false; sink + 1];
    loop {
        distance.fill(i64::MAX);
        via.fill(usize::MAX);
        queued.fill(false);
        distance[0] = 0;
        let mut queue = vec![0usize];
        queued[0] = true;
        let mut at = 0;
        while at < queue.len() {
            let x = queue[at];
            at += 1;
            queued[x] = false;
            let mut e = head[x];
            while e != usize::MAX {
                let y = to[e];
                if cap[e] != 0 && distance[x] != i64::MAX && distance[x] + cost[e] < distance[y] {
                    distance[y] = distance[x] + cost[e];
                    via[y] = e;
                    if !queued[y] {
                        queued[y] = true;
                        queue.push(y);
                    }
                }
                e = next[e];
            }
        }
        if distance[sink] == i64::MAX || distance[sink] >= 0 {
            break;
        }
        let mut y = sink;
        while y != 0 {
            let e = via[y];
            cap[e] -= 1;
            cap[e ^ 1] += 1;
            y = to[e ^ 1];
        }
    }
    let mut out = Vec::new();
    for r in rows {
        let mut e = head[row_at[r]];
        while e != usize::MAX {
            let y = to[e];
            if y > rows.len() && y < sink && cap[e] == 0 && e % 2 == 0 {
                out.push((*r, cols[y - rows.len() - 1]));
            }
            e = next[e];
        }
    }
    out
}

fn greedy_pairs(edges: &[FolderEdge]) -> Vec<(usize, usize)> {
    let mut sorted = edges.to_vec();
    sorted.sort_by(|a, z| {
        z.shared
            .cmp(&a.shared)
            .then(a.source.cmp(&z.source))
            .then(a.candidate.cmp(&z.candidate))
    });
    let mut sources = HashSet::new();
    let mut candidates = HashSet::new();
    let mut out = Vec::new();
    for e in sorted {
        if sources.contains(&e.source) || candidates.contains(&e.candidate) {
            continue;
        }
        sources.insert(e.source);
        candidates.insert(e.candidate);
        out.push((e.source, e.candidate));
    }
    out
}

fn most_pairs(rows: &[usize], cols: &[usize], edges: &[FolderEdge]) -> Vec<(usize, usize)> {
    let row_at: HashMap<usize, usize> = rows.iter().enumerate().map(|(i, r)| (*r, i)).collect();
    let col_at: HashMap<usize, usize> = cols.iter().enumerate().map(|(i, c)| (*c, i)).collect();
    let mut adjacent: Vec<Vec<usize>> = vec![Vec::new(); rows.len()];
    let mut sorted = edges.to_vec();
    sorted.sort_by(|a, z| z.shared.cmp(&a.shared).then(a.candidate.cmp(&z.candidate)));
    for e in &sorted {
        adjacent[row_at[&e.source]].push(col_at[&e.candidate]);
    }
    let mut row_pair = vec![usize::MAX; rows.len()];
    let mut col_pair = vec![usize::MAX; cols.len()];
    for (source, candidate) in greedy_pairs(edges) {
        row_pair[row_at[&source]] = col_at[&candidate];
        col_pair[col_at[&candidate]] = row_at[&source];
    }
    let mut depth = vec![usize::MAX; rows.len()];
    let mut cursor = vec![0usize; rows.len()];
    loop {
        let mut queue: Vec<usize> = Vec::new();
        for r in 0..rows.len() {
            if row_pair[r] == usize::MAX {
                depth[r] = 0;
                queue.push(r);
            } else {
                depth[r] = usize::MAX;
            }
        }
        let mut open = false;
        let mut at = 0;
        while at < queue.len() {
            let r = queue[at];
            at += 1;
            for &c in &adjacent[r] {
                let owner = col_pair[c];
                if owner == usize::MAX {
                    open = true;
                } else if depth[owner] == usize::MAX {
                    depth[owner] = depth[r] + 1;
                    queue.push(owner);
                }
            }
        }
        if !open {
            break;
        }
        cursor.fill(0);
        for start in 0..rows.len() {
            if row_pair[start] != usize::MAX {
                continue;
            }
            let mut stack = vec![start];
            while let Some(&r) = stack.last() {
                let Some(&c) = adjacent[r].get(cursor[r]) else {
                    depth[r] = usize::MAX;
                    stack.pop();
                    continue;
                };
                let owner = col_pair[c];
                if owner == usize::MAX {
                    for &x in &stack {
                        let y = adjacent[x][cursor[x]];
                        row_pair[x] = y;
                        col_pair[y] = x;
                    }
                    break;
                }
                if depth[r] != usize::MAX && depth[owner] == depth[r] + 1 {
                    stack.push(owner);
                } else {
                    cursor[r] += 1;
                }
            }
        }
    }
    row_pair
        .iter()
        .enumerate()
        .filter(|(_, c)| **c != usize::MAX)
        .map(|(r, c)| (rows[r], cols[*c]))
        .collect()
}

pub fn pair_folders(
    source_count: usize,
    candidate_count: usize,
    edges: &[FolderEdge],
    positional: &[bool],
) -> Vec<Option<usize>> {
    let mut parent: Vec<usize> = (0..source_count + candidate_count).collect();
    fn root(parent: &mut [usize], mut x: usize) -> usize {
        while parent[x] != x {
            parent[x] = parent[parent[x]];
            x = parent[x];
        }
        x
    }
    for e in edges {
        let a = root(&mut parent, e.source);
        let b = root(&mut parent, source_count + e.candidate);
        parent[a] = b;
    }
    let mut order: Vec<usize> = Vec::new();
    let mut groups: HashMap<usize, Vec<FolderEdge>> = HashMap::new();
    for e in edges {
        let key = root(&mut parent, e.source);
        groups
            .entry(key)
            .or_insert_with(|| {
                order.push(key);
                Vec::new()
            })
            .push(*e);
    }
    let mut paired: Vec<Option<usize>> = vec![None; source_count];
    for key in order {
        let group = &groups[&key];
        let mut rows: Vec<usize> = group.iter().map(|e| e.source).collect();
        rows.sort_unstable();
        rows.dedup();
        let mut cols: Vec<usize> = group.iter().map(|e| e.candidate).collect();
        cols.sort_unstable();
        cols.dedup();
        let exact = rows.len().min(cols.len()) * (rows.len() + cols.len() + group.len())
            <= EXACT_WORK_LIMIT;
        let pairs = if exact {
            best_pairs(&rows, &cols, group)
        } else {
            most_pairs(&rows, &cols, group)
        };
        for (source, candidate) in pairs {
            paired[source] = Some(candidate);
        }
    }
    let mut taken: HashSet<usize> = paired.iter().flatten().copied().collect();
    let mut next = 0;
    for slot in paired.iter_mut() {
        if slot.is_some() {
            continue;
        }
        while next < candidate_count
            && (taken.contains(&next) || positional.get(next) == Some(&false))
        {
            next += 1;
        }
        if next >= candidate_count {
            break;
        }
        *slot = Some(next);
        taken.insert(next);
    }
    paired
}

fn is_folder(node: &ImportedNode) -> bool {
    node.node_type == NodeType::Folder
}

fn kids(node: &ImportedNode) -> &[ImportedNode] {
    node.children.as_deref().unwrap_or(&[])
}

fn pages_in(nodes: &[ImportedNode], out: &mut Vec<String>) {
    for node in nodes {
        if is_folder(node) {
            pages_in(kids(node), out);
        } else if let Some(url) = node.url.as_deref() {
            out.push(page_key(url));
        }
    }
}

fn link_count(nodes: &[ImportedNode]) -> usize {
    nodes
        .iter()
        .map(|node| {
            if is_folder(node) {
                link_count(kids(node))
            } else {
                1
            }
        })
        .sum()
}

fn bookmarkable(url: &str) -> bool {
    !ardia_state::omnibox::url::is_javascript_url(url)
}

struct Merging<'a> {
    tree: &'a mut BookmarkTree,
    before: BookmarkTree,
    seen: &'a HashSet<String>,
    pages: HashMap<BookmarkId, Rc<HashSet<String>>>,
    from: &'a MergeFrom<'a>,
    ids: &'a IdGen,
    now: Millis,
    out: BookmarkMerge,
}

impl Merging<'_> {
    fn recorded(&self, id: &BookmarkId) -> Option<&ImportedFolder> {
        self.from.made.get(id.as_str())
    }

    fn own_folder(&self, id: &BookmarkId) -> Option<Candidate> {
        let folder = self.recorded(id)?;
        (folder.source == self.from.source && !folder.wrapper).then(|| Candidate {
            id: id.clone(),
            earlier: !folder.adopted,
            needs_evidence: false,
        })
    }

    fn candidate(&self, kind: &PlaceKind, id: &BookmarkId) -> Option<Candidate> {
        match kind {
            PlaceKind::Nested => {
                if self.recorded(id).is_some() {
                    self.own_folder(id)
                } else {
                    Some(Candidate {
                        id: id.clone(),
                        earlier: false,
                        needs_evidence: false,
                    })
                }
            }
            PlaceKind::Root { wrapper } => {
                if wrapper.as_ref() == Some(id) {
                    None
                } else if self.recorded(id).is_some() {
                    self.own_folder(id)
                } else {
                    Some(Candidate {
                        id: id.clone(),
                        earlier: false,
                        needs_evidence: true,
                    })
                }
            }
        }
    }

    fn record(&mut self, id: &BookmarkId, wrapper: bool, adopted: bool) {
        self.out.made.insert(
            id.to_string(),
            ImportedFolder {
                source: self.from.source.to_owned(),
                engine: self.from.engine.to_owned(),
                wrapper,
                adopted,
            },
        );
    }

    fn pages_under(&mut self, id: &BookmarkId) -> Rc<HashSet<String>> {
        if let Some(known) = self.pages.get(id) {
            return Rc::clone(known);
        }
        let mut out = HashSet::new();
        let mut stack = vec![id.clone()];
        let mut visited = HashSet::new();
        while let Some(at) = stack.pop() {
            if !visited.insert(at.clone()) {
                continue;
            }
            match self.before.get(at.as_str()) {
                Some(BookmarkNode::Url { url, .. }) => {
                    out.insert(page_key(url));
                }
                Some(BookmarkNode::Folder { children, .. }) => {
                    stack.extend(children.iter().cloned());
                }
                None => {}
            }
        }
        let out = Rc::new(out);
        self.pages.insert(id.clone(), Rc::clone(&out));
        out
    }

    fn child_folders(&self, place: &Place) -> Vec<Candidate> {
        self.before
            .children(place.id.as_str())
            .iter()
            .filter(|id| {
                matches!(
                    self.before.get(id.as_str()),
                    Some(BookmarkNode::Folder { .. })
                )
            })
            .filter_map(|id| self.candidate(&place.kind, id))
            .collect()
    }

    fn unseen(&self, nodes: &[ImportedNode]) -> Vec<ImportedNode> {
        nodes
            .iter()
            .filter_map(|node| {
                if !is_folder(node) {
                    let url = node.url.as_deref()?;
                    if !bookmarkable(url) || self.seen.contains(&page_key(url)) {
                        return None;
                    }
                    return Some(node.clone());
                }
                let children = self.unseen(kids(node));
                (!children.is_empty() || kids(node).is_empty()).then(|| ImportedNode {
                    children: Some(children),
                    ..node.clone()
                })
            })
            .collect()
    }

    fn build(&mut self, node: &ImportedNode, parent: &BookmarkId) -> Option<BookmarkId> {
        let added = node
            .date_added
            .filter(|at| at.is_finite())
            .map_or(self.now, |at| at as Millis);
        if is_folder(node) {
            let id = self
                .tree
                .add_folder(self.ids, parent, None, &node.title, added)
                .ok()?;
            self.out.folders += 1;
            self.record(&id, false, false);
            for child in kids(node) {
                self.build(child, &id);
            }
            Some(id)
        } else {
            let url = node.url.as_deref().filter(|url| bookmarkable(url))?;
            let title = if node.title.is_empty() {
                url
            } else {
                &node.title
            };
            let id = self
                .tree
                .add_url(self.ids, parent, None, title, url, added)
                .ok()?;
            self.out.links += 1;
            Some(id)
        }
    }

    fn append(
        &mut self,
        parent: &BookmarkId,
        nodes: &[ImportedNode],
        earlier: bool,
    ) -> Vec<BookmarkId> {
        if nodes.is_empty()
            || !matches!(
                self.tree.get(parent.as_str()),
                Some(BookmarkNode::Folder { .. })
            )
        {
            return Vec::new();
        }
        let ids: Vec<BookmarkId> = nodes
            .iter()
            .filter_map(|node| self.build(node, parent))
            .collect();
        if earlier {
            self.out.into_earlier = true;
        }
        ids
    }

    fn match_folders(
        &mut self,
        folders: &[usize],
        nodes: &[ImportedNode],
        places: &[Place],
    ) -> HashMap<usize, Candidate> {
        let mut titles: Vec<String> = Vec::new();
        let mut groups: HashMap<String, (Vec<usize>, Vec<Candidate>)> = HashMap::new();
        for &index in folders {
            let title = nodes[index].title.clone();
            groups
                .entry(title.clone())
                .or_insert_with(|| {
                    titles.push(title);
                    (Vec::new(), Vec::new())
                })
                .0
                .push(index);
        }
        for place in places {
            for candidate in self.child_folders(place) {
                let title = self
                    .before
                    .get(candidate.id.as_str())
                    .map(|node| node.title().to_owned())
                    .unwrap_or_default();
                if let Some(group) = groups.get_mut(&title) {
                    group.1.push(candidate);
                }
            }
        }
        let mut matched = HashMap::new();
        for title in titles {
            let Some((sources, candidates)) = groups.remove(&title) else {
                continue;
            };
            if candidates.is_empty() {
                continue;
            }
            let mut holders: HashMap<String, Vec<usize>> = HashMap::new();
            let mut sizes = Vec::with_capacity(candidates.len());
            for (i, candidate) in candidates.iter().enumerate() {
                let pages = self.pages_under(&candidate.id);
                sizes.push(pages.len());
                for page in pages.iter() {
                    holders.entry(page.clone()).or_default().push(i);
                }
            }
            let pages_of: Vec<Vec<String>> = sources
                .iter()
                .map(|&index| {
                    let mut pages = Vec::new();
                    pages_in(kids(&nodes[index]), &mut pages);
                    let mut seen = HashSet::new();
                    pages.retain(|page| seen.insert(page.clone()));
                    pages
                })
                .collect();
            let counted = counted_pages(&pages_of, &holders);
            let mut edges: Vec<FolderEdge> = Vec::new();
            for (s, pages) in pages_of.iter().enumerate() {
                let mut shared: Vec<(usize, usize)> = Vec::new();
                for page in pages {
                    if !counted.contains(page) {
                        continue;
                    }
                    for &c in holders.get(page).map_or(&[][..], Vec::as_slice) {
                        match shared.iter_mut().find(|(known, _)| *known == c) {
                            Some(entry) => entry.1 += 1,
                            None => shared.push((c, 1)),
                        }
                    }
                }
                for (candidate, count) in shared {
                    if candidates[candidate].needs_evidence && count * 2 <= sizes[candidate] {
                        continue;
                    }
                    edges.push(FolderEdge {
                        source: s,
                        candidate,
                        shared: count,
                    });
                }
            }
            let positional: Vec<bool> = candidates.iter().map(|c| !c.needs_evidence).collect();
            for (s, paired) in pair_folders(sources.len(), candidates.len(), &edges, &positional)
                .into_iter()
                .enumerate()
            {
                if let Some(c) = paired {
                    matched.insert(sources[s], candidates[c].clone());
                }
            }
        }
        matched
    }

    fn merge_level(&mut self, nodes: &[ImportedNode], places: &[Place]) -> Vec<ImportedNode> {
        let folders: Vec<usize> = (0..nodes.len()).filter(|&i| is_folder(&nodes[i])).collect();
        let matched = self.match_folders(&folders, nodes, places);
        let mut fresh = Vec::new();
        for (index, node) in nodes.iter().enumerate() {
            let Some(folder) = matched.get(&index).cloned() else {
                fresh.extend(self.unseen(std::slice::from_ref(node)));
                continue;
            };
            let before = self.out.links + self.out.folders;
            let inner = self.merge_level(
                kids(node),
                &[Place {
                    id: folder.id.clone(),
                    kind: PlaceKind::Nested,
                }],
            );
            self.append(&folder.id, &inner, folder.earlier);
            if folder.needs_evidence && self.out.links + self.out.folders > before {
                self.record(&folder.id, false, true);
            }
        }
        fresh
    }
}

pub fn merge_imported_bookmarks(
    tree: &mut BookmarkTree,
    ids: &IdGen,
    seen: &HashSet<String>,
    placements: &[Placement],
    from: &MergeFrom<'_>,
    now: Millis,
) -> BookmarkMerge {
    let before = tree.clone();
    let mut m = Merging {
        tree,
        before,
        seen,
        pages: HashMap::new(),
        from,
        ids,
        now,
        out: BookmarkMerge::default(),
    };
    let wrapper_title = format!("Imported from {}", from.source);
    for placement in placements {
        let root = placement.root.clone();
        let incoming = &placement.nodes;
        let root_children: Vec<BookmarkId> = match m.before.get(root.as_str()) {
            Some(BookmarkNode::Folder { children, .. }) => children.clone(),
            _ => continue,
        };
        if incoming.is_empty() {
            continue;
        }
        if root_children.is_empty() {
            let fresh = m.unseen(incoming);
            m.append(&root, &fresh, false);
            continue;
        }
        let folders: Vec<BookmarkId> = root_children
            .into_iter()
            .filter(|id| matches!(m.before.get(id.as_str()), Some(BookmarkNode::Folder { .. })))
            .collect();
        let own_wrapper = folders
            .iter()
            .find(|id| {
                m.recorded(id)
                    .is_some_and(|f| f.source == from.source && f.wrapper)
            })
            .cloned();
        let adopted = if own_wrapper.is_some() {
            None
        } else {
            folders
                .iter()
                .find(|id| {
                    m.recorded(id).is_none()
                        && m.before.get(id.as_str()).map(BookmarkNode::title)
                            == Some(wrapper_title.as_str())
                })
                .cloned()
        };
        let wrapper = own_wrapper.clone().or_else(|| adopted.clone());
        if let Some(adopted) = &adopted {
            m.record(adopted, true, true);
        }
        let made_by_import = own_wrapper
            .as_ref()
            .and_then(|id| m.recorded(id))
            .is_some_and(|f| !f.adopted);
        let mut places = Vec::new();
        if let Some(wrapper) = &wrapper {
            places.push(Place {
                id: wrapper.clone(),
                kind: PlaceKind::Nested,
            });
        }
        places.push(Place {
            id: root.clone(),
            kind: PlaceKind::Root {
                wrapper: wrapper.clone(),
            },
        });
        let fresh = m.merge_level(incoming, &places);
        if fresh.is_empty() {
            continue;
        }
        match &wrapper {
            Some(wrapper) => {
                m.append(wrapper, &fresh, made_by_import);
            }
            None => {
                let holder = ImportedNode::folder(wrapper_title.clone(), fresh, None);
                for id in m.append(&root, std::slice::from_ref(&holder), false) {
                    m.record(&id, true, false);
                }
            }
        }
    }
    let total: usize = placements.iter().map(|p| link_count(&p.nodes)).sum();
    m.out.skipped = total.saturating_sub(m.out.links);
    m.out
}

pub fn placements_of(root: &ImportedNode, tree: &BookmarkTree) -> Vec<Placement> {
    let role = |node: &ImportedNode| node.role.as_deref().unwrap_or_default().to_owned();
    let toolbar: Vec<ImportedNode> = kids(root)
        .iter()
        .filter(|child| role(child) == "toolbar")
        .flat_map(|child| kids(child).iter().cloned())
        .collect();
    let other: Vec<ImportedNode> = kids(root)
        .iter()
        .filter(|child| role(child) != "toolbar")
        .flat_map(|child| {
            if is_folder(child) && matches!(role(child).as_str(), "other" | "list") {
                kids(child).to_vec()
            } else {
                vec![child.clone()]
            }
        })
        .collect();
    vec![
        Placement {
            root: tree.bar(),
            nodes: toolbar,
        },
        Placement {
            root: tree.other(),
            nodes: other,
        },
    ]
}

pub fn import_into_tree(
    tree: &mut BookmarkTree,
    ids: &IdGen,
    made: &mut ImportedFolders,
    root: &ImportedNode,
    source: &str,
    now: Millis,
) -> BookmarkMerge {
    if kids(root).is_empty() {
        return BookmarkMerge::default();
    }
    let engine = tree.engine_profile.clone();
    let seen = bookmarked_pages(tree);
    let placements = placements_of(root, tree);
    let merged = {
        let from = MergeFrom {
            source,
            engine: &engine,
            made,
        };
        merge_imported_bookmarks(tree, ids, &seen, &placements, &from, now)
    };
    made.retain(|id, folder| folder.engine != engine || tree.get(id).is_some());
    made.extend(merged.made.clone());
    merged
}

pub fn bookmarked_pages(tree: &BookmarkTree) -> HashSet<String> {
    let mut out = HashSet::new();
    let mut stack = vec![tree.bar(), tree.other()];
    let mut visited = HashSet::new();
    while let Some(at) = stack.pop() {
        if !visited.insert(at.clone()) {
            continue;
        }
        match tree.get(at.as_str()) {
            Some(BookmarkNode::Url { url, .. }) => {
                out.insert(page_key(url));
            }
            Some(BookmarkNode::Folder { children, .. }) => stack.extend(children.iter().cloned()),
            None => {}
        }
    }
    out
}

#[cfg(test)]
mod tests;
