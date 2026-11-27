use ardia_state::omnibox::providers::ExtensionOpen;
use ardia_state::omnibox::suggest::Suggestion;
use ardia_state::omnibox::url::display_url;

pub const MAX_ROW_TEXT: usize = 300;

pub fn clip_row_text(text: &str) -> String {
    if text.chars().count() <= MAX_ROW_TEXT {
        return text.to_owned();
    }
    let mut clipped: String = text.chars().take(MAX_ROW_TEXT).collect();
    clipped.push('…');
    clipped
}

pub fn suggestion_labels(s: &Suggestion) -> (String, Option<String>) {
    match s {
        Suggestion::Page {
            url,
            title,
            tab_id: Some(_),
            ..
        } => {
            let shown = if title.is_empty() {
                display_url(url)
            } else {
                title.clone()
            };
            (clip_row_text(&shown), Some("Switch to Tab".to_owned()))
        }
        Suggestion::Page { url, title, .. } if title.is_empty() => {
            (clip_row_text(&display_url(url)), None)
        }
        Suggestion::Page { url, title, .. } => {
            (clip_row_text(title), Some(clip_row_text(&display_url(url))))
        }
        Suggestion::Search {
            query,
            engine,
            bang: true,
            ..
        } => (clip_row_text(&format!("Search {engine} for {query}")), None),
        Suggestion::Search { query, .. } => (clip_row_text(query), None),
        Suggestion::Calc {
            expression, value, ..
        } => (clip_row_text(value), Some(clip_row_text(expression))),
        Suggestion::Action { title, .. } => (clip_row_text(title), None),
        Suggestion::Extension { title, open, .. } => (
            clip_row_text(title),
            Some(
                match open {
                    ExtensionOpen::Action => "Open Extension",
                    ExtensionOpen::Options => "Extension Options",
                }
                .to_owned(),
            ),
        ),
        Suggestion::Provider {
            title,
            url,
            subtitle,
            ..
        } => {
            let host =
                ardia_state::omnibox::url::display_host(&ardia_state::omnibox::url::host_of(url));
            let host = if host.is_empty() {
                display_url(url)
            } else {
                host
            };
            let detail = match subtitle {
                Some(subtitle) => format!("{host} · {subtitle}"),
                None => host,
            };
            (clip_row_text(title), Some(clip_row_text(&detail)))
        }
    }
}

pub fn destination_label(s: Option<&Suggestion>) -> String {
    match s {
        Some(Suggestion::Search { engine, .. }) => engine.clone(),
        Some(Suggestion::Calc { .. }) => "Copy".to_owned(),
        _ => "Go".to_owned(),
    }
}

pub fn removable_url(s: Option<&Suggestion>) -> Option<&str> {
    match s {
        Some(Suggestion::Page {
            url,
            visited: true,
            tab_id: None,
            ..
        }) => Some(url),
        _ => None,
    }
}

pub fn preview_text(s: Option<&Suggestion>) -> Option<String> {
    match s {
        Some(Suggestion::Search { query, .. }) => Some(query.clone()),
        Some(Suggestion::Page { url, .. }) => Some(display_url(url)),
        _ => None,
    }
}

pub fn row_hint(s: &Suggestion) -> Option<String> {
    match s {
        Suggestion::Action { hint, .. } => hint.clone(),
        Suggestion::Provider { provider, .. } => Some(provider.clone()),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use ardia_state::TabId;

    fn page(title: &str, tab: Option<&str>, visited: bool) -> Suggestion {
        Suggestion::Page {
            url: "https://github.com/ardia".into(),
            title: title.into(),
            favicon: None,
            tab_id: tab.map(TabId::new),
            bookmarked: false,
            visited,
        }
    }

    #[test]
    fn rows_read_like_the_old_command_bar() {
        assert_eq!(
            suggestion_labels(&page("Ardia", Some("t1"), false)),
            ("Ardia".into(), Some("Switch to Tab".into()))
        );
        assert_eq!(
            suggestion_labels(&page("Ardia", None, true)),
            ("Ardia".into(), Some("github.com/ardia".into()))
        );
        assert_eq!(
            suggestion_labels(&page("", None, true)),
            ("github.com/ardia".into(), None)
        );
        let bang = Suggestion::Search {
            query: "cats".into(),
            url: String::new(),
            engine: "YouTube".into(),
            suggested: false,
            bang: true,
        };
        assert_eq!(
            suggestion_labels(&bang).0,
            "Search YouTube for cats".to_owned()
        );
        let calc = Suggestion::Calc {
            expression: "2+2".into(),
            value: "4".into(),
            url: String::new(),
        };
        assert_eq!(suggestion_labels(&calc), ("4".into(), Some("2+2".into())));
        assert_eq!(destination_label(Some(&calc)), "Copy");
        assert_eq!(destination_label(Some(&bang)), "YouTube");
        assert_eq!(destination_label(None), "Go");
    }

    #[test]
    fn only_visited_rows_that_are_not_open_tabs_can_be_removed() {
        assert!(removable_url(Some(&page("a", None, true))).is_some());
        assert!(removable_url(Some(&page("a", Some("t"), true))).is_none());
        assert!(removable_url(Some(&page("a", None, false))).is_none());
    }

    #[test]
    fn long_titles_are_clipped_with_an_ellipsis() {
        let long = "x".repeat(400);
        let clipped = clip_row_text(&long);
        assert_eq!(clipped.chars().count(), MAX_ROW_TEXT + 1);
        assert!(clipped.ends_with('…'));
    }
}
