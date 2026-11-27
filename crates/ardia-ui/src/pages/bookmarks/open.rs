use std::collections::HashSet;
use std::sync::Arc;

use ardia_state::splits::SplitSide;
use ardia_state::windows::WindowKind;
use ardia_state::{Action, NewTab, ProfileId, TabId, WindowId};

use crate::host::UiHost;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum OpenMode {
    Current,
    Background,
    Foreground,
    Window,
    Incognito,
    Split,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum OpenAll {
    Tabs,
    Window,
    Incognito,
}

fn is_bookmarklet(url: &str) -> bool {
    url.trim_start()
        .get(..11)
        .is_some_and(|head| head.eq_ignore_ascii_case("javascript:"))
}

fn window_facts(
    host: &Arc<dyn UiHost>,
    window: &WindowId,
) -> (bool, Option<ProfileId>, Option<TabId>) {
    let state = host.store().snapshot();
    let shown = state.window(window.as_str());
    let private =
        shown.is_some_and(|w| w.kind == WindowKind::Incognito || w.profile_id.is_incognito());
    let profile = shown.map(|w| w.profile_id.clone());
    let active = state.active_tab(window.as_str()).map(|t| t.id.clone());
    (private, profile, active)
}

fn newest_window(host: &Arc<dyn UiHost>, before: &HashSet<WindowId>) -> Option<WindowId> {
    let state = host.store().snapshot();
    state
        .window_order
        .iter()
        .rev()
        .find(|id| !before.contains(*id))
        .cloned()
}

fn open_window(
    host: &Arc<dyn UiHost>,
    kind: WindowKind,
    profile: Option<ProfileId>,
    url: &str,
) -> Option<WindowId> {
    let before: HashSet<WindowId> = host
        .store()
        .snapshot()
        .window_order
        .iter()
        .cloned()
        .collect();
    host.dispatch(Action::OpenWindow {
        kind,
        profile,
        url: Some(url.to_owned()),
        frame: None,
    });
    let created = newest_window(host, &before)?;
    host.dispatch(Action::FocusWindow {
        window: created.clone(),
    });
    Some(created)
}

pub fn open_url(host: &Arc<dyn UiHost>, window: &WindowId, url: &str, mode: OpenMode) {
    if is_bookmarklet(url) {
        log::debug!("bookmarklets run from the bookmarks bar");
        return;
    }
    let (private, profile, active) = window_facts(host, window);
    let original = profile.as_ref().map(|p| {
        if p.is_incognito() {
            p.incognito_original()
        } else {
            p.clone()
        }
    });
    match mode {
        OpenMode::Incognito => {
            open_window(host, WindowKind::Incognito, original, url);
        }
        OpenMode::Window => {
            if private {
                open_window(host, WindowKind::Incognito, original, url);
            } else {
                open_window(host, WindowKind::Main, profile, url);
            }
        }
        OpenMode::Split => host.dispatch(Action::OpenSplitPane {
            window: window.clone(),
            side: SplitSide::Right,
            url: Some(url.to_owned()),
        }),
        OpenMode::Current if active.is_some() => {
            if let Some(active) = active {
                host.navigate(window.clone(), active, url.to_owned());
            }
        }
        OpenMode::Current | OpenMode::Foreground | OpenMode::Background => {
            let background = mode == OpenMode::Background;
            host.dispatch(Action::NewTab {
                window: window.clone(),
                tab: NewTab {
                    url: Some(url.to_owned()),
                    background,
                    opener: if background { active } else { None },
                    ..NewTab::default()
                },
            });
        }
    }
}

fn tab_after(
    host: &Arc<dyn UiHost>,
    window: &WindowId,
    url: &str,
    after: Option<&TabId>,
) -> Option<TabId> {
    let state = host.store().snapshot();
    let ids = state.window(window.as_str())?.tab_ids.clone();
    let index = after
        .and_then(|after| ids.iter().position(|id| id == after))
        .map(|at| at + 1);
    let before: HashSet<TabId> = ids.iter().cloned().collect();
    host.dispatch(Action::NewTab {
        window: window.clone(),
        tab: NewTab {
            url: Some(url.to_owned()),
            background: true,
            index,
            ..NewTab::default()
        },
    });
    let state = host.store().snapshot();
    state
        .window(window.as_str())?
        .tab_ids
        .iter()
        .find(|id| !before.contains(*id))
        .cloned()
}

fn open_in_order(
    host: &Arc<dyn UiHost>,
    window: &WindowId,
    links: &[String],
    mut after: Option<TabId>,
) -> Vec<TabId> {
    let mut made = Vec::new();
    for url in links {
        if let Some(tab) = tab_after(host, window, url, after.as_ref()) {
            made.push(tab.clone());
            after = Some(tab);
        }
    }
    made
}

pub fn open_links(
    host: &Arc<dyn UiHost>,
    window: &WindowId,
    links: &[String],
    mode: OpenAll,
) -> Vec<TabId> {
    let links: Vec<String> = links
        .iter()
        .filter(|url| !is_bookmarklet(url))
        .cloned()
        .collect();
    let Some((first, rest)) = links.split_first() else {
        return Vec::new();
    };
    let (private, profile, _) = window_facts(host, window);
    let exists = host.store().snapshot().window(window.as_str()).is_some();
    if mode != OpenAll::Tabs || !exists {
        let incognito = mode == OpenAll::Incognito || private;
        let kind = if incognito {
            WindowKind::Incognito
        } else {
            WindowKind::Main
        };
        let created = open_window(host, kind, if incognito { None } else { profile }, first);
        let Some(created) = created else {
            return Vec::new();
        };
        let active = host
            .store()
            .snapshot()
            .active_tab(created.as_str())
            .map(|t| t.id.clone());
        let mut made: Vec<TabId> = active.iter().cloned().collect();
        made.extend(open_in_order(host, &created, rest, active));
        return made;
    }
    let before: HashSet<TabId> = host
        .store()
        .snapshot()
        .window(window.as_str())
        .map(|w| w.tab_ids.iter().cloned().collect())
        .unwrap_or_default();
    host.dispatch(Action::NewTab {
        window: window.clone(),
        tab: NewTab {
            url: Some(first.clone()),
            ..NewTab::default()
        },
    });
    let opened = host
        .store()
        .snapshot()
        .window(window.as_str())
        .and_then(|w| w.tab_ids.iter().find(|id| !before.contains(*id)).cloned());
    let mut made: Vec<TabId> = opened.iter().cloned().collect();
    made.extend(open_in_order(host, window, rest, opened));
    made
}

pub fn add_as_group(host: &Arc<dyn UiHost>, window: &WindowId, title: &str, links: &[String]) {
    let mut made = Vec::new();
    let mut after = None;
    for url in links.iter().filter(|url| !is_bookmarklet(url)) {
        if let Some(tab) = tab_after(host, window, url, after.as_ref()) {
            made.push(tab.clone());
            after = Some(tab);
        }
    }
    if !made.is_empty() {
        host.dispatch(Action::CreateGroup {
            tabs: made,
            name: title.to_owned(),
        });
    }
}

pub fn copy_text(links: &[(String, String)], markdown: bool) -> String {
    links
        .iter()
        .map(|(url, title)| {
            if markdown {
                format!("[{}]({url})", title.replace(['[', ']'], ""))
            } else {
                url.clone()
            }
        })
        .collect::<Vec<_>>()
        .join("\n")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn links_copy_as_lines_or_markdown() {
        let links = vec![
            ("https://a.example/".to_owned(), "A [one]".to_owned()),
            ("https://b.example/".to_owned(), "B".to_owned()),
        ];
        assert_eq!(
            copy_text(&links, false),
            "https://a.example/\nhttps://b.example/"
        );
        assert_eq!(
            copy_text(&links, true),
            "[A one](https://a.example/)\n[B](https://b.example/)"
        );
        assert!(is_bookmarklet("javascript:alert(1)"));
        assert!(!is_bookmarklet("https://x.example/"));
    }
}
