use std::sync::Arc;

use ardia_state::splits::SplitSide;
use ardia_state::windows::WindowKind;
use ardia_state::{Action, BrowserState, NewTab, ProfileId, TabId, WindowId};
use gpui::{App, AsyncApp};

use crate::host::{Confirmation, UiHost};
use crate::pages::history_model::MANY_LINKS;

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
pub enum OpenAllMode {
    Tabs,
    Window,
    Incognito,
}

pub fn open_mode_for(platform: bool, shift: bool, alt: bool, middle: bool) -> OpenMode {
    if platform || middle {
        return if shift {
            OpenMode::Foreground
        } else {
            OpenMode::Background
        };
    }
    if alt {
        OpenMode::Split
    } else if shift {
        OpenMode::Window
    } else {
        OpenMode::Current
    }
}

fn private_window(state: &BrowserState, window: &WindowId) -> bool {
    state
        .window(window.as_str())
        .is_some_and(|w| w.kind == WindowKind::Incognito || w.profile_id.is_incognito())
}

fn original_profile(state: &BrowserState, window: &WindowId) -> Option<ProfileId> {
    state.window(window.as_str()).map(|w| {
        if w.profile_id.is_incognito() {
            w.profile_id.incognito_original()
        } else {
            w.profile_id.clone()
        }
    })
}

fn open_window(
    host: &Arc<dyn UiHost>,
    from: &WindowId,
    url: &str,
    incognito: bool,
) -> Option<WindowId> {
    let state = host.store().snapshot();
    let private = incognito || private_window(&state, from);
    let outcome = host
        .store()
        .dispatch(Action::OpenWindow {
            kind: if private {
                WindowKind::Incognito
            } else {
                WindowKind::Main
            },
            profile: original_profile(&state, from),
            url: Some(url.to_owned()),
            frame: None,
        })
        .ok()?;
    let created = outcome.window?;
    host.dispatch(Action::FocusWindow {
        window: created.clone(),
    });
    Some(created)
}

pub fn open_url(
    host: &Arc<dyn UiHost>,
    window: &WindowId,
    current: &TabId,
    url: &str,
    mode: OpenMode,
) {
    match mode {
        OpenMode::Incognito => {
            open_window(host, window, url, true);
        }
        OpenMode::Window => {
            open_window(host, window, url, false);
        }
        OpenMode::Current => host.navigate(window.clone(), current.clone(), url.to_owned()),
        OpenMode::Split => {
            let opened = host.store().dispatch(Action::OpenSplitPane {
                window: window.clone(),
                side: SplitSide::Right,
                url: Some(url.to_owned()),
            });
            if opened.is_err() {
                new_tab(host, window, url, false, None);
            }
        }
        OpenMode::Background => {
            new_tab(host, window, url, true, Some(current.clone()));
        }
        OpenMode::Foreground => {
            new_tab(host, window, url, false, None);
        }
    }
}

fn new_tab(
    host: &Arc<dyn UiHost>,
    window: &WindowId,
    url: &str,
    background: bool,
    opener: Option<TabId>,
) -> Option<TabId> {
    host.store()
        .dispatch(Action::NewTab {
            window: window.clone(),
            tab: NewTab {
                url: Some(url.to_owned()),
                background,
                opener,
                ..NewTab::default()
            },
        })
        .ok()
        .and_then(|outcome| outcome.tab)
}

fn open_in_order(
    host: &Arc<dyn UiHost>,
    window: &WindowId,
    urls: &[String],
    mut after: Option<TabId>,
) {
    for url in urls {
        let index = after.as_ref().and_then(|after| {
            host.store()
                .snapshot()
                .window(window.as_str())
                .and_then(|w| w.tab_ids.iter().position(|id| id == after))
                .map(|at| at + 1)
        });
        let opened = host
            .store()
            .dispatch(Action::NewTab {
                window: window.clone(),
                tab: NewTab {
                    url: Some(url.clone()),
                    background: true,
                    index,
                    ..NewTab::default()
                },
            })
            .ok()
            .and_then(|outcome| outcome.tab);
        after = opened.or(after);
    }
}

pub fn open_links_now(
    host: &Arc<dyn UiHost>,
    window: &WindowId,
    urls: &[String],
    mode: OpenAllMode,
) {
    let Some((first, rest)) = urls.split_first() else {
        return;
    };
    if mode == OpenAllMode::Tabs && host.store().snapshot().window(window.as_str()).is_some() {
        let opened = new_tab(host, window, first, false, None);
        open_in_order(host, window, rest, opened);
        return;
    }
    let Some(created) = open_window(host, window, first, mode == OpenAllMode::Incognito) else {
        return;
    };
    let active = host
        .store()
        .snapshot()
        .active_tab(created.as_str())
        .map(|tab| tab.id.clone());
    open_in_order(host, &created, rest, active);
}

pub fn open_links(
    host: Arc<dyn UiHost>,
    window: WindowId,
    urls: Vec<String>,
    mode: OpenAllMode,
    many_message: &'static str,
    cx: &mut App,
) {
    if urls.is_empty() {
        return;
    }
    if urls.len() <= MANY_LINKS {
        open_links_now(&host, &window, &urls, mode);
        return;
    }
    let answer = host.confirm_in_window(
        window.clone(),
        Confirmation {
            title: format!("Open {} tabs?", urls.len()),
            message: many_message.to_owned(),
            confirm: "Open All".to_owned(),
            destructive: false,
        },
    );
    cx.spawn(async move |cx: &mut AsyncApp| {
        if answer.await == Ok(true) {
            cx.update(|_| open_links_now(&host, &window, &urls, mode));
        }
    })
    .detach();
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn modifiers_pick_where_a_link_opens() {
        assert_eq!(open_mode_for(false, false, false, false), OpenMode::Current);
        assert_eq!(
            open_mode_for(true, false, false, false),
            OpenMode::Background
        );
        assert_eq!(
            open_mode_for(true, true, false, false),
            OpenMode::Foreground
        );
        assert_eq!(
            open_mode_for(false, false, false, true),
            OpenMode::Background
        );
        assert_eq!(open_mode_for(false, false, true, false), OpenMode::Split);
        assert_eq!(open_mode_for(false, true, false, false), OpenMode::Window);
    }
}
