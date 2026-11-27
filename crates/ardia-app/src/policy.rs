use std::sync::Weak;

use ardia_engine::{
    DefaultPolicy, EngineProfileId, EngineWindowId, HostPolicy, KeyChord, NewBrowserKind,
    NewBrowserWindow,
};
use ardia_state::windows::WindowKind;

use crate::coordinator::AppCoordinator;
use crate::maps::ProfileOwner;

pub const RESERVED_COMMANDS: &[&str] = &[
    "newTab",
    "newWindow",
    "newIncognitoWindow",
    "newLittleArdia",
    "closeTab",
    "closeWindow",
    "reopenClosedTab",
    "quit",
    "focusCommandBar",
    "nextTab",
    "previousTab",
    "selectTab",
    "selectLastTab",
    "toggleSidebar",
];

pub struct AppPolicy {
    coordinator: Weak<AppCoordinator>,
    keys: DefaultPolicy,
    page_full_screen_keys: DefaultPolicy,
}

pub fn page_full_screen_chords() -> Vec<KeyChord> {
    use ardia_engine::Modifiers;
    vec![
        KeyChord::new("q", Modifiers::COMMAND),
        KeyChord::new("f", Modifiers::COMMAND | Modifiers::CONTROL),
        KeyChord::new("f", Modifiers::FUNCTION),
    ]
}

impl std::fmt::Debug for AppPolicy {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("AppPolicy")
            .field("reserved", &self.keys.reserved_shortcut_count())
            .finish()
    }
}

impl AppPolicy {
    pub fn new(
        coordinator: Weak<AppCoordinator>,
        reserved: impl IntoIterator<Item = KeyChord>,
    ) -> Self {
        let keys = DefaultPolicy::new();
        keys.set_reserved_shortcuts(reserved);
        let page_full_screen_keys = DefaultPolicy::new();
        page_full_screen_keys.set_reserved_shortcuts(page_full_screen_chords());
        Self {
            coordinator,
            keys,
            page_full_screen_keys,
        }
    }
}

impl HostPolicy for AppPolicy {
    fn new_browser_window(
        &self,
        profile: Option<EngineProfileId>,
        kind: NewBrowserKind,
    ) -> NewBrowserWindow {
        match kind {
            NewBrowserKind::Popup => self
                .coordinator
                .upgrade()
                .filter(|coordinator| coordinator.popups_open_as_tabs())
                .and_then(|coordinator| coordinator.window_for_new_tabs(profile))
                .map_or(NewBrowserWindow::Create, NewBrowserWindow::Use),
            NewBrowserKind::Normal => self
                .coordinator
                .upgrade()
                .and_then(|coordinator| coordinator.window_for_new_tabs(profile))
                .map_or(NewBrowserWindow::Create, NewBrowserWindow::Use),
            NewBrowserKind::App | NewBrowserKind::Devtools | NewBrowserKind::Other => {
                NewBrowserWindow::Refuse
            }
        }
    }

    fn is_reserved_key(&self, chord: &KeyChord) -> bool {
        let page_full_screen = self
            .coordinator
            .upgrade()
            .is_some_and(|coordinator| coordinator.focused_page_full_screen());
        if page_full_screen {
            self.page_full_screen_keys.is_reserved_key(chord)
        } else {
            self.keys.is_reserved_key(chord)
        }
    }

    fn window_should_close(&self, window: EngineWindowId) -> bool {
        if let Some(coordinator) = self.coordinator.upgrade() {
            coordinator.engine_window_closing(window);
        }
        true
    }

    fn menu_item_enabled(&self, command: &str, arg: Option<&str>) -> bool {
        self.coordinator
            .upgrade()
            .is_none_or(|coordinator| coordinator.command_enabled(command, arg))
    }
}

pub fn popups_open_as_tabs_in(enabled: bool, front: Option<WindowKind>) -> bool {
    enabled && front != Some(WindowKind::LittleArdia)
}

impl AppCoordinator {
    pub fn popups_open_as_tabs(&self) -> bool {
        let state = self.store().snapshot();
        let front = state
            .focus_order
            .first()
            .and_then(|id| state.window(id.as_str()))
            .map(|w| w.kind);
        popups_open_as_tabs_in(state.settings.popups_open_as_tabs, front)
    }

    pub fn focused_page_full_screen(&self) -> bool {
        let state = self.store().snapshot();
        state
            .focus_order
            .first()
            .is_some_and(|window| state.fullscreen_tab(window.as_str()).is_some())
    }

    pub fn window_for_new_tabs(&self, profile: Option<EngineProfileId>) -> Option<EngineWindowId> {
        let state = self.store().snapshot();
        let bridge = self.bridge.try_lock()?;
        let owner = match profile {
            Some(profile) => Some(bridge.profiles.owner(profile)?.clone()),
            None => None,
        };
        let window = state
            .focus_order
            .iter()
            .chain(state.window_order.iter())
            .filter_map(|id| state.window(id.as_str()))
            .find(|w| match &owner {
                None => w.kind == WindowKind::Main,
                Some(ProfileOwner::Private(_)) => {
                    w.kind == WindowKind::Incognito
                        && bridge.profiles.engine_of(&w.profile_id) == profile
                }
                Some(ProfileOwner::Regular(profile)) => {
                    w.kind == WindowKind::Main
                        && (&w.profile_id == profile
                            || !state.view_tabs(w.id.as_str(), Some(profile)).is_empty())
                }
            })?;
        bridge.windows.by_left(&window.id).copied()
    }

    pub fn engine_window_closing(&self, window: EngineWindowId) {
        match self.bridge.try_lock() {
            Some(mut bridge) => {
                if bridge.windows.by_right(&window).is_some() {
                    bridge.closing_windows.insert(window);
                }
            }
            None => log::warn!("{window} closed while its state was busy"),
        }
    }

    pub fn command_enabled(&self, command: &str, arg: Option<&str>) -> bool {
        let state = self.store().snapshot();
        let window = self.command_window(&state);
        let tab = window.as_ref().and_then(|w| state.active_tab(w.as_str()));
        match command {
            "noop" => false,
            "togglePin" if arg == Some("tile") => {
                tab.is_some_and(|t| t.pin.as_ref().is_some_and(|pin| !pin.is_tile()))
            }
            "reopenClosedTab" => state.newest_closed(window.as_ref()).is_some(),
            "reopenClosedWindow" => !state.closed.windows.is_empty(),
            "clearRecentlyClosed" => {
                !ardia_state::closed::recently_closed_to_clear(&state, window.as_ref()).is_empty()
            }
            "closeTab" | "duplicateTab" | "togglePin" | "togglePinnedRow" | "reload"
            | "forceReload" | "stop" | "copyUrl" | "copyUrlAsMarkdown" | "share" | "toggleMute"
            | "findInPage" | "zoomIn" | "zoomOut" | "zoomReset" | "devTools" | "toggleDevTools"
            | "viewSource" | "print" | "savePage" => tab.is_some(),
            "back" => tab.is_some_and(|t| t.live.can_go_back),
            "forward" => tab.is_some_and(|t| t.live.can_go_forward),
            "returnToPinnedUrl" => {
                tab.is_some_and(|t| t.pinned_url.as_deref().is_some_and(|home| home != t.url))
            }
            "toggleReader" => tab.is_some_and(|t| {
                let reader = self.reader_status_of(&t.id);
                reader.active || reader.available
            }),
            "closeTabGroup" => tab.is_some_and(|t| state.group_of(t.id.as_str()).is_some()),
            "switchProfile" => arg.is_some_and(|profile| state.profile(profile).is_some()),
            "nextProfile" | "previousProfile" => state.profile_order.len() > 1,
            "findNext" | "findPrevious" => tab.is_some_and(|t| !t.live.find.query.is_empty()),
            "togglePageEngine" => tab
                .is_some_and(|t| ardia_state::engines::switchable_engine(&state.settings, &t.url)),
            _ => true,
        }
    }
}

#[cfg(target_os = "macos")]
pub fn reserved_chords(bar: &ardia_engine::macos::menu::MenuBar) -> Vec<KeyChord> {
    bar.commands()
        .into_iter()
        .filter(|item| RESERVED_COMMANDS.contains(&item.command.as_str()))
        .filter_map(|item| {
            let shortcut = item.shortcut.as_ref()?;
            Some(KeyChord::new(
                shortcut.key.clone(),
                ardia_engine::Modifiers(shortcut.modifiers),
            ))
        })
        .collect()
}

#[cfg(test)]
mod popup_tests {
    use super::*;

    #[test]
    fn pop_ups_open_as_tabs_only_when_chosen_and_never_from_little_ardia() {
        assert!(!popups_open_as_tabs_in(false, Some(WindowKind::Main)));
        assert!(popups_open_as_tabs_in(true, Some(WindowKind::Main)));
        assert!(popups_open_as_tabs_in(true, None));
        assert!(popups_open_as_tabs_in(true, Some(WindowKind::Incognito)));
        assert!(!popups_open_as_tabs_in(true, Some(WindowKind::LittleArdia)));
    }
}
