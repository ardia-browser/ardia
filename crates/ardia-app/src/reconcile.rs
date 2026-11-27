use std::collections::HashSet;
use std::sync::Arc;

use ardia_engine::{
    Adoption, BrowserEngine, EngineError, EngineProfileId, EngineTabId, EngineWindowId, OpenTab,
    Rect, Reply,
};
use ardia_state::actions::{Action, PageUpdate};
use ardia_state::model::PageKind;
use ardia_state::windows::{BrowserWindow, WindowKind};
use ardia_state::{BrowserState, ProfileId, TabId, WindowId};
use ardia_ui::UtilityWindowKind;
use serde_json::{Value, json};

use crate::coordinator::{AppCoordinator, Applied, HostedWindow, ShellEffect};

const PROFILE_ATTEMPTS: u32 = 3;
const WINDOW_ATTEMPTS: u32 = 2;

fn frame_rect(window: &BrowserWindow, fallback: Rect) -> Rect {
    window
        .frame
        .filter(|frame| frame.is_valid())
        .map_or(fallback, |frame| {
            Rect::new(frame.x, frame.y, frame.width, frame.height)
        })
}

fn little_ardia_frame(saved: [f64; 2]) -> Rect {
    let [width, height] = saved;
    let fallback = ardia_theme::layout::LITTLE_ARDIA_DEFAULT_SIZE;
    let side = |value: f64, default: f32| {
        if value.is_finite() && value > 0.0 {
            value
        } else {
            f64::from(default)
        }
    };
    Rect::new(
        0.0,
        0.0,
        side(width, fallback[0]),
        side(height, fallback[1]),
    )
}

fn utility_kind(kind: WindowKind) -> Option<UtilityWindowKind> {
    match kind {
        WindowKind::Settings => Some(UtilityWindowKind::Settings),
        WindowKind::Import => Some(UtilityWindowKind::Import),
        WindowKind::Onboarding => Some(UtilityWindowKind::Onboarding),
        _ => None,
    }
}

pub fn shown_tabs(state: &BrowserState, window: &BrowserWindow) -> Vec<TabId> {
    let Some(active) = window.active_tab().filter(|tab| {
        state
            .tab(tab.as_str())
            .is_some_and(|t| t.window_id == window.id && !t.live.peek)
    }) else {
        return Vec::new();
    };
    let mut shown = vec![active.clone()];
    if let Some(split) = state.split_of(active.as_str()) {
        for pane in split.tab_ids() {
            if !shown.contains(&pane) && state.tab(pane.as_str()).is_some() {
                shown.push(pane);
            }
        }
    }
    if let Some(peek) = state.shown_peek(window.id.as_str())
        && !shown.contains(&peek.tab_id)
    {
        shown.push(peek.tab_id.clone());
    }
    shown
}

pub fn hidden_pages(state: &BrowserState, window: &BrowserWindow, shown: &[TabId]) -> Vec<TabId> {
    window
        .tab_ids
        .iter()
        .filter(|tab| !shown.contains(tab))
        .filter(|tab| {
            state.tab(tab.as_str()).is_some_and(|t| {
                t.window_id == window.id && crate::tab_lifecycle::keeps_hidden_page(t)
            })
        })
        .cloned()
        .collect()
}

impl AppCoordinator {
    pub(crate) fn reconcile(&self) {
        let Some(engine) = self.engine() else {
            return;
        };
        if !engine.is_started() || self.is_shutting_down() {
            return;
        }
        let state = self.store().snapshot();
        self.open_new_windows(&state, &engine);
        self.take_in_strays(&state, &engine);
        self.adopt_moved_tabs(&state, &engine);
        self.close_vanished_tabs(&state, &engine);
        self.close_vanished_windows(&state, &engine);
        if crate::webkit::page::set_fraud_warnings(state.settings.webkit_fraud_warnings) {
            log::info!(
                "WebKit fraud warnings are {}",
                if state.settings.webkit_fraud_warnings {
                    "on"
                } else {
                    "off"
                }
            );
        }
        self.reconcile_webkit(&self.store().snapshot());
        let state = self.store().snapshot();
        self.bridge.lock().lifecycle.begin_pass();
        for window in state
            .window_order
            .iter()
            .filter_map(|id| state.window(id.as_str()))
        {
            if window.kind.has_tabs() {
                self.show_window_tabs(&state, window, &engine);
            }
        }
        self.bridge.lock().lifecycle.end_pass();
        self.release_closed_hidden_pages();
        let state = self.store().snapshot();
        self.apply_tab_settings(&state, &engine);
        self.apply_auto_pip(state.settings.auto_picture_in_picture, &engine);
        self.apply_video_upscaling(state.settings.video_upscaling, &engine);
        self.sync_global_hotkey();
        self.apply_command_scroll_zoom(state.settings.command_scroll_zoom);
    }

    fn open_new_windows(&self, state: &BrowserState, engine: &Arc<dyn BrowserEngine>) {
        for window in state
            .window_order
            .iter()
            .filter_map(|id| state.window(id.as_str()))
        {
            if let Some(kind) = utility_kind(window.kind) {
                let fresh = self.bridge.lock().gpui_requested.insert(window.id.clone());
                if fresh {
                    self.effect(ShellEffect::OpenUtility(kind));
                }
                continue;
            }
            if !window.kind.has_tabs() || self.engine_window(&window.id).is_some() {
                continue;
            }
            let failures = self
                .bridge
                .lock()
                .window_failures
                .get(&window.id)
                .copied()
                .unwrap_or(0);
            if failures >= WINDOW_ATTEMPTS {
                continue;
            }
            let fallback = if window.kind == WindowKind::LittleArdia {
                little_ardia_frame(state.settings.little_ardia_size)
            } else {
                self.config.default_frame
            };
            match engine.create_window(frame_rect(window, fallback)) {
                Ok(engine_window) => {
                    self.bridge
                        .lock()
                        .windows
                        .insert(window.id.clone(), engine_window);
                    self.open_gpui_window(&window.id, window.kind, engine_window);
                }
                Err(problem) => {
                    log::warn!("{} has no engine window: {problem}", window.id);
                    *self
                        .bridge
                        .lock()
                        .window_failures
                        .entry(window.id.clone())
                        .or_default() += 1;
                    if failures + 1 >= WINDOW_ATTEMPTS {
                        self.request_gpui_window(&window.id, window.kind, None);
                    }
                }
            }
        }
    }

    pub(crate) fn open_gpui_window(
        &self,
        window: &WindowId,
        kind: WindowKind,
        engine_window: EngineWindowId,
    ) {
        let host = if self.config.hosts_native_windows {
            self.retain_host(engine_window)
        } else {
            None
        };
        if kind == WindowKind::LittleArdia
            && let Some(native) = self.hosted_native_window(engine_window)
        {
            crate::acted_full_screen::join_full_screen_spaces(native.handle());
        }
        self.request_gpui_window(window, kind, host);
    }

    pub(crate) fn hosted_native_window(
        &self,
        engine_window: EngineWindowId,
    ) -> Option<ardia_engine::NativeWindow> {
        if !self.config.hosts_native_windows {
            return None;
        }
        self.engine()?.native_window_handle(engine_window).ok()
    }

    fn request_gpui_window(&self, window: &WindowId, kind: WindowKind, host: Option<HostedWindow>) {
        let fresh = {
            let mut bridge = self.bridge.lock();
            !bridge.gpui.contains_key(window) && bridge.gpui_requested.insert(window.clone())
        };
        if fresh {
            self.effect(ShellEffect::OpenBrowserWindow {
                window: window.clone(),
                kind,
                host,
            });
        }
    }

    fn retain_host(&self, engine_window: EngineWindowId) -> Option<HostedWindow> {
        let engine = self.engine()?;
        let side = self.side()?;
        let native = engine.native_window_handle(engine_window).ok()?;
        let view = engine.window_host_view(engine_window).ok()?;
        let host = HostedWindow {
            window: native.handle().as_ptr() as usize,
            view: view.handle().as_ptr() as usize,
        };
        if host.window == 0 || host.view == 0 {
            return None;
        }
        side.borrow_mut()
            .hosted
            .insert(engine_window, (native, view));
        Some(host)
    }

    fn take_in_strays(&self, state: &BrowserState, engine: &Arc<dyn BrowserEngine>) {
        let strays: Vec<(WindowId, EngineTabId)> = self
            .bridge
            .lock()
            .strays
            .iter()
            .map(|(window, tab)| (window.clone(), *tab))
            .collect();
        for (window, stray) in strays {
            if state.window(window.as_str()).is_none() {
                let mut bridge = self.bridge.lock();
                bridge.strays.remove(&window);
                bridge.closing_tabs.insert(stray);
                drop(bridge);
                let _ = engine.close_now(stray);
                continue;
            }
            let Some(engine_window) = self.engine_window(&window) else {
                continue;
            };
            let adoption = engine.adopt_tab(engine_window, stray);
            if matches!(adoption, Ok(Adoption::Busy)) {
                self.mark_dirty();
                continue;
            }
            let placeholder = {
                let mut bridge = self.bridge.lock();
                bridge.strays.remove(&window);
                bridge.placeholders.remove(&window)
            };
            match (adoption, placeholder) {
                (Ok(Adoption::Adopted), Some(placeholder)) => {
                    self.bind_tab(&placeholder, stray, &window)
                }
                (Ok(Adoption::Adopted), None) => {}
                _ => {
                    log::info!(
                        "a private page couldn't move to its private window, so it reloads there"
                    );
                    self.bridge.lock().closing_tabs.insert(stray);
                    let _ = engine.close_now(stray);
                    self.mark_dirty();
                }
            }
        }
    }

    fn adopt_moved_tabs(&self, state: &BrowserState, engine: &Arc<dyn BrowserEngine>) {
        let moved: Vec<(TabId, EngineTabId, WindowId)> = {
            let bridge = self.bridge.lock();
            bridge
                .tabs
                .iter()
                .filter_map(|(tab, engine_tab)| {
                    let listed = state.tab(tab.as_str())?;
                    let home = bridge.tab_homes.get(tab)?;
                    (*home != listed.window_id)
                        .then(|| (tab.clone(), *engine_tab, listed.window_id.clone()))
                })
                .collect()
        };
        for (tab, engine_tab, target) in moved {
            let Some(engine_window) = self.engine_window(&target) else {
                continue;
            };
            match engine.adopt_tab(engine_window, engine_tab) {
                Ok(Adoption::Adopted) => {
                    self.bridge.lock().tab_homes.insert(tab, target);
                }
                Ok(Adoption::Busy) => self.mark_dirty(),
                Ok(Adoption::Refused) | Err(_) => {
                    log::info!(
                        "{tab} couldn't move with its page, so it reloads in its new window"
                    );
                    self.retire_engine_tab(&tab, engine_tab, engine);
                }
            }
        }
    }

    pub(crate) fn retire_engine_tab(
        &self,
        tab: &TabId,
        engine_tab: EngineTabId,
        engine: &Arc<dyn BrowserEngine>,
    ) {
        self.unbind_tab(tab);
        let confirmed = {
            let mut bridge = self.bridge.lock();
            bridge.closing_tabs.insert(engine_tab);
            bridge.leave_confirmed.remove(&engine_tab)
        };
        let closed = if confirmed {
            engine.close_now(engine_tab)
        } else {
            engine.close(engine_tab)
        };
        if let Err(problem) = closed
            && !problem.is_gone()
        {
            log::warn!("{tab}'s old page didn't close: {problem}");
        }
    }

    fn close_vanished_tabs(&self, state: &BrowserState, engine: &Arc<dyn BrowserEngine>) {
        let gone: Vec<(TabId, EngineTabId)> = {
            let bridge = self.bridge.lock();
            bridge
                .tabs
                .iter()
                .filter(|(tab, _)| state.tab(tab.as_str()).is_none())
                .map(|(tab, engine_tab)| (tab.clone(), *engine_tab))
                .collect()
        };
        for (tab, engine_tab) in gone {
            self.retire_engine_tab(&tab, engine_tab, engine);
        }
        let mut bridge = self.bridge.lock();
        bridge
            .pending_tabs
            .retain(|tab| state.tab(tab.as_str()).is_some());
        bridge
            .closing_rows
            .retain(|tab| state.tab(tab.as_str()).is_some());
        let stale: Vec<TabId> = bridge
            .prompts
            .tabs()
            .into_iter()
            .filter(|tab| state.tab(tab.as_str()).is_none())
            .collect();
        for tab in &stale {
            bridge.prompts.forget_tab(tab);
            bridge.site.forget_tab(tab);
        }
        let ended = bridge
            .translate
            .forget_missing(|tab| state.tab(tab.as_str()).is_some());
        drop(bridge);
        if !ended.is_empty() {
            self.cancel_translations(ended);
        }
    }

    fn close_vanished_windows(&self, state: &BrowserState, engine: &Arc<dyn BrowserEngine>) {
        let gone: Vec<(WindowId, EngineWindowId)> = {
            let bridge = self.bridge.lock();
            bridge
                .windows
                .iter()
                .filter(|(window, _)| state.window(window.as_str()).is_none())
                .map(|(window, engine_window)| (window.clone(), *engine_window))
                .collect()
        };
        for (window, engine_window) in gone {
            let homed: Vec<TabId> = {
                let bridge = self.bridge.lock();
                bridge
                    .tab_homes
                    .iter()
                    .filter(|(_, home)| **home == window)
                    .map(|(tab, _)| tab.clone())
                    .collect()
            };
            for tab in &homed {
                self.unbind_tab(tab);
            }
            {
                let mut bridge = self.bridge.lock();
                bridge.windows.remove_left(&window);
                bridge.closing_windows.insert(engine_window);
                bridge.engine_active.remove(&window);
                bridge.shown.remove(&window);
                bridge.window_profiles.remove(&window);
                bridge.placeholders.remove(&window);
                bridge.gpui_requested.remove(&window);
            }
            if let Err(problem) = engine.close_window(engine_window)
                && !problem.is_gone()
            {
                log::warn!("{window}'s engine window didn't close: {problem}");
            }
            self.forget_hidden_page_shelf(engine_window);
            self.forget_hosted(engine_window);
            self.effect(ShellEffect::CloseWindow { window });
        }
        let utilities: Vec<WindowId> = {
            let bridge = self.bridge.lock();
            bridge
                .gpui_requested
                .iter()
                .filter(|window| state.window(window.as_str()).is_none())
                .filter(|window| bridge.windows.by_left(window).is_none())
                .cloned()
                .collect()
        };
        let mut bridge = self.bridge.lock();
        for window in utilities {
            if !bridge.gpui.contains_key(&window) {
                bridge.gpui_requested.remove(&window);
            }
        }
        let open_private = |profile: &ProfileId| {
            state
                .windows
                .values()
                .any(|window| &window.profile_id == profile)
        };
        bridge.profiles.retain_private(open_private);
        bridge
            .profile_paths
            .retain(|profile, _| !profile.is_incognito() || open_private(profile));
        bridge
            .profile_failures
            .retain(|profile, _| !profile.is_incognito() || open_private(profile));
    }

    fn show_window_tabs(
        &self,
        state: &BrowserState,
        window: &BrowserWindow,
        engine: &Arc<dyn BrowserEngine>,
    ) {
        let Some(engine_window) = self.engine_window(&window.id) else {
            return;
        };
        let Some(profile) = self.resolve_profile(&window.profile_id) else {
            return;
        };
        let set = self.bridge.lock().window_profiles.get(&window.id) != Some(&window.profile_id);
        if set {
            match engine.set_active_profile(engine_window, Some(profile)) {
                Ok(()) => {
                    self.bridge
                        .lock()
                        .window_profiles
                        .insert(window.id.clone(), window.profile_id.clone());
                }
                Err(problem) => log::warn!("{} couldn't show its profile: {problem}", window.id),
            }
        }
        let wanted = shown_tabs(state, window);
        let mut live: Vec<(TabId, EngineTabId)> = Vec::new();
        for tab in &wanted {
            if !self.new_tab_page_ready(state, window, tab) {
                continue;
            }
            if let Some(engine_tab) =
                self.materialize(state, tab, &window.id, engine_window, engine)
            {
                live.push((tab.clone(), engine_tab));
            }
        }
        let active = window
            .active_tab()
            .and_then(|tab| live.iter().find(|(shown, _)| shown == tab))
            .map(|(_, engine_tab)| *engine_tab);
        if let Some(engine_tab) = active {
            let current = self.bridge.lock().engine_active.get(&window.id).copied();
            if current != Some(engine_tab) {
                match engine.activate_tab(engine_window, engine_tab) {
                    Ok(()) => {
                        self.bridge
                            .lock()
                            .engine_active
                            .insert(window.id.clone(), engine_tab);
                        if let Some(tab) = window.active_tab() {
                            self.note_front_tab(&window.id, tab);
                        }
                    }
                    Err(problem) => log::debug!("{} couldn't show its tab: {problem}", window.id),
                }
            }
        }
        let shown_now: Vec<TabId> = live.iter().map(|(tab, _)| tab.clone()).collect();
        let before = self
            .bridge
            .lock()
            .shown
            .insert(window.id.clone(), shown_now.clone())
            .unwrap_or_default();
        for (tab, engine_tab) in &live {
            if !before.contains(tab) {
                let _ = engine.note_shown(*engine_tab, true);
                let _ = engine.tab_command(*engine_tab, ardia_engine::TabCommand::LoadIfNeeded);
            }
        }
        for tab in before.iter().filter(|tab| !shown_now.contains(tab)) {
            self.note_tab_left_screen(tab);
            if let Some(engine_tab) = self.engine_tab(tab) {
                let _ = engine.note_shown(engine_tab, false);
                let _ =
                    engine.tab_command(engine_tab, ardia_engine::TabCommand::ExitExclusiveAccess);
            }
        }
        for tab in hidden_pages(state, window, &wanted) {
            if self.engine_tab(&tab).is_some() {
                continue;
            }
            let first = state
                .tab(tab.as_str())
                .is_some_and(|listed| self.strip_is_empty(state, &window.id, &listed.profile_id));
            if let Some(engine_tab) =
                self.materialize(state, &tab, &window.id, engine_window, engine)
            {
                let _ = engine.note_shown(engine_tab, false);
                self.park_hidden_page(engine_window, engine_tab, first);
            }
        }
    }

    pub(crate) fn resolve_profile(&self, profile: &ProfileId) -> Option<EngineProfileId> {
        if let Some(known) = self.engine_profile(profile) {
            return Some(known);
        }
        {
            let bridge = self.bridge.lock();
            if bridge.profile_waits.contains(profile)
                || bridge.profile_failures.get(profile).copied().unwrap_or(0) >= PROFILE_ATTEMPTS
            {
                return None;
            }
        }
        let engine = self.engine()?;
        let reply: Reply<EngineProfileId> = if profile.is_incognito() {
            let original = self.resolve_profile(&profile.incognito_original())?;
            engine.off_the_record_profile(original)
        } else {
            let folder = self.store().snapshot().engine_profile(profile);
            let wanted = chromium_profile_folder(&folder);
            let startup = engine.default_profile().ok().filter(|id| {
                engine.profile_info(*id).is_ok_and(|info| {
                    std::path::Path::new(&info.path)
                        .file_name()
                        .is_some_and(|name| name == wanted.as_str())
                })
            });
            if let Some(id) = startup {
                self.bridge.lock().profiles.insert(profile.clone(), id);
                self.content_blocker_profile_loaded(profile, id);
                return Some(id);
            }
            engine.load_profile(&wanted)
        };
        self.bridge.lock().profile_waits.insert(profile.clone());
        let me = self.weak();
        let wanted = profile.clone();
        self.spawn(async move {
            let result = reply.await;
            if let Some(me) = me.upgrade() {
                me.profile_ready(&wanted, result);
            }
        });
        self.engine_profile(profile)
    }

    pub fn service_profile_dir(&self, profile: &ProfileId) -> Option<String> {
        if let Some(path) = self.bridge.lock().profile_paths.get(profile) {
            return Some(path.clone());
        }
        let engine_profile = self.engine_profile(profile)?;
        let path = self.engine()?.profile_info(engine_profile).ok()?.path;
        if path.is_empty() {
            return None;
        }
        self.bridge
            .lock()
            .profile_paths
            .insert(profile.clone(), path.clone());
        Some(path)
    }

    pub(crate) fn profile_ready(
        &self,
        profile: &ProfileId,
        result: Result<EngineProfileId, EngineError>,
    ) {
        self.bridge.lock().profile_waits.remove(profile);
        match result {
            Ok(id) => {
                self.bridge.lock().profiles.insert(profile.clone(), id);
                self.content_blocker_profile_loaded(profile, id);
                self.mark_dirty();
                self.note_profile_loaded(profile);
            }
            Err(problem) => self.profile_failed(profile, &problem),
        }
    }

    fn profile_failed(&self, profile: &ProfileId, problem: &EngineError) {
        log::warn!("{profile} didn't load in the engine: {problem}");
        *self
            .bridge
            .lock()
            .profile_failures
            .entry(profile.clone())
            .or_default() += 1;
        self.mark_dirty();
    }

    fn materialize(
        &self,
        state: &BrowserState,
        tab: &TabId,
        window: &WindowId,
        engine_window: EngineWindowId,
        engine: &Arc<dyn BrowserEngine>,
    ) -> Option<EngineTabId> {
        if state
            .tab(tab.as_str())
            .is_some_and(|t| matches!(t.page.kind, PageKind::Frozen { .. }))
        {
            return None;
        }
        if self.materialize_webkit(state, tab) {
            return None;
        }
        if let Some(known) = self.engine_tab(tab) {
            return Some(known);
        }
        {
            let bridge = self.bridge.lock();
            if bridge.pending_tabs.contains(tab)
                || bridge.closing_rows.contains(tab)
                || bridge.placeholders.get(window) == Some(tab)
            {
                return None;
            }
        }
        let listed = state.tab(tab.as_str())?;
        let profile = self.resolve_profile(&listed.profile_id)?;
        let restore = listed
            .page
            .pending_restore()
            .filter(|_| !listed.is_incognito())
            .map(str::to_owned);
        if let Some(key) = restore {
            self.restore_through_engine(tab, &key, &listed.profile_id, engine);
            return None;
        }
        if self.restore_saved_history(listed, engine) {
            return None;
        }
        let url = listed
            .live
            .navigation
            .clone()
            .unwrap_or_else(|| listed.url.clone());
        let internal = ardia_ui::InternalPage::of(&url);
        let url = if internal.is_some() {
            String::new()
        } else {
            url
        };
        match engine.open_tab(
            engine_window,
            OpenTab {
                url,
                profile,
                foreground: false,
            },
        ) {
            Ok(engine_tab) => {
                self.bind_tab(tab, engine_tab, window);
                self.note_page_opened(listed);
                self.tag_for_restore(tab, engine_tab, &listed.profile_id, engine);
                if let Some(page) = internal {
                    self.show_internal_page(tab, &page);
                }
                Some(engine_tab)
            }
            Err(problem) => {
                log::warn!("{tab} couldn't open its page: {problem}");
                None
            }
        }
    }

    fn restore_through_engine(
        &self,
        tab: &TabId,
        key: &str,
        profile: &ProfileId,
        engine: &Arc<dyn BrowserEngine>,
    ) {
        let Some(folder) = self.service_profile_dir(profile) else {
            return;
        };
        self.bridge.lock().pending_tabs.insert(tab.clone());
        let reply = engine.call_service(
            "ac_tab_restore_take",
            &folder,
            &json!({ "key": key }).to_string(),
        );
        let me = self.weak();
        let tab = tab.clone();
        self.spawn(async move {
            let saved = reply.await;
            if let Some(me) = me.upgrade() {
                me.finish_restore(&tab, saved.ok());
            }
        });
    }

    pub(crate) fn finish_restore(&self, tab: &TabId, saved: Option<Value>) {
        self.bridge.lock().pending_tabs.remove(tab);
        let state = self.store().snapshot();
        let (Some(listed), Some(engine)) = (state.tab(tab.as_str()), self.engine()) else {
            return;
        };
        if self.engine_tab(tab).is_some() || !engine.is_started() {
            return;
        }
        let (Some(engine_window), Some(profile)) = (
            self.engine_window(&listed.window_id),
            self.engine_profile(&listed.profile_id),
        ) else {
            self.mark_dirty();
            return;
        };
        let state_text = saved
            .as_ref()
            .and_then(|value| value.get("state"))
            .and_then(Value::as_str)
            .filter(|text| !text.is_empty());
        let into_empty_strip = self.strip_is_empty(&state, &listed.window_id, &listed.profile_id);
        let restored = state_text
            .and_then(|text| {
                engine
                    .restore_tab(engine_window, Some(text), profile, false)
                    .ok()
            })
            .flatten();
        if let Some(engine_tab) = restored {
            let _ = engine.tab_command(engine_tab, ardia_engine::TabCommand::LoadIfNeeded);
        }
        let navigation = listed.live.navigation.clone().filter(|url| !url.is_empty());
        let internal = ardia_ui::InternalPage::of(navigation.as_deref().unwrap_or(&listed.url));
        let navigation = navigation.filter(|_| internal.is_none());
        let engine_tab = match restored {
            Some(engine_tab) => {
                if let Some(url) = navigation.as_deref()
                    && let Err(problem) = engine.load_url(engine_tab, url, true)
                {
                    log::warn!("{tab} couldn't load {url} after it was restored: {problem}");
                }
                Some(engine_tab)
            }
            None => engine
                .open_tab(
                    engine_window,
                    OpenTab {
                        url: match internal {
                            Some(_) => String::new(),
                            None => navigation.unwrap_or_else(|| listed.url.clone()),
                        },
                        profile,
                        foreground: false,
                    },
                )
                .ok(),
        };
        if let Some(engine_tab) = engine_tab {
            self.bind_tab(tab, engine_tab, &listed.window_id);
            let hidden = state
                .window(listed.window_id.as_str())
                .is_none_or(|window| !shown_tabs(&state, window).contains(tab));
            if hidden {
                let _ = engine.note_shown(engine_tab, false);
                self.park_hidden_page(
                    engine_window,
                    engine_tab,
                    into_empty_strip && restored.is_none(),
                );
            }
            self.tag_for_restore(tab, engine_tab, &listed.profile_id, &engine);
            if let Some(page) = internal.as_ref() {
                self.show_internal_page(tab, page);
            }
        }
        self.mark_dirty();
    }

    fn tag_for_restore(
        &self,
        tab: &TabId,
        engine_tab: EngineTabId,
        profile: &ProfileId,
        engine: &Arc<dyn BrowserEngine>,
    ) {
        if profile.is_incognito() {
            return;
        }
        self.bridge
            .lock()
            .lifecycle
            .history_bound
            .insert(tab.clone());
        let Ok(info) = engine.tab_info(engine_tab) else {
            return;
        };
        let state = self.store().snapshot();
        let key = state
            .tab(tab.as_str())
            .and_then(|t| t.page.pending_restore().map(str::to_owned))
            .unwrap_or_else(|| tab.to_string());
        let Some(folder) = self.service_profile_dir(profile) else {
            return;
        };
        let reply = engine.call_service(
            "ac_tab_restore_tag",
            &folder,
            &json!({ "tab": info.tab_id, "key": key }).to_string(),
        );
        self.spawn(async move {
            if let Err(problem) = reply.await {
                log::debug!("the page couldn't be tagged for reopening: {problem}");
            }
        });
    }

    pub(crate) fn bind_tab(&self, tab: &TabId, engine_tab: EngineTabId, window: &WindowId) {
        {
            let mut bridge = self.bridge.lock();
            bridge.tabs.insert(tab.clone(), engine_tab);
            bridge.tab_homes.insert(tab.clone(), window.clone());
            bridge.applied.entry(tab.clone()).or_default();
            bridge.pending_tabs.remove(tab);
        }
        self.note_tab_had_page(tab);
        self.dispatch_quietly(Action::UpdatePage {
            tab: tab.clone(),
            update: PageUpdate {
                engine_tab_id: Some(Some(engine_tab.to_string())),
                ..PageUpdate::default()
            },
        });
        self.mark_dirty();
    }

    pub(crate) fn unbind_tab(&self, tab: &TabId) {
        let engine_tab = {
            let mut bridge = self.bridge.lock();
            let engine_tab = bridge.tabs.remove_left(tab);
            bridge.tab_homes.remove(tab);
            bridge.applied.remove(tab);
            bridge.icon_themes.remove(tab);
            bridge.icon_urls.remove(tab);
            bridge.favicon_pages.remove(tab);
            bridge.readers.remove(tab);
            bridge.devtools_open.remove(tab);
            bridge.pending_tabs.remove(tab);
            for shown in bridge.shown.values_mut() {
                shown.retain(|known| known != tab);
            }
            if let Some(engine_tab) = engine_tab {
                bridge
                    .engine_active
                    .retain(|_, active| *active != engine_tab);
            }
            engine_tab
        };
        if let Some(engine_tab) = engine_tab
            && let Some(side) = self.side()
        {
            let (view, devtools) = {
                let mut side = side.borrow_mut();
                (
                    side.views.remove(&engine_tab),
                    side.devtools.remove(&engine_tab),
                )
            };
            drop((view, devtools));
        }
        if engine_tab.is_some() && self.store().snapshot().tab(tab.as_str()).is_some() {
            self.dispatch_quietly(Action::UpdatePage {
                tab: tab.clone(),
                update: PageUpdate {
                    engine_tab_id: Some(None),
                    loading: Some(false),
                    ..PageUpdate::default()
                },
            });
        }
    }

    pub(crate) fn duplicate_in_engine(&self, source: &TabId, copy: &TabId) {
        let state = self.store().snapshot();
        let (Some(listed), Some(engine)) = (state.tab(copy.as_str()), self.engine()) else {
            return;
        };
        let (Some(source_tab), Some(engine_window), Some(profile)) = (
            self.engine_tab(source),
            self.engine_window(&listed.window_id),
            self.engine_profile(&listed.profile_id),
        ) else {
            return;
        };
        match engine.duplicate_tab(engine_window, source_tab, profile, false) {
            Ok(Some(engine_tab)) => self.bind_tab(copy, engine_tab, &listed.window_id),
            Ok(None) => log::debug!("the engine didn't copy {source}'s history"),
            Err(problem) => log::warn!("{source} couldn't be copied: {problem}"),
        }
    }

    fn apply_tab_settings(&self, state: &BrowserState, engine: &Arc<dyn BrowserEngine>) {
        let mapped: Vec<(TabId, EngineTabId, Applied)> = {
            let bridge = self.bridge.lock();
            bridge
                .tabs
                .iter()
                .map(|(tab, engine_tab)| {
                    (
                        tab.clone(),
                        *engine_tab,
                        bridge.applied.get(tab).copied().unwrap_or_default(),
                    )
                })
                .collect()
        };
        let shown: HashSet<TabId> = self
            .bridge
            .lock()
            .shown
            .values()
            .flatten()
            .cloned()
            .collect();
        for (tab, engine_tab, applied) in mapped {
            let Some(listed) = state.tab(tab.as_str()) else {
                continue;
            };
            let mut next = applied;
            let silenced = ardia_state::mute::silenced(state, listed);
            if silenced != applied.muted && engine.set_muted(engine_tab, silenced).is_ok() {
                next.muted = silenced;
            }
            if (listed.zoom - applied.zoom).abs() > 1e-6
                && engine.set_zoom(engine_tab, listed.zoom).is_ok()
            {
                next.zoom = listed.zoom;
            }
            let pinned = listed.is_pinned();
            if pinned != applied.pinned
                && let Some(engine_window) = self.engine_window(&listed.window_id)
            {
                let index = state
                    .profile_index(&listed.window_id, &listed.profile_id, &tab)
                    .unwrap_or(0);
                if engine
                    .place_tab(engine_window, engine_tab, index as i32, pinned)
                    .is_ok()
                {
                    next.pinned = pinned;
                }
            }
            let asleep = matches!(listed.page.kind, PageKind::Asleep | PageKind::Frozen { .. })
                && !shown.contains(&tab);
            let mut stays_asleep = asleep;
            if asleep && !applied.asleep {
                if listed.page.kind == PageKind::Asleep {
                    stays_asleep = self.sleep_when_asked(listed, engine_tab, engine);
                } else {
                    let _ = engine.discard(engine_tab);
                }
            }
            next.asleep = stays_asleep;
            if next != applied {
                self.bridge.lock().applied.insert(tab, next);
            }
        }
    }
}

pub fn chromium_profile_folder(engine_profile: &str) -> String {
    if engine_profile.is_empty() {
        "Default".to_owned()
    } else if engine_profile == "Default" || engine_profile.starts_with("Profile ") {
        engine_profile.to_owned()
    } else {
        format!("Profile {engine_profile}")
    }
}

#[cfg(test)]
mod little_frame_tests {
    use super::*;

    #[test]
    fn little_ardia_engine_windows_open_at_the_saved_size() {
        let frame = little_ardia_frame([900.0, 640.0]);
        assert_eq!((frame.width, frame.height), (900.0, 640.0));
        let broken = little_ardia_frame([f64::NAN, -4.0]);
        assert_eq!((broken.width, broken.height), (900.0, 640.0));
    }
}
