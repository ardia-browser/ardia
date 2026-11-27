use std::path::Path;

use super::sqlite::Snapshot;
use super::{HistoryEntry, is_web_url, webkit_to_unix_ms};

pub fn read(profile: &Path) -> Result<Vec<HistoryEntry>, String> {
    let file = profile.join("History");
    let db = Snapshot::copying(&file)?;
    if !db.table_exists("urls") {
        return Err("History has no urls table".into());
    }
    let sql = "SELECT url, title, visit_count, last_visit_time FROM urls \
               WHERE hidden = 0 AND last_visit_time > 0 AND (url LIKE 'http://%' OR url LIKE 'https://%') \
               ORDER BY last_visit_time DESC";
    let mut out = Vec::new();
    db.query(sql, |row| {
        if let Some(url) = row.text("url").filter(|u| is_web_url(u)) {
            out.push(HistoryEntry {
                url,
                title: row.text("title").unwrap_or_default(),
                visits: row
                    .int("visit_count")
                    .unwrap_or(1)
                    .clamp(1, i64::from(u32::MAX)) as u32,
                last_visit_ms: row
                    .int("last_visit_time")
                    .and_then(webkit_to_unix_ms)
                    .unwrap_or(0.0),
            });
        }
        true
    })?;
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::import_readers::fixture;

    #[test]
    fn chrome_history_reads_web_pages_newest_first_and_leaves_the_file_alone() {
        let profile = fixture("home/Library/Application Support/Google/Chrome/Default");
        let before = std::fs::read(profile.join("History")).unwrap();
        let entries = read(&profile).unwrap();
        assert!(!entries.is_empty());
        assert!(
            entries
                .iter()
                .all(|e| is_web_url(&e.url) && e.last_visit_ms > 0.0)
        );
        assert!(
            entries
                .windows(2)
                .all(|w| w[0].last_visit_ms >= w[1].last_visit_ms)
        );
        assert_eq!(std::fs::read(profile.join("History")).unwrap(), before);
        assert!(!profile.join("History-journal").exists());
    }
}
