use crate::json;
use crate::model::Millis;
use crate::omnibox::suggest::{PageRow, page_key};
use indexmap::IndexMap;
use serde::{Deserialize, Serialize};

pub const MAX_ENTRIES: usize = 100_000;
pub const MAX_VISIT_TIMES: usize = 50;
const DAY_MS: i64 = 86_400_000;

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryEntry {
    pub url: String,
    #[serde(default, deserialize_with = "json::lenient")]
    pub title: String,
    #[serde(default, deserialize_with = "json::lenient")]
    pub favicon: Option<String>,
    #[serde(default, deserialize_with = "json::lenient")]
    pub visits: u32,
    #[serde(default, deserialize_with = "json::millis")]
    pub last_visit: Millis,
    #[serde(
        default,
        skip_serializing_if = "Vec::is_empty",
        deserialize_with = "json::lenient"
    )]
    pub visit_times: Vec<Millis>,
}

impl HistoryEntry {
    pub fn frecency(&self, now: Millis) -> f64 {
        let weight = |at: Millis| match (now - at) / DAY_MS {
            0..=3 => 100.0,
            4..=13 => 70.0,
            14..=30 => 50.0,
            31..=89 => 30.0,
            _ => 10.0,
        };
        let samples: Vec<Millis> = if self.visit_times.is_empty() {
            vec![self.last_visit]
        } else {
            self.visit_times.clone()
        };
        let mean = samples.iter().map(|&at| weight(at)).sum::<f64>() / samples.len() as f64;
        mean * f64::from(self.visits.max(1))
    }

    pub fn row(&self) -> PageRow<'_> {
        PageRow {
            url: &self.url,
            title: &self.title,
            favicon: self.favicon.as_deref(),
            visits: self.visits,
            last_visit: self.last_visit,
        }
    }
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct History {
    entries: IndexMap<String, HistoryEntry>,
}

impl History {
    pub fn from_entries(entries: impl IntoIterator<Item = HistoryEntry>) -> Self {
        let mut history = History::default();
        for entry in entries {
            history.entries.insert(page_key(&entry.url), entry);
        }
        history.trim();
        history
    }

    pub fn len(&self) -> usize {
        self.entries.len()
    }

    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }

    pub fn get(&self, url: &str) -> Option<&HistoryEntry> {
        self.entries.get(&page_key(url))
    }

    pub fn record_visit(&mut self, url: &str, title: &str, favicon: Option<&str>, at: Millis) {
        if url.is_empty() || crate::omnibox::url::is_javascript_url(url) {
            return;
        }
        let key = page_key(url);
        let entry = self.entries.entry(key).or_insert_with(|| HistoryEntry {
            url: url.to_owned(),
            title: String::new(),
            favicon: None,
            visits: 0,
            last_visit: at,
            visit_times: Vec::new(),
        });
        entry.url = url.to_owned();
        if !title.is_empty() {
            entry.title = title.to_owned();
        }
        if favicon.is_some() {
            entry.favicon = favicon.map(str::to_owned);
        }
        entry.visits = entry.visits.saturating_add(1);
        entry.last_visit = entry.last_visit.max(at);
        entry.visit_times.push(at);
        let over = entry.visit_times.len().saturating_sub(MAX_VISIT_TIMES);
        entry.visit_times.drain(..over);
        self.trim();
    }

    pub fn set_title(&mut self, url: &str, title: &str) -> bool {
        match self.entries.get_mut(&page_key(url)) {
            Some(entry) if entry.title != title => {
                entry.title = title.to_owned();
                true
            }
            _ => false,
        }
    }

    pub fn remove(&mut self, url: &str) -> bool {
        self.entries.shift_remove(&page_key(url)).is_some()
    }

    pub fn remove_between(&mut self, from: Millis, to: Millis) -> usize {
        let before = self.entries.len();
        self.entries
            .retain(|_, e| e.last_visit < from || e.last_visit >= to);
        before - self.entries.len()
    }

    pub fn clear(&mut self) {
        self.entries.clear();
    }

    fn trim(&mut self) {
        if self.entries.len() <= MAX_ENTRIES {
            return;
        }
        self.entries
            .sort_by(|_, a, _, b| b.last_visit.cmp(&a.last_visit));
        self.entries.truncate(MAX_ENTRIES);
    }

    pub fn entries(&self) -> impl Iterator<Item = &HistoryEntry> {
        self.entries.values()
    }

    pub fn rows(&self) -> impl Iterator<Item = PageRow<'_>> {
        self.entries.values().map(HistoryEntry::row)
    }

    pub fn recent(&self, limit: usize) -> Vec<&HistoryEntry> {
        let mut list: Vec<&HistoryEntry> = self.entries.values().collect();
        list.sort_by_key(|e| std::cmp::Reverse(e.last_visit));
        list.truncate(limit);
        list
    }

    pub fn top_sites(&self, limit: usize, now: Millis) -> Vec<&HistoryEntry> {
        let mut list: Vec<&HistoryEntry> = self.entries.values().collect();
        list.sort_by(|a, b| b.frecency(now).total_cmp(&a.frecency(now)));
        list.truncate(limit);
        list
    }

    pub fn search(&self, text: &str, limit: usize) -> Vec<&HistoryEntry> {
        let needle = text.trim().to_lowercase();
        if needle.is_empty() {
            return self.recent(limit);
        }
        let mut found: Vec<&HistoryEntry> = self
            .entries
            .values()
            .filter(|e| {
                e.url.to_lowercase().contains(&needle) || e.title.to_lowercase().contains(&needle)
            })
            .collect();
        found.sort_by_key(|e| std::cmp::Reverse(e.last_visit));
        found.truncate(limit);
        found
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const NOW: Millis = 1_795_656_501_578;

    #[test]
    fn visits_accumulate_per_page_and_keep_recent_times() {
        let mut history = History::default();
        for i in 0..60 {
            history.record_visit("https://a.example/x#frag", "A", None, NOW - i);
        }
        history.record_visit(
            "https://a.example/x",
            "",
            Some("https://a.example/f.ico"),
            NOW + 1,
        );
        let entry = history.get("https://a.example/x").unwrap();
        assert_eq!(entry.visits, 61);
        assert_eq!(entry.title, "A");
        assert_eq!(entry.visit_times.len(), MAX_VISIT_TIMES);
        assert_eq!(entry.last_visit, NOW + 1);
        assert_eq!(history.len(), 1);
        history.record_visit("javascript:alert(1)", "x", None, NOW);
        history.record_visit("", "x", None, NOW);
        assert_eq!(history.len(), 1);
    }

    #[test]
    fn frecency_prefers_recent_frequent_pages() {
        let fresh = HistoryEntry {
            url: "a".into(),
            title: String::new(),
            favicon: None,
            visits: 5,
            last_visit: NOW,
            visit_times: vec![NOW],
        };
        let stale = HistoryEntry {
            last_visit: NOW - 200 * DAY_MS,
            visit_times: vec![NOW - 200 * DAY_MS],
            ..fresh.clone()
        };
        assert!(fresh.frecency(NOW) > stale.frecency(NOW));
        let mut history = History::from_entries([
            stale,
            HistoryEntry {
                url: "b".into(),
                ..fresh
            },
        ]);
        assert_eq!(history.top_sites(1, NOW)[0].url, "b");
        assert_eq!(history.search("B", 5).len(), 1);
        assert_eq!(
            history.remove_between(NOW - 300 * DAY_MS, NOW - 100 * DAY_MS),
            1
        );
        assert!(history.remove("b"));
        assert!(history.is_empty());
    }
}
