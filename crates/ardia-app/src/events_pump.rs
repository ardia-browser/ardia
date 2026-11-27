use std::collections::{HashMap, VecDeque};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Weak};
use std::time::Duration;

use ardia_engine::{
    BrowserEngine, DownloadEvent, DownloadItem, EngineEvent, EngineProfileId, EngineTabId,
    EngineWindowId, EventSubscription, NewBrowserKind, PromptKey, SecurityLevel, TabInfo,
};
use ardia_state::actions::{Action, NewTab, PageUpdate};
use ardia_state::downloads::{Download, DownloadState};
use ardia_state::tabs::{FindState, SecurityState};
use ardia_state::windows::{Popover, Toast, ToastKind, WindowKind};
use ardia_state::{BrowserStore, DownloadId, TabId, WindowId};
use ardia_theme::RgbaColor;
use parking_lot::Mutex;

use crate::coordinator::{AppCoordinator, Owner, ShellEffect};
use crate::favicons;
use crate::maps::ProfileOwner;

pub const SHUTDOWN_FLUSH: Duration = Duration::from_secs(2);

type Ready = Arc<dyn Fn() + Send + Sync>;

pub struct EngineFeed {
    subscription: EventSubscription,
    inbox: Mutex<VecDeque<EngineEvent>>,
    ready: Mutex<Option<Ready>>,
    store: Arc<BrowserStore>,
    shutting_down: Arc<AtomicBool>,
}

impl std::fmt::Debug for EngineFeed {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("EngineFeed")
            .field("waiting", &self.inbox.lock().len())
            .finish()
    }
}

impl EngineFeed {
    pub fn attach(
        engine: &dyn BrowserEngine,
        store: Arc<BrowserStore>,
        shutting_down: Arc<AtomicBool>,
    ) -> Arc<Self> {
        let feed = Arc::new(Self {
            subscription: engine.subscribe(),
            inbox: Mutex::new(VecDeque::new()),
            ready: Mutex::new(None),
            store,
            shutting_down,
        });
        let weak: Weak<EngineFeed> = Arc::downgrade(&feed);
        feed.subscription.set_wake_hook(move || {
            if let Some(feed) = weak.upgrade() {
                feed.collect();
            }
        });
        feed
    }

    pub fn on_ready(&self, ready: impl Fn() + Send + Sync + 'static) {
        *self.ready.lock() = Some(Arc::new(ready));
        if !self.inbox.lock().is_empty() || self.subscription.pending() > 0 {
            self.collect();
        }
    }

    fn collect(&self) {
        let events = self.subscription.drain();
        if events.is_empty() {
            return;
        }
        for event in &events {
            match event {
                EngineEvent::WillShutDown => {
                    self.shutting_down.store(true, Ordering::Release);
                    if !self.store.flush(SHUTDOWN_FLUSH) {
                        log::warn!("the session didn't finish saving before the engine shut down");
                    }
                }
                EngineEvent::QuitCancelled => self.shutting_down.store(false, Ordering::Release),
                _ => {}
            }
        }
        self.inbox.lock().extend(events);
        let ready = self.ready.lock().clone();
        if let Some(ready) = ready {
            ready();
        }
    }

    pub fn take(&self) -> Vec<EngineEvent> {
        let mut events: Vec<EngineEvent> = self.inbox.lock().drain(..).collect();
        if self.subscription.pending() > 0 {
            events.extend(self.subscription.drain());
        }
        events
    }

    pub fn is_idle(&self) -> bool {
        self.inbox.lock().is_empty() && self.subscription.pending() == 0
    }
}

fn opened_behind(disposition: &str) -> bool {
    matches!(disposition, "background_tab" | "background")
}

fn security_state(level: SecurityLevel) -> SecurityState {
    match level {
        SecurityLevel::Secure => SecurityState::Secure,
        SecurityLevel::Insecure | SecurityLevel::Mixed => SecurityState::Insecure,
        SecurityLevel::CertificateError => SecurityState::Dangerous,
        SecurityLevel::Local => SecurityState::Internal,
        SecurityLevel::None | SecurityLevel::Unknown => SecurityState::Unknown,
    }
}

pub fn state_download(profile: Option<String>, item: &DownloadItem) -> Download {
    Download {
        id: DownloadId::new(item.id.as_str()),
        url: item.url.clone(),
        filename: item.filename.clone(),
        path: item.path.clone(),
        state: DownloadState::from_key(&item.state).unwrap_or_default(),
        paused: item.paused,
        dangerous: item.dangerous.then_some(true),
        received: if item.received.is_finite() {
            item.received.max(0.0)
        } else {
            0.0
        },
        total: if item.total.is_finite() {
            item.total
        } else {
            -1.0
        },
        speed: if item.speed.is_finite() {
            item.speed.max(0.0)
        } else {
            0.0
        },
        mime_type: item.mime_type.clone(),
        profile,
        off_the_record: item.off_the_record.then_some(true),
        staging: None,
        start_time: (item.start_time.is_finite() && item.start_time > 0.0)
            .then_some(item.start_time),
        extra: Default::default(),
    }
}

fn merge_update(into: &mut PageUpdate, from: PageUpdate) {
    macro_rules! take {
        ($($field:ident),+) => {$(
            if from.$field.is_some() {
                into.$field = from.$field;
            }
        )+};
    }
    take!(
        url,
        title,
        favicon,
        loading,
        progress,
        can_go_back,
        can_go_forward,
        audible,
        theme_color,
        icon_theme,
        security,
        unread_count,
        blocked_requests,
        engine_tab_id
    );
}

#[derive(Default)]
struct PageBatch {
    order: Vec<TabId>,
    updates: HashMap<TabId, PageUpdate>,
}

impl PageBatch {
    fn add(&mut self, tab: TabId, update: PageUpdate) {
        match self.updates.get_mut(&tab) {
            Some(known) => merge_update(known, update),
            None => {
                self.order.push(tab.clone());
                self.updates.insert(tab, update);
            }
        }
    }
}

impl AppCoordinator {
    pub(crate) fn apply_events(&self, events: Vec<EngineEvent>) {
        let mut batch = PageBatch::default();
        for event in events {
            self.note_reader_event(&event);
            self.note_page_overlay(&event);
            self.note_media_event(&event);
            self.note_share_event(&event);
            self.note_translate_event(&event);
            self.note_blocker_event(&event);
            self.note_engine_event(&event);
            self.note_telemetry_event(&event);
            self.note_pip_event(&event);
            if self.swallowed_by_internal_page(&event) {
                continue;
            }
            if let Some((tab, update)) = self.page_update_for(&event, &batch) {
                batch.add(tab, update);
                continue;
            }
            self.flush_pages(&mut batch);
            let inserted = matches!(event, EngineEvent::TabInserted { .. }).then(|| event.clone());
            self.apply_event(event);
            if let Some(inserted) = inserted {
                self.note_inserted_tab(&inserted);
            }
        }
        self.flush_pages(&mut batch);
    }

    fn flush_pages(&self, batch: &mut PageBatch) {
        for tab in batch.order.drain(..) {
            if let Some(mut update) = batch.updates.remove(&tab) {
                self.adjust_page_update(&tab, &mut update);
                self.dispatch_quietly(Action::UpdatePage { tab, update });
            }
        }
    }

    pub(crate) fn state_tab(&self, tab: EngineTabId) -> Option<TabId> {
        self.bridge.lock().tabs.by_right(&tab).cloned()
    }

    pub(crate) fn state_window(&self, window: EngineWindowId) -> Option<WindowId> {
        self.bridge.lock().windows.by_right(&window).cloned()
    }

    fn page_update_for(
        &self,
        event: &EngineEvent,
        batch: &PageBatch,
    ) -> Option<(TabId, PageUpdate)> {
        let update = match event {
            EngineEvent::TitleChanged { title, .. } => {
                let listed = self.store.snapshot();
                let placeholder = self
                    .state_tab(event.tab()?)
                    .and_then(|tab| listed.tab(tab.as_str()))
                    .is_some_and(|tab| ardia_state::tabs::is_placeholder_title(title, &tab.url));
                if placeholder {
                    return None;
                }
                PageUpdate {
                    title: Some(title.clone()),
                    ..PageUpdate::default()
                }
            }
            EngineEvent::ShownTitleChanged { title, url, .. } => {
                if ardia_state::tabs::is_blank_address(url) {
                    return None;
                }
                let listed = self.store.snapshot();
                let same = self
                    .state_tab(event.tab()?)
                    .and_then(|tab| listed.tab(tab.as_str()).map(|t| t.title == *title))
                    .unwrap_or(true);
                if same {
                    return None;
                }
                PageUpdate {
                    title: Some(title.clone()),
                    ..PageUpdate::default()
                }
            }
            EngineEvent::UrlChanged { url, .. } => PageUpdate {
                url: Some(url.clone()),
                ..PageUpdate::default()
            },
            EngineEvent::LoadingChanged { loading, .. } => PageUpdate {
                loading: Some(*loading),
                ..PageUpdate::default()
            },
            EngineEvent::ProgressChanged { progress, .. } => PageUpdate {
                progress: Some(*progress as f32),
                ..PageUpdate::default()
            },
            EngineEvent::NavigationStateChanged {
                can_go_back,
                can_go_forward,
                ..
            } => PageUpdate {
                can_go_back: Some(*can_go_back),
                can_go_forward: Some(*can_go_forward),
                ..PageUpdate::default()
            },
            EngineEvent::ThemeColorChanged { color, .. } => PageUpdate {
                theme_color: Some(color.as_deref().and_then(RgbaColor::parse)),
                ..PageUpdate::default()
            },
            EngineEvent::RequestsBlocked { count, .. } => PageUpdate {
                blocked_requests: Some((*count).max(0) as u32),
                ..PageUpdate::default()
            },
            EngineEvent::RendererGone { .. } => PageUpdate {
                loading: Some(false),
                fullscreen: Some(false),
                ..PageUpdate::default()
            },
            _ => return None,
        };
        let tab = self.state_tab(event.tab()?)?;
        let blank = matches!(event,
            EngineEvent::UrlChanged { url, .. } | EngineEvent::TitleChanged { title: url, .. }
                if url == "about:blank");
        if blank
            && self
                .store
                .snapshot()
                .tab(tab.as_str())
                .is_some_and(|listed| listed.url.is_empty())
        {
            return None;
        }
        let mut update = update;
        if let EngineEvent::UrlChanged { url, .. } = event
            && self.favicon_left_behind(&tab, url)
        {
            update.favicon = Some(None);
        }
        if let Some(update) = self.kept_behind_new_tab(&tab, event, update.clone()) {
            return update;
        }
        if let EngineEvent::TitleChanged { title, .. } = event {
            let waiting = batch
                .updates
                .get(&tab)
                .and_then(|update| update.url.as_deref());
            self.record_visit(&tab, title, waiting);
        }
        Some((tab, update))
    }

    fn record_visit(&self, tab: &TabId, title: &str, waiting_url: Option<&str>) {
        let state = self.store.snapshot();
        let Some(tab) = state.tab(tab.as_str()) else {
            return;
        };
        let url = waiting_url.unwrap_or(&tab.url);
        let web = url.starts_with("https://") || url.starts_with("http://");
        if web && !tab.is_incognito() && !title.is_empty() {
            let own_icon = self
                .bridge
                .lock()
                .favicon_pages
                .get(&tab.id)
                .is_some_and(|page| page == url);
            self.dispatch_quietly(Action::RecordVisit {
                profile: tab.profile_id.clone(),
                url: url.to_owned(),
                title: title.to_owned(),
                favicon: tab.favicon.clone().filter(|_| own_icon),
            });
        }
    }

    fn apply_event(&self, event: EngineEvent) {
        match event {
            EngineEvent::Started => self.on_started(),
            EngineEvent::WillShutDown => {
                self.shutting_down.store(true, Ordering::Release);
                crate::webkit::page::flush_history();
            }
            EngineEvent::QuitCancelled => self.shutting_down.store(false, Ordering::Release),
            EngineEvent::EventsDropped { count, resync } => {
                log::warn!("the engine dropped {count} events");
                if resync {
                    self.resync();
                }
            }
            EngineEvent::WindowCreatedByEngine {
                window,
                profile,
                kind,
            } => self.adopt_engine_window(window, profile, kind),
            EngineEvent::TabInserted {
                window,
                tab,
                opener,
                disposition,
            } => self.on_tab_inserted(window, tab, opener, &disposition),
            EngineEvent::TabRemoved { tab, .. } => {
                if let Ok(mut holds) = crate::pointer_hold::HOLDS.lock() {
                    holds.forget(tab);
                }
            }
            EngineEvent::TabActivated { window, tab } => {
                if let Some(window) = self.state_window(window) {
                    self.bridge.lock().engine_active.insert(window, tab);
                }
            }
            EngineEvent::ActivationRequested { tab, .. } => {
                if let Some(tab) = self.state_tab(tab) {
                    self.dispatch_quietly(Action::ActivateTab { tab: tab.clone() });
                    if let Some(window) = self.window_of(&tab) {
                        self.dispatch_quietly(Action::FocusWindow {
                            window: window.clone(),
                        });
                        self.effect(ShellEffect::FocusWindow { window });
                    }
                }
            }
            EngineEvent::TabWillClose { tab } => self.on_tab_will_close(tab),
            EngineEvent::FaviconChanged { tab, url } => self.on_favicon(tab, url),
            EngineEvent::AudioChanged {
                tab,
                audible,
                muted,
            } => self.on_audio(tab, audible, muted),
            EngineEvent::SecurityChanged { tab } => self.on_security(tab),
            EngineEvent::ZoomChanged { tab, zoom } => self.on_zoom(tab, zoom),
            EngineEvent::FindMatches { tab, matches } => {
                if let Some(tab) = self.state_tab(tab) {
                    let state = self.store.snapshot();
                    if let Some(find) = state
                        .tab(tab.as_str())
                        .map(|t| t.live.find.clone())
                        .filter(|find| find.open)
                    {
                        self.dispatch_quietly(Action::SetFind {
                            tab,
                            find: FindState {
                                count: Some(matches.count.max(0) as u32),
                                active: matches.active.max(0) as u32,
                                ..find
                            },
                        });
                    }
                }
            }
            EngineEvent::DevToolsChanged { tab, open, .. } => {
                if let Some(state_tab) = self.state_tab(tab) {
                    let window = self.window_of(&state_tab);
                    {
                        let mut bridge = self.bridge.lock();
                        if open {
                            bridge.devtools_open.insert(state_tab);
                        } else {
                            bridge.devtools_open.remove(&state_tab);
                        }
                    }
                    self.forget_devtools_view(tab);
                    if let Some(window) = window {
                        self.touch(window);
                    }
                }
            }
            EngineEvent::FullscreenChanged {
                window,
                tab,
                fullscreen,
            } => {
                if let Some(tab) = self.state_tab(tab) {
                    self.dispatch_quietly(Action::UpdatePage {
                        tab,
                        update: PageUpdate {
                            fullscreen: Some(fullscreen),
                            ..PageUpdate::default()
                        },
                    });
                }
                if let Some(window) = self.state_window(window) {
                    self.touch(window);
                }
            }
            EngineEvent::PasswordPrompt { tab, prompt, .. } => {
                if let Some(tab) = self.state_tab(tab) {
                    let changed = self.bridge.lock().prompts.password(&tab, &prompt);
                    if changed {
                        self.publish_prompts(&tab);
                    }
                }
            }
            EngineEvent::AutofillPrompt { tab, prompt, .. } => {
                if let Some(tab) = self.state_tab(tab) {
                    let changed = self.bridge.lock().prompts.autofill(&tab, &prompt);
                    if changed {
                        self.publish_prompts(&tab);
                    }
                }
            }
            EngineEvent::PermissionRequested { ref request, .. }
                if self.turned_down_unasked(request) => {}
            EngineEvent::PermissionRequested { tab, ref request } => {
                match tab.and_then(|tab| self.state_tab(tab)) {
                    Some(tab) => {
                        let changed = self.bridge.lock().prompts.permission(&tab, request);
                        if changed {
                            self.publish_prompts(&tab);
                        }
                    }
                    None => self.bridge.lock().prompts.hold(event.clone()),
                }
            }
            EngineEvent::PermissionDismissed { request_id } => {
                let tab = {
                    let mut bridge = self.bridge.lock();
                    bridge
                        .prompts
                        .release(&PromptKey::Permission(request_id.clone()));
                    bridge.prompts.settle_request(&request_id)
                };
                if let Some(tab) = tab {
                    self.publish_prompts(&tab);
                }
            }
            EngineEvent::ExternalAppRequest { ref request, .. }
                if crate::site::external_app_ask(request).is_none() =>
            {
                if let Some(id) = request.get("id").and_then(serde_json::Value::as_str)
                    && let Some(engine) = self.engine()
                    && let Err(problem) = engine.resolve_external_app(id, false, false)
                {
                    log::warn!("couldn't turn down {id}: {problem}");
                }
            }
            EngineEvent::ExternalAppRequest { tab, ref request } => match self.state_tab(tab) {
                Some(tab) => {
                    let changed = self.bridge.lock().prompts.external_app(&tab, request);
                    if changed {
                        self.publish_prompts(&tab);
                    }
                }
                None => self.bridge.lock().prompts.hold(event.clone()),
            },
            EngineEvent::DeviceChooser { tab, ref chooser } => {
                let open = chooser.open;
                self.hold_or_release(event.clone(), open);
                self.set_tab_popover(
                    tab,
                    open.then(|| Popover::Custom(format!("deviceChooser:{}", chooser.id))),
                    |popover| matches!(popover, Popover::Custom(name) if name.starts_with("deviceChooser:")),
                );
            }
            EngineEvent::CastDialog { tab, ref dialog } => {
                let open = dialog.open;
                self.hold_or_release(event.clone(), open);
                self.set_tab_popover(tab, open.then_some(Popover::Cast), |popover| {
                    *popover == Popover::Cast
                });
                self.signal.emit(ardia_ui::host_data::HostTopics::CAST);
            }
            EngineEvent::CastRoutes { routes, .. } => {
                self.bridge.lock().cast_routes = routes;
                self.signal.emit(ardia_ui::host_data::HostTopics::CAST);
            }
            EngineEvent::MediaAccessChanged { tab, access } => {
                if let Some(tab) = self.state_tab(tab) {
                    let mut bridge = self.bridge.lock();
                    let any = access.camera || access.microphone || access.screen;
                    let changed = if any {
                        bridge.media_access.insert(tab, access) != Some(access)
                    } else {
                        bridge.media_access.remove(&tab).is_some()
                    };
                    drop(bridge);
                    if changed {
                        self.signal.emit(ardia_ui::host_data::HostTopics::PAGE);
                    }
                }
            }
            EngineEvent::ExtensionInstallPrompt { .. } => {
                ardia_telemetry::counts::count("extension_install_prompts");
                self.bridge.lock().prompts.hold(event);
                self.signal
                    .emit(ardia_ui::host_data::HostTopics::EXTENSIONS);
            }
            EngineEvent::ExtensionInstallFailed { message, .. } => {
                self.notify(ToastKind::Error, message);
            }
            EngineEvent::ConfirmCloseWithDownloads {
                window,
                count,
                request,
            } => self.confirm_close_with_downloads(window, count, request, event),
            EngineEvent::WindowClosed { window } => self.on_window_closed(window),
            EngineEvent::WindowCloseCancelled { window } => self.on_close_cancelled(window),
            EngineEvent::WindowCanTakeTabs { .. } => self.mark_dirty(),
            EngineEvent::ShowRequested { window, active } => {
                if let Some(window) = self.state_window(window)
                    && active
                {
                    self.effect(ShellEffect::FocusWindow { window });
                }
            }
            EngineEvent::PopupBlocked { tab, popup } => {
                if let Some(tab) = self.state_tab(tab) {
                    let window = self.window_of(&tab);
                    let origin = popup.origin.clone();
                    let first = {
                        let mut bridge = self.bridge.lock();
                        let first = bridge.prompts.blocked_popups(&tab).is_empty();
                        bridge.prompts.block_popup(&tab, popup);
                        first
                    };
                    if let Some(window) = window {
                        self.touch(window);
                    }
                    self.popup_was_blocked(&tab, &origin, first);
                }
            }
            EngineEvent::DiscardedChanged { tab, discarded, .. } => {
                if discarded && let Some(tab) = self.state_tab(tab) {
                    self.bridge
                        .lock()
                        .applied
                        .entry(tab.clone())
                        .or_default()
                        .asleep = true;
                    self.dispatch_quietly(Action::SleepTabs { tabs: vec![tab] });
                }
            }
            EngineEvent::AppUrlRequested { tab, url, .. } => {
                match (ardia_ui::pages::is_internal(&url), self.state_tab(tab)) {
                    (true, Some(tab)) => {
                        if let Err(problem) =
                            self.dispatch_action(Action::Navigate { tab, input: url })
                        {
                            log::debug!("an internal page didn't open: {problem}");
                        }
                    }
                    _ => self.open_app_url(&url),
                }
            }
            EngineEvent::Download(DownloadEvent::Changed { profile, item }) => {
                let download = state_download(profile, &item);
                self.open_if_done(&download);
                self.dispatch_quietly(Action::UpsertDownload {
                    download: Box::new(download),
                });
            }
            EngineEvent::Download(DownloadEvent::Removed { id, .. }) => {
                self.dispatch_quietly(Action::RemoveDownload { id });
            }
            EngineEvent::OpenUrls { urls, sender } => {
                if let Some(sender) = sender {
                    crate::link_sources::remember(
                        &urls,
                        &ardia_state::air_traffic::LinkSource {
                            bundle_id: sender.bundle_id,
                            app_name: sender.app_name,
                        },
                    );
                }
                for (index, url) in urls.iter().enumerate() {
                    self.open_url_at(url, index);
                }
            }
            EngineEvent::DockReopen {
                has_visible_windows,
            } => {
                ardia_telemetry::counts::count("dock_reopens");
                if !has_visible_windows {
                    self.dispatch_quietly(Action::OpenLastWindowOrNew);
                }
            }
            EngineEvent::MenuCommand { command, arg } => {
                self.focus_platform_window();
                if let Err(problem) = self.run_command(&command, arg.as_deref()) {
                    log::warn!("menu command {command} didn't run: {problem}");
                }
            }
            EngineEvent::Unresponsive { tab } => {
                log::info!("{tab} stopped responding");
            }
            EngineEvent::TabOffered { offer } => {
                log::info!(
                    "the engine offered a tab for {} that this host doesn't adopt",
                    offer.url
                );
            }
            EngineEvent::PageMessage { tab, message } => {
                if self.peek_page_message(tab, &message) {
                } else if message.kind == "scroll" && message.main_frame {
                    self.note_page_scroll(tab, &message.json);
                } else if message.kind == "theme" && message.main_frame {
                    self.note_page_theme(tab, &message.json);
                } else if message.kind == "selection" && message.main_frame {
                    if let Some(tab) = self.state_tab(tab) {
                        self.note_page_selection(&tab, &message.json);
                    }
                } else if message.kind == "commandWheel" && message.main_frame {
                    if let (Some(tab), Some(data)) = (self.state_tab(tab), message.data()) {
                        self.command_wheel_from_page(tab, &data);
                    }
                } else {
                    log::trace!("{tab} sent {}", message.kind);
                }
            }
            EngineEvent::Service(service) => match service.topic_kind() {
                ardia_engine::ServiceTopic::ExtensionsChanged => self.extensions_changed(),
                ardia_engine::ServiceTopic::ExtensionsAction => self.extension_actions_changed(),
                ardia_engine::ServiceTopic::HistoryChanged => self.engine_history_changed(&service),
                ardia_engine::ServiceTopic::BookmarksChanged => {
                    self.engine_bookmarks_changed(&service)
                }
                ardia_engine::ServiceTopic::CliControl => self.control_server_changed(&service),
                _ => log::debug!("engine service event {}", service.topic),
            },
            EngineEvent::ExtensionActionPopup { tab, popup } => {
                let extension = popup
                    .get("extensionId")
                    .and_then(serde_json::Value::as_str)
                    .unwrap_or_default()
                    .to_owned();
                if let Some(tab) = tab.and_then(|tab| self.state_tab(tab))
                    && let Some(window) = self.window_of(&tab)
                    && !extension.is_empty()
                {
                    self.close_popup(&window);
                    self.open_extension_popup(&window, &tab, &extension);
                }
            }
            EngineEvent::PreferredSizeChanged { tab, size } => {
                self.popup_resized(tab, size.width, size.height);
            }
            EngineEvent::ExtensionSidePanel { tab, panel } => {
                self.side_panel_requested(tab, &panel);
            }
            EngineEvent::ExtensionActionShortcut { .. }
            | EngineEvent::TitleChanged { .. }
            | EngineEvent::ShownTitleChanged { .. }
            | EngineEvent::UrlChanged { .. }
            | EngineEvent::LoadingChanged { .. }
            | EngineEvent::ProgressChanged { .. }
            | EngineEvent::NavigationStateChanged { .. }
            | EngineEvent::ThemeColorChanged { .. }
            | EngineEvent::RequestsBlocked { .. }
            | EngineEvent::RendererGone { .. }
            | EngineEvent::LoadFailed { .. }
            | EngineEvent::StatusText { .. }
            | EngineEvent::DocumentCommitted { .. }
            | EngineEvent::FocusGained { .. }
            | EngineEvent::PipChanged { .. }
            | EngineEvent::PipActivity { .. }
            | EngineEvent::AutofillSuggestionsShown { .. }
            | EngineEvent::ContextMenuCommand { .. }
            | EngineEvent::ShareFromContextMenu { .. }
            | EngineEvent::ContextMenuShown { .. }
            | EngineEvent::NavigationBecameDownload { .. }
            | EngineEvent::Responsive { .. } => {}
            EngineEvent::PageScroll { .. } | EngineEvent::PageOverscroll { .. } => {
                self.note_page_scroll_ack(&event);
            }
        }
    }

    fn hold_or_release(&self, event: EngineEvent, open: bool) {
        let key = match &event {
            EngineEvent::DeviceChooser { chooser, .. } => PromptKey::DeviceChooser(chooser.id),
            EngineEvent::CastDialog { dialog, .. } => PromptKey::CastDialog(dialog.id),
            _ => return,
        };
        let mut bridge = self.bridge.lock();
        if open {
            bridge.prompts.hold(event);
        } else {
            bridge.prompts.release(&key);
        }
    }

    fn set_tab_popover(
        &self,
        tab: Option<EngineTabId>,
        popover: Option<Popover>,
        ours: impl Fn(&Popover) -> bool,
    ) {
        let Some(window) = tab
            .and_then(|tab| self.state_tab(tab))
            .and_then(|tab| self.window_of(&tab))
        else {
            return;
        };
        let state = self.store.snapshot();
        let current = state
            .window(window.as_str())
            .and_then(|w| w.chrome.popover.clone());
        let keep = popover.is_none() && current.as_ref().is_some_and(|known| !ours(known));
        if !keep && current != popover {
            self.dispatch_quietly(Action::SetPopover { window, popover });
        }
    }

    pub(crate) fn publish_prompts(&self, tab: &TabId) {
        let prompts = self.bridge.lock().prompts.site_prompts(tab);
        if self.store.snapshot().tab(tab.as_str()).is_some() {
            self.dispatch_quietly(Action::SetPrompts {
                tab: tab.clone(),
                prompts,
            });
        }
    }

    pub(crate) fn window_of(&self, tab: &TabId) -> Option<WindowId> {
        self.store
            .snapshot()
            .tab(tab.as_str())
            .map(|tab| tab.window_id.clone())
    }

    fn on_started(&self) {
        if self.started.swap(true, Ordering::AcqRel) {
            return;
        }
        self.boot_session();
    }

    fn open_window_for(
        &self,
        kind: WindowKind,
        known: Option<&Owner>,
        engine_profile: Option<EngineProfileId>,
    ) -> Option<(WindowId, Option<TabId>)> {
        let outcome = match self.store.dispatch(Action::OpenWindow {
            kind,
            profile: known.map(|known| known.owner.original().clone()),
            url: None,
            frame: None,
        }) {
            Ok(outcome) => outcome,
            Err(problem) => {
                log::warn!("couldn't give the engine's page a window: {problem}");
                return None;
            }
        };
        let window = outcome.window?;
        let window_profile = self
            .store
            .snapshot()
            .window(window.as_str())
            .map(|w| w.profile_id.clone());
        let mut bridge = self.bridge.lock();
        if let Some(tab) = outcome.tab.clone() {
            bridge.placeholders.insert(window.clone(), tab);
        }
        if let (Some(engine_profile), Some(window_profile)) = (engine_profile, window_profile)
            && window_profile.is_incognito()
        {
            if known.is_some_and(|known| known.certain) {
                bridge.profiles.insert(window_profile, engine_profile);
            } else {
                bridge.profiles.alias(window_profile, engine_profile);
            }
        }
        Some((window, outcome.tab))
    }

    fn adopt_engine_window(
        &self,
        window: EngineWindowId,
        profile: Option<EngineProfileId>,
        kind: NewBrowserKind,
    ) {
        if self.state_window(window).is_some() {
            return;
        }
        let known = profile.and_then(|profile| self.profile_owner(profile));
        let kind = match (&known, kind) {
            (Some(known), _) if known.owner.is_private() => WindowKind::Incognito,
            (_, NewBrowserKind::Popup) => WindowKind::LittleArdia,
            _ => WindowKind::Main,
        };
        let Some((state_window, _)) = self.open_window_for(kind, known.as_ref(), profile) else {
            return;
        };
        self.bridge
            .lock()
            .windows
            .insert(state_window.clone(), window);
        self.open_gpui_window(&state_window, kind, window);
    }

    fn shelter_private_tab(&self, tab: EngineTabId, known: &Owner, info: &TabInfo) {
        let Some((window, Some(placeholder))) =
            self.open_window_for(WindowKind::Incognito, Some(known), info.profile)
        else {
            log::warn!("{tab} is private but has no private window, so it closes");
            self.bridge.lock().closing_tabs.insert(tab);
            if let Some(engine) = self.engine() {
                let _ = engine.close_now(tab);
            }
            return;
        };
        log::info!("{tab} is private, so it moves to its own private window");
        self.bridge.lock().strays.insert(window, tab);
        if !info.url.is_empty() {
            self.dispatch_quietly(Action::UpdatePage {
                tab: placeholder,
                update: PageUpdate {
                    url: Some(info.url.clone()),
                    title: (!info.title.is_empty()).then(|| info.title.clone()),
                    ..PageUpdate::default()
                },
            });
        }
        self.mark_dirty();
    }

    fn on_tab_inserted(
        &self,
        window: EngineWindowId,
        tab: EngineTabId,
        opener: Option<EngineTabId>,
        disposition: &str,
    ) {
        if self.is_popup_tab(tab) {
            return;
        }
        let Some(state_window) = self.state_window(window) else {
            log::debug!("{tab} arrived in {window}, which has no Ardia window");
            return;
        };
        if let Some(known) = self.state_tab(tab) {
            let state = self.store.snapshot();
            let moved = state
                .tab(known.as_str())
                .is_some_and(|t| t.window_id != state_window);
            self.bridge
                .lock()
                .tab_homes
                .insert(known.clone(), state_window.clone());
            if moved && disposition != "adopted" {
                let index = state
                    .window(state_window.as_str())
                    .map_or(0, |w| w.tab_ids.len());
                self.dispatch_quietly(Action::MoveTab {
                    tab: known,
                    window: state_window,
                    index,
                });
            }
            return;
        }
        let engine = match self.engine() {
            Some(engine) => engine,
            None => return,
        };
        let info = engine.tab_info(tab).unwrap_or_default();
        let known = info.profile.and_then(|profile| self.profile_owner(profile));
        let (window_private, window_engine_profile) = {
            let state = self.store.snapshot();
            let listed = state.window(state_window.as_str());
            (
                listed.is_some_and(|w| w.kind == WindowKind::Incognito),
                listed.and_then(|w| self.bridge.lock().profiles.engine_of(&w.profile_id)),
            )
        };
        let elsewhere = window_engine_profile.is_some_and(|mapped| Some(mapped) != info.profile);
        if let Some(known) = known.as_ref().filter(|known| known.owner.is_private())
            && (!window_private || elsewhere)
        {
            self.shelter_private_tab(tab, known, &info);
            return;
        }
        let owner = known.map(|known| known.owner);
        let placeholder = self.bridge.lock().placeholders.remove(&state_window);
        let state_tab = match placeholder {
            Some(placeholder) if self.store.snapshot().tab(placeholder.as_str()).is_some() => {
                placeholder
            }
            _ => {
                let profile = match owner {
                    Some(ProfileOwner::Regular(profile)) => Some(profile),
                    _ => None,
                };
                let opener = opener.and_then(|opener| self.state_tab(opener));
                if self.route_page_link(tab, &state_window, opener.as_ref(), disposition, &info.url)
                {
                    return;
                }
                let outcome = self.store.dispatch(Action::NewTab {
                    window: state_window.clone(),
                    tab: NewTab {
                        profile,
                        opener,
                        background: opened_behind(disposition),
                        ..NewTab::default()
                    },
                });
                match outcome.ok().and_then(|outcome| outcome.tab) {
                    Some(created) => created,
                    None => {
                        log::warn!("{tab} couldn't be listed in {state_window}");
                        return;
                    }
                }
            }
        };
        self.bind_tab(&state_tab, tab, &state_window);
        let mut update = PageUpdate {
            title: (!info.title.is_empty()).then(|| info.title.clone()),
            loading: Some(info.loading),
            ..PageUpdate::default()
        };
        if !info.url.is_empty() {
            update.url = Some(info.url);
        }
        self.dispatch_quietly(Action::UpdatePage {
            tab: state_tab,
            update,
        });
    }

    fn on_tab_will_close(&self, tab: EngineTabId) {
        if self.is_popup_tab(tab) {
            self.popup_tab_gone(tab);
            return;
        }
        let sheltered = {
            let mut bridge = self.bridge.lock();
            let window = bridge
                .strays
                .iter()
                .find(|(_, stray)| **stray == tab)
                .map(|(window, _)| window.clone());
            window.inspect(|window| {
                bridge.strays.remove(window);
            })
        };
        if let Some(window) = sheltered {
            let placeholder = self.bridge.lock().placeholders.remove(&window);
            if let Some(placeholder) = placeholder {
                self.dispatch_quietly(Action::CloseTabs {
                    tabs: vec![placeholder],
                    last_closes_window: true,
                });
            }
            return;
        }
        let (state_tab, ours, window_closing) = {
            let mut bridge = self.bridge.lock();
            let ours = bridge.closing_tabs.remove(&tab);
            let state_tab = bridge.tabs.by_right(&tab).cloned();
            let window_closing = state_tab
                .as_ref()
                .and_then(|t| bridge.tab_homes.get(t))
                .and_then(|w| bridge.windows.by_left(w))
                .is_some_and(|w| bridge.closing_windows.contains(w));
            (state_tab, ours, window_closing)
        };
        let Some(state_tab) = state_tab else {
            return;
        };
        self.unbind_tab(&state_tab);
        if ours || window_closing || self.is_shutting_down() {
            return;
        }
        let state = self.store.snapshot();
        let Some(listed) = state.tab(state_tab.as_str()) else {
            return;
        };
        let single = state
            .window(listed.window_id.as_str())
            .is_some_and(|w| w.kind == WindowKind::LittleArdia);
        self.dispatch_quietly(Action::CloseTabs {
            tabs: vec![state_tab],
            last_closes_window: single,
        });
    }

    fn on_window_closed(&self, window: EngineWindowId) {
        let (state_window, requested) = {
            let mut bridge = self.bridge.lock();
            let requested = bridge.closing_windows.remove(&window);
            let state_window = bridge.windows.remove_right(&window);
            (state_window, requested)
        };
        self.forget_hosted(window);
        let Some(state_window) = state_window else {
            return;
        };
        let homed: Vec<TabId> = {
            let bridge = self.bridge.lock();
            bridge
                .tab_homes
                .iter()
                .filter(|(_, home)| **home == state_window)
                .map(|(tab, _)| tab.clone())
                .collect()
        };
        for tab in &homed {
            self.unbind_tab(tab);
        }
        {
            let mut bridge = self.bridge.lock();
            bridge.engine_active.remove(&state_window);
            bridge.shown.remove(&state_window);
            bridge.window_profiles.remove(&state_window);
            bridge.placeholders.remove(&state_window);
        }
        if !requested && self.engine_is_quitting() {
            log::info!("the engine is quitting, so {state_window} stays in the session");
            self.begin_shutdown();
        }
        if self.is_shutting_down() {
            return;
        }
        let exists = self
            .store
            .snapshot()
            .window(state_window.as_str())
            .is_some();
        if exists {
            if !requested {
                log::debug!("the engine closed {state_window} by itself");
            }
            self.dispatch_quietly(Action::CloseWindow {
                window: state_window.clone(),
            });
        }
        self.effect(ShellEffect::CloseWindow {
            window: state_window,
        });
    }

    fn on_close_cancelled(&self, window: EngineWindowId) {
        let (forced, profiles) = {
            let mut bridge = self.bridge.lock();
            bridge.closing_windows.remove(&window);
            let profiles = bridge.profiles.engine_profiles();
            (bridge.windows.by_right(&window).is_none(), profiles)
        };
        let Some(engine) = self.engine().filter(|_| forced) else {
            return;
        };
        for profile in profiles {
            for tab in engine.tabs_for_profile(window, profile).unwrap_or_default() {
                let _ = engine.close_now(tab);
            }
        }
        self.bridge.lock().closing_windows.insert(window);
        let _ = engine.close_window(window);
    }

    fn favicon_left_behind(&self, tab: &TabId, url: &str) -> bool {
        let Some((page, has_icon)) = self
            .store
            .snapshot()
            .tab(tab.as_str())
            .map(|listed| (listed.url.clone(), listed.favicon.is_some()))
        else {
            return false;
        };
        if !has_icon {
            return false;
        }
        let page = self
            .bridge
            .lock()
            .favicon_pages
            .get(tab)
            .cloned()
            .unwrap_or(page);
        favicon_site_changed(&page, url)
    }

    pub(crate) fn on_favicon(&self, tab: EngineTabId, url: Option<String>) {
        if let Some(state_tab) = self.state_tab(tab) {
            self.favicon_for_tab(state_tab, url);
        }
    }

    pub(crate) fn favicon_for_tab(&self, state_tab: TabId, url: Option<String>) {
        let page = self
            .store
            .snapshot()
            .tab(state_tab.as_str())
            .map(|listed| listed.url.clone())
            .unwrap_or_default();
        self.bridge
            .lock()
            .favicon_pages
            .insert(state_tab.clone(), page);
        self.dispatch_quietly(Action::UpdatePage {
            tab: state_tab.clone(),
            update: PageUpdate {
                favicon: Some(url.clone()),
                ..PageUpdate::default()
            },
        });
        let Some(url) = url.filter(|url| !url.is_empty()) else {
            self.bridge.lock().icon_urls.remove(&state_tab);
            self.set_icon_theme(&state_tab, None);
            return;
        };
        let already = self.bridge.lock().icon_urls.get(&state_tab) == Some(&url);
        if already {
            return;
        }
        self.bridge
            .lock()
            .icon_urls
            .insert(state_tab.clone(), url.clone());
        if let Some(bytes) = favicons::data_url_bytes(&url) {
            self.set_icon_theme(&state_tab, Some(favicons::theme_for_bytes(&bytes)));
            return;
        }
        if !favicons::is_remote(&url) {
            self.set_icon_theme(&state_tab, Some(ardia_theme::IconTheme::Default));
            return;
        }
        if let Some(theme) = self.cached_icon_theme(&url) {
            self.set_icon_theme(&state_tab, Some(theme));
            return;
        }
        let profile = self
            .store
            .snapshot()
            .tab(state_tab.as_str())
            .map(|listed| listed.profile_id.clone());
        let request = match profile {
            Some(profile) => self.request_icon(&profile, &url),
            None => favicons::IconRequest::FailedRecently,
        };
        if request == favicons::IconRequest::FailedRecently {
            self.set_icon_theme(&state_tab, Some(ardia_theme::IconTheme::Default));
        }
    }

    pub(crate) fn set_icon_theme(&self, tab: &TabId, theme: Option<ardia_theme::IconTheme>) {
        {
            let mut bridge = self.bridge.lock();
            match theme {
                Some(theme) => bridge.icon_themes.insert(tab.clone(), theme),
                None => bridge.icon_themes.remove(tab),
            };
        }
        self.dispatch_quietly(Action::UpdatePage {
            tab: tab.clone(),
            update: PageUpdate {
                icon_theme: Some(theme),
                ..PageUpdate::default()
            },
        });
    }

    fn on_audio(&self, tab: EngineTabId, audible: bool, muted: bool) {
        let Some(state_tab) = self.state_tab(tab) else {
            return;
        };
        if !muted {
            self.bridge
                .lock()
                .applied
                .entry(state_tab.clone())
                .or_default()
                .muted = false;
        }
        self.dispatch_quietly(Action::UpdatePage {
            tab: state_tab,
            update: PageUpdate {
                audible: Some(audible),
                ..PageUpdate::default()
            },
        });
        self.mark_dirty();
    }

    fn kept_behind_new_tab(
        &self,
        tab: &TabId,
        event: &EngineEvent,
        update: PageUpdate,
    ) -> Option<Option<(TabId, PageUpdate)>> {
        let mut bridge = self.bridge.lock();
        if let Some(kept) = bridge.new_tab_shown.get_mut(tab) {
            match event {
                EngineEvent::UrlChanged { url, .. } => kept.0 = url.clone(),
                EngineEvent::TitleChanged { title, .. }
                | EngineEvent::ShownTitleChanged { title, .. } => kept.1 = title.clone(),
                _ => return None,
            }
            return Some(None);
        }
        if let EngineEvent::UrlChanged { url, .. } = event
            && !url.is_empty()
            && url != "about:blank"
            && self
                .store
                .snapshot()
                .tab(tab.as_str())
                .is_some_and(|listed| listed.url.is_empty())
        {
            bridge.back_to_new_tab.insert(tab.clone());
        }
        let _ = update;
        None
    }

    fn note_page_theme(&self, tab: EngineTabId, json: &str) {
        let Some(state_tab) = self.state_tab(tab) else {
            return;
        };
        let Ok(value) = serde_json::from_str::<serde_json::Value>(json) else {
            return;
        };
        let color = value
            .get("color")
            .and_then(serde_json::Value::as_str)
            .and_then(RgbaColor::parse);
        self.dispatch_quietly(Action::UpdatePage {
            tab: state_tab,
            update: PageUpdate {
                theme_color: Some(color),
                ..PageUpdate::default()
            },
        });
    }

    fn note_page_scroll(&self, tab: EngineTabId, json: &str) {
        let Some(state_tab) = self.state_tab(tab) else {
            return;
        };
        let down = serde_json::from_str::<serde_json::Value>(json)
            .ok()
            .and_then(|value| {
                value
                    .get("state")
                    .and_then(|s| s.as_str())
                    .map(|s| s == "down")
            });
        let Some(down) = down else {
            return;
        };
        let hides = self.store.snapshot().settings.hide_toolbar_while_scrolling;
        let changed = {
            let mut bridge = self.bridge.lock();
            if down && hides {
                let hidden = bridge.scrolled_down.insert(state_tab.clone());
                if hidden {
                    crate::telemetry_events::note_toolbar_hidden(state_tab.as_str());
                }
                hidden
            } else {
                let shown = bridge.scrolled_down.remove(&state_tab);
                if shown {
                    crate::telemetry_events::note_toolbar_shown(state_tab.as_str());
                }
                shown
            }
        };
        if changed {
            self.signal.emit(ardia_ui::host_data::HostTopics::PAGE);
        }
    }

    fn on_security(&self, tab: EngineTabId) {
        let (Some(state_tab), Some(engine)) = (self.state_tab(tab), self.engine()) else {
            return;
        };
        if let Ok(info) = engine.security_info(tab) {
            self.dispatch_quietly(Action::UpdatePage {
                tab: state_tab,
                update: PageUpdate {
                    security: Some(security_state(info.level)),
                    ..PageUpdate::default()
                },
            });
        }
    }

    fn on_zoom(&self, tab: EngineTabId, zoom: f64) {
        let Some(state_tab) = self.state_tab(tab) else {
            return;
        };
        self.bridge
            .lock()
            .applied
            .entry(state_tab.clone())
            .or_default()
            .zoom = zoom;
        let differs = self
            .store
            .snapshot()
            .tab(state_tab.as_str())
            .is_some_and(|t| (t.zoom - zoom).abs() > 1e-6);
        if differs && zoom.is_finite() && (0.25..=5.0).contains(&zoom) {
            self.dispatch_quietly(Action::SetZoom {
                tab: state_tab,
                zoom,
            });
        }
    }

    fn confirm_close_with_downloads(
        &self,
        window: EngineWindowId,
        count: i32,
        request: u64,
        event: EngineEvent,
    ) {
        if self.config.background {
            log::info!("closing with {count} downloads in progress cancels them in the background");
            self.answer_close_with_downloads(request, true);
            return;
        }
        self.bridge.lock().prompts.hold(event);
        let quitting = self.is_shutting_down() || self.engine_is_quitting();
        let shown = self
            .state_window(window)
            .or_else(|| crate::menu_bridge::focused_window(&self.store.snapshot()));
        self.effect(ShellEffect::ConfirmCloseWithDownloads {
            window: shown,
            request,
            count: count.max(1) as u32,
            quitting,
        });
    }

    pub fn answer_close_with_downloads(&self, request: u64, close: bool) {
        self.bridge
            .lock()
            .prompts
            .release(&PromptKey::CloseWithDownloads(request));
        if let Some(engine) = self.engine()
            && let Err(problem) = engine.resolve_close_with_downloads(request, close)
        {
            log::warn!("the downloads question didn't reach the engine: {problem}");
        }
    }

    pub(crate) fn notify(&self, kind: ToastKind, message: String) {
        let state = self.store.snapshot();
        let Some(window) = state
            .focus_order
            .iter()
            .find(|w| state.window(w.as_str()).is_some_and(|w| w.kind.has_tabs()))
            .cloned()
        else {
            return;
        };
        let now = ardia_state::store::now_ms();
        self.dispatch_quietly(Action::PushToast {
            window,
            toast: Toast {
                id: now.max(0) as u64,
                kind,
                message,
                action: None,
                icon: None,
                created_at: now,
                expires_at: Some(now + 6_000),
            },
        });
    }

    fn open_app_url(&self, url: &str) {
        let page = url
            .strip_prefix("ardia://")
            .unwrap_or_default()
            .split(['/', '?', '#'])
            .next()
            .unwrap_or_default();
        let kind = match page {
            "settings" => ardia_ui::UtilityWindowKind::Settings,
            "import" => ardia_ui::UtilityWindowKind::Import,
            "onboarding" | "welcome" => ardia_ui::UtilityWindowKind::Onboarding,
            _ => return,
        };
        self.effect(ShellEffect::OpenUtility(kind));
    }

    pub(crate) fn resync(&self) {
        let Some(engine) = self.engine() else {
            return;
        };
        let held: Vec<EngineEvent> = engine.open_prompts();
        let stale = self.bridge.lock().prompts.clear_requests();
        for tab in stale {
            self.publish_prompts(&tab);
        }
        let mapped: Vec<(TabId, EngineTabId)> = self
            .bridge
            .lock()
            .tabs
            .iter()
            .map(|(tab, engine_tab)| (tab.clone(), *engine_tab))
            .collect();
        for (tab, engine_tab) in mapped {
            let Ok(info) = engine.tab_info(engine_tab) else {
                self.unbind_tab(&tab);
                continue;
            };
            self.dispatch_quietly(Action::UpdatePage {
                tab: tab.clone(),
                update: PageUpdate {
                    url: (!info.url.is_empty()).then_some(info.url),
                    title: Some(info.title),
                    loading: Some(info.loading),
                    progress: Some(info.progress as f32),
                    can_go_back: Some(info.can_go_back),
                    can_go_forward: Some(info.can_go_forward),
                    audible: Some(info.audible),
                    ..PageUpdate::default()
                },
            });
            if let Ok(Some(prompt)) = engine.password_prompt(engine_tab) {
                self.bridge.lock().prompts.password(&tab, &prompt);
                self.publish_prompts(&tab);
            }
        }
        self.apply_events(held);
        self.mark_dirty();
    }
}

pub fn favicon_site_changed(icon_page: &str, url: &str) -> bool {
    let web = |u: &str| u.starts_with("https://") || u.starts_with("http://");
    if !web(url) || !web(icon_page) {
        return false;
    }
    ardia_state::omnibox::url::host_of(icon_page) != ardia_state::omnibox::url::host_of(url)
}

#[cfg(test)]
mod favicon_site_tests {
    use super::favicon_site_changed;

    #[test]
    fn a_tab_that_leaves_its_site_drops_the_old_icon() {
        assert!(favicon_site_changed(
            "https://x.com/home",
            "https://example.com/"
        ));
        assert!(!favicon_site_changed(
            "https://x.com/home",
            "https://x.com/explore"
        ));
        assert!(!favicon_site_changed(
            "https://www.x.com/",
            "https://x.com/"
        ));
        assert!(!favicon_site_changed("https://x.com/", "ardia://history"));
    }
}
