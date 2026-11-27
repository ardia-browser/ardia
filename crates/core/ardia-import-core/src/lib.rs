#![forbid(unsafe_code)]

mod bookmark;
mod chromium_bookmarks;
mod error;
mod html;
mod json;
mod netscape_bookmarks;

pub use bookmark::{BookmarkNode, NodeType};
pub use chromium_bookmarks::{
    chromium_bookmarks, chromium_bookmarks_with, from_webkit, Limits, ProfileFile, MAX_FOLDER_DEPTH, MAX_INPUT_BYTES,
    MAX_JSON_DEPTH, MAX_NODES,
};
pub use error::ImportError;
pub use netscape_bookmarks::{netscape_bookmarks, netscape_bookmarks_with};
