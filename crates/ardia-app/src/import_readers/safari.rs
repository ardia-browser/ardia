use std::path::{Path, PathBuf};

use ardia_import_core::BookmarkNode;
use ardia_state::import::{BookmarkSource, import_bookmarks_bytes};
use serde_json::Value;

use super::plist::{COCOA_EPOCH_SECONDS, Plist, parse_binary};
use super::sqlite::Snapshot;
use super::{Credential, HistoryEntry, is_web_url};

pub const FULL_DISK_ACCESS_NEEDED: &str = "Ardia needs Full Disk Access to read Safari's data.";
pub const NOT_AN_EXPORT: &str =
    "This doesn't look like a Safari export. Choose the .zip file Safari saved.";

#[derive(Clone, Debug, Default, PartialEq)]
pub struct SafariProfile {
    pub name: Option<String>,
    pub history: Vec<HistoryEntry>,
    pub extensions: Vec<String>,
}

#[derive(Clone, Debug, Default)]
pub struct SafariData {
    pub bookmarks: Option<BookmarkNode>,
    pub credentials: Vec<Credential>,
    pub cards: Vec<super::ImportedCard>,
    pub cookies: Vec<super::chromium_secrets::Cookie>,
    pub tabs: Vec<SafariTab>,
    pub profiles: Vec<SafariProfile>,
    pub warnings: Vec<String>,
}

impl SafariData {
    pub fn history(&self) -> Vec<HistoryEntry> {
        self.profiles
            .iter()
            .flat_map(|p| p.history.iter().cloned())
            .collect()
    }

    fn profile_mut(&mut self, name: Option<String>) -> &mut SafariProfile {
        match self.profiles.iter().position(|p| p.name == name) {
            Some(index) => &mut self.profiles[index],
            None => {
                self.profiles.push(SafariProfile {
                    name,
                    ..SafariProfile::default()
                });
                self.profiles.last_mut().expect("just pushed")
            }
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SafariTab {
    pub url: String,
    pub title: String,
    pub window: usize,
    pub active: bool,
}

pub fn tabs(file: &Path) -> Vec<SafariTab> {
    let Some(top) = std::fs::read(file)
        .ok()
        .and_then(|bytes| parse_binary(&bytes))
    else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for (window, entry) in top
        .get("SessionWindows")
        .map(Plist::as_array)
        .unwrap_or_default()
        .iter()
        .enumerate()
    {
        let selected = entry
            .get("SelectedTabIndex")
            .and_then(Plist::as_int)
            .unwrap_or(0);
        for (index, tab) in entry
            .get("TabStates")
            .map(Plist::as_array)
            .unwrap_or_default()
            .iter()
            .enumerate()
        {
            let Some(url) = tab
                .get("TabURL")
                .and_then(Plist::as_str)
                .filter(|u| is_web_url(u))
            else {
                continue;
            };
            out.push(SafariTab {
                url: url.to_owned(),
                title: tab
                    .get("TITLE")
                    .and_then(Plist::as_str)
                    .unwrap_or_default()
                    .to_owned(),
                window,
                active: index as i64 == selected,
            });
        }
    }
    out
}

pub fn directory(home: &Path) -> PathBuf {
    home.join("Library/Safari")
}

pub fn has_access(home: &Path) -> bool {
    let dir = directory(home);
    ["Bookmarks.plist", "History.db"]
        .iter()
        .map(|name| dir.join(name))
        .filter(|file| file.exists())
        .any(|file| std::fs::File::open(file).is_ok())
}

fn role(mut node: BookmarkNode, source: &Plist) -> BookmarkNode {
    let id = source
        .get("WebBookmarkIdentifier")
        .or_else(|| source.get("Title"))
        .and_then(Plist::as_str)
        .unwrap_or_default();
    let (role, title) = match id {
        "BookmarksBar" => ("toolbar", Some("Bookmarks Bar")),
        "BookmarksMenu" => ("menu", Some("Bookmarks Menu")),
        "com.apple.ReadingList" => ("readingList", Some("Reading List")),
        _ => ("other", None),
    };
    node.role = Some(role.to_owned());
    if let Some(title) = title {
        node.title = title.to_owned();
    }
    node
}

fn bookmark(source: &Plist) -> Option<BookmarkNode> {
    match source.get("WebBookmarkType").and_then(Plist::as_str)? {
        "WebBookmarkTypeLeaf" => {
            let url = source
                .get("URLString")
                .and_then(Plist::as_str)
                .filter(|u| !u.is_empty())?;
            let title = source
                .get("URIDictionary")
                .and_then(|d| d.get("title"))
                .and_then(Plist::as_str)
                .unwrap_or(url);
            let added = source
                .get("ReadingList")
                .and_then(|r| r.get("DateAdded"))
                .and_then(Plist::unix_ms);
            Some(BookmarkNode::link(title, url, added))
        }
        "WebBookmarkTypeList" => {
            let kids: Vec<BookmarkNode> = source
                .get("Children")
                .map(Plist::as_array)
                .unwrap_or_default()
                .iter()
                .filter_map(bookmark)
                .collect();
            if kids.is_empty() && source.get("WebBookmarkIdentifier").is_some() {
                return None;
            }
            let title = source
                .get("Title")
                .and_then(Plist::as_str)
                .unwrap_or_default();
            Some(BookmarkNode::folder(title, kids, None))
        }
        _ => None,
    }
}

pub fn bookmarks(file: &Path) -> Result<BookmarkNode, String> {
    let bytes = std::fs::read(file).map_err(|_| "No Safari bookmarks".to_owned())?;
    let top = parse_binary(&bytes).ok_or("Bookmarks.plist isn't a Safari bookmarks file")?;
    let children = top
        .get("Children")
        .map(Plist::as_array)
        .unwrap_or_default()
        .iter()
        .filter_map(|child| bookmark(child).map(|node| role(node, child)))
        .collect();
    Ok(BookmarkNode::folder("Bookmarks", children, None))
}

pub fn history(file: &Path) -> Result<Vec<HistoryEntry>, String> {
    if !file.exists() {
        return Err("No Safari history".into());
    }
    let db = Snapshot::copying(file)?;
    if !db.table_exists("history_items") || !db.table_exists("history_visits") {
        return Err("History.db isn't a Safari history database".into());
    }
    let sql = "SELECT i.url AS url, i.visit_count AS visit_count, MAX(v.visit_time) AS visit_time, \
               (SELECT title FROM history_visits WHERE history_item = i.id AND title IS NOT NULL \
                ORDER BY visit_time DESC LIMIT 1) AS title \
               FROM history_items i JOIN history_visits v ON v.history_item = i.id \
               GROUP BY i.id ORDER BY visit_time DESC";
    let mut out = Vec::new();
    db.query(sql, |row| {
        if let Some(url) = row.text("url").filter(|u| is_web_url(u)) {
            let seconds = row.int("visit_time").unwrap_or(0);
            out.push(HistoryEntry {
                url,
                title: row.text("title").unwrap_or_default(),
                visits: row
                    .int("visit_count")
                    .unwrap_or(1)
                    .clamp(1, i64::from(u32::MAX)) as u32,
                last_visit_ms: if seconds > 0 {
                    (seconds as f64 + COCOA_EPOCH_SECONDS) * 1000.0
                } else {
                    0.0
                },
            });
        }
        true
    })?;
    Ok(out)
}

pub fn load_direct_with(home: &Path, cookies: bool, now_ms: f64) -> Result<SafariData, String> {
    let mut out = load_direct(home)?;
    if cookies {
        match super::safari_cookies::load(home, now_ms) {
            Ok(found) => out.cookies = found,
            Err(problem) => out.warnings.push(problem),
        }
    }
    Ok(out)
}

pub fn load_direct(home: &Path) -> Result<SafariData, String> {
    if !has_access(home) {
        return Err(FULL_DISK_ACCESS_NEEDED.into());
    }
    let dir = directory(home);
    let mut out = SafariData::default();
    match bookmarks(&dir.join("Bookmarks.plist")) {
        Ok(tree) => out.bookmarks = Some(tree),
        Err(problem) => out.warnings.push(problem),
    }
    out.tabs = tabs(&dir.join("LastSession.plist"));
    match history(&dir.join("History.db")) {
        Ok(entries) => out.profiles.push(SafariProfile {
            name: None,
            history: entries,
            extensions: Vec::new(),
        }),
        Err(problem) => out.warnings.push(problem),
    }
    Ok(out)
}

pub fn profile_name(file: &str) -> Option<String> {
    let stem = Path::new(file).file_stem()?.to_string_lossy().into_owned();
    for separator in [" - ", "_"] {
        if let Some(at) = stem.find(separator) {
            let name = stem[at + separator.len()..].trim();
            return (!name.is_empty()).then(|| name.to_owned());
        }
    }
    None
}

pub fn export_history(rows: &[Value]) -> Vec<HistoryEntry> {
    let mut out: Vec<HistoryEntry> = rows
        .iter()
        .filter_map(|row| {
            let url = row.get("url")?.as_str().filter(|u| is_web_url(u))?;
            if row.get("destination_url").is_some() {
                return None;
            }
            let micros = row.get("time_usec").and_then(Value::as_i64).unwrap_or(0);
            let visits = row
                .get("visit_count")
                .or_else(|| row.get("visits_count"))
                .and_then(Value::as_u64)
                .unwrap_or(1);
            Some(HistoryEntry {
                url: url.to_owned(),
                title: row
                    .get("title")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_owned(),
                visits: visits.clamp(1, u64::from(u32::MAX)) as u32,
                last_visit_ms: if micros > 0 {
                    micros as f64 / 1000.0
                } else {
                    0.0
                },
            })
        })
        .collect();
    out.sort_by(|a, b| b.last_visit_ms.total_cmp(&a.last_visit_ms));
    out
}

pub fn parse_export(mut files: Vec<(String, Vec<u8>)>) -> Result<SafariData, String> {
    files.retain(|(name, _)| !name.starts_with('.'));
    files.sort_by(|a, b| a.0.cmp(&b.0));
    let mut out = SafariData::default();
    let mut recognised = false;
    for (name, data) in files {
        let ext = Path::new(&name)
            .extension()
            .map(|e| e.to_string_lossy().to_lowercase())
            .unwrap_or_default();
        match ext.as_str() {
            "html" | "htm" => {
                let text = String::from_utf8_lossy(&data);
                if !text.to_lowercase().contains("netscape-bookmark-file") {
                    continue;
                }
                recognised = true;
                match import_bookmarks_bytes(BookmarkSource::NetscapeHtml, &data) {
                    Ok(parsed) => match out.bookmarks.as_mut() {
                        None => out.bookmarks = Some(parsed),
                        Some(existing) => existing
                            .children
                            .get_or_insert_with(Vec::new)
                            .extend(parsed.children.unwrap_or_default()),
                    },
                    Err(problem) => out
                        .warnings
                        .push(format!("Couldn't read {name}: {problem}")),
                }
            }
            "csv" => {
                recognised = true;
                let text = String::from_utf8_lossy(&data);
                match super::csv::passwords(&text) {
                    Ok(found) => out.credentials.extend(found),
                    Err(problem) => out
                        .warnings
                        .push(format!("Couldn't read {name}: {problem}")),
                }
            }
            "json" => {
                if data.windows(15).any(|w| w == b"\"payment_cards\"") {
                    recognised = true;
                    match super::payment_cards(&data) {
                        Ok(found) => out.cards.extend(found),
                        Err(problem) => out
                            .warnings
                            .push(format!("Couldn't read {name}: {problem}")),
                    }
                    continue;
                }
                let Ok(top) = serde_json::from_slice::<Value>(&data) else {
                    out.warnings.push(format!("Couldn't read {name}"));
                    continue;
                };
                let kind = top
                    .pointer("/metadata/data_type")
                    .and_then(Value::as_str)
                    .map(str::to_owned)
                    .unwrap_or_else(|| {
                        if top.get("history").is_some() {
                            "history".into()
                        } else if top.get("extensions").is_some() {
                            "extensions".into()
                        } else {
                            String::new()
                        }
                    });
                let profile = profile_name(&name);
                match kind.as_str() {
                    "history" => {
                        recognised = true;
                        let rows = top
                            .get("history")
                            .and_then(Value::as_array)
                            .cloned()
                            .unwrap_or_default();
                        let entries = export_history(&rows);
                        out.profile_mut(profile).history.extend(entries);
                    }
                    "extensions" => {
                        recognised = true;
                        let names: Vec<String> = top
                            .get("extensions")
                            .and_then(Value::as_array)
                            .map(|list| {
                                list.iter()
                                    .filter_map(|e| {
                                        e.get("display_name")?.as_str().map(str::to_owned)
                                    })
                                    .collect()
                            })
                            .unwrap_or_default();
                        out.profile_mut(profile).extensions.extend(names);
                    }
                    _ => {}
                }
            }
            _ => {}
        }
    }
    if !recognised {
        return Err(NOT_AN_EXPORT.into());
    }
    Ok(out)
}

pub fn load_export(path: &Path) -> Result<SafariData, String> {
    let name = path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    if !path.exists() {
        return Err(format!("{name} doesn't exist"));
    }
    let mut files = Vec::new();
    if path.is_dir() {
        let mut stack = vec![path.to_path_buf()];
        while let Some(dir) = stack.pop() {
            let Ok(read) = std::fs::read_dir(&dir) else {
                continue;
            };
            for entry in read.flatten() {
                let file = entry.path();
                let Ok(kind) = entry.file_type() else {
                    continue;
                };
                if kind.is_dir() {
                    stack.push(file);
                } else if kind.is_file()
                    && let Ok(bytes) = std::fs::read(&file)
                {
                    files.push((entry.file_name().to_string_lossy().into_owned(), bytes));
                }
            }
        }
    } else {
        let data = std::fs::read(path).map_err(|e| format!("Couldn't read {name}: {e}"))?;
        let archive = super::zip::Archive::open(&data)?;
        for entry in &archive.entries {
            if entry.name.ends_with('/') || entry.name.starts_with("__MACOSX/") {
                continue;
            }
            let base = entry
                .name
                .rsplit('/')
                .next()
                .unwrap_or(&entry.name)
                .to_owned();
            files.push((base, archive.extract(entry)?));
        }
    }
    parse_export(files)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::import_readers::fixture;

    #[test]
    fn direct_bookmarks_keep_roles_titles_and_reading_list_dates() {
        let tree = bookmarks(&fixture("home/Library/Safari/Bookmarks.plist")).unwrap();
        let roles: Vec<Option<&str>> = tree
            .children
            .as_ref()
            .unwrap()
            .iter()
            .map(|c| c.role.as_deref())
            .collect();
        assert!(roles.contains(&Some("toolbar")));
        assert!(roles.contains(&Some("readingList")));
        let bar = &tree.children.as_ref().unwrap()[0];
        assert_eq!(bar.title, "Bookmarks Bar");
        assert!(tree.link_count() >= 3);
        let reading = tree
            .children
            .as_ref()
            .unwrap()
            .iter()
            .find(|c| c.role.as_deref() == Some("readingList"))
            .unwrap();
        assert!(reading.children.as_ref().unwrap()[0].date_added.is_some());
    }

    #[test]
    fn last_session_tabs_are_read_per_window() {
        let found = tabs(&fixture("home/Library/Safari/LastSession.plist"));
        assert!(!found.is_empty());
        assert!(found.iter().all(|t| is_web_url(&t.url)));
        assert!(tabs(&fixture("nope.plist")).is_empty());
    }

    #[test]
    fn direct_history_reads_web_urls_newest_first() {
        let entries = history(&fixture("home/Library/Safari/History.db")).unwrap();
        assert!(!entries.is_empty());
        assert!(entries.iter().all(|e| is_web_url(&e.url) && e.visits >= 1));
        assert!(
            entries
                .windows(2)
                .all(|w| w[0].last_visit_ms >= w[1].last_visit_ms)
        );
    }

    #[test]
    fn the_export_reads_the_same_from_the_zip_and_the_folder() {
        for path in ["safari/Safari Export", "safari/Safari Export.zip"] {
            let data = load_export(&fixture(path)).unwrap();
            assert!(
                data.bookmarks.as_ref().is_some_and(|b| b.link_count() > 0),
                "{path}"
            );
            assert!(!data.credentials.is_empty());
            assert!(data.history().iter().all(|e| is_web_url(&e.url)));
            assert!(
                !data
                    .history()
                    .iter()
                    .any(|e| e.url == "https://maps.apple.example/"),
                "redirect sources are skipped"
            );
            assert!(
                data.profiles
                    .iter()
                    .any(|p| p.name.as_deref() == Some("Work"))
            );
            assert!(
                data.profiles
                    .iter()
                    .any(|p| p.extensions.contains(&"Example Blocker".to_owned()))
            );
        }
        assert_eq!(
            load_export(&fixture("safari/not-an-export.zip")).unwrap_err(),
            NOT_AN_EXPORT
        );
    }

    #[test]
    fn export_profile_names_come_from_file_names() {
        assert_eq!(profile_name("History_Work.json"), Some("Work".into()));
        assert_eq!(
            profile_name("History - Personal.json"),
            Some("Personal".into())
        );
        assert_eq!(profile_name("History.json"), None);
    }
}
