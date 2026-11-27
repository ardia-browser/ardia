use std::collections::{HashMap, HashSet};
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::groups::{self, TabGroup};
use crate::ids::{GroupId, ProfileId, TabId, WindowId};
use crate::model::{Millis, TabPage};
use crate::state::BrowserState;
use crate::tabs::Tab;

pub const LINK_EXTENSION: &str = ".webloc";
pub const MANIFEST: &str = ".ardia-folder.json";
pub const MANIFEST_VERSION: u64 = 1;
pub const MAX_NAME_BYTES: usize = 200;
pub const EMPTY_FOLDER_URL: &str = "about:blank";
pub const EMPTY_FOLDER_TITLE: &str = "Empty Folder";

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum BaseEntry {
    Link {
        key: String,
        file: String,
        name: String,
        url: String,
        #[serde(default)]
        id: Option<String>,
    },
    Dir {
        key: String,
        file: String,
        name: String,
        children: Vec<BaseEntry>,
    },
}

impl BaseEntry {
    pub fn key(&self) -> &str {
        match self {
            BaseEntry::Link { key, .. } | BaseEntry::Dir { key, .. } => key,
        }
    }

    pub fn file(&self) -> &str {
        match self {
            BaseEntry::Link { file, .. } | BaseEntry::Dir { file, .. } => file,
        }
    }

    pub fn is_link(&self) -> bool {
        matches!(self, BaseEntry::Link { .. })
    }
}

pub fn clean_base(list: &[Value]) -> Vec<BaseEntry> {
    let text = |v: Option<&Value>| {
        v.and_then(Value::as_str)
            .filter(|s| !s.is_empty())
            .map(str::to_owned)
    };
    list.iter()
        .filter_map(|e| {
            let key = text(e.get("key"))?;
            let file = text(e.get("file"))?;
            let name = e.get("name")?.as_str()?.to_owned();
            match e.get("kind").and_then(Value::as_str) {
                Some("dir") => Some(BaseEntry::Dir {
                    key,
                    file,
                    name,
                    children: clean_base(
                        e.get("children")
                            .and_then(Value::as_array)
                            .map_or(&[][..], Vec::as_slice),
                    ),
                }),
                Some("link") => Some(BaseEntry::Link {
                    key,
                    file,
                    name,
                    url: text(e.get("url"))?,
                    id: text(e.get("id")),
                }),
                _ => None,
            }
        })
        .collect()
}

#[derive(Clone, Debug, PartialEq)]
pub enum LocalEntry {
    Link {
        key: String,
        name: String,
        url: String,
    },
    Dir {
        key: String,
        name: String,
        children: Vec<LocalEntry>,
    },
}

impl LocalEntry {
    fn key(&self) -> &str {
        match self {
            LocalEntry::Link { key, .. } | LocalEntry::Dir { key, .. } => key,
        }
    }

    fn name(&self) -> &str {
        match self {
            LocalEntry::Link { name, .. } | LocalEntry::Dir { name, .. } => name,
        }
    }

    pub fn signature(entries: &[LocalEntry]) -> String {
        fn value(e: &LocalEntry) -> Value {
            match e {
                LocalEntry::Link { key, name, url } => {
                    json!({"kind": "link", "key": key, "name": name, "url": url})
                }
                LocalEntry::Dir {
                    key,
                    name,
                    children,
                } => {
                    json!({"kind": "dir", "key": key, "name": name, "children": children.iter().map(value).collect::<Vec<_>>()})
                }
            }
        }
        Value::Array(entries.iter().map(value).collect()).to_string()
    }
}

#[derive(Clone, Debug, PartialEq)]
pub enum RemoteEntry {
    Link {
        file: String,
        url: String,
        id: Option<String>,
    },
    Held {
        file: String,
        waiting: bool,
    },
    Dir {
        file: String,
        level: RemoteLevel,
    },
}

impl RemoteEntry {
    pub fn file(&self) -> &str {
        match self {
            RemoteEntry::Link { file, .. }
            | RemoteEntry::Held { file, .. }
            | RemoteEntry::Dir { file, .. } => file,
        }
    }
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct RemoteLevel {
    pub entries: Vec<RemoteEntry>,
    pub manifest: Option<Vec<String>>,
    pub manifest_pending: bool,
}

#[derive(Clone, Debug, PartialEq)]
pub enum Dropped {
    Link { file: String, url: String },
    Dir { file: String, known: Vec<BaseEntry> },
}

impl Dropped {
    fn file(&self) -> &str {
        match self {
            Dropped::Link { file, .. } | Dropped::Dir { file, .. } => file,
        }
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct TargetLink {
    pub key: Option<String>,
    pub file: Option<String>,
    pub name: String,
    pub url: String,
    pub renamed: bool,
    pub write: bool,
    pub expect: Option<String>,
    pub id: Option<String>,
    pub file_id: Option<String>,
    pub held_name: Option<String>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct TargetDir {
    pub key: Option<String>,
    pub file: Option<String>,
    pub name: String,
    pub renamed: bool,
    pub level: TargetLevel,
}

#[derive(Clone, Debug, PartialEq)]
pub enum TargetEntry {
    Link(TargetLink),
    Dir(TargetDir),
}

impl TargetEntry {
    pub fn key(&self) -> Option<&str> {
        match self {
            TargetEntry::Link(l) => l.key.as_deref(),
            TargetEntry::Dir(d) => d.key.as_deref(),
        }
    }

    fn file(&self) -> Option<&str> {
        match self {
            TargetEntry::Link(l) => l.file.as_deref(),
            TargetEntry::Dir(d) => d.file.as_deref(),
        }
    }

    fn is_link(&self) -> bool {
        matches!(self, TargetEntry::Link(_))
    }
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct TargetLevel {
    pub entries: Vec<TargetEntry>,
    pub dropped: Vec<Dropped>,
    pub remote: Option<RemoteLevel>,
}

fn is_link_file(file: &str) -> bool {
    file.to_lowercase().ends_with(LINK_EXTENSION)
}

pub fn name_of_file(file: &str, link: bool) -> String {
    if link && is_link_file(file) {
        file[..file.len() - LINK_EXTENSION.len()].to_owned()
    } else {
        file.to_owned()
    }
}

fn cap_bytes(text: &str, limit: usize) -> String {
    let mut used = 0;
    let mut out = String::new();
    for c in text.chars() {
        used += c.len_utf8();
        if used > limit {
            break;
        }
        out.push(c);
    }
    out
}

pub fn clean_name(name: &str, fallback: &str) -> String {
    let replaced: String = name
        .chars()
        .map(|c| if c == '/' || c == ':' { '-' } else { c })
        .collect();
    let collapsed = replaced.split_whitespace().collect::<Vec<_>>().join(" ");
    let cleaned = collapsed.trim_start_matches('.').trim().to_owned();
    let base = if cleaned.is_empty() {
        fallback.to_owned()
    } else {
        cleaned
    };
    let capped = cap_bytes(&base, MAX_NAME_BYTES).trim().to_owned();
    if capped.is_empty() {
        fallback.to_owned()
    } else {
        capped
    }
}

pub fn file_name_for(name: &str, link: bool) -> String {
    if link {
        format!("{}{LINK_EXTENSION}", clean_name(name, "Link"))
    } else {
        clean_name(name, "Folder")
    }
}

pub fn unique_file_name(name: &str, link: bool, taken: &mut HashSet<String>) -> String {
    let first = file_name_for(name, link);
    let stem = name_of_file(&first, link);
    let mut file = first;
    let mut n = 2;
    while taken.contains(&file.to_lowercase()) {
        file = if link {
            format!("{stem} {n}{LINK_EXTENSION}")
        } else {
            format!("{stem} {n}")
        };
        n += 1;
    }
    taken.insert(file.to_lowercase());
    file
}

pub fn manifest_text(order: &[String]) -> String {
    format!("{}\n", json!({"version": MANIFEST_VERSION, "order": order}))
}

pub fn manifest_is_newer(text: Option<&str>) -> bool {
    text.and_then(|t| serde_json::from_str::<Value>(t).ok())
        .and_then(|v| v.get("version").and_then(Value::as_f64))
        .is_some_and(|v| v > MANIFEST_VERSION as f64)
}

pub fn parse_manifest(text: Option<&str>) -> Option<Vec<String>> {
    let doc: Value = serde_json::from_str(text?).ok()?;
    if doc.get("version").and_then(Value::as_f64) != Some(MANIFEST_VERSION as f64) {
        return None;
    }
    Some(
        doc.get("order")?
            .as_array()?
            .iter()
            .filter_map(|f| f.as_str().map(str::to_owned))
            .collect(),
    )
}

fn numeric_compare(a: &str, b: &str) -> std::cmp::Ordering {
    let lower = |s: &str| s.to_lowercase();
    let (a, b) = (lower(a), lower(b));
    let mut x = a.chars().peekable();
    let mut y = b.chars().peekable();
    loop {
        match (x.peek().copied(), y.peek().copied()) {
            (None, None) => return std::cmp::Ordering::Equal,
            (None, Some(_)) => return std::cmp::Ordering::Less,
            (Some(_), None) => return std::cmp::Ordering::Greater,
            (Some(c), Some(d)) if c.is_ascii_digit() && d.is_ascii_digit() => {
                let mut m = String::new();
                while let Some(c) = x.peek().copied().filter(char::is_ascii_digit) {
                    m.push(c);
                    x.next();
                }
                let mut n = String::new();
                while let Some(d) = y.peek().copied().filter(char::is_ascii_digit) {
                    n.push(d);
                    y.next();
                }
                let (m, n) = (m.trim_start_matches('0'), n.trim_start_matches('0'));
                let order = m.len().cmp(&n.len()).then_with(|| m.cmp(n));
                if order != std::cmp::Ordering::Equal {
                    return order;
                }
            }
            (Some(c), Some(d)) => {
                if c != d {
                    return c.cmp(&d);
                }
                x.next();
                y.next();
            }
        }
    }
}

pub fn remote_order(level: &RemoteLevel) -> (Vec<String>, Vec<String>) {
    let present: HashSet<&str> = level.entries.iter().map(RemoteEntry::file).collect();
    let mut listed: Vec<String> = Vec::new();
    for f in level.manifest.iter().flatten() {
        if present.contains(f.as_str()) && !listed.contains(f) {
            listed.push(f.clone());
        }
    }
    let in_list: HashSet<&String> = listed.iter().collect();
    let mut rest: Vec<String> = level
        .entries
        .iter()
        .map(|e| e.file().to_owned())
        .filter(|f| !in_list.contains(f))
        .collect();
    rest.sort_by(|a, b| numeric_compare(a, b));
    (listed, rest)
}

pub fn weave<T: Clone + PartialEq>(primary: &[T], other: &[T]) -> Vec<T> {
    let mut out: Vec<T> = primary.to_vec();
    for (i, x) in other.iter().enumerate() {
        if out.contains(x) {
            continue;
        }
        let mut j = i as isize - 1;
        while j >= 0 && !out.contains(&other[j as usize]) {
            j -= 1;
        }
        let at = if j < 0 {
            0
        } else {
            out.iter()
                .position(|e| *e == other[j as usize])
                .map_or(out.len(), |p| p + 1)
        };
        out.insert(at, x.clone());
    }
    out
}

type Path = Vec<usize>;

fn remote_at<'a>(root: &'a RemoteLevel, path: &[usize]) -> Option<&'a RemoteLevel> {
    let mut level = root;
    for i in path {
        match level.entries.get(*i)? {
            RemoteEntry::Dir { level: inner, .. } => level = inner,
            _ => return None,
        }
    }
    Some(level)
}

#[derive(Clone, Debug, PartialEq, Eq, Hash)]
struct RemoteRef {
    level: Path,
    index: usize,
}

fn links_in(level: &RemoteLevel, at: &Path, out: &mut Vec<RemoteRef>) {
    for (i, e) in level.entries.iter().enumerate() {
        match e {
            RemoteEntry::Link { .. } => out.push(RemoteRef {
                level: at.clone(),
                index: i,
            }),
            RemoteEntry::Dir { level: inner, .. } => {
                let mut next = at.clone();
                next.push(i);
                links_in(inner, &next, out);
            }
            RemoteEntry::Held { .. } => {}
        }
    }
}

fn base_link_ids(base: &[BaseEntry], out: &mut HashSet<String>) {
    for b in base {
        match b {
            BaseEntry::Link { id: Some(id), .. } => {
                out.insert(id.clone());
            }
            BaseEntry::Dir { children, .. } => base_link_ids(children, out),
            BaseEntry::Link { .. } => {}
        }
    }
}

#[derive(Default)]
struct Ctx {
    dirs: HashMap<String, Path>,
    owner_of: HashMap<String, RemoteRef>,
    base_owner: HashMap<String, String>,
    moved: HashSet<String>,
    arriving: HashMap<RemoteRef, BaseEntry>,
    arriving_keys: HashSet<String>,
    local_links: HashMap<String, LocalEntry>,
    waiting: u32,
}

fn link_of<'a>(
    root: &'a RemoteLevel,
    r: &RemoteRef,
) -> Option<(&'a str, &'a str, Option<&'a str>)> {
    match remote_at(root, &r.level)?.entries.get(r.index)? {
        RemoteEntry::Link { file, url, id } => Some((file, url, id.as_deref())),
        _ => None,
    }
}

fn map_dirs(
    base: &[BaseEntry],
    remote: Option<&Path>,
    root: &RemoteLevel,
    dirs: &mut HashMap<String, Path>,
    levels: &mut Vec<(Vec<BaseEntry>, Option<Path>)>,
) {
    levels.push((base.to_vec(), remote.cloned()));
    let level = remote.and_then(|p| remote_at(root, p));
    let offered: Vec<(Path, &RemoteLevel, &str)> = level
        .map(|l| {
            l.entries
                .iter()
                .enumerate()
                .filter_map(|(i, e)| match e {
                    RemoteEntry::Dir {
                        file, level: inner, ..
                    } => {
                        let mut p = remote.cloned().unwrap_or_default();
                        p.push(i);
                        Some((p, inner, file.as_str()))
                    }
                    _ => None,
                })
                .collect()
        })
        .unwrap_or_default();
    let mut used: HashSet<Path> = HashSet::new();
    let wanted: Vec<&BaseEntry> = base.iter().filter(|b| !b.is_link()).collect();
    let remote_ids = |inner: &RemoteLevel| {
        let mut refs = Vec::new();
        links_in(inner, &Vec::new(), &mut refs);
        refs.iter()
            .filter_map(|r| link_of(inner, r).and_then(|(_, _, id)| id.map(str::to_owned)))
            .collect::<HashSet<String>>()
    };
    for b in &wanted {
        let BaseEntry::Dir {
            key,
            file,
            children,
            ..
        } = b
        else {
            continue;
        };
        let mut ids = HashSet::new();
        base_link_ids(children, &mut ids);
        let mut best: Option<Path> = None;
        let mut score = 0;
        for (p, inner, f) in &offered {
            let s = if used.contains(p) {
                0
            } else {
                ids.intersection(&remote_ids(inner)).count()
            };
            if s > score || (s > 0 && s == score && *f == file.as_str()) {
                best = Some(p.clone());
                score = s;
            }
        }
        if let Some(p) = best {
            used.insert(p.clone());
            dirs.insert(key.clone(), p);
        }
    }
    for b in &wanted {
        if dirs.contains_key(b.key()) {
            continue;
        }
        if let Some((p, _, _)) = offered
            .iter()
            .find(|(p, _, f)| !used.contains(p) && *f == b.file())
        {
            used.insert(p.clone());
            dirs.insert(b.key().to_owned(), p.clone());
        }
    }
    for b in &wanted {
        if dirs.contains_key(b.key()) {
            continue;
        }
        let BaseEntry::Dir { children, .. } = b else {
            continue;
        };
        if let Some((p, _, _)) = offered.iter().find(|(p, inner, _)| {
            !used.contains(p)
                && children
                    .iter()
                    .any(|c| inner.entries.iter().any(|x| x.file() == c.file()))
        }) {
            used.insert(p.clone());
            dirs.insert(b.key().to_owned(), p.clone());
        }
    }
    for b in wanted {
        if let BaseEntry::Dir { key, children, .. } = b {
            let inner = dirs.get(key).cloned();
            map_dirs(children, inner.as_ref(), root, dirs, levels);
        }
    }
}

fn collect_local(local: &[LocalEntry], into: &mut HashMap<String, LocalEntry>) {
    for l in local {
        match l {
            LocalEntry::Link { key, .. } => {
                into.insert(key.clone(), l.clone());
            }
            LocalEntry::Dir { children, .. } => collect_local(children, into),
        }
    }
}

fn identities(base: &[BaseEntry], local: &[LocalEntry], remote: &RemoteLevel) -> Ctx {
    let mut ctx = Ctx::default();
    let mut levels = Vec::new();
    map_dirs(base, Some(&Vec::new()), remote, &mut ctx.dirs, &mut levels);
    let mut all = Vec::new();
    links_in(remote, &Vec::new(), &mut all);
    let preferred = |name: &str, file: &str, candidates: &[RemoteRef]| -> Option<RemoteRef> {
        candidates
            .iter()
            .find(|r| link_of(remote, r).is_some_and(|(f, _, _)| f == file))
            .or_else(|| {
                candidates.iter().find(|r| {
                    link_of(remote, r).is_some_and(|(f, _, _)| name_of_file(f, true) == name)
                })
            })
            .or(candidates.first())
            .cloned()
    };
    for (entries, level) in &levels {
        for b in entries {
            let BaseEntry::Link {
                key,
                file,
                name,
                id: Some(id),
                ..
            } = b
            else {
                continue;
            };
            if ctx.base_owner.contains_key(id) {
                continue;
            }
            let everywhere: Vec<RemoteRef> = all
                .iter()
                .filter(|r| link_of(remote, r).is_some_and(|(_, _, i)| i == Some(id.as_str())))
                .cloned()
                .collect();
            let here: Vec<RemoteRef> = everywhere
                .iter()
                .filter(|r| Some(&r.level) == level.as_ref())
                .cloned()
                .collect();
            let by_file = |list: &[RemoteRef]| {
                list.iter()
                    .find(|r| link_of(remote, r).is_some_and(|(f, _, _)| f == file))
                    .cloned()
            };
            let Some(r) = by_file(&here)
                .or_else(|| by_file(&everywhere))
                .or_else(|| preferred(name, file, &here))
                .or_else(|| preferred(name, file, &everywhere))
            else {
                continue;
            };
            ctx.owner_of.insert(id.clone(), r.clone());
            ctx.base_owner.insert(id.clone(), key.clone());
            if Some(&r.level) != level.as_ref() {
                ctx.moved.insert(key.clone());
                ctx.arriving.insert(r, b.clone());
                ctx.arriving_keys.insert(key.clone());
            }
        }
    }
    for r in &all {
        if let Some((_, _, Some(id))) = link_of(remote, r)
            && !ctx.owner_of.contains_key(id)
        {
            ctx.owner_of.insert(id.to_owned(), r.clone());
        }
    }
    collect_local(local, &mut ctx.local_links);
    ctx
}

pub struct Merged {
    pub level: TargetLevel,
    pub waiting: u32,
}

pub fn merge_folder(base: &[BaseEntry], local: &[LocalEntry], remote: &RemoteLevel) -> Merged {
    let mut ctx = identities(base, local, remote);
    let level = merge_level(base, local, Some(&Vec::new()), remote, &mut ctx);
    Merged {
        level,
        waiting: ctx.waiting,
    }
}

fn holds_arrival(root: &RemoteLevel, at: &Path, ctx: &Ctx) -> bool {
    let Some(level) = remote_at(root, at) else {
        return false;
    };
    level.entries.iter().enumerate().any(|(i, e)| match e {
        RemoteEntry::Link { .. } => ctx.arriving.contains_key(&RemoteRef {
            level: at.clone(),
            index: i,
        }),
        RemoteEntry::Dir { .. } => {
            let mut p = at.clone();
            p.push(i);
            holds_arrival(root, &p, ctx)
        }
        RemoteEntry::Held { .. } => false,
    })
}

fn merge_level(
    base: &[BaseEntry],
    local: &[LocalEntry],
    at: Option<&Path>,
    root: &RemoteLevel,
    ctx: &mut Ctx,
) -> TargetLevel {
    let level = at
        .and_then(|p| remote_at(root, p))
        .cloned()
        .unwrap_or_default();
    let here_path = at.cloned();
    let local_by_key: HashMap<&str, &LocalEntry> = local.iter().map(|l| (l.key(), l)).collect();
    let base_keys: HashSet<&str> = base.iter().map(BaseEntry::key).collect();
    let staying: Vec<&BaseEntry> = base
        .iter()
        .filter(|b| !b.is_link() || !ctx.moved.contains(b.key()))
        .collect();
    let ref_at = |i: usize| RemoteRef {
        level: here_path.clone().unwrap_or_default(),
        index: i,
    };
    let dir_path = |i: usize| {
        let mut p = here_path.clone().unwrap_or_default();
        p.push(i);
        p
    };
    let arrivals: Vec<usize> = if here_path.is_some() {
        (0..level.entries.len())
            .filter(|i| {
                matches!(level.entries[*i], RemoteEntry::Link { .. })
                    && ctx.arriving.contains_key(&ref_at(*i))
            })
            .collect()
    } else {
        Vec::new()
    };
    let open: Vec<usize> = (0..level.entries.len())
        .filter(|i| !arrivals.contains(i))
        .collect();
    let owned = |ctx: &Ctx, i: usize| -> Option<String> {
        here_path.as_ref()?;
        match &level.entries[i] {
            RemoteEntry::Link { id: Some(id), .. } if ctx.owner_of.get(id) == Some(&ref_at(i)) => {
                Some(id.clone())
            }
            _ => None,
        }
    };
    let foreign = |ctx: &Ctx, b: &BaseEntry, i: usize| {
        owned(ctx, i).is_some_and(|id| ctx.base_owner.get(&id).is_some_and(|k| k != b.key()))
    };
    let same_thing = |b: &BaseEntry, r: &RemoteEntry| match (b, r) {
        (BaseEntry::Link { url, .. }, RemoteEntry::Link { url: u, .. }) => u == url,
        (BaseEntry::Dir { children, .. }, RemoteEntry::Dir { level: inner, .. }) => children
            .iter()
            .any(|c| inner.entries.iter().any(|x| x.file() == c.file())),
        _ => false,
    };
    let mut used: HashSet<usize> = HashSet::new();
    let mut claimed: HashMap<String, usize> = HashMap::new();
    for b in &staying {
        let pick = match b {
            BaseEntry::Dir { key, .. } => ctx.dirs.get(key).and_then(|p| {
                let (last, parent) = p.split_last()?;
                (Some(parent.to_vec()) == here_path).then_some(*last)
            }),
            BaseEntry::Link {
                id: Some(id), key, ..
            } if ctx.base_owner.get(id) == Some(key) => open
                .iter()
                .copied()
                .find(|i| ctx.owner_of.get(id) == Some(&ref_at(*i))),
            _ => None,
        };
        if let Some(i) = pick.filter(|i| !used.contains(i)) {
            used.insert(i);
            claimed.insert(b.key().to_owned(), i);
        }
    }
    for b in &staying {
        if !b.is_link() || claimed.contains_key(b.key()) {
            continue;
        }
        if let Some(i) = open.iter().copied().find(|i| {
            !used.contains(i)
                && !matches!(level.entries[*i], RemoteEntry::Dir { .. })
                && level.entries[*i].file() == b.file()
                && !foreign(ctx, b, *i)
        }) {
            used.insert(i);
            claimed.insert(b.key().to_owned(), i);
        }
    }
    for b in &staying {
        if !b.is_link() || claimed.contains_key(b.key()) {
            continue;
        }
        if let Some(i) = open.iter().copied().find(|i| {
            !used.contains(i) && !foreign(ctx, b, *i) && same_thing(b, &level.entries[*i])
        }) {
            used.insert(i);
            claimed.insert(b.key().to_owned(), i);
        }
    }
    let fresh: Vec<usize> = open.iter().copied().filter(|i| !used.contains(i)).collect();

    let mut entries: Vec<TargetEntry> = Vec::new();
    let mut dropped: Vec<Dropped> = Vec::new();
    let keep = |ctx: &mut Ctx,
                b: &BaseEntry,
                here: Option<&LocalEntry>,
                found: Option<usize>,
                entries: &mut Vec<TargetEntry>,
                dropped: &mut Vec<Dropped>| {
        let r = found.filter(|i| {
            matches!(
                (&level.entries[*i], b),
                (
                    RemoteEntry::Link { .. } | RemoteEntry::Held { .. },
                    BaseEntry::Link { .. }
                ) | (RemoteEntry::Dir { .. }, BaseEntry::Dir { .. })
            )
        });
        if let (None, BaseEntry::Dir { children, .. }, Some(i)) = (here, b, r)
            && let RemoteEntry::Dir { file, .. } = &level.entries[i]
            && holds_arrival(root, &dir_path(i), ctx)
        {
            let inner = merge_level(children, &[], Some(&dir_path(i)), root, ctx);
            entries.push(TargetEntry::Dir(TargetDir {
                key: None,
                file: Some(file.clone()),
                name: name_of_file(file, false),
                renamed: false,
                level: inner,
            }));
            return;
        }
        let same_kind = here.is_some_and(|h| {
            matches!(
                (h, b),
                (LocalEntry::Link { .. }, BaseEntry::Link { .. })
                    | (LocalEntry::Dir { .. }, BaseEntry::Dir { .. })
            )
        });
        let (Some(here), Some(i), true) = (here, r, same_kind) else {
            if here.is_none()
                && let Some(i) = r
            {
                match (&level.entries[i], b) {
                    (RemoteEntry::Dir { file, .. }, BaseEntry::Dir { children, .. }) => dropped
                        .push(Dropped::Dir {
                            file: file.clone(),
                            known: children.clone(),
                        }),
                    (RemoteEntry::Link { file, url, .. }, _) => dropped.push(Dropped::Link {
                        file: file.clone(),
                        url: url.clone(),
                    }),
                    (RemoteEntry::Held { file, .. }, BaseEntry::Link { url, .. }) => {
                        dropped.push(Dropped::Link {
                            file: file.clone(),
                            url: url.clone(),
                        })
                    }
                    _ => {}
                }
            }
            return;
        };
        let r_file = level.entries[i].file().to_owned();
        let (b_name, b_file) = match b {
            BaseEntry::Link { name, file, .. } | BaseEntry::Dir { name, file, .. } => {
                (name.clone(), file.clone())
            }
        };
        let local_renamed = here.name() != b_name;
        let name = if local_renamed {
            here.name().to_owned()
        } else if r_file != b_file {
            name_of_file(&r_file, b.is_link())
        } else {
            b_name.clone()
        };
        match (here, b) {
            (
                LocalEntry::Link { url: here_url, .. },
                BaseEntry::Link {
                    key,
                    url: b_url,
                    id: b_id,
                    ..
                },
            ) => {
                let (remote_url, file_id) = match &level.entries[i] {
                    RemoteEntry::Link { url, id, .. } => (Some(url.clone()), id.clone()),
                    _ => (None, None),
                };
                let local_moved = here_url != b_url;
                let url = if local_moved || remote_url.is_none() {
                    here_url.clone()
                } else {
                    remote_url.clone().unwrap_or_default()
                };
                let owns_file = owned(ctx, i).is_some()
                    && file_id.as_ref().is_none_or(|f| {
                        !ctx.base_owner.contains_key(f) || ctx.base_owner.get(f) == Some(key)
                    });
                let id = if owns_file {
                    file_id.clone()
                } else {
                    b_id.clone()
                        .filter(|id| ctx.base_owner.get(id).is_none_or(|k| k == key))
                };
                let held_name =
                    matches!(level.entries[i], RemoteEntry::Held { .. }).then(|| b_name.clone());
                if let RemoteEntry::Held { waiting: true, .. } = level.entries[i] {
                    ctx.waiting += 1;
                }
                let write = match &remote_url {
                    None => local_moved,
                    Some(r) => url != *r,
                };
                entries.push(TargetEntry::Link(TargetLink {
                    key: Some(key.clone()),
                    file: Some(r_file),
                    name,
                    url,
                    renamed: local_renamed,
                    write,
                    expect: Some(remote_url.unwrap_or_else(|| b_url.clone())),
                    id,
                    file_id,
                    held_name,
                }));
            }
            (
                LocalEntry::Dir { children: lc, .. },
                BaseEntry::Dir {
                    key, children: bc, ..
                },
            ) => {
                let inner = merge_level(bc, lc, Some(&dir_path(i)), root, ctx);
                entries.push(TargetEntry::Dir(TargetDir {
                    key: Some(key.clone()),
                    file: Some(r_file),
                    name,
                    renamed: local_renamed,
                    level: inner,
                }));
            }
            _ => {}
        }
    };
    for b in &staying {
        let here = local_by_key.get(b.key()).copied();
        keep(
            ctx,
            b,
            here,
            claimed.get(b.key()).copied(),
            &mut entries,
            &mut dropped,
        );
    }
    for i in &arrivals {
        let Some(b) = ctx.arriving.get(&ref_at(*i)).cloned() else {
            continue;
        };
        let here = ctx.local_links.get(b.key()).cloned();
        keep(ctx, &b, here.as_ref(), Some(*i), &mut entries, &mut dropped);
    }
    for l in local {
        if base_keys.contains(l.key()) || ctx.arriving_keys.contains(l.key()) {
            continue;
        }
        let twin = fresh.iter().copied().find(|i| {
            !used.contains(i)
                && match (l, &level.entries[*i]) {
                    (LocalEntry::Link { url, .. }, RemoteEntry::Link { url: u, .. }) => u == url,
                    (LocalEntry::Dir { name, .. }, RemoteEntry::Dir { file, .. }) => {
                        file.to_lowercase() == name.to_lowercase()
                    }
                    _ => false,
                }
        });
        if let Some(t) = twin {
            used.insert(t);
        }
        match l {
            LocalEntry::Link { key, name, url } => {
                let (file, file_id, expect) = match twin.map(|t| &level.entries[t]) {
                    Some(RemoteEntry::Link { file, id, url }) => {
                        (Some(file.clone()), id.clone(), Some(url.clone()))
                    }
                    Some(other) => (Some(other.file().to_owned()), None, None),
                    None => (None, None, None),
                };
                let id = twin
                    .and_then(|t| owned(ctx, t))
                    .filter(|f| !ctx.base_owner.contains_key(f));
                entries.push(TargetEntry::Link(TargetLink {
                    key: Some(key.clone()),
                    file,
                    name: name.clone(),
                    url: url.clone(),
                    renamed: true,
                    write: twin.is_none(),
                    expect,
                    id,
                    file_id,
                    held_name: None,
                }));
            }
            LocalEntry::Dir {
                key,
                name,
                children,
            } => {
                let (file, inner) = match twin {
                    Some(t) if matches!(level.entries[t], RemoteEntry::Dir { .. }) => (
                        Some(level.entries[t].file().to_owned()),
                        merge_level(&[], children, Some(&dir_path(t)), root, ctx),
                    ),
                    _ => (
                        twin.map(|t| level.entries[t].file().to_owned()),
                        merge_level(&[], children, None, root, ctx),
                    ),
                };
                entries.push(TargetEntry::Dir(TargetDir {
                    key: Some(key.clone()),
                    file,
                    name: name.clone(),
                    renamed: true,
                    level: inner,
                }));
            }
        }
    }
    for i in &fresh {
        if used.contains(i) {
            continue;
        }
        match &level.entries[*i] {
            RemoteEntry::Held { waiting, .. } => {
                if *waiting {
                    ctx.waiting += 1;
                }
            }
            RemoteEntry::Link { file, url, id } => {
                let own = owned(ctx, *i).is_some_and(|f| !ctx.base_owner.contains_key(&f));
                entries.push(TargetEntry::Link(TargetLink {
                    key: None,
                    file: Some(file.clone()),
                    name: name_of_file(file, true),
                    url: url.clone(),
                    renamed: false,
                    write: false,
                    expect: Some(url.clone()),
                    id: if own { id.clone() } else { None },
                    file_id: id.clone(),
                    held_name: None,
                }));
            }
            RemoteEntry::Dir { file, .. } => {
                let inner = merge_level(&[], &[], Some(&dir_path(*i)), root, ctx);
                entries.push(TargetEntry::Dir(TargetDir {
                    key: None,
                    file: Some(file.clone()),
                    name: file.clone(),
                    renamed: false,
                    level: inner,
                }));
            }
        }
    }
    let ordered_entries = ordered(entries, base, local, &level);
    TargetLevel {
        entries: ordered_entries,
        dropped,
        remote: here_path.map(|_| level),
    }
}

fn same_relative(a: &[usize], b: &[usize]) -> bool {
    let in_b: HashSet<usize> = b.iter().copied().collect();
    let in_a: HashSet<usize> = a.iter().copied().collect();
    let x: Vec<usize> = a.iter().copied().filter(|e| in_b.contains(e)).collect();
    let y: Vec<usize> = b.iter().copied().filter(|e| in_a.contains(e)).collect();
    x == y
}

fn ordered(
    entries: Vec<TargetEntry>,
    base: &[BaseEntry],
    local: &[LocalEntry],
    remote: &RemoteLevel,
) -> Vec<TargetEntry> {
    let by_key: HashMap<String, usize> = entries
        .iter()
        .enumerate()
        .filter_map(|(i, e)| e.key().map(|k| (k.to_owned(), i)))
        .collect();
    let by_file: HashMap<String, usize> = entries
        .iter()
        .enumerate()
        .filter_map(|(i, e)| e.file().map(|f| (f.to_owned(), i)))
        .collect();
    let base_seq: Vec<usize> = base
        .iter()
        .filter_map(|b| by_key.get(b.key()).copied())
        .collect();
    let local_seq: Vec<usize> = local
        .iter()
        .filter_map(|l| by_key.get(l.key()).copied())
        .collect();
    let (listed, rest) = remote_order(remote);
    let listed_seq: Vec<usize> = listed
        .iter()
        .filter_map(|f| by_file.get(f).copied())
        .collect();
    let mut remote_seq = listed_seq.clone();
    remote_seq.extend(rest.iter().filter_map(|f| by_file.get(f).copied()));
    let local_moved = !same_relative(&base_seq, &local_seq);
    let remote_moved = !remote.manifest_pending && !same_relative(&base_seq, &remote_seq);
    let primary = if local_moved {
        local_seq.clone()
    } else if remote_moved {
        remote_seq.clone()
    } else {
        base_seq
    };
    let woven = weave(&weave(&primary, &local_seq), &listed_seq);
    let mut with_rest = woven.clone();
    with_rest.extend(remote_seq.iter().copied().filter(|e| !woven.contains(e)));
    let all: Vec<usize> = (0..entries.len()).collect();
    let order = weave(&with_rest, &all);
    let mut slots: Vec<Option<TargetEntry>> = entries.into_iter().map(Some).collect();
    order.into_iter().filter_map(|i| slots[i].take()).collect()
}

#[derive(Clone, Debug, PartialEq)]
pub enum FolderOp {
    Write {
        path: String,
        text: String,
        create: bool,
        expect: Option<String>,
    },
    Move {
        path: String,
        to: String,
    },
    Delete {
        path: String,
        expect: String,
    },
    Mkdir {
        path: String,
    },
    Rmdir {
        path: String,
    },
}

pub fn webloc_text(url: &str, id: Option<&str>) -> String {
    let escape = |t: &str| {
        t.replace('&', "&amp;")
            .replace('<', "&lt;")
            .replace('>', "&gt;")
    };
    let mut lines = vec![
        r#"<?xml version="1.0" encoding="UTF-8"?>"#.to_owned(),
        r#"<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">"#.to_owned(),
        r#"<plist version="1.0">"#.to_owned(),
        "<dict>".to_owned(),
        "\t<key>URL</key>".to_owned(),
        format!("\t<string>{}</string>", escape(url)),
    ];
    if let Some(id) = id {
        lines.push("\t<key>ArdiaLink</key>".to_owned());
        lines.push(format!("\t<string>{}</string>", escape(id)));
    }
    lines.extend(["</dict>".to_owned(), "</plist>".to_owned(), String::new()]);
    lines.join("\n")
}

fn unescape_xml(text: &str) -> String {
    let mut out = String::new();
    let mut rest = text;
    while let Some(at) = rest.find('&') {
        out.push_str(&rest[..at]);
        let tail = &rest[at..];
        let Some(end) = tail.find(';').filter(|e| *e <= 12) else {
            out.push('&');
            rest = &tail[1..];
            continue;
        };
        let name = &tail[1..end];
        let decoded = match name.to_lowercase().as_str() {
            "amp" => Some('&'),
            "lt" => Some('<'),
            "gt" => Some('>'),
            "quot" => Some('"'),
            "apos" => Some('\''),
            n if n.starts_with("#x") => u32::from_str_radix(&n[2..], 16)
                .ok()
                .and_then(char::from_u32),
            n if n.starts_with('#') => n[1..].parse::<u32>().ok().and_then(char::from_u32),
            _ => None,
        };
        match decoded {
            Some(c) => {
                out.push(c);
                rest = &tail[end + 1..];
            }
            None => {
                out.push('&');
                rest = &tail[1..];
            }
        }
    }
    out.push_str(rest);
    out
}

fn string_for(text: &str, key: &str) -> Option<String> {
    let mut plain = String::new();
    let mut rest = text;
    while let Some(at) = rest.find("<!--") {
        plain.push_str(&rest[..at]);
        rest = rest[at..].find("-->").map_or("", |e| &rest[at + e + 3..]);
    }
    plain.push_str(rest);
    let lower = plain.to_lowercase();
    let mut from = 0;
    while let Some(k) = lower[from..].find("<key>") {
        let start = from + k + 5;
        let end = start + lower[start..].find("</key>")?;
        let after = end + 6;
        from = after;
        if plain[start..end].trim().to_lowercase() != key.to_lowercase() {
            continue;
        }
        let tail = &lower[after..];
        let gap = tail.len() - tail.trim_start().len();
        if !tail.trim_start().starts_with("<string>") {
            return None;
        }
        let value_start = after + gap + 8;
        let value_end = value_start + lower[value_start..].find("</string>")?;
        let value = unescape_xml(&plain[value_start..value_end])
            .trim()
            .to_owned();
        return (!value.is_empty()).then_some(value);
    }
    None
}

pub fn parse_webloc(text: &str) -> Option<String> {
    string_for(text, "URL")
}

pub fn webloc_link_id(text: &str) -> Option<String> {
    string_for(text, "ArdiaLink")
}

pub fn new_link_id(now: Millis) -> String {
    let random = uuid_like();
    format!("{}{}", base36(now.max(0) as u64), &random[..8])
}

fn base36(mut n: u64) -> String {
    if n == 0 {
        return "0".into();
    }
    let mut out = Vec::new();
    while n > 0 {
        let d = (n % 36) as u8;
        out.push(if d < 10 { b'0' + d } else { b'a' + d - 10 });
        n /= 36;
    }
    out.reverse();
    String::from_utf8(out).unwrap_or_default()
}

fn uuid_like() -> String {
    use std::sync::atomic::{AtomicU64, Ordering};
    static SEED: AtomicU64 = AtomicU64::new(0);
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_nanos() as u64);
    let mut x = nanos
        ^ SEED.fetch_add(0x9E37_79B9_7F4A_7C15, Ordering::Relaxed)
        ^ u64::from(std::process::id());
    let mut out = String::new();
    while out.len() < 12 {
        x ^= x << 13;
        x ^= x >> 7;
        x ^= x << 17;
        out.push_str(&base36(x % 2_176_782_336));
    }
    out
}

pub fn is_shareable_url(url: &str) -> bool {
    let Ok(parsed) = url::Url::parse(url) else {
        return false;
    };
    matches!(parsed.scheme(), "http" | "https") && parsed.host_str().is_some_and(|h| !h.is_empty())
}

pub struct Planned {
    pub ops: Vec<FolderOp>,
    pub base: Vec<BaseEntry>,
}

struct Pass {
    identity_only: bool,
    needs_identity: bool,
    ids: HashMap<String, String>,
    seen: HashSet<String>,
    now: Millis,
}

pub fn plan_files(level: &TargetLevel, base: &[BaseEntry], now: Millis) -> Planned {
    let mut full = Pass {
        identity_only: false,
        needs_identity: false,
        ids: HashMap::new(),
        seen: HashSet::new(),
        now,
    };
    let mut ops = Vec::new();
    let next = plan_level("", level, &mut ops, &mut full);
    if !full.needs_identity {
        return Planned { ops, base: next };
    }
    let mut first = Pass {
        identity_only: true,
        needs_identity: false,
        ids: HashMap::new(),
        seen: HashSet::new(),
        now,
    };
    let mut identity_ops = Vec::new();
    plan_level("", level, &mut identity_ops, &mut first);
    Planned {
        ops: identity_ops,
        base: with_ids(base, &first.ids),
    }
}

fn with_ids(base: &[BaseEntry], ids: &HashMap<String, String>) -> Vec<BaseEntry> {
    base.iter()
        .map(|b| match b {
            BaseEntry::Dir {
                key,
                file,
                name,
                children,
            } => BaseEntry::Dir {
                key: key.clone(),
                file: file.clone(),
                name: name.clone(),
                children: with_ids(children, ids),
            },
            BaseEntry::Link {
                key,
                file,
                name,
                url,
                id,
            } => BaseEntry::Link {
                key: key.clone(),
                file: file.clone(),
                name: name.clone(),
                url: url.clone(),
                id: ids.get(key).cloned().or_else(|| id.clone()),
            },
        })
        .collect()
}

fn drop_ops(prefix: &str, d: &Dropped, ops: &mut Vec<FolderOp>) {
    match d {
        Dropped::Link { file, url } => ops.push(FolderOp::Delete {
            path: format!("{prefix}{file}"),
            expect: url.clone(),
        }),
        Dropped::Dir { file, known } => {
            let inside = format!("{prefix}{file}/");
            for k in known {
                let inner = match k {
                    BaseEntry::Link { file, url, .. } => Dropped::Link {
                        file: file.clone(),
                        url: url.clone(),
                    },
                    BaseEntry::Dir { file, children, .. } => Dropped::Dir {
                        file: file.clone(),
                        known: children.clone(),
                    },
                };
                drop_ops(&inside, &inner, ops);
            }
            ops.push(FolderOp::Rmdir {
                path: format!("{prefix}{file}"),
            });
        }
    }
}

fn move_ops(
    prefix: &str,
    moves: &[(String, String, bool)],
    reserved: &HashSet<String>,
    ops: &mut Vec<FolderOp>,
) {
    let sources: HashSet<String> = moves.iter().map(|m| m.0.to_lowercase()).collect();
    let tangled = moves.iter().any(|m| sources.contains(&m.1.to_lowercase()));
    if !tangled {
        for (from, to, _) in moves {
            ops.push(FolderOp::Move {
                path: format!("{prefix}{from}"),
                to: format!("{prefix}{to}"),
            });
        }
        return;
    }
    let mut taken: HashSet<String> = reserved
        .iter()
        .cloned()
        .chain(sources.iter().cloned())
        .chain(moves.iter().map(|m| m.1.to_lowercase()))
        .collect();
    let parked: Vec<(String, String, String)> = moves
        .iter()
        .map(|(from, to, link)| {
            (
                from.clone(),
                to.clone(),
                unique_file_name(
                    &format!("{} (moving)", name_of_file(from, *link)),
                    *link,
                    &mut taken,
                ),
            )
        })
        .collect();
    for (from, _, via) in &parked {
        ops.push(FolderOp::Move {
            path: format!("{prefix}{from}"),
            to: format!("{prefix}{via}"),
        });
    }
    for (_, to, via) in &parked {
        ops.push(FolderOp::Move {
            path: format!("{prefix}{via}"),
            to: format!("{prefix}{to}"),
        });
    }
}

fn plan_level(
    prefix: &str,
    level: &TargetLevel,
    ops: &mut Vec<FolderOp>,
    pass: &mut Pass,
) -> Vec<BaseEntry> {
    let entries: Vec<&TargetEntry> = level.entries.iter().filter(|e| e.key().is_some()).collect();
    if !pass.identity_only {
        for d in &level.dropped {
            drop_ops(prefix, d, ops);
        }
    }
    let referenced: HashSet<&str> = entries.iter().filter_map(|e| e.file()).collect();
    let dropped_files: HashSet<&str> = level.dropped.iter().map(Dropped::file).collect();
    let kept: Vec<String> = level
        .remote
        .iter()
        .flat_map(|r| r.entries.iter())
        .map(|r| r.file().to_owned())
        .filter(|f| !referenced.contains(f.as_str()) && !dropped_files.contains(f.as_str()))
        .collect();
    let mut taken: HashSet<String> = kept.iter().map(|f| f.to_lowercase()).collect();
    let held = |e: &TargetEntry| matches!(e, TargetEntry::Link(l) if l.held_name.is_some());
    let renamed = |e: &TargetEntry| match e {
        TargetEntry::Link(l) => l.renamed,
        TargetEntry::Dir(d) => d.renamed,
    };
    let name = |e: &TargetEntry| match e {
        TargetEntry::Link(l) => l.name.clone(),
        TargetEntry::Dir(d) => d.name.clone(),
    };
    let mut finals: Vec<Option<String>> = vec![None; entries.len()];
    for (i, e) in entries.iter().enumerate() {
        if let Some(file) = e.file()
            && (!renamed(e) || held(e))
        {
            finals[i] = Some(file.to_owned());
            taken.insert(file.to_lowercase());
        }
    }
    for (i, e) in entries.iter().enumerate() {
        if finals[i].is_none() {
            finals[i] = Some(unique_file_name(&name(e), e.is_link(), &mut taken));
        }
    }
    let finals: Vec<String> = finals.into_iter().map(Option::unwrap_or_default).collect();
    let mut ids: Vec<Option<String>> = vec![None; entries.len()];
    for (i, e) in entries.iter().enumerate() {
        let TargetEntry::Link(l) = e else { continue };
        if held(e) {
            if let Some(id) = &l.id {
                pass.seen.insert(id.clone());
            }
            ids[i] = l.id.clone();
            continue;
        }
        let moving = l.file.as_ref().is_some_and(|f| *f != finals[i]);
        if moving && l.file_id.is_none() {
            pass.needs_identity = true;
        }
        let mut id = l.id.clone().filter(|id| !pass.seen.contains(id));
        if id.is_none()
            && (l.write || l.file.is_none() || moving || l.file_id.is_some() || pass.identity_only)
        {
            id = Some(new_link_id(pass.now));
        }
        if let Some(id) = &id {
            pass.seen.insert(id.clone());
            if pass.identity_only
                && let Some(key) = &l.key
            {
                pass.ids.insert(key.clone(), id.clone());
            }
        }
        ids[i] = id;
    }
    for (i, e) in entries.iter().enumerate() {
        let TargetEntry::Link(l) = e else { continue };
        let Some(file) = &l.file else { continue };
        if held(e) || (!l.write && ids[i] == l.file_id) {
            continue;
        }
        ops.push(FolderOp::Write {
            path: format!("{prefix}{file}"),
            text: webloc_text(&l.url, ids[i].as_deref()),
            create: false,
            expect: l.expect.clone(),
        });
    }
    if pass.identity_only {
        for e in &entries {
            if let TargetEntry::Dir(d) = e
                && let Some(file) = &d.file
            {
                plan_level(&format!("{prefix}{file}/"), &d.level, ops, pass);
            }
        }
        return Vec::new();
    }
    let moves: Vec<(String, String, bool)> = entries
        .iter()
        .enumerate()
        .filter_map(|(i, e)| {
            e.file()
                .filter(|f| **f != finals[i])
                .map(|f| (f.to_owned(), finals[i].clone(), e.is_link()))
        })
        .collect();
    move_ops(prefix, &moves, &taken, ops);
    let mut base = Vec::new();
    for (i, e) in entries.iter().enumerate() {
        let file = finals[i].clone();
        match e {
            TargetEntry::Link(l) => {
                if l.file.is_none() {
                    ops.push(FolderOp::Write {
                        path: format!("{prefix}{file}"),
                        text: webloc_text(&l.url, ids[i].as_deref()),
                        create: true,
                        expect: None,
                    });
                }
                let url = if held(e) {
                    l.expect.clone().unwrap_or_else(|| l.url.clone())
                } else {
                    l.url.clone()
                };
                base.push(BaseEntry::Link {
                    key: l.key.clone().unwrap_or_default(),
                    file,
                    name: l.held_name.clone().unwrap_or_else(|| l.name.clone()),
                    url,
                    id: ids[i].clone(),
                });
            }
            TargetEntry::Dir(d) => {
                if d.file.is_none() {
                    ops.push(FolderOp::Mkdir {
                        path: format!("{prefix}{file}"),
                    });
                }
                let children = plan_level(&format!("{prefix}{file}/"), &d.level, ops, pass);
                base.push(BaseEntry::Dir {
                    key: d.key.clone().unwrap_or_default(),
                    file,
                    name: d.name.clone(),
                    children,
                });
            }
        }
    }
    let current = level.remote.as_ref().and_then(|r| r.manifest.clone());
    let known: HashSet<&String> = kept.iter().chain(finals.iter()).collect();
    let listed: Vec<String> = current
        .iter()
        .flatten()
        .filter(|f| known.contains(f))
        .cloned()
        .collect();
    let order = weave(&finals, &listed);
    let pending = level.remote.as_ref().is_some_and(|r| r.manifest_pending);
    if !pending && (!order.is_empty() || current.is_some()) && order != current.unwrap_or_default()
    {
        ops.push(FolderOp::Write {
            path: format!("{prefix}{MANIFEST}"),
            text: manifest_text(&order),
            create: false,
            expect: None,
        });
    }
    base
}

#[derive(Clone, Debug, Default)]
pub struct LocalFolder {
    pub entries: Vec<LocalEntry>,
    pub tab_of: HashMap<String, TabId>,
    pub group_of: HashMap<String, GroupId>,
    pub name_of: HashMap<String, String>,
    pub url_of: HashMap<String, String>,
    pub others: HashMap<GroupId, Vec<TabId>>,
}

pub fn known_names(base: &[BaseEntry], into: &mut HashMap<String, String>) {
    for b in base {
        match b {
            BaseEntry::Link { key, name, .. } => {
                into.insert(key.clone(), name.clone());
            }
            BaseEntry::Dir {
                key,
                name,
                children,
                ..
            } => {
                into.insert(key.clone(), name.clone());
                known_names(children, into);
            }
        }
    }
}

fn display_host(url: &str) -> String {
    url::Url::parse(url)
        .ok()
        .and_then(|u| {
            u.host_str()
                .map(|h| h.trim_start_matches("www.").to_owned())
        })
        .unwrap_or_default()
}

fn link_name(t: &Tab, known: Option<&String>) -> String {
    if let Some(custom) = t
        .custom_title
        .as_ref()
        .map(|c| c.trim())
        .filter(|c| !c.is_empty())
    {
        return custom.to_owned();
    }
    if let Some(known) = known {
        return known.clone();
    }
    let title = t.title.trim();
    if !title.is_empty() {
        return title.to_owned();
    }
    let host = display_host(t.pin_home());
    if host.is_empty() {
        "Link".to_owned()
    } else {
        host
    }
}

pub fn group_name(g: &TabGroup) -> String {
    let name = g.name.trim();
    if name.is_empty() {
        "Folder".to_owned()
    } else {
        name.to_owned()
    }
}

pub fn local_folder(
    s: &BrowserState,
    group: &GroupId,
    names: &HashMap<String, String>,
) -> Option<LocalFolder> {
    let root = s.groups.get(group)?;
    let w = s.windows.get(&root.window_id)?;
    let position: HashMap<&TabId, usize> = w
        .tab_ids
        .iter()
        .enumerate()
        .map(|(i, id)| (id, i))
        .collect();
    let mut children: HashMap<GroupId, Vec<Arc<TabGroup>>> = HashMap::new();
    for g in s.groups.values() {
        if let Some(parent) = &g.parent_id
            && g.window_id == root.window_id
        {
            children.entry(parent.clone()).or_default().push(g.clone());
        }
    }
    let mut folder = LocalFolder::default();
    fn walk(
        s: &BrowserState,
        g: &TabGroup,
        seen: &HashSet<GroupId>,
        children: &HashMap<GroupId, Vec<Arc<TabGroup>>>,
        position: &HashMap<&TabId, usize>,
        names: &HashMap<String, String>,
        folder: &mut LocalFolder,
    ) -> Vec<LocalEntry> {
        let mut kid_of: HashMap<TabId, Arc<TabGroup>> = HashMap::new();
        for k in children.get(&g.id).into_iter().flatten() {
            if !seen.contains(&k.id) {
                for id in &k.tab_ids {
                    kid_of.insert(id.clone(), k.clone());
                }
            }
        }
        let mut out = Vec::new();
        let mut done: HashSet<GroupId> = HashSet::new();
        let mut extra = Vec::new();
        let mut ids = g.tab_ids.clone();
        ids.sort_by_key(|id| position.get(id).copied().unwrap_or(0));
        for id in ids {
            if let Some(kid) = kid_of.get(&id) {
                if !done.insert(kid.id.clone()) {
                    continue;
                }
                let key = kid.pin_key().to_owned();
                folder.group_of.insert(key.clone(), kid.id.clone());
                folder.name_of.insert(key.clone(), group_name(kid));
                let mut inner_seen = seen.clone();
                inner_seen.insert(kid.id.clone());
                let inner = walk(s, kid, &inner_seen, children, position, names, folder);
                out.push(LocalEntry::Dir {
                    key,
                    name: group_name(kid),
                    children: inner,
                });
                continue;
            }
            let Some(t) = s.tabs.get(&id) else { continue };
            let url = t.pin_home().to_owned();
            if !is_shareable_url(&url) {
                extra.push(id.clone());
                continue;
            }
            let key = t.pin_key().to_owned();
            let name = link_name(t, names.get(&key));
            folder.tab_of.insert(key.clone(), id.clone());
            folder.name_of.insert(key.clone(), name.clone());
            folder.url_of.insert(key.clone(), url.clone());
            out.push(LocalEntry::Link { key, name, url });
        }
        folder.others.insert(g.id.clone(), extra);
        out
    }
    let seen = HashSet::from([root.id.clone()]);
    folder.entries = walk(s, root, &seen, &children, &position, names, &mut folder);
    Some(folder)
}

fn keys_in(level: &TargetLevel, links: &mut HashSet<String>, dirs: &mut HashSet<String>) {
    for e in &level.entries {
        match e {
            TargetEntry::Link(l) => {
                if let Some(k) = &l.key {
                    links.insert(k.clone());
                }
            }
            TargetEntry::Dir(d) => {
                if let Some(k) = &d.key {
                    dirs.insert(k.clone());
                }
                keys_in(&d.level, links, dirs);
            }
        }
    }
}

fn has_link(level: &TargetLevel) -> bool {
    level.entries.iter().any(|e| match e {
        TargetEntry::Link(_) => true,
        TargetEntry::Dir(d) => has_link(&d.level),
    })
}

fn is_placeholder(t: Option<&Arc<Tab>>) -> bool {
    t.is_some_and(|t| !t.page.has_page() && (t.url.is_empty() || t.url == EMPTY_FOLDER_URL))
}

pub struct FolderRemovals {
    pub removed: Vec<TabId>,
}

pub fn folder_removals(
    s: &BrowserState,
    group: &GroupId,
    level: &TargetLevel,
    folder: &LocalFolder,
) -> FolderRemovals {
    let Some(root) = s.groups.get(group) else {
        return FolderRemovals {
            removed: Vec::new(),
        };
    };
    let mut links = HashSet::new();
    let mut dirs = HashSet::new();
    keys_in(level, &mut links, &mut dirs);
    let shown = s.active_tab(root.window_id.as_str()).map(|t| t.id.clone());
    let gone = folder
        .tab_of
        .iter()
        .filter(|(k, _)| !links.contains(*k))
        .map(|(_, id)| id.clone());
    let blanks: Vec<TabId> = if has_link(level) {
        folder
            .others
            .get(group)
            .into_iter()
            .flatten()
            .filter(|id| is_placeholder(s.tabs.get(*id)) && Some(*id) != shown.as_ref())
            .cloned()
            .collect()
    } else {
        Vec::new()
    };
    let mut removed: Vec<TabId> = gone
        .filter(|id| {
            !(s.tabs.get(id).is_some_and(|t| t.page.has_page()) || Some(id) == shown.as_ref())
        })
        .collect();
    removed.extend(blanks);
    FolderRemovals { removed }
}

fn sleeping_tab(
    id: TabId,
    window: &WindowId,
    profile: &ProfileId,
    url: &str,
    title: &str,
    now: Millis,
) -> Tab {
    let mut tab = Tab::new(id, window.clone(), profile.clone(), url, now);
    tab.title = title.to_owned();
    tab.custom_title = Some(title.to_owned());
    tab.page = TabPage::ASLEEP;
    tab
}

pub fn with_folder(
    before: &BrowserState,
    s: &BrowserState,
    group: &GroupId,
    level: &mut TargetLevel,
    folder: &LocalFolder,
    ids: &crate::ids::IdGen,
    now: Millis,
) -> Option<(BrowserState, Vec<TabId>)> {
    let root = before.groups.get(group)?.clone();
    before.windows.get(&root.window_id)?;
    let w = s.windows.get(&root.window_id)?.clone();
    let window_id = root.window_id.clone();
    let profile_id = root.profile_id.clone();
    let mut links = HashSet::new();
    let mut dirs = HashSet::new();
    keys_in(level, &mut links, &mut dirs);
    let shown = before.active_tab(window_id.as_str()).map(|t| t.id.clone());
    let gone_links: Vec<TabId> = folder
        .tab_of
        .iter()
        .filter(|(k, _)| !links.contains(*k))
        .map(|(_, id)| id.clone())
        .collect();
    let released: Vec<TabId> = gone_links
        .iter()
        .filter(|id| {
            before.tabs.get(*id).is_some_and(|t| t.page.has_page()) || Some(*id) == shown.as_ref()
        })
        .cloned()
        .collect();
    let mut dirty = !gone_links.is_empty();
    let mut next = s.clone();
    let tabs = Arc::make_mut(&mut next.tabs);
    for id in &released {
        if let Some(t) = tabs.get_mut(id) {
            let t = Arc::make_mut(t);
            t.pinned_url = None;
            t.pin_key = None;
        }
    }
    let mut groups_map = (*next.groups).clone();
    for (key, id) in &folder.group_of {
        if !dirs.contains(key) && groups_map.shift_remove(id).is_some() {
            dirty = true;
        }
    }
    let mut created: Vec<TabId> = Vec::new();
    #[allow(clippy::too_many_arguments)]
    fn place(
        level: &mut TargetLevel,
        parent: &GroupId,
        folder: &LocalFolder,
        tabs: &mut crate::state::TabMap,
        groups_map: &mut groups::Groups,
        s: &BrowserState,
        window: &WindowId,
        profile: &ProfileId,
        ids: &crate::ids::IdGen,
        now: Millis,
        created: &mut Vec<TabId>,
        dirty: &mut bool,
    ) -> Vec<TabId> {
        let mut out = Vec::new();
        for e in level.entries.iter_mut() {
            match e {
                TargetEntry::Link(l) => {
                    let known = l
                        .key
                        .as_ref()
                        .and_then(|k| folder.tab_of.get(k))
                        .filter(|id| tabs.contains_key(*id))
                        .cloned();
                    if let (Some(id), Some(key)) = (known, l.key.clone()) {
                        let t = Arc::make_mut(tabs.get_mut(&id).expect("present"));
                        if Some(&l.name) != folder.name_of.get(&key) {
                            t.custom_title = Some(l.name.clone());
                            *dirty = true;
                        }
                        if Some(&l.url) != folder.url_of.get(&key) {
                            t.pinned_url = Some(l.url.clone());
                            if !t.page.has_page() {
                                t.url = l.url.clone();
                            }
                            *dirty = true;
                        }
                        out.push(id);
                        continue;
                    }
                    let id = TabId::from(ids.next("t"));
                    let mut tab = sleeping_tab(id.clone(), window, profile, &l.url, &l.name, now);
                    tab.pinned_url = Some(l.url.clone());
                    tabs.insert(id.clone(), Arc::new(tab));
                    created.push(id.clone());
                    l.key = Some(id.as_str().to_owned());
                    *dirty = true;
                    out.push(id);
                }
                TargetEntry::Dir(d) => {
                    let known = d.key.as_ref().and_then(|k| folder.group_of.get(k)).cloned();
                    let existing = known.as_ref().and_then(|k| {
                        groups_map
                            .get(k)
                            .cloned()
                            .or_else(|| s.groups.get(k).cloned())
                    });
                    let id = existing
                        .as_ref()
                        .map_or_else(|| GroupId::from(ids.next("g")), |g| g.id.clone());
                    let mut inner = place(
                        &mut d.level,
                        &id,
                        folder,
                        tabs,
                        groups_map,
                        s,
                        window,
                        profile,
                        ids,
                        now,
                        created,
                        dirty,
                    );
                    if existing.is_some() {
                        inner.extend(
                            folder
                                .others
                                .get(&id)
                                .into_iter()
                                .flatten()
                                .filter(|x| tabs.contains_key(*x))
                                .cloned(),
                        );
                    }
                    if inner.is_empty() {
                        if existing.is_some() {
                            groups_map.shift_remove(&id);
                            *dirty = true;
                        }
                        d.key = None;
                        continue;
                    }
                    match existing {
                        None => {
                            let mut g = TabGroup::new(
                                id.clone(),
                                window.clone(),
                                profile.clone(),
                                inner.clone(),
                                now,
                            );
                            g.name = d.name.clone();
                            g.collapsed = true;
                            g.pinned = true;
                            g.parent_id = Some(parent.clone());
                            groups_map.insert(id.clone(), Arc::new(g));
                            d.key = Some(id.as_str().to_owned());
                            *dirty = true;
                        }
                        Some(existing) => {
                            let key = d.key.clone().unwrap_or_default();
                            let mut g = (*existing).clone();
                            if Some(&d.name) != folder.name_of.get(&key) {
                                g.name = d.name.clone();
                                *dirty = true;
                            }
                            g.tab_ids = inner.clone();
                            groups_map.insert(id.clone(), Arc::new(g));
                        }
                    }
                    out.extend(inner);
                }
            }
        }
        out
    }
    let placed = place(
        level,
        group,
        folder,
        tabs,
        &mut groups_map,
        s,
        &window_id,
        &profile_id,
        ids,
        now,
        &mut created,
        &mut dirty,
    );
    let in_place: HashSet<&TabId> = placed.iter().collect();
    let leftover: Vec<TabId> = root
        .tab_ids
        .iter()
        .filter(|id| tabs.contains_key(*id) && !in_place.contains(id) && !released.contains(id))
        .cloned()
        .collect();
    let mut members = placed.clone();
    members.extend(leftover);
    if members.is_empty() {
        let id = TabId::from(ids.next("t"));
        tabs.insert(
            id.clone(),
            Arc::new(sleeping_tab(
                id.clone(),
                &window_id,
                &profile_id,
                EMPTY_FOLDER_URL,
                EMPTY_FOLDER_TITLE,
                now,
            )),
        );
        members.push(id);
        dirty = true;
    }
    let mut root_group = (*groups_map.get(group).cloned().unwrap_or(root.clone())).clone();
    root_group.tab_ids = members.clone();
    groups_map.insert(group.clone(), Arc::new(root_group));
    let block: HashSet<&TabId> = members.iter().collect();
    let old: HashSet<&TabId> = root.tab_ids.iter().collect();
    let first = w
        .tab_ids
        .iter()
        .position(|id| old.contains(id) || block.contains(id));
    let rest: Vec<TabId> = w
        .tab_ids
        .iter()
        .filter(|id| !block.contains(id) && !(old.contains(id) && !released.contains(id)))
        .cloned()
        .collect();
    let at = first.map_or(rest.len(), |f| {
        w.tab_ids[..f].iter().filter(|id| rest.contains(id)).count()
    });
    let mut order = rest;
    for (i, id) in members.iter().enumerate() {
        order.insert(at + i, id.clone());
    }
    let nested = groups::nest_groups(&groups_map);
    let arranged = crate::state::order_sections(&order, tabs, &nested);
    let mut final_groups = nested;
    groups::sync_group_order(&mut final_groups, &window_id, &arranged);
    let unchanged = !dirty
        && arranged == w.tab_ids
        && final_groups
            .values()
            .filter(|g| g.window_id == window_id)
            .all(|g| {
                before
                    .groups
                    .get(&g.id)
                    .is_some_and(|o| o.tab_ids == g.tab_ids)
            });
    if unchanged {
        return None;
    }
    let mut window = (*w).clone();
    window.tab_ids = arranged;
    Arc::make_mut(&mut next.windows).insert(window_id, Arc::new(window));
    next.groups = Arc::new(final_groups);
    Some((next, created))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn link(file: &str, url: &str, id: Option<&str>) -> RemoteEntry {
        RemoteEntry::Link {
            file: file.into(),
            url: url.into(),
            id: id.map(Into::into),
        }
    }

    #[test]
    fn names_and_weblocs_match_the_old_files() {
        assert_eq!(clean_name("  .a/b:c  d ", "Link"), "a-b-c d");
        assert_eq!(file_name_for("", true), "Link.webloc");
        let mut taken: HashSet<String> = HashSet::from(["docs.webloc".to_owned()]);
        assert_eq!(unique_file_name("Docs", true, &mut taken), "Docs 2.webloc");
        assert_eq!(
            manifest_text(&["A.webloc".into()]),
            "{\"version\":1,\"order\":[\"A.webloc\"]}\n"
        );
        let text = webloc_text("https://a.example/?x=1&y=<2>", Some("abc"));
        assert!(text.contains("<string>https://a.example/?x=1&amp;y=&lt;2&gt;</string>"));
        assert_eq!(
            parse_webloc(&text).as_deref(),
            Some("https://a.example/?x=1&y=<2>")
        );
        assert_eq!(webloc_link_id(&text).as_deref(), Some("abc"));
        assert_eq!(parse_webloc("<!-- <key>URL</key><string>no</string> --><key>url</key>\n<string> https://b/ </string>").as_deref(), Some("https://b/"));
        assert!(manifest_is_newer(Some("{\"version\":2}")));
        assert_eq!(
            parse_manifest(Some("{\"version\":1,\"order\":[\"a\",3]}")),
            Some(vec!["a".to_owned()])
        );
        let level = RemoteLevel {
            entries: vec![
                link("b10.webloc", "https://x/", None),
                link("b9.webloc", "https://y/", None),
                link("a.webloc", "https://z/", None),
            ],
            manifest: Some(vec!["a.webloc".into()]),
            manifest_pending: false,
        };
        assert_eq!(
            remote_order(&level),
            (
                vec!["a.webloc".to_owned()],
                vec!["b9.webloc".to_owned(), "b10.webloc".to_owned()]
            )
        );
        assert_eq!(weave(&[1, 3], &[1, 2, 3, 4]), vec![1, 2, 3, 4]);
    }

    #[test]
    fn a_new_local_link_is_written_and_a_remote_one_arrives() {
        let local = vec![LocalEntry::Link {
            key: "t1".into(),
            name: "Docs".into(),
            url: "https://docs.example/".into(),
        }];
        let remote = RemoteLevel {
            entries: vec![link("News.webloc", "https://news.example/", Some("idn"))],
            manifest: None,
            manifest_pending: false,
        };
        let merged = merge_folder(&[], &local, &remote);
        assert_eq!(merged.level.entries.len(), 2);
        let planned = plan_files(&merged.level, &[], 1_795_000_000_000);
        assert!(planned.ops.iter().any(
            |o| matches!(o, FolderOp::Write { path, create: true, .. } if path == "Docs.webloc")
        ));
        assert!(
            planned
                .ops
                .iter()
                .any(|o| matches!(o, FolderOp::Write { path, .. } if path == MANIFEST))
        );
        assert_eq!(planned.base.len(), 1);
        let arrived = merged
            .level
            .entries
            .iter()
            .find(|e| e.key().is_none())
            .unwrap();
        assert!(
            matches!(arrived, TargetEntry::Link(l) if l.url == "https://news.example/" && l.name == "News")
        );
    }

    #[test]
    fn deletions_and_renames_follow_the_three_way_rule() {
        let base = vec![
            BaseEntry::Link {
                key: "a".into(),
                file: "A.webloc".into(),
                name: "A".into(),
                url: "https://a/".into(),
                id: Some("ida".into()),
            },
            BaseEntry::Link {
                key: "b".into(),
                file: "B.webloc".into(),
                name: "B".into(),
                url: "https://b/".into(),
                id: Some("idb".into()),
            },
        ];
        let local = vec![LocalEntry::Link {
            key: "a".into(),
            name: "A2".into(),
            url: "https://a/".into(),
        }];
        let remote = RemoteLevel {
            entries: vec![
                link("A.webloc", "https://a/", Some("ida")),
                link("B.webloc", "https://b/", Some("idb")),
            ],
            manifest: None,
            manifest_pending: false,
        };
        let merged = merge_folder(&base, &local, &remote);
        assert_eq!(
            merged.level.dropped,
            vec![Dropped::Link {
                file: "B.webloc".into(),
                url: "https://b/".into()
            }]
        );
        let planned = plan_files(&merged.level, &base, 1);
        assert!(planned.ops.contains(&FolderOp::Delete {
            path: "B.webloc".into(),
            expect: "https://b/".into()
        }));
        assert!(planned.ops.contains(&FolderOp::Move {
            path: "A.webloc".into(),
            to: "A2.webloc".into()
        }));
        let remote_renamed = RemoteLevel {
            entries: vec![link("Alpha.webloc", "https://a/", Some("ida"))],
            manifest: None,
            manifest_pending: false,
        };
        let local_same = vec![LocalEntry::Link {
            key: "a".into(),
            name: "A".into(),
            url: "https://a/".into(),
        }];
        let merged = merge_folder(&base[..1], &local_same, &remote_renamed);
        assert!(matches!(&merged.level.entries[0], TargetEntry::Link(l) if l.name == "Alpha"));
    }
}
