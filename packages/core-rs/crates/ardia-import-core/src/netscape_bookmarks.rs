use std::mem;

use crate::bookmark::BookmarkNode;
use crate::chromium_bookmarks::{Limits, ProfileFile};
use crate::error::ImportError;
use crate::html::{decode_entities, decode_text, is_space, Attribute, Scanner, Tag};

const TOP_TITLE: &str = "Bookmarks";
const SKIPPED_SCHEME: &str = "place:";

pub fn netscape_bookmarks(file: ProfileFile<'_>) -> Result<BookmarkNode, ImportError> {
    netscape_bookmarks_with(file, &Limits::default())
}

pub fn netscape_bookmarks_with(file: ProfileFile<'_>, limits: &Limits) -> Result<BookmarkNode, ImportError> {
    let bytes = match file {
        ProfileFile::Missing => return Err(ImportError::NotFound),
        ProfileFile::Oversized => return Err(ImportError::TooLarge),
        ProfileFile::Bytes(bytes) if bytes.len() > limits.max_input_bytes => return Err(ImportError::TooLarge),
        ProfileFile::Bytes(bytes) => bytes,
    };
    let text = decode_text(bytes);
    let mut tree = Tree::new(limits);
    let mut scanner = Scanner::new(&text);
    while let Some(tag) = scanner.next_tag() {
        if tag.opens("h3") {
            let title = clean(&scanner.text_until("h3"));
            tree.folder_heading(folder_from(&tag, title));
        } else if tag.opens("dl") {
            tree.open_list();
        } else if tag.closes("dl") {
            tree.close_list();
        } else if tag.opens("a") {
            let title = clean(&scanner.text_until("a"));
            let href = clean(tag.attribute(Attribute::Href).unwrap_or_default());
            if href.is_empty() || starts_with_ignoring_case(&href, SKIPPED_SCHEME) {
                continue;
            }
            let title = if title.is_empty() { href.clone() } else { title };
            tree.link(BookmarkNode::link(
                title,
                href,
                seconds(tag.attribute(Attribute::AddDate)),
            ));
        }
    }
    let top = tree.finish();
    if top.link_count() == 0 && top.children.as_ref().is_none_or(Vec::is_empty) {
        return Err(ImportError::Unreadable);
    }
    Ok(top)
}

fn folder_from(tag: &Tag<'_>, title: String) -> BookmarkNode {
    let mut folder = BookmarkNode::folder(title, Vec::new(), seconds(tag.attribute(Attribute::AddDate)));
    let id = tag.attribute(Attribute::Id);
    let flag = |which: Attribute| {
        tag.attribute(which)
            .is_some_and(|value| value.eq_ignore_ascii_case("true"))
    };
    folder.role = if flag(Attribute::PersonalToolbarFolder) || id == Some("com.apple.FavoritesBar") {
        Some("toolbar")
    } else if flag(Attribute::UnfiledBookmarksFolder) {
        Some("other")
    } else if id == Some("com.apple.ReadingList") {
        Some("readingList")
    } else {
        None
    }
    .map(str::to_owned);
    folder
}

fn clean(text: &str) -> String {
    decode_entities(text).trim().to_owned()
}

fn starts_with_ignoring_case(text: &str, prefix: &str) -> bool {
    text.as_bytes()
        .get(..prefix.len())
        .is_some_and(|head| head.eq_ignore_ascii_case(prefix.as_bytes()))
}

fn seconds(text: Option<&str>) -> Option<f64> {
    let text = text?.trim_matches(|c: char| c.is_ascii() && is_space(c as u8));
    if text.starts_with('+') {
        return None;
    }
    let seconds: i64 = text.parse().ok()?;
    (seconds > 0).then_some(seconds as f64 * 1000.0)
}

enum Pending {
    Nothing,
    Folder(BookmarkNode),
    Dropped,
}

struct Tree<'l> {
    limits: &'l Limits,
    stack: Vec<BookmarkNode>,
    pending: Pending,
    saw_root_list: bool,
    flattened: usize,
    nodes: usize,
}

impl<'l> Tree<'l> {
    fn new(limits: &'l Limits) -> Self {
        Tree {
            limits,
            stack: vec![BookmarkNode::folder(TOP_TITLE, Vec::new(), None)],
            pending: Pending::Nothing,
            saw_root_list: false,
            flattened: 0,
            nodes: 0,
        }
    }

    fn reserve(&mut self) -> bool {
        let free = self.nodes < self.limits.max_nodes;
        if free {
            self.nodes += 1;
        }
        free
    }

    fn can_nest(&self) -> bool {
        self.stack.len() <= self.limits.max_folder_depth
    }

    fn append(&mut self, node: BookmarkNode) {
        if let Some(children) = self.stack.last_mut().and_then(|top| top.children.as_mut()) {
            children.push(node);
        }
    }

    fn flush_pending(&mut self) {
        if let Pending::Folder(folder) = mem::replace(&mut self.pending, Pending::Nothing) {
            self.append(folder);
        }
    }

    fn folder_heading(&mut self, folder: BookmarkNode) {
        self.flush_pending();
        self.pending = if self.can_nest() && self.reserve() {
            Pending::Folder(folder)
        } else {
            Pending::Dropped
        };
    }

    fn open_list(&mut self) {
        match mem::replace(&mut self.pending, Pending::Nothing) {
            Pending::Folder(folder) => self.stack.push(folder),
            Pending::Dropped => self.flattened += 1,
            Pending::Nothing if !self.saw_root_list => self.saw_root_list = true,
            Pending::Nothing => {
                if self.can_nest() && self.reserve() {
                    let mut list = BookmarkNode::folder("", Vec::new(), None);
                    list.role = Some("list".to_owned());
                    self.stack.push(list);
                } else {
                    self.flattened += 1;
                }
            }
        }
    }

    fn close_list(&mut self) {
        self.flush_pending();
        if self.flattened > 0 {
            self.flattened -= 1;
        } else if self.stack.len() > 1 {
            self.pop();
        }
    }

    fn pop(&mut self) {
        if let Some(done) = self.stack.pop() {
            self.append(done);
        }
    }

    fn link(&mut self, link: BookmarkNode) {
        self.flush_pending();
        if self.reserve() {
            self.append(link);
        }
    }

    fn finish(mut self) -> BookmarkNode {
        self.flush_pending();
        while self.stack.len() > 1 {
            self.pop();
        }
        self.stack
            .pop()
            .unwrap_or_else(|| BookmarkNode::folder(TOP_TITLE, Vec::new(), None))
    }
}
