use ardia_import_core::{
    BookmarkNode, ImportError, MAX_INPUT_BYTES, ProfileFile, chromium_bookmarks, netscape_bookmarks,
};
use std::fs;
use std::io::Read;
use std::path::Path;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum BookmarkSource {
    Chromium,
    NetscapeHtml,
}

fn read_capped(path: &Path) -> std::io::Result<Option<Vec<u8>>> {
    let file = match fs::File::open(path) {
        Ok(file) => file,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(e),
    };
    let mut bytes = Vec::new();
    file.take(MAX_INPUT_BYTES as u64 + 1)
        .read_to_end(&mut bytes)?;
    Ok(Some(bytes))
}

fn profile_file(bytes: &Option<Vec<u8>>) -> ProfileFile<'_> {
    match bytes {
        None => ProfileFile::Missing,
        Some(b) if b.len() > MAX_INPUT_BYTES => ProfileFile::Oversized,
        Some(b) => ProfileFile::Bytes(b),
    }
}

#[derive(Debug, thiserror::Error)]
pub enum ImportFailure {
    #[error("couldn't read the file: {0}")]
    Io(#[from] std::io::Error),
    #[error("the bookmarks couldn't be read: {0}")]
    Parse(ImportError),
}

pub fn import_chromium_profile(profile_dir: &Path) -> Result<BookmarkNode, ImportFailure> {
    let bookmarks = read_capped(&profile_dir.join("Bookmarks"))?;
    let account = read_capped(&profile_dir.join("AccountBookmarks"))?;
    chromium_bookmarks(profile_file(&bookmarks), profile_file(&account))
        .map_err(ImportFailure::Parse)
}

pub fn import_bookmarks_bytes(
    source: BookmarkSource,
    bytes: &[u8],
) -> Result<BookmarkNode, ImportFailure> {
    let file = if bytes.len() > MAX_INPUT_BYTES {
        ProfileFile::Oversized
    } else {
        ProfileFile::Bytes(bytes)
    };
    match source {
        BookmarkSource::Chromium => chromium_bookmarks(file, ProfileFile::Missing),
        BookmarkSource::NetscapeHtml => netscape_bookmarks(file),
    }
    .map_err(ImportFailure::Parse)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn netscape_html_imports_folders_and_links() {
        let html = br#"<!DOCTYPE NETSCAPE-Bookmark-file-1>
<DL><p>
<DT><H3>Work</H3>
<DL><p><DT><A HREF="https://a.example/" ADD_DATE="1700000000">A</A></DL><p>
<DT><A HREF="https://b.example/">B</A>
</DL><p>"#;
        let tree = import_bookmarks_bytes(BookmarkSource::NetscapeHtml, html).unwrap();
        assert_eq!(tree.link_count(), 2);
    }

    #[test]
    fn missing_profiles_and_garbage_fail_cleanly() {
        let dir = tempfile::tempdir().unwrap();
        assert!(matches!(
            import_chromium_profile(dir.path()),
            Err(ImportFailure::Parse(ImportError::NotFound))
        ));
        std::fs::write(dir.path().join("Bookmarks"), b"{not json").unwrap();
        assert!(matches!(
            import_chromium_profile(dir.path()),
            Err(ImportFailure::Parse(_))
        ));
        assert!(matches!(
            import_bookmarks_bytes(BookmarkSource::Chromium, &vec![b' '; MAX_INPUT_BYTES + 1]),
            Err(ImportFailure::Parse(ImportError::TooLarge))
        ));
    }
}
