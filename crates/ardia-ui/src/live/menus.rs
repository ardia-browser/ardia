use ardia_state::groups::GroupColor;
use ardia_state::live::{LiveCommand, LiveFilters, LiveFolderKind, LiveSourceId, LiveState};
use ardia_state::omnibox::url::clean_url;
use ardia_state::{Action, BrowserState, TabId, WindowId};
use gpui::{Hsla, SharedString};

use crate::msg::Msg;
use crate::popovers::context_menu::{MenuEntry, MenuItem, sections};
use crate::primitives::icons::Icon;
use crate::primitives::theme_bridge::hsla;
use crate::profiles::layer::PeopleMsg;
use crate::settings::rows::Pane;

pub const COLOR_ORDER: [GroupColor; 9] = [
    GroupColor::Grey,
    GroupColor::Blue,
    GroupColor::Red,
    GroupColor::Yellow,
    GroupColor::Green,
    GroupColor::Pink,
    GroupColor::Purple,
    GroupColor::Cyan,
    GroupColor::Orange,
];

fn live(command: LiveCommand) -> Msg {
    Msg::Live(command)
}

fn source_groups(kind: LiveFolderKind) -> &'static [LiveSourceId] {
    match kind {
        LiveFolderKind::PullRequests => &[LiveSourceId::Github, LiveSourceId::Bitbucket],
        LiveFolderKind::Documents => &[
            LiveSourceId::Notion,
            LiveSourceId::Confluence,
            LiveSourceId::Gdrive,
        ],
    }
}

fn color_name(color: GroupColor) -> &'static str {
    match color {
        GroupColor::Grey => "Grey",
        GroupColor::Blue => "Blue",
        GroupColor::Red => "Red",
        GroupColor::Yellow => "Yellow",
        GroupColor::Green => "Green",
        GroupColor::Pink => "Pink",
        GroupColor::Purple => "Purple",
        GroupColor::Cyan => "Cyan",
        GroupColor::Orange => "Orange",
        GroupColor::NoColor => "None",
    }
}

fn set_color(folder: &str, color: Option<GroupColor>) -> Msg {
    live(LiveCommand::SetColor {
        folder: folder.to_owned(),
        color: color.and_then(|c| serde_json::to_value(c).ok()),
    })
}

fn color_items(folder: &str, current: Option<GroupColor>, dark: bool) -> Vec<MenuEntry> {
    let neutral: Hsla = gpui::hsla(0.0, 0.0, if dark { 1.0 } else { 0.0 }, 0.3);
    let mut out = vec![
        MenuItem::new("live-color:none", "None")
            .checked(current == Some(GroupColor::NoColor))
            .msg(Msg::Count("live_folder_color_picks"))
            .msg(set_color(folder, Some(GroupColor::NoColor)))
            .entry(),
        MenuItem::new("live-color:neutral", "Neutral")
            .swatch(Some(neutral))
            .checked(current.is_none())
            .msg(Msg::Count("live_folder_color_picks"))
            .msg(set_color(folder, None))
            .entry(),
        MenuEntry::Separator,
    ];
    out.extend(COLOR_ORDER.iter().map(|color| {
        MenuItem::new(
            SharedString::from(format!("live-color:{}", color.key())),
            color_name(*color),
        )
        .swatch(crate::sidebar::group_list::group_tint(Some(*color)).map(hsla))
        .checked(current == Some(*color))
        .msg(Msg::Count("live_folder_color_picks"))
        .msg(set_color(folder, Some(*color)))
        .entry()
    }));
    out
}

pub fn folder_color(live_state: &LiveState, folder: &str) -> Option<GroupColor> {
    live_state
        .folders
        .get(folder)
        .and_then(|f| f.color.clone())
        .and_then(|c| serde_json::from_value(c).ok())
}

pub fn live_folder_menu(state: &LiveState, folder_id: &str, dark: bool) -> Vec<MenuEntry> {
    let Some(folder) = state.folders.get(folder_id) else {
        return Vec::new();
    };
    let pr = folder.kind == LiveFolderKind::PullRequests;
    let id = folder_id.to_owned();
    let status = state.status.get(folder_id);
    let mut repos: Vec<(String, LiveSourceId, String)> = state
        .folder_repos(folder_id)
        .into_iter()
        .filter_map(|key| {
            let (source, name) = key.split_once(':')?;
            let source = LiveSourceId::ALL.into_iter().find(|s| s.key() == source)?;
            Some((key.clone(), source, name.to_owned()))
        })
        .collect();
    let one_source = repos
        .iter()
        .map(|r| r.1)
        .collect::<std::collections::HashSet<_>>()
        .len()
        <= 1;
    repos.sort_by(|a, b| a.2.cmp(&b.2).then(a.1.key().cmp(b.1.key())));
    let filters_with = |filters: LiveFilters| {
        live(LiveCommand::SetOptions {
            folder: id.clone(),
            group_stacks: None,
            show_completed: None,
            filters: Some(filters),
            sources: None,
        })
    };
    let filters = pr.then(|| {
        let f = folder.filters;
        let hidden: Vec<&String> = folder.hidden_repos.iter().collect();
        let repo_entries: Vec<MenuEntry> = repos
            .iter()
            .map(|(key, source, name)| {
                let title = if one_source {
                    name.clone()
                } else {
                    format!("{name} ({})", source.name())
                };
                let shown = !hidden.contains(&key);
                MenuItem::new(SharedString::from(format!("repo:{key}")), title)
                    .checked(shown)
                    .msg(Msg::Count("live_repo_menu_picks"))
                    .msg(live(LiveCommand::SetRepoHidden {
                        folder: id.clone(),
                        repo: key.clone(),
                        hidden: shown,
                    }))
                    .msg(live(LiveCommand::Refresh {
                        folder: id.clone(),
                        manual: false,
                    }))
                    .entry()
            })
            .collect();
        let mut hide_all = MenuItem::new("repos:none", "Hide All Repositories")
            .enabled(repos.iter().any(|r| !hidden.contains(&&r.0)))
            .msg(Msg::Count("live_repo_menu_picks"))
            .msg(Msg::Count("live_repo_hide_alls"));
        for (key, _, _) in repos.iter().filter(|r| !hidden.contains(&&r.0)) {
            hide_all = hide_all.msg(live(LiveCommand::SetRepoHidden {
                folder: id.clone(),
                repo: key.clone(),
                hidden: true,
            }));
        }
        let mut show_new_repos = MenuItem::new("repos:new", "Show New Repositories")
            .checked(folder.show_new_repos)
            .msg(Msg::Count("live_repo_menu_picks"));
        if folder.show_new_repos {
            show_new_repos = show_new_repos.msg(Msg::Count("live_new_repos_hidden_turned_on"));
        }
        let repos_menu = MenuEntry::Submenu(crate::popovers::context_menu::Submenu {
            key: "repos".into(),
            title: "Repositories".into(),
            icon: None,
            symbol: None,
            enabled: !repos.is_empty(),
            children: sections(vec![
                vec![
                    MenuItem::new("repos:all", "Show All Repositories")
                        .enabled(!hidden.is_empty())
                        .msg(Msg::Count("live_repo_menu_picks"))
                        .msg(live(LiveCommand::ShowAllRepos { folder: id.clone() }))
                        .msg(live(LiveCommand::Refresh {
                            folder: id.clone(),
                            manual: false,
                        }))
                        .entry(),
                    hide_all.entry(),
                ],
                repo_entries,
                vec![
                    show_new_repos
                        .msg(live(LiveCommand::SetShowNewRepos {
                            folder: id.clone(),
                            show: !folder.show_new_repos,
                        }))
                        .entry(),
                ],
            ]),
        });
        MenuEntry::submenu(
            "filters",
            "Filters",
            None,
            sections(vec![
                vec![
                    MenuItem::new("filter:authored", "Created by Me")
                        .checked(f.authored)
                        .msg(filters_with(LiveFilters {
                            authored: !f.authored,
                            ..f
                        }))
                        .entry(),
                    MenuItem::new("filter:reviewRequests", "Awaiting My Review")
                        .checked(f.review_requests)
                        .msg(filters_with(LiveFilters {
                            review_requests: !f.review_requests,
                            ..f
                        }))
                        .entry(),
                    repos_menu,
                ],
                vec![
                    MenuItem::new("option:groupStacks", "Group Stacked Pull Requests")
                        .checked(folder.group_stacks)
                        .msg(live(LiveCommand::SetOptions {
                            folder: id.clone(),
                            group_stacks: Some(!folder.group_stacks),
                            show_completed: None,
                            filters: None,
                            sources: None,
                        }))
                        .entry(),
                    MenuItem::new("option:showCompleted", "Show Completed")
                        .checked(folder.show_completed)
                        .msg(live(LiveCommand::SetOptions {
                            folder: id.clone(),
                            group_stacks: None,
                            show_completed: Some(!folder.show_completed),
                            filters: None,
                            sources: None,
                        }))
                        .entry(),
                ],
            ]),
        )
    });
    let source_items: Vec<MenuEntry> = source_groups(folder.kind)
        .iter()
        .map(|source| {
            let connected = state.accounts.contains_key(source);
            let on = folder.sources.contains(source);
            let mut next: Vec<LiveSourceId> = if on {
                folder
                    .sources
                    .iter()
                    .copied()
                    .filter(|s| s != source)
                    .collect()
            } else {
                folder.sources.iter().copied().chain([*source]).collect()
            };
            if next.is_empty() {
                next = folder.sources.clone();
            }
            let title = if connected {
                source.name().to_owned()
            } else {
                format!("{} (Not Connected)", source.name())
            };
            let item = MenuItem::new(
                SharedString::from(format!("source:{}", source.key())),
                title,
            )
            .checked(on);
            if connected {
                item.msg(live(LiveCommand::SetOptions {
                    folder: id.clone(),
                    group_stacks: None,
                    show_completed: None,
                    filters: None,
                    sources: Some(next),
                }))
                .entry()
            } else {
                item.msg(Msg::SettingsAt(Pane::General)).entry()
            }
        })
        .chain([
            MenuEntry::Separator,
            MenuItem::new("live-settings", "Live Folder Settings…")
                .icon(Icon::Gear)
                .msg(Msg::SettingsAt(Pane::General))
                .entry(),
        ])
        .collect();
    let mut group = Vec::new();
    group.extend(filters);
    group.push(MenuEntry::submenu(
        "sources",
        "Sources",
        Some(if pr { Icon::Split } else { Icon::Doc }),
        source_items,
    ));
    group.push(MenuEntry::submenu(
        "customize",
        "Customize",
        Some(Icon::Sliders),
        vec![
            MenuItem::new("live-rename", "Rename…")
                .icon(Icon::Pencil)
                .msg(Msg::People(PeopleMsg::RenameLiveFolder(id.clone())))
                .entry(),
            MenuItem::new(
                "live-icon",
                if folder.icon.is_some() {
                    "Change Icon…"
                } else {
                    "Add Icon…"
                },
            )
            .icon(Icon::Photo)
            .msg(Msg::People(PeopleMsg::OpenLiveIconPicker(id.clone())))
            .entry(),
            MenuEntry::submenu(
                "live-color",
                "Color",
                Some(Icon::Palette),
                color_items(folder_id, folder_color(state, folder_id), dark),
            ),
        ],
    ));
    sections(vec![
        status
            .and_then(|s| s.error.as_ref())
            .map(|_| {
                MenuItem::new("fixError", "Resolve Warning…")
                    .icon(Icon::Warning)
                    .msg(Msg::Count("live_folder_warning_resolves"))
                    .msg(Msg::SettingsAt(Pane::General))
                    .entry()
            })
            .into_iter()
            .collect(),
        vec![
            MenuItem::new("live-refresh", "Refresh")
                .icon(Icon::Reload)
                .enabled(status.is_none_or(|s| s.state != ardia_state::live::FolderState::Updating))
                .msg(live(LiveCommand::Refresh {
                    folder: id.clone(),
                    manual: true,
                }))
                .entry(),
            MenuItem::new("live-read", "Mark All as Read")
                .icon(Icon::Check)
                .enabled(state.unread.get(folder_id).is_some_and(|u| !u.is_empty()))
                .msg(live(LiveCommand::MarkRead {
                    folder: id.clone(),
                    items: None,
                }))
                .entry(),
        ],
        group,
        vec![
            MenuItem::new("live-delete", "Delete Live Folder")
                .icon(Icon::Trash)
                .msg(live(LiveCommand::RemoveFolder { folder: id }))
                .entry(),
        ],
    ])
}

pub fn markdown_link(title: &str, url: &str) -> String {
    let title = title.replace('[', "\\[").replace(']', "\\]");
    format!("[{title}]({url})")
}

pub fn live_item_menu(
    state: &LiveState,
    browser: &BrowserState,
    window: &WindowId,
    folder: &str,
    item_id: &str,
    tab: Option<&TabId>,
) -> Vec<MenuEntry> {
    let Some(item) = state.folder_item(folder, item_id) else {
        return Vec::new();
    };
    let unread = state
        .unread
        .get(folder)
        .is_some_and(|u| u.iter().any(|i| i == item_id));
    let open = |background: bool| {
        live(LiveCommand::OpenItem {
            window: window.clone(),
            folder: folder.to_owned(),
            item: item_id.to_owned(),
            background,
        })
    };
    let away = tab
        .and_then(|t| browser.tab(t.as_str()))
        .is_some_and(|t| t.pinned_url.as_deref().is_some_and(|home| home != t.url));
    let mut first = vec![
        MenuItem::new("live-open", if tab.is_some() { "Show Tab" } else { "Open" })
            .icon(Icon::ArrowUpRight)
            .msg(open(false))
            .entry(),
        MenuItem::new("live-background", "Open in Background")
            .enabled(tab.is_none())
            .msg(open(true))
            .entry(),
    ];
    if let Some(tab) = tab {
        first.push(
            MenuItem::new("live-back", "Back to Pinned URL")
                .icon(Icon::Undo)
                .enabled(away)
                .msg(Msg::command("returnToPinnedUrl"))
                .msg(Msg::Store(Action::ActivateTab { tab: tab.clone() }))
                .entry(),
        );
    }
    let copy = MenuItem::new("live-copy", "Copy Link")
        .icon(Icon::Link)
        .msg(Msg::Copy(clean_url(&item.url)))
        .alternate(
            MenuItem::new("live-copy-md", "Copy Link as Markdown")
                .icon(Icon::Link)
                .msg(Msg::Copy(markdown_link(&item.title, &item.url))),
        )
        .entry();
    let read = MenuItem::new(
        "live-unread",
        if unread {
            "Mark as Read"
        } else {
            "Mark as Unread"
        },
    )
    .icon(Icon::Dot)
    .msg(if unread {
        live(LiveCommand::MarkRead {
            folder: folder.to_owned(),
            items: Some(vec![item_id.to_owned()]),
        })
    } else {
        live(LiveCommand::MarkUnread {
            folder: folder.to_owned(),
            item: item_id.to_owned(),
        })
    })
    .entry();
    sections(vec![
        first,
        vec![copy],
        vec![read],
        tab.map(|t| {
            MenuItem::new("live-close", "Close")
                .icon(Icon::XMark)
                .msg(Msg::CloseTab(t.clone()))
                .entry()
        })
        .into_iter()
        .collect(),
    ])
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::popovers::context_menu::titles;
    use std::collections::{HashMap, HashSet};

    #[test]
    fn folder_and_item_menus_follow_the_old_order() {
        let mut s = LiveState::default();
        let f = s.create_folder("lf".into(), "p", LiveFolderKind::PullRequests, None, 0);
        assert_eq!(
            titles(&live_folder_menu(&s, &f, true)),
            vec![
                "Refresh",
                "Mark All as Read",
                "-",
                "Filters",
                "Sources",
                "Customize",
                "-",
                "Delete Live Folder"
            ]
        );
        let item = ardia_state::live::LiveItem {
            id: "a".into(),
            source: LiveSourceId::Github,
            url: "https://x.test/a?utm_source=y".into(),
            title: "A [b]".into(),
            subtitle: String::new(),
            icon: None,
            updated_at: 0,
            section: None,
            pr: None,
            doc: None,
        };
        s.apply_fetch(
            &f,
            vec![item],
            &HashMap::new(),
            1,
            &HashSet::new(),
            &HashSet::new(),
        );
        let browser = BrowserState::default();
        let menu = live_item_menu(&s, &browser, &WindowId::new("w"), &f, "a", None);
        assert_eq!(
            titles(&menu),
            vec![
                "Open",
                "Open in Background",
                "-",
                "Copy Link",
                "-",
                "Mark as Unread"
            ]
        );
        assert_eq!(markdown_link("A [b]", "u"), "[A \\[b\\]](u)");
        let docs = s.create_folder("ld".into(), "p", LiveFolderKind::Documents, None, 0);
        assert!(!titles(&live_folder_menu(&s, &docs, false)).contains(&"Filters".to_owned()));
    }
}
