use std::sync::Arc;

use ardia_state::model::TabPin;
use ardia_state::{Action, BrowserState, TabId, WindowId};
use gpui::{App, Window};

use crate::host::{TextPrompt, UiHost};
use crate::msg::{Emit, Msg};

pub fn edit_pinned_url_prompt(state: &BrowserState, tab: &TabId) -> Option<TextPrompt> {
    let t = state.tab(tab.as_str())?;
    if !state.in_pinned_container(tab.as_str()) {
        return None;
    }
    Some(TextPrompt {
        title: "Edit Pinned Page".into(),
        message: String::new(),
        value: t
            .pinned_url
            .clone()
            .filter(|u| !u.is_empty())
            .unwrap_or_else(|| t.url.clone()),
        placeholder: "Enter Pinned URL".into(),
        confirm: "Save".into(),
    })
}

pub fn pinned_url_from(typed: &str) -> Option<String> {
    let typed = typed.trim();
    if typed.is_empty() {
        return None;
    }
    Some(if typed.contains("://") {
        typed.to_owned()
    } else {
        format!("https://{typed}")
    })
}

pub fn folder_name_prompt(title: &str, value: &str) -> TextPrompt {
    TextPrompt {
        title: title.into(),
        message: String::new(),
        value: value.into(),
        placeholder: "Folder".into(),
        confirm: "Update".into(),
    }
}

fn ask(
    host: &Arc<dyn UiHost>,
    emit: &Emit,
    window_id: &WindowId,
    prompt: TextPrompt,
    answer: impl FnOnce(String) -> Option<Msg> + 'static,
    window: &mut Window,
    cx: &mut App,
) {
    let Some(reply) = host.prompt_in_window(window_id.clone(), prompt) else {
        return;
    };
    let emit = emit.clone();
    window
        .spawn(cx, async move |cx| {
            let Ok(Some(typed)) = reply.await else {
                return;
            };
            if let Some(msg) = answer(typed) {
                let _ = cx.update(|window, cx| emit.send(msg, window, cx));
            }
        })
        .detach();
}

pub fn edit_pinned_url(
    host: &Arc<dyn UiHost>,
    emit: &Emit,
    window_id: &WindowId,
    state: &BrowserState,
    tab: &TabId,
    window: &mut Window,
    cx: &mut App,
) {
    let Some(prompt) = edit_pinned_url_prompt(state, tab) else {
        return;
    };
    let tab = tab.clone();
    ask(
        host,
        emit,
        window_id,
        prompt,
        move |typed| {
            pinned_url_from(&typed).map(|url| {
                Msg::Store(Action::SetPinnedUrl {
                    tab,
                    url: Some(url),
                })
            })
        },
        window,
        cx,
    );
}

pub fn new_folder_with_tab(
    host: &Arc<dyn UiHost>,
    emit: &Emit,
    window_id: &WindowId,
    tab: &TabId,
    window: &mut Window,
    cx: &mut App,
) {
    host.dispatch(Action::AddToTileFolder {
        tabs: Vec::new(),
        onto: tab.clone(),
        before: None,
    });
    let state = host.store().snapshot();
    let Some(folder) = state
        .tab(tab.as_str())
        .and_then(|t| t.pin.as_ref().and_then(TabPin::folder).cloned())
    else {
        return;
    };
    let window_key = window_id.clone();
    ask(
        host,
        emit,
        window_id,
        folder_name_prompt("Name Folder", &folder.name),
        move |name| {
            Some(Msg::Store(Action::RenameTileFolder {
                window: window_key,
                folder: folder.id,
                name,
            }))
        },
        window,
        cx,
    );
}

pub fn tile_folder_of(
    state: &BrowserState,
    window_id: &WindowId,
    folder: &str,
) -> Option<ardia_state::model::TileFolder> {
    state
        .view_tabs(window_id.as_str(), None)
        .into_iter()
        .find_map(|t| {
            t.pin
                .as_ref()
                .and_then(TabPin::folder)
                .filter(|f| f.id == folder)
                .cloned()
        })
}

pub fn rename_folder(
    host: &Arc<dyn UiHost>,
    emit: &Emit,
    window_id: &WindowId,
    state: &BrowserState,
    folder: &str,
    window: &mut Window,
    cx: &mut App,
) {
    let Some(found) = tile_folder_of(state, window_id, folder) else {
        return;
    };
    let window_key = window_id.clone();
    ask(
        host,
        emit,
        window_id,
        folder_name_prompt("Rename Folder", &found.name),
        move |name| {
            Some(Msg::Store(Action::RenameTileFolder {
                window: window_key,
                folder: found.id,
                name,
            }))
        },
        window,
        cx,
    );
}
