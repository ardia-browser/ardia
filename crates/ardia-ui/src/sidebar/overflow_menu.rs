use ardia_state::windows::BrowserWindow;
use ardia_state::{Action, BrowserState};

use crate::keybindings::hint;
use crate::msg::Msg;
use crate::popovers::context_menu::sections;
use crate::popovers::context_menu::{MenuEntry, MenuItem};
use crate::primitives::icons::Icon;
use crate::sidebar::model::sections as sections_of;

pub const CLOSED_SHOWN: usize = 15;
pub const CLEANED_SHOWN: usize = 20;

fn plural(n: usize, word: &str) -> String {
    if n == 1 {
        format!("1 {word}")
    } else {
        format!("{n} {word}s")
    }
}

fn snapshot_title(tab: &ardia_state::tabs::TabSnapshot) -> String {
    [
        tab.custom_title.as_deref().unwrap_or(""),
        tab.title.as_str(),
        tab.url.as_str(),
    ]
    .into_iter()
    .find(|t| !t.is_empty())
    .unwrap_or("New Tab")
    .to_owned()
}

fn restore(window: &BrowserWindow, id: &ardia_state::EntryId) -> Msg {
    Msg::Store(Action::RestoreClosed {
        id: id.clone(),
        window: Some(window.id.clone()),
    })
}

fn group_title(g: &ardia_state::closed::ClosedGroup) -> String {
    format!("{} ({})", g.group.name, plural(g.tabs.len(), "Tab"))
}

fn closed_entries(state: &BrowserState, window: &BrowserWindow) -> Vec<MenuEntry> {
    let private = window.kind == ardia_state::windows::WindowKind::Incognito;
    let default_profile = ardia_state::ProfileId::new(&state.settings.default_profile_id);
    let owner = |profile: Option<&ardia_state::ProfileId>| {
        profile
            .filter(|p| state.profile(p.as_str()).is_some())
            .unwrap_or(&default_profile)
            .clone()
    };
    let mut closed: Vec<(i64, MenuEntry)> = state
        .closed
        .tabs
        .iter()
        .filter(|c| c.tab.profile_id == window.profile_id)
        .filter(|c| private || !c.tab.profile_id.is_incognito())
        .map(|c| {
            (
                c.closed_at,
                MenuItem::new(format!("restore:{}", c.id.as_str()), snapshot_title(&c.tab))
                    .symbol("clock.arrow.circlepath")
                    .msg(restore(window, &c.id))
                    .entry(),
            )
        })
        .collect();
    if !private {
        closed.extend(
            state
                .closed
                .windows
                .iter()
                .filter(|c| owner(c.window.profile_id.as_ref()) == window.profile_id)
                .map(|c| {
                    (
                        c.closed_at,
                        MenuItem::new(
                            format!("restore:{}", c.id.as_str()),
                            crate::sidebar::overflow_menu::closed_window_title(c.tabs.len()),
                        )
                        .symbol("macwindow")
                        .msg(restore(window, &c.id))
                        .entry(),
                    )
                }),
        );
    }
    closed.extend(
        state
            .closed
            .groups
            .iter()
            .filter(|g| {
                private
                    || g.tabs
                        .first()
                        .is_some_and(|t| t.profile_id == window.profile_id)
            })
            .map(|g| {
                (
                    g.closed_at,
                    MenuItem::new(format!("restore:{}", g.id.as_str()), group_title(g))
                        .symbol("rectangle.stack")
                        .msg(restore(window, &g.id))
                        .entry(),
                )
            }),
    );
    closed.sort_by_key(|entry| std::cmp::Reverse(entry.0));
    closed
        .into_iter()
        .take(CLOSED_SHOWN)
        .map(|(_, entry)| entry)
        .collect()
}

pub fn closed_window_title(tabs: usize) -> String {
    match tabs {
        0 => "Window (Pinned Tabs)".to_owned(),
        1 => "Window (1 Tab)".to_owned(),
        count => format!("Window ({count} Tabs)"),
    }
}

fn history_entries(state: &BrowserState, window: &BrowserWindow) -> Vec<MenuEntry> {
    let closed = closed_entries(state, window);
    let cleaned_all: Vec<&ardia_state::closed::ClosedTab> = state
        .closed
        .cleaned_tabs
        .iter()
        .filter(|c| c.tab.profile_id == window.profile_id)
        .collect();
    let cleaned: Vec<MenuEntry> = cleaned_all
        .iter()
        .rev()
        .take(CLEANED_SHOWN)
        .map(|c| {
            MenuItem::new(format!("cleaned:{}", c.id.as_str()), snapshot_title(&c.tab))
                .msg(restore(window, &c.id))
                .entry()
        })
        .collect();
    let mut cleaned_group = Vec::new();
    if !cleaned.is_empty() {
        let mut restore_all = MenuItem::new(
            "restoreAll",
            format!("Restore {}", plural(cleaned_all.len(), "Tab")),
        );
        for c in &cleaned_all {
            restore_all = restore_all.msg(restore(window, &c.id));
        }
        let mut children = cleaned;
        children.push(MenuEntry::Separator);
        children.push(restore_all.entry());
        cleaned_group.push(
            MenuEntry::submenu("cleaned", "Recently Cleaned", None, children)
                .symbol("wand.and.stars"),
        );
    }
    let deleted: Vec<MenuEntry> = state
        .closed
        .deleted_groups
        .iter()
        .rev()
        .map(|g| {
            MenuItem::new(format!("restore:{}", g.id.as_str()), group_title(g))
                .symbol("trash")
                .msg(restore(window, &g.id))
                .entry()
        })
        .collect();
    if !deleted.is_empty() {
        cleaned_group.push(
            MenuEntry::submenu("deleted", "Recently Deleted Groups", None, deleted).symbol("trash"),
        );
    }
    let private = window.kind == ardia_state::windows::WindowKind::Incognito;
    let clear = if !private && !closed.is_empty() {
        vec![
            MenuItem::new("clearClosed", "Clear Recently Closed")
                .msg(Msg::Store(Action::ClearRecentlyClosed {
                    window: Some(window.id.clone()),
                }))
                .entry(),
        ]
    } else {
        Vec::new()
    };
    sections(vec![closed, cleaned_group, clear])
}

pub fn duplicate_tabs(state: &BrowserState, window: &BrowserWindow) -> Vec<ardia_state::TabId> {
    ardia_state::duplicate_tabs::duplicate_tab_ids(state, window.id.as_str())
}

static LAST_CLEAR_CLOSED_DUPLICATES: std::sync::atomic::AtomicBool =
    std::sync::atomic::AtomicBool::new(false);

pub fn note_tabs_cleared(duplicates: Option<usize>) {
    LAST_CLEAR_CLOSED_DUPLICATES.store(duplicates.is_some(), std::sync::atomic::Ordering::Relaxed);
    if let Some(closed) = duplicates {
        ardia_telemetry::counts::count("duplicate_tabs_closes");
        ardia_telemetry::counts::add("duplicate_tabs_closed", closed as u64);
    }
}

pub fn note_clear_undone() {
    if LAST_CLEAR_CLOSED_DUPLICATES.swap(false, std::sync::atomic::Ordering::Relaxed) {
        ardia_telemetry::counts::count("duplicate_tabs_undos");
    }
}

pub fn closed_duplicates_message(count: usize) -> String {
    format!("Closed {}", plural(count, "Duplicate Tab"))
}

pub fn synced_devices_entry(
    window: &BrowserWindow,
    devices: &[crate::sync_api::RemoteTabs],
) -> Option<MenuEntry> {
    use crate::sync_api::{device_label, device_symbol};
    let tabs = |d: &crate::sync_api::RemoteTabs| -> Vec<MenuEntry> {
        std::iter::once(
            MenuItem::new("synced-header", "Recent Tabs")
                .enabled(false)
                .entry(),
        )
        .chain(d.tabs.iter().enumerate().map(|(i, t)| {
            let title = if t.title.is_empty() {
                t.url.clone()
            } else {
                t.title.clone()
            };
            MenuItem::new(format!("synced:{}:{i}", d.device_id), title)
                .msg(Msg::Store(Action::NewTab {
                    window: window.id.clone(),
                    tab: ardia_state::NewTab {
                        url: Some(t.url.clone()),
                        ..ardia_state::NewTab::default()
                    },
                }))
                .entry()
        }))
        .collect()
    };
    let icon = |d: &crate::sync_api::RemoteTabs| {
        crate::popovers::menu_items::device_icon(device_symbol(d.kind, &d.name))
    };
    match devices {
        [] => None,
        [only] => Some(MenuEntry::submenu(
            "synced",
            format!("Your {} Tabs", device_label(only.kind, &only.name)),
            Some(icon(only)),
            tabs(only),
        )),
        many => Some(MenuEntry::submenu(
            "synced",
            "Your Devices",
            Some(Icon::MacbookAndIphone),
            many.iter()
                .map(|d| {
                    MenuEntry::submenu(
                        format!("device:{}", d.device_id),
                        d.name.clone(),
                        Some(icon(d)),
                        tabs(d),
                    )
                })
                .collect(),
        )),
    }
}

pub fn overflow_menu(state: &BrowserState, window: &BrowserWindow) -> Vec<MenuEntry> {
    overflow_menu_with(state, window, &[])
}

pub fn overflow_menu_with(
    state: &BrowserState,
    window: &BrowserWindow,
    devices: &[crate::sync_api::RemoteTabs],
) -> Vec<MenuEntry> {
    let order = sections_of(state, window.id.as_str()).ordered_tabs();
    let active = state.active_tab(window.id.as_str()).map(|t| t.id.clone());
    let open: Vec<MenuEntry> = order
        .iter()
        .filter_map(|id| state.tab(id.as_str()))
        .map(|tab| {
            MenuItem::new(format!("open:{}", tab.id.as_str()), tab.display_title())
                .checked(active.as_ref() == Some(&tab.id))
                .msg(Msg::Store(Action::ActivateTab {
                    tab: tab.id.clone(),
                }))
                .entry()
        })
        .collect();
    let history = history_entries(state, window);
    let history_enabled = !history.is_empty();
    let history = if history.is_empty() {
        vec![MenuItem::new("none", "Empty").enabled(false).entry()]
    } else {
        history
    };
    let duplicates = duplicate_tabs(state, window);
    let mut close_duplicates = MenuItem::new("closeDuplicates", "Close Duplicate Tabs")
        .symbol("square.on.square")
        .shortcut(hint(state, "closeDuplicateTabs"))
        .enabled(!duplicates.is_empty());
    if !duplicates.is_empty() {
        close_duplicates = close_duplicates.msg(Msg::command("closeDuplicateTabs"));
    }
    vec![
        MenuItem::new("search", "Search Tabs…")
            .symbol("magnifyingglass")
            .shortcut(hint(state, "searchTabs"))
            .msg(Msg::command("searchTabs"))
            .entry(),
        MenuEntry::Separator,
        MenuEntry::submenu("open", "Open Tabs", None, open)
            .symbol("square.stack")
            .enabled(!order.is_empty()),
    ]
    .into_iter()
    .chain(synced_devices_entry(window, devices))
    .chain([
        MenuEntry::submenu("closed", "Recently Closed", None, history)
            .symbol("clock.arrow.circlepath")
            .enabled(history_enabled),
        MenuEntry::Separator,
        MenuItem::new("clean", "Clean Up Tabs")
            .symbol("wand.and.stars")
            .shortcut(hint(state, "cleanUpTabs"))
            .msg(Msg::command("cleanUpTabs"))
            .entry(),
        close_duplicates.entry(),
        MenuItem::new("closeAll", "Close All Tabs")
            .symbol("xmark")
            .shortcut(hint(state, "closeAllTabs"))
            .msg(Msg::command("closeAllTabs"))
            .entry(),
    ])
    .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn plural_counts_read_naturally() {
        assert_eq!(plural(1, "Tab"), "1 Tab");
        assert_eq!(plural(3, "Tab"), "3 Tabs");
        assert_eq!(closed_duplicates_message(1), "Closed 1 Duplicate Tab");
        assert_eq!(closed_duplicates_message(2), "Closed 2 Duplicate Tabs");
    }
}
