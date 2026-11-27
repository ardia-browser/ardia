use std::collections::BTreeSet;

use ardia_state::history::{History, HistoryEntry};
use ardia_state::omnibox::url::{app_url_origin, display_host, display_url, host_of};
use chrono::{Datelike, Local, LocalResult, NaiveDate, TimeZone, Timelike};

pub const ROW_HEIGHT: f32 = 38.0;
pub const DAY_HEADER: f32 = 44.0;
pub const MANY_LINKS: usize = 15;

const DAYS: [&str; 7] = [
    "Sunday",
    "Monday",
    "Tuesday",
    "Wednesday",
    "Thursday",
    "Friday",
    "Saturday",
];
const MONTHS: [&str; 12] = [
    "January",
    "February",
    "March",
    "April",
    "May",
    "June",
    "July",
    "August",
    "September",
    "October",
    "November",
    "December",
];

fn local_date(ms: i64) -> Option<NaiveDate> {
    match Local.timestamp_millis_opt(ms) {
        LocalResult::Single(at) | LocalResult::Ambiguous(at, _) => Some(at.date_naive()),
        LocalResult::None => None,
    }
}

pub fn day_start(ms: i64) -> i64 {
    let Some(date) = local_date(ms) else {
        return ms;
    };
    date.and_hms_opt(0, 0, 0)
        .and_then(|midnight| Local.from_local_datetime(&midnight).earliest())
        .map_or(ms, |at| at.timestamp_millis())
}

fn next_day_start(start: i64) -> i64 {
    let Some(next) = local_date(start).and_then(|date| date.succ_opt()) else {
        return start + 86_400_000;
    };
    next.and_hms_opt(0, 0, 0)
        .and_then(|midnight| Local.from_local_datetime(&midnight).earliest())
        .map_or(start + 86_400_000, |at| at.timestamp_millis())
}

pub fn day_label(start: i64, now: i64) -> String {
    let Some(date) = local_date(start) else {
        return String::new();
    };
    let full = format!(
        "{}, {} {}, {}",
        DAYS[date.weekday().num_days_from_sunday() as usize],
        MONTHS[date.month0() as usize],
        date.day(),
        date.year()
    );
    let today = day_start(now);
    if start == today {
        format!("Today – {full}")
    } else if start == day_start(today - 1) {
        format!("Yesterday – {full}")
    } else {
        full
    }
}

pub fn time_label(ms: i64) -> String {
    let at = match Local.timestamp_millis_opt(ms) {
        LocalResult::Single(at) | LocalResult::Ambiguous(at, _) => at,
        LocalResult::None => return String::new(),
    };
    let hour = at.hour();
    let twelve = if hour % 12 == 0 { 12 } else { hour % 12 };
    let half = if hour < 12 { "AM" } else { "PM" };
    format!("{twelve}:{:02} {half}", at.minute())
}

pub fn host_label(url: &str) -> String {
    if let Some(origin) = app_url_origin(url) {
        return origin;
    }
    let host = display_host(&host_of(url));
    if host.is_empty() {
        url.to_owned()
    } else {
        host
    }
}

pub fn query_words(query: &str) -> Vec<String> {
    query
        .to_lowercase()
        .split_whitespace()
        .map(str::to_owned)
        .collect()
}

pub fn search_text(fields: &[&str]) -> String {
    fields
        .iter()
        .map(|field| {
            if field.to_ascii_lowercase().contains("xn--") {
                format!("{field} {}", display_url(field))
            } else {
                (*field).to_owned()
            }
        })
        .collect::<Vec<_>>()
        .join(" ")
        .to_lowercase()
}

pub fn matches_query(query: &str, fields: &[&str]) -> bool {
    let words = query_words(query);
    if words.is_empty() {
        return true;
    }
    let hay = search_text(fields);
    words.iter().all(|word| hay.contains(word.as_str()))
}

#[derive(Clone, Debug, PartialEq)]
pub struct HistoryRow {
    pub url: String,
    pub title: String,
    pub favicon: Option<String>,
    pub last_visit: i64,
    pub day: usize,
    pub first: bool,
    pub last: bool,
}

#[derive(Clone, Debug, PartialEq)]
pub enum HistoryItem {
    Day(usize),
    Row(usize),
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct HistoryLayout {
    pub days: Vec<String>,
    pub rows: Vec<HistoryRow>,
    pub items: Vec<HistoryItem>,
}

impl HistoryLayout {
    pub fn urls(&self) -> Vec<String> {
        self.rows.iter().map(|row| row.url.clone()).collect()
    }

    pub fn item_of(&self, url: &str) -> Option<usize> {
        self.items
            .iter()
            .position(|item| matches!(item, HistoryItem::Row(at) if self.rows[*at].url == url))
    }
}

pub fn entries_newest_first(history: Option<&History>) -> Vec<&HistoryEntry> {
    let Some(history) = history else {
        return Vec::new();
    };
    let mut entries: Vec<&HistoryEntry> = history.entries().collect();
    entries.sort_by_key(|entry| std::cmp::Reverse(entry.last_visit));
    entries
}

pub fn layout_history(entries: &[&HistoryEntry], query: &str, now: i64) -> HistoryLayout {
    let words = query_words(query);
    let mut layout = HistoryLayout::default();
    let (mut from, mut to) = (i64::MAX, i64::MIN);
    for entry in entries {
        if !words.is_empty() {
            let hay = search_text(&[&entry.title, &entry.url]);
            if !words.iter().all(|word| hay.contains(word.as_str())) {
                continue;
            }
        }
        let first = entry.last_visit < from || entry.last_visit >= to;
        if first {
            from = day_start(entry.last_visit);
            to = next_day_start(from);
            if let Some(previous) = layout.rows.last_mut() {
                previous.last = true;
            }
            layout.days.push(day_label(from, now));
            layout.items.push(HistoryItem::Day(layout.days.len() - 1));
        }
        layout.items.push(HistoryItem::Row(layout.rows.len()));
        layout.rows.push(HistoryRow {
            url: entry.url.clone(),
            title: entry.title.clone(),
            favicon: entry.favicon.clone(),
            last_visit: entry.last_visit,
            day: layout.days.len() - 1,
            first,
            last: false,
        });
    }
    if let Some(previous) = layout.rows.last_mut() {
        previous.last = true;
    }
    layout
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct RowSelection {
    pub selected: BTreeSet<String>,
    pub anchor: Option<String>,
    pub cursor: Option<String>,
}

fn index_of(urls: &[String], url: &str) -> Option<usize> {
    urls.iter().position(|known| known == url)
}

fn range_of(urls: &[String], from: usize, to: usize) -> &[String] {
    &urls[from.min(to)..=from.max(to)]
}

fn moved_range(urls: &[String], s: &RowSelection, anchor: &str, to: usize) -> RowSelection {
    let from = index_of(urls, anchor).unwrap_or(to);
    let end = s
        .cursor
        .as_deref()
        .and_then(|cursor| index_of(urls, cursor))
        .unwrap_or(from);
    let mut selected = s.selected.clone();
    for url in range_of(urls, from, end) {
        selected.remove(url);
    }
    for url in range_of(urls, from, to) {
        selected.insert(url.clone());
    }
    RowSelection {
        selected,
        anchor: Some(anchor.to_owned()),
        cursor: Some(urls[to].clone()),
    }
}

pub fn toggled_row(urls: &[String], s: &RowSelection, url: &str, shift: bool) -> RowSelection {
    let to = index_of(urls, url);
    if shift
        && let (Some(anchor), Some(to)) = (
            s.anchor.as_deref().filter(|a| index_of(urls, a).is_some()),
            to,
        )
    {
        return moved_range(urls, s, anchor, to);
    }
    let mut selected = s.selected.clone();
    if !selected.remove(url) {
        selected.insert(url.to_owned());
    }
    RowSelection {
        selected,
        anchor: Some(url.to_owned()),
        cursor: Some(url.to_owned()),
    }
}

pub fn moved_cursor(urls: &[String], s: &RowSelection, step: i32, extend: bool) -> RowSelection {
    if urls.is_empty() {
        return s.clone();
    }
    let at = s
        .cursor
        .as_deref()
        .and_then(|cursor| index_of(urls, cursor));
    let index = match at {
        None if step > 0 => 0,
        None => urls.len() - 1,
        Some(at) => (at as i64 + i64::from(step)).clamp(0, urls.len() as i64 - 1) as usize,
    };
    let cursor = urls[index].clone();
    if !extend {
        return RowSelection {
            selected: s.selected.clone(),
            anchor: Some(cursor.clone()),
            cursor: Some(cursor),
        };
    }
    let anchor = s
        .anchor
        .clone()
        .filter(|anchor| index_of(urls, anchor).is_some())
        .or_else(|| at.map(|at| urls[at].clone()))
        .unwrap_or_else(|| cursor.clone());
    let base = if Some(&anchor) == s.anchor.as_ref() {
        s.clone()
    } else {
        RowSelection {
            cursor: Some(anchor.clone()),
            ..s.clone()
        }
    };
    moved_range(urls, &base, &anchor, index)
}

pub fn toggled_cursor(urls: &[String], s: &RowSelection) -> RowSelection {
    match s.cursor.as_deref().filter(|c| index_of(urls, c).is_some()) {
        Some(cursor) => toggled_row(urls, s, cursor, false),
        None => s.clone(),
    }
}

pub fn all_rows(urls: &[String], s: &RowSelection) -> RowSelection {
    RowSelection {
        selected: urls.iter().cloned().collect(),
        ..s.clone()
    }
}

pub fn shown_rows(urls: &[String], s: &RowSelection) -> RowSelection {
    let shown = |url: &String| index_of(urls, url).is_some();
    RowSelection {
        selected: s
            .selected
            .iter()
            .filter(|url| shown(url))
            .cloned()
            .collect(),
        anchor: s.anchor.clone().filter(shown),
        cursor: s.cursor.clone().filter(shown),
    }
}

pub fn without_rows(s: &RowSelection, urls: &[String]) -> RowSelection {
    RowSelection {
        selected: s
            .selected
            .iter()
            .filter(|url| !urls.contains(url))
            .cloned()
            .collect(),
        ..s.clone()
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum RowMenuItem {
    OpenInNewTab,
    OpenInSplitView,
    OpenInNewWindow,
    OpenInIncognitoWindow,
    OpenAllInNewTabs,
    OpenAllInNewWindow,
    OpenAllInIncognitoWindow,
    CopyLink,
    CopyLinkAsMarkdown,
    MoreFromThisSite,
    Remove,
}

pub fn history_row_menu(count: usize, alternate: bool) -> Vec<Vec<(RowMenuItem, String)>> {
    let copy = if alternate {
        (
            RowMenuItem::CopyLinkAsMarkdown,
            if count == 1 {
                "Copy Link as Markdown".to_owned()
            } else {
                format!("Copy {count} Links as Markdown")
            },
        )
    } else {
        (
            RowMenuItem::CopyLink,
            if count == 1 {
                "Copy Link".to_owned()
            } else {
                format!("Copy {count} Links")
            },
        )
    };
    if count > 1 {
        return vec![
            vec![
                (
                    RowMenuItem::OpenAllInNewTabs,
                    format!("Open {count} in New Tabs"),
                ),
                (
                    RowMenuItem::OpenAllInNewWindow,
                    format!("Open {count} in New Window"),
                ),
                (
                    RowMenuItem::OpenAllInIncognitoWindow,
                    format!("Open {count} in Incognito Window"),
                ),
            ],
            vec![copy],
            vec![(
                RowMenuItem::Remove,
                format!("Remove {count} Pages from History…"),
            )],
        ];
    }
    vec![
        vec![
            (RowMenuItem::OpenInNewTab, "Open in New Tab".to_owned()),
            (
                RowMenuItem::OpenInSplitView,
                "Open in Split View".to_owned(),
            ),
            (RowMenuItem::OpenInNewWindow, "New Window".to_owned()),
            (
                RowMenuItem::OpenInIncognitoWindow,
                "Incognito Window".to_owned(),
            ),
        ],
        vec![
            copy,
            (
                RowMenuItem::MoreFromThisSite,
                "More from This Site".to_owned(),
            ),
        ],
        vec![(RowMenuItem::Remove, "Remove from History".to_owned())],
    ]
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(url: &str, title: &str, at: i64) -> HistoryEntry {
        HistoryEntry {
            url: url.into(),
            title: title.into(),
            favicon: None,
            visits: 1,
            last_visit: at,
            visit_times: vec![at],
        }
    }

    fn urls(list: &[&str]) -> Vec<String> {
        list.iter().map(|url| (*url).to_owned()).collect()
    }

    #[test]
    fn labels_read_like_the_old_app() {
        let noon = Local
            .with_ymd_and_hms(2026, 11, 26, 12, 5, 0)
            .single()
            .unwrap()
            .timestamp_millis();
        assert_eq!(time_label(noon), "12:05 PM");
        let morning = noon - 3 * 3_600_000;
        assert_eq!(time_label(morning), "9:05 AM");
        let start = day_start(noon);
        assert_eq!(
            day_label(start, noon),
            "Today – Thursday, November 26, 2026"
        );
        let yesterday = day_start(start - 1);
        assert_eq!(
            day_label(yesterday, noon),
            "Yesterday – Wednesday, November 25, 2026"
        );
        assert_eq!(
            day_label(day_start(yesterday - 1), noon),
            "Tuesday, November 24, 2026"
        );
        assert_eq!(host_label("https://www.example.com/a"), "example.com");
        assert_eq!(host_label("ardia://settings/tabs"), "ardia://settings");
        assert_eq!(host_label("mailto:x"), "mailto:x");
    }

    #[test]
    fn history_groups_by_day_and_filters_every_word() {
        let noon = Local
            .with_ymd_and_hms(2026, 11, 26, 12, 0, 0)
            .single()
            .unwrap()
            .timestamp_millis();
        let list = [
            entry("https://a.example/", "Rust Book", noon),
            entry("https://b.example/", "GPUI notes", noon - 3_600_000),
            entry("https://c.example/", "Rust Blog", noon - 86_400_000),
        ];
        let refs: Vec<&HistoryEntry> = list.iter().collect();
        let layout = layout_history(&refs, "", noon);
        assert_eq!(layout.days.len(), 2);
        assert_eq!(layout.items.len(), 5);
        assert!(layout.rows[0].first && !layout.rows[0].last);
        assert!(layout.rows[1].last && layout.rows[2].first && layout.rows[2].last);
        let found = layout_history(&refs, "rust  BLOG", noon);
        assert_eq!(found.urls(), urls(&["https://c.example/"]));
        assert_eq!(found.item_of("https://c.example/"), Some(1));
        assert!(layout_history(&refs, "nothing", noon).rows.is_empty());
    }

    #[test]
    fn selection_follows_clicks_shift_and_keys() {
        let all = urls(&["a", "b", "c", "d"]);
        let s = toggled_row(&all, &RowSelection::default(), "b", false);
        let s = toggled_row(&all, &s, "d", true);
        assert_eq!(s.selected, urls(&["b", "c", "d"]).into_iter().collect());
        let s = toggled_row(&all, &s, "c", true);
        assert_eq!(s.selected, urls(&["b", "c"]).into_iter().collect());
        let s = moved_cursor(&all, &RowSelection::default(), 1, false);
        assert_eq!(s.cursor.as_deref(), Some("a"));
        let s = moved_cursor(&all, &s, 1, true);
        assert_eq!(s.selected, urls(&["a", "b"]).into_iter().collect());
        let s = toggled_cursor(&all, &s);
        assert_eq!(s.selected, urls(&["a"]).into_iter().collect());
        let s = all_rows(&all, &s);
        assert_eq!(s.selected.len(), 4);
        let s = shown_rows(&urls(&["a", "c"]), &s);
        assert_eq!(s.selected, urls(&["a", "c"]).into_iter().collect());
        assert_eq!(s.cursor, None);
        let s = without_rows(&s, &urls(&["a"]));
        assert_eq!(s.selected, urls(&["c"]).into_iter().collect());
    }

    #[test]
    fn menus_match_the_old_app() {
        let one = history_row_menu(1, false);
        assert_eq!(one[0][0].1, "Open in New Tab");
        assert_eq!(one[1][1].1, "More from This Site");
        assert_eq!(one[2][0].1, "Remove from History");
        let many = history_row_menu(3, false);
        assert_eq!(many[0][0].1, "Open 3 in New Tabs");
        assert_eq!(many[1][0].1, "Copy 3 Links");
        assert_eq!(many[2][0].1, "Remove 3 Pages from History…");
        assert_eq!(history_row_menu(1, true)[1][0].1, "Copy Link as Markdown");
    }
}
