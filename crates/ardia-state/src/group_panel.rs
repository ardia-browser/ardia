use std::collections::{HashMap, HashSet};

use crate::groups::Groups;
use crate::ids::TabId;
use crate::omnibox::url::host_of;

#[derive(Clone, Debug, PartialEq)]
pub struct PanelTab {
    pub id: TabId,
    pub title: String,
    pub url: String,
    pub used_at: i64,
}

pub fn group_tab_ids(groups: &Groups, group: &str) -> Vec<TabId> {
    let mut children: HashMap<&str, Vec<&str>> = HashMap::new();
    for g in groups.values() {
        if let Some(parent) = &g.parent_id {
            children
                .entry(parent.as_str())
                .or_default()
                .push(g.id.as_str());
        }
    }
    let mut seen_groups: HashSet<&str> = HashSet::new();
    let mut seen_tabs: HashSet<&TabId> = HashSet::new();
    let mut out = Vec::new();
    let mut stack = vec![group];
    while let Some(id) = stack.pop() {
        let Some(g) = groups.get(id) else {
            continue;
        };
        if !seen_groups.insert(id) {
            continue;
        }
        for tab in &g.tab_ids {
            if seen_tabs.insert(tab) {
                out.push(tab.clone());
            }
        }
        if let Some(kids) = children.get(id) {
            stack.extend(kids.iter().rev());
        }
    }
    out
}

pub fn by_recent_use(mut rows: Vec<PanelTab>) -> Vec<PanelTab> {
    rows.sort_by_key(|row| std::cmp::Reverse(row.used_at));
    rows
}

fn words(text: &str) -> Vec<String> {
    text.to_lowercase()
        .split(|c: char| !c.is_ascii_lowercase() && !c.is_ascii_digit())
        .filter(|w| !w.is_empty())
        .map(str::to_owned)
        .collect()
}

fn is_subsequence(needle: &str, haystack: &str) -> bool {
    let mut wanted = needle.chars().peekable();
    for c in haystack.chars() {
        if wanted.peek() == Some(&c) {
            wanted.next();
        }
    }
    wanted.peek().is_none()
}

pub fn fuzzy_score(query: &str, text: &str) -> f64 {
    let q = query.trim().to_lowercase();
    let t = text.to_lowercase();
    if q.is_empty() {
        return 0.0;
    }
    if t == q {
        return 1000.0;
    }
    let tw = words(&t);
    let mut score: f64 = if t.starts_with(&q) { 200.0 } else { 0.0 };
    let squashed: String = t
        .chars()
        .filter(|c| c.is_ascii_lowercase() || c.is_ascii_digit())
        .collect();
    for token in words(&q) {
        let len = token.chars().count() as f64;
        if let Some(i) = tw.iter().position(|w| w.starts_with(&token)) {
            score += 60.0 + len * 4.0 - i as f64 * 2.0;
        } else if len >= 3.0 && t.contains(&token) {
            score += 25.0 + len;
        } else if len >= 2.0 && is_subsequence(&token, &squashed) {
            score += 8.0;
        } else {
            return 0.0;
        }
    }
    score - tw.len() as f64
}

pub fn matching_rows(query: &str, rows: &[PanelTab]) -> Vec<PanelTab> {
    let q = query.trim().to_lowercase();
    if q.is_empty() {
        return rows.to_vec();
    }
    let mut scored: Vec<(f64, usize, &PanelTab)> = rows
        .iter()
        .enumerate()
        .filter_map(|(order, row)| {
            let score = fuzzy_score(&q, &row.title)
                .max(fuzzy_score(&q, &host_of(&row.url)) * 0.9)
                .max(fuzzy_score(&q, &row.url) * 0.6);
            let contains =
                row.title.to_lowercase().contains(&q) || row.url.to_lowercase().contains(&q);
            let score = if score > 0.0 {
                score
            } else if contains {
                1.0
            } else {
                0.0
            };
            (score > 0.0).then_some((score, order, row))
        })
        .collect();
    scored.sort_by(|a, b| b.0.total_cmp(&a.0).then(a.1.cmp(&b.1)));
    scored.into_iter().map(|(_, _, row)| row.clone()).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn row(id: &str, title: &str, url: &str, used_at: i64) -> PanelTab {
        PanelTab {
            id: TabId::new(id),
            title: title.into(),
            url: url.into(),
            used_at,
        }
    }

    #[test]
    fn rows_sort_by_recent_use_and_match_titles_before_urls() {
        let rows = by_recent_use(vec![
            row("a", "Pull requests", "https://github.com/pulls", 1),
            row("b", "Inbox", "https://mail.google.com/", 3),
            row("c", "Docs", "https://docs.example/pull", 2),
        ]);
        assert_eq!(rows[0].id.as_str(), "b");
        let found = matching_rows("pull", &rows);
        assert_eq!(found[0].id.as_str(), "a");
        assert_eq!(found.len(), 2);
        assert!(matching_rows("zzz", &rows).is_empty());
        assert_eq!(matching_rows("  ", &rows).len(), 3);
    }

    #[test]
    fn fuzzy_scores_follow_the_core_rules() {
        assert_eq!(fuzzy_score("inbox", "Inbox"), 1000.0);
        assert!(fuzzy_score("gh", "GitHub") > 0.0);
        assert_eq!(fuzzy_score("xq", "GitHub"), 0.0);
    }
}
