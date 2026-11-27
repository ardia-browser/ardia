use ardia_state::omnibox::PasteAction;
use ardia_state::{BrowserState, TabId};

use crate::keybindings::hint;
use crate::msg::Msg;
use crate::popovers::context_menu::{MenuEntry, MenuItem, sections};
use crate::primitives::icons::Icon;

pub fn site_origin(url: &str) -> Option<String> {
    let lower = url.get(..8).unwrap_or(url).to_ascii_lowercase();
    let scheme_len = if lower.starts_with("https://") {
        8
    } else if lower.starts_with("http://") {
        7
    } else {
        return None;
    };
    let rest = &url[scheme_len..];
    let end = rest.find(['/', '?', '#']).unwrap_or(rest.len());
    let authority = &rest[..end];
    let host = authority.rsplit('@').next().unwrap_or(authority);
    (!host.is_empty()).then(|| {
        format!(
            "{}{}",
            url[..scheme_len].to_ascii_lowercase(),
            host.to_ascii_lowercase()
        )
    })
}

pub fn reload_menu(
    state: &BrowserState,
    tab: &TabId,
    blocker: crate::site::model::ReloadBlocker,
) -> Vec<MenuEntry> {
    let reload = MenuItem::new("reload", "Reload")
        .icon(Icon::Reload)
        .shortcut(hint(state, "reload"))
        .msg(Msg::Reload {
            tab: tab.clone(),
            hard: false,
        })
        .entry();
    let hard = MenuItem::new("forceReload", "Hard Reload")
        .icon(Icon::Sync)
        .shortcut(hint(state, "forceReload"))
        .msg(Msg::Reload {
            tab: tab.clone(),
            hard: true,
        })
        .entry();
    let blocking = crate::site::menus::blocking_item(tab, blocker);
    let clear = MenuItem::new("clearData", "Clear Cookies and Site Data…")
        .icon(Icon::Trash)
        .msg(Msg::ClearSiteData(tab.clone()))
        .entry();
    sections(vec![vec![reload, hard], vec![blocking], vec![clear]])
}

pub fn paste_target(state: &BrowserState, paste: &PasteAction) -> String {
    match paste {
        PasteAction::Go(url) => url.clone(),
        PasteAction::Search(query) => state.default_search_engine().search_url(query),
    }
}

pub fn shareable(url: &str) -> bool {
    site_origin(url).is_some()
}

pub fn url_bar_menu(
    state: &BrowserState,
    tab: &TabId,
    paste: Option<&PasteAction>,
) -> Vec<MenuEntry> {
    let Some(shown) = state.tab(tab.as_str()) else {
        return Vec::new();
    };
    let copy = MenuItem::new("copy", "Copy Link")
        .icon(Icon::Link)
        .shortcut(hint(state, "copyUrl"))
        .msg(Msg::command("copyUrl"))
        .alternate(
            MenuItem::new("copyMarkdown", "Copy Link as Markdown")
                .icon(Icon::Link)
                .shortcut(hint(state, "copyUrlAsMarkdown"))
                .msg(Msg::command("copyUrlAsMarkdown")),
        )
        .entry();
    let mut first = vec![copy];
    if let Some(paste) = paste {
        let (title, glyph) = match paste {
            PasteAction::Go(_) => ("Paste and Go", Icon::ArrowUp),
            PasteAction::Search(_) => ("Paste and Search", Icon::Search),
        };
        first.push(
            MenuItem::new("pasteAndGo", title)
                .icon(glyph)
                .msg(Msg::Navigate {
                    tab: tab.clone(),
                    input: paste_target(state, paste),
                })
                .entry(),
        );
    }
    let mut second = Vec::new();
    if shareable(&shown.url) {
        second.push(
            MenuItem::new("share", "Share")
                .icon(Icon::Share)
                .msg(Msg::Share(tab.clone()))
                .entry(),
        );
    }
    sections(vec![first, second])
}

pub fn split_menu(
    state: &BrowserState,
    window: &ardia_state::WindowId,
    tab: &TabId,
) -> Vec<MenuEntry> {
    use ardia_state::actions::Action;
    use ardia_state::model::Orientation;
    use ardia_state::splits::{PaneDirection, SplitSide, SplitView};
    let Some(split) = state.split_of(tab.as_str()) else {
        return Vec::new();
    };
    let store = Msg::Store;
    let horizontal = split.orientation == Orientation::Horizontal;
    let stacks = split.slots.iter().any(|slot| slot.is_stack());
    let add =
        |key: &'static str, title: &'static str, glyph: Icon, side: SplitSide, command: &str| {
            MenuItem::new(key, title)
                .icon(glyph)
                .enabled(SplitView::can_insert(Some(split), tab.as_str(), side))
                .shortcut(hint(state, command))
                .msg(store(Action::ActivateTab { tab: tab.clone() }))
                .msg(store(Action::OpenSplitPane {
                    window: window.clone(),
                    side,
                    url: None,
                }))
                .entry()
        };
    let moves = [
        (
            "moveLeft",
            "Move Pane Left",
            Icon::HalfLeft,
            PaneDirection::Left,
            "moveSplitPaneLeft",
            true,
        ),
        (
            "moveRight",
            "Move Pane Right",
            Icon::HalfRight,
            PaneDirection::Right,
            "moveSplitPaneRight",
            true,
        ),
        (
            "moveUp",
            "Move Pane Up",
            Icon::ArrowUp,
            PaneDirection::Up,
            "moveSplitPaneUp",
            false,
        ),
        (
            "moveDown",
            "Move Pane Down",
            Icon::ArrowDown,
            PaneDirection::Down,
            "moveSplitPaneDown",
            false,
        ),
    ];
    let mut arrange: Vec<MenuEntry> = moves
        .into_iter()
        .filter(|(.., sideways)| {
            if *sideways {
                horizontal || stacks
            } else {
                !horizontal || stacks
            }
        })
        .map(|(key, title, glyph, direction, command, _)| {
            MenuItem::new(key, title)
                .icon(glyph)
                .enabled(split.neighbor(tab.as_str(), direction).is_some())
                .shortcut(hint(state, command))
                .msg(store(Action::MovePane {
                    tab: tab.clone(),
                    direction,
                }))
                .entry()
        })
        .collect();
    arrange.push(
        MenuItem::new("flip", "Flip Split View")
            .icon(if horizontal {
                Icon::SwapHorizontal
            } else {
                Icon::SwapVertical
            })
            .msg(store(Action::FlipSplit {
                split: split.id.clone(),
            }))
            .entry(),
    );
    arrange.push(
        MenuItem::new(
            "convert",
            if horizontal {
                "Convert to Vertical Split View"
            } else {
                "Convert to Horizontal Split View"
            },
        )
        .icon(if horizontal {
            Icon::SplitVertical
        } else {
            Icon::Split
        })
        .msg(Msg::Stores(vec![
            Action::Unsplit {
                split: split.id.clone(),
            },
            Action::SplitTabs {
                tabs: split.tab_ids(),
                orientation: if horizontal {
                    Orientation::Vertical
                } else {
                    Orientation::Horizontal
                },
            },
        ]))
        .entry(),
    );
    let remove = MenuItem::new("remove", "Remove from Split View")
        .icon(Icon::Expand)
        .msg(store(Action::RemoveFromSplit { tab: tab.clone() }))
        .alternate(
            MenuItem::new("separate", "Separate All Tabs")
                .icon(Icon::Split)
                .msg(store(Action::Unsplit {
                    split: split.id.clone(),
                })),
        )
        .entry();
    let close = MenuItem::new("close", "Close Pane")
        .icon(Icon::XMark)
        .msg(Msg::CloseTab(tab.clone()))
        .entry();
    let close_split = MenuItem::new("closeSplit", "Close Split View")
        .icon(Icon::XMark)
        .msg(Msg::Count("split_view_closes"))
        .msg(store(Action::CloseTabs {
            tabs: split.tab_ids(),
            last_closes_window: false,
        }))
        .entry();
    sections(vec![
        vec![
            add(
                "addRight",
                "Add Right Split",
                Icon::HalfRight,
                SplitSide::Right,
                "openSplitPane",
            ),
            add(
                "addBottom",
                "Add Bottom Split",
                Icon::HalfBottom,
                SplitSide::Bottom,
                "openSplitPaneBelow",
            ),
        ],
        vec![
            MenuEntry::submenu("arrange", "Arrange", Some(Icon::SwapHorizontal), arrange),
            remove,
        ],
        vec![close, close_split],
    ])
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::popovers::context_menu::titles;

    #[test]
    fn only_web_pages_have_an_origin() {
        assert_eq!(
            site_origin("https://User@Example.com:8080/a?b").as_deref(),
            Some("https://example.com:8080")
        );
        assert_eq!(
            site_origin("http://a.test").as_deref(),
            Some("http://a.test")
        );
        assert_eq!(site_origin("ardia://settings"), None);
        assert_eq!(site_origin("file:///tmp/x"), None);
    }

    #[test]
    fn the_reload_menu_lists_the_legacy_items() {
        let state = BrowserState::default();
        let menu = reload_menu(
            &state,
            &TabId::new("t"),
            crate::site::model::ReloadBlocker::Unavailable,
        );
        assert_eq!(
            titles(&menu),
            [
                "Reload",
                "Hard Reload",
                "-",
                "Block Ads & Trackers",
                "-",
                "Clear Cookies and Site Data…"
            ]
        );
    }
}
