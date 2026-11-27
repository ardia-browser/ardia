use ardia_state::commands::Command;
use ardia_state::model::{SidebarSide, TabLayout, TabPin};
use ardia_state::omnibox::url::clean_url;
use ardia_state::settings::{AddressBar, BookmarksBar, NewTabOpens, SettingsPatch};
use ardia_state::splits::{PaneDirection, SplitSide};
use ardia_state::tabs::Tab;
use ardia_state::windows::{Popover, WindowKind};
use ardia_state::{Action, EntryId, NewTab, ProfileId, ProfilePatch, TabId};
use gpui::{Context, Window};
use std::sync::Arc;

use crate::host::{PageCommand, UtilityWindowKind};
use crate::msg::{FindMsg, Msg, RenameTarget};
use crate::pages::{OpenPlan, PageKind, plan_open};
use crate::popovers::menu_items::link_text;
use crate::settings::rows::Pane;
use crate::window::browser_window::BrowserWindowView;

fn is_web_page(url: &str) -> bool {
    let lower = url.trim_start().to_ascii_lowercase();
    lower.starts_with("http://") || lower.starts_with("https://")
}

fn flip(settings: &ardia_state::settings::Settings, key: &str) -> SettingsPatch {
    let on = settings
        .get(key)
        .and_then(|value| value.as_bool())
        .unwrap_or(false);
    SettingsPatch::new().set(key, !on)
}

impl BrowserWindowView {
    fn settings(&mut self, patch: SettingsPatch, window: &mut Window, cx: &mut Context<Self>) {
        self.dispatch(
            Action::UpdateSettings {
                patch,
                from_sync: false,
            },
            window,
            cx,
        );
    }

    fn profile_step(&self, delta: i32) -> Option<ProfileId> {
        let current = &self.state.window(self.window_id.as_str())?.profile_id;
        let order = &self.state.profile_order;
        if order.len() < 2 {
            return None;
        }
        let at = order.iter().position(|p| p == current)? as i32;
        let next = (at + delta).rem_euclid(order.len() as i32) as usize;
        order.get(next).cloned()
    }

    fn switch_profile(&mut self, profile: ProfileId, window: &mut Window, cx: &mut Context<Self>) {
        let incognito = self
            .state
            .window(self.window_id.as_str())
            .is_some_and(|w| w.kind == WindowKind::Incognito);
        if incognito || self.state.profile(profile.as_str()).is_none() {
            return;
        }
        self.dispatch(
            Action::SwitchProfile {
                window: self.window_id.clone(),
                profile,
            },
            window,
            cx,
        );
    }

    fn new_tab(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.state.settings.new_tab_opens() == NewTabOpens::CommandBar {
            self.open_panel(true, Some(String::new()), window, cx);
            return;
        }
        if let Some(home) = ardia_state::new_tab_home::home_url(&self.state.settings) {
            self.dispatch(
                Action::NewTab {
                    window: self.window_id.clone(),
                    tab: NewTab {
                        url: Some(home),
                        ..NewTab::default()
                    },
                },
                window,
                cx,
            );
            return;
        }
        self.dispatch(
            Action::NewTab {
                window: self.window_id.clone(),
                tab: NewTab::default(),
            },
            window,
            cx,
        );
        self.open_panel(false, Some(String::new()), window, cx);
    }

    fn open_window(&mut self, kind: WindowKind, window: &mut Window, cx: &mut Context<Self>) {
        let profile = self
            .state
            .window(self.window_id.as_str())
            .map(|w| w.profile_id.clone())
            .filter(|p| !p.is_incognito());
        let url = (kind == WindowKind::Main)
            .then(|| ardia_state::new_tab_home::home_url(&self.state.settings))
            .flatten();
        self.dispatch(
            Action::OpenWindow {
                kind,
                profile,
                url,
                frame: None,
            },
            window,
            cx,
        );
    }

    fn selected_tabs(&self) -> Vec<TabId> {
        self.state
            .window(self.window_id.as_str())
            .map(|w| w.chrome.selection.clone())
            .filter(|selection| selection.len() > 1)
            .unwrap_or_default()
    }

    fn copy_url(&mut self, markdown: bool, window: &mut Window, cx: &mut Context<Self>) {
        let selected: Vec<Arc<Tab>> = self
            .selected_tabs()
            .iter()
            .filter_map(|id| self.state.tab(id.as_str()).cloned())
            .filter(|t| !t.url.is_empty())
            .collect();
        if selected.len() > 1 {
            let refs: Vec<&Tab> = selected.iter().map(|t| t.as_ref()).collect();
            if let Some(text) = link_text(&refs, markdown) {
                ardia_telemetry::counts::count("url_copies");
                ardia_telemetry::counts::count("url_copies_of_selected_tabs");
                cx.write_to_clipboard(gpui::ClipboardItem::new_string(text));
                self.notify_toast(format!("Copied {} Links", refs.len()), window, cx);
            }
            return;
        }
        let Some(tab) = self.active_tab().filter(|t| !t.url.is_empty()) else {
            return;
        };
        let Some(text) = link_text(&[tab.as_ref()], markdown) else {
            return;
        };
        cx.write_to_clipboard(gpui::ClipboardItem::new_string(text));
        ardia_telemetry::counts::count("url_copies");
        if !markdown {
            if clean_url(&tab.url) != tab.url {
                ardia_telemetry::counts::count("url_copies_cleaned");
            }
            let message = if clean_url(&tab.url) != tab.url {
                "Copied a clean link without trackers"
            } else {
                "Copied Current URL"
            };
            self.notify_toast(message, window, cx);
        }
    }

    fn setting_command(
        &mut self,
        command: Command,
        arg: Option<&str>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> bool {
        let spec = command.spec();
        if let Some(key) = spec.toggles {
            let patch = flip(&self.state.settings, key);
            self.settings(patch, window, cx);
            return true;
        }
        match (spec.chooses, spec.variant(arg)) {
            (Some(key), Some(variant)) => {
                self.settings(SettingsPatch::new().set(key, variant.arg), window, cx);
                true
            }
            (Some(_), None) => true,
            _ => false,
        }
    }

    fn blocked_here(&self, command: Command) -> bool {
        let incognito = self
            .state
            .window(self.window_id.as_str())
            .is_some_and(|w| w.kind == WindowKind::Incognito);
        let settings = &self.state.settings;
        match command {
            Command::SetBookmarksBar | Command::ToggleBookmarksBar => incognito,
            Command::ToggleCompactToolbar => {
                settings.minimalism_mode
                    || (self.state.tab_layout(self.window_id.as_str()) == TabLayout::Sidebar
                        && settings.address_bar == AddressBar::Sidebar)
            }
            Command::OpenProfileMenu => incognito,
            _ => false,
        }
    }

    fn move_tab_by(&mut self, delta: i32, window: &mut Window, cx: &mut Context<Self>) {
        let Some(tab) = self.active_tab() else {
            return;
        };
        let Some(order) = self
            .state
            .window(self.window_id.as_str())
            .map(|w| w.tab_ids.clone())
        else {
            return;
        };
        let Some(at) = order.iter().position(|id| *id == tab.id) else {
            return;
        };
        let target = (at as i32 + delta).clamp(0, order.len().saturating_sub(1) as i32) as usize;
        if target != at {
            self.dispatch(
                Action::MoveTab {
                    tab: tab.id.clone(),
                    window: self.window_id.clone(),
                    index: target,
                },
                window,
                cx,
            );
        }
    }

    fn set_layout(&mut self, arg: &str, window: &mut Window, cx: &mut Context<Self>) {
        let patch = match arg {
            "sidebarLeft" => SettingsPatch::new()
                .set("tabLayout", TabLayout::Sidebar)
                .set("sidebarSide", SidebarSide::Left),
            "sidebarRight" => SettingsPatch::new()
                .set("tabLayout", TabLayout::Sidebar)
                .set("sidebarSide", SidebarSide::Right),
            "top" => SettingsPatch::new().set("tabLayout", TabLayout::Top),
            _ => return,
        };
        self.settings(patch, window, cx);
    }

    fn open_window_for(&self, profile: ProfileId) -> Option<ardia_state::WindowId> {
        self.host
            .store()
            .dispatch(Action::OpenWindow {
                kind: WindowKind::Main,
                profile: Some(profile),
                url: None,
                frame: None,
            })
            .ok()
            .and_then(|outcome| outcome.window)
    }

    fn blank_tabs_in(&self, target: &ardia_state::WindowId, keep: &[TabId]) -> Vec<TabId> {
        self.host
            .store()
            .snapshot()
            .view_tabs(target.as_str(), None)
            .into_iter()
            .filter(|t| t.url.is_empty() && !t.is_pinned() && !keep.contains(&t.id))
            .map(|t| t.id.clone())
            .collect()
    }

    pub(crate) fn move_group_to_window(
        &mut self,
        group: ardia_state::GroupId,
        target: Option<ardia_state::WindowId>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let Some(found) = self.state.group(group.as_str()).cloned() else {
            return;
        };
        let fresh = target.is_none();
        let Some(target) = target.or_else(|| self.open_window_for(found.profile_id.clone())) else {
            return;
        };
        let blank = if fresh {
            self.blank_tabs_in(&target, &found.tab_ids)
        } else {
            Vec::new()
        };
        self.host.dispatch(Action::MoveGroupToWindow {
            group,
            window: target,
        });
        if !blank.is_empty() {
            self.host.dispatch(Action::CloseTabs {
                tabs: blank,
                last_closes_window: false,
            });
        }
        self.on_store(ardia_state::Topics::ALL, window, cx);
    }

    pub(crate) fn group_to_bookmarks_bar(
        &mut self,
        group: ardia_state::GroupId,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        use crate::pages::bookmarks::edits;
        let state = self.host.store().snapshot();
        let Some(root) = state.group(group.as_str()).cloned() else {
            return;
        };
        let profile = crate::bookmarks_bar::bookmark_profile(&root.profile_id);
        let store = self.host.store();
        {
            let mut stack: Vec<(
                Arc<ardia_state::groups::TabGroup>,
                Option<ardia_state::BookmarkId>,
            )> = vec![(Arc::clone(&root), None)];
            while let Some((at, parent)) = stack.pop() {
                let name = if at.name.trim().is_empty() {
                    "Untitled".to_owned()
                } else {
                    at.name.clone()
                };
                let made = match &parent {
                    Some(parent) => edits::add_folder(store, &profile, parent, None, &name),
                    None => edits::add_folder_to_bar(store, &profile, &name),
                };
                let Some(folder) = made else {
                    break;
                };
                let children: Vec<_> = state
                    .groups
                    .values()
                    .filter(|c| c.parent_id.as_ref() == Some(&at.id))
                    .cloned()
                    .collect();
                let mut filed = Vec::new();
                for tab in &at.tab_ids {
                    if let Some(child) = children.iter().find(|c| c.tab_ids.contains(tab)) {
                        if !filed.contains(&child.id) {
                            filed.push(child.id.clone());
                            stack.push((Arc::clone(child), Some(folder.clone())));
                        }
                        continue;
                    }
                    if let Some(t) = state.tab(tab.as_str()).filter(|t| !t.url.is_empty()) {
                        edits::add_url(store, &profile, &folder, None, &t.display_title(), &t.url);
                    }
                }
            }
        }
        self.dispatch(Action::CloseGroup { group }, window, cx);
    }

    pub(crate) fn bookmark_tabs_to_new_folder(&mut self, tabs: Vec<TabId>, cx: &mut Context<Self>) {
        let adds: Vec<(String, String)> = tabs
            .iter()
            .filter_map(|t| self.state.tab(t.as_str()))
            .filter(|t| !t.url.is_empty())
            .map(|t| (t.url.clone(), t.display_title()))
            .collect();
        let p = self.look.p;
        let Some(ctx) = crate::bookmarks_bar::BarCtx::for_window(
            &self.host,
            &self.emit,
            &self.window_id,
            &p,
            self.look.glass,
            cx,
        ) else {
            return;
        };
        let Some(bar) = self.state.bookmarks_of(&ctx.profile).map(|tree| tree.bar()) else {
            return;
        };
        crate::bookmarks_bar::dialog::prompt_new_folder_for(&ctx, bar, adds, cx);
    }

    pub(crate) fn move_tabs_to_window(
        &mut self,
        tabs: Vec<TabId>,
        target: Option<ardia_state::WindowId>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let Some(profile) = tabs
            .first()
            .and_then(|t| self.state.tab(t.as_str()))
            .map(|t| t.profile_id.clone())
        else {
            return;
        };
        let fresh = target.is_none();
        let target = match target {
            Some(target) => Some(target),
            None => self
                .host
                .store()
                .dispatch(Action::OpenWindow {
                    kind: WindowKind::Main,
                    profile: Some(profile),
                    url: None,
                    frame: None,
                })
                .ok()
                .and_then(|outcome| outcome.window),
        };
        let Some(target) = target else {
            return;
        };
        let blank: Vec<TabId> = if fresh {
            self.host
                .store()
                .snapshot()
                .view_tabs(target.as_str(), None)
                .into_iter()
                .filter(|t| t.url.is_empty() && !t.is_pinned() && !tabs.contains(&t.id))
                .map(|t| t.id.clone())
                .collect()
        } else {
            Vec::new()
        };
        for tab in tabs {
            self.host.dispatch(Action::MoveTab {
                tab,
                window: target.clone(),
                index: usize::MAX,
            });
        }
        if !blank.is_empty() {
            self.host.dispatch(Action::CloseTabs {
                tabs: blank,
                last_closes_window: false,
            });
        }
        self.on_store(ardia_state::Topics::ALL, window, cx);
    }

    pub(crate) fn run_command(&mut self, id: &str, window: &mut Window, cx: &mut Context<Self>) {
        if crate::plugins::bar_actions::parse_action_id(id).is_some() {
            if let Some(plugins) = self.host.plugins() {
                crate::plugins::bar_actions::run_action(
                    plugins.as_ref(),
                    &self.state,
                    &self.window_id,
                    id,
                );
            }
            return;
        }
        if let Some(arg) = id.strip_prefix(crate::sidebar::clean_up_upsell::UNDO_PREFIX) {
            ardia_telemetry::counts::count("clean_up_undos");
            for action in
                crate::sidebar::clean_up_upsell::undo_actions(&self.state, &self.window_id, arg)
            {
                self.dispatch(action, window, cx);
            }
            return;
        }
        if id == crate::sidebar::tidy_tabs::TIDY_COMMAND {
            let msgs = self
                .state
                .window(self.window_id.as_str())
                .map(|w| w.profile_id.clone())
                .map(|profile| {
                    crate::sidebar::tidy_tabs::tidy_messages(&self.state, &self.window_id, &profile)
                })
                .unwrap_or_default();
            for msg in msgs {
                self.handle(msg, window, cx);
            }
            return;
        }
        if id == crate::sidebar::tidy_tabs::TIDY_PINS_COMMAND {
            for msg in crate::sidebar::tidy_tabs::tidy_pins_messages(&self.state, &self.window_id) {
                self.handle(msg, window, cx);
            }
            return;
        }
        if let Some(arg) = id.strip_prefix(crate::sidebar::tidy_tabs::UNDO_TIDY_PREFIX) {
            for msg in crate::sidebar::tidy_tabs::undo_messages(&self.state, arg) {
                self.handle(msg, window, cx);
            }
            return;
        }
        if let Some(arg) = id.strip_prefix(crate::sidebar::sort_tabs::UNDO_SORT_PREFIX) {
            for msg in crate::sidebar::sort_tabs::undo_messages(&self.state, arg) {
                self.handle(msg, window, cx);
            }
            return;
        }
        if let Some((target, key)) = id
            .strip_prefix(crate::sidebar::sort_tabs::SORT_GROUP_PREFIX)
            .and_then(|arg| crate::sidebar::sort_tabs::group_command(arg, &self.window_id))
        {
            for msg in crate::sidebar::sort_tabs::sort_messages(&self.state, &target, key) {
                self.handle(msg, window, cx);
            }
            return;
        }
        if let Some(tab) = id.strip_prefix(crate::popovers::toast::SHOW_SYNCED_TAB) {
            self.dispatch(
                Action::ActivateTab {
                    tab: TabId::new(tab),
                },
                window,
                cx,
            );
            return;
        }
        if id == crate::popovers::menu_items::ADD_SHARED_FOLDER {
            drop(
                self.host
                    .sync_action(crate::sync_api::SyncAction::AddSharedFolder {
                        window: self.window_id.clone(),
                    }),
            );
            return;
        }
        if let Some((kind, group)) = id
            .strip_prefix(crate::popovers::menu_items::SHARED_FOLDER_COMMAND)
            .and_then(|rest| rest.split_once(':'))
        {
            let group = ardia_state::GroupId::new(group);
            let action = match kind {
                "share" => crate::sync_api::SyncAction::ShareFolder {
                    window: self.window_id.clone(),
                    group,
                },
                "reveal" => crate::sync_api::SyncAction::RevealSharedFolder { group },
                _ => crate::sync_api::SyncAction::StopSyncingFolder { group },
            };
            drop(self.host.sync_action(action));
            return;
        }
        if let Some((tab, device)) = id
            .strip_prefix(crate::popovers::menu_items::SEND_TAB)
            .and_then(|rest| rest.split_once(':'))
        {
            drop(self.host.sync_action(crate::sync_api::SyncAction::SendTab {
                tab: TabId::new(tab),
                device: device.to_owned(),
            }));
            return;
        }
        if id == crate::sidebar::tab_switcher::COMMIT_ID {
            if let Some(msg) = crate::sidebar::tab_switcher::commit_message(
                &self.state,
                self.window_id.as_str(),
                None,
            ) {
                self.handle(msg, window, cx);
            }
            cx.notify();
            return;
        }
        let Some((command, arg)) = Command::parse_id(id) else {
            log::debug!("unknown command {id}");
            return;
        };
        let _span = ardia_profile::command(command.id());
        if self.blocked_here(command) || self.setting_command(command, arg, window, cx) {
            return;
        }
        let window_id = self.window_id.clone();
        let active = self.active_tab();
        let tab = active.as_ref().map(|t| t.id.clone());
        let send = |this: &mut Self, msg: Msg, window: &mut Window, cx: &mut Context<Self>| {
            this.handle(msg, window, cx)
        };
        match command {
            Command::NewTab => self.new_tab(window, cx),
            Command::NewWindow => match arg.map(ProfileId::new) {
                Some(profile) if self.state.profile(profile.as_str()).is_some() => self.dispatch(
                    Action::OpenWindow {
                        kind: WindowKind::Main,
                        profile: Some(profile),
                        url: None,
                        frame: None,
                    },
                    window,
                    cx,
                ),
                _ => self.open_window(WindowKind::Main, window, cx),
            },
            Command::NewIncognitoWindow => self.open_window(WindowKind::Incognito, window, cx),
            Command::NewLittleArdia => self.open_window(WindowKind::LittleArdia, window, cx),
            Command::ReopenClosedTab => self.dispatch(
                Action::ReopenClosed {
                    window: Some(window_id),
                },
                window,
                cx,
            ),
            Command::RestoreClosed => {
                if let Some(id) = arg {
                    self.dispatch(
                        Action::RestoreClosed {
                            id: EntryId::new(id),
                            window: Some(window_id),
                        },
                        window,
                        cx,
                    );
                }
            }
            Command::ReopenClosedWindow => {
                self.dispatch(Action::ReopenClosed { window: None }, window, cx)
            }
            Command::ClearRecentlyClosed => self.dispatch(
                Action::ClearRecentlyClosed {
                    window: Some(self.window_id.clone()),
                },
                window,
                cx,
            ),
            Command::FocusCommandBar => self.open_panel_by_key(window, cx),
            Command::SearchTabs => crate::sidebar::search_tabs::open(self, window, cx),
            Command::ChangeTabIcon => {
                use crate::sidebar::icon_picker::{Target, open};
                let target = match arg {
                    Some(group) if group.starts_with("group:") => Some(Target::Group(
                        ardia_state::GroupId::new(group.trim_start_matches("group:")),
                    )),
                    Some(tab) => Some(Target::Tab(TabId::new(tab))),
                    None => tab.clone().map(Target::Tab),
                };
                if let Some(target) = target {
                    open(self, target, window, cx);
                }
            }
            Command::CloseTab if self.selected_tabs().len() > 1 => {
                let tabs = self.selected_tabs();
                ardia_telemetry::counts::count("selection_close_keys");
                ardia_telemetry::counts::add("selection_close_key_tabs", tabs.len() as u64);
                self.dispatch(
                    Action::CloseTabs {
                        tabs,
                        last_closes_window: false,
                    },
                    window,
                    cx,
                );
                self.dispatch(
                    Action::SelectTabs {
                        window: window_id,
                        tabs: Vec::new(),
                    },
                    window,
                    cx,
                );
            }
            Command::CloseTab => match tab {
                Some(tab) => {
                    if self.state.split_of(tab.as_str()).is_some() {
                        ardia_telemetry::counts::count("split_pane_closes");
                    }
                    self.dispatch(
                        Action::CloseTabs {
                            tabs: vec![tab],
                            last_closes_window: true,
                        },
                        window,
                        cx,
                    )
                }
                None => self.host.request_window_close(window_id),
            },
            Command::CloseAllTabs => self.clear_unpinned(window, cx),
            Command::CloseDuplicateTabs => self.close_duplicate_tabs(window, cx),
            Command::SortTabs => {
                if let Some(key) = arg.and_then(crate::sidebar::sort_tabs::SortKey::from_arg) {
                    let target = crate::sidebar::sort_tabs::SortTarget::window(&window_id);
                    for msg in crate::sidebar::sort_tabs::sort_messages(&self.state, &target, key) {
                        self.handle(msg, window, cx);
                    }
                }
            }
            Command::CleanUpTabs => {
                for msg in
                    crate::sidebar::clean_up_upsell::clean_up_now(&self.state, &self.window_id)
                {
                    self.handle(msg, window, cx);
                }
            }
            Command::UndoClearTabs => {
                self.dispatch(Action::UndoClear { window: window_id }, window, cx)
            }
            Command::CopyUrl => self.copy_url(false, window, cx),
            Command::CopyUrlAsMarkdown => self.copy_url(true, window, cx),
            Command::FindInPage | Command::UseSelectionForFind => {
                send(self, Msg::Find(FindMsg::Open), window, cx)
            }
            Command::FindAndReplace => send(self, Msg::Find(FindMsg::OpenReplace), window, cx),
            Command::FindNext => send(self, Msg::Find(FindMsg::Next), window, cx),
            Command::FindPrevious => send(self, Msg::Find(FindMsg::Previous), window, cx),
            Command::Reload => {
                if let Some(tab) = tab {
                    send(self, Msg::Reload { tab, hard: false }, window, cx);
                }
            }
            Command::ForceReload => {
                if let Some(tab) = tab {
                    send(self, Msg::Reload { tab, hard: true }, window, cx);
                }
            }
            Command::Stop => {
                if let Some(tab) = tab {
                    send(self, Msg::Stop(tab), window, cx);
                }
            }
            Command::Back => {
                if let Some(tab) = tab {
                    send(self, Msg::Back(tab), window, cx);
                }
            }
            Command::Forward => {
                if let Some(tab) = tab {
                    send(self, Msg::Forward(tab), window, cx);
                }
            }
            Command::ZoomIn | Command::ZoomOut | Command::ZoomReset => {
                if let Some(tab) = active
                    .as_ref()
                    .filter(|t| !t.url.is_empty())
                    .map(|t| t.id.clone())
                {
                    let step = match command {
                        Command::ZoomIn => 1,
                        Command::ZoomOut => -1,
                        _ => 0,
                    };
                    send(self, Msg::Zoom { tab, step }, window, cx);
                    self.site_msg(crate::site::SiteMsg::ZoomChanged, window, cx);
                }
            }
            Command::DevTools
            | Command::ToggleDevTools
            | Command::JavaScriptConsole
            | Command::InspectElements => {
                if let Some(tab) = tab {
                    send(self, Msg::DevTools(tab), window, cx);
                }
            }
            Command::ViewSource => {
                if let Some(page) = active.as_ref().filter(|t| is_web_page(&t.url)) {
                    self.dispatch(
                        Action::NewTab {
                            window: window_id,
                            tab: NewTab {
                                url: Some(format!("view-source:{}", page.url)),
                                opener: Some(page.id.clone()),
                                profile: Some(page.profile_id.clone()),
                                ..NewTab::default()
                            },
                        },
                        window,
                        cx,
                    );
                }
            }
            Command::NextTab => self.dispatch(
                Action::CycleTab {
                    window: window_id,
                    delta: 1,
                },
                window,
                cx,
            ),
            Command::PreviousTab => self.dispatch(
                Action::CycleTab {
                    window: window_id,
                    delta: -1,
                },
                window,
                cx,
            ),
            Command::TabSwitcher => {
                match crate::sidebar::tab_switcher::step(
                    &self.state,
                    window_id.as_str(),
                    arg == Some("backward"),
                    std::time::Instant::now(),
                ) {
                    crate::sidebar::tab_switcher::Step::Activate(tab) => {
                        self.dispatch(Action::ActivateTab { tab }, window, cx)
                    }
                    _ => cx.notify(),
                }
            }
            Command::SelectTab => {
                let index = arg
                    .and_then(|a| a.parse::<usize>().ok())
                    .map(|n| n.saturating_sub(1));
                self.dispatch(
                    Action::SelectTabAt {
                        window: window_id,
                        index,
                    },
                    window,
                    cx,
                );
            }
            Command::SelectLastTab => self.dispatch(
                Action::SelectTabAt {
                    window: window_id,
                    index: None,
                },
                window,
                cx,
            ),
            Command::TogglePin => {
                if let Some(active) = &active {
                    let row = active.pin.as_ref().is_some_and(TabPin::is_row);
                    let pin = match arg {
                        Some("row") if row => Some(TabPin::TILE),
                        Some("row") => Some(TabPin::Row),
                        Some("tile") if row => Some(TabPin::TILE),
                        Some("tile") => return,
                        _ if active.pin.is_some() => None,
                        _ => Some(TabPin::TILE),
                    };
                    self.dispatch(
                        Action::SetPin {
                            tab: active.id.clone(),
                            pin,
                        },
                        window,
                        cx,
                    );
                }
            }
            Command::TogglePinnedRow => {
                if let Some(active) = &active {
                    let pin = if active.pin.as_ref().is_some_and(TabPin::is_row) {
                        None
                    } else {
                        Some(TabPin::Row)
                    };
                    self.dispatch(
                        Action::SetPin {
                            tab: active.id.clone(),
                            pin,
                        },
                        window,
                        cx,
                    );
                }
            }
            Command::DuplicateTab => {
                if let Some(tab) = tab {
                    self.dispatch(Action::DuplicateTab { tab }, window, cx);
                }
            }
            Command::BookmarkPage
            | Command::BookmarkAllTabs
            | Command::ExportBookmarks
            | Command::AddFolderToSidebar
            | Command::RestoreArcFolders
            | Command::OpenBookmark
            | Command::AddBookmarkToFolder => {
                let glass = self.look.glass;
                if let Some(ctx) = crate::bookmarks_bar::BarCtx::for_window(
                    &self.host,
                    &self.emit,
                    &self.window_id,
                    &self.look.p,
                    glass,
                    cx,
                ) {
                    crate::bookmarks_bar::run_command(&ctx, command, arg, window, cx);
                }
            }
            Command::HideElement => {
                if let Some(tab) = tab.clone() {
                    send(
                        self,
                        Msg::Site(crate::site::SiteMsg::Answer(
                            tab,
                            crate::site::SiteAnswer::HideElement,
                        )),
                        window,
                        cx,
                    );
                }
            }
            Command::ShowHiddenElements => send(
                self,
                Msg::TogglePopover(ardia_state::windows::Popover::Custom(
                    crate::site::render::HIDDEN_ELEMENTS_POPOVER.to_owned(),
                )),
                window,
                cx,
            ),
            Command::ToggleMute => {
                if let Some(active) = &active {
                    let actions =
                        ardia_state::mute::toggle(&self.state, &active.id, arg == Some("site"));
                    send(self, Msg::Stores(actions), window, cx);
                }
            }
            Command::Downloads => self.handle(Msg::TogglePopover(Popover::Downloads), window, cx),
            Command::SwitchProfile => {
                if let Some(profile) = arg.map(ProfileId::new) {
                    self.switch_profile(profile, window, cx);
                }
            }
            Command::NextProfile => {
                if let Some(profile) = self.profile_step(1) {
                    self.switch_profile(profile, window, cx);
                }
            }
            Command::PreviousProfile => {
                if let Some(profile) = self.profile_step(-1) {
                    self.switch_profile(profile, window, cx);
                }
            }
            Command::NewProfile => self.handle(
                Msg::People(crate::profiles::layer::PeopleMsg::CreateProfile),
                window,
                cx,
            ),
            Command::OpenSettings => {
                send(self, Msg::Utility(UtilityWindowKind::Settings), window, cx)
            }
            Command::ClearBrowsingData => {
                crate::pages::history::request_clear_data(&window_id);
                self.open_internal(PageKind::History, window, cx);
                cx.notify();
            }
            Command::ManagePlugins => send(self, Msg::SettingsAt(Pane::Plugins), window, cx),
            Command::ManageExtensions => send(self, Msg::SettingsAt(Pane::Extensions), window, cx),
            Command::PinExtensions => send(self, Msg::PinDialog(true), window, cx),
            Command::AddExtension => send(
                self,
                Msg::Store(Action::NewTab {
                    window: window_id,
                    tab: ardia_state::NewTab {
                        url: Some(crate::popovers::extensions::WEB_STORE_URL.to_owned()),
                        ..ardia_state::NewTab::default()
                    },
                }),
                window,
                cx,
            ),
            Command::OpenExtension => {
                if let (Some(id), Some(tab)) = (arg, self.active_tab()) {
                    send(
                        self,
                        Msg::Extension {
                            tab: tab.id.clone(),
                            extension: id.to_owned(),
                        },
                        window,
                        cx,
                    );
                }
            }
            Command::Autofill => send(self, Msg::SettingsAt(Pane::Autofill), window, cx),
            Command::KeyboardShortcuts => send(self, Msg::SettingsAt(Pane::Shortcuts), window, cx),
            Command::ImportBrowserData => {
                send(self, Msg::Utility(UtilityWindowKind::Import), window, cx)
            }
            Command::ShowOnboarding => send(
                self,
                Msg::Utility(UtilityWindowKind::Onboarding),
                window,
                cx,
            ),
            Command::ShowHistory => self.open_internal(PageKind::History, window, cx),
            Command::ManageBookmarks => self.open_internal(PageKind::Bookmarks, window, cx),
            Command::ToggleSidebar => {
                self.dispatch(Action::ToggleSidebar { window: window_id }, window, cx)
            }
            Command::ToggleTabLayout => {
                let layout = match self.state.tab_layout(window_id.as_str()) {
                    TabLayout::Sidebar => TabLayout::Top,
                    TabLayout::Top => TabLayout::Sidebar,
                };
                ardia_telemetry::counts::count(match layout {
                    TabLayout::Top => "tab_layout_switches_to_top",
                    TabLayout::Sidebar => "tab_layout_switches_to_sidebar",
                });
                self.dispatch(
                    Action::SetTabLayout {
                        window: None,
                        layout,
                    },
                    window,
                    cx,
                );
            }
            Command::SetTabLayout => self.set_layout(arg.unwrap_or_default(), window, cx),
            Command::ToggleSidebarSide => {
                let side = match self.state.settings.sidebar_side {
                    SidebarSide::Left => SidebarSide::Right,
                    SidebarSide::Right => SidebarSide::Left,
                };
                self.settings(SettingsPatch::new().set("sidebarSide", side), window, cx);
            }
            Command::ToggleAddressBar => {
                let bar = match self.state.settings.address_bar {
                    AddressBar::Toolbar => AddressBar::Sidebar,
                    AddressBar::Sidebar => AddressBar::Toolbar,
                };
                self.settings(SettingsPatch::new().set("addressBar", bar), window, cx);
            }
            Command::ToggleBookmarksBar => {
                let browser = self.state.window(window_id.as_str()).cloned();
                let shown = browser.as_ref().is_some_and(|w| {
                    crate::popovers::menu_items::bookmarks_bar_shown(&self.state, w)
                });
                let mode = if shown {
                    BookmarksBar::Never
                } else {
                    BookmarksBar::Always
                };
                self.settings(SettingsPatch::new().set("bookmarksBar", mode), window, cx);
            }
            Command::ToggleOpenLinksInLittleArdia => {
                let patch = flip(&self.state.settings, "openLinksInLittleArdia");
                self.settings(patch, window, cx);
            }
            Command::OpenSplitPane | Command::OpenSplitPaneBelow => {
                let side = if command == Command::OpenSplitPane {
                    SplitSide::Right
                } else {
                    ardia_telemetry::counts::count("split_below_opens");
                    SplitSide::Bottom
                };
                self.dispatch(
                    Action::OpenSplitPane {
                        window: window_id,
                        side,
                        url: None,
                    },
                    window,
                    cx,
                );
            }
            Command::FocusNextPane => self.dispatch(
                Action::FocusPane {
                    window: window_id,
                    delta: 1,
                },
                window,
                cx,
            ),
            Command::FocusPreviousPane => self.dispatch(
                Action::FocusPane {
                    window: window_id,
                    delta: -1,
                },
                window,
                cx,
            ),
            Command::MoveSplitPaneLeft
            | Command::MoveSplitPaneRight
            | Command::MoveSplitPaneUp
            | Command::MoveSplitPaneDown => {
                if let Some(tab) = tab {
                    let direction = match command {
                        Command::MoveSplitPaneLeft => PaneDirection::Left,
                        Command::MoveSplitPaneRight => PaneDirection::Right,
                        Command::MoveSplitPaneUp => PaneDirection::Up,
                        _ => PaneDirection::Down,
                    };
                    ardia_telemetry::counts::count("split_pane_key_moves");
                    self.dispatch(Action::MovePane { tab, direction }, window, cx);
                }
            }
            Command::NewGroupWithTabs => {
                let selection = self
                    .state
                    .window(window_id.as_str())
                    .map(|w| w.chrome.selection.clone())
                    .filter(|s| !s.is_empty())
                    .or_else(|| tab.clone().map(|t| vec![t]));
                if let Some(tabs) = selection {
                    self.dispatch(
                        Action::CreateGroup {
                            tabs,
                            name: "New Group".into(),
                        },
                        window,
                        cx,
                    );
                }
            }
            Command::NewTabInGroup => {
                if let Some(group) = tab
                    .as_ref()
                    .and_then(|t| self.state.group_of(t.as_str()))
                    .map(|g| g.id.clone())
                {
                    self.handle(Msg::NewTabInGroup(group), window, cx);
                } else {
                    self.new_tab(window, cx);
                }
            }
            Command::CloseTabGroup => {
                if let Some(group) = tab
                    .as_ref()
                    .and_then(|t| self.state.group_of(t.as_str()))
                    .map(|g| g.id.clone())
                {
                    self.dispatch(Action::CloseGroup { group }, window, cx);
                }
            }
            Command::TogglePinnedFold => {
                let profile = self
                    .state
                    .window(window_id.as_str())
                    .filter(|_| self.state.tab_layout(window_id.as_str()) == TabLayout::Sidebar)
                    .and_then(|w| self.state.profile(w.profile_id.as_str()));
                if let Some(profile) = profile {
                    let collapsed = profile.pinned_collapsed.unwrap_or(false);
                    self.dispatch(
                        Action::UpdateProfile {
                            profile: profile.id.clone(),
                            patch: ProfilePatch {
                                pinned_collapsed: Some(!collapsed),
                                ..ProfilePatch::default()
                            },
                        },
                        window,
                        cx,
                    );
                }
            }
            Command::RenameTab => {
                if let Some(tab) = tab {
                    self.handle(Msg::Rename(Some(RenameTarget::Tab(tab))), window, cx);
                }
            }
            Command::ReturnToPinnedUrl => {
                if let Some(tab) = tab {
                    self.dispatch(Action::ReturnToPinnedUrl { tab }, window, cx);
                }
            }
            Command::MoveTabDown => self.move_tab_by(1, window, cx),
            Command::MoveTabUp => self.move_tab_by(-1, window, cx),
            Command::OpenProfileMenu => {
                let at = gpui::point(gpui::px(80.), gpui::px(40.));
                self.handle(
                    Msg::Menu(Some((crate::msg::MenuTarget::Profile, at))),
                    window,
                    cx,
                );
            }
            Command::OpenPeekAsTab => {
                self.dispatch(Action::PromotePeek { window: window_id }, window, cx)
            }
            Command::ClosePeek => {
                self.dispatch(Action::ClosePeek { window: window_id }, window, cx)
            }
            Command::Cast => {
                if let Some(tab) = tab {
                    send(self, Msg::Cast(tab), window, cx);
                }
            }
            Command::Share => {
                if let Some(tab) = tab {
                    send(self, Msg::Share(tab), window, cx);
                }
            }
            Command::MergeAllWindows => {
                let others: Vec<_> = self
                    .state
                    .window_order
                    .iter()
                    .filter(|id| **id != window_id)
                    .filter_map(|id| self.state.window(id.as_str()).cloned())
                    .filter(|w| w.kind == WindowKind::Main)
                    .collect();
                let mut index = self
                    .state
                    .window(window_id.as_str())
                    .map_or(0, |w| w.tab_ids.len());
                for other in others {
                    for moving in other.tab_ids.iter() {
                        self.host.dispatch(Action::MoveTab {
                            tab: moving.clone(),
                            window: window_id.clone(),
                            index,
                        });
                        index += 1;
                    }
                }
                self.on_store(ardia_state::Topics::ALL, window, cx);
            }
            Command::CloseWindow => self.request_close(window, cx),
            Command::ToggleFullScreen => {
                let on = !self.window_full_screen(window);
                self.set_window_full_screen(on, window, cx)
            }
            Command::Minimize => window.minimize_window(),
            Command::Hide => cx.hide(),
            Command::HideOthers => cx.hide_other_apps(),
            Command::ShowAll => cx.unhide_other_apps(),
            Command::OpenFile if self.state.shown_peek(window_id.as_str()).is_some() => {
                self.dispatch(Action::PromotePeek { window: window_id }, window, cx)
            }
            Command::OpenFile => self.host.open_file(window_id),
            Command::Print | Command::SavePage | Command::PrintWithSystemDialog => {
                let page_command = match command {
                    Command::Print => PageCommand::Print,
                    Command::SavePage => PageCommand::SavePage,
                    _ => PageCommand::PrintWithSystemDialog,
                };
                if let Some(tab) = tab {
                    self.host.page_command(tab, page_command);
                }
            }
            Command::ToggleReader => {
                if let Some(tab) = tab {
                    self.host.toggle_reader(tab);
                }
            }
            Command::TogglePageEngine => {
                if let Some(tab) = arg
                    .map(ardia_state::TabId::new)
                    .filter(|tab| self.state.tab(tab.as_str()).is_some())
                    .or(tab)
                {
                    self.host.toggle_page_engine(tab);
                }
            }
            Command::ReportProblem => {
                self.handle(crate::report::sheet::open_report(&window_id), window, cx)
            }
            _ => log::debug!("command {id} has no window action"),
        }
    }
}

impl BrowserWindowView {
    fn open_internal(&mut self, kind: PageKind, window: &mut Window, cx: &mut Context<Self>) {
        match plan_open(&self.state, &self.window_id, kind) {
            OpenPlan::Activate(tab) => self.dispatch(Action::ActivateTab { tab }, window, cx),
            OpenPlan::NavigateIn(_) => self.open_input(kind.page().url(), false, window, cx),
            OpenPlan::NewTab => self.open_input(kind.page().url(), true, window, cx),
        }
    }
}
