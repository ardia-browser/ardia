use std::sync::Arc;

use ardia_engine::{EngineTabId, ExtensionActionStates, ExtensionViewKind, Services, TabCommand};
use ardia_state::{ProfileId, TabId, WindowId};
use ardia_ui::host_data::{ExtensionItem, ExtensionList, ExtensionPopupView, HostTopics};
use ardia_ui::primitives::favicon::decode_data_uri;
use serde_json::{Value, json};

use crate::coordinator::AppCoordinator;

pub const POPUP_SIZE: (f32, f32) = (25.0, 25.0);

#[derive(Clone, Debug, PartialEq)]
pub struct SidePanelCard {
    pub url: String,
    pub engine_tab: EngineTabId,
    pub owners: std::collections::HashSet<TabId>,
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct SidePanelEntry {
    pub extension_id: String,
    pub engine_tab: Option<EngineTabId>,
    pub tab: Option<TabId>,
    pub hidden: bool,
    pub shown_tabs: std::collections::HashSet<TabId>,
    pub closed_tabs: std::collections::HashSet<TabId>,
    pub cards: Vec<SidePanelCard>,
    pub synced_for: Option<TabId>,
    pub sync_queued: bool,
}

#[derive(Clone, Debug, PartialEq)]
pub struct PopupEntry {
    pub extension_id: String,
    pub name: String,
    pub engine_tab: EngineTabId,
    pub opened_on: TabId,
    pub size: (f32, f32),
    pub sized: bool,
}

fn text(value: &Value, key: &str) -> String {
    value
        .get(key)
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_owned()
}

fn flag(value: &Value, key: &str) -> bool {
    value.get(key).and_then(Value::as_bool).unwrap_or(false)
}

fn image_of(url: &str) -> Option<Arc<gpui::Image>> {
    url.starts_with("data:")
        .then(|| decode_data_uri(url))
        .flatten()
}

pub fn parse_list(reply: &Value, private: bool) -> Vec<ExtensionItem> {
    let rows = reply
        .get("extensions")
        .or(Some(reply))
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    rows.iter()
        .filter_map(|row| {
            let id = text(row, "id");
            if id.is_empty() || (private && !flag(row, "incognito")) {
                return None;
            }
            let action_icon = text(row, "actionIcon");
            let icon = image_of(&action_icon).or_else(|| image_of(&text(row, "icon")));
            Some(ExtensionItem {
                name: Some(text(row, "name"))
                    .filter(|name| !name.is_empty())
                    .unwrap_or_else(|| id.clone()),
                id,
                icon,
                enabled: flag(row, "enabled"),
                pinned: flag(row, "pinned"),
                pinned_index: row
                    .get("pinnedIndex")
                    .and_then(Value::as_u64)
                    .and_then(|index| u32::try_from(index).ok()),
                has_action: row
                    .get("hasAction")
                    .and_then(Value::as_bool)
                    .unwrap_or(true),
                action_title: text(row, "actionTitle"),
                badge: String::new(),
                badge_color: None,
                badge_text_color: None,
                action_enabled: true,
                may_modify: flag(row, "mayModify"),
                options_url: Some(text(row, "optionsUrl")).filter(|url| !url.is_empty()),
                from_web_store: flag(row, "fromWebStore"),
                side_panel: !text(row, "sidePanel").is_empty(),
            })
        })
        .collect()
}

pub fn with_action_states(
    items: &[ExtensionItem],
    states: &ExtensionActionStates,
) -> Vec<ExtensionItem> {
    items
        .iter()
        .map(|item| {
            let mut item = item.clone();
            if let Some(state) = states.get(&item.id) {
                if !state.title.is_empty() {
                    item.action_title = state.title.clone();
                }
                item.badge = state.badge_text.chars().take(4).collect();
                item.badge_color = state.badge_color.clone();
                item.badge_text_color = state.badge_text_color.clone();
                item.action_enabled = state.enabled;
                if let Some(icon) = state.icon.as_deref().and_then(image_of) {
                    item.icon = Some(icon);
                }
            }
            item
        })
        .collect()
}

fn popup_url(states: &ExtensionActionStates, extension_id: &str) -> Option<String> {
    let popup = states.get(extension_id)?.popup.as_ref()?;
    let url = popup
        .as_str()
        .map(str::to_owned)
        .or_else(|| popup.get("url").and_then(Value::as_str).map(str::to_owned))?;
    url.starts_with("chrome-extension://").then_some(url)
}

impl AppCoordinator {
    fn extension_profile(&self, window: &WindowId) -> Option<(ProfileId, bool)> {
        let state = self.store.snapshot();
        let profile = state.window(window.as_str())?.profile_id.clone();
        if profile.is_incognito() {
            Some((profile.incognito_original(), true))
        } else {
            Some((profile, false))
        }
    }

    fn shown_tab(&self, window: &WindowId) -> Option<TabId> {
        self.store
            .snapshot()
            .active_tab(window.as_str())
            .map(|tab| tab.id.clone())
    }

    pub(crate) fn extension_list(&self, window: &WindowId) -> ExtensionList {
        let shown = self.shown_tab(window);
        let cached = self.bridge.lock().toolbar_snapshots.get(window).cloned();
        match cached {
            Some((tab, list)) if tab == shown && list.loaded => list,
            Some((_, list)) => {
                self.schedule_snapshot(window);
                list
            }
            None => {
                self.schedule_snapshot(window);
                ExtensionList {
                    profile: self.extension_profile(window).map(|(profile, _)| profile),
                    loaded: false,
                    items: Arc::default(),
                }
            }
        }
    }

    fn schedule_snapshot(&self, window: &WindowId) {
        if !self.bridge.lock().snapshots_pending.insert(window.clone()) {
            return;
        }
        let window = window.clone();
        self.post(move |coordinator| coordinator.rebuild_snapshot(&window));
    }

    fn refresh_snapshots(&self) {
        let windows: Vec<WindowId> = self
            .bridge
            .lock()
            .toolbar_snapshots
            .keys()
            .cloned()
            .collect();
        for window in windows {
            self.schedule_snapshot(&window);
        }
    }

    fn rebuild_snapshot(&self, window: &WindowId) {
        self.bridge.lock().snapshots_pending.remove(window);
        if self.store.snapshot().window(window.as_str()).is_none() {
            self.bridge.lock().toolbar_snapshots.remove(window);
            return;
        }
        let shown = self.shown_tab(window);
        let list = self.build_extension_list(window, shown.as_ref());
        let changed = {
            let mut bridge = self.bridge.lock();
            let changed = bridge
                .toolbar_snapshots
                .get(window)
                .is_none_or(|(tab, known)| *tab != shown || *known != list);
            if list.loaded || !bridge.toolbar_snapshots.contains_key(window) {
                bridge
                    .toolbar_snapshots
                    .insert(window.clone(), (shown, list));
            }
            changed
        };
        if changed {
            self.signal.emit(HostTopics::EXTENSIONS);
        }
    }

    fn build_extension_list(&self, window: &WindowId, shown: Option<&TabId>) -> ExtensionList {
        let Some((profile, private)) = self.extension_profile(window) else {
            return ExtensionList::default();
        };
        let cached = self.bridge.lock().extension_lists.get(&profile).cloned();
        let Some(items) = cached else {
            self.fetch_extensions(&profile);
            return ExtensionList {
                profile: Some(profile),
                loaded: false,
                items: Arc::default(),
            };
        };
        let visible: Vec<ExtensionItem> = items
            .iter()
            .filter(|(_, incognito)| !private || *incognito)
            .map(|(item, _)| item.clone())
            .collect();
        let states = shown
            .map(|tab| self.tab_action_states(tab, &visible))
            .unwrap_or_default();
        ExtensionList {
            profile: Some(profile),
            loaded: true,
            items: Arc::new(with_action_states(&visible, &states)),
        }
    }

    fn tab_action_states(&self, tab: &TabId, items: &[ExtensionItem]) -> ExtensionActionStates {
        if let Some(known) = self.bridge.lock().action_states.get(tab) {
            return known.clone();
        }
        let ids: Vec<String> = items
            .iter()
            .filter(|item| item.enabled && item.has_action)
            .map(|item| item.id.clone())
            .collect();
        let (Some(engine_tab), Some(engine)) = (self.engine_tab(tab), self.engine()) else {
            return ExtensionActionStates::new();
        };
        if ids.is_empty() {
            return ExtensionActionStates::new();
        }
        ardia_telemetry::counts::count("extension_action_state_requests");
        let states = engine
            .extension_action_states(engine_tab, &ids)
            .unwrap_or_else(|problem| {
                ardia_telemetry::counts::count("extension_action_state_failures");
                log::debug!("{tab} has no extension action states: {problem}");
                ExtensionActionStates::new()
            });
        self.bridge
            .lock()
            .action_states
            .insert(tab.clone(), states.clone());
        states
    }

    pub(crate) fn fetch_extensions(&self, profile: &ProfileId) {
        let (Some(engine), Some(dir)) = (self.engine(), self.service_profile_dir(profile)) else {
            return;
        };
        let watch = {
            let mut bridge = self.bridge.lock();
            if !bridge.extension_loading.insert(profile.clone()) {
                return;
            }
            bridge.extension_watched.insert(profile.clone())
        };
        let services = Services::new(engine.as_ref(), &dir);
        if watch {
            let watching = services.extensions().watch_actions();
            self.spawn(async move {
                if let Err(problem) = watching.await {
                    log::debug!("extension actions aren't watched: {problem}");
                }
            });
        }
        let first_load = !profile.is_incognito()
            && EXTENSIONS_LOAD_REPORTED
                .lock()
                .insert(profile.as_str().to_owned());
        let health = first_load.then(|| services.extensions().load_health());
        let default_profile =
            self.store().snapshot().settings.default_profile_id == profile.as_str();
        let consent = ardia_telemetry::consent_now();
        let reply = services.extensions().list();
        let me = self.weak();
        let profile = profile.clone();
        self.spawn(async move {
            if let Some(health) = health
                && let Ok(health) = health.await
            {
                note_extensions_loaded(&health, default_profile, consent.as_ref());
            }
            let listed = reply.await;
            let Some(me) = me.upgrade() else {
                return;
            };
            let items = match listed {
                Ok(value) => {
                    let all = parse_list(&value, false);
                    note_extensions_installed(&profile, &all);
                    let private: Vec<String> = parse_list(&value, true)
                        .into_iter()
                        .map(|item| item.id)
                        .collect();
                    all.into_iter()
                        .map(|item| {
                            let incognito = private.contains(&item.id);
                            (item, incognito)
                        })
                        .collect()
                }
                Err(problem) => {
                    log::warn!("the extensions of {profile} didn't load: {problem}");
                    Vec::new()
                }
            };
            {
                let mut bridge = me.bridge.lock();
                bridge.extension_loading.remove(&profile);
                bridge.extension_lists.insert(profile, items);
            }
            me.refresh_snapshots();
        });
    }

    pub(crate) fn extensions_changed(&self) {
        let stale: Vec<ProfileId> = {
            let mut bridge = self.bridge.lock();
            bridge.action_states.clear();
            bridge
                .extension_lists
                .drain()
                .map(|(profile, _)| profile)
                .collect()
        };
        for profile in stale {
            self.fetch_extensions(&profile);
        }
        self.refresh_snapshots();
    }

    pub(crate) fn extension_actions_changed(&self) {
        ardia_telemetry::counts::count("extension_action_refreshes");
        self.bridge.lock().action_states.clear();
        self.refresh_snapshots();
    }

    pub(crate) fn pin_extension(&self, window: &WindowId, extension_id: &str, pinned: bool) {
        let Some((profile, _)) = self.extension_profile(window) else {
            return;
        };
        let (Some(engine), Some(dir)) = (self.engine(), self.service_profile_dir(&profile)) else {
            return;
        };
        if let Some(items) = self.bridge.lock().extension_lists.get_mut(&profile) {
            let next = items
                .iter()
                .filter_map(|(item, _)| item.pinned_index)
                .max()
                .map_or(0, |last| last + 1);
            if let Some((item, _)) = items.iter_mut().find(|(item, _)| item.id == extension_id) {
                item.pinned = pinned;
                item.pinned_index = pinned.then_some(next);
            }
        }
        self.refresh_snapshots();
        let reply = Services::new(engine.as_ref(), &dir)
            .extensions()
            .configure(extension_id, json!({ "pinned": pinned }));
        let me = self.weak();
        let id = extension_id.to_owned();
        self.spawn(async move {
            let configured = reply.await;
            let Some(me) = me.upgrade() else {
                return;
            };
            if let Err(problem) = configured {
                log::warn!(
                    "{id} couldn't be {}: {problem}",
                    if pinned { "pinned" } else { "unpinned" }
                );
            }
            me.bridge.lock().extension_lists.remove(&profile);
            me.fetch_extensions(&profile);
        });
    }

    pub(crate) fn run_extension_action(&self, tab: &TabId, extension_id: &str) {
        let Some(window) = self.window_of(tab) else {
            return;
        };
        let same = self
            .bridge
            .lock()
            .popups
            .get(&window)
            .is_some_and(|popup| popup.extension_id == extension_id);
        self.close_popup(&window);
        if same {
            return;
        }
        let (Some(engine_tab), Some(engine)) = (self.engine_tab(tab), self.engine()) else {
            log::debug!("{tab} has no page yet to run {extension_id}");
            return;
        };
        match engine.execute_extension_action(engine_tab, extension_id) {
            Ok(result) if result == "popup" => {
                self.open_extension_popup(&window, tab, extension_id)
            }
            Ok(result) if result == "none" => {}
            Ok(result) => log::debug!("{extension_id} answered its click with {result}"),
            Err(problem) => log::warn!("{tab} couldn't run {extension_id}: {problem}"),
        }
    }

    pub(crate) fn open_extension_popup(&self, window: &WindowId, tab: &TabId, extension_id: &str) {
        let (Some(engine_tab), Some(engine), Some(engine_window), Some(profile)) = (
            self.engine_tab(tab),
            self.engine(),
            self.engine_window(window),
            self.engine_profile_of(tab),
        ) else {
            return;
        };
        let ids = [extension_id.to_owned()];
        let states = engine
            .extension_action_states(engine_tab, &ids)
            .unwrap_or_default();
        if self
            .store
            .snapshot()
            .window(window.as_str())
            .is_some_and(|w| w.profile_id.is_incognito())
        {
            ardia_telemetry::counts::count("private_window_extension_opens");
        }
        let Some(url) = popup_url(&states, extension_id) else {
            log::debug!("{extension_id} has no popup on {tab}");
            return;
        };
        let opened = match engine.open_extension_view(
            engine_window,
            &url,
            profile,
            ExtensionViewKind::Popup,
        ) {
            Ok(Some(opened)) => opened,
            Ok(None) => return,
            Err(problem) => {
                log::warn!("the popup of {extension_id} didn't open: {problem}");
                return;
            }
        };
        let name = self
            .extension_profile(window)
            .and_then(|(profile, _)| {
                self.bridge
                    .lock()
                    .extension_lists
                    .get(&profile)
                    .and_then(|items| items.iter().find(|(item, _)| item.id == extension_id))
                    .map(|(item, _)| item.name.clone())
            })
            .unwrap_or_else(|| extension_id.to_owned());
        {
            let mut bridge = self.bridge.lock();
            bridge.popup_tabs.insert(opened, window.clone());
            bridge.popups.insert(
                window.clone(),
                PopupEntry {
                    extension_id: extension_id.to_owned(),
                    name,
                    engine_tab: opened,
                    opened_on: tab.clone(),
                    size: POPUP_SIZE,
                    sized: false,
                },
            );
        }
        if self.backend() == ardia_engine::EngineBackend::Mac
            && let (Some(side), Ok(view)) = (self.side(), engine.native_view_handle(opened))
        {
            side.borrow_mut().views.insert(opened, view);
        }
        self.signal.emit(HostTopics::EXTENSIONS);
    }

    pub(crate) fn popup_view(&self, window: &WindowId) -> Option<ExtensionPopupView> {
        let entry = self.bridge.lock().popups.get(window).cloned()?;
        if self.shown_tab(window).as_ref() != Some(&entry.opened_on) {
            let window = window.clone();
            self.post(move |coordinator| coordinator.close_popup(&window));
            return None;
        }
        let view = self.side().and_then(|side| {
            side.borrow()
                .views
                .get(&entry.engine_tab)
                .map(ardia_engine::NativeView::handle)
        });
        Some(ExtensionPopupView {
            extension_id: entry.extension_id,
            name: entry.name,
            view,
            size: entry.size,
            sized: entry.sized,
        })
    }

    pub(crate) fn close_popup(&self, window: &WindowId) {
        let Some(entry) = self.bridge.lock().popups.remove(window) else {
            return;
        };
        self.bridge.lock().popup_tabs.remove(&entry.engine_tab);
        if let Some(side) = self.side() {
            let view = side.borrow_mut().views.remove(&entry.engine_tab);
            drop(view);
        }
        if let Some(engine) = self.engine()
            && let Err(problem) = engine.tab_command(entry.engine_tab, TabCommand::CloseNow)
        {
            log::debug!(
                "the popup of {} was already gone: {problem}",
                entry.extension_id
            );
        }
        self.signal.emit(HostTopics::EXTENSIONS);
    }

    pub(crate) fn uninstall_extension(&self, window: &WindowId, extension_id: &str) {
        let Some((profile, _)) = self.extension_profile(window) else {
            return;
        };
        let (Some(engine), Some(dir)) = (self.engine(), self.service_profile_dir(&profile)) else {
            return;
        };
        let open = self
            .bridge
            .lock()
            .popups
            .iter()
            .filter(|(_, popup)| popup.extension_id == extension_id)
            .map(|(window, _)| window.clone())
            .collect::<Vec<_>>();
        for window in open {
            self.close_popup(&window);
        }
        let panels: Vec<WindowId> = self
            .bridge
            .lock()
            .side_panels
            .iter()
            .filter(|(_, panel)| panel.extension_id == extension_id)
            .map(|(window, _)| window.clone())
            .collect();
        for window in panels {
            self.shut_side_panel(&window);
        }
        let reply = Services::new(engine.as_ref(), &dir)
            .extensions()
            .uninstall(extension_id);
        let me = self.weak();
        let id = extension_id.to_owned();
        self.spawn(async move {
            let removed = reply.await;
            let Some(me) = me.upgrade() else {
                return;
            };
            if let Err(problem) = removed {
                log::warn!("{id} couldn't be removed: {problem}");
            }
            me.bridge.lock().extension_lists.remove(&profile);
            me.fetch_extensions(&profile);
        });
    }

    pub(crate) fn reorder_extension(&self, window: &WindowId, extension_id: &str, to: usize) {
        if self
            .store
            .snapshot()
            .window(window.as_str())
            .is_none_or(|w| w.profile_id.is_incognito())
        {
            return;
        }
        let Some((profile, _)) = self.extension_profile(window) else {
            return;
        };
        let (Some(engine), Some(dir)) = (self.engine(), self.service_profile_dir(&profile)) else {
            return;
        };
        let moved = {
            let mut bridge = self.bridge.lock();
            let Some(items) = bridge.extension_lists.get_mut(&profile) else {
                return;
            };
            let mut shown: Vec<(String, Option<u32>)> = items
                .iter()
                .filter(|(item, _)| item.enabled && item.pinned)
                .map(|(item, _)| (item.id.clone(), item.pinned_index))
                .collect();
            shown.sort_by_key(|(_, index)| index.unwrap_or(u32::MAX));
            let Some((slots, pinned_index)) =
                ardia_ui::host_data::moved_toolbar_order(&shown, extension_id, to)
            else {
                return;
            };
            for (item, _) in items.iter_mut() {
                if let Some((_, slot)) = slots.iter().find(|(id, _)| *id == item.id) {
                    item.pinned_index = Some(*slot);
                }
            }
            pinned_index
        };
        self.refresh_snapshots();
        let reply = Services::new(engine.as_ref(), &dir)
            .extensions()
            .configure(extension_id, json!({ "pinnedIndex": moved }));
        let me = self.weak();
        let id = extension_id.to_owned();
        self.spawn(async move {
            let configured = reply.await;
            let Some(me) = me.upgrade() else {
                return;
            };
            if let Err(problem) = configured {
                log::warn!("{id} couldn't move: {problem}");
                me.bridge.lock().extension_lists.remove(&profile);
                me.fetch_extensions(&profile);
            }
        });
    }

    pub(crate) fn flip_side_panel(&self, window: &WindowId, extension_id: &str) {
        let showing = self
            .bridge
            .lock()
            .side_panels
            .get(window)
            .is_some_and(|panel| panel.extension_id == extension_id && !panel.hidden);
        if showing {
            self.close_side_panel_on_tab(window);
        } else {
            self.open_side_panel(window, extension_id);
        }
    }

    pub(crate) fn side_panel_requested(&self, tab: Option<EngineTabId>, panel: &Value) {
        let Some(window) = tab
            .and_then(|tab| self.state_tab(tab))
            .and_then(|tab| self.window_of(&tab))
        else {
            return;
        };
        let extension_id = text(panel, "extensionId");
        if extension_id.is_empty() {
            return;
        }
        if flag(panel, "open") {
            self.open_side_panel(&window, &extension_id);
        } else if self
            .bridge
            .lock()
            .side_panels
            .get(&window)
            .is_some_and(|entry| entry.extension_id == extension_id)
        {
            self.shut_side_panel(&window);
        }
    }

    fn panel_page(&self, window: &WindowId) -> Option<TabId> {
        let state = self.store.snapshot();
        state
            .shown_peek(window.as_str())
            .map(|peek| peek.tab_id.clone())
            .or_else(|| state.active_tab(window.as_str()).map(|tab| tab.id.clone()))
    }

    fn open_side_panel(&self, window: &WindowId, extension_id: &str) {
        let reopening = self
            .bridge
            .lock()
            .side_panels
            .get(window)
            .is_none_or(|panel| panel.extension_id != extension_id);
        if reopening {
            self.shut_side_panel(window);
            self.bridge.lock().side_panels.insert(
                window.clone(),
                SidePanelEntry {
                    extension_id: extension_id.to_owned(),
                    hidden: true,
                    ..SidePanelEntry::default()
                },
            );
        }
        if let Some(tab) = self.panel_page(window)
            && let Some(entry) = self.bridge.lock().side_panels.get_mut(window)
        {
            entry.closed_tabs.remove(&tab);
        }
        self.sync_side_panel(window);
    }

    pub(crate) fn close_side_panel_on_tab(&self, window: &WindowId) {
        let tab = self.panel_page(window);
        let others = {
            let state = self.store.snapshot();
            let mut bridge = self.bridge.lock();
            let Some(entry) = bridge.side_panels.get_mut(window) else {
                return;
            };
            let Some(tab) = tab.or_else(|| entry.tab.clone()) else {
                drop(bridge);
                self.shut_side_panel(window);
                return;
            };
            entry.shown_tabs.remove(&tab);
            entry.closed_tabs.insert(tab);
            entry.shown_tabs.iter().any(|id| {
                state
                    .tab(id.as_str())
                    .is_some_and(|t| &t.window_id == window)
            })
        };
        if others {
            self.hide_side_panel(window);
        } else {
            self.shut_side_panel(window);
        }
    }

    fn hide_side_panel(&self, window: &WindowId) {
        let changed = self
            .bridge
            .lock()
            .side_panels
            .get_mut(window)
            .is_some_and(|entry| !std::mem::replace(&mut entry.hidden, true));
        if changed {
            self.signal.emit(HostTopics::EXTENSIONS);
        }
    }

    fn sync_side_panel(&self, window: &WindowId) {
        let Some((extension_id, closed)) = ({
            let tab = self.panel_page(window);
            let mut bridge = self.bridge.lock();
            bridge.side_panels.get_mut(window).map(|entry| {
                entry.synced_for = tab.clone();
                (
                    entry.extension_id.clone(),
                    tab.as_ref().is_some_and(|t| entry.closed_tabs.contains(t)),
                )
            })
        }) else {
            return;
        };
        if closed {
            self.hide_side_panel(window);
            return;
        }
        let Some(tab) = self.panel_page(window) else {
            return;
        };
        let (Some(engine_tab), Some(engine), Some(engine_window), Some(profile)) = (
            self.engine_tab(&tab),
            self.engine(),
            self.engine_window(window),
            self.engine_profile_of(&tab),
        ) else {
            return;
        };
        let url = match engine.side_panel_url(engine_tab, &extension_id) {
            Ok(Some(url)) if url.starts_with("chrome-extension://") => Some(url),
            Ok(_) => None,
            Err(problem) => {
                log::warn!("the side panel of {extension_id} isn't available: {problem}");
                None
            }
        };
        let Some(url) = url else {
            log::debug!("{extension_id} has no side panel on {tab}");
            let none_left = {
                let mut bridge = self.bridge.lock();
                bridge.side_panels.get_mut(window).is_some_and(|entry| {
                    entry.shown_tabs.remove(&tab);
                    entry.cards.is_empty()
                })
            };
            if none_left {
                self.shut_side_panel(window);
            } else {
                self.hide_side_panel(window);
            }
            return;
        };
        let warm = self
            .bridge
            .lock()
            .side_panels
            .get(window)
            .and_then(|entry| {
                entry
                    .cards
                    .iter()
                    .find(|card| card.url == url)
                    .map(|card| card.engine_tab)
            });
        let opened = match warm {
            Some(opened) => opened,
            None => match engine.open_extension_view(
                engine_window,
                &url,
                profile,
                ExtensionViewKind::SidePanel,
            ) {
                Ok(Some(opened)) => {
                    if self.backend() == ardia_engine::EngineBackend::Mac
                        && let (Some(side), Ok(view)) =
                            (self.side(), engine.native_view_handle(opened))
                    {
                        side.borrow_mut().views.insert(opened, view);
                    }
                    self.bridge.lock().popup_tabs.insert(opened, window.clone());
                    opened
                }
                Ok(None) => return,
                Err(problem) => {
                    log::warn!("the side panel of {extension_id} didn't open: {problem}");
                    return;
                }
            },
        };
        let dropped = {
            let state = self.store.snapshot();
            let mut bridge = self.bridge.lock();
            let Some(entry) = bridge.side_panels.get_mut(window) else {
                return;
            };
            entry.shown_tabs.insert(tab.clone());
            if !entry.cards.iter().any(|card| card.engine_tab == opened) {
                entry.cards.push(SidePanelCard {
                    url,
                    engine_tab: opened,
                    owners: Default::default(),
                });
            }
            for card in &mut entry.cards {
                card.owners.remove(&tab);
                if card.engine_tab == opened {
                    card.owners.insert(tab.clone());
                }
            }
            let live = |id: &TabId| {
                state
                    .tab(id.as_str())
                    .is_some_and(|t| &t.window_id == window)
            };
            let closed = entry.closed_tabs.clone();
            let mut dropped = Vec::new();
            entry.cards.retain(|card| {
                let kept = card.engine_tab == opened
                    || card
                        .owners
                        .iter()
                        .any(|id| live(id) && !closed.contains(id));
                if !kept {
                    dropped.push(card.engine_tab);
                }
                kept
            });
            entry.engine_tab = Some(opened);
            entry.tab = Some(tab);
            entry.hidden = false;
            for gone in &dropped {
                bridge.popup_tabs.remove(gone);
            }
            dropped
        };
        for gone in dropped {
            self.close_panel_view(gone);
        }
        self.signal.emit(HostTopics::EXTENSIONS);
    }

    fn close_panel_view(&self, engine_tab: EngineTabId) {
        if let Some(side) = self.side() {
            let view = side.borrow_mut().views.remove(&engine_tab);
            drop(view);
        }
        if let Some(engine) = self.engine()
            && let Err(problem) = engine.tab_command(engine_tab, TabCommand::CloseNow)
        {
            log::debug!("the side panel was already gone: {problem}");
        }
    }

    pub(crate) fn shut_side_panel(&self, window: &WindowId) {
        let Some(entry) = self.bridge.lock().side_panels.remove(window) else {
            return;
        };
        for card in &entry.cards {
            self.bridge.lock().popup_tabs.remove(&card.engine_tab);
            self.close_panel_view(card.engine_tab);
        }
        self.signal.emit(HostTopics::EXTENSIONS);
    }

    pub(crate) fn side_panel_wanted(&self, window: &WindowId) -> bool {
        self.bridge.lock().side_panels.contains_key(window)
    }

    pub(crate) fn side_panel_view(
        &self,
        window: &WindowId,
    ) -> Option<ardia_ui::host_data::SidePanelView> {
        let page = self.panel_page(window);
        let stale = self
            .bridge
            .lock()
            .side_panels
            .get(window)
            .is_some_and(|entry| entry.synced_for != page && !entry.sync_queued);
        if stale {
            if let Some(entry) = self.bridge.lock().side_panels.get_mut(window) {
                entry.sync_queued = true;
            }
            let window = window.clone();
            self.post(move |me| {
                if let Some(entry) = me.bridge.lock().side_panels.get_mut(&window) {
                    entry.sync_queued = false;
                }
                me.sync_side_panel(&window);
            });
        }
        let entry = self
            .bridge
            .lock()
            .side_panels
            .get(window)
            .filter(|entry| !entry.hidden && entry.engine_tab.is_some())
            .cloned()?;
        let raw = self.extension_profile(window).and_then(|(profile, _)| {
            self.bridge
                .lock()
                .extension_lists
                .get(&profile)
                .and_then(|items| {
                    items
                        .iter()
                        .find(|(item, _)| item.id == entry.extension_id)
                        .map(|(item, _)| item.clone())
                })
        });
        let item = raw.as_ref();
        let title = item
            .map(|item| {
                if item.action_title.is_empty() {
                    item.name.clone()
                } else {
                    item.action_title.clone()
                }
            })
            .filter(|title| !title.is_empty())
            .unwrap_or_else(|| "Extension".to_owned());
        let view = entry.engine_tab.and_then(|engine_tab| {
            self.side().and_then(|side| {
                side.borrow()
                    .views
                    .get(&engine_tab)
                    .map(ardia_engine::NativeView::handle)
            })
        });
        Some(ardia_ui::host_data::SidePanelView {
            extension_id: entry.extension_id,
            title,
            icon: item.and_then(|item| item.icon.clone()),
            view,
        })
    }

    pub(crate) fn install_prompt_for(
        &self,
        window: &WindowId,
    ) -> Option<ardia_ui::host_data::ExtensionInstallView> {
        let focused = self.store.snapshot().focus_order.first().cloned();
        self.bridge
            .lock()
            .prompts
            .held()
            .into_iter()
            .find_map(|event| match event {
                ardia_engine::EngineEvent::ExtensionInstallPrompt { tab, prompt, .. } => {
                    let owner = tab
                        .and_then(|tab| self.state_tab(tab))
                        .and_then(|tab| self.window_of(&tab))
                        .or_else(|| focused.clone());
                    (owner.as_ref() == Some(window)).then(|| {
                        ardia_ui::host_data::ExtensionInstallView {
                            request_id: prompt.request_id.clone(),
                            name: prompt.name.clone(),
                            kind: prompt.kind.clone(),
                            icon: image_of(&prompt.icon),
                            permissions: prompt.permissions.clone(),
                        }
                    })
                }
                _ => None,
            })
    }

    pub(crate) fn install_dropped_crx(&self, window: &WindowId, path: &str) {
        if self
            .store
            .snapshot()
            .window(window.as_str())
            .is_none_or(|w| w.profile_id.is_incognito())
        {
            return;
        }
        let Some((profile, _)) = self.extension_profile(window) else {
            return;
        };
        let (Some(engine), Some(dir)) = (self.engine(), self.service_profile_dir(&profile)) else {
            return;
        };
        let reply = Services::new(engine.as_ref(), &dir)
            .extensions()
            .install_crx(path);
        let me = self.weak();
        self.spawn(async move {
            let installed = reply.await;
            let Some(me) = me.upgrade() else {
                return;
            };
            match installed {
                Ok(_) => me.extensions_changed(),
                Err(problem) => me.notify(
                    ardia_state::windows::ToastKind::Error,
                    format!("Couldn't add the extension: {problem}"),
                ),
            }
        });
    }

    pub(crate) fn answer_install(&self, request_id: &str, accepted: bool) {
        if let Some(engine) = self.engine()
            && let Err(problem) = engine.resolve_extension_install(request_id, accepted)
        {
            log::warn!("the extension install answer didn't reach the engine: {problem}");
        }
        self.bridge
            .lock()
            .prompts
            .release(&ardia_engine::PromptKey::ExtensionInstall(
                request_id.to_owned(),
            ));
        self.signal.emit(HostTopics::EXTENSIONS);
        if accepted {
            self.extensions_changed();
        }
    }

    pub(crate) fn is_popup_tab(&self, tab: EngineTabId) -> bool {
        self.bridge.lock().popup_tabs.contains_key(&tab)
    }

    pub(crate) fn popup_tab_gone(&self, tab: EngineTabId) {
        let window = self.bridge.lock().popup_tabs.remove(&tab);
        let Some(window) = window else {
            return;
        };
        let removed = {
            let mut bridge = self.bridge.lock();
            let popup = match bridge.popups.get(&window) {
                Some(entry) if entry.engine_tab == tab => bridge.popups.remove(&window).is_some(),
                _ => false,
            };
            let panel = match bridge.side_panels.get_mut(&window) {
                Some(entry) if entry.cards.iter().any(|card| card.engine_tab == tab) => {
                    entry.cards.retain(|card| card.engine_tab != tab);
                    if entry.engine_tab == Some(tab) {
                        entry.engine_tab = None;
                        entry.hidden = true;
                    }
                    if entry.cards.is_empty() {
                        bridge.side_panels.remove(&window);
                    }
                    true
                }
                _ => false,
            };
            popup || panel
        };
        if let Some(side) = self.side() {
            let view = side.borrow_mut().views.remove(&tab);
            drop(view);
        }
        if removed {
            self.signal.emit(HostTopics::EXTENSIONS);
        }
    }

    pub(crate) fn popup_resized(&self, tab: EngineTabId, width: f64, height: f64) {
        let changed = {
            let mut bridge = self.bridge.lock();
            let Some(window) = bridge.popup_tabs.get(&tab).cloned() else {
                return;
            };
            match bridge.popups.get_mut(&window) {
                Some(entry) if width.is_finite() && height.is_finite() => {
                    entry.size = (width as f32, height as f32);
                    entry.sized = true;
                    true
                }
                _ => false,
            }
        };
        if changed {
            self.signal.emit(HostTopics::EXTENSIONS);
        }
    }
}

static EXTENSIONS_LOAD_REPORTED: parking_lot::Mutex<std::collections::BTreeSet<String>> =
    parking_lot::Mutex::new(std::collections::BTreeSet::new());

static EXTENSIONS_KNOWN: parking_lot::Mutex<
    std::collections::BTreeMap<String, std::collections::BTreeSet<String>>,
> = parking_lot::Mutex::new(std::collections::BTreeMap::new());

const EXTENSION_DISABLE_REASONS: [(&str, &str); 9] = [
    ("user", "disabled_user"),
    ("permissions", "disabled_permissions"),
    ("corrupted", "disabled_corrupted"),
    ("developer", "disabled_developer"),
    ("unsupported", "disabled_unsupported"),
    ("policy", "disabled_policy"),
    ("external", "disabled_external"),
    ("reload", "disabled_reload"),
    ("other", "disabled_other"),
];

const ICLOUD_PASSWORDS_IDS: [&str; 2] = [
    "pejdijmoenmkgeppbflobdenhhabjlaj",
    "mfbcdcnpokpoajjciilocoachedjkima",
];

fn note_extensions_loaded(
    health: &Value,
    default_profile: bool,
    consent: Option<&ardia_telemetry::Consent>,
) {
    let count = |value: Option<&Value>| value.and_then(Value::as_u64).unwrap_or(0);
    let mut props = serde_json::Map::new();
    props.insert(
        "profile_kind".into(),
        json!(if default_profile { "default" } else { "other" }),
    );
    props.insert("dropped".into(), json!(count(health.get("dropped"))));
    props.insert("enabled".into(), json!(count(health.get("enabled"))));
    for (reason, field) in EXTENSION_DISABLE_REASONS {
        props.insert(
            field.into(),
            json!(count(health.pointer(&format!("/disabled/{reason}")))),
        );
    }
    ardia_telemetry::capture_for("extensions_loaded", props, consent);
}

fn note_extensions_installed(profile: &ProfileId, listed: &[ExtensionItem]) {
    let ids: std::collections::BTreeSet<String> =
        listed.iter().map(|item| item.id.clone()).collect();
    let before = EXTENSIONS_KNOWN
        .lock()
        .insert(profile.as_str().to_owned(), ids.clone());
    let Some(before) = before else {
        return;
    };
    for id in ids.difference(&before) {
        let mut props = serde_json::Map::new();
        if ICLOUD_PASSWORDS_IDS.contains(&id.as_str()) {
            props.insert("icloud_passwords".into(), json!(true));
            props.insert(
                "apple_helper_allowed".into(),
                json!(crate::webkit::passkeys::entitled()),
            );
        }
        ardia_telemetry::capture("extension_installed", props);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lists_parse_leniently_and_keep_private_windows_to_allowed_extensions() {
        let reply = json!({"extensions": [
            {"id": "a", "name": "Alpha", "enabled": true, "pinned": true, "pinnedIndex": 2, "incognito": true,
             "icon": "data:image/png;base64,iVBORw0KGgo="},
            {"id": "b", "enabled": false, "pinned": "yes"},
            {"name": "no id"},
            "garbage"
        ]});
        let all = parse_list(&reply, false);
        assert_eq!(all.len(), 2);
        assert_eq!(all[0].name, "Alpha");
        assert_eq!(all[0].pinned_index, Some(2));
        assert!(all[0].icon.is_some());
        assert_eq!(all[1].name, "b");
        assert!(!all[1].pinned);
        assert_eq!(parse_list(&reply, true).len(), 1);
        assert!(parse_list(&json!("nonsense"), false).is_empty());
    }

    #[test]
    fn action_states_add_badges_titles_and_popups() {
        let items = vec![ExtensionItem {
            id: "a".into(),
            name: "Alpha".into(),
            ..ExtensionItem::default()
        }];
        let mut states = ExtensionActionStates::new();
        states.insert(
            "a".into(),
            ardia_engine::ExtensionActionState {
                title: "Alpha on this page".into(),
                badge_text: "12345".into(),
                popup: Some(json!("chrome-extension://a/popup.html")),
                ..Default::default()
            },
        );
        let merged = with_action_states(&items, &states);
        assert_eq!(merged[0].badge, "1234");
        assert_eq!(merged[0].tooltip(), "Alpha on this page");
        assert_eq!(
            popup_url(&states, "a").as_deref(),
            Some("chrome-extension://a/popup.html")
        );
        states.get_mut("a").unwrap().popup = Some(json!("javascript:alert(1)"));
        assert_eq!(popup_url(&states, "a"), None);
    }
}
