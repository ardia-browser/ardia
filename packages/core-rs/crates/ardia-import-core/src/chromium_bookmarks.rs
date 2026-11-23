use serde_json::{Map, Value};

use crate::bookmark::BookmarkNode;
use crate::error::ImportError;
use crate::json;

pub const MAX_INPUT_BYTES: usize = 64 * 1024 * 1024;
pub const MAX_FOLDER_DEPTH: usize = 64;
pub const MAX_NODES: usize = 250_000;
pub const MAX_JSON_DEPTH: usize = 200;

const WEBKIT_EPOCH_OFFSET_MICROS: i64 = 11_644_473_600_000_000;
const TOP_TITLE: &str = "Bookmarks";
const ROOTS: [(&str, &str, &str); 3] = [
    ("bookmark_bar", "toolbar", "Bookmarks Bar"),
    ("other", "other", "Other Bookmarks"),
    ("synced", "mobile", "Mobile Bookmarks"),
];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Limits {
    pub max_input_bytes: usize,
    pub max_folder_depth: usize,
    pub max_nodes: usize,
    pub max_json_depth: usize,
}

impl Default for Limits {
    fn default() -> Self {
        Limits {
            max_input_bytes: MAX_INPUT_BYTES,
            max_folder_depth: MAX_FOLDER_DEPTH,
            max_nodes: MAX_NODES,
            max_json_depth: MAX_JSON_DEPTH,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProfileFile<'a> {
    Missing,
    Bytes(&'a [u8]),
    Oversized,
}

impl<'a> ProfileFile<'a> {
    fn readable(self, limits: &Limits) -> Option<Result<&'a [u8], ImportError>> {
        match self {
            ProfileFile::Missing => None,
            ProfileFile::Bytes(bytes) if bytes.len() <= limits.max_input_bytes => Some(Ok(bytes)),
            ProfileFile::Bytes(_) | ProfileFile::Oversized => Some(Err(ImportError::TooLarge)),
        }
    }
}

pub fn chromium_bookmarks(
    bookmarks: ProfileFile<'_>,
    account_bookmarks: ProfileFile<'_>,
) -> Result<BookmarkNode, ImportError> {
    chromium_bookmarks_with(bookmarks, account_bookmarks, &Limits::default())
}

pub fn chromium_bookmarks_with(
    bookmarks: ProfileFile<'_>,
    account_bookmarks: ProfileFile<'_>,
    limits: &Limits,
) -> Result<BookmarkNode, ImportError> {
    let local = bookmarks.readable(limits);
    let account = account_bookmarks.readable(limits);
    if local.is_none() && account.is_none() {
        return Err(ImportError::NotFound);
    }
    let mut nodes = 0usize;
    let mut folders = match local {
        Some(bytes) => roots(bytes?, limits, &mut nodes).ok_or(ImportError::Unreadable)?,
        None => Vec::new(),
    };
    if let Some(extra) = account
        .and_then(Result::ok)
        .and_then(|bytes| roots(bytes, limits, &mut nodes))
    {
        for folder in extra {
            match folders.iter_mut().find(|existing| existing.role == folder.role) {
                Some(same) => same
                    .children
                    .get_or_insert_with(Vec::new)
                    .extend(folder.children.unwrap_or_default()),
                None => folders.push(folder),
            }
        }
    }
    Ok(BookmarkNode::folder(TOP_TITLE, folders, None))
}

pub fn from_webkit(text: &str) -> Option<f64> {
    let micros: i64 = text.parse().ok()?;
    (micros > WEBKIT_EPOCH_OFFSET_MICROS).then(|| (micros - WEBKIT_EPOCH_OFFSET_MICROS) as f64 / 1000.0)
}

fn roots(bytes: &[u8], limits: &Limits, nodes: &mut usize) -> Option<Vec<BookmarkNode>> {
    let top = json::parse(bytes, limits.max_json_depth)?;
    let roots = top.as_object()?.get("roots")?.as_object()?;
    let mut folders = Vec::new();
    for (key, role, default_title) in ROOTS {
        let Some(json) = roots.get(key).and_then(Value::as_object) else {
            continue;
        };
        let Some(mut folder) = node(json, 0, limits, nodes) else {
            continue;
        };
        if folder.children.as_ref().is_none_or(Vec::is_empty) {
            continue;
        }
        folder.role = Some(role.to_owned());
        folder.title = text(json, "name")
            .filter(|name| !name.is_empty())
            .unwrap_or(default_title)
            .to_owned();
        folders.push(folder);
    }
    Some(folders)
}

fn node(json: &Map<String, Value>, depth: usize, limits: &Limits, nodes: &mut usize) -> Option<BookmarkNode> {
    if *nodes >= limits.max_nodes {
        return None;
    }
    let title = text(json, "name").unwrap_or_default();
    let date_added = text(json, "date_added").and_then(from_webkit);
    match text(json, "type") {
        Some("url") => {
            let url = text(json, "url").filter(|url| !url.is_empty())?;
            *nodes += 1;
            Some(BookmarkNode::link(title, url, date_added))
        }
        Some("folder") => {
            *nodes += 1;
            let mut children = Vec::new();
            if depth < limits.max_folder_depth {
                if let Some(list) = json.get("children").and_then(Value::as_array) {
                    for child in list.iter().filter_map(Value::as_object) {
                        if *nodes >= limits.max_nodes {
                            break;
                        }
                        if let Some(made) = node(child, depth + 1, limits, nodes) {
                            children.push(made);
                        }
                    }
                }
            }
            Some(BookmarkNode::folder(title, children, date_added))
        }
        _ => None,
    }
}

fn text<'a>(json: &'a Map<String, Value>, key: &str) -> Option<&'a str> {
    json.get(key).and_then(Value::as_str)
}
