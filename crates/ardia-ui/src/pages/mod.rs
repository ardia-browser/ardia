pub mod bookmarks;
pub mod downloads;
pub mod history;
pub mod history_model;
pub mod links;
pub mod reader;
mod shell;

use ardia_state::omnibox::url::encode_uri_component;
use ardia_state::{BrowserState, TabId, WindowId};
use gpui::{AnyElement, IntoElement};

use crate::primitives::icons::Icon;
use crate::window::chrome::Chrome;

pub const SCHEME: &str = "ardia://";
pub const MAX_QUERY: usize = 512;

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum InternalPage {
    NewTab,
    History { query: String },
    Bookmarks { query: String },
    Downloads,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum PageKind {
    NewTab,
    History,
    Bookmarks,
    Downloads,
}

fn percent_decode(text: &str) -> String {
    let bytes = text.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut at = 0;
    while at < bytes.len() {
        let hex = |b: u8| (b as char).to_digit(16);
        match bytes[at] {
            b'%' if at + 2 < bytes.len() => match (hex(bytes[at + 1]), hex(bytes[at + 2])) {
                (Some(high), Some(low)) => {
                    out.push((high * 16 + low) as u8);
                    at += 3;
                    continue;
                }
                _ => out.push(b'%'),
            },
            b'+' => out.push(b' '),
            byte => out.push(byte),
        }
        at += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn query_value(query: &str, key: &str) -> Option<String> {
    query
        .split('&')
        .filter_map(|pair| pair.split_once('=').or(Some((pair, ""))))
        .find(|(name, _)| *name == key)
        .map(|(_, value)| percent_decode(value))
}

fn clean(text: String, limit: usize) -> String {
    text.chars()
        .filter(|c| !c.is_control())
        .take(limit)
        .collect()
}

impl InternalPage {
    pub fn of(url: &str) -> Option<Self> {
        let rest = url.trim().get(SCHEME.len()..).filter(|_| {
            url.trim()
                .get(..SCHEME.len())
                .is_some_and(|scheme| scheme.eq_ignore_ascii_case(SCHEME))
        })?;
        let host_end = rest.find(['/', '?', '#']).unwrap_or(rest.len());
        let host = rest[..host_end].to_ascii_lowercase();
        let query = rest[host_end..]
            .split_once('?')
            .map(|(_, query)| query.split('#').next().unwrap_or_default())
            .unwrap_or_default();
        let text = |key: &str| clean(query_value(query, key).unwrap_or_default(), MAX_QUERY);
        Some(match host.as_str() {
            "newtab" => InternalPage::NewTab,
            "history" => InternalPage::History { query: text("q") },
            "bookmarks" => InternalPage::Bookmarks { query: text("q") },
            "downloads" => InternalPage::Downloads,
            _ => return None,
        })
    }

    pub fn kind(&self) -> PageKind {
        match self {
            InternalPage::NewTab => PageKind::NewTab,
            InternalPage::History { .. } => PageKind::History,
            InternalPage::Bookmarks { .. } => PageKind::Bookmarks,
            InternalPage::Downloads => PageKind::Downloads,
        }
    }

    pub fn title(&self) -> &'static str {
        self.kind().title()
    }

    pub fn icon(&self) -> Icon {
        self.kind().icon()
    }

    pub fn url(&self) -> String {
        match self {
            InternalPage::NewTab => "ardia://newtab".into(),
            InternalPage::History { query } if query.is_empty() => "ardia://history".into(),
            InternalPage::History { query } => {
                format!("ardia://history?q={}", encode_uri_component(query))
            }
            InternalPage::Bookmarks { query } if query.is_empty() => "ardia://bookmarks".into(),
            InternalPage::Bookmarks { query } => {
                format!("ardia://bookmarks?q={}", encode_uri_component(query))
            }
            InternalPage::Downloads => "ardia://downloads".into(),
        }
    }
}

impl PageKind {
    pub fn title(self) -> &'static str {
        match self {
            PageKind::NewTab => "New Tab",
            PageKind::History => "History",
            PageKind::Bookmarks => "Bookmarks",
            PageKind::Downloads => "Downloads",
        }
    }

    pub fn icon(self) -> Icon {
        match self {
            PageKind::NewTab => Icon::ArdiaMark,
            PageKind::History => Icon::History,
            PageKind::Bookmarks => Icon::Bookmark,
            PageKind::Downloads => Icon::ArrowDownCircle,
        }
    }

    pub fn page(self) -> InternalPage {
        match self {
            PageKind::NewTab => InternalPage::NewTab,
            PageKind::History => InternalPage::History {
                query: String::new(),
            },
            PageKind::Bookmarks => InternalPage::Bookmarks {
                query: String::new(),
            },
            PageKind::Downloads => InternalPage::Downloads,
        }
    }
}

pub fn is_internal(url: &str) -> bool {
    InternalPage::of(url).is_some()
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum OpenPlan {
    Activate(TabId),
    NavigateIn(TabId),
    NewTab,
}

pub fn plan_open(state: &BrowserState, window: &WindowId, kind: PageKind) -> OpenPlan {
    let Some(shown) = state.window(window.as_str()) else {
        return OpenPlan::NewTab;
    };
    let existing = shown.tab_ids.iter().find(|id| {
        state.tab(id.as_str()).is_some_and(|tab| {
            tab.profile_id == shown.profile_id
                && InternalPage::of(&tab.url).is_some_and(|page| page.kind() == kind)
        })
    });
    if let Some(existing) = existing {
        return OpenPlan::Activate(existing.clone());
    }
    match state.active_tab(window.as_str()) {
        Some(active) if active.url.is_empty() || active.url.starts_with("ardia://newtab") => {
            OpenPlan::NavigateIn(active.id.clone())
        }
        _ => OpenPlan::NewTab,
    }
}

pub fn internal_page(
    c: &Chrome,
    tab: &ardia_state::tabs::Tab,
    page: &InternalPage,
) -> Option<AnyElement> {
    Some(match page {
        InternalPage::NewTab => return None,
        InternalPage::History { query } => {
            history::HistoryPage::new(c, tab, query).into_any_element()
        }
        InternalPage::Bookmarks { query } => {
            bookmarks::BookmarksPage::new(c, tab, query).into_any_element()
        }
        InternalPage::Downloads => downloads::DownloadsPage::new(c, tab).into_any_element(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn internal_urls_parse_and_round_trip() {
        assert_eq!(
            InternalPage::of("ardia://newtab"),
            Some(InternalPage::NewTab)
        );
        assert_eq!(
            InternalPage::of("ARDIA://History?q=rust%20gpui"),
            Some(InternalPage::History {
                query: "rust gpui".into()
            })
        );
        assert_eq!(
            InternalPage::of("ardia://bookmarks/"),
            Some(InternalPage::Bookmarks {
                query: String::new()
            })
        );
        assert_eq!(InternalPage::of("ardia://settings"), None);
        assert_eq!(
            InternalPage::of("ardia://reader?url=https%3A%2F%2Fa.example"),
            None
        );
        assert_eq!(InternalPage::of("https://history"), None);
        assert_eq!(InternalPage::of("ardia://"), None);
        assert_eq!(
            InternalPage::of("ardia://history?q=%E2%9C%93%0Abad%"),
            Some(InternalPage::History {
                query: "\u{2713}bad%".into()
            })
        );
        let long = format!("ardia://history?q={}", "a".repeat(MAX_QUERY * 2));
        assert!(matches!(
            InternalPage::of(&long),
            Some(InternalPage::History { query }) if query.len() == MAX_QUERY
        ));
    }
}
