use ardia_state::actions::{Action, NewTab};
use ardia_state::commands::Command;
use ardia_state::model::{TabLayout, TabPin};
use ardia_state::settings::SettingsPatch;
use ardia_state::splits::{PaneDirection, SplitSide};
use ardia_state::windows::{
    CommandBarPlacementState, CommandBarState, NewTabTarget, Popover, WindowKind,
};
use ardia_state::{BrowserState, EntryId, ProfileId, TabId, WindowId};
use ardia_ui::pages::PageKind;
use ardia_ui::{PageCommand, UiHost, UtilityWindowKind};
use serde_json::Value;

use crate::coordinator::{AppCoordinator, ShellEffect};

pub const IDC_VIEW_SOURCE: i32 = 35002;
pub const IDC_PRINT: i32 = 35003;
pub const IDC_SAVE_PAGE: i32 = 35004;
pub const IDC_EMAIL_PAGE_LOCATION: i32 = 35006;
pub const IDC_BASIC_PRINT: i32 = 35007;
pub const IDC_TASK_MANAGER: i32 = 40006;
pub const IDC_CARET_BROWSING_TOGGLE: i32 = 40260;

pub const RELEASE_NOTES_URL: &str = "https://ardia.dev/release-notes";
pub const REPORT_PROBLEM_URL: &str = "https://github.com/ardia-browser/ardia/issues/new";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CommandOutcome {
    Ran,
    ForUi,
}

pub const UI_COMMANDS: &[&str] = &[
    "about",
    "closeDuplicateTabs",
    "sortTabs",
    "checkForUpdates",
    "renameTab",
    "changeTabIcon",
    "bookmarkPage",
    "bookmarkAllTabs",
    "exportBookmarks",
    "clearRecentlyClosed",
    "manageExtensions",
    "addExtension",
    "pinExtensions",
    "openExtension",
    "autofill",
    "keyboardShortcuts",
    "toolTour",
    "videoTour",
    "copyLastFreeze",
    "tabSwitcher",
    "searchTabs",
    "openProfileMenu",
    "newTabInGroup",
    "newProfile",
    "toggleKeepOnTop",
    "toggleBookmarksBar",
    "toggleAddressBar",
    "useSelectionForFind",
    "findAndReplace",
    "jumpToSelection",
    "hideElement",
    "showHiddenElements",
    "togglePageEngine",
    "moveTabToProfile",
    "togglePinnedFold",
];

pub const RECENTLY_CLOSED_SHOWN: usize = 10;

pub fn closed_window_title(tabs: usize) -> String {
    match tabs {
        0 => "Window (Pinned Tabs)".to_owned(),
        1 => "Window (1 Tab)".to_owned(),
        count => format!("Window ({count} Tabs)"),
    }
}

pub fn recently_closed_in(
    state: &BrowserState,
    window: Option<&WindowId>,
) -> Vec<(EntryId, String)> {
    let target = window.and_then(|id| state.window(id.as_str()));
    let every_profile =
        target.is_none_or(|w| w.kind == WindowKind::Incognito || w.profile_id.is_incognito());
    let default_profile = ProfileId::new(&state.settings.default_profile_id);
    let listed = |profile: Option<&ProfileId>| {
        if every_profile {
            return true;
        }
        let owner = profile
            .filter(|profile| state.profile(profile.as_str()).is_some())
            .unwrap_or(&default_profile);
        target.is_some_and(|w| &w.profile_id == owner)
    };
    let mut entries: Vec<(ardia_state::Millis, EntryId, String)> = Vec::new();
    for closed in state.closed.tabs.iter() {
        let profile = &closed.tab.profile_id;
        if profile.is_incognito() || !listed(Some(profile)) {
            continue;
        }
        let title = if closed.tab.title.is_empty() {
            let mut shown = ardia_state::tabs::Tab::new(
                TabId::new(closed.id.as_str()),
                closed.window_id.clone(),
                profile.clone(),
                &closed.tab.url,
                0,
            );
            shown.custom_title = closed.tab.custom_title.clone();
            shown.label()
        } else {
            closed.tab.title.clone()
        };
        entries.push((closed.closed_at, closed.id.clone(), title));
    }
    for closed in state.closed.windows.iter() {
        let profile = closed.window.profile_id.as_ref();
        if profile.is_some_and(ProfileId::is_incognito) || !listed(profile) {
            continue;
        }
        entries.push((
            closed.closed_at,
            closed.id.clone(),
            closed_window_title(closed.tabs.len()),
        ));
    }
    entries.sort_by_key(|(at, _, _)| std::cmp::Reverse(*at));
    entries
        .into_iter()
        .take(RECENTLY_CLOSED_SHOWN)
        .map(|(_, id, title)| (id, title))
        .collect()
}

pub fn focused_window(state: &BrowserState) -> Option<WindowId> {
    state
        .focus_order
        .iter()
        .chain(state.window_order.iter().rev())
        .find(|id| state.window(id.as_str()).is_some_and(|w| w.kind.has_tabs()))
        .cloned()
}

fn profile_neighbor(state: &BrowserState, current: &ProfileId, step: isize) -> Option<ProfileId> {
    let order = &state.profile_order;
    let at = order.iter().position(|p| p == current)? as isize;
    let len = order.len() as isize;
    (len > 1).then(|| order[(at + step).rem_euclid(len) as usize].clone())
}

impl AppCoordinator {
    pub fn focused_window(&self) -> Option<WindowId> {
        focused_window(&self.store().snapshot())
    }

    pub fn active_tab(&self) -> Option<TabId> {
        let state = self.store().snapshot();
        let window = focused_window(&state)?;
        state.active_tab(window.as_str()).map(|t| t.id.clone())
    }

    fn chrome_command(&self, command: i32) -> Result<CommandOutcome, String> {
        let state = self.store().snapshot();
        let window = focused_window(&state).ok_or("there's no window")?;
        let profile = state
            .window(window.as_str())
            .map(|w| w.profile_id.clone())
            .ok_or("there's no window")?;
        let (Some(engine), Some(engine_window), Some(engine_profile)) = (
            self.engine(),
            self.engine_window(&window),
            self.engine_profile(&profile),
        ) else {
            return Err("the page isn't open in the engine".into());
        };
        engine
            .execute_chrome_command(engine_window, command, engine_profile)
            .map_err(|e| e.to_string())
            .map(|_| CommandOutcome::Ran)
    }

    fn toggle_setting(&self, key: &str) -> Result<CommandOutcome, String> {
        let current = self
            .store()
            .snapshot()
            .settings
            .get(key)
            .and_then(|value| value.as_bool())
            .unwrap_or(false);
        self.dispatch_action(Action::UpdateSettings {
            patch: SettingsPatch::new().set(key, !current),
            from_sync: false,
        })
        .map(|_| CommandOutcome::Ran)
        .map_err(|e| e.to_string())
    }

    fn choose_setting(&self, key: &str, arg: Option<&str>) -> Result<CommandOutcome, String> {
        let value = arg.ok_or_else(|| format!("{key} needs a choice"))?;
        self.dispatch_action(Action::UpdateSettings {
            patch: SettingsPatch::new().set(key, Value::from(value)),
            from_sync: false,
        })
        .map(|_| CommandOutcome::Ran)
        .map_err(|e| e.to_string())
    }

    fn for_ui(&self, command: &str, arg: Option<&str>) -> Result<CommandOutcome, String> {
        let window = self
            .focused_window()
            .ok_or("there's no window to show it in")?;
        let name = match arg {
            Some(arg) => format!("command:{command}:{arg}"),
            None => format!("command:{command}"),
        };
        self.dispatch_quietly(Action::SetPopover {
            window,
            popover: Some(Popover::Custom(name)),
        });
        Ok(CommandOutcome::ForUi)
    }

    fn toggle_popover(&self, window: WindowId, popover: Popover) -> Result<CommandOutcome, String> {
        let shown = self
            .store()
            .snapshot()
            .window(window.as_str())
            .and_then(|w| w.chrome.popover.clone());
        let next = (shown.as_ref() != Some(&popover)).then_some(popover);
        self.dispatch_quietly(Action::SetPopover {
            window,
            popover: next,
        });
        Ok(CommandOutcome::Ran)
    }

    pub fn copy_text(&self, text: String) {
        self.effect(ShellEffect::Copy(text));
    }

    pub fn diagnostics(&self) -> String {
        let state = self.store().snapshot();
        format!(
            "Ardia GPUI {}\nengine: {:?}\nwindows: {}\ntabs: {}\nprofiles: {}",
            env!("CARGO_PKG_VERSION"),
            self.backend(),
            state.windows.len(),
            state.tabs.len(),
            state.profiles.len()
        )
    }

    pub fn run_command(&self, command: &str, arg: Option<&str>) -> Result<CommandOutcome, String> {
        let (command, arg) = match (command.split_once(':'), arg) {
            (Some((name, inline)), None) if !command.starts_with("std:") && !inline.is_empty() => {
                (name, Some(inline))
            }
            _ => (command, arg),
        };
        let ran = Ok(CommandOutcome::Ran);
        let state = self.store().snapshot();
        let window = focused_window(&state);
        let tab = window
            .as_ref()
            .and_then(|w| state.active_tab(w.as_str()))
            .map(|t| t.id.clone());
        let need_window = || window.clone().ok_or_else(|| "there's no window".to_owned());
        let need_tab = || tab.clone().ok_or_else(|| "there's no tab".to_owned());
        let act = |action: Action| {
            self.dispatch_action(action)
                .map(|_| CommandOutcome::Ran)
                .map_err(|e| e.to_string())
        };
        match command {
            "quit" | "std:quit:" => {
                self.request_quit_from_user();
                ran
            }
            "undo" => {
                self.undo_or_reopen_closed_tab();
                ran
            }
            "openSettings" => {
                self.effect(ShellEffect::OpenUtility(UtilityWindowKind::Settings));
                ran
            }
            "importBrowserData" => {
                self.effect(ShellEffect::OpenUtility(UtilityWindowKind::Import));
                ran
            }
            "showOnboarding" => {
                self.effect(ShellEffect::OpenUtility(UtilityWindowKind::Onboarding));
                ran
            }
            "newTab" => {
                let window = need_window()?;
                let outcome = self
                    .dispatch_action(Action::NewTab {
                        window: window.clone(),
                        tab: NewTab::default(),
                    })
                    .map_err(|e| e.to_string())?;
                if let Some(created) = outcome.tab {
                    self.dispatch_quietly(Action::SetCommandBar {
                        window,
                        state: CommandBarState {
                            open: true,
                            initial_text: String::new(),
                            new_tab: Some(NewTabTarget::Into(created)),
                            placement: CommandBarPlacementState::Centred,
                        },
                    });
                }
                ran
            }
            "newWindow" => act(Action::OpenWindow {
                kind: WindowKind::Main,
                profile: None,
                url: None,
                frame: None,
            }),
            "newIncognitoWindow" => act(Action::OpenWindow {
                kind: WindowKind::Incognito,
                profile: None,
                url: None,
                frame: None,
            }),
            "newLittleArdia" => act(Action::OpenWindow {
                kind: WindowKind::LittleArdia,
                profile: arg.map(ProfileId::new),
                url: None,
                frame: None,
            }),
            "toggleOpenLinksInLittleArdia" => self.toggle_setting("openLinksInLittleArdia"),
            "closeTab" => {
                let window = need_window()?;
                let little = state
                    .window(window.as_str())
                    .is_some_and(|w| w.kind == WindowKind::LittleArdia);
                act(Action::CloseTabs {
                    tabs: vec![need_tab()?],
                    last_closes_window: little,
                })
            }
            "closeAllTabs" => {
                let window = need_window()?;
                let tabs: Vec<TabId> = state
                    .view_tabs(window.as_str(), None)
                    .into_iter()
                    .filter(|t| !t.is_pinned())
                    .map(|t| t.id.clone())
                    .collect();
                act(Action::CloseTabs {
                    tabs,
                    last_closes_window: false,
                })
            }
            "closeWindow" | "std:closeWindow:" => {
                self.request_window_close(need_window()?);
                ran
            }
            "reopenClosedTab" => act(Action::ReopenClosed { window }),
            "reopenClosedWindow" => {
                let offered = recently_closed_in(&state, window.as_ref());
                let entry = state
                    .closed
                    .windows
                    .iter()
                    .rev()
                    .find(|closed| offered.iter().any(|(id, _)| id == &closed.id))
                    .map(|closed| closed.id.clone())
                    .ok_or("no window was closed")?;
                act(Action::RestoreClosed {
                    id: entry,
                    window: None,
                })
            }
            "restoreClosed" => {
                let id = EntryId::new(arg.ok_or("which entry?")?);
                let offered = recently_closed_in(&state, window.as_ref())
                    .iter()
                    .any(|(entry, _)| entry == &id);
                if !offered {
                    return Err("that entry can't be reopened in this window".into());
                }
                act(Action::RestoreClosed { id, window })
            }
            "focusCommandBar" => self.for_ui(command, arg),
            "toggleSidebar" => act(Action::ToggleSidebar {
                window: need_window()?,
            }),
            "cleanUpTabs" => act(Action::ClearUnpinned {
                window: need_window()?,
            }),
            "undoClearTabs" => {
                let window = need_window()?;
                ardia_ui::sidebar::overflow_menu::note_clear_undone();
                act(Action::UndoClear { window })
            }
            "nextTab" => act(Action::CycleTab {
                window: need_window()?,
                delta: 1,
            }),
            "previousTab" => act(Action::CycleTab {
                window: need_window()?,
                delta: -1,
            }),
            "selectTab" => {
                let n: usize = arg
                    .and_then(|n| n.parse().ok())
                    .filter(|n| *n > 0)
                    .ok_or("which tab?")?;
                act(Action::SelectTabAt {
                    window: need_window()?,
                    index: Some(n - 1),
                })
            }
            "selectLastTab" => act(Action::SelectTabAt {
                window: need_window()?,
                index: None,
            }),
            "togglePin" if arg == Some("tile") => {
                let tab = need_tab()?;
                let pinned_row = state
                    .tab(tab.as_str())
                    .is_some_and(|t| t.pin.as_ref().is_some_and(|pin| !pin.is_tile()));
                if !pinned_row {
                    return ran;
                }
                act(Action::SetPin {
                    tab,
                    pin: Some(TabPin::TILE),
                })
            }
            "togglePin" | "togglePinnedRow" => {
                let tab = need_tab()?;
                let current = state.tab(tab.as_str()).and_then(|t| t.pin.clone());
                let wanted = if command == "togglePin" {
                    TabPin::TILE
                } else {
                    TabPin::Row
                };
                let pin = match current {
                    Some(pin) if pin.is_tile() == wanted.is_tile() => None,
                    _ => Some(wanted),
                };
                act(Action::SetPin { tab, pin })
            }
            "duplicateTab" => act(Action::DuplicateTab { tab: need_tab()? }),
            "newGroupWithTabs" => {
                let window = need_window()?;
                let selected = state
                    .window(window.as_str())
                    .map(|w| w.chrome.selection.clone())
                    .filter(|selection| !selection.is_empty());
                act(Action::CreateGroup {
                    tabs: selected.unwrap_or(vec![need_tab()?]),
                    name: String::new(),
                })
            }
            "closeTabGroup" => {
                let tab = need_tab()?;
                let group = state
                    .group_of(tab.as_str())
                    .map(|g| g.id.clone())
                    .ok_or("the tab isn't in a group")?;
                act(Action::CloseGroup { group })
            }
            "returnToPinnedUrl" => act(Action::ReturnToPinnedUrl { tab: need_tab()? }),
            "moveTabDown" | "moveTabUp" => {
                let window = need_window()?;
                let tab = need_tab()?;
                let ids = state
                    .window(window.as_str())
                    .map(|w| w.tab_ids.clone())
                    .unwrap_or_default();
                let at = ids
                    .iter()
                    .position(|t| *t == tab)
                    .ok_or("the tab isn't listed")?;
                let index = if command == "moveTabDown" {
                    (at + 1).min(ids.len().saturating_sub(1))
                } else {
                    at.saturating_sub(1)
                };
                act(Action::MoveTab { tab, window, index })
            }
            "moveTabToWindow" => {
                let tab = need_tab()?;
                let target = match arg {
                    Some("new") | None => {
                        let outcome = self
                            .dispatch_action(Action::OpenWindow {
                                kind: WindowKind::Main,
                                profile: state.tab(tab.as_str()).map(|t| t.profile_id.clone()),
                                url: None,
                                frame: None,
                            })
                            .map_err(|e| e.to_string())?;
                        outcome.window.ok_or("no window opened")?
                    }
                    Some(id) => WindowId::new(id),
                };
                let blank: Vec<TabId> = self
                    .store()
                    .snapshot()
                    .view_tabs(target.as_str(), None)
                    .into_iter()
                    .filter(|t| t.url.is_empty() && !t.is_pinned() && t.id != tab)
                    .map(|t| t.id.clone())
                    .collect();
                act(Action::MoveTab {
                    tab,
                    window: target,
                    index: usize::MAX,
                })?;
                if !blank.is_empty() && arg.is_none_or(|a| a == "new") {
                    self.dispatch_quietly(Action::CloseTabs {
                        tabs: blank,
                        last_closes_window: false,
                    });
                }
                ran
            }
            "mergeAllWindows" => {
                let target = need_window()?;
                let moving: Vec<TabId> = state
                    .window_order
                    .iter()
                    .filter(|w| **w != target)
                    .filter_map(|w| state.window(w.as_str()))
                    .filter(|w| w.kind == WindowKind::Main)
                    .flat_map(|w| w.tab_ids.clone())
                    .collect();
                for tab in moving {
                    self.dispatch_quietly(Action::MoveTab {
                        tab,
                        window: target.clone(),
                        index: usize::MAX,
                    });
                }
                ran
            }
            "switchProfile" => act(Action::SwitchProfile {
                window: need_window()?,
                profile: ProfileId::new(arg.ok_or("which profile?")?),
            }),
            "nextProfile" | "previousProfile" => {
                let window = need_window()?;
                let current = state
                    .window(window.as_str())
                    .map(|w| w.profile_id.clone())
                    .ok_or("there's no window")?;
                let step = if command == "nextProfile" { 1 } else { -1 };
                let profile =
                    profile_neighbor(&state, &current, step).ok_or("there's one profile")?;
                act(Action::SwitchProfile { window, profile })
            }
            "openSplitPane" | "openSplitPaneBelow" => act(Action::OpenSplitPane {
                window: need_window()?,
                side: if command == "openSplitPane" {
                    SplitSide::Right
                } else {
                    SplitSide::Bottom
                },
                url: None,
            }),
            "focusNextPane" | "focusPreviousPane" => act(Action::FocusPane {
                window: need_window()?,
                delta: if command == "focusNextPane" { 1 } else { -1 },
            }),
            "moveSplitPaneLeft" | "moveSplitPaneRight" | "moveSplitPaneUp"
            | "moveSplitPaneDown" => {
                let direction = match command {
                    "moveSplitPaneLeft" => PaneDirection::Left,
                    "moveSplitPaneRight" => PaneDirection::Right,
                    "moveSplitPaneUp" => PaneDirection::Up,
                    _ => PaneDirection::Down,
                };
                act(Action::MovePane {
                    tab: need_tab()?,
                    direction,
                })
            }
            "setTabLayout" => match arg {
                Some("top") => act(Action::SetTabLayout {
                    window: None,
                    layout: TabLayout::Top,
                }),
                Some(side @ ("sidebarLeft" | "sidebarRight")) => {
                    act(Action::SetTabLayout {
                        window: None,
                        layout: TabLayout::Sidebar,
                    })?;
                    let side = if side == "sidebarLeft" {
                        "left"
                    } else {
                        "right"
                    };
                    self.choose_setting("sidebarSide", Some(side))
                }
                _ => Err("which layout?".into()),
            },
            "toggleTabLayout" => {
                let layout = match state.settings.tab_layout {
                    TabLayout::Sidebar => TabLayout::Top,
                    TabLayout::Top => TabLayout::Sidebar,
                };
                act(Action::SetTabLayout {
                    window: None,
                    layout,
                })
            }
            "toggleSidebarSide" => {
                let side = match state.settings.sidebar_side {
                    ardia_state::model::SidebarSide::Left => "right",
                    ardia_state::model::SidebarSide::Right => "left",
                };
                self.choose_setting("sidebarSide", Some(side))
            }
            "toggleMute" => {
                let tab = need_tab()?;
                for action in ardia_state::mute::toggle(&state, &tab, arg == Some("site")) {
                    act(action)?;
                }
                ran
            }
            "downloads" => self.toggle_popover(need_window()?, Popover::Downloads),
            "showHistory" => self
                .open_internal_page(&need_window()?, PageKind::History)
                .map(|()| CommandOutcome::Ran),
            "manageBookmarks" => self
                .open_internal_page(&need_window()?, PageKind::Bookmarks)
                .map(|()| CommandOutcome::Ran),
            "clearBrowsingData" => {
                let window = need_window()?;
                self.open_internal_page(&window, PageKind::History)?;
                ardia_ui::pages::history::request_clear_data(&window);
                self.touch(window);
                self.wake();
                ran
            }
            "toggleReader" => {
                self.toggle_reader_in(&need_tab()?);
                ran
            }
            "openFile" => {
                if let Some(window) = window.clone() {
                    if state.shown_peek(window.as_str()).is_some() {
                        let animates = state
                            .window(window.as_str())
                            .is_some_and(|w| w.kind == WindowKind::Main)
                            && self.gpui_window(&window).is_some();
                        if animates {
                            return self.for_ui(command, arg);
                        }
                        return act(Action::PromotePeek { window });
                    }
                    let little = state
                        .window(window.as_str())
                        .is_some_and(|w| w.kind == WindowKind::LittleArdia);
                    if little {
                        return act(Action::PromoteLittleArdia { window });
                    }
                }
                self.choose_files_to_open(window)
                    .map(|()| CommandOutcome::Ran)
            }
            "reload" => {
                self.reload(need_tab()?, false);
                ran
            }
            "forceReload" => {
                self.reload(need_tab()?, true);
                ran
            }
            "stop" => {
                self.stop_loading(need_tab()?);
                ran
            }
            "back" => {
                self.go_back(need_tab()?);
                ran
            }
            "forward" => {
                self.go_forward(need_tab()?);
                ran
            }
            "zoomIn" | "zoomOut" | "zoomReset" => {
                let direction = match command {
                    "zoomIn" => 1,
                    "zoomOut" => -1,
                    _ => 0,
                };
                self.zoom_step(need_tab()?, direction);
                ran
            }
            "devTools" | "inspectElements" | "javaScriptConsole" => {
                let tab = need_tab()?;
                let (Some(engine), Some(engine_tab)) = (self.engine(), self.engine_tab(&tab))
                else {
                    return Err("the page isn't open in the engine".into());
                };
                let shown = match command {
                    "inspectElements" => engine.show_devtools_panel(engine_tab, "elements"),
                    "javaScriptConsole" => engine.show_devtools_panel(engine_tab, "console"),
                    _ => engine.show_devtools(engine_tab),
                };
                shown
                    .map(|()| CommandOutcome::Ran)
                    .map_err(|e| e.to_string())
            }
            "toggleDevTools" => {
                self.toggle_devtools(need_tab()?);
                ran
            }
            "findInPage" => {
                let tab = need_tab()?;
                let find = state
                    .tab(tab.as_str())
                    .map(|t| t.live.find.clone())
                    .unwrap_or_default();
                act(Action::SetFind {
                    tab,
                    find: ardia_state::tabs::FindState { open: true, ..find },
                })
            }
            "findNext" | "findPrevious" => {
                let tab = need_tab()?;
                let query = state
                    .tab(tab.as_str())
                    .map(|t| t.live.find.query.clone())
                    .filter(|query| !query.is_empty())
                    .ok_or("there's nothing to find")?;
                self.find_in_page(tab, query, command == "findNext");
                ran
            }
            "viewSource" => self.chrome_command(IDC_VIEW_SOURCE),
            "print" | "printWithSystemDialog" | "savePage" => {
                let page_command = match command {
                    "print" => PageCommand::Print,
                    "printWithSystemDialog" => PageCommand::PrintWithSystemDialog,
                    _ => PageCommand::SavePage,
                };
                self.run_page_command(&need_tab()?, page_command)
                    .map(|()| CommandOutcome::Ran)
            }
            "emailPageLocation" => self.chrome_command(IDC_EMAIL_PAGE_LOCATION),
            "taskManager" => self.chrome_command(IDC_TASK_MANAGER),
            "caretBrowsing" => self.chrome_command(IDC_CARET_BROWSING_TOGGLE),
            "cast" => {
                self.show_cast(need_tab()?);
                ran
            }
            "share" => {
                self.share_tab(need_tab()?);
                ran
            }
            "copyUrl" | "copyUrlAsMarkdown" => {
                let tab = need_tab()?;
                let listed = state.tab(tab.as_str()).ok_or("there's no tab")?;
                if listed.url.is_empty() {
                    return Err("the tab has no address".into());
                }
                let text = if command == "copyUrl" {
                    listed.url.clone()
                } else {
                    format!(
                        "[{}]({})",
                        listed.display_title().replace(['[', ']'], ""),
                        listed.url
                    )
                };
                self.copy_text(text);
                ran
            }
            "copyDiagnostics" => {
                self.copy_text(self.diagnostics());
                ran
            }
            "releaseNotes" => {
                self.open_in_tab(RELEASE_NOTES_URL)?;
                ran
            }
            "reportProblem" => {
                if crate::report::hub().is_some() {
                    return self.for_ui(command, arg);
                }
                self.open_in_tab(REPORT_PROBLEM_URL)?;
                ran
            }
            _ => {
                if let Some((parsed, _)) = Command::parse_id(command) {
                    let spec = parsed.spec();
                    if let Some(key) = spec.toggles {
                        return self.toggle_setting(key);
                    }
                    if let Some(key) = spec.chooses {
                        return self.choose_setting(key, arg);
                    }
                }
                if UI_COMMANDS.contains(&command) {
                    return self.for_ui(command, arg);
                }
                Err(format!("{command} isn't a command"))
            }
        }
    }

    fn open_in_tab(&self, url: &str) -> Result<(), String> {
        match self.focused_window() {
            Some(window) => self
                .dispatch_action(Action::NewTab {
                    window,
                    tab: NewTab {
                        url: Some(url.to_owned()),
                        ..NewTab::default()
                    },
                })
                .map(|_| ())
                .map_err(|e| e.to_string()),
            None => self
                .dispatch_action(Action::OpenWindow {
                    kind: WindowKind::Main,
                    profile: None,
                    url: Some(url.to_owned()),
                    frame: None,
                })
                .map(|_| ())
                .map_err(|e| e.to_string()),
        }
    }

    pub(crate) fn share_url(&self, tab: &TabId, url: &str) {
        #[cfg(target_os = "macos")]
        {
            use ardia_engine::macos::dialogs::{ShareItem, share};
            let anchor = self
                .window_of(tab)
                .and_then(|window| self.engine_window(&window))
                .and_then(|window| self.engine()?.window_host_view(window).ok());
            if let Some(anchor) = anchor {
                let rect = ardia_engine::Rect::new(0.0, 0.0, 1.0, 1.0);
                if let Err(problem) = share(&[ShareItem::Url(url.to_owned())], &anchor, rect) {
                    log::warn!("the share sheet didn't open: {problem}");
                }
                return;
            }
        }
        let _ = url;
        if let Some(window) = self.window_of(tab) {
            self.dispatch_quietly(Action::SetPopover {
                window,
                popover: Some(Popover::Share),
            });
        }
    }

    pub fn recently_closed(&self) -> Vec<(EntryId, String)> {
        let state = self.store().snapshot();
        recently_closed_in(&state, focused_window(&state).as_ref())
    }
}

#[cfg(target_os = "macos")]
pub mod native {
    use std::collections::hash_map::DefaultHasher;
    use std::hash::{Hash, Hasher};

    use ardia_engine::Modifiers;
    use ardia_engine::macos::menu::{MenuBar, MenuContext, MenuEntry, Shortcut, dia_menu_bar};
    use ardia_state::BrowserState;

    use super::focused_window;

    pub fn menu_context(
        state: &BrowserState,
        recently_closed: &[(ardia_state::EntryId, String)],
    ) -> MenuContext {
        let focused = focused_window(state);
        let current_profile = focused
            .as_ref()
            .and_then(|w| state.window(w.as_str()))
            .map(|w| w.profile_id.clone());
        MenuContext {
            app_name: "Ardia".into(),
            profiles: state
                .profile_order
                .iter()
                .filter_map(|id| state.profile(id.as_str()))
                .map(|profile| MenuEntry {
                    id: profile.id.to_string(),
                    title: profile.name.clone(),
                    current: current_profile.as_ref() == Some(&profile.id),
                })
                .collect(),
            windows: state
                .window_order
                .iter()
                .filter_map(|id| state.window(id.as_str()))
                .filter(|w| w.kind == ardia_state::windows::WindowKind::Main)
                .enumerate()
                .map(|(n, w)| MenuEntry {
                    id: w.id.to_string(),
                    title: state
                        .active_tab(w.id.as_str())
                        .map(|t| t.display_title())
                        .unwrap_or_else(|| format!("Window {}", n + 1)),
                    current: focused.as_ref() == Some(&w.id),
                })
                .collect(),
            recently_closed: recently_closed
                .iter()
                .map(|(id, title)| MenuEntry {
                    id: id.to_string(),
                    title: title.clone(),
                    current: false,
                })
                .collect(),
            extensions: Vec::new(),
            show_onboarding: true,
        }
    }

    pub fn signature(context: &MenuContext) -> u64 {
        let mut hasher = DefaultHasher::new();
        for entry in context
            .profiles
            .iter()
            .chain(&context.windows)
            .chain(&context.recently_closed)
        {
            entry.id.hash(&mut hasher);
            entry.title.hash(&mut hasher);
            entry.current.hash(&mut hasher);
        }
        hasher.finish()
    }

    pub fn titled_signature(context: &MenuContext, titles: &[(&str, &str)]) -> u64 {
        let mut hasher = DefaultHasher::new();
        signature(context).hash(&mut hasher);
        titles.hash(&mut hasher);
        hasher.finish()
    }

    pub const TILE_PIN_TITLE: &str = "Move Pinned Tab to Top Apps";

    pub fn add_tile_pin_item(bar: &mut MenuBar, shown: bool) {
        use ardia_engine::macos::menu::MenuItem;
        fn walk(items: &mut Vec<MenuItem>, shown: bool) -> bool {
            let at = items.iter().position(|item| {
                matches!(item, MenuItem::Command(command) if command.command == "togglePin" && command.arg.is_none())
            });
            if let Some(at) = at {
                if let MenuItem::Command(command) = &items[at] {
                    let mut tile = command.clone();
                    tile.title = TILE_PIN_TITLE.to_owned();
                    tile.arg = Some("tile".to_owned());
                    tile.shortcut = None;
                    tile.hidden = !shown;
                    tile.enabled = shown;
                    items.insert(at + 1, MenuItem::Command(tile));
                }
                return true;
            }
            items.iter_mut().any(|item| match item {
                MenuItem::Submenu(menu) => walk(&mut menu.items, shown),
                _ => false,
            })
        }
        for menu in &mut bar.menus {
            if walk(&mut menu.items, shown) {
                return;
            }
        }
    }

    pub fn route_undo(bar: &mut MenuBar) {
        use ardia_engine::macos::menu::{CommandItem, MenuItem};
        fn walk(items: &mut [MenuItem]) -> bool {
            for item in items {
                match item {
                    MenuItem::Standard(standard) if standard.action == "undo:" => {
                        *item = MenuItem::Command(CommandItem {
                            title: standard.title.clone(),
                            command: "undo".to_owned(),
                            arg: None,
                            shortcut: standard.shortcut.clone(),
                            hidden: standard.hidden,
                            alternate: standard.alternate,
                            enabled: true,
                            checked: false,
                        });
                        return true;
                    }
                    MenuItem::Submenu(menu) => {
                        if walk(&mut menu.items) {
                            return true;
                        }
                    }
                    _ => {}
                }
            }
            false
        }
        for menu in &mut bar.menus {
            if walk(&mut menu.items) {
                return;
            }
        }
    }

    pub fn retitle(bar: &mut MenuBar, titles: &[(&str, &str)]) {
        fn walk(items: &mut [ardia_engine::macos::menu::MenuItem], titles: &[(&str, &str)]) {
            for item in items {
                match item {
                    ardia_engine::macos::menu::MenuItem::Command(command) => {
                        if let Some((_, title)) =
                            titles.iter().find(|(id, _)| *id == command.command)
                        {
                            command.title = (*title).to_owned();
                        }
                    }
                    ardia_engine::macos::menu::MenuItem::Submenu(menu) => {
                        walk(&mut menu.items, titles)
                    }
                    _ => {}
                }
            }
        }
        for menu in &mut bar.menus {
            walk(&mut menu.items, titles);
        }
    }

    pub fn menu_bar(context: &MenuContext) -> MenuBar {
        dia_menu_bar(context)
    }

    pub fn keystroke(shortcut: &Shortcut) -> Option<String> {
        let key = match shortcut.key.as_str() {
            "\u{F700}" => "up".to_owned(),
            "\u{F701}" => "down".to_owned(),
            "\u{F702}" => "left".to_owned(),
            "\u{F703}" => "right".to_owned(),
            "\u{F72C}" => "pageup".to_owned(),
            "\u{F72D}" => "pagedown".to_owned(),
            "\u{8}" | "\u{7F}" => "backspace".to_owned(),
            "\u{D}" => "enter".to_owned(),
            "\u{9}" => "tab".to_owned(),
            "\u{1B}" => "escape".to_owned(),
            " " => "space".to_owned(),
            text => {
                let code = text.chars().next()? as u32;
                if (0xF704..=0xF726).contains(&code) {
                    format!("f{}", code - 0xF704 + 1)
                } else if text.chars().count() == 1 && !text.chars().any(char::is_control) {
                    text.to_lowercase()
                } else {
                    return None;
                }
            }
        };
        let modifiers = Modifiers(shortcut.modifiers);
        let mut out = String::new();
        for (flag, name) in [
            (Modifiers::CONTROL, "ctrl-"),
            (Modifiers::OPTION, "alt-"),
            (Modifiers::SHIFT, "shift-"),
            (Modifiers::COMMAND, "cmd-"),
            (Modifiers::FUNCTION, "fn-"),
        ] {
            if modifiers.contains(flag) {
                out.push_str(name);
            }
        }
        out.push_str(&key);
        Some(out)
    }

    pub fn commands_with_keys(bar: &MenuBar) -> Vec<(String, Option<String>, String)> {
        bar.commands()
            .into_iter()
            .filter(|item| item.enabled && item.command != "noop")
            .filter_map(|item| {
                let shortcut = item.shortcut.as_ref()?;
                Some((item.command.clone(), item.arg.clone(), keystroke(shortcut)?))
            })
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn profiles_cycle_in_both_directions() {
        let mut state = BrowserState::from_session(
            ardia_state::persistence::session::SessionData::fresh(Default::default()),
            1,
        );
        let ids = ardia_state::ids::IdGen::with_launch("menu");
        state
            .apply(
                Action::CreateProfile {
                    name: "Work".into(),
                    color: None,
                    icon: None,
                },
                2,
                &ids,
            )
            .unwrap();
        let first = state.profile_order[0].clone();
        let second = state.profile_order[1].clone();
        assert_eq!(profile_neighbor(&state, &first, 1), Some(second.clone()));
        assert_eq!(profile_neighbor(&state, &first, -1), Some(second.clone()));
        assert_eq!(profile_neighbor(&state, &second, 1), Some(first));
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn every_menu_command_has_a_route() {
        use ardia_engine::macos::menu::MenuContext;
        let bar = native::menu_bar(&MenuContext {
            app_name: "Ardia".into(),
            ..MenuContext::default()
        });
        let routed = [
            "quit",
            "openSettings",
            "importBrowserData",
            "showOnboarding",
            "newTab",
            "newWindow",
            "newIncognitoWindow",
            "newLittleArdia",
            "toggleOpenLinksInLittleArdia",
            "closeTab",
            "closeAllTabs",
            "closeWindow",
            "reopenClosedTab",
            "reopenClosedWindow",
            "restoreClosed",
            "focusCommandBar",
            "toggleSidebar",
            "cleanUpTabs",
            "nextTab",
            "previousTab",
            "selectTab",
            "selectLastTab",
            "togglePin",
            "togglePinnedRow",
            "duplicateTab",
            "newGroupWithTabs",
            "closeTabGroup",
            "returnToPinnedUrl",
            "moveTabDown",
            "moveTabUp",
            "moveTabToWindow",
            "mergeAllWindows",
            "switchProfile",
            "nextProfile",
            "previousProfile",
            "openSplitPane",
            "openSplitPaneBelow",
            "focusNextPane",
            "focusPreviousPane",
            "moveSplitPaneLeft",
            "moveSplitPaneRight",
            "moveSplitPaneUp",
            "moveSplitPaneDown",
            "setTabLayout",
            "toggleTabLayout",
            "toggleMute",
            "downloads",
            "showHistory",
            "clearBrowsingData",
            "manageBookmarks",
            "toggleReader",
            "openFile",
            "reload",
            "forceReload",
            "stop",
            "back",
            "forward",
            "zoomIn",
            "zoomOut",
            "zoomReset",
            "devTools",
            "inspectElements",
            "javaScriptConsole",
            "toggleDevTools",
            "findInPage",
            "findNext",
            "findPrevious",
            "viewSource",
            "print",
            "printWithSystemDialog",
            "savePage",
            "emailPageLocation",
            "taskManager",
            "caretBrowsing",
            "cast",
            "share",
            "copyUrl",
            "copyUrlAsMarkdown",
            "copyDiagnostics",
            "releaseNotes",
            "reportProblem",
        ];
        let mut missing = Vec::new();
        for item in bar.commands() {
            let id = item.command.as_str();
            if id == "noop" || routed.contains(&id) || UI_COMMANDS.contains(&id) {
                continue;
            }
            let generic = Command::parse_id(id).is_some_and(|(command, _)| {
                command.spec().toggles.is_some() || command.spec().chooses.is_some()
            });
            if !generic {
                missing.push(id.to_owned());
            }
        }
        missing.sort();
        missing.dedup();
        assert!(
            missing.is_empty(),
            "menu commands without a route: {missing:?}"
        );
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn the_tile_pin_item_sits_under_move_to_top_apps_and_hides_when_disabled() {
        use ardia_engine::macos::menu::{MenuContext, MenuItem};
        type Listed = Vec<(String, Option<String>, bool)>;
        fn find(items: &[MenuItem]) -> Option<(usize, Listed)> {
            for item in items {
                if let MenuItem::Submenu(menu) = item
                    && let Some(found) = find(&menu.items)
                {
                    return Some(found);
                }
            }
            let listed: Listed = items
                .iter()
                .filter_map(|item| match item {
                    MenuItem::Command(c) => Some((c.command.clone(), c.arg.clone(), c.hidden)),
                    _ => None,
                })
                .collect();
            listed
                .iter()
                .position(|(command, arg, _)| command == "togglePin" && arg.is_none())
                .map(|at| (at, listed))
        }
        for shown in [false, true] {
            let mut bar = native::menu_bar(&MenuContext::default());
            native::add_tile_pin_item(&mut bar, shown);
            let (at, listed) = bar
                .menus
                .iter()
                .find_map(|menu| find(&menu.items))
                .expect("Move to Top Apps is in the menu bar");
            assert_eq!(
                listed[at + 1],
                ("togglePin".to_owned(), Some("tile".to_owned()), !shown)
            );
        }
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn appkit_shortcuts_become_gpui_keystrokes() {
        use ardia_engine::Modifiers;
        use ardia_engine::macos::menu::Shortcut;
        let shortcut = |key: &str, modifiers: Modifiers| Shortcut::new(key, modifiers);
        assert_eq!(
            native::keystroke(&shortcut("t", Modifiers::COMMAND)).as_deref(),
            Some("cmd-t")
        );
        assert_eq!(
            native::keystroke(&shortcut(
                "\u{F703}",
                Modifiers::OPTION | Modifiers::COMMAND
            ))
            .as_deref(),
            Some("alt-cmd-right")
        );
        assert_eq!(
            native::keystroke(&shortcut("\u{8}", Modifiers::SHIFT | Modifiers::COMMAND)).as_deref(),
            Some("shift-cmd-backspace")
        );
        assert_eq!(
            native::keystroke(&shortcut("\u{F70F}", Modifiers::NONE)).as_deref(),
            Some("f12")
        );
        assert_eq!(
            native::keystroke(&shortcut("-", Modifiers::COMMAND)).as_deref(),
            Some("cmd--")
        );
        let bar = native::menu_bar(&ardia_engine::macos::menu::MenuContext::default());
        let keyed = native::commands_with_keys(&bar);
        assert!(
            keyed
                .iter()
                .any(|(command, _, keys)| command == "newTab" && keys == "cmd-t")
        );
        assert!(
            keyed
                .iter()
                .any(|(command, arg, keys)| command == "selectTab"
                    && arg.as_deref() == Some("1")
                    && keys == "cmd-1")
        );
    }
}
