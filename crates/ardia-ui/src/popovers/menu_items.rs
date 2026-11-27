use std::sync::Arc;

use ardia_state::groups::GroupColor;
use ardia_state::model::{TabLayout, TabPin};
use ardia_state::omnibox::url::clean_url;
use ardia_state::settings::{AddressBar, BookmarksBar, SettingsPatch};
use ardia_state::splits::SplitSide;
use ardia_state::tabs::Tab;
use ardia_state::windows::{BrowserWindow, WindowKind};
use ardia_state::{Action, BrowserState, GroupId, GroupPatch, NewTab, TabId};
use gpui::{Hsla, SharedString};

use crate::keybindings::hint;
use crate::msg::{Msg, RenameTarget};
use crate::popovers::context_menu::{MenuEntry, MenuItem, sections};
use crate::popovers::tab_menu_extras::{TabExtras, pip_entries, unread_entries};
use crate::primitives::icons::Icon;
use crate::primitives::theme_bridge::hsla;
use crate::settings::rows::Pane;
use crate::sidebar::group_list::group_tint;

fn store(action: Action) -> Msg {
    Msg::Store(action)
}

fn hint_when(on: bool, state: &BrowserState, id: &str) -> Option<String> {
    if on { hint(state, id) } else { None }
}

fn plural(n: usize, word: &str) -> String {
    if n == 1 {
        format!("1 {word}")
    } else {
        format!("{n} {word}s")
    }
}

pub fn link_text(tabs: &[&Tab], markdown: bool) -> Option<String> {
    let lines: Vec<String> = tabs
        .iter()
        .filter(|t| !t.url.is_empty())
        .map(|t| {
            let url = clean_url(&t.url);
            if markdown {
                format!("[{}]({url})", t.display_title().replace(['[', ']'], ""))
            } else {
                url
            }
        })
        .collect();
    if lines.is_empty() {
        return None;
    }
    Some(if markdown && lines.len() > 1 {
        lines
            .iter()
            .map(|line| format!("- {line}"))
            .collect::<Vec<_>>()
            .join("\n")
    } else {
        lines.join("\n")
    })
}

fn copy_items(tabs: &[&Tab], titles: (&str, &str), shortcuts: [Option<String>; 2]) -> MenuEntry {
    let [plain_hint, markdown_hint] = shortcuts;
    let plain = link_text(tabs, false);
    let markdown = link_text(tabs, true);
    let mut primary = MenuItem::new("copy", titles.0)
        .icon(Icon::Link)
        .enabled(plain.is_some())
        .shortcut(plain_hint);
    if let Some(text) = plain {
        primary = primary.msg(Msg::Copy(text));
    }
    let mut alternate = MenuItem::new("copyMd", titles.1)
        .icon(Icon::Link)
        .enabled(markdown.is_some())
        .shortcut(markdown_hint);
    if let Some(text) = markdown {
        alternate = alternate.msg(Msg::Copy(text));
    }
    primary.alternate(alternate).entry()
}

fn away_from_pin(tab: &Tab) -> bool {
    tab.pinned_url
        .as_deref()
        .is_some_and(|pinned| !tab.url.is_empty() && clean_url(pinned) != clean_url(&tab.url))
}

fn pinned_section_title(state: &BrowserState, tab: &Tab) -> String {
    let name = state
        .profile(tab.profile_id.as_str())
        .map_or_else(|| "Profile".to_owned(), |p| p.name.clone());
    format!("Pinned in {name}")
}

fn window_title(state: &BrowserState, window: &BrowserWindow) -> String {
    let name = state
        .profile(window.profile_id.as_str())
        .map_or_else(|| "Profile".to_owned(), |p| p.name.clone());
    let label = state
        .active_tab(window.id.as_str())
        .map_or_else(|| "New Tab".to_owned(), |t| t.label());
    let others = state
        .view_tabs(window.id.as_str(), None)
        .len()
        .saturating_sub(1);
    if others > 0 {
        format!("{name} — {label} & {}", plural(others, "Tab"))
    } else {
        format!("{name} — {label}")
    }
}

fn window_items(
    state: &BrowserState,
    here: &BrowserWindow,
    mover: &dyn Fn(Option<ardia_state::WindowId>) -> Msg,
) -> Vec<MenuEntry> {
    state
        .window_order
        .iter()
        .filter(|id| **id != here.id)
        .filter_map(|id| state.window(id.as_str()))
        .filter(|w| w.kind == WindowKind::Main)
        .map(|w| {
            MenuItem::new(
                SharedString::from(format!("window:{}", w.id)),
                window_title(state, w),
            )
            .msg(mover(Some(w.id.clone())))
            .entry()
        })
        .chain(
            state
                .window_order
                .iter()
                .any(|id| {
                    *id != here.id
                        && state
                            .window(id.as_str())
                            .is_some_and(|w| w.kind == WindowKind::Main)
                })
                .then_some(MenuEntry::Separator),
        )
        .chain(std::iter::once(
            MenuItem::new("window:new", "New Window")
                .msg(mover(None))
                .entry(),
        ))
        .collect()
}

fn profile_items(
    state: &BrowserState,
    current: impl Fn(&ardia_state::ProfileId) -> bool,
    msgs: impl Fn(&ardia_state::ProfileId) -> Vec<Msg>,
) -> Vec<MenuEntry> {
    state
        .profile_order
        .iter()
        .filter_map(|id| state.profile(id.as_str()).map(|p| (id, p)))
        .map(|(id, profile)| {
            let here = current(id);
            let mut item = MenuItem::new(
                SharedString::from(format!("profile:{id}")),
                profile.name.clone(),
            )
            .checked(here)
            .enabled(!here);
            for msg in msgs(id) {
                item = item.msg(msg);
            }
            item.entry()
        })
        .collect()
}

fn move_to_profile(tabs: &[TabId], profile: &ardia_state::ProfileId) -> Vec<Msg> {
    vec![store(Action::MoveTabsToProfile {
        tabs: tabs.to_vec(),
        profile: profile.clone(),
        before: None,
        background: false,
    })]
}

fn destinations(
    state: &BrowserState,
    window: &BrowserWindow,
    tabs: &[TabId],
    incognito: bool,
    current: impl Fn(&ardia_state::ProfileId) -> bool,
    with_window: bool,
) -> Vec<MenuEntry> {
    let mut profile = MenuEntry::submenu(
        "moveToProfile",
        "Profile",
        Some(Icon::Person),
        profile_items(state, current, |id| move_to_profile(tabs, id)),
    );
    if let MenuEntry::Submenu(sub) = &mut profile {
        sub.enabled = !incognito;
    }
    let mut out = vec![profile];
    if with_window {
        let mut windows = MenuEntry::submenu(
            "moveToWindow",
            "Window",
            Some(Icon::Window),
            window_items(state, window, &|target| Msg::MoveTabsToWindow {
                tabs: tabs.to_vec(),
                window: target,
            }),
        );
        if let MenuEntry::Submenu(sub) = &mut windows {
            sub.enabled = !incognito;
        }
        out.push(windows);
    }
    out
}

fn group_path(state: &BrowserState, group: &GroupId) -> String {
    let mut names = Vec::new();
    let mut at = state.group(group.as_str());
    while let Some(g) = at {
        names.push(if g.name.is_empty() {
            "Untitled".to_owned()
        } else {
            g.name.clone()
        });
        at = g.parent_id.as_ref().and_then(|p| state.group(p.as_str()));
        if names.len() > 16 {
            break;
        }
    }
    names.reverse();
    names.join(" › ")
}

fn group_items(
    state: &BrowserState,
    window: &BrowserWindow,
    exclude: Option<&GroupId>,
    tabs: &[TabId],
) -> Vec<MenuEntry> {
    let item = |id: &GroupId| {
        MenuItem::new(
            SharedString::from(format!("group:{id}")),
            group_path(state, id),
        )
        .msg(store(Action::AddToGroup {
            group: id.clone(),
            tabs: tabs.to_vec(),
        }))
    };
    let mut listed: Vec<(bool, MenuItem)> = state
        .groups
        .values()
        .filter(|g| g.window_id == window.id && g.profile_id == window.profile_id)
        .filter(|g| Some(&g.id) != exclude)
        .map(|g| (g.pinned, item(&g.id)))
        .collect();
    listed.sort_by(|a, b| a.1.title.cmp(&b.1.title));
    let pinned: Vec<MenuEntry> = listed
        .iter()
        .filter(|(p, _)| *p)
        .map(|(_, i)| i.clone().entry())
        .collect();
    let rest: Vec<MenuEntry> = listed
        .into_iter()
        .filter(|(p, _)| !*p)
        .map(|(_, i)| i.entry())
        .collect();
    if pinned.is_empty() {
        return rest;
    }
    let mut out = vec![MenuEntry::Header("Pinned".into())];
    out.extend(pinned);
    if !rest.is_empty() {
        out.push(MenuEntry::Separator);
        out.extend(rest);
    }
    out
}

fn visible_with_active(state: &BrowserState, window: &BrowserWindow, tab: &Tab) -> bool {
    let Some(active) = window.active_tab() else {
        return false;
    };
    *active == tab.id
        || state
            .split_of(active.as_str())
            .is_some_and(|s| s.contains(tab.id.as_str()))
}

fn can_sleep(state: &BrowserState, window: &BrowserWindow, tab: &Tab) -> bool {
    tab.live.engine_tab_id.is_some()
        && !tab.url.is_empty()
        && !visible_with_active(state, window, tab)
}

pub fn tab_or_selection(
    state: &BrowserState,
    window: &BrowserWindow,
    tab: &TabId,
) -> Vec<MenuEntry> {
    tab_or_selection_with(state, window, tab, &[])
}

pub fn tab_or_selection_with(
    state: &BrowserState,
    window: &BrowserWindow,
    tab: &TabId,
    targets: &[crate::sync_api::SendTarget],
) -> Vec<MenuEntry> {
    tab_or_selection_full(state, window, tab, targets, &TabExtras::default())
}

pub fn tab_or_selection_full(
    state: &BrowserState,
    window: &BrowserWindow,
    tab: &TabId,
    targets: &[crate::sync_api::SendTarget],
    extras: &TabExtras,
) -> Vec<MenuEntry> {
    let selection = &window.chrome.selection;
    if selection.len() > 1 && selection.contains(tab) {
        return with_symbols(multi_tab_menu(state, window, selection), MULTI_TAB_SYMBOLS);
    }
    with_symbols(
        tab_menu_full(state, window, tab, targets, extras),
        TAB_SYMBOLS,
    )
}

pub const TAB_SYMBOLS: &[(&str, &str)] = &[
    ("copy", "link"),
    ("copyMd", "link"),
    ("duplicate", "plus.square.on.square"),
    ("unsplit", "rectangle.split.2x1.slash"),
    ("split", "rectangle.split.2x1"),
    ("backToPin", "arrow.uturn.backward"),
    ("unpinMember", "pin.slash"),
    ("pinRow", "pin"),
    ("pin", "pin.slash"),
    ("moveTo", "arrow.up.forward.square"),
    ("pinTile", "square.grid.2x2"),
    ("leaveFolder", "folder.badge.minus"),
    ("newFolder", "folder.badge.plus"),
    ("ungroupTab", "folder.badge.minus"),
    ("newGroup", "folder.badge.plus"),
    ("moveToGroup", "folder"),
    ("moveToProfile", "person"),
    ("moveToWindow", "macwindow"),
    ("exitPip", "pip.exit"),
    ("unbookmark", "minus.circle"),
    ("customize", "slider.horizontal.3"),
    ("rename", "pencil"),
    ("resetName", "arrow.counterclockwise"),
    ("icon", "photo"),
    ("resetIcon", "arrow.counterclockwise"),
    ("letters", "textformat"),
    ("resetLetters", "arrow.counterclockwise"),
    ("replacePin", "pin"),
    ("editPin", "link"),
    ("engine", "globe"),
    ("unloadTopApp", "moon.zzz"),
    ("sleep", "moon.zzz"),
    ("close", "xmark"),
    ("closeTabs", "xmark.square"),
];

pub const MULTI_TAB_SYMBOLS: &[(&str, &str)] = &[
    ("pinTiles", "square.grid.2x2"),
    ("moveToGroup", "folder"),
    ("ungroup", "folder.badge.minus"),
    ("moveToProfile", "person"),
    ("moveToWindow", "macwindow"),
    ("bookmarkTo", "bookmark"),
    ("copy", "link"),
    ("copyMd", "link"),
    ("duplicate", "plus.square.on.square"),
    ("unpin", "pin.slash"),
    ("pinRows", "pin"),
    ("newGroup", "folder.badge.plus"),
    ("moveTo", "arrow.up.forward.square"),
    ("close", "xmark"),
    ("closeOthers", "xmark.square"),
];

pub const GROUP_SYMBOLS: &[(&str, &str)] = &[
    ("newTab", "plus.app"),
    ("copy", "link"),
    ("copyMd", "link"),
    ("duplicate", "plus.square.on.square"),
    ("moveTo", "arrow.up.forward.square"),
    ("moveToProfile", "person"),
    ("moveToWindow", "macwindow"),
    ("bookmarkBar", "bookmark"),
    ("rename", "pencil"),
    ("icon", "photo"),
    ("color", "paintpalette"),
    ("nest", "folder.badge.plus"),
    ("sleep", "moon.zzz"),
    ("ungroup", "folder.badge.minus"),
    ("close", "xmark"),
    ("delete", "trash"),
];

pub const SIDEBAR_SYMBOLS: &[(&str, &str)] = &[
    ("newTab", "plus.app"),
    ("newTabInSplit", "rectangle.split.2x1"),
    ("reopen", "clock.arrow.circlepath"),
    ("newGroup", "folder.badge.plus"),
    ("addShared", "person.2"),
    ("closeDuplicates", "square.on.square"),
    ("closeAll", "xmark"),
];

fn symbol_for(key: &str, table: &[(&str, &'static str)]) -> Option<&'static str> {
    table.iter().find(|(k, _)| *k == key).map(|(_, s)| *s)
}

fn item_with_symbol(mut item: MenuItem, table: &[(&str, &'static str)]) -> MenuItem {
    if let Some(symbol) = symbol_for(&item.key, table) {
        item.symbol = Some(SharedString::new_static(symbol));
    }
    item.alternate = item
        .alternate
        .map(|alternate| Box::new(item_with_symbol(*alternate, table)));
    item
}

pub fn with_symbols(entries: Vec<MenuEntry>, table: &[(&str, &'static str)]) -> Vec<MenuEntry> {
    entries
        .into_iter()
        .map(|entry| match entry {
            MenuEntry::Item(item) => MenuEntry::Item(item_with_symbol(item, table)),
            MenuEntry::Submenu(mut sub) => {
                if let Some(symbol) = symbol_for(&sub.key, table) {
                    sub.symbol = Some(SharedString::new_static(symbol));
                }
                sub.children = with_symbols(sub.children, table);
                MenuEntry::Submenu(sub)
            }
            other => other,
        })
        .collect()
}

pub const SEND_TAB: &str = "syncSendTab:";

pub fn device_icon(symbol: &str) -> Icon {
    Icon::from_symbol(symbol).unwrap_or(Icon::Laptop)
}

pub fn send_tab_entry(tab: &Tab, targets: &[crate::sync_api::SendTarget]) -> Option<MenuEntry> {
    let lower = tab.url.to_ascii_lowercase();
    if !(lower.starts_with("http:") || lower.starts_with("https:")) || targets.is_empty() {
        return None;
    }
    let item = |key: String, title: String, target: &crate::sync_api::SendTarget| {
        MenuItem::new(key, title)
            .icon(device_icon(crate::sync_api::device_symbol(
                target.kind,
                &target.name,
            )))
            .msg(Msg::Command(SharedString::from(format!(
                "{SEND_TAB}{}:{}",
                tab.id, target.id
            ))))
            .entry()
    };
    if let [only] = targets {
        return Some(item(
            format!("sendTo:{}", only.id),
            format!("Send to {}", only.name),
            only,
        ));
    }
    Some(MenuEntry::submenu(
        "sendToDevice",
        "Send to Device",
        Some(Icon::MacbookAndIphone),
        targets
            .iter()
            .map(|t| item(format!("sendTo:{}", t.id), t.name.clone(), t))
            .collect(),
    ))
}

struct Facts {
    housed: bool,
    member_pin: bool,
    tile: bool,
    row: bool,
    above: Vec<TabId>,
    below: Vec<TabId>,
    others: Vec<TabId>,
    group: Option<GroupId>,
    split: Option<ardia_state::SplitId>,
    incognito: bool,
    across: bool,
    active: bool,
}

fn facts(state: &BrowserState, window: &BrowserWindow, tab: &Tab) -> Facts {
    let list: Vec<TabId> = state
        .view_tabs(window.id.as_str(), None)
        .iter()
        .filter(|t| !state.in_pinned_container(t.id.as_str()))
        .map(|t| t.id.clone())
        .collect();
    let housed = state.in_pinned_container(tab.id.as_str());
    let index = list.iter().position(|id| *id == tab.id);
    let (above, below) = match (housed, index) {
        (false, Some(at)) => (list[..at].to_vec(), list[at + 1..].to_vec()),
        _ => (Vec::new(), Vec::new()),
    };
    Facts {
        housed,
        member_pin: housed && tab.pin.is_none(),
        tile: tab.pin.as_ref().is_some_and(TabPin::is_tile),
        row: tab.pin.as_ref().is_some_and(TabPin::is_row),
        others: if housed {
            Vec::new()
        } else {
            list.into_iter().filter(|id| *id != tab.id).collect()
        },
        above,
        below,
        group: state.group_of(tab.id.as_str()).map(|g| g.id.clone()),
        split: state.split_of(tab.id.as_str()).map(|s| s.id.clone()),
        incognito: tab.profile_id.is_incognito(),
        across: state.tab_layout(window.id.as_str()) == TabLayout::Top,
        active: window.active_tab() == Some(&tab.id),
    }
}

fn pin_items(state: &BrowserState, tab: &Tab, f: &Facts) -> Vec<MenuEntry> {
    let reset = (f.housed && away_from_pin(tab)).then(|| {
        MenuItem::new("backToPin", "Reset Pinned Tab")
            .icon(Icon::Undo)
            .shortcut(hint_when(f.active, state, "returnToPinnedUrl"))
            .msg(store(Action::ReturnToPinnedUrl {
                tab: tab.id.clone(),
            }))
            .entry()
    });
    let mut out = Vec::new();
    if f.member_pin {
        out.push(
            MenuItem::new("unpinMember", "Unpin")
                .icon(Icon::PinSlash)
                .msg(store(Action::RemoveFromGroups {
                    tabs: vec![tab.id.clone()],
                }))
                .entry(),
        );
    } else if tab.pin.is_none() {
        if f.split.is_none() {
            out.push(
                MenuItem::new("pinRow", "Pin Tab")
                    .icon(Icon::Pin)
                    .shortcut(hint_when(f.active, state, "togglePinnedRow"))
                    .msg(store(Action::SetPin {
                        tab: tab.id.clone(),
                        pin: Some(TabPin::Row),
                    }))
                    .entry(),
            );
        }
        return out;
    } else {
        out.push(
            MenuItem::new(
                "pin",
                if f.row {
                    "Unpin"
                } else {
                    "Unpin from Top Apps"
                },
            )
            .icon(Icon::PinSlash)
            .shortcut(hint_when(f.active && f.row, state, "togglePinnedRow"))
            .msg(store(Action::SetPin {
                tab: tab.id.clone(),
                pin: None,
            }))
            .entry(),
        );
    }
    out.extend(reset);
    out
}

fn split_items(state: &BrowserState, tab: &Tab, f: &Facts) -> Vec<MenuEntry> {
    if f.split.is_some() {
        return vec![
            MenuItem::new("unsplit", "Remove from Split View")
                .icon(Icon::Split)
                .msg(store(Action::RemoveFromSplit {
                    tab: tab.id.clone(),
                }))
                .entry(),
        ];
    }
    if f.tile {
        return Vec::new();
    }
    let open = if f.active {
        Msg::command("openSplitPane")
    } else {
        Msg::Store(Action::ActivateTab {
            tab: tab.id.clone(),
        })
    };
    let mut item = MenuItem::new("split", "Open in Split View")
        .icon(Icon::Split)
        .shortcut(hint_when(f.active, state, "openSplitPane"))
        .msg(open);
    if !f.active {
        item = item.msg(Msg::command("openSplitPane"));
    }
    vec![item.entry()]
}

fn bookmark_folder_items(
    state: &BrowserState,
    window: &BrowserWindow,
    tabs: &[TabId],
) -> Vec<MenuEntry> {
    if !state.settings.show_bookmarks {
        return Vec::new();
    }
    let Some(tree) = state.bookmarks_of(&window.profile_id) else {
        return Vec::new();
    };
    let file_into = |parent: &ardia_state::ids::BookmarkId, key: String, title: String| {
        let mut item = MenuItem::new(SharedString::from(key), title);
        for tab in tabs.iter().filter_map(|t| state.tab(t.as_str())) {
            if tab.url.is_empty() {
                continue;
            }
            item = item.msg(store(Action::AddBookmark {
                profile: tab.profile_id.clone(),
                parent: Some(parent.clone()),
                title: tab.display_title(),
                url: tab.url.clone(),
            }));
        }
        item.entry()
    };
    let (bar, other) = (tree.bar(), tree.other());
    let mut folders = vec![
        file_into(&bar, "folder:bar".into(), "Bookmarks Bar".into()),
        file_into(&other, "folder:other".into(), "Other Bookmarks".into()),
    ];
    for root in [&bar, &other] {
        for child in tree.children(root.as_str()) {
            if let Some(node @ ardia_state::bookmarks::BookmarkNode::Folder { .. }) =
                tree.get(child.as_str())
            {
                folders.push(file_into(
                    node.id(),
                    format!("folder:{}", node.id()),
                    node.title().to_owned(),
                ));
            }
        }
    }
    folders.push(MenuEntry::Separator);
    folders.push(
        MenuItem::new("folder:new", "New Folder…")
            .msg(Msg::BookmarkTabsToNewFolder(tabs.to_vec()))
            .entry(),
    );
    vec![MenuEntry::submenu(
        "bookmarkTo",
        "Bookmarks Folder",
        Some(Icon::Bookmark),
        folders,
    )]
}

fn mute_items(state: &BrowserState, tab: &Tab) -> Vec<MenuEntry> {
    if tab.url.is_empty() {
        return Vec::new();
    }
    let mute = ardia_state::mute::mute_state(state, tab);
    let mute_icon = if mute.is_some() {
        Icon::Speaker
    } else {
        Icon::SpeakerSlash
    };
    let item = MenuItem::new("mute", ardia_state::mute::mute_title(mute))
        .icon(mute_icon)
        .msg(Msg::Stores(ardia_state::mute::toggle_mute(state, tab)));
    if mute == Some(ardia_state::mute::MuteState::Site) {
        return vec![item.entry()];
    }
    let site = MenuItem::new("muteSite", ardia_state::mute::site_mute_title(mute))
        .icon(Icon::SpeakerSlash)
        .msg(Msg::Stores(ardia_state::mute::toggle_site_mute(state, tab)));
    vec![item.alternate(site).entry()]
}

fn grouping_items(
    state: &BrowserState,
    window: &BrowserWindow,
    tab: &Tab,
    f: &Facts,
) -> Vec<MenuEntry> {
    if f.tile {
        if tab.pin.as_ref().and_then(TabPin::folder).is_some() {
            return vec![
                MenuItem::new("leaveFolder", "Remove from Folder")
                    .icon(Icon::Folder)
                    .msg(store(Action::LeaveTileFolder {
                        tabs: vec![tab.id.clone()],
                    }))
                    .entry(),
            ];
        }
        if state.settings.top_app_folders {
            return vec![
                MenuItem::new("newFolder", "New Folder…")
                    .icon(Icon::Folder)
                    .msg(Msg::NewTileFolder(tab.id.clone()))
                    .entry(),
            ];
        }
        return Vec::new();
    }
    let mut out = Vec::new();
    if !f.member_pin {
        out.push(match &f.group {
            Some(_) => MenuItem::new("ungroupTab", "Remove from Group")
                .icon(Icon::Folder)
                .msg(store(Action::RemoveFromGroups {
                    tabs: vec![tab.id.clone()],
                }))
                .entry(),
            None => MenuItem::new("newGroup", "New Group")
                .icon(Icon::Folder)
                .shortcut(hint_when(f.active, state, "newGroupWithTabs"))
                .msg(store(Action::CreateGroup {
                    tabs: vec![tab.id.clone()],
                    name: "New Group".into(),
                }))
                .entry(),
        });
    }
    let groups = group_items(
        state,
        window,
        f.group.as_ref(),
        std::slice::from_ref(&tab.id),
    );
    if !groups.is_empty() {
        out.push(MenuEntry::submenu(
            "moveToGroup",
            "Group",
            Some(Icon::Folder),
            groups,
        ));
    }
    out
}

fn move_to(state: &BrowserState, window: &BrowserWindow, tab: &Tab, f: &Facts) -> MenuEntry {
    let place = if f.member_pin || f.split.is_some() {
        Vec::new()
    } else if f.tile {
        vec![
            MenuItem::new("pinRow", pinned_section_title(state, tab))
                .icon(Icon::Pin)
                .msg(store(Action::SetPin {
                    tab: tab.id.clone(),
                    pin: Some(TabPin::Row),
                }))
                .entry(),
        ]
    } else {
        vec![
            MenuItem::new("pinTile", "Top Apps")
                .icon(Icon::Grid)
                .msg(store(Action::SetPin {
                    tab: tab.id.clone(),
                    pin: Some(TabPin::TILE),
                }))
                .entry(),
        ]
    };
    let destinations = destinations(
        state,
        window,
        std::slice::from_ref(&tab.id),
        f.incognito,
        |id| *id == tab.profile_id,
        true,
    );
    MenuEntry::submenu(
        "moveTo",
        "Move to",
        Some(Icon::Window),
        sections(vec![
            place,
            grouping_items(state, window, tab, f),
            destinations,
        ]),
    )
}

fn bookmark_items(state: &BrowserState, tab: &Tab, f: &Facts) -> Vec<MenuEntry> {
    if !state.settings.show_bookmarks {
        return Vec::new();
    }
    let existing = state
        .bookmarks_of(&tab.profile_id)
        .filter(|_| !tab.url.is_empty())
        .and_then(|tree| tree.find_url(&tab.url).map(|node| node.id().clone()));
    match existing {
        None => {
            let mut item = MenuItem::new("bookmark", "Bookmark Tab…")
                .icon(Icon::Bookmark)
                .enabled(!tab.url.is_empty())
                .shortcut(hint_when(f.active, state, "bookmarkPage"));
            if !tab.url.is_empty() {
                item = item.msg(store(Action::AddBookmark {
                    profile: tab.profile_id.clone(),
                    parent: None,
                    title: tab.display_title(),
                    url: tab.url.clone(),
                }));
            }
            vec![item.entry()]
        }
        Some(id) => vec![
            MenuItem::new("bookmark", "Edit Bookmark…")
                .icon(Icon::BookmarkFill)
                .msg(Msg::command("manageBookmarks"))
                .alternate(
                    MenuItem::new("unbookmark", "Remove Bookmark")
                        .icon(Icon::Minus)
                        .msg(store(Action::RemoveBookmark {
                            profile: tab.profile_id.clone(),
                            id,
                        })),
                )
                .entry(),
        ],
    }
}

fn customize(state: &BrowserState, tab: &Tab, housed: bool, unread: Vec<MenuEntry>) -> MenuEntry {
    let mut names = vec![
        MenuItem::new("rename", "Rename…")
            .icon(Icon::TextFormat)
            .msg(Msg::Rename(Some(RenameTarget::Tab(tab.id.clone()))))
            .entry(),
    ];
    if tab.custom_title.as_deref().is_some_and(|t| !t.is_empty()) {
        names.push(
            MenuItem::new("resetName", "Reset Name")
                .icon(Icon::Undo)
                .msg(store(Action::RenameTab {
                    tab: tab.id.clone(),
                    title: None,
                }))
                .entry(),
        );
    }
    names.push(
        MenuItem::new("icon", "Change Icon…")
            .icon(Icon::Photo)
            .msg(Msg::Command(SharedString::from(format!(
                "changeTabIcon:{}",
                tab.id
            ))))
            .entry(),
    );
    if tab.custom_icon.is_some() {
        names.push(
            MenuItem::new("resetIcon", "Reset Icon")
                .icon(Icon::Undo)
                .msg(store(Action::SetTabIcon {
                    tab: tab.id.clone(),
                    icon: None,
                }))
                .entry(),
        );
    }
    names.extend(crate::sidebar::tile_letters::menu_items(state, tab));
    if housed {
        let away = tab.pinned_url.as_deref().is_some_and(|home| {
            !home.is_empty()
                && !tab.url.is_empty()
                && !ardia_state::tabs::same_page_key(&tab.url, home)
        });
        names.push(MenuEntry::Separator);
        names.push(
            MenuItem::new("replacePin", "Replace Pinned URL with Current")
                .icon(Icon::Pin)
                .enabled(away)
                .msg(store(Action::SetPinnedUrl {
                    tab: tab.id.clone(),
                    url: None,
                }))
                .entry(),
        );
        names.push(
            MenuItem::new("editPin", "Edit Pinned URL…")
                .icon(Icon::Link)
                .msg(Msg::EditPinnedUrl(tab.id.clone()))
                .entry(),
        );
    }
    let mut others = Vec::new();
    if let Some(title) =
        ardia_state::engines::tab_menu_engine_item(state, tab).filter(|_| cfg!(target_os = "macos"))
    {
        others.push(
            MenuItem::new("engine", title)
                .icon(Icon::Globe)
                .msg(Msg::Command(SharedString::from(format!(
                    "togglePageEngine:{}",
                    tab.id
                ))))
                .entry(),
        );
    }
    others.extend(unread);
    if !others.is_empty() {
        names.push(MenuEntry::Separator);
        names.extend(others);
    }
    MenuEntry::submenu("customize", "Customize", Some(Icon::Sliders), names)
}

fn close_items(state: &BrowserState, tab: &Tab, f: &Facts) -> Vec<MenuEntry> {
    if f.housed {
        return Vec::new();
    }
    let close = |key: &'static str, title: &str, tabs: &[TabId]| {
        MenuItem::new(key, title)
            .enabled(!tabs.is_empty())
            .msg(store(Action::CloseTabs {
                tabs: tabs.to_vec(),
                last_closes_window: false,
            }))
            .entry()
    };
    let split = f
        .split
        .clone()
        .map(|split| {
            vec![
                MenuItem::new("closeSplit", "Close Split View")
                    .msg(Msg::Count("split_view_closes"))
                    .msg(store(Action::CloseTabs {
                        tabs: state
                            .split(split.as_str())
                            .map(|s| s.tab_ids())
                            .unwrap_or_default(),
                        last_closes_window: false,
                    }))
                    .entry(),
            ]
        })
        .unwrap_or_default();
    vec![
        MenuItem::new("close", "Close Tab")
            .icon(Icon::XMark)
            .shortcut(hint_when(f.active, state, "closeTab"))
            .msg(store(Action::CloseTabs {
                tabs: vec![tab.id.clone()],
                last_closes_window: false,
            }))
            .entry(),
        MenuEntry::submenu(
            "closeTabs",
            "Close Tabs",
            Some(Icon::XMark),
            sections(vec![
                vec![
                    close("closeOthers", "Close Other Tabs", &f.others),
                    close(
                        "closeBelow",
                        if f.across {
                            "Close Tabs to the Right"
                        } else {
                            "Close Tabs Below"
                        },
                        &f.below,
                    ),
                    close(
                        "closeAbove",
                        if f.across {
                            "Close Tabs to the Left"
                        } else {
                            "Close Tabs Above"
                        },
                        &f.above,
                    ),
                ],
                split,
            ]),
        ),
    ]
}

pub fn tab_menu(state: &BrowserState, window: &BrowserWindow, tab: &TabId) -> Vec<MenuEntry> {
    tab_menu_with(state, window, tab, &[])
}

pub fn tab_menu_with(
    state: &BrowserState,
    window: &BrowserWindow,
    tab: &TabId,
    targets: &[crate::sync_api::SendTarget],
) -> Vec<MenuEntry> {
    tab_menu_full(state, window, tab, targets, &TabExtras::default())
}

pub fn tab_menu_full(
    state: &BrowserState,
    window: &BrowserWindow,
    tab: &TabId,
    targets: &[crate::sync_api::SendTarget],
    extras: &TabExtras,
) -> Vec<MenuEntry> {
    let Some(tab) = state.tab(tab.as_str()) else {
        return Vec::new();
    };
    let f = facts(state, window, tab);
    let mut quick = vec![copy_items(
        &[tab.as_ref()],
        ("Copy Link", "Copy Link as Markdown"),
        [
            hint_when(f.active, state, "copyUrl"),
            hint_when(f.active, state, "copyUrlAsMarkdown"),
        ],
    )];
    quick.push(
        MenuItem::new("duplicate", "Duplicate")
            .icon(Icon::Copy)
            .msg(store(Action::DuplicateTab {
                tab: tab.id.clone(),
            }))
            .entry(),
    );
    quick.extend(split_items(state, tab, &f));
    quick.extend(mute_items(state, tab));
    quick.extend(pip_entries(tab, extras.pip_open));
    let mut places = pin_items(state, tab, &f);
    places.push(move_to(state, window, tab, &f));
    places.extend(bookmark_items(state, tab, &f));
    if !f.incognito {
        places.extend(send_tab_entry(tab, targets));
    }
    places.extend(extras.calendar.iter().cloned());
    let plugins = if f.incognito {
        Vec::new()
    } else {
        extras.plugins.clone()
    };
    let unread = unread_entries(state, tab, extras.page_unread);
    let mut last = vec![customize(state, tab, f.housed, unread)];
    if f.housed
        && f.tile
        && state.settings.keep_top_apps_running
        && !ardia_state::pin_share::open_pages(state, &tab.id).is_empty()
    {
        last.push(
            MenuItem::new("unloadTopApp", "Unload")
                .icon(Icon::Moon)
                .msg(Msg::Count("top_apps_unloaded_from_menu"))
                .msg(store(Action::UnloadTopApp {
                    tab: tab.id.clone(),
                }))
                .entry(),
        );
    } else if can_sleep(state, window, tab) {
        last.push(
            MenuItem::new("sleep", "Sleep Tab")
                .icon(Icon::Moon)
                .msg(Msg::Count("tabs_slept_from_menu"))
                .msg(store(Action::SleepTabs {
                    tabs: vec![tab.id.clone()],
                }))
                .entry(),
        );
    }
    sections(vec![
        quick,
        places,
        plugins,
        last,
        close_items(state, tab, &f),
    ])
}

pub fn multi_tab_menu(
    state: &BrowserState,
    window: &BrowserWindow,
    ids: &[TabId],
) -> Vec<MenuEntry> {
    let tabs: Vec<&Arc<Tab>> = ids.iter().filter_map(|id| state.tab(id.as_str())).collect();
    let ids: Vec<TabId> = tabs.iter().map(|t| t.id.clone()).collect();
    let n = ids.len();
    let all_pinned = tabs.iter().all(|t| t.pin.is_some());
    let all_tiles = tabs
        .iter()
        .all(|t| t.pin.as_ref().is_some_and(TabPin::is_tile));
    let all_rows = tabs
        .iter()
        .all(|t| t.pin.as_ref().is_some_and(TabPin::is_row));
    let incognito = tabs.iter().any(|t| t.profile_id.is_incognito());
    let others: Vec<TabId> = state
        .view_tabs(window.id.as_str(), None)
        .iter()
        .filter(|t| !ids.contains(&t.id) && !state.in_pinned_container(t.id.as_str()))
        .map(|t| t.id.clone())
        .collect();
    let clear = store(Action::SelectTabs {
        window: window.id.clone(),
        tabs: Vec::new(),
    });
    let pin_all = |pin: Option<TabPin>| -> Vec<Msg> {
        ids.iter()
            .map(|tab| {
                store(Action::SetPin {
                    tab: tab.clone(),
                    pin: pin.clone(),
                })
            })
            .collect()
    };
    let with_msgs = |mut item: MenuItem, msgs: Vec<Msg>| {
        for msg in msgs {
            item = item.msg(msg);
        }
        item.msg(clear.clone()).entry()
    };
    let mut placing = Vec::new();
    if !all_tiles {
        placing.push(with_msgs(
            MenuItem::new("pinTiles", "Top Apps").icon(Icon::Grid),
            pin_all(Some(TabPin::TILE)),
        ));
    }
    if all_pinned && !all_rows {
        placing.push(with_msgs(
            MenuItem::new("pinRows", pinned_section_title(state, tabs[0])).icon(Icon::Pin),
            pin_all(Some(TabPin::Row)),
        ));
    }
    let mut grouping = Vec::new();
    let groups = group_items(state, window, None, &ids);
    if !groups.is_empty() {
        grouping.push(MenuEntry::submenu(
            "moveToGroup",
            "Group",
            Some(Icon::Folder),
            groups,
        ));
    }
    if tabs.iter().any(|t| state.group_of(t.id.as_str()).is_some()) {
        grouping.push(with_msgs(
            MenuItem::new("ungroup", "Remove from Group").icon(Icon::Folder),
            vec![store(Action::RemoveFromGroups { tabs: ids.clone() })],
        ));
    }
    let destinations = destinations(
        state,
        window,
        &ids,
        incognito,
        |id| tabs.iter().all(|t| t.profile_id == *id),
        true,
    );
    let move_to = MenuEntry::submenu(
        "moveTo",
        "Move to",
        Some(Icon::Window),
        sections(vec![
            placing,
            grouping,
            destinations,
            bookmark_folder_items(state, window, &ids),
        ]),
    );
    let refs: Vec<&Tab> = tabs.iter().map(|t| t.as_ref()).collect();
    let copy_title = format!("Copy {n} Links");
    let copy_md_title = format!("Copy {n} Links as Markdown");
    sections(vec![
        vec![
            copy_items(&refs, (&copy_title, &copy_md_title), [None, None]),
            with_msgs(
                MenuItem::new("duplicate", format!("Duplicate {n} Tabs")).icon(Icon::Copy),
                ids.iter()
                    .map(|tab| store(Action::DuplicateTab { tab: tab.clone() }))
                    .collect(),
            ),
        ],
        vec![
            if all_pinned {
                with_msgs(
                    MenuItem::new("unpin", format!("Unpin {n} Tabs")).icon(Icon::PinSlash),
                    pin_all(None),
                )
            } else {
                with_msgs(
                    MenuItem::new("pinRows", format!("Pin {n} Tabs")).icon(Icon::Pin),
                    pin_all(Some(TabPin::Row)),
                )
            },
            with_msgs(
                MenuItem::new("newGroup", format!("New Group with {n} Tabs"))
                    .icon(Icon::Folder)
                    .enabled(!all_tiles)
                    .shortcut(hint_when(!all_tiles, state, "newGroupWithTabs")),
                vec![store(Action::CreateGroup {
                    tabs: ids
                        .iter()
                        .filter(|id| {
                            state
                                .tab(id.as_str())
                                .is_some_and(|t| !t.pin.as_ref().is_some_and(TabPin::is_tile))
                        })
                        .cloned()
                        .collect(),
                    name: "New Group".into(),
                })],
            ),
            move_to,
        ],
        vec![
            with_msgs(
                MenuItem::new("close", format!("Close {n} Tabs")).icon(Icon::XMark),
                vec![store(Action::CloseTabs {
                    tabs: ids.clone(),
                    last_closes_window: false,
                })],
            ),
            with_msgs(
                MenuItem::new("closeOthers", "Close Other Tabs")
                    .icon(Icon::XMark)
                    .enabled(!others.is_empty()),
                vec![store(Action::CloseTabs {
                    tabs: others,
                    last_closes_window: false,
                })],
            ),
        ],
    ])
}

const GROUP_COLOR_ORDER: [GroupColor; 9] = [
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

fn neutral_swatch(dark: bool) -> Hsla {
    let white = if dark { 1.0 } else { 0.0 };
    gpui::hsla(0.0, 0.0, white, 0.3)
}

fn color_items(group: &GroupId, current: Option<GroupColor>, dark: bool) -> Vec<MenuEntry> {
    let set = |color: Option<GroupColor>| {
        store(Action::UpdateGroup {
            group: group.clone(),
            patch: GroupPatch {
                color: Some(color),
                ..GroupPatch::default()
            },
        })
    };
    let mut out = vec![
        MenuItem::new("color:none", "None")
            .checked(current == Some(GroupColor::NoColor))
            .msg(set(Some(GroupColor::NoColor)))
            .entry(),
        MenuItem::new("color:neutral", "Neutral")
            .swatch(Some(neutral_swatch(dark)))
            .checked(current.is_none())
            .msg(set(None))
            .entry(),
        MenuEntry::Separator,
    ];
    out.extend(GROUP_COLOR_ORDER.iter().map(|color| {
        MenuItem::new(
            SharedString::from(format!("color:{}", color.key())),
            color_name(*color),
        )
        .swatch(group_tint(Some(*color)).map(hsla))
        .checked(current == Some(*color))
        .msg(set(Some(*color)))
        .entry()
    }));
    out
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub enum SharedFolderMenu {
    #[default]
    Unavailable,
    Share,
    Shared {
        status: String,
    },
}

pub const SHARED_FOLDER_COMMAND: &str = "sharedFolder:";
pub const ADD_SHARED_FOLDER: &str = "addSharedFolder";

fn shared_command(kind: &str, group: &GroupId) -> Msg {
    Msg::Command(SharedString::from(format!(
        "{SHARED_FOLDER_COMMAND}{kind}:{group}"
    )))
}

pub fn shared_folder_items(group: &GroupId, shared: &SharedFolderMenu) -> Vec<MenuEntry> {
    let share = MenuItem::new("shareFolder", "Share Folder…")
        .icon(Icon::PersonBadgePlus)
        .msg(shared_command("share", group))
        .entry();
    match shared {
        SharedFolderMenu::Unavailable => Vec::new(),
        SharedFolderMenu::Share => vec![share],
        SharedFolderMenu::Shared { status } => vec![MenuEntry::submenu(
            "sharedFolder",
            "Shared Folder",
            Some(Icon::PersonTwo),
            vec![
                MenuItem::new("sharedStatus", status.clone())
                    .enabled(false)
                    .entry(),
                MenuEntry::Separator,
                share,
                MenuItem::new("revealFolder", "Show in Finder")
                    .icon(Icon::Folder)
                    .msg(shared_command("reveal", group))
                    .entry(),
                MenuItem::new("stopSyncing", "Stop Syncing Folder")
                    .icon(Icon::IcloudSlash)
                    .msg(shared_command("stop", group))
                    .entry(),
            ],
        )],
    }
}

pub fn group_menu(
    state: &BrowserState,
    window: &BrowserWindow,
    group: &GroupId,
    dark: bool,
) -> Vec<MenuEntry> {
    group_menu_with(state, window, group, dark, &SharedFolderMenu::Unavailable)
}

pub fn group_menu_with(
    state: &BrowserState,
    window: &BrowserWindow,
    group: &GroupId,
    dark: bool,
    shared: &SharedFolderMenu,
) -> Vec<MenuEntry> {
    group_menu_full(state, window, group, dark, shared, Vec::new())
}

pub fn group_menu_full(
    state: &BrowserState,
    window: &BrowserWindow,
    group: &GroupId,
    dark: bool,
    shared: &SharedFolderMenu,
    plugins: Vec<MenuEntry>,
) -> Vec<MenuEntry> {
    let Some(g) = state.group(group.as_str()) else {
        return Vec::new();
    };
    let shown = window
        .active_tab()
        .and_then(|t| state.group_of(t.as_str()))
        .is_some_and(|active| active.id == g.id);
    let members: Vec<&Tab> = g
        .tab_ids
        .iter()
        .filter_map(|id| state.tab(id.as_str()).map(|t| t.as_ref()))
        .collect();
    let mut placing = Vec::new();
    if g.parent_id.is_none() {
        placing.push(
            MenuItem::new("pin", if g.pinned { "Unpin Group" } else { "Pin Group" })
                .icon(if g.pinned { Icon::PinSlash } else { Icon::Pin })
                .msg(store(Action::UpdateGroup {
                    group: group.clone(),
                    patch: GroupPatch {
                        pinned: Some(!g.pinned),
                        ..GroupPatch::default()
                    },
                }))
                .entry(),
        );
    }
    placing.push(MenuEntry::submenu(
        "moveTo",
        "Move to",
        Some(Icon::Window),
        {
            let mut entries = destinations(
                state,
                window,
                &g.tab_ids,
                g.profile_id.is_incognito(),
                |id| *id == g.profile_id,
                false,
            );
            if !g.pinned {
                let mut windows = MenuEntry::submenu(
                    "moveToWindow",
                    "Window",
                    Some(Icon::Window),
                    window_items(state, window, &|target| Msg::MoveGroupToWindow {
                        group: group.clone(),
                        window: target,
                    }),
                );
                if let MenuEntry::Submenu(sub) = &mut windows {
                    sub.enabled = !g.profile_id.is_incognito();
                }
                entries.push(windows);
            }
            if state.settings.show_bookmarks {
                entries.push(
                    MenuItem::new("bookmarkBar", "Bookmarks Bar")
                        .icon(Icon::Bookmark)
                        .msg(Msg::GroupToBookmarksBar(group.clone()))
                        .entry(),
                );
            }
            entries
        },
    ));
    placing.push(MenuEntry::submenu(
        "customize",
        "Customize",
        Some(Icon::Sliders),
        vec![
            MenuItem::new("rename", "Rename…")
                .icon(Icon::TextFormat)
                .msg(Msg::Rename(Some(RenameTarget::Group(group.clone()))))
                .entry(),
            MenuItem::new(
                "icon",
                if g.icon.as_deref().is_some_and(|icon| !icon.is_empty()) {
                    "Change Icon…"
                } else {
                    "Add Icon…"
                },
            )
            .icon(Icon::Photo)
            .msg(Msg::Command(SharedString::from(format!(
                "changeTabIcon:group:{group}"
            ))))
            .entry(),
            MenuEntry::submenu(
                "color",
                "Color",
                Some(Icon::Palette),
                color_items(group, g.color, dark),
            ),
            MenuEntry::Separator,
            MenuItem::new("nest", "New Nested Group")
                .icon(Icon::Folder)
                .msg(store(Action::NewNestedGroup {
                    parent: group.clone(),
                }))
                .entry(),
        ],
    ));
    placing.push(crate::sidebar::sort_tabs::sort_menu(
        state,
        &crate::sidebar::sort_tabs::SortTarget::group(&window.id, group),
        false,
    ));
    placing.extend(shared_folder_items(group, shared));
    placing.extend(plugins);
    let sleepers: Vec<TabId> = members
        .iter()
        .filter(|t| can_sleep(state, window, t))
        .map(|t| t.id.clone())
        .collect();
    sections(vec![
        vec![
            MenuItem::new("newTab", "New Tab in Group")
                .icon(Icon::Plus)
                .shortcut(hint_when(shown, state, "newTabInGroup"))
                .msg(Msg::NewTabInGroup(group.clone()))
                .entry(),
            copy_items(
                &members,
                ("Copy All Links", "Copy All Links as Markdown"),
                [None, None],
            ),
            MenuItem::new("duplicate", "Duplicate Group")
                .icon(Icon::Copy)
                .msg(store(Action::DuplicateGroup {
                    group: group.clone(),
                }))
                .entry(),
        ],
        placing,
        vec![
            MenuItem::new("sleep", "Sleep Tabs")
                .icon(Icon::Moon)
                .enabled(!sleepers.is_empty())
                .msg(Msg::Count("groups_slept_from_menu"))
                .msg(store(Action::SleepTabs { tabs: sleepers }))
                .entry(),
            MenuItem::new("ungroup", "Ungroup")
                .icon(Icon::Folder)
                .msg(store(Action::Ungroup {
                    group: group.clone(),
                }))
                .entry(),
            MenuItem::new("close", "Close Group")
                .icon(Icon::XMark)
                .shortcut(hint_when(shown, state, "closeTabGroup"))
                .msg(store(Action::CloseGroup {
                    group: group.clone(),
                }))
                .alternate(
                    MenuItem::new("delete", "Delete Group")
                        .icon(Icon::Trash)
                        .msg(store(Action::DeleteGroup {
                            group: group.clone(),
                        })),
                )
                .entry(),
        ],
    ])
}

pub fn profile_menu(state: &BrowserState, window: &BrowserWindow) -> Vec<MenuEntry> {
    if window.kind == WindowKind::Incognito {
        return Vec::new();
    }
    let mut out: Vec<MenuEntry> = state
        .profile_order
        .iter()
        .filter_map(|id| state.profile(id.as_str()).map(|p| (id, p)))
        .map(|(id, profile)| {
            MenuItem::new(
                SharedString::from(format!("profile:{id}")),
                profile.name.clone(),
            )
            .checked(*id == window.profile_id)
            .swatch(Some(hsla(ardia_theme::profile_accent(profile.look()))))
            .shortcut(hint(state, &format!("switchProfile:{id}")))
            .msg(store(Action::SwitchProfile {
                window: window.id.clone(),
                profile: id.clone(),
            }))
            .entry()
        })
        .collect();
    out.push(MenuEntry::Separator);
    out.push(
        MenuItem::new("new", "New Profile…")
            .icon(Icon::Plus)
            .msg(Msg::command("newProfile"))
            .entry(),
    );
    out.push(
        MenuItem::new("edit", "Manage Profiles…")
            .icon(Icon::Gear)
            .msg(Msg::SettingsAt(Pane::Profiles))
            .entry(),
    );
    out
}

fn settings(patch: SettingsPatch) -> Msg {
    store(Action::UpdateSettings {
        patch,
        from_sync: false,
    })
}

pub fn bookmarks_bar_shown(state: &BrowserState, window: &BrowserWindow) -> bool {
    match state.settings.bookmarks_bar {
        BookmarksBar::Always => true,
        BookmarksBar::Never => false,
        BookmarksBar::NewTab => state
            .active_tab(window.id.as_str())
            .is_none_or(|t| t.url.is_empty()),
    }
}

pub fn browser_layout_items(state: &BrowserState, window: &BrowserWindow) -> Vec<MenuEntry> {
    let s = &state.settings;
    let in_sidebar = state.tab_layout(window.id.as_str()) == TabLayout::Sidebar;
    let right = s.sidebar_side == ardia_state::model::SidebarSide::Right;
    let minimal = s.minimalism_mode;
    let address_in_toolbar = !minimal && (!in_sidebar || s.address_bar == AddressBar::Toolbar);
    let toggle_hint = hint(state, "toggleTabLayout");
    let layout = |key: &'static str, title: &str, glyph: Icon, checked: bool, shows_hint: bool| {
        MenuItem::new(key, title)
            .icon(glyph)
            .checked(checked)
            .shortcut(if shows_hint {
                toggle_hint.clone()
            } else {
                None
            })
            .msg(Msg::Command(SharedString::from(format!(
                "setTabLayout:{}",
                key.trim_start_matches("layout:")
            ))))
            .entry()
    };
    let mut address = Vec::new();
    if in_sidebar && !minimal {
        address.push(
            MenuItem::new("layout:addressToolbar", "Address Bar in Toolbar")
                .icon(Icon::TopStrip)
                .checked(s.address_bar == AddressBar::Toolbar)
                .msg(settings(
                    SettingsPatch::new().set("addressBar", AddressBar::Toolbar),
                ))
                .entry(),
        );
        address.push(
            MenuItem::new("layout:addressSidebar", "Address Bar in Sidebar")
                .icon(Icon::SidebarLeft)
                .checked(s.address_bar == AddressBar::Sidebar)
                .msg(settings(
                    SettingsPatch::new().set("addressBar", AddressBar::Sidebar),
                ))
                .entry(),
        );
    }
    if address_in_toolbar {
        address.push(
            MenuItem::new("layout:compactToolbar", "Compact Toolbar")
                .checked(s.compact_toolbar)
                .msg(settings(
                    SettingsPatch::new().set("compactToolbar", !s.compact_toolbar),
                ))
                .entry(),
        );
    }
    let mut shown = vec![
        MenuItem::new("layout:autoHide", "Auto-Hide Tabs")
            .icon(Icon::Eye)
            .checked(!state.sidebar_shown(window.id.as_str()) && in_sidebar)
            .shortcut(hint(state, "toggleSidebar"))
            .msg(store(Action::ToggleSidebar {
                window: window.id.clone(),
            }))
            .entry(),
        MenuItem::new("layout:minimalism", "Minimalism Mode")
            .icon(Icon::HalfLeft)
            .checked(minimal)
            .shortcut(hint(state, "toggleMinimalism"))
            .msg(settings(
                SettingsPatch::new().set("minimalismMode", !minimal),
            ))
            .entry(),
    ];
    if s.show_bookmarks && window.kind != WindowKind::Incognito {
        let on = bookmarks_bar_shown(state, window);
        shown.push(
            MenuItem::new("layout:bookmarksBar", "Bookmarks Bar")
                .icon(Icon::Bookmark)
                .checked(on)
                .shortcut(hint(state, "toggleBookmarksBar"))
                .msg(settings(SettingsPatch::new().set(
                    "bookmarksBar",
                    if on {
                        BookmarksBar::Never
                    } else {
                        BookmarksBar::Always
                    },
                )))
                .entry(),
        );
    }
    sections(vec![
        vec![
            layout(
                "layout:sidebarLeft",
                "Sidebar on Left",
                Icon::SidebarLeft,
                in_sidebar && !right,
                !in_sidebar && !right,
            ),
            layout(
                "layout:sidebarRight",
                "Sidebar on Right",
                Icon::SidebarRight,
                in_sidebar && right,
                !in_sidebar && right,
            ),
            layout(
                "layout:top",
                "Top Tab Bar",
                Icon::TopStrip,
                !in_sidebar,
                in_sidebar,
            ),
        ],
        address,
        shown,
    ])
}

pub fn sidebar_menu(state: &BrowserState, window: &BrowserWindow) -> Vec<MenuEntry> {
    sidebar_menu_with(state, window, false)
}

pub fn sidebar_menu_with(
    state: &BrowserState,
    window: &BrowserWindow,
    can_add_shared: bool,
) -> Vec<MenuEntry> {
    let active = state.active_tab(window.id.as_str()).is_some();
    sections(vec![
        vec![
            MenuItem::new("newTab", "New Tab")
                .icon(Icon::Plus)
                .shortcut(hint(state, "newTab"))
                .msg(Msg::command("newTab"))
                .entry(),
            MenuItem::new("newTabInSplit", "New Tab in Split View")
                .icon(Icon::Split)
                .enabled(active)
                .shortcut(hint(state, "openSplitPane"))
                .msg(store(Action::OpenSplitPane {
                    window: window.id.clone(),
                    side: SplitSide::Right,
                    url: None,
                }))
                .entry(),
            MenuItem::new("reopen", "Reopen Closed Tab")
                .icon(Icon::History)
                .enabled(state.newest_closed(Some(&window.id)).is_some())
                .shortcut(hint(state, "reopenClosedTab"))
                .msg(store(Action::ReopenClosed {
                    window: Some(window.id.clone()),
                }))
                .entry(),
        ],
        vec![
            MenuItem::new("newGroup", "New Group")
                .icon(Icon::Folder)
                .msg(store(Action::NewTab {
                    window: window.id.clone(),
                    tab: NewTab::default(),
                }))
                .msg(store(Action::SelectTabs {
                    window: window.id.clone(),
                    tabs: Vec::new(),
                }))
                .msg(Msg::command("newGroupWithTabs"))
                .entry(),
        ]
        .into_iter()
        .chain(can_add_shared.then(|| {
            MenuItem::new("addShared", "Add Shared Folder…")
                .icon(Icon::PersonTwo)
                .msg(Msg::command(ADD_SHARED_FOLDER))
                .entry()
        }))
        .chain([crate::sidebar::sort_tabs::sort_menu(
            state,
            &crate::sidebar::sort_tabs::SortTarget::window(&window.id),
            true,
        )])
        .collect(),
        vec![MenuEntry::submenu(
            "browserLayout",
            "Browser Layout",
            Some(Icon::SidebarLeft),
            browser_layout_items(state, window),
        )],
        vec![
            {
                let duplicates = crate::sidebar::overflow_menu::duplicate_tabs(state, window);
                let mut item = MenuItem::new("closeDuplicates", "Close Duplicate Tabs")
                    .shortcut(hint(state, "closeDuplicateTabs"))
                    .enabled(!duplicates.is_empty());
                if !duplicates.is_empty() {
                    item = item.msg(Msg::command("closeDuplicateTabs"));
                }
                item.entry()
            },
            MenuItem::new("closeAll", "Close All Tabs")
                .icon(Icon::XMark)
                .shortcut(hint(state, "closeAllTabs"))
                .msg(Msg::command("closeAllTabs"))
                .entry(),
        ],
    ])
}
