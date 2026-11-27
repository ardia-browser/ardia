use ardia_state::{Action, NewTab, TabId};
use gpui::{App, PromptLevel, Window};

use crate::host_data::ExtensionItem;
use crate::msg::{Emit, Msg};
use crate::popovers::context_menu::{MenuEntry, MenuItem, sections};
use crate::popovers::extensions::WEB_STORE_URL;
use crate::settings::rows::Pane;
use crate::window::chrome::Chrome;

fn open_tab(c: &Chrome, url: &str) -> Msg {
    Msg::Store(Action::NewTab {
        window: c.window.id.clone(),
        tab: NewTab {
            url: Some(url.to_owned()),
            ..NewTab::default()
        },
    })
}

pub fn cast_source_entries(c: &Chrome, tab: &TabId) -> Vec<MenuEntry> {
    let screen = c.host.cast_panel(tab).is_some_and(|panel| panel.screen);
    let source = |key: &'static str, title: &'static str, on: bool, screen: bool| {
        MenuItem::new(key, title)
            .checked(on)
            .msg(Msg::CastSource {
                tab: tab.clone(),
                screen,
            })
            .entry()
    };
    vec![
        source("tab", "Cast Tab", !screen, false),
        source("screen", "Cast Screen", screen, true),
    ]
}

pub fn overflow_entries(c: &Chrome) -> Vec<MenuEntry> {
    let list = c.host.extensions(&c.window.id);
    let enabled = list.menu();
    let tab = c.active.map(|tab| tab.id.clone());
    let listed: Vec<MenuEntry> = enabled
        .iter()
        .map(|item| {
            let mut row = MenuItem::new(format!("extension:{}", item.id), item.name.clone());
            if item.pinned {
                row = row.symbol("pin.fill");
            }
            match &tab {
                Some(tab) => row
                    .msg(Msg::Extension {
                        tab: tab.clone(),
                        extension: item.id.clone(),
                    })
                    .entry(),
                None => row.enabled(false).entry(),
            }
        })
        .collect();
    sections(vec![
        listed,
        vec![
            MenuItem::new("manage", "Manage Extensions…")
                .symbol("puzzlepiece.extension")
                .msg(Msg::SettingsAt(Pane::Extensions))
                .entry(),
            MenuItem::new("add", "Add Extension…")
                .symbol("plus")
                .msg(open_tab(c, WEB_STORE_URL))
                .entry(),
        ],
    ])
}

pub fn cast_routes_entries(c: &Chrome) -> Vec<MenuEntry> {
    let mut out: Vec<MenuEntry> = c
        .host
        .cast_routes(&c.window.id)
        .into_iter()
        .map(|route| {
            MenuItem::new(
                format!("stop:{}", route.id),
                format!("Stop Casting to {}", route.sink),
            )
            .symbol("stop.circle")
            .msg(Msg::StopCastRoute(route.id))
            .entry()
        })
        .collect();
    out.push(MenuEntry::Separator);
    let mut open = MenuItem::new("open", "Cast…").symbol("tv.and.mediabox");
    match c.active {
        Some(tab) => open = open.msg(Msg::Cast(tab.id.clone())),
        None => open = open.enabled(false),
    }
    out.push(open.entry());
    out
}

pub fn extension_entries(c: &Chrome, extension: &str) -> Vec<MenuEntry> {
    let list = c.host.extensions(&c.window.id);
    let Some(item) = list.find(extension).cloned() else {
        return Vec::new();
    };
    let mut first = Vec::new();
    if let Some(options) = item.options_url.clone().filter(|_| item.enabled) {
        first.push(
            MenuItem::new("options", "Options")
                .symbol("gearshape")
                .msg(open_tab(c, &options))
                .entry(),
        );
    }
    if item.side_panel && item.enabled {
        let open = c
            .host
            .side_panel(&c.window.id)
            .is_some_and(|panel| panel.extension_id == item.id);
        first.push(
            MenuItem::new(
                "sidePanel",
                if open {
                    "Close Side Panel"
                } else {
                    "Open Side Panel"
                },
            )
            .symbol("sidebar.right")
            .msg(Msg::ToggleSidePanel(item.id.clone()))
            .entry(),
        );
    }
    first.push(
        MenuItem::new(
            "pin",
            if item.pinned {
                "Unpin from Toolbar"
            } else {
                "Pin to Toolbar"
            },
        )
        .symbol(if item.pinned { "pin.slash" } else { "pin" })
        .msg(Msg::PinExtension {
            extension: item.id.clone(),
            pinned: !item.pinned,
        })
        .entry(),
    );
    sections(vec![
        first,
        vec![
            MenuItem::new("manage", "Manage Extension")
                .symbol("puzzlepiece.extension")
                .msg(open_tab(c, &manage_url(&item.id)))
                .entry(),
        ],
        vec![
            MenuItem::new("remove", "Remove Extension…")
                .symbol("trash")
                .enabled(item.may_modify)
                .msg(Msg::AskRemoveExtension(item.id.clone()))
                .entry(),
        ],
    ])
}

pub fn ask_remove_extension(
    c_host: &std::sync::Arc<dyn crate::host::UiHost>,
    window_id: &ardia_state::WindowId,
    emit: &Emit,
    extension: &str,
    window: &mut Window,
    cx: &mut App,
) {
    let list = c_host.extensions(window_id);
    let Some(item) = list.find(extension).cloned() else {
        return;
    };
    if !item.may_modify {
        return;
    }
    let title = format!("Remove “{}”?", item.name);
    let answer = window.prompt(
        PromptLevel::Warning,
        &title,
        Some(removal_message(&item)),
        &["Remove", "Cancel"],
        cx,
    );
    let emit = emit.clone();
    let id = item.id.clone();
    window
        .spawn(cx, async move |cx| {
            if answer.await.is_ok_and(|choice| choice == 0) {
                let _ = cx.update(|window, cx| emit.send(Msg::RemoveExtension(id), window, cx));
            }
        })
        .detach();
}

pub fn manage_url(extension: &str) -> String {
    format!("chrome://extensions/?id={extension}")
}

pub fn removal_message(item: &ExtensionItem) -> &'static str {
    if item.from_web_store {
        "Its data and settings will be removed too."
    } else if cfg!(target_os = "macos") {
        "The extension's folder stays on your Mac."
    } else {
        "The extension's folder stays on your computer."
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn removal_copy_matches_the_old_confirmation() {
        let store = ExtensionItem {
            from_web_store: true,
            ..ExtensionItem::default()
        };
        assert_eq!(
            removal_message(&store),
            "Its data and settings will be removed too."
        );
        assert!(
            removal_message(&ExtensionItem::default())
                .starts_with("The extension's folder stays on your")
        );
    }
}
