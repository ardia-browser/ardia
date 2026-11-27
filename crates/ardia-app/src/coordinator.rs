use std::cell::RefCell;
use std::collections::{HashMap, HashSet, VecDeque};
use std::future::Future;
use std::path::PathBuf;
use std::pin::Pin;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Weak};
use std::task::{Context, Poll};

use ardia_engine::{
    AutofillPromptAction, BrowserEngine, CastRoute, DownloadCommand, EngineBackend,
    EngineProfileId, EngineTabId, EngineWindowId, NativeView, NativeWindow, PasswordPromptAction,
    PermissionResult, Rect, Services,
};
use ardia_state::actions::{Action, ActionError, Outcome, PageUpdate};
use ardia_state::model::PageKind;
use ardia_state::tabs::FindState;
use ardia_state::windows::WindowKind;
use ardia_state::{BrowserStore, Interest, ProfileId, TabId, Topics, Update, WindowId};
use ardia_theme::IconTheme;
use ardia_ui::host_data::{
    CastPanel, ExtensionItem, ExtensionList, ExtensionPopupView, HostSignal, ImportProgress,
    SyncStatus,
};
use ardia_ui::{HostTabView, UiHost, UtilityWindowKind};
use gpui::AnyWindowHandle;
use parking_lot::Mutex;

use crate::events_pump::EngineFeed;
use crate::links::{LinkPlan, is_openable, plan_link};
use crate::main_thread::MainThread;
use crate::maps::{BiMap, ProfileMap, ProfileOwner};
use crate::prompts::{PromptBook, RequestKind};

pub type LocalTask = Pin<Box<dyn Future<Output = ()>>>;
pub type Spawner = Box<dyn Fn(LocalTask)>;
pub type Waker = Arc<dyn Fn() + Send + Sync>;
pub type Job = Box<dyn FnOnce(&AppCoordinator) + Send>;

const MAX_PUMP_ROUNDS: usize = 16;

#[derive(Clone, Debug, PartialEq)]
pub struct CoordinatorConfig {
    pub hosts_native_windows: bool,
    pub background: bool,
    pub onboarding: bool,
    pub default_frame: Rect,
    pub data_dir: Option<std::path::PathBuf>,
    pub scratch: bool,
    pub favicon_dir: Option<PathBuf>,
    pub delays_new_tab_pages: bool,
}

impl Default for CoordinatorConfig {
    fn default() -> Self {
        Self {
            hosts_native_windows: false,
            background: false,
            onboarding: false,
            default_frame: Rect::new(0.0, 0.0, 1360.0, 860.0),
            data_dir: None,
            scratch: false,
            favicon_dir: None,
            delays_new_tab_pages: false,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct HostedWindow {
    pub window: usize,
    pub view: usize,
}

#[derive(Clone, Debug, PartialEq)]
pub enum ShellEffect {
    OpenBrowserWindow {
        window: WindowId,
        kind: WindowKind,
        host: Option<HostedWindow>,
    },
    CloseWindow {
        window: WindowId,
    },
    FocusWindow {
        window: WindowId,
    },
    OpenUtility(UtilityWindowKind),
    ConfirmCloseWithDownloads {
        window: Option<WindowId>,
        request: u64,
        count: u32,
        quitting: bool,
    },
    ConfirmQuitWithDownloads {
        count: u32,
    },
    InstallMenu,
    Copy(String),
    Quit,
    SyntheticInput {
        window: WindowId,
        steps: Vec<crate::synthetic_input::Step>,
    },
    RunCommand {
        window: WindowId,
        window_number: Option<isize>,
        command: String,
    },
    AskControlPeer {
        question: crate::control_doorbell::Question,
        window: Option<WindowId>,
    },
    DismissControlPeer {
        ask: u64,
    },
    Confirm(crate::webkit::tabs::ConfirmRequest),
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Presentation {
    Activate,
    ShowInactive,
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct PumpReport {
    pub events: usize,
    pub jobs: usize,
    pub rounds: usize,
    pub refresh: Vec<WindowId>,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Applied {
    pub muted: bool,
    pub zoom: f64,
    pub pinned: bool,
    pub asleep: bool,
}

impl Default for Applied {
    fn default() -> Self {
        Self {
            muted: false,
            zoom: 1.0,
            pinned: false,
            asleep: false,
        }
    }
}

#[derive(Default)]
pub struct Bridge {
    pub windows: BiMap<WindowId, EngineWindowId>,
    pub tabs: BiMap<TabId, EngineTabId>,
    pub tab_homes: HashMap<TabId, WindowId>,
    pub profiles: ProfileMap,
    pub profile_paths: HashMap<ProfileId, String>,
    pub profile_waits: HashSet<ProfileId>,
    pub profile_failures: HashMap<ProfileId, u32>,
    pub pending_tabs: HashSet<TabId>,
    pub placeholders: HashMap<WindowId, TabId>,
    pub shown: HashMap<WindowId, Vec<TabId>>,
    pub engine_active: HashMap<WindowId, EngineTabId>,
    pub window_profiles: HashMap<WindowId, ProfileId>,
    pub applied: HashMap<TabId, Applied>,
    pub icon_themes: HashMap<TabId, IconTheme>,
    pub icon_urls: HashMap<TabId, String>,
    pub favicon_pages: HashMap<TabId, String>,
    pub icons: crate::favicons::IconCache,
    pub backdrops: crate::backdrop::BackdropCache,
    pub readers: crate::reader::ReaderBook,
    pub open_when_done: HashSet<String>,
    pub history_loaded: HashSet<ProfileId>,
    pub bookmark_sync: crate::bookmark_engine::BookmarkSync,
    pub sync_engine: Option<Arc<crate::sync_engine::SyncEngine>>,
    pub shared_folders: Option<Arc<crate::shared_folders::SharedFolders>>,
    pub page_icons: HashMap<String, Option<Arc<gpui::Image>>>,
    pub page_icon_queue: HashMap<ProfileId, Vec<String>>,
    pub file_icons: HashMap<String, Option<Arc<gpui::Image>>>,
    pub page_overlays: crate::page_overlays::PageOverlayBook,
    pub settings_data: crate::settings_data::SettingsData,
    pub settings_services: crate::settings_services::SettingsServices,
    pub program_control: crate::program_control::ProgramControlBook,
    pub control_gate: Arc<crate::control_doorbell::ControlGate>,
    pub prompts: PromptBook,
    pub site: crate::site::SiteBook,
    pub translate: crate::translate::TranslateBook,
    pub blocker: crate::content_blocker::BlockerBook,
    pub devtools_open: HashSet<TabId>,
    pub closing_windows: HashSet<EngineWindowId>,
    pub closing_tabs: HashSet<EngineTabId>,
    pub leave_confirmed: HashSet<EngineTabId>,
    pub asking_to_leave: HashSet<EngineTabId>,
    pub closing_rows: HashSet<TabId>,
    pub strays: HashMap<WindowId, EngineTabId>,
    pub gpui: HashMap<WindowId, AnyWindowHandle>,
    pub gpui_requested: HashSet<WindowId>,
    pub cast_routes: Vec<CastRoute>,
    pub extension_lists: HashMap<ProfileId, Vec<(ExtensionItem, bool)>>,
    pub extension_loading: HashSet<ProfileId>,
    pub extension_watched: HashSet<ProfileId>,
    pub action_states: HashMap<TabId, ardia_engine::ExtensionActionStates>,
    pub toolbar_snapshots: HashMap<WindowId, (Option<TabId>, ExtensionList)>,
    pub snapshots_pending: HashSet<WindowId>,
    pub popups: HashMap<WindowId, crate::extensions::PopupEntry>,
    pub popup_tabs: HashMap<EngineTabId, WindowId>,
    pub side_panels: HashMap<WindowId, crate::extensions::SidePanelEntry>,
    pub pin_dialogs: HashSet<WindowId>,
    pub media_access: HashMap<TabId, ardia_engine::MediaAccess>,
    pub media: crate::media::MediaState,
    pub share: crate::screen_share::ShareState,
    pub unlocked: crate::import_run::UnlockedKeys,
    pub scrolled_down: HashSet<TabId>,
    pub back_to_new_tab: HashSet<TabId>,
    pub new_tab_shown: HashMap<TabId, (String, String, Option<String>)>,
    pub import: Option<ImportProgress>,
    pub import_runs: u64,
    pub import_cancel: Option<std::sync::Arc<std::sync::atomic::AtomicBool>>,
    pub import_browsers: Option<Vec<ardia_ui::host_data::ImportBrowser>>,
    pub sync_status: SyncStatus,
    pub sync_refreshing: bool,
    pub cast_screens: HashSet<i32>,
    pub imported_folders: Option<crate::bookmark_merge::ImportedFolders>,
    pub window_failures: HashMap<WindowId, u32>,
    pub menu_signature: Option<u64>,
    pub replace_notes: HashMap<TabId, ardia_ui::host::ReplaceNote>,
    pub pin_handoffs: crate::pin_handoff::Handoffs,
    pub webkit: crate::webkit::tabs::WebKitBook,
    pub lifecycle: crate::tab_lifecycle::LifecycleBook,
}

pub(crate) struct EngineSide {
    pub(crate) engine: Arc<dyn BrowserEngine>,
    pub(crate) hosted: HashMap<EngineWindowId, (NativeWindow, NativeView)>,
    pub(crate) views: HashMap<EngineTabId, NativeView>,
    pub(crate) devtools: HashMap<EngineTabId, NativeView>,
    spawner: Option<Spawner>,
    parked: Vec<LocalTask>,
}

pub struct AppCoordinator {
    me: Weak<AppCoordinator>,
    pub(crate) store: Arc<BrowserStore>,
    backend: EngineBackend,
    pub(crate) config: CoordinatorConfig,
    side: MainThread<RefCell<EngineSide>>,
    pub(crate) bridge: ardia_profile::strict::Mutex<Bridge>,
    effects: Mutex<Vec<ShellEffect>>,
    jobs: Mutex<VecDeque<Job>>,
    pub(crate) feed: Arc<EngineFeed>,
    waker: Mutex<Option<Waker>>,
    touched: Mutex<HashSet<WindowId>>,
    dirty: AtomicBool,
    pub(crate) shutting_down: Arc<AtomicBool>,
    pub(crate) started: AtomicBool,
    pending_urls: Mutex<Vec<String>>,
    platform_focus: Mutex<Option<WindowId>>,
    store_subscription: Mutex<Option<ardia_state::Subscription>>,
    pub(crate) signal: HostSignal,
    pub(crate) icon_disk: Option<crate::favicons::DiskCache>,
    pub(crate) plugins: Mutex<Option<Arc<crate::plugins::PluginService>>>,
}

impl std::fmt::Debug for AppCoordinator {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let bridge = self.bridge.lock();
        f.debug_struct("AppCoordinator")
            .field("backend", &self.backend)
            .field("windows", &bridge.windows.len())
            .field("tabs", &bridge.tabs.len())
            .finish()
    }
}

fn noop_poll(task: &mut LocalTask) -> Poll<()> {
    let waker = futures::task::noop_waker();
    let mut context = Context::from_waker(&waker);
    task.as_mut().poll(&mut context)
}

impl AppCoordinator {
    pub fn new(
        store: Arc<BrowserStore>,
        engine: Arc<dyn BrowserEngine>,
        config: CoordinatorConfig,
    ) -> Arc<Self> {
        let shutting_down = Arc::new(AtomicBool::new(false));
        let feed = EngineFeed::attach(engine.as_ref(), store.clone(), shutting_down.clone());
        let backend = engine.backend();
        let coordinator = Arc::new_cyclic(|me: &Weak<AppCoordinator>| AppCoordinator {
            icon_disk: config.favicon_dir.clone().and_then(|dir| {
                let me = me.clone();
                crate::favicons::DiskCache::start(dir, move |result| {
                    if let Some(coordinator) = me.upgrade() {
                        coordinator.post(move |coordinator| coordinator.disk_icon_result(result));
                    }
                })
            }),
            me: me.clone(),
            store,
            backend,
            config,
            side: MainThread::new(RefCell::new(EngineSide {
                engine,
                hosted: HashMap::new(),
                views: HashMap::new(),
                devtools: HashMap::new(),
                spawner: None,
                parked: Vec::new(),
            })),
            bridge: ardia_profile::strict::Mutex::new(Bridge::default()),
            effects: Mutex::new(Vec::new()),
            jobs: Mutex::new(VecDeque::new()),
            feed,
            waker: Mutex::new(None),
            touched: Mutex::new(HashSet::new()),
            dirty: AtomicBool::new(true),
            shutting_down,
            started: AtomicBool::new(false),
            pending_urls: Mutex::new(Vec::new()),
            platform_focus: Mutex::new(None),
            store_subscription: Mutex::new(None),
            signal: HostSignal::new(),
            plugins: Mutex::new(None),
        });
        let weak = Arc::downgrade(&coordinator);
        let subscription =
            coordinator
                .store
                .subscribe(Interest::Topics(Topics::ALL), move |update| {
                    if let Some(coordinator) = weak.upgrade() {
                        coordinator.note_store_update(update);
                    }
                });
        *coordinator.store_subscription.lock() = Some(subscription);
        let weak = Arc::downgrade(&coordinator);
        coordinator.feed.on_ready(move || {
            if let Some(coordinator) = weak.upgrade() {
                coordinator.wake();
            }
        });
        coordinator
    }

    pub fn weak(&self) -> Weak<AppCoordinator> {
        self.me.clone()
    }

    pub fn store(&self) -> &Arc<BrowserStore> {
        &self.store
    }

    pub fn backend(&self) -> EngineBackend {
        self.backend
    }

    pub fn config(&self) -> &CoordinatorConfig {
        &self.config
    }

    pub fn engine(&self) -> Option<Arc<dyn BrowserEngine>> {
        self.side.get().map(|side| side.borrow().engine.clone())
    }

    pub(crate) fn side(&self) -> Option<&RefCell<EngineSide>> {
        self.side.get()
    }

    pub fn is_shutting_down(&self) -> bool {
        self.shutting_down.load(Ordering::Acquire)
    }

    pub fn begin_shutdown(&self) {
        self.shutting_down.store(true, Ordering::Release);
        crate::webkit::page::flush_history();
        crate::sync_engine::ui_bridge::shutdown(self);
        if let Some(plugins) = self.plugins.lock().take() {
            plugins.stop_all();
        }
    }

    pub fn start_plugins(self: &Arc<Self>, data_dir: &std::path::Path, scratch: bool) {
        let service = crate::plugins::start(self, data_dir, scratch);
        *self.plugins.lock() = Some(service);
    }

    pub fn plugin_service(&self) -> Option<Arc<crate::plugins::PluginService>> {
        self.plugins.lock().clone()
    }

    pub fn set_waker(&self, waker: impl Fn() + Send + Sync + 'static) {
        *self.waker.lock() = Some(Arc::new(waker));
        self.wake();
    }

    pub fn wake(&self) {
        let waker = self.waker.lock().clone();
        if let Some(waker) = waker {
            waker();
        }
    }

    pub fn attach_spawner(&self, spawner: impl Fn(LocalTask) + 'static) {
        let Some(side) = self.side.get() else {
            log::error!("the spawner must be attached on the main thread");
            return;
        };
        let parked = {
            let mut side = side.borrow_mut();
            side.spawner = Some(Box::new(spawner));
            std::mem::take(&mut side.parked)
        };
        let side = side.borrow();
        if let Some(spawner) = side.spawner.as_ref() {
            for task in parked {
                spawner(task);
            }
        }
    }

    pub(crate) fn spawn(&self, task: impl Future<Output = ()> + 'static) {
        let Some(side) = self.side.get() else {
            log::error!("async engine work was started off the main thread and dropped");
            return;
        };
        let mut task: LocalTask = Box::pin(task);
        {
            let side = side.borrow();
            if let Some(spawner) = side.spawner.as_ref() {
                spawner(task);
                return;
            }
        }
        if noop_poll(&mut task).is_pending() {
            side.borrow_mut().parked.push(task);
        }
    }

    pub fn poll_parked(&self) -> usize {
        let Some(side) = self.side.get() else {
            return 0;
        };
        let parked = std::mem::take(&mut side.borrow_mut().parked);
        let mut still = Vec::new();
        for mut task in parked {
            if noop_poll(&mut task).is_pending() {
                still.push(task);
            }
        }
        let left = still.len();
        side.borrow_mut().parked.extend(still);
        left
    }

    pub fn post(&self, job: impl FnOnce(&AppCoordinator) + Send + 'static) {
        self.jobs.lock().push_back(Box::new(job));
        self.wake();
    }

    pub(crate) fn effect(&self, effect: ShellEffect) {
        self.effects.lock().push(effect);
        self.wake();
    }

    pub fn take_effects(&self) -> Vec<ShellEffect> {
        std::mem::take(&mut *self.effects.lock())
    }

    pub(crate) fn mark_dirty(&self) {
        self.dirty.store(true, Ordering::Release);
        self.wake();
    }

    pub(crate) fn touch(&self, window: WindowId) {
        self.touched.lock().insert(window);
    }

    fn note_store_update(&self, update: &Update) {
        {
            let mut touched = self.touched.lock();
            touched.extend(update.changes.windows.iter().cloned());
            for tab in &update.changes.tabs {
                if let Some(tab) = update.state.tab(tab.as_str()) {
                    touched.insert(tab.window_id.clone());
                }
            }
        }
        let structural = update.changes.topics.intersects(
            Topics::WINDOWS
                | Topics::TABS
                | Topics::SPLITS
                | Topics::PROFILES
                | Topics::FOCUS
                | Topics::CLOSED,
        );
        if structural {
            self.dirty.store(true, Ordering::Release);
        }
        if update.changes.topics.intersects(Topics::SETTINGS) {
            self.post(|coordinator| coordinator.sync_control_server());
            self.post(|coordinator| coordinator.note_lifecycle_settings());
        }
        if update.changes.topics.intersects(Topics::BOOKMARKS) {
            self.post(|coordinator| coordinator.push_engine_bookmarks());
        }
        self.wake();
    }

    pub fn queue_urls(&self, urls: impl IntoIterator<Item = String>) {
        self.pending_urls.lock().extend(urls);
        self.wake();
    }

    pub fn start(&self) {
        if let Some(engine) = self.engine()
            && engine.is_started()
            && !self.started.swap(true, Ordering::AcqRel)
        {
            self.boot_session();
        }
        self.pump();
    }

    pub(crate) fn boot_session(&self) {
        crate::app_icon_choice::restore();
        crate::system_probe::prewarm_login_item();
        let launch_consent = ardia_telemetry::consent_now();
        std::thread::spawn(move || {
            if crate::system_probe::is_default_browser() {
                ardia_telemetry::counts::add_for(
                    launch_consent.as_ref(),
                    "launches_as_default_browser",
                    1,
                );
            }
        });
        crate::webkit::content_rules::start(self.config.data_dir.as_deref(), None);
        self.install_webkit_services();
        crate::mouse_shortcuts::install(self.weak());
        crate::scroll_zoom::install(self.weak());
        self.install_page_swipes();
        let state = self.store.snapshot();
        let has_browser = state.windows.values().any(|w| w.kind.has_tabs());
        if !has_browser {
            self.dispatch_quietly(Action::OpenLastWindowOrNew);
        }
        self.effect(ShellEffect::InstallMenu);
        self.start_live();
        self.start_tab_lifecycle();
        if self.config.onboarding && !self.config.background {
            let fresh = self
                .config
                .data_dir
                .as_deref()
                .and_then(crate::onboarding_doc::read)
                .is_none_or(|record| {
                    !record.completed && record.step.as_deref().is_none_or(|step| step == "intro")
                });
            self.effect(ShellEffect::OpenUtility(if fresh {
                UtilityWindowKind::Intro
            } else {
                UtilityWindowKind::Onboarding
            }));
        }
        self.mark_dirty();
    }

    pub fn is_started(&self) -> bool {
        self.started.load(Ordering::Acquire)
    }

    pub fn pump(&self) -> PumpReport {
        let mut report = PumpReport::default();
        if !self.side.is_owner() {
            return report;
        }
        for _ in 0..MAX_PUMP_ROUNDS {
            let events = self.feed.take();
            let jobs: Vec<Job> = self.jobs.lock().drain(..).collect();
            let urls: Vec<String> = if self.is_started() {
                std::mem::take(&mut *self.pending_urls.lock())
            } else {
                Vec::new()
            };
            let dirty = self.dirty.swap(false, Ordering::AcqRel);
            if events.is_empty() && jobs.is_empty() && urls.is_empty() && !dirty {
                break;
            }
            report.rounds += 1;
            report.events += events.len();
            report.jobs += jobs.len();
            self.apply_events(events);
            for job in jobs {
                job(self);
            }
            for url in urls {
                self.open_url(&url);
            }
            if self.is_started() {
                self.reconcile();
            }
        }
        if self.is_started() {
            self.tend_readers();
            self.load_engine_history();
            self.load_engine_bookmarks();
            crate::sync_engine::ui_bridge::engine(self);
        }
        let busy = !self.feed.is_idle()
            || !self.jobs.lock().is_empty()
            || self.dirty.load(Ordering::Acquire);
        if busy {
            self.wake();
        }
        report.refresh = self.touched.lock().drain().collect();
        report
    }

    pub(crate) fn dispatch_quietly(&self, action: Action) -> Option<Outcome> {
        let name = action_name(&action);
        match self.store.dispatch(action) {
            Ok(outcome) => Some(outcome),
            Err(problem) => {
                log::debug!("{name} changed nothing: {problem}");
                None
            }
        }
    }

    pub fn dispatch_action(&self, action: Action) -> Result<Outcome, ActionError> {
        if let Action::ActivateTab { tab } = &action
            && self.hands_off_pin(tab)
        {
            return Ok(Outcome::default());
        }
        let action = match action {
            Action::ReturnToPinnedUrl { tab } => self.return_to_pinned(tab)?,
            other => other,
        };
        if self.guard_shared_removal(&action) {
            return Ok(Outcome::default());
        }
        if self.side.is_owner() && self.warn_before(&action) {
            return Ok(Outcome::default());
        }
        if let Action::Navigate { tab, .. } = &action {
            self.note_leaving_new_tab(tab);
        }
        match &action {
            Action::RemoveHistory { profile, url } => {
                self.forget_history_in_engine(profile, std::slice::from_ref(url))
            }
            Action::RemoveHistoryPages { profile, urls } => {
                self.forget_history_in_engine(profile, urls)
            }
            Action::UpdateSettings {
                patch,
                from_sync: false,
            } => ardia_ui::settings::panes::note_settings_picks(patch),
            Action::ClearRecentlyClosed { window } => {
                let gone = ardia_state::closed::recently_closed_to_clear(
                    &self.store.snapshot(),
                    window.as_ref(),
                )
                .len() as u64;
                if gone > 0 {
                    ardia_telemetry::counts::count("recently_closed_clears");
                    ardia_telemetry::counts::add("recently_closed_entries_cleared", gone);
                }
            }
            _ => {}
        }
        if let Action::CloseWindow { window } = &action {
            if self.is_shutting_down() {
                log::debug!("{window} stays in the session while Ardia quits");
                return Ok(Outcome::default());
            }
            if self.close_through_engine(window) {
                return Ok(Outcome::default());
            }
        }
        let closing = self.pages_closed_by(&action);
        if self.side.is_owner() && self.ask_before_closing(&action, &closing) {
            return Ok(Outcome::default());
        }
        let intent = Intent::of(&action, self);
        let counted = dispatched_counts(&action);
        let outcome = self.store.dispatch(action)?;
        for (field, by) in counted {
            ardia_telemetry::counts::add(field, by);
        }
        self.follow_through(intent, &outcome);
        self.retire_unloaded(&closing.unloaded);
        if self.side.is_owner() && self.is_started() {
            self.reconcile();
        } else {
            self.mark_dirty();
        }
        Ok(outcome)
    }

    fn follow_through(&self, intent: Intent, outcome: &Outcome) {
        match intent {
            Intent::None => {}
            Intent::Navigate(tab) => self.load_navigation(&tab),
            Intent::Duplicate(source) => {
                if let Some(copy) = outcome.tab.clone() {
                    self.duplicate_in_engine(&source, &copy);
                }
            }
            Intent::DeleteProfile(Some(profile)) => {
                if let Some(engine) = self.engine() {
                    let reply = engine.delete_profile(profile);
                    let consent = ardia_telemetry::consent_now();
                    self.spawn(async move {
                        let result = reply.await;
                        let removed = matches!(result, Ok(true));
                        ardia_telemetry::counts::add_for(
                            consent.as_ref(),
                            if removed {
                                "profile_data_removed"
                            } else {
                                "profile_data_left"
                            },
                            1,
                        );
                        if let Err(problem) = result {
                            log::warn!("the engine kept a deleted profile's data: {problem}");
                        }
                    });
                }
            }
            Intent::DeleteProfile(None) => {}
        }
    }

    pub(crate) fn pages_closed_by(&self, action: &Action) -> ClosingPages {
        if !matches!(
            action,
            Action::CloseTabs { .. }
                | Action::CloseSyncedTabs { .. }
                | Action::ClearUnpinned { .. }
                | Action::CloseDuplicateTabs { .. }
                | Action::CloseGroup { .. }
                | Action::DeleteGroup { .. }
        ) {
            return ClosingPages::default();
        }
        let state = self.store.snapshot();
        let Ok((next, _)) = state.reduce(
            action.clone(),
            ardia_state::store::now_ms(),
            self.store.ids(),
        ) else {
            return ClosingPages::default();
        };
        let mut pages = ClosingPages::default();
        for (id, before) in state.tabs.iter() {
            match next.tabs.get(id) {
                None => pages.removed.push(id.clone()),
                Some(after)
                    if before.page.kind != PageKind::Asleep
                        && after.page.kind == PageKind::Asleep =>
                {
                    pages.unloaded.push(id.clone())
                }
                Some(_) => {}
            }
        }
        pages.removed.sort();
        pages.unloaded.sort();
        pages
    }

    fn ask_before_closing(&self, action: &Action, closing: &ClosingPages) -> bool {
        let all = closing.all();
        if all.is_empty() {
            return false;
        }
        let Some(engine) = self.engine().filter(|engine| engine.is_started()) else {
            return false;
        };
        let live: Vec<(TabId, EngineTabId)> = {
            let bridge = self.bridge.lock();
            all.iter()
                .filter_map(|tab| {
                    bridge
                        .tabs
                        .by_left(tab)
                        .map(|engine_tab| (tab.clone(), *engine_tab))
                })
                .filter(|(_, engine_tab)| !bridge.leave_confirmed.contains(engine_tab))
                .collect()
        };
        let still_asking = {
            let bridge = self.bridge.lock();
            live.iter()
                .find(|(_, engine_tab)| bridge.asking_to_leave.contains(engine_tab))
                .map(|(tab, _)| tab.clone())
        };
        if let Some(tab) = still_asking {
            log::info!("{tab} is still asking before it closes, so it comes forward");
            self.dispatch_quietly(Action::ActivateTab { tab });
            self.mark_dirty();
            return true;
        }
        let asking: Vec<(TabId, EngineTabId)> = live
            .into_iter()
            .filter(|(_, engine_tab)| {
                engine
                    .tab_info(*engine_tab)
                    .is_ok_and(|info| info.asks_before_leaving)
            })
            .collect();
        if asking.is_empty() {
            return false;
        }
        let fronts = self.front_tabs(&all);
        {
            let mut bridge = self.bridge.lock();
            bridge
                .asking_to_leave
                .extend(asking.iter().map(|(_, engine_tab)| *engine_tab));
            bridge.closing_rows.extend(all.iter().cloned());
        }
        let me = self.weak();
        let action = action.clone();
        self.spawn(async move {
            let mut staying = Vec::new();
            for (tab, engine_tab) in asking {
                let Some(coordinator) = me.upgrade() else {
                    return;
                };
                coordinator.dispatch_quietly(Action::ActivateTab { tab: tab.clone() });
                if coordinator.is_started() {
                    coordinator.reconcile();
                }
                log::info!("{tab} asks before it closes");
                let reply = engine.ask_before_leaving(engine_tab);
                drop(coordinator);
                let answer = reply.await;
                log::info!("{tab} answered {answer:?}");
                let leave = answer.unwrap_or(true);
                let Some(coordinator) = me.upgrade() else {
                    return;
                };
                {
                    let mut bridge = coordinator.bridge.lock();
                    bridge.asking_to_leave.remove(&engine_tab);
                    if leave {
                        bridge.leave_confirmed.insert(engine_tab);
                    } else {
                        bridge.closing_rows.remove(&tab);
                    }
                }
                if leave {
                    coordinator.retire_engine_tab(&tab, engine_tab, &engine);
                    coordinator.mark_dirty();
                } else {
                    staying.push(tab);
                }
            }
            if let Some(coordinator) = me.upgrade() {
                coordinator.finish_closing(action, all, &staying, fronts);
            }
        });
        true
    }

    fn front_tabs(&self, closing: &[TabId]) -> Vec<TabId> {
        let state = self.store.snapshot();
        let mut fronts: Vec<TabId> = Vec::new();
        for tab in closing {
            let front = state
                .tab(tab.as_str())
                .and_then(|listed| state.active_tab(listed.window_id.as_str()))
                .map(|front| front.id.clone());
            if let Some(front) = front
                && !closing.contains(&front)
                && !fronts.contains(&front)
            {
                fronts.push(front);
            }
        }
        fronts
    }

    fn finish_closing(
        &self,
        action: Action,
        all: Vec<TabId>,
        staying: &[TabId],
        fronts: Vec<TabId>,
    ) {
        let state = self.store.snapshot();
        let expected: Vec<TabId> = all
            .iter()
            .filter(|tab| !staying.contains(tab) && state.tab(tab.as_str()).is_some())
            .cloned()
            .collect();
        if !expected.is_empty() {
            if staying.is_empty() {
                for front in fronts
                    .iter()
                    .filter(|front| state.tab(front.as_str()).is_some())
                {
                    self.dispatch_quietly(Action::ActivateTab { tab: front.clone() });
                }
            }
            let last_closes_window = matches!(
                action,
                Action::CloseTabs {
                    last_closes_window: true,
                    ..
                }
            );
            let action = self.closing_after_asking(action, &expected, staying, last_closes_window);
            if let Some(action) = action {
                let name = action_name(&action);
                if let Err(problem) =
                    crate::close_warnings::without_warnings(|| self.dispatch_action(action))
                {
                    log::debug!("{name} changed nothing after asking: {problem}");
                }
            }
        }
        {
            let mut bridge = self.bridge.lock();
            for tab in &all {
                bridge.closing_rows.remove(tab);
            }
        }
        self.mark_dirty();
    }

    fn closing_after_asking(
        &self,
        action: Action,
        expected: &[TabId],
        staying: &[TabId],
        last_closes_window: bool,
    ) -> Option<Action> {
        let keeps_stayers = |candidate: &Action| -> bool {
            self.pages_closed_by(candidate)
                .all()
                .iter()
                .all(|tab| !staying.contains(tab))
        };
        let matches_expected =
            |candidate: &Action| same_tabs(&self.pages_closed_by(candidate).all(), expected);
        let replay = match &action {
            Action::CloseGroup { group } if !staying.is_empty() => {
                self.dispatch_quietly(Action::RemoveFromGroups {
                    tabs: staying.to_vec(),
                });
                Some(Action::CloseGroup {
                    group: group.clone(),
                })
            }
            _ if staying.is_empty() => Some(action),
            _ => None,
        };
        if let Some(replay) =
            replay.filter(|candidate| matches_expected(candidate) && keeps_stayers(candidate))
        {
            return Some(replay);
        }
        let close = |tabs: Vec<TabId>| Action::CloseTabs {
            tabs,
            last_closes_window,
        };
        let everything = close(expected.to_vec());
        if keeps_stayers(&everything) {
            return Some(everything);
        }
        let safe: Vec<TabId> = expected
            .iter()
            .filter(|tab| keeps_stayers(&close(vec![(*tab).clone()])))
            .cloned()
            .collect();
        let safe = close(safe);
        if keeps_stayers(&safe) {
            return Some(safe);
        }
        log::info!(
            "closing the rest would take a page that stayed with it, so nothing more closes"
        );
        None
    }

    fn retire_unloaded(&self, tabs: &[TabId]) {
        if tabs.is_empty() {
            return;
        }
        let Some(engine) = self.engine() else {
            return;
        };
        let state = self.store.snapshot();
        for tab in tabs.iter().filter(|tab| state.tab(tab.as_str()).is_some()) {
            if let Some(engine_tab) = self.engine_tab(tab) {
                self.retire_engine_tab(tab, engine_tab, &engine);
            }
        }
    }

    pub fn follow_platform_focus(&self, window: Option<&WindowId>) {
        let changed = {
            let mut last = self.platform_focus.lock();
            let changed = last.as_ref() != window;
            *last = window.cloned();
            changed
        };
        if changed {
            self.focus_browser_window(window);
            if let (Some(_), Some(hub)) = (window, crate::live::hub()) {
                hub.note_focus();
            }
        }
    }

    pub fn platform_window(&self) -> Option<WindowId> {
        #[cfg(target_os = "macos")]
        if self.config.hosts_native_windows {
            return self.app_main_window();
        }
        self.platform_focus.lock().clone()
    }

    pub fn focus_platform_window(&self) {
        let window = self.platform_window();
        self.focus_browser_window(window.as_ref());
    }

    pub fn command_window(&self, state: &ardia_state::BrowserState) -> Option<WindowId> {
        self.platform_window()
            .filter(|window| {
                state
                    .window(window.as_str())
                    .is_some_and(|w| w.kind.has_tabs())
            })
            .or_else(|| crate::menu_bridge::focused_window(state))
    }

    #[cfg(target_os = "macos")]
    fn app_main_window(&self) -> Option<WindowId> {
        let main = crate::hosted_input::main_window()?;
        let engine_window = {
            let side = self.side.get()?.try_borrow().ok()?;
            side.hosted
                .iter()
                .find(|(_, (native, _))| native.handle().as_ptr() as usize == main)
                .map(|(engine_window, _)| *engine_window)?
        };
        self.bridge.lock().windows.by_right(&engine_window).cloned()
    }

    fn focus_browser_window(&self, window: Option<&WindowId>) {
        let Some(window) = window else {
            return;
        };
        let state = self.store.snapshot();
        let browser = state
            .window(window.as_str())
            .is_some_and(|w| w.kind.has_tabs());
        if browser && state.focus_order.first() != Some(window) {
            self.dispatch_quietly(Action::FocusWindow {
                window: window.clone(),
            });
        }
    }

    fn close_through_engine(&self, window: &WindowId) -> bool {
        if self.is_shutting_down() || !self.side.is_owner() {
            return false;
        }
        let Some(engine_window) = self.bridge.lock().windows.by_left(window).copied() else {
            return false;
        };
        let Some(engine) = self.engine().filter(|engine| engine.is_started()) else {
            return false;
        };
        self.bridge.lock().closing_windows.insert(engine_window);
        match engine.close_window(engine_window) {
            Ok(()) => true,
            Err(problem) => {
                log::warn!("the engine couldn't close {window}: {problem}");
                self.bridge.lock().closing_windows.remove(&engine_window);
                self.bridge.lock().windows.remove_left(window);
                false
            }
        }
    }

    fn load_navigation(&self, tab: &TabId) {
        let state = self.store.snapshot();
        let Some(url) = state
            .tab(tab.as_str())
            .and_then(|t| t.live.navigation.clone().or_else(|| Some(t.url.clone())))
            .filter(|url| !url.is_empty())
        else {
            return;
        };
        self.load_into_tab(tab, &url);
    }

    fn return_to_pinned(&self, tab: TabId) -> Result<Action, ActionError> {
        let state = self.store.snapshot();
        let listed = state
            .tab(tab.as_str())
            .ok_or_else(|| ActionError::NoTab(tab.to_string()))?;
        let home = listed
            .pinned_url
            .clone()
            .filter(|home| !home.is_empty())
            .ok_or(ActionError::Invalid("this tab has no pinned address"))?;
        if ardia_state::omnibox::url::same_page(&listed.url, &home) {
            return Err(ActionError::Invalid(
                "the tab is already at its pinned address",
            ));
        }
        Ok(Action::Navigate { tab, input: home })
    }

    fn load_into_tab(&self, tab: &TabId, url: &str) {
        if url.is_empty() {
            return;
        }
        if let Some(page) = ardia_ui::InternalPage::of(url) {
            self.show_internal_page(tab, &page);
            return;
        }
        if self.leaves_internal_page_in_place(tab, url) {
            return;
        }
        if self.webkit_load(tab, url) {
            return;
        }
        let engine_tab = self.bridge.lock().tabs.by_left(tab).copied();
        if let (Some(engine_tab), Some(engine)) = (engine_tab, self.engine())
            && let Err(problem) = engine.load_url(engine_tab, url, true)
        {
            log::warn!("{tab} couldn't load {url}: {problem}");
        }
    }

    pub fn open_url(&self, url: &str) {
        self.open_url_at(url, 0);
    }

    pub fn open_url_at(&self, url: &str, batch_index: usize) {
        if !is_openable(url) {
            ardia_telemetry::counts::count("incoming_links_refused");
            log::warn!("ignored a link that can't be opened");
            return;
        }
        let state = self.store.snapshot();
        let url = url.trim().to_owned();
        if crate::links::runs_javascript(&url) && !state.settings.allow_javascript_from_apple_events
        {
            log::info!("refused a javascript: link from another app");
            return;
        }
        let source = crate::link_sources::take(&url);
        if let Some(dir) = self.config.data_dir.as_deref() {
            crate::link_sources::note(dir, &source);
        }
        match plan_link(&state, &url, &source) {
            LinkPlan::NewTab {
                window,
                profile,
                group,
            } => {
                let index = group
                    .is_none()
                    .then(|| crate::links::app_link_index(&state, &window, &profile, batch_index))
                    .flatten();
                let outcome = self.dispatch_quietly(Action::NewTab {
                    window: window.clone(),
                    tab: ardia_state::NewTab {
                        url: Some(url),
                        profile: Some(profile),
                        index,
                        ..ardia_state::NewTab::default()
                    },
                });
                if let (Some(group), Some(tab)) = (group, outcome.and_then(|o| o.tab))
                    && self
                        .dispatch_quietly(Action::AddToGroup {
                            group,
                            tabs: vec![tab],
                        })
                        .is_some()
                {
                    ardia_telemetry::counts::count("air_traffic_group_links");
                }
                self.dispatch_quietly(Action::FocusWindow {
                    window: window.clone(),
                });
                self.effect(ShellEffect::FocusWindow { window });
            }
            LinkPlan::NewWindow { kind, profile } => {
                self.dispatch_quietly(Action::OpenWindow {
                    kind,
                    profile: Some(profile),
                    url: Some(url),
                    frame: None,
                });
            }
        }
        self.mark_dirty();
    }

    pub fn engine_tab(&self, tab: &TabId) -> Option<EngineTabId> {
        self.bridge.lock().tabs.by_left(tab).copied()
    }

    pub fn engine_is_quitting(&self) -> bool {
        let Some(engine) = self.engine() else {
            return true;
        };
        if !engine.is_started() {
            return true;
        }
        match engine.query(ardia_engine::EngineQuery::KeepAliveState) {
            Ok(state) => state
                .as_str()
                .is_some_and(|state| state.contains("trying_to_quit=1")),
            Err(_) => self.backend == EngineBackend::Mac,
        }
    }

    pub fn engine_window(&self, window: &WindowId) -> Option<EngineWindowId> {
        self.bridge.lock().windows.by_left(window).copied()
    }

    pub fn engine_profile(&self, profile: &ProfileId) -> Option<EngineProfileId> {
        self.bridge.lock().profiles.engine_of(profile)
    }

    pub(crate) fn profile_owner(&self, engine_profile: EngineProfileId) -> Option<Owner> {
        if let Some(owner) = self.bridge.lock().profiles.owner(engine_profile).cloned() {
            return Some(Owner {
                owner,
                certain: true,
            });
        }
        let info = self.engine()?.profile_info(engine_profile).ok()?;
        if !info.off_the_record {
            return None;
        }
        let state = self.store.snapshot();
        let Some(original) = self.private_original(&state, &info.path) else {
            log::info!("{engine_profile} is private, but its own profile isn't known yet");
            return Some(Owner {
                owner: ProfileOwner::Private(state.last_active_profile()),
                certain: false,
            });
        };
        let owner = ProfileOwner::Private(original);
        self.bridge
            .lock()
            .profiles
            .note_owner(engine_profile, owner.clone());
        Some(Owner {
            owner,
            certain: true,
        })
    }

    fn private_original(&self, state: &ardia_state::BrowserState, path: &str) -> Option<ProfileId> {
        if path.is_empty() {
            return None;
        }
        let private = std::path::Path::new(path);
        let by_path = state
            .profile_order
            .iter()
            .filter(|profile| !profile.is_incognito() && self.engine_profile(profile).is_some())
            .filter_map(|profile| {
                let own = self.service_profile_dir(profile)?;
                (!own.is_empty() && private.starts_with(&own)).then(|| (own.len(), profile.clone()))
            })
            .max_by_key(|(length, _)| *length)
            .map(|(_, profile)| profile);
        by_path.or_else(|| {
            let names: Vec<&std::ffi::OsStr> = [
                private.file_name(),
                private.parent().and_then(std::path::Path::file_name),
            ]
            .into_iter()
            .flatten()
            .collect();
            state
                .profile_order
                .iter()
                .filter(|profile| !profile.is_incognito())
                .find(|profile| {
                    let folder = state.engine_profile(profile);
                    let chromium = crate::reconcile::chromium_profile_folder(&folder);
                    names.iter().any(|name| {
                        *name == std::ffi::OsStr::new(&folder)
                            || *name == std::ffi::OsStr::new(&chromium)
                    })
                })
                .cloned()
        })
    }

    pub(crate) fn engine_profile_of(&self, tab: &TabId) -> Option<EngineProfileId> {
        let profile = self
            .store
            .snapshot()
            .tab(tab.as_str())
            .map(|t| t.profile_id.clone())?;
        self.engine_profile(&profile)
    }

    pub fn gpui_window(&self, window: &WindowId) -> Option<AnyWindowHandle> {
        self.bridge.lock().gpui.get(window).copied()
    }

    pub fn cast_routes(&self) -> Vec<CastRoute> {
        self.bridge.lock().cast_routes.clone()
    }

    pub fn held_prompts(&self) -> Vec<ardia_engine::EngineEvent> {
        self.bridge.lock().prompts.held()
    }

    pub fn blocked_popups(&self, tab: &TabId) -> Vec<ardia_engine::BlockedPopup> {
        self.bridge.lock().prompts.blocked_popups(tab).to_vec()
    }

    pub fn open_blocked_popup(&self, tab: &TabId, popup_id: &str, always: bool) -> bool {
        if crate::webkit::page::has(tab) {
            return self.open_webkit_blocked_popup(tab, popup_id, always);
        }
        let popup = self.bridge.lock().prompts.take_popup(tab, popup_id);
        match (popup, self.engine_tab(tab), self.engine()) {
            (Some(popup), Some(engine_tab), Some(engine)) => engine
                .open_blocked_popup(engine_tab, &popup.id, always)
                .is_ok(),
            _ => false,
        }
    }

    pub fn devtools_open(&self, tab: &TabId) -> bool {
        self.bridge.lock().devtools_open.contains(tab)
    }

    fn with_engine_tab(
        &self,
        tab: &TabId,
        what: &str,
        run: impl FnOnce(&dyn BrowserEngine, EngineTabId) -> ardia_engine::EngineResult<()>,
    ) {
        let (Some(engine_tab), Some(engine)) = (self.engine_tab(tab), self.engine()) else {
            log::debug!("{tab} has no page yet to {what}");
            return;
        };
        if let Err(problem) = run(engine.as_ref(), engine_tab) {
            log::warn!("{tab} couldn't {what}: {problem}");
        }
    }

    pub(crate) fn forget_devtools_view(&self, tab: EngineTabId) {
        if let Some(side) = self.side.get() {
            let view = side.borrow_mut().devtools.remove(&tab);
            drop(view);
        }
    }

    pub(crate) fn forget_hosted(&self, window: EngineWindowId) {
        if let Some(side) = self.side.get() {
            let hosted = side.borrow_mut().hosted.remove(&window);
            drop(hosted);
        }
    }

    pub fn present_window(&self, window: &WindowId) -> Presentation {
        let focused = self.store.snapshot().focus_order.first() == Some(window);
        if focused && !self.config.background {
            return Presentation::Activate;
        }
        if let (Some(engine_window), Some(engine)) = (self.engine_window(window), self.engine())
            && let Err(problem) = engine.show_inactive(engine_window)
        {
            log::warn!("{window} didn't come on screen: {problem}");
        }
        Presentation::ShowInactive
    }

    pub fn host_alive(&self, window: &WindowId, host: HostedWindow) -> bool {
        let (Some(engine_window), Some(side)) = (self.engine_window(window), self.side.get())
        else {
            return false;
        };
        side.borrow()
            .hosted
            .get(&engine_window)
            .is_some_and(|(native, view)| {
                native.handle().as_ptr() as usize == host.window
                    && view.handle().as_ptr() as usize == host.view
            })
    }

    pub fn tab_views(&self, tab: &TabId) -> Option<HostTabView> {
        let state = self.store.snapshot();
        state.tab(tab.as_str())?;
        if let Some(views) = self.webkit_views(tab) {
            return Some(views);
        }
        let empty = HostTabView {
            tab_id: tab.clone(),
            page_view: None,
            devtools_view: None,
        };
        if self.backend != EngineBackend::Mac {
            return Some(empty);
        }
        let engine_tab = self.engine_tab(tab)?;
        let side = self.side.get()?;
        let engine = self.engine()?;
        let cached = side.borrow().views.get(&engine_tab).map(NativeView::handle);
        let page_view = match cached {
            Some(handle) => Some(handle),
            None => match engine.native_view_handle(engine_tab) {
                Ok(view) => {
                    let handle = view.handle();
                    side.borrow_mut().views.insert(engine_tab, view);
                    log::debug!("{tab} shows its page");
                    Some(handle)
                }
                Err(problem) => {
                    log::debug!("{tab} has no page view yet: {problem}");
                    None
                }
            },
        };
        let devtools_view = if self.devtools_open(tab) {
            let cached = side
                .borrow()
                .devtools
                .get(&engine_tab)
                .map(NativeView::handle);
            match cached {
                Some(handle) => Some(handle),
                None => match engine.devtools_view_handle(engine_tab) {
                    Ok(Some(view)) => {
                        let handle = view.handle();
                        side.borrow_mut().devtools.insert(engine_tab, view);
                        Some(handle)
                    }
                    _ => None,
                },
            }
        } else {
            None
        };
        Some(HostTabView {
            page_view,
            devtools_view,
            ..empty
        })
    }

    pub fn request_quit(&self) {
        let downloading = self.downloads_in_progress();
        let windowless = self.bridge.lock().windows.is_empty();
        if downloading > 0 && windowless && !self.config.background && !self.is_shutting_down() {
            self.effect(ShellEffect::ConfirmQuitWithDownloads { count: downloading });
            return;
        }
        self.quit_now();
    }

    pub fn quit_now(&self) {
        self.begin_shutdown();
        if !self.store.flush(crate::events_pump::SHUTDOWN_FLUSH) {
            log::warn!("the session didn't finish saving before quitting");
        }
        self.effect(ShellEffect::Quit);
    }

    pub fn downloads_in_progress(&self) -> u32 {
        let state = self.store.snapshot();
        let active = state
            .downloads
            .items()
            .iter()
            .filter(|download| download.is_active())
            .count();
        u32::try_from(active).unwrap_or(u32::MAX)
    }

    pub fn flush(&self) -> bool {
        self.store.flush(crate::events_pump::SHUTDOWN_FLUSH)
    }

    fn resolve_request(&self, request_id: &str, result: PermissionResult, remember: bool) {
        if result == PermissionResult::Accept {
            self.ensure_system_access_for(request_id);
        }
        if self.webkit_resolve_notification_permission(request_id, result, remember) {
            let tab = self.bridge.lock().prompts.settle_request(request_id);
            if let Some(tab) = tab {
                self.publish_prompts(&tab);
            }
            return;
        }
        let Some(engine) = self.engine() else {
            return;
        };
        let request = self.bridge.lock().prompts.request(request_id);
        note_request_answer(
            request.as_ref().map(|(_, kind)| *kind),
            &self.bridge.lock().prompts.permissions_of(request_id),
            result,
            remember,
        );
        let outcome = match request.map(|(_, kind)| kind) {
            Some(RequestKind::ExternalApp) => engine.resolve_external_app(
                request_id,
                result == PermissionResult::Accept,
                remember,
            ),
            _ => engine.resolve_permission(request_id, result, remember),
        };
        if let Err(problem) = outcome {
            log::warn!("couldn't answer {request_id}: {problem}");
        }
        let tab = self.bridge.lock().prompts.settle_request(request_id);
        if let Some(tab) = tab {
            self.publish_prompts(&tab);
        }
    }
}

fn note_request_answer(
    kind: Option<RequestKind>,
    permissions: &[String],
    result: PermissionResult,
    remember: bool,
) {
    use ardia_telemetry::counts::count;
    if kind == Some(RequestKind::ExternalApp) {
        count(match (result, remember) {
            (PermissionResult::Accept, true) => "external_app_allows_always",
            (PermissionResult::Accept, false) => "external_app_allows",
            _ => "external_app_declines",
        });
        return;
    }
    if !permissions.iter().any(|name| name == "multipleDownloads") {
        return;
    }
    count("multiple_download_asks");
    match result {
        PermissionResult::Accept => count("multiple_download_allows"),
        PermissionResult::Deny => count("multiple_download_blocks"),
        PermissionResult::Dismiss => {}
    }
}

impl AppCoordinator {
    fn ensure_system_access_for(&self, request_id: &str) {
        let (permissions, tab) = {
            let bridge = self.bridge.lock();
            (
                bridge.prompts.permissions_of(request_id),
                bridge.prompts.request(request_id).map(|(tab, _)| tab),
            )
        };
        let window = tab.and_then(|tab| {
            self.store
                .snapshot()
                .tab(tab.as_str())
                .map(|t| t.window_id.clone())
        });
        if permissions.iter().any(|kind| kind == "notifications") {
            self.ensure_notification_permission(window.clone());
        }
        if permissions
            .iter()
            .any(|kind| kind == "location" || kind == "geolocation")
        {
            self.ensure_location_permission(window);
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Owner {
    pub owner: ProfileOwner,
    pub certain: bool,
}

enum Intent {
    None,
    Navigate(TabId),
    Duplicate(TabId),
    DeleteProfile(Option<EngineProfileId>),
}

impl Intent {
    fn of(action: &Action, coordinator: &AppCoordinator) -> Self {
        match action {
            Action::Navigate { tab, .. } => Intent::Navigate(tab.clone()),
            Action::DuplicateTab { tab } => Intent::Duplicate(tab.clone()),
            Action::DeleteProfile { profile } => {
                Intent::DeleteProfile(coordinator.engine_profile(profile))
            }
            _ => Intent::None,
        }
    }
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct ClosingPages {
    pub removed: Vec<TabId>,
    pub unloaded: Vec<TabId>,
}

impl ClosingPages {
    pub fn all(&self) -> Vec<TabId> {
        self.removed.iter().chain(&self.unloaded).cloned().collect()
    }
}

fn same_tabs(left: &[TabId], right: &[TabId]) -> bool {
    let left: HashSet<&TabId> = left.iter().collect();
    let right: HashSet<&TabId> = right.iter().collect();
    left == right
}

fn dispatched_counts(action: &Action) -> Vec<(&'static str, u64)> {
    match action {
        Action::ToggleSidebar { .. } => vec![("auto_hide_tabs_toggles", 1)],
        Action::NewTab { tab, .. } if tab.url.as_deref() == Some("chrome://settings") => {
            vec![("chrome_settings_opens", 1)]
        }
        Action::MoveBookmarks { ids, .. } if !ids.is_empty() => {
            vec![("bookmark_moves", 1), ("bookmarks_moved", ids.len() as u64)]
        }
        Action::UpdateSettings {
            patch,
            from_sync: false,
        } => match patch
            .get("busyTabWarnings")
            .and_then(serde_json::Value::as_bool)
        {
            Some(true) => vec![("busy_tab_warnings_turned_on", 1)],
            Some(false) => vec![("busy_tab_warnings_turned_off", 1)],
            None => Vec::new(),
        },
        _ => Vec::new(),
    }
}

pub fn action_name(action: &Action) -> String {
    let shown = format!("{action:?}");
    let end = shown.find([' ', '{', '(']).unwrap_or(shown.len());
    shown[..end].to_owned()
}

fn password_action(action: &str) -> Option<PasswordPromptAction> {
    Some(match action {
        "save" => PasswordPromptAction::Save,
        "update" => PasswordPromptAction::Update,
        "never" => PasswordPromptAction::Never,
        "nope" | "notNow" => PasswordPromptAction::Nope,
        "dismiss" => PasswordPromptAction::Dismiss,
        _ => return None,
    })
}

fn autofill_action(action: &str) -> Option<AutofillPromptAction> {
    Some(match action {
        "accept" => AutofillPromptAction::Accept,
        "decline" => AutofillPromptAction::Decline,
        "dismiss" => AutofillPromptAction::Dismiss,
        _ => return None,
    })
}

fn press_clock_seconds() -> f64 {
    #[cfg(target_os = "macos")]
    {
        let mut now = libc::timespec {
            tv_sec: 0,
            tv_nsec: 0,
        };
        if unsafe { libc::clock_gettime(libc::CLOCK_UPTIME_RAW, &mut now) } == 0 {
            return now.tv_sec as f64 + now.tv_nsec as f64 / 1e9;
        }
    }
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(1.0, |d| d.as_secs_f64())
}

impl AppCoordinator {
    fn clear_site_data_of(&self, tab: TabId) {
        let state = self.store.snapshot();
        let Some(listed) = state.tab(tab.as_str()) else {
            return;
        };
        let Some(origin) = ardia_ui::content::toolbar_menus::site_origin(&listed.url) else {
            return;
        };
        let host = origin.split("://").nth(1).unwrap_or(&origin).to_owned();
        let answer = self.ask_in_window(
            &listed.window_id,
            ardia_ui::Confirmation {
                title: format!("Clear cookies and site data for {host}?"),
                message: "You'll be signed out of this site, and its offline data will be deleted."
                    .to_owned(),
                confirm: "Clear".to_owned(),
                destructive: true,
            },
        );
        let profile = listed.profile_id.clone();
        let me = self.me.clone();
        self.spawn(async move {
            if !answer.await.unwrap_or(false) {
                return;
            }
            let Some(me) = me.upgrade() else {
                return;
            };
            let (Some(engine), Some(dir)) = (me.engine(), me.service_profile_dir(&profile)) else {
                return;
            };
            let reply = ardia_engine::Services::new(engine.as_ref(), &dir)
                .sites()
                .clear_data(&origin);
            if let Err(problem) = reply.await {
                log::debug!("site data for {origin} wasn't cleared: {problem}");
                return;
            }
            let now = me.store.snapshot();
            let same = now
                .tab(tab.as_str())
                .and_then(|t| ardia_ui::content::toolbar_menus::site_origin(&t.url))
                .is_some_and(|o| o == origin);
            if same {
                me.reload(tab, false);
            }
        });
    }

    fn note_leaving_new_tab(&self, tab: &TabId) {
        let from_new_tab = self
            .store
            .snapshot()
            .tab(tab.as_str())
            .is_some_and(|t| t.url.is_empty());
        let mut bridge = self.bridge.lock();
        let shown = bridge.new_tab_shown.remove(tab).is_some();
        if from_new_tab || shown {
            bridge.back_to_new_tab.insert(tab.clone());
        }
    }

    fn show_new_tab_behind(&self, tab: &TabId) -> bool {
        let state = self.store.snapshot();
        let Some(listed) = state.tab(tab.as_str()) else {
            return false;
        };
        let mut bridge = self.bridge.lock();
        if listed.live.can_go_back
            || listed.url.is_empty()
            || bridge.new_tab_shown.contains_key(tab)
            || !bridge.back_to_new_tab.contains(tab)
        {
            return false;
        }
        bridge.new_tab_shown.insert(
            tab.clone(),
            (
                listed.url.clone(),
                listed.title.clone(),
                listed.favicon.clone(),
            ),
        );
        drop(bridge);
        self.dispatch_quietly(Action::UpdatePage {
            tab: tab.clone(),
            update: PageUpdate {
                url: Some(String::new()),
                title: Some(String::new()),
                favicon: Some(None),
                ..PageUpdate::default()
            },
        });
        true
    }

    fn hide_new_tab(&self, tab: &TabId) -> bool {
        let Some((url, title, favicon)) = self.bridge.lock().new_tab_shown.remove(tab) else {
            return false;
        };
        self.dispatch_quietly(Action::UpdatePage {
            tab: tab.clone(),
            update: PageUpdate {
                url: Some(url),
                title: Some(title),
                favicon: Some(favicon),
                ..PageUpdate::default()
            },
        });
        true
    }
}

impl UiHost for AppCoordinator {
    fn store(&self) -> &Arc<BrowserStore> {
        &self.store
    }

    fn dispatch(&self, action: Action) {
        if let Action::SetPopover { window, popover } = &action {
            self.note_popover_change(window, popover.as_ref());
        }
        let name = action_name(&action);
        if let Err(problem) = self.dispatch_action(action) {
            log::debug!("{name} changed nothing: {problem}");
        }
    }

    fn navigate(&self, _window: WindowId, tab: TabId, input: String) {
        self.bridge.lock().new_tab_shown.remove(&tab);
        self.dispatch(Action::Navigate { tab, input });
    }

    fn go_back(&self, tab: TabId) {
        if self.back_from_internal_page(&tab) || self.go_back_across_engines(&tab) {
            return;
        }
        if self.show_new_tab_behind(&tab) {
            return;
        }
        if self.webkit_go_back(&tab) {
            return;
        }
        self.with_engine_tab(&tab, "go back", |engine, id| engine.go_back(id));
    }

    fn go_forward(&self, tab: TabId) {
        if self.hide_new_tab(&tab) || self.webkit_go_forward(&tab) {
            return;
        }
        self.with_engine_tab(&tab, "go forward", |engine, id| engine.go_forward(id));
    }

    fn clear_site_data(&self, tab_id: TabId) {
        self.clear_site_data_of(tab_id);
    }

    fn page_holds_pointer(&self, tab_id: &TabId) -> bool {
        self.engine_tab(tab_id).is_some_and(|tab| {
            crate::pointer_hold::HOLDS
                .lock()
                .is_ok_and(|holds| holds.holds(tab))
        })
    }

    fn back_to_new_tab(&self, tab_id: &TabId) -> bool {
        self.bridge.lock().back_to_new_tab.contains(tab_id)
    }

    fn page_full_screen_takes_window(&self, tab_id: &TabId) -> bool {
        !crate::webkit::page::has(tab_id)
    }

    fn exit_page_full_screen(&self, tab_id: TabId) {
        if crate::webkit::page::has(&tab_id) {
            return;
        }
        self.with_engine_tab(&tab_id, "leave full screen", |engine, tab| {
            engine.tab_command(tab, ardia_engine::TabCommand::ExitFullscreen)
        });
    }

    fn window_transitions(&self, window_id: &WindowId) -> u64 {
        self.engine_window(window_id)
            .and_then(|engine_window| self.hosted_native_window(engine_window))
            .map_or(0, |native| {
                crate::acted_full_screen::transitions(native.handle())
            })
    }

    fn cover_page(&self, tab_id: TabId) -> futures::channel::oneshot::Receiver<bool> {
        let (tx, rx) = futures::channel::oneshot::channel();
        let (Some(engine_tab), Some(engine)) = (self.engine_tab(&tab_id), self.engine()) else {
            let _ = tx.send(false);
            return rx;
        };
        let reply = engine.cover_page(engine_tab);
        self.spawn(async move {
            let _ = tx.send(reply.await.unwrap_or(false));
        });
        rx
    }

    fn uncover_page(&self, tab_id: TabId, fade: bool) {
        if let (Some(engine_tab), Some(engine)) = (self.engine_tab(&tab_id), self.engine()) {
            let _ = engine.uncover_page(engine_tab, fade);
        }
    }

    fn page_draw_state(
        &self,
        tab_id: TabId,
    ) -> futures::channel::oneshot::Receiver<Option<ardia_ui::host::PageDrawState>> {
        let (tx, rx) = futures::channel::oneshot::channel();
        let (Some(engine_tab), Some(engine)) = (self.engine_tab(&tab_id), self.engine()) else {
            let _ = tx.send(None);
            return rx;
        };
        let reply = engine.evaluate_js(
            engine_tab,
            "[innerWidth * devicePixelRatio, innerHeight * devicePixelRatio, !!document.fullscreenElement]",
        );
        self.spawn(async move {
            let drawn = reply.await.ok().flatten().and_then(|value| {
                let list = value.as_array()?;
                Some(ardia_ui::host::PageDrawState {
                    width: list.first()?.as_f64()?,
                    height: list.get(1)?.as_f64()?,
                    full_screen: list.get(2)?.as_bool()?,
                })
            });
            let _ = tx.send(drawn);
        });
        rx
    }

    fn move_window_to_display(&self, window_id: WindowId, display: String) {
        if !self.config.hosts_native_windows {
            return;
        }
        let (Some(engine_window), Some(engine)) = (self.engine_window(&window_id), self.engine())
        else {
            return;
        };
        if let Ok(native) = engine.native_window_handle(engine_window) {
            crate::acted_full_screen::move_to_display(native.handle(), display);
        }
    }

    fn act_window_full_screen(&self, window_id: WindowId, on: bool) {
        let (Some(engine_window), Some(engine)) = (self.engine_window(&window_id), self.engine())
        else {
            return;
        };
        if let Err(problem) = engine.set_acted_fullscreen(engine_window, on) {
            log::debug!("{window_id} couldn't act out full screen: {problem}");
        }
        if self.config.hosts_native_windows
            && let Ok(native) = engine.native_window_handle(engine_window)
        {
            crate::acted_full_screen::act(native.handle(), on);
        }
    }

    fn new_tab_shown(&self, tab_id: &TabId) -> bool {
        self.bridge.lock().new_tab_shown.contains_key(tab_id)
    }

    fn reload(&self, tab: TabId, ignore_cache: bool) {
        if self.reload_internal_page(&tab) || self.webkit_reload(&tab, ignore_cache) {
            return;
        }
        self.with_engine_tab(&tab, "reload", |engine, id| {
            if ignore_cache {
                engine.reload_ignoring_cache(id)
            } else {
                engine.reload(id)
            }
        });
    }

    fn stop_loading(&self, tab: TabId) {
        if self.internal_page_of(&tab).is_some() || self.webkit_stop(&tab) {
            return;
        }
        self.with_engine_tab(&tab, "stop", |engine, id| engine.stop(id));
    }

    fn set_muted(&self, tab: TabId, muted: bool) {
        self.dispatch(Action::SetMuted { tab, muted });
    }

    fn set_zoom(&self, tab: TabId, factor: f64) {
        self.dispatch(Action::SetZoom { tab, zoom: factor });
    }

    fn zoom_step(&self, tab: TabId, direction: i32) {
        let direction = direction.clamp(-1, 1);
        if self.webkit_zoom_step(&tab, direction) {
            return;
        }
        self.with_engine_tab(&tab, "zoom", |engine, id| engine.zoom_step(id, direction));
    }

    fn find_in_page(&self, tab: TabId, query: String, forward: bool) {
        let state = self.store.snapshot();
        let current = state
            .tab(tab.as_str())
            .map(|t| t.live.find.clone())
            .unwrap_or_default();
        let fresh = current.query != query;
        self.dispatch(Action::SetFind {
            tab: tab.clone(),
            find: FindState {
                open: true,
                query: query.clone(),
                count: if fresh { None } else { current.count },
                ..current
            },
        });
        if self.webkit_find(&tab, &query, forward) {
        } else if query.is_empty() {
            self.with_engine_tab(&tab, "stop finding", |engine, id| engine.stop_finding(id));
        } else {
            self.with_engine_tab(&tab, "find", |engine, id| engine.find(id, &query, forward));
        }
    }

    fn replace_in_page(&self, tab: TabId, query: String, replacement: String, all: bool) {
        self.replace_in_tab(tab, query, replacement, all);
    }

    fn replace_note(&self, tab: &TabId) -> Option<ardia_ui::host::ReplaceNote> {
        self.replace_note_of(tab)
    }

    fn stop_finding(&self, tab: TabId) {
        if !self.webkit_stop_finding(&tab) {
            self.with_engine_tab(&tab, "stop finding", |engine, id| engine.stop_finding(id));
        }
        self.dispatch(Action::SetFind {
            tab,
            find: FindState::default(),
        });
    }

    fn toggle_devtools(&self, tab: TabId) {
        let open = self.devtools_open(&tab);
        self.with_engine_tab(&tab, "toggle DevTools", |engine, id| {
            if open {
                engine.close_devtools(id)
            } else {
                engine.show_devtools(id)
            }
        });
    }

    fn enter_pip(&self, tab: TabId) {
        if self.webkit_set_pip(&tab, true, false) {
            return;
        }
        let (Some(engine_tab), Some(engine)) = (self.engine_tab(&tab), self.engine()) else {
            return;
        };
        let reply = engine.enter_pip(engine_tab, press_clock_seconds());
        self.spawn(async move {
            if let Err(problem) = reply.await {
                log::debug!("picture in picture didn't start: {problem}");
            }
        });
    }

    fn show_cast(&self, tab: TabId) {
        self.with_engine_tab(&tab, "cast", |engine, id| {
            engine.show_cast_dialog(id).map(|_| ())
        });
    }

    fn share_tab(&self, tab: TabId) {
        let state = self.store.snapshot();
        let Some(url) = state
            .tab(tab.as_str())
            .map(|t| t.url.clone())
            .filter(|url| !url.is_empty())
        else {
            return;
        };
        self.share_url(&tab, &url);
    }

    fn open_page_in(&self, tab_id: TabId, engine: ardia_state::model::PageEngine) {
        self.open_page_in_engine(&tab_id, engine, Some(Some(engine)), true);
    }

    fn toggle_page_engine(&self, tab_id: TabId) {
        self.toggle_engine_of(&tab_id);
    }

    fn retiring_page(&self, tab_id: TabId) -> Option<ardia_ui::host::RetiringPage> {
        self.retiring_page_of(&tab_id)
    }

    fn reset_page_engine(&self, tab_id: TabId) {
        let state = self.store.snapshot();
        let url = state
            .tab(tab_id.as_str())
            .map(|tab| ardia_state::engines::current_url(tab).to_owned())
            .unwrap_or_default();
        let engine = ardia_state::engines::recommended_engine_for(&state.settings, &url);
        self.open_page_in_engine(&tab_id, engine, Some(None), true);
    }

    fn set_engine_mode(&self, mode: ardia_state::settings::EngineMode) {
        self.change_engine_mode(mode);
    }

    fn engine_mode_switching(&self) -> bool {
        self.engine_mode_pending().is_some()
    }

    fn offers_engine_choice(&self) -> bool {
        self.offers_webkit()
    }

    fn webkit_passkey_access(&self) -> ardia_ui::settings::engines::PasskeyAccess {
        self.webkit_passkey_access_now()
    }

    fn request_webkit_passkey_access(&self) {
        self.request_passkey_access();
    }

    fn webkit_passkey_requesting(&self) -> bool {
        self.passkey_request_pending()
    }

    fn tab_native_views(&self, tab_id: TabId) -> Option<HostTabView> {
        self.tab_views(&tab_id)
    }

    fn icon_theme_for(&self, tab_id: TabId) -> Option<IconTheme> {
        let cached = self.bridge.lock().icon_themes.get(&tab_id).copied();
        cached.or_else(|| {
            self.store
                .snapshot()
                .tab(tab_id.as_str())
                .and_then(|t| t.live.icon_theme)
        })
    }

    fn download_command(&self, download_id: String, command: DownloadCommand) {
        if crate::webkit::downloads::handles(&download_id) {
            crate::webkit::downloads::command(command.as_str(), &download_id);
            return;
        }
        let Some(engine) = self.engine() else {
            return;
        };
        let profile_dir = self
            .store
            .snapshot()
            .downloads
            .get(&download_id)
            .and_then(|d| d.profile.clone())
            .unwrap_or_default();
        let reply = Services::new(engine.as_ref(), &profile_dir)
            .downloads()
            .command(&download_id, command);
        self.spawn(async move {
            if let Err(problem) = reply.await {
                log::warn!("the download command didn't run: {problem}");
            }
        });
    }

    fn toast_command(&self, command: &str) -> bool {
        self.busy_toast_command(command)
    }

    fn reveal_path(&self, path: String) {
        #[cfg(target_os = "macos")]
        if let Err(problem) =
            ardia_engine::macos::platform::reveal_in_finder(&[std::path::PathBuf::from(&path)])
        {
            log::warn!("couldn't show {path} in Finder: {problem}");
        }
        #[cfg(not(target_os = "macos"))]
        log::info!("revealing {path} isn't supported here yet");
    }

    fn resolve_permission(&self, request_id: String, result: PermissionResult, remember: bool) {
        self.resolve_request(&request_id, result, remember);
    }

    fn resolve_password_prompt(
        &self,
        tab: TabId,
        action: String,
        username: Option<String>,
        password: Option<String>,
    ) {
        if self.webkit_resolve_password(&tab, &action, username.as_deref(), password.as_deref()) {
            if self.bridge.lock().prompts.clear_password(&tab) {
                self.publish_prompts(&tab);
            }
            return;
        }
        let Some(action) = password_action(&action) else {
            log::warn!("{action} isn't a password prompt answer");
            return;
        };
        self.with_engine_tab(&tab, "answer the password prompt", |engine, id| {
            engine.resolve_password_prompt(id, action, username.as_deref(), password.as_deref())
        });
        if self.bridge.lock().prompts.clear_password(&tab) {
            self.publish_prompts(&tab);
        }
    }

    fn resolve_autofill_prompt(&self, tab: TabId, prompt_id: i64, action: String) {
        if self.webkit_resolve_autofill(&tab, prompt_id, &action) {
            return;
        }
        let Some(action) = autofill_action(&action) else {
            log::warn!("{action} isn't an autofill answer");
            return;
        };
        self.with_engine_tab(&tab, "answer autofill", |engine, id| {
            engine.resolve_autofill_prompt(id, prompt_id, action)
        });
        if self
            .bridge
            .lock()
            .prompts
            .clear_autofill(&tab, Some(prompt_id))
        {
            self.publish_prompts(&tab);
        }
    }

    fn execute_extension_action(&self, tab: TabId, extension_id: String) {
        self.run_extension_action(&tab, &extension_id);
    }

    fn open_little_ardia_in_main(&self, window_id: WindowId) {
        self.dispatch(Action::PromoteLittleArdia { window: window_id });
    }

    fn open_utility_window(&self, kind: UtilityWindowKind) {
        self.effect(ShellEffect::OpenUtility(kind));
    }

    fn start_import(&self, source: String, profile_id: ProfileId) {
        crate::import::start(self, source, profile_id);
    }

    fn request_window_close(&self, window_id: WindowId) {
        self.dispatch(Action::CloseWindow { window: window_id });
    }

    fn favicon_image(&self, profile: &ProfileId, url: &str) -> Option<Arc<gpui::Image>> {
        AppCoordinator::favicon_image(self, profile, url)
    }

    fn pinned_backdrop(
        &self,
        icon: &ardia_ui::primitives::favicon::Favicon,
        look: ardia_ui::host::PinnedBackdrop,
    ) -> Option<Arc<gpui::Image>> {
        AppCoordinator::pinned_backdrop(self, icon, look)
    }

    fn favicon_inker(&self, url: &str) -> Option<ardia_ui::primitives::favicon::FaviconInker> {
        AppCoordinator::favicon_inker(self, url)
    }

    fn live(&self) -> Option<Arc<ardia_state::live::LiveState>> {
        crate::live::hub().map(|hub| hub.snapshot())
    }

    fn live_command(&self, command: ardia_state::live::LiveCommand) {
        if let Some(hub) = crate::live::hub() {
            hub.command(command);
        }
    }

    fn report(&self) -> Option<Arc<ardia_ui::report::state::ReportView>> {
        crate::report::hub().map(|hub| hub.view())
    }

    fn report_command(&self, command: ardia_ui::report::state::ReportCommand) {
        self.start_report().command(command);
    }

    fn report_record(&self, window: &mut gpui::Window, cx: &mut gpui::App) {
        let hub = std::sync::Arc::clone(self.start_report());
        let Some(me) = self.weak().upgrade() else {
            return;
        };
        let host: std::sync::Arc<dyn ardia_ui::host::UiHost> = me;
        #[cfg(target_os = "macos")]
        crate::recorder::start(&hub, host, window, cx);
        #[cfg(not(target_os = "macos"))]
        let _ = (hub, host, window, cx);
    }

    fn report_player(&self, path: Option<&str>) -> Option<ardia_engine::NativeViewHandle> {
        #[cfg(target_os = "macos")]
        {
            match path {
                Some(path) => crate::recorder::open_player(path),
                None => {
                    crate::recorder::close_player();
                    None
                }
            }
        }
        #[cfg(not(target_os = "macos"))]
        {
            let _ = path;
            None
        }
    }

    fn calendar(&self) -> Option<Arc<ardia_ui::live::CalendarView>> {
        crate::calendar::hub().map(|hub| hub.view())
    }

    fn calendar_command(&self, command: ardia_ui::live::CalendarCommand) {
        if let Some(hub) = crate::calendar::hub() {
            hub.command(command);
        }
    }

    fn live_status_text(&self, folder: &str) -> String {
        crate::live::hub().map_or_else(String::new, |hub| hub.status_text(folder))
    }

    fn symbol_image(
        &self,
        request: ardia_ui::icon_picker::symbols::SymbolRequest<'_>,
    ) -> Option<Arc<gpui::Image>> {
        crate::symbols::symbol_image(request)
    }

    fn open_file(&self, window_id: WindowId) {
        if let Err(problem) = self.choose_files_to_open(Some(window_id)) {
            log::debug!("Open File didn't start: {problem}");
        }
    }

    fn page_command(&self, tab_id: TabId, command: ardia_ui::PageCommand) {
        if let Err(problem) = self.run_page_command(&tab_id, command) {
            log::debug!("{command:?} didn't run: {problem}");
        }
    }

    fn run_bookmarklet(&self, tab_id: TabId, url: String) {
        self.run_bookmarklet_in(&tab_id, &url);
    }

    fn start_dictation(&self) {
        crate::ntp_extras::start_dictation();
    }

    fn power_up_frame(
        &self,
        request: &ardia_ui::ntp::power_up::PowerUpRequest,
    ) -> Option<ardia_ui::ntp::power_up::PowerUpFrame> {
        crate::power_up::frame(request)
    }

    fn search_suggestions(
        &self,
        profile_id: ProfileId,
        url: String,
    ) -> futures::channel::oneshot::Receiver<Option<String>> {
        self.fetch_search_suggestions(&profile_id, url)
    }

    fn ntp_extras(&self) -> ardia_state::ntp_extras::NtpExtras {
        self.config
            .data_dir
            .as_deref()
            .map(crate::ntp_extras::extras)
            .unwrap_or_default()
    }

    fn sharing(&self) -> bool {
        self.config
            .data_dir
            .as_deref()
            .is_some_and(crate::ntp_extras::sharing)
    }

    fn set_sharing(
        &self,
        on: bool,
        source: ardia_telemetry::SharingSource,
        placement: Option<ardia_telemetry::AskPlacement>,
    ) {
        crate::webkit::telemetry::set_allowed(on);
        if let Some(dir) = self.config.data_dir.as_deref() {
            crate::ntp_extras::set_sharing(dir, on, source, placement);
        }
    }

    fn default_browser(&self) -> Option<bool> {
        Some(crate::system_probe::is_default_browser())
    }

    fn make_default_browser(&self) {
        ardia_telemetry::counts::count("default_browser_prompts_opened");
        if !self.config.background {
            crate::system_probe::make_default_browser();
        }
        self.signal.emit(ardia_ui::host_data::HostTopics::SYNC);
    }

    fn open_at_login(&self) -> Option<ardia_ui::LoginItemState> {
        let coordinator = self.weak();
        let item = crate::system_probe::cached_login_item(move || {
            if let Some(coordinator) = coordinator.upgrade() {
                coordinator
                    .signal
                    .emit(ardia_ui::host_data::HostTopics::SYNC);
            }
        });
        Some(ardia_ui::LoginItemState {
            on: item.shown_on(),
            needs_approval: item == crate::system_probe::LoginItem::RequiresApproval,
        })
    }

    fn settings_value(
        &self,
        query: &ardia_ui::settings::data::SettingsQuery,
    ) -> Option<serde_json::Value> {
        self.settings_value_of(query)
    }

    fn settings_revision(&self, query: &ardia_ui::settings::data::SettingsQuery) -> Option<u64> {
        self.settings_revision_of(query)
    }

    fn settings_call(
        &self,
        call: ardia_ui::settings::data::SettingsCall,
    ) -> ardia_ui::settings::data::CallReply {
        self.run_settings_call(call)
    }

    fn app_icon_count(&self) -> usize {
        crate::app_icon_choice::VARIANTS.len()
    }

    fn app_icons(&self) -> Vec<ardia_ui::AppIconChoice> {
        crate::app_icon_choice::VARIANTS
            .iter()
            .map(|variant| ardia_ui::AppIconChoice {
                id: variant.id.to_owned(),
                name: variant.name.to_owned(),
                flat: variant.flat,
                preview: crate::app_icon_choice::preview(variant.id),
            })
            .collect()
    }

    fn current_app_icon(&self) -> Option<String> {
        Some(crate::app_icon_choice::current().to_owned())
    }

    fn set_app_icon(&self, id: String) {
        crate::app_icon_choice::set(&id, true);
        self.signal.emit(ardia_ui::host_data::HostTopics::SYNC);
    }

    fn about(&self) -> Option<ardia_ui::AboutInfo> {
        Some(ardia_ui::AboutInfo {
            app_version: crate::system_probe::app_version()
                .unwrap_or_else(|| env!("CARGO_PKG_VERSION").to_owned()),
            chromium_version: self
                .engine()
                .and_then(|engine| engine.chromium_version().ok()),
        })
    }

    fn profile_flags(&self, profile: &ProfileId) -> Option<ardia_ui::ProfileFlags> {
        self.engine_profile_flags(profile)
    }

    fn set_profile_flag(&self, profile: ProfileId, flag: ardia_ui::ProfileFlagKind, on: bool) {
        self.write_profile_flag(&profile, flag, on);
    }

    fn plugin_rows(&self) -> Vec<ardia_ui::PluginRow> {
        let Some(service) = self.plugins.lock().clone() else {
            return Vec::new();
        };
        let mut rows: Vec<ardia_ui::PluginRow> = service
            .listings()
            .into_iter()
            .map(|(name, active, problems)| ardia_ui::PluginRow {
                name,
                active,
                problems,
            })
            .collect();
        rows.sort_by(|a, b| a.name.cmp(&b.name));
        rows
    }

    fn plugin_folder(&self) -> Option<String> {
        let service = self.plugins.lock().clone()?;
        Some(service.folders().user_root().to_string_lossy().into_owned())
    }

    fn turn_plugin_off(&self, name: String) {
        if let Some(service) = self.plugins.lock().clone() {
            service.turn_plugin_off(&name);
        }
        self.signal.emit(ardia_ui::host_data::HostTopics::PLUGINS);
    }

    fn download_settings(&self, profile: &ProfileId) -> Option<ardia_ui::DownloadSettings> {
        self.cached_download_settings(profile)
    }

    fn set_download_settings(
        &self,
        profiles: Vec<ProfileId>,
        folder: Option<String>,
        ask_where_to_save: Option<bool>,
    ) {
        self.write_download_settings(profiles, folder, ask_where_to_save);
    }

    fn app_links(
        &self,
        profile: &ProfileId,
    ) -> Option<Vec<ardia_ui::settings::automations::AppLink>> {
        self.app_links_for(profile)
    }

    fn remove_app_link(&self, profile: ProfileId, origin: String, scheme: String) {
        self.drop_app_link(profile, origin, scheme);
    }

    fn recent_source_apps(&self) -> Vec<ardia_state::air_traffic::SourceApp> {
        self.recent_link_apps()
    }

    fn live_connect(
        &self,
        request: ardia_ui::settings::automations::LiveConnect,
    ) -> futures::channel::mpsc::UnboundedReceiver<ardia_ui::settings::automations::ConnectProgress>
    {
        self.start_live_connect(request)
    }

    fn cancel_live_connect(&self) {
        self.stop_live_connect();
    }

    fn automation_rules(&self) -> ardia_ui::settings::automations::AutomationRulesView {
        self.automation_rules_view()
    }

    fn approve_automation_rule(&self, key: String) {
        self.approve_rule(&key);
    }

    fn revoke_automation_rule(&self, key: String) {
        self.revoke_approved_rule(&key);
    }

    fn automation_approved(&self, key: &str) -> bool {
        self.is_automation_approved(key)
    }

    fn set_open_at_login(&self, on: bool) {
        if !self.config.background {
            crate::system_probe::set_open_at_login(on);
        }
        crate::system_probe::forget_login_item();
        self.signal.emit(ardia_ui::host_data::HostTopics::SYNC);
    }

    fn change_ntp_extras(&self, change: ardia_state::ntp_extras::NtpExtrasChange) {
        if let Some(dir) = self.config.data_dir.as_deref() {
            crate::ntp_extras::change(dir, change);
        }
    }

    fn export_bookmarks(&self, window_id: WindowId, profile_id: ProfileId) {
        self.export_bookmarks_of(&window_id, &profile_id);
    }

    fn confirm_in_window(
        &self,
        window_id: WindowId,
        question: ardia_ui::Confirmation,
    ) -> futures::channel::oneshot::Receiver<bool> {
        self.ask_in_window(&window_id, question)
    }

    #[cfg(target_os = "macos")]
    fn confirm_attached(
        &self,
        window: &mut gpui::Window,
        question: ardia_ui::Confirmation,
    ) -> futures::channel::oneshot::Receiver<bool> {
        self.ask_attached(window, question)
    }

    fn clear_browsing_data(
        &self,
        profile_id: ProfileId,
        request: ardia_ui::ClearBrowsingData,
    ) -> futures::channel::oneshot::Receiver<bool> {
        self.clear_browsing_data_for(profile_id, request)
    }

    fn show_menu(
        &self,
        items: Vec<ardia_ui::NativeMenuItem>,
    ) -> Option<futures::channel::oneshot::Receiver<Option<String>>> {
        cfg!(target_os = "macos").then(|| self.native_menu(items))
    }

    fn native_menus(&self) -> bool {
        cfg!(target_os = "macos")
    }

    fn prompt_in_window(
        &self,
        window: WindowId,
        prompt: ardia_ui::TextPrompt,
    ) -> Option<futures::channel::oneshot::Receiver<Option<String>>> {
        Some(self.prompt_in(&window, prompt))
    }

    fn arc_themes(&self) -> futures::channel::oneshot::Receiver<Vec<ardia_ui::ArcThemeChoice>> {
        let (answer, reply) = futures::channel::oneshot::channel();
        let home = std::env::var_os("HOME").map(std::path::PathBuf::from);
        let spawned = std::thread::Builder::new()
            .name("arc-themes".into())
            .spawn(move || {
                let spaces = home
                    .map(|home| crate::arc_themes::read_spaces(&home))
                    .unwrap_or_default();
                let choices = spaces
                    .into_iter()
                    .map(|space| ardia_ui::ArcThemeChoice {
                        title: space.title(),
                        swatch: crate::arc_themes::accent_rgb(&space.theme),
                        id: space.id,
                        theme: space.theme,
                    })
                    .collect();
                let _ = answer.send(choices);
            });
        if let Err(error) = spawned {
            log::warn!("couldn't start the Arc theme reader: {error}");
        }
        reply
    }

    fn page_favicon(&self, profile: &ProfileId, url: &str) -> Option<Arc<gpui::Image>> {
        AppCoordinator::page_favicon(self, profile, url)
    }

    fn page_favicon_inker(
        &self,
        profile: &ProfileId,
        url: &str,
    ) -> Option<ardia_ui::primitives::favicon::FaviconInker> {
        AppCoordinator::page_favicon_inker(self, profile, url)
    }

    fn file_icon(&self, path: &str, points: f32) -> Option<Arc<gpui::Image>> {
        self.cached_file_icon(path, points)
    }

    fn open_path(&self, path: String) {
        self.open_file_path(&path);
    }

    fn move_to_trash(&self, path: String) -> futures::channel::oneshot::Receiver<bool> {
        self.trash_path(&path)
    }

    fn opens_when_done(&self, download_id: &str) -> bool {
        self.opening_when_done(download_id)
    }

    fn toggle_open_when_done(&self, download_id: String) {
        self.toggle_opening_when_done(download_id);
    }

    fn scrolled_down(&self, tab_id: &TabId) -> bool {
        self.bridge.lock().scrolled_down.contains(tab_id)
    }

    fn reveal_toolbar(&self, tab_id: &TabId) {
        if self.bridge.lock().scrolled_down.remove(tab_id) {
            crate::telemetry_events::note_toolbar_shown(tab_id.as_str());
            self.signal.emit(ardia_ui::host_data::HostTopics::PAGE);
        }
    }

    fn media_session(&self, tab_id: &TabId) -> Option<ardia_ui::media::session::Session> {
        self.media_session_of(tab_id)
    }

    fn media_action(&self, tab_id: TabId, action: ardia_ui::media::session::MediaAction) {
        self.run_media_action(tab_id, action);
    }

    fn dismiss_player(&self, tab_id: TabId) {
        self.dismiss_media_player(&tab_id);
    }

    fn shows_mini_player(&self, tab_id: &TabId) -> bool {
        self.shows_mini_player_for(tab_id)
    }

    fn sidebar_player_tab(&self, window_id: &WindowId, profile_id: &ProfileId) -> Option<TabId> {
        self.sidebar_player_for(window_id, profile_id)
    }

    fn media_pip_open(&self, tab_id: &TabId) -> bool {
        self.media_pip_open_for(tab_id)
    }

    fn toggle_media_pip(&self, tab_id: TabId) {
        self.toggle_pip_for(tab_id);
    }

    fn display_request(&self, tab_id: &TabId) -> Option<ardia_ui::media::share::DisplayRequest> {
        self.display_request_for(tab_id)
    }

    fn answer_display_request(&self, tab_id: TabId, source: Option<String>, audio: bool) {
        AppCoordinator::answer_display_request(self, &tab_id, source, audio);
    }

    fn share_tab_with(&self, tab_id: TabId, shared: TabId, audio: bool) {
        AppCoordinator::share_tab_with(self, &tab_id, &shared, audio);
    }

    fn display_sources(&self) -> Vec<ardia_ui::media::share::DisplaySource> {
        let me = self.weak();
        crate::screen_capture::sources_with(std::sync::Arc::new(move || {
            if let Some(me) = me.upgrade() {
                me.signal.emit(ardia_ui::host_data::HostTopics::PAGE);
            }
        }))
    }

    fn screen_recording_allowed(&self) -> bool {
        crate::screen_capture::screen_recording_allowed()
    }

    fn request_screen_recording(&self) {
        crate::screen_capture::request_screen_recording();
    }

    fn display_thumbnails(
        &self,
        ids: &[String],
        width: f64,
    ) -> std::collections::HashMap<String, std::sync::Arc<gpui::Image>> {
        let me = self.weak();
        crate::screen_capture::thumbnails(
            ids,
            width,
            std::sync::Arc::new(move || {
                if let Some(me) = me.upgrade() {
                    me.signal.emit(ardia_ui::host_data::HostTopics::PAGE);
                }
            }),
        )
    }

    fn share_bar(&self, tab_id: &TabId) -> Option<(TabId, ardia_ui::media::share::TabShare)> {
        self.share_bar_for(tab_id)
    }

    fn stop_sharing(&self, capturer: TabId) {
        AppCoordinator::stop_sharing(self, &capturer);
    }

    fn share_instead(&self, capturer: TabId, tab_id: TabId) {
        AppCoordinator::share_instead(self, &capturer, &tab_id);
    }

    fn dismiss_share_bar(&self, capturer: TabId, tab_id: TabId) {
        AppCoordinator::dismiss_share_bar(self, &capturer, &tab_id);
    }

    fn media_access(&self, tab_id: &TabId) -> ardia_ui::host_data::MediaCapture {
        self.bridge
            .lock()
            .media_access
            .get(tab_id)
            .map(|access| ardia_ui::host_data::MediaCapture {
                camera: access.camera,
                microphone: access.microphone,
                screen: access.screen,
            })
            .unwrap_or_default()
    }

    fn content_blocker(&self) -> Option<ardia_ui::site::model::ContentBlockerView> {
        self.content_blocker_view()
    }

    fn content_blocker_command(&self, command: ardia_ui::site::model::ContentBlockerCommand) {
        drop(AppCoordinator::content_blocker_command(self, command));
    }

    fn site_page(&self, tab_id: &TabId) -> Option<ardia_ui::site::SitePage> {
        self.site_page_for(tab_id)
    }

    fn site_panel(&self, tab_id: &TabId) -> ardia_ui::site::SitePanel {
        self.site_panel_for(tab_id)
    }

    fn refresh_site_panel(&self, tab_id: TabId) {
        self.refresh_site_panel_for(tab_id);
    }

    fn site_answer(&self, tab_id: TabId, answer: ardia_ui::site::SiteAnswer) {
        self.site_answer_for(tab_id, answer);
    }

    fn page_selection(&self, tab_id: &TabId) -> Option<ardia_ui::site::model::PageSelection> {
        self.page_selection_for(tab_id)
    }

    fn translate_view(&self, tab_id: &TabId) -> ardia_ui::site::model::TranslateView {
        self.translate_view_for(tab_id)
    }

    fn translate_languages(&self, tab_id: &TabId) -> Vec<ardia_ui::site::model::TranslateLanguage> {
        self.translate_languages_for(tab_id)
    }

    fn reader_status(&self, tab_id: &TabId) -> ardia_ui::ReaderStatus {
        self.reader_status_of(tab_id)
    }

    fn toggle_reader(&self, tab_id: TabId) {
        self.toggle_reader_in(&tab_id);
    }

    fn note_system_dark(&self, dark: bool) {
        self.note_reader_system_dark(dark);
    }

    fn onboarding_record(&self) -> Option<ardia_ui::OnboardingRecord> {
        crate::onboarding_doc::read(self.config.data_dir.as_deref()?)
    }

    fn save_onboarding(&self, record: ardia_ui::OnboardingRecord) {
        if let Some(dir) = self.config.data_dir.clone() {
            std::thread::spawn(move || crate::onboarding_doc::write(&dir, &record));
        }
    }

    fn open_meadow(&self, night: bool, creeper: bool) -> Option<ardia_engine::NativeViewHandle> {
        #[cfg(target_os = "macos")]
        {
            let page = crate::meadow::write_page(self.config.data_dir.as_deref()?)?;
            let meadow = crate::meadow::mac::create(&page, night, creeper)?;
            let handle = ardia_engine::NativeViewHandle(meadow.view_ptr());
            *crate::meadow::shown().lock() = Some(crate::meadow::Shown(meadow));
            Some(handle)
        }
        #[cfg(not(target_os = "macos"))]
        {
            let _ = (night, creeper);
            None
        }
    }

    fn meadow_events(&self) -> Vec<String> {
        crate::meadow::drain()
    }

    fn set_meadow_alpha(&self, alpha: f64) {
        #[cfg(target_os = "macos")]
        if let Some(shown) = crate::meadow::shown().lock().as_ref() {
            shown.0.set_alpha(alpha);
        }
        #[cfg(not(target_os = "macos"))]
        let _ = alpha;
    }

    fn close_meadow(&self) {
        #[cfg(target_os = "macos")]
        crate::meadow::shown().lock().take();
    }

    fn cover_screen(&self, window: &gpui::Window) {
        #[cfg(target_os = "macos")]
        crate::meadow::mac::cover_screen(window);
        #[cfg(not(target_os = "macos"))]
        let _ = window;
    }

    fn watch_sidebar_edge(
        &self,
        window: &gpui::Window,
        window_id: WindowId,
        watch: Option<(
            ardia_ui::sidebar::edge_peek::SidebarEdgeWatch,
            ardia_ui::sidebar::edge_peek::SidebarEdgeSink,
        )>,
    ) {
        crate::sidebar_edge::watch(window, window_id, watch, self.config.background);
    }

    fn app_active(&self) -> bool {
        #[cfg(target_os = "macos")]
        {
            crate::meadow::mac::app_active()
        }
        #[cfg(not(target_os = "macos"))]
        {
            true
        }
    }

    fn play_intro_music(&self, muted: bool) {
        crate::intro_music::play(muted, self.config.background);
    }

    fn set_intro_music_muted(&self, muted: bool) {
        crate::intro_music::set_muted(muted);
    }

    fn stop_intro_music(&self, fade: f64) {
        crate::intro_music::stop(fade);
    }

    fn intro_music_muted(&self) -> bool {
        self.config
            .data_dir
            .as_deref()
            .is_some_and(crate::onboarding_doc::intro_music_muted)
    }

    fn save_intro_music_muted(&self, muted: bool) {
        if let Some(dir) = self.config.data_dir.clone() {
            std::thread::spawn(move || crate::onboarding_doc::save_intro_music_muted(&dir, muted));
        }
    }

    fn install_id(&self) -> String {
        let dir = self.config.data_dir.as_deref();
        dir.and_then(crate::telemetry::shown)
            .and_then(|shown| shown.install_id)
            .or_else(|| dir.and_then(crate::sharing_doc::install_id))
            .unwrap_or_else(crate::sharing_doc::upcoming_install_id)
    }

    fn icon_theme_of(&self, bytes: &[u8]) -> ardia_theme::IconTheme {
        crate::favicons::theme_for_bytes(bytes)
    }

    fn onboarding_system(&self) -> ardia_ui::OnboardingSystem {
        #[cfg(target_os = "macos")]
        {
            crate::system_setup::probe(&crate::system_setup::mac::MacSystem)
        }
        #[cfg(not(target_os = "macos"))]
        {
            ardia_ui::OnboardingSystem::default()
        }
    }

    fn apply_onboarding_system(&self, choice: ardia_ui::OnboardingSystemChoice) {
        let allowed = !self.config.background && !self.config.scratch;
        let dir = self.config.data_dir.clone();
        #[cfg(target_os = "macos")]
        {
            let calls = crate::system_setup::mac::MacSystem;
            let before = crate::system_setup::probe(&calls);
            let applied = crate::system_setup::apply(&calls, choice, before, allowed);
            if applied.became_default
                && choice.trial
                && let Some(dir) = dir
            {
                crate::onboarding_doc::record_trial(&dir, ardia_state::store::now_ms());
            }
        }
        #[cfg(not(target_os = "macos"))]
        {
            let _ = (choice, allowed, dir);
        }
    }

    fn page_overlay(&self, tab_id: &TabId) -> ardia_ui::window::page_overlays::PageOverlay {
        self.page_overlay_of(tab_id)
    }

    fn new_tab_notice(
        &self,
        window_id: &WindowId,
    ) -> Option<ardia_ui::window::page_overlays::NewTabNotice> {
        self.new_tab_notice_of(window_id)
    }

    fn frozen_picture(&self, window_id: &WindowId) -> Option<Arc<gpui::Image>> {
        self.frozen_picture_in(window_id)
    }

    fn navigation_steps(
        &self,
        tab_id: &TabId,
    ) -> Vec<ardia_ui::window::page_overlays::NavigationStep> {
        self.navigation_steps_of(tab_id)
    }

    fn program_control(&self) -> ardia_ui::window::page_overlays::ProgramControl {
        self.program_control_view()
    }

    fn stop_program_control(&self) {
        self.stop_program_control_now();
    }

    fn dismiss_control_pill(&self) {
        self.dismiss_control_pill_now();
    }

    fn focus_page(&self, tab_id: TabId) {
        log::debug!("focusing the page of {tab_id}");
        self.with_engine_tab(&tab_id, "focus", |engine, id| engine.focus(id));
    }

    fn go_to_offset(&self, tab_id: TabId, offset: i32) {
        self.go_to_offset_in(&tab_id, offset);
    }

    fn recover_crashed_page(&self, tab_id: TabId) {
        self.recover_crashed(&tab_id);
        self.reload(tab_id, false);
    }

    fn resolve_unresponsive(&self, tab_id: TabId, exit: bool) {
        self.resolve_unresponsive_in(&tab_id, exit);
    }

    fn register_gpui_window(&self, window_id: WindowId, handle: AnyWindowHandle) {
        crate::telemetry_events::mark_first_window();
        {
            let mut bridge = self.bridge.lock();
            bridge.gpui_requested.remove(&window_id);
            bridge.gpui.insert(window_id.clone(), handle);
        }
        let little = self
            .store
            .snapshot()
            .window(window_id.as_str())
            .is_some_and(|w| w.kind == ardia_state::windows::WindowKind::LittleArdia);
        if little
            && let Some(native) = self
                .engine_window(&window_id)
                .and_then(|engine_window| self.hosted_native_window(engine_window))
        {
            crate::acted_full_screen::join_full_screen_spaces(native.handle());
        }
    }

    fn host_signal(&self) -> Option<&HostSignal> {
        Some(&self.signal)
    }

    fn updater(&self) -> Option<ardia_ui::host::UpdaterState> {
        let (scratch, background) = (self.config.scratch, self.config.background);
        Some(crate::updater::with(scratch, background, |updater| {
            updater.state()
        }))
    }

    fn set_automatic_updates(&self, on: bool) {
        let (scratch, background) = (self.config.scratch, self.config.background);
        crate::updater::with(scratch, background, |updater| updater.set_automatic(on));
    }

    fn set_update_channel(&self, channel: ardia_ui::host::UpdateChannel) {
        let (scratch, background) = (self.config.scratch, self.config.background);
        crate::updater::with(scratch, background, |updater| updater.set_channel(channel));
    }

    fn check_for_updates(&self) {
        let (scratch, background) = (self.config.scratch, self.config.background);
        crate::updater::with(scratch, background, |updater| updater.check_now());
    }

    fn plugin_detail(&self, name: &str) -> Option<ardia_ui::host::PluginDetail> {
        self.plugins.lock().clone()?.settings_detail(name)
    }

    fn plugin_command(&self, name: &str, command: ardia_ui::host::PluginCommand) {
        let Some(service) = self.plugins.lock().clone() else {
            return;
        };
        match command {
            ardia_ui::host::PluginCommand::Restart => service.restart_plugin(name),
            ardia_ui::host::PluginCommand::Remove => {
                if service.remove_plugin(name) {
                    ardia_telemetry::counts::count("plugin_removals");
                }
            }
            ardia_ui::host::PluginCommand::ShowLog => {
                if let Some(log) = service.plugin_log(name) {
                    self.open_path(log.to_string_lossy().into_owned());
                }
            }
        }
    }

    fn official_plugins(&self) -> Option<Vec<ardia_ui::host::OfficialPlugin>> {
        self.plugin_service()
            .map(|service| service.official_plugins())
    }

    fn install_official_plugin(
        &self,
        name: String,
    ) -> Option<futures::channel::oneshot::Receiver<Result<(), String>>> {
        self.plugin_service()
            .map(|service| service.install_official(&name))
    }

    fn cancel_official_install(&self, name: String) {
        if let Some(service) = self.plugin_service() {
            service.cancel_official_install(&name);
        }
    }

    fn official_install_progress(
        &self,
        name: String,
    ) -> Option<ardia_ui::host::OfficialInstallPhase> {
        self.plugin_service()
            .and_then(|service| service.official_install_progress(&name))
    }

    fn linked_programs(&self, plugin: String) -> Vec<ardia_ui::host::LinkedProgram> {
        self.plugin_service()
            .map(|service| service.linked_programs(&plugin))
            .unwrap_or_default()
    }

    fn plugins(&self) -> Option<Arc<dyn ardia_ui::plugins::PluginHost>> {
        self.plugins
            .lock()
            .clone()
            .map(|service| service as Arc<dyn ardia_ui::plugins::PluginHost>)
    }

    fn extensions(&self, window_id: &WindowId) -> ExtensionList {
        self.extension_list(window_id)
    }

    fn set_extension_pinned(&self, window_id: WindowId, extension_id: String, pinned: bool) {
        self.pin_extension(&window_id, &extension_id, pinned);
    }

    fn extension_popup(&self, window_id: &WindowId) -> Option<ExtensionPopupView> {
        self.popup_view(window_id)
    }

    fn close_extension_popup(&self, window_id: WindowId) {
        self.close_popup(&window_id);
    }

    fn remove_extension(&self, window_id: WindowId, extension_id: String) {
        self.uninstall_extension(&window_id, &extension_id);
    }

    fn cast_panel(&self, tab_id: &TabId) -> Option<CastPanel> {
        self.cast_panel_for(tab_id)
    }

    fn start_casting(&self, tab_id: TabId, device_id: String) {
        self.cast_to(&tab_id, &device_id);
    }

    fn stop_casting(&self, tab_id: TabId, device_id: String) {
        self.stop_cast(&tab_id, &device_id);
    }

    fn set_cast_source(&self, tab_id: TabId, screen: bool) {
        self.choose_cast_source(&tab_id, screen);
    }

    fn cast_routes(&self, _window_id: &WindowId) -> Vec<ardia_ui::host_data::CastRouteInfo> {
        self.bridge
            .lock()
            .cast_routes
            .iter()
            .map(|route| ardia_ui::host_data::CastRouteInfo {
                id: route.id.clone(),
                sink: route.sink.clone(),
                description: route.description.clone(),
            })
            .collect()
    }

    fn stop_cast_route(&self, route_id: String) {
        let Some(engine) = self.engine() else {
            return;
        };
        if let Err(problem) = engine.global(ardia_engine::GlobalCommand::TerminateCastRoute {
            route_id: route_id.clone(),
        }) {
            log::warn!("casting to {route_id} didn't stop: {problem}");
        }
    }

    fn move_extension(&self, window_id: WindowId, extension_id: String, to: usize) {
        self.reorder_extension(&window_id, &extension_id, to);
    }

    fn side_panel(&self, window_id: &WindowId) -> Option<ardia_ui::host_data::SidePanelView> {
        self.side_panel_view(window_id)
    }

    fn toggle_side_panel(&self, window_id: WindowId, extension_id: String) {
        self.flip_side_panel(&window_id, &extension_id);
    }

    fn close_side_panel(&self, window_id: WindowId) {
        self.close_side_panel_on_tab(&window_id);
    }

    fn side_panel_wanted(&self, window_id: &WindowId) -> bool {
        AppCoordinator::side_panel_wanted(self, window_id)
    }

    fn extension_install(
        &self,
        window_id: &WindowId,
    ) -> Option<ardia_ui::host_data::ExtensionInstallView> {
        self.install_prompt_for(window_id)
    }

    fn resolve_extension_install(&self, request_id: String, accepted: bool) {
        self.answer_install(&request_id, accepted);
    }

    fn install_crx(&self, window_id: WindowId, path: String) {
        self.install_dropped_crx(&window_id, &path);
    }

    fn tab_capture(&self, tab_id: &TabId) -> Option<ardia_ui::host_data::CaptureBadge> {
        if self.shared_tab(tab_id) {
            return Some(ardia_ui::host_data::CaptureBadge::Screen);
        }
        let access = self.bridge.lock().media_access.get(tab_id).copied()?;
        ardia_ui::host_data::capture_badge(access.camera, access.microphone, access.screen)
    }

    fn pin_dialog_open(&self, window_id: &WindowId) -> bool {
        self.bridge.lock().pin_dialogs.contains(window_id)
    }

    fn set_pin_dialog(&self, window_id: WindowId, open: bool) {
        let changed = {
            let mut bridge = self.bridge.lock();
            if open {
                bridge.pin_dialogs.insert(window_id)
            } else {
                bridge.pin_dialogs.remove(&window_id)
            }
        };
        if changed {
            self.signal
                .emit(ardia_ui::host_data::HostTopics::EXTENSIONS);
        }
    }

    fn import_progress(&self) -> Option<ImportProgress> {
        AppCoordinator::import_progress(self)
    }

    fn import_browsers(&self) -> Option<Vec<ardia_ui::host_data::ImportBrowser>> {
        self.bridge.lock().import_browsers.clone()
    }

    fn refresh_import_browsers(&self) {
        crate::import::refresh_browsers(self);
    }

    fn run_import(&self, plan: ardia_ui::host_data::ImportPlan) {
        crate::import::run_plan(self, plan);
    }

    fn cancel_import(&self) {
        self.abort_import();
    }

    fn unlock_import(
        &self,
        browser_id: String,
        browser_name: String,
    ) -> futures::channel::oneshot::Receiver<Result<(), String>> {
        self.unlock_browser(browser_id, browser_name)
    }

    fn browser_icon(&self, browser_id: &str, points: f32) -> Option<Arc<gpui::Image>> {
        let path = crate::app_icons::browser_app_path(browser_id)?;
        self.file_icon(&path, points)
    }

    fn app_icon_for_pid(&self, pid: i32, points: f32) -> Option<Arc<gpui::Image>> {
        crate::app_icons::running_app_icon(pid, points)
    }

    fn tab_preview(&self, tab_id: &TabId) -> Option<Arc<gpui::Image>> {
        self.tab_preview_for(tab_id)
    }

    fn safari_access(&self) -> bool {
        cfg!(target_os = "macos")
            && std::env::var_os("HOME").is_some_and(|home| {
                crate::import_readers::safari_has_access(std::path::Path::new(&home))
            })
    }

    fn open_full_disk_access_settings(&self) {
        crate::import_readers::open_full_disk_access_settings();
    }

    fn open_extension_store_pages(&self, profile_id: ProfileId, urls: Vec<String>) {
        self.open_store_pages(&profile_id, &urls);
    }

    fn note_store_pages_opened(&self) {
        self.mark_store_pages_opened();
    }

    fn note_theme_preset(&self, event: ardia_ui::ThemePresetEvent) {
        crate::theme_preset_counts::note(event);
    }

    fn sync_status(&self) -> SyncStatus {
        crate::sync_engine::ui_bridge::status(self)
    }

    fn refresh_sync_status(&self) {
        crate::sync_engine::ui_bridge::engine(self);
        self.refresh_sync();
    }

    fn sync_action(&self, action: ardia_ui::sync_api::SyncAction) -> ardia_ui::sync_api::SyncReply {
        crate::sync_engine::ui_bridge::action(self, action)
    }

    fn set_sync_type(&self, data_type: String, on: bool) {
        self.write_sync_type(&data_type, on);
    }

    fn set_open_tabs_synced(&self, on: bool) {
        self.write_open_tabs_synced(on);
    }

    fn set_profile_synced(&self, profile: ProfileId, on: bool) {
        self.write_profile_synced(profile, on);
    }

    fn set_profile_tabs_synced(&self, profile: ProfileId, on: bool) {
        self.write_profile_tabs_synced(profile, on);
    }

    fn haptic_alignment(&self) {
        crate::profile_sync::haptic_alignment();
    }

    fn take_page_swipes(
        &self,
        window_id: &WindowId,
    ) -> Vec<ardia_ui::window::swipe_overlay::PageSwipe> {
        self.take_page_swipes_of(window_id)
    }

    fn note_swipe_list(&self, window_id: &WindowId, open: bool) {
        self.note_swipe_list_of(window_id, open);
    }

    fn swipe_haptic(&self, haptic: ardia_ui::window::swipe_overlay::SwipeHaptic) {
        crate::page_swipe::haptic(haptic);
    }

    fn page_scroll(
        &self,
        window_id: &WindowId,
        tab_id: Option<&TabId>,
        input: ardia_ui::window::swipe_tracker::ScrollInput,
    ) -> bool {
        self.page_scroll_from_gpui(window_id, tab_id, input)
    }

    fn unregister_gpui_window(&self, window_id: WindowId) {
        let removed = self.bridge.lock().gpui.remove(&window_id).is_some();
        if !removed || self.config.hosts_native_windows || self.is_shutting_down() {
            return;
        }
        if self.store.snapshot().window(window_id.as_str()).is_none() {
            return;
        }
        self.post(move |coordinator| {
            let open = coordinator
                .store
                .snapshot()
                .window(window_id.as_str())
                .is_some();
            if open
                && !coordinator.is_shutting_down()
                && coordinator.gpui_window(&window_id).is_none()
            {
                coordinator.dispatch(Action::CloseWindow { window: window_id });
            }
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn action_names_are_short() {
        assert_eq!(
            action_name(&Action::OpenLastWindowOrNew),
            "OpenLastWindowOrNew"
        );
        assert_eq!(
            action_name(&Action::ActivateTab {
                tab: TabId::new("t")
            }),
            "ActivateTab"
        );
        assert_eq!(password_action("notNow"), Some(PasswordPromptAction::Nope));
        assert_eq!(password_action("bogus"), None);
        assert_eq!(
            autofill_action("accept"),
            Some(AutofillPromptAction::Accept)
        );
    }

    fn mock_coordinator() -> Arc<AppCoordinator> {
        let store = Arc::new(BrowserStore::in_memory(
            ardia_state::BrowserState::from_session(
                ardia_state::persistence::session::SessionData::fresh(
                    ardia_state::persistence::session::LoadOptions::default(),
                ),
                1_795_000_000_000,
            ),
            ardia_state::ids::IdGen::with_launch("unit"),
        ));
        let engine: Arc<dyn BrowserEngine> = Arc::new(ardia_engine::MockBrowserEngine::started());
        let app = AppCoordinator::new(store, engine, CoordinatorConfig::default());
        app.start();
        app.pump();
        app
    }

    fn background_tab(app: &AppCoordinator, window: &WindowId, url: &str) -> TabId {
        app.dispatch_action(Action::NewTab {
            window: window.clone(),
            tab: ardia_state::NewTab {
                url: Some(url.into()),
                background: true,
                ..ardia_state::NewTab::default()
            },
        })
        .unwrap()
        .tab
        .unwrap()
    }

    #[test]
    fn a_page_that_stayed_never_closes_with_its_source() {
        let app = mock_coordinator();
        let window = app.focused_window().unwrap();
        let source = background_tab(&app, &window, "https://source.example/");
        let other = background_tab(&app, &window, "https://other.example/");
        let peek = app
            .dispatch_action(Action::OpenPeek {
                window,
                url: "https://peek.example/".into(),
                source: Some(source.clone()),
            })
            .unwrap()
            .tab
            .unwrap();
        let everything = Action::CloseTabs {
            tabs: vec![source.clone(), other.clone(), peek.clone()],
            last_closes_window: false,
        };
        assert!(
            app.pages_closed_by(&Action::CloseTabs {
                tabs: vec![source.clone()],
                last_closes_window: false,
            })
            .all()
            .contains(&peek),
            "closing the source takes its Peek along"
        );
        let chosen = app
            .closing_after_asking(
                everything,
                &[source.clone(), other.clone()],
                std::slice::from_ref(&peek),
                false,
            )
            .expect("the other tab can still close");
        let closes = app.pages_closed_by(&chosen).all();
        assert!(!closes.contains(&peek), "the page that stayed stays");
        assert!(!closes.contains(&source), "and so does the tab it needs");
        assert!(closes.contains(&other));
    }

    #[test]
    fn a_group_with_a_page_that_stayed_still_closes_as_a_group() {
        let app = mock_coordinator();
        let window = app.focused_window().unwrap();
        let first = background_tab(&app, &window, "https://first.example/");
        let second = background_tab(&app, &window, "https://second.example/");
        let group = app
            .dispatch_action(Action::CreateGroup {
                tabs: vec![first.clone(), second.clone()],
                name: "Pair".into(),
            })
            .unwrap()
            .group
            .unwrap();
        let chosen = app
            .closing_after_asking(
                Action::CloseGroup {
                    group: group.clone(),
                },
                std::slice::from_ref(&first),
                std::slice::from_ref(&second),
                false,
            )
            .expect("the rest of the group closes");
        assert_eq!(chosen, Action::CloseGroup { group });
        assert_eq!(app.pages_closed_by(&chosen).all(), vec![first]);
        let state = app.store().snapshot();
        assert!(
            state.group_of(second.as_str()).is_none(),
            "the page that stayed left the group"
        );
    }

    #[test]
    fn a_replay_must_close_the_same_tabs() {
        let tabs = |ids: &[&str]| ids.iter().map(|id| TabId::new(*id)).collect::<Vec<_>>();
        assert!(same_tabs(&tabs(&["a", "b"]), &tabs(&["b", "a"])));
        assert!(!same_tabs(&tabs(&["a", "b"]), &tabs(&["a"])));
        assert!(!same_tabs(&tabs(&["a"]), &tabs(&["c"])));
        let pages = ClosingPages {
            removed: tabs(&["a"]),
            unloaded: tabs(&["p"]),
        };
        assert_eq!(pages.all(), tabs(&["a", "p"]));
    }
}
