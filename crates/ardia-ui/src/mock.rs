use std::collections::HashMap;
use std::ffi::c_void;
use std::sync::Arc;

use ardia_engine::{DownloadCommand, NativeViewHandle, PermissionResult};
use ardia_state::ids::IdGen;
use ardia_state::persistence::session::{LoadOptions, SessionData};
use ardia_state::tabs::FindState;
use ardia_state::windows::WindowKind;
use ardia_state::{Action, BrowserState, BrowserStore, PageUpdate, ProfileId, TabId, WindowId};
use ardia_theme::IconTheme;
use gpui::{AnyWindowHandle, Image};
use parking_lot::Mutex;

use crate::host::{
    ClearBrowsingData, Confirmation, HostTabView, NativeMenuItem, PageCommand, UiHost,
    UtilityWindowKind,
};
use crate::host_data::{
    CastDeviceState, CastPanel, ExtensionItem, ExtensionList, ExtensionPopupView, HostSignal,
    HostTopics, ImportProgress, ImportStage, StageState, SyncStatus,
};
use crate::pages::reader::ReaderStatus;

pub const ZOOM_LEVELS: [f64; 17] = [
    0.25, 0.33, 0.5, 0.67, 0.75, 0.8, 0.9, 1.0, 1.1, 1.25, 1.5, 1.75, 2.0, 2.5, 3.0, 4.0, 5.0,
];

pub fn zoom_after(current: f64, direction: i32) -> f64 {
    let at = ZOOM_LEVELS
        .iter()
        .position(|level| (level - current).abs() < 0.005)
        .unwrap_or_else(|| {
            ZOOM_LEVELS
                .iter()
                .position(|level| *level > current)
                .unwrap_or(ZOOM_LEVELS.len() - 1)
        });
    let next = match direction.signum() {
        1 => (at + 1).min(ZOOM_LEVELS.len() - 1),
        -1 => at.saturating_sub(1),
        _ => return 1.0,
    };
    ZOOM_LEVELS[next]
}

#[derive(Clone, Debug, PartialEq)]
pub enum HostCall {
    Settings(crate::settings::data::SettingsCall),
    SiteAnswer(TabId, crate::site::SiteAnswer),
    ContentBlocker(crate::site::model::ContentBlockerCommand),
    AutomaticUpdates(bool),
    UpdateChannel(crate::host::UpdateChannel),
    CheckForUpdates,
    PluginCommand(String, crate::host::PluginCommand),
    TurnPluginOff(String),
    RefreshSitePanel(TabId),
    Replace {
        tab: TabId,
        query: String,
        replacement: String,
        all: bool,
    },
    Navigate {
        window: WindowId,
        tab: TabId,
        input: String,
    },
    Back(TabId),
    Forward(TabId),
    Reload {
        tab: TabId,
        hard: bool,
    },
    Stop(TabId),
    Mute {
        tab: TabId,
        muted: bool,
    },
    Zoom {
        tab: TabId,
        factor: f64,
    },
    Find {
        tab: TabId,
        query: String,
        forward: bool,
    },
    StopFinding(TabId),
    DevTools(TabId),
    Pip(TabId),
    Cast(TabId),
    Share(TabId),
    Download {
        id: String,
        command: DownloadCommand,
    },
    Reveal(String),
    Permission {
        request: String,
        result: PermissionResult,
        remember: bool,
    },
    Password {
        tab: TabId,
        action: String,
        username: Option<String>,
    },
    Autofill {
        tab: TabId,
        prompt: i64,
        action: String,
    },
    Extension {
        tab: TabId,
        extension: String,
    },
    LittleToMain(WindowId),
    Utility(UtilityWindowKind),
    Import {
        source: String,
        profile: ProfileId,
    },
    CloseWindow(WindowId),
    Register(WindowId),
    Unregister(WindowId),
    PinExtension {
        window: WindowId,
        extension: String,
        pinned: bool,
    },
    CloseExtensionPopup(WindowId),
    RemoveExtension {
        window: WindowId,
        extension: String,
    },
    StartCasting {
        tab: TabId,
        device: String,
        mode: i32,
    },
    CastSource {
        tab: TabId,
        screen: bool,
    },
    StopCasting {
        tab: TabId,
        device: String,
    },
    RefreshSync,
    SyncType {
        data_type: String,
        on: bool,
    },
    RunImport(crate::host_data::ImportPlan),
    CancelImport,
    RefreshImportBrowsers,
    OpenFile(WindowId),
    Confirm {
        window: WindowId,
        question: Confirmation,
    },
    ClearBrowsingData {
        profile: ProfileId,
        request: ClearBrowsingData,
    },
    ShowMenu(Vec<NativeMenuItem>),
    Prompt(crate::host::TextPrompt),
    OpenPath(String),
    Trash(String),
    OpenWhenDone(String),
    ToggleReader(TabId),
    TogglePageEngine(TabId),
    ResetPageEngine(TabId),
    OpenPageIn(TabId, ardia_state::model::PageEngine),
    SetEngineMode(ardia_state::settings::EngineMode),
    PageCommand {
        tab: TabId,
        command: PageCommand,
    },
    MediaAction {
        tab: TabId,
        action: crate::media::session::MediaAction,
    },
    DismissPlayer(TabId),
    AnswerDisplay {
        tab: TabId,
        source: Option<String>,
        audio: bool,
    },
    ShareTabWith {
        tab: TabId,
        shared: TabId,
        audio: bool,
    },
    InstallCrx {
        window: WindowId,
        path: String,
    },
    SaveOnboarding(crate::host::OnboardingRecord),
    OnboardingSystem(crate::host::OnboardingSystemChoice),
    Sharing(bool),
    ProfileSynced(ProfileId, bool),
    ProfileTabsSynced(ProfileId, bool),
}

type PopupRecord = (String, String, usize, (f32, f32), bool);

#[derive(Default)]
struct Recorded {
    calls: Vec<HostCall>,
    official_plugins: Option<Vec<crate::host::OfficialPlugin>>,
    updater: Option<crate::host::UpdaterState>,
    plugin_details: Vec<crate::host::PluginDetail>,
    official_failure: Option<String>,
    site_pages: HashMap<TabId, crate::site::SitePage>,
    site_panels: HashMap<TabId, crate::site::SitePanel>,
    selections: HashMap<TabId, crate::site::model::PageSelection>,
    content_blocker: Option<crate::site::model::ContentBlockerView>,
    views: HashMap<TabId, (usize, usize)>,
    icon_themes: HashMap<TabId, IconTheme>,
    find_matches: u32,
    extensions: Vec<ExtensionItem>,
    popups: HashMap<WindowId, PopupRecord>,
    casts: HashMap<TabId, CastPanel>,
    import: Option<ImportProgress>,
    imports: u64,
    sync: SyncStatus,
    browsers: Option<Vec<crate::host_data::ImportBrowser>>,
    favicons: HashMap<String, Arc<Image>>,
    page_favicons: HashMap<String, Arc<Image>>,
    inkers: HashMap<String, crate::primitives::favicon::FaviconInker>,
    backdrop: Option<Arc<Image>>,
    backdrop_asks: Vec<(
        crate::primitives::favicon::Favicon,
        crate::host::PinnedBackdrop,
    )>,
    readers: HashMap<TabId, ReaderStatus>,
    confirm_answer: bool,
    sync_actions: Vec<crate::sync_api::SyncAction>,
    sync_answers: std::collections::VecDeque<crate::sync_api::SyncAnswer>,
    settings_values: HashMap<crate::settings::data::SettingsQuery, serde_json::Value>,
    settings_revisions: HashMap<crate::settings::data::SettingsQuery, u64>,
    settings_revision: u64,
    settings_replies: Vec<(String, serde_json::Value)>,
    menu_pick: Option<Option<String>>,
    prompt_answer: Option<Option<String>>,
    arc_themes: Vec<crate::host::ArcThemeChoice>,
    open_when_done: Vec<String>,
    webkit: bool,
    engine_switching: bool,
    passkeys_entitled: bool,
}

pub struct MockUiHost {
    store: Arc<BrowserStore>,
    recorded: Mutex<Recorded>,
    signal: HostSignal,
    plugins: Mutex<Option<Arc<dyn crate::plugins::PluginHost>>>,
    media: Mutex<crate::media::session::MediaBook>,
    display: Mutex<HashMap<TabId, crate::media::share::DisplayRequest>>,
    shares: Mutex<HashMap<TabId, (TabId, crate::media::share::TabShare)>>,
    unlock_refused: Mutex<bool>,
}

pub fn fresh_state() -> BrowserState {
    BrowserState::from_session(
        SessionData::fresh(LoadOptions::default()),
        ardia_state::store::now_ms(),
    )
}

impl MockUiHost {
    pub fn set_settings_value(
        &self,
        query: crate::settings::data::SettingsQuery,
        value: serde_json::Value,
    ) {
        let mut recorded = self.recorded.lock();
        recorded.settings_revision += 1;
        let revision = recorded.settings_revision;
        recorded.settings_revisions.insert(query.clone(), revision);
        recorded.settings_values.insert(query, value);
    }

    pub fn reply_to_settings(&self, variant: &str, value: serde_json::Value) {
        self.recorded
            .lock()
            .settings_replies
            .push((variant.to_owned(), value));
    }

    pub fn settings_calls(&self) -> Vec<crate::settings::data::SettingsCall> {
        self.recorded
            .lock()
            .calls
            .iter()
            .filter_map(|call| match call {
                HostCall::Settings(call) => Some(call.clone()),
                _ => None,
            })
            .collect()
    }

    pub fn set_site_page(&self, tab: TabId, page: Option<crate::site::SitePage>) {
        let mut recorded = self.recorded.lock();
        match page {
            Some(page) => recorded.site_pages.insert(tab, page),
            None => recorded.site_pages.remove(&tab),
        };
    }

    pub fn set_content_blocker(&self, view: Option<crate::site::model::ContentBlockerView>) {
        self.recorded.lock().content_blocker = view;
    }

    pub fn set_site_panel(&self, tab: TabId, panel: crate::site::SitePanel) {
        self.recorded.lock().site_panels.insert(tab, panel);
    }

    pub fn set_page_selection(
        &self,
        tab: TabId,
        selection: Option<crate::site::model::PageSelection>,
    ) {
        let mut recorded = self.recorded.lock();
        match selection {
            Some(selection) => recorded.selections.insert(tab, selection),
            None => recorded.selections.remove(&tab),
        };
    }

    pub fn new(store: Arc<BrowserStore>) -> Arc<Self> {
        Arc::new(MockUiHost {
            store,
            recorded: Mutex::new(Recorded {
                find_matches: 3,
                ..Recorded::default()
            }),
            signal: HostSignal::new(),
            plugins: Mutex::new(None),
            media: Mutex::new(crate::media::session::MediaBook::default()),
            display: Mutex::new(HashMap::new()),
            shares: Mutex::new(HashMap::new()),
            unlock_refused: Mutex::new(false),
        })
    }

    pub fn refuse_unlock(&self, refused: bool) {
        *self.unlock_refused.lock() = refused;
    }

    pub fn set_display_request(&self, tab: &TabId, request: crate::media::share::DisplayRequest) {
        self.display.lock().insert(tab.clone(), request);
        self.signal.emit(crate::host_data::HostTopics::PAGE);
    }

    pub fn set_share_bar(
        &self,
        tab: &TabId,
        capturer: &TabId,
        share: crate::media::share::TabShare,
    ) {
        self.shares
            .lock()
            .insert(tab.clone(), (capturer.clone(), share));
        self.signal.emit(crate::host_data::HostTopics::PAGE);
    }

    pub fn set_now_playing(
        &self,
        tab: &TabId,
        report: Option<crate::media::session::NowPlaying>,
        now_ms: f64,
    ) {
        let state = self.store.snapshot();
        self.media.lock().apply(&state, tab, report, now_ms);
        self.signal.emit(crate::host_data::HostTopics::PAGE);
    }

    pub fn set_updater(&self, updater: Option<crate::host::UpdaterState>) {
        self.recorded.lock().updater = updater;
    }

    pub fn set_plugin_details(&self, details: Vec<crate::host::PluginDetail>) {
        self.recorded.lock().plugin_details = details;
    }

    pub fn set_official_plugins(
        &self,
        plugins: Option<Vec<crate::host::OfficialPlugin>>,
        failure: Option<String>,
    ) {
        let mut recorded = self.recorded.lock();
        recorded.official_plugins = plugins;
        recorded.official_failure = failure;
    }

    pub fn set_plugins(&self, plugins: Option<Arc<dyn crate::plugins::PluginHost>>) {
        *self.plugins.lock() = plugins;
        self.signal.emit(crate::host_data::HostTopics::PLUGINS);
    }

    pub fn fresh() -> Arc<Self> {
        Self::new(Arc::new(BrowserStore::in_memory(
            fresh_state(),
            IdGen::with_launch("mock"),
        )))
    }

    pub fn set_webkit(&self, offered: bool, switching: bool, passkeys_entitled: bool) {
        let mut recorded = self.recorded.lock();
        recorded.webkit = offered;
        recorded.engine_switching = switching;
        recorded.passkeys_entitled = passkeys_entitled;
    }

    pub fn calls(&self) -> Vec<HostCall> {
        self.recorded.lock().calls.clone()
    }

    pub fn take_calls(&self) -> Vec<HostCall> {
        std::mem::take(&mut self.recorded.lock().calls)
    }

    pub fn set_find_matches(&self, count: u32) {
        self.recorded.lock().find_matches = count;
    }

    pub fn set_icon_theme(&self, tab: TabId, theme: IconTheme) {
        self.recorded.lock().icon_themes.insert(tab, theme);
    }

    pub fn set_native_views(
        &self,
        tab: TabId,
        page: Option<NativeViewHandle>,
        devtools: Option<NativeViewHandle>,
    ) {
        let page = page.map_or(0, |view| view.as_ptr() as usize);
        let devtools = devtools.map_or(0, |view| view.as_ptr() as usize);
        self.recorded.lock().views.insert(tab, (page, devtools));
    }

    pub fn open_window(&self, kind: WindowKind, url: Option<&str>) -> Option<WindowId> {
        self.store
            .dispatch(Action::OpenWindow {
                kind,
                profile: None,
                url: url.map(str::to_owned),
                frame: None,
            })
            .ok()
            .and_then(|outcome| outcome.window)
    }

    pub fn signal(&self) -> &HostSignal {
        &self.signal
    }

    pub fn set_extensions(&self, items: Vec<ExtensionItem>) {
        self.recorded.lock().extensions = items;
        self.signal.emit(HostTopics::EXTENSIONS);
    }

    pub fn set_extension_popup(&self, window: WindowId, popup: Option<ExtensionPopupView>) {
        {
            let mut recorded = self.recorded.lock();
            match popup {
                Some(popup) => recorded.popups.insert(
                    window,
                    (
                        popup.extension_id,
                        popup.name,
                        popup.view.map_or(0, |view| view.as_ptr() as usize),
                        popup.size,
                        popup.sized,
                    ),
                ),
                None => recorded.popups.remove(&window),
            };
        }
        self.signal.emit(HostTopics::EXTENSIONS);
    }

    pub fn set_cast_panel(&self, tab: TabId, panel: Option<CastPanel>) {
        {
            let mut recorded = self.recorded.lock();
            match panel {
                Some(panel) => recorded.casts.insert(tab, panel),
                None => recorded.casts.remove(&tab),
            };
        }
        self.signal.emit(HostTopics::CAST);
    }

    pub fn set_import_progress(&self, progress: Option<ImportProgress>) {
        self.recorded.lock().import = progress;
        self.signal.emit(HostTopics::IMPORT);
    }

    pub fn update_import(&self, change: impl FnOnce(&mut ImportProgress)) {
        let changed = {
            let mut recorded = self.recorded.lock();
            recorded.import.as_mut().map(change).is_some()
        };
        if changed {
            self.signal.emit(HostTopics::IMPORT);
        }
    }

    pub fn set_import_browsers(&self, browsers: Option<Vec<crate::host_data::ImportBrowser>>) {
        self.recorded.lock().browsers = browsers;
        self.signal.emit(HostTopics::IMPORT);
    }

    pub fn sync_actions(&self) -> Vec<crate::sync_api::SyncAction> {
        self.recorded.lock().sync_actions.clone()
    }

    pub fn queue_sync_answer(&self, answer: crate::sync_api::SyncAnswer) {
        self.recorded.lock().sync_answers.push_back(answer);
    }

    pub fn set_sync_status(&self, status: SyncStatus) {
        self.recorded.lock().sync = status;
        self.signal.emit(HostTopics::SYNC);
    }

    fn change_cast(
        &self,
        tab: &TabId,
        device: &str,
        change: impl FnOnce(&mut crate::host_data::CastDevice),
    ) {
        let changed = {
            let mut recorded = self.recorded.lock();
            recorded
                .casts
                .get_mut(tab)
                .and_then(|panel| panel.devices.iter_mut().find(|d| d.id == device))
                .map(change)
                .is_some()
        };
        if changed {
            self.signal.emit(HostTopics::CAST);
        }
    }

    pub fn set_menu_pick(&self, pick: Option<Option<String>>) {
        self.recorded.lock().menu_pick = pick;
    }

    pub fn set_prompt_answer(&self, answer: Option<Option<String>>) {
        self.recorded.lock().prompt_answer = answer;
    }

    pub fn set_arc_themes(&self, themes: Vec<crate::host::ArcThemeChoice>) {
        self.recorded.lock().arc_themes = themes;
    }

    pub fn set_confirm_answer(&self, answer: bool) {
        self.recorded.lock().confirm_answer = answer;
    }

    pub fn set_pinned_backdrop(&self, image: Option<Arc<Image>>) {
        self.recorded.lock().backdrop = image;
    }

    pub fn pinned_backdrop_asks(
        &self,
    ) -> Vec<(
        crate::primitives::favicon::Favicon,
        crate::host::PinnedBackdrop,
    )> {
        self.recorded.lock().backdrop_asks.clone()
    }

    pub fn set_favicon_inker(&self, url: &str, inker: crate::primitives::favicon::FaviconInker) {
        self.recorded.lock().inkers.insert(url.to_owned(), inker);
    }

    pub fn set_favicon_image(&self, url: &str, image: Arc<Image>) {
        self.recorded.lock().favicons.insert(url.to_owned(), image);
    }

    pub fn set_page_favicon(&self, page: &str, image: Arc<Image>) {
        self.recorded
            .lock()
            .page_favicons
            .insert(page.to_owned(), image);
    }

    pub fn set_reader(&self, tab: TabId, reader: ReaderStatus) {
        self.recorded.lock().readers.insert(tab, reader);
    }

    fn record(&self, call: HostCall) {
        self.recorded.lock().calls.push(call);
    }

    fn act(&self, action: Action) {
        if let Err(error) = self.store.dispatch(action) {
            log::debug!("mock host action failed: {error}");
        }
    }
}

impl UiHost for MockUiHost {
    fn updater(&self) -> Option<crate::host::UpdaterState> {
        self.recorded.lock().updater.clone()
    }

    fn set_automatic_updates(&self, on: bool) {
        self.recorded
            .lock()
            .calls
            .push(HostCall::AutomaticUpdates(on));
    }

    fn set_update_channel(&self, channel: crate::host::UpdateChannel) {
        self.recorded
            .lock()
            .calls
            .push(HostCall::UpdateChannel(channel));
    }

    fn check_for_updates(&self) {
        self.recorded.lock().calls.push(HostCall::CheckForUpdates);
    }

    fn plugin_rows(&self) -> Vec<crate::host::PluginRow> {
        self.recorded
            .lock()
            .plugin_details
            .iter()
            .map(|detail| crate::host::PluginRow {
                name: detail.name.clone(),
                active: detail.active,
                problems: detail.problems.clone(),
            })
            .collect()
    }

    fn plugin_detail(&self, name: &str) -> Option<crate::host::PluginDetail> {
        self.recorded
            .lock()
            .plugin_details
            .iter()
            .find(|detail| detail.name == name)
            .cloned()
    }

    fn plugin_command(&self, name: &str, command: crate::host::PluginCommand) {
        self.recorded
            .lock()
            .calls
            .push(HostCall::PluginCommand(name.to_owned(), command));
    }

    fn turn_plugin_off(&self, name: String) {
        self.recorded
            .lock()
            .calls
            .push(HostCall::TurnPluginOff(name));
    }

    fn official_plugins(&self) -> Option<Vec<crate::host::OfficialPlugin>> {
        self.recorded.lock().official_plugins.clone()
    }

    fn install_official_plugin(
        &self,
        name: String,
    ) -> Option<futures::channel::oneshot::Receiver<Result<(), String>>> {
        let (answer, reply) = futures::channel::oneshot::channel();
        let mut recorded = self.recorded.lock();
        let result = match recorded.official_failure.clone() {
            Some(reason) => Err(reason),
            None => {
                if let Some(plugin) = recorded
                    .official_plugins
                    .iter_mut()
                    .flatten()
                    .find(|p| p.name == name)
                {
                    plugin.state = crate::host::OfficialPluginState::Installed;
                }
                Ok(())
            }
        };
        let _ = answer.send(result);
        Some(reply)
    }

    fn store(&self) -> &Arc<BrowserStore> {
        &self.store
    }

    fn media_session(&self, tab_id: &TabId) -> Option<crate::media::session::Session> {
        self.media.lock().session(tab_id).cloned()
    }

    fn media_action(&self, tab_id: TabId, action: crate::media::session::MediaAction) {
        self.media
            .lock()
            .action(&tab_id, action, crate::media::mini_player::now_ms());
        self.record(HostCall::MediaAction {
            tab: tab_id,
            action,
        });
    }

    fn dismiss_player(&self, tab_id: TabId) {
        self.media.lock().dismiss(&tab_id);
        self.record(HostCall::DismissPlayer(tab_id));
    }

    fn display_request(&self, tab_id: &TabId) -> Option<crate::media::share::DisplayRequest> {
        self.display.lock().get(tab_id).cloned()
    }

    fn answer_display_request(&self, tab_id: TabId, source: Option<String>, audio: bool) {
        self.display.lock().remove(&tab_id);
        self.record(HostCall::AnswerDisplay {
            tab: tab_id,
            source,
            audio,
        });
    }

    fn install_crx(&self, window_id: WindowId, path: String) {
        self.record(HostCall::InstallCrx {
            window: window_id,
            path,
        });
    }

    fn share_tab_with(&self, tab_id: TabId, shared: TabId, audio: bool) {
        self.display.lock().remove(&tab_id);
        self.record(HostCall::ShareTabWith {
            tab: tab_id,
            shared,
            audio,
        });
    }

    fn share_bar(&self, tab_id: &TabId) -> Option<(TabId, crate::media::share::TabShare)> {
        self.shares.lock().get(tab_id).cloned()
    }

    fn unlock_import(
        &self,
        _browser_id: String,
        browser_name: String,
    ) -> futures::channel::oneshot::Receiver<Result<(), String>> {
        let (answer, reply) = futures::channel::oneshot::channel();
        let outcome = if *self.unlock_refused.lock() {
            Err(format!(
                "macOS didn't allow access to {browser_name}'s keychain item. Try again, or skip the encrypted data."
            ))
        } else {
            Ok(())
        };
        let _ = answer.send(outcome);
        reply
    }

    fn dismiss_share_bar(&self, _capturer: TabId, tab_id: TabId) {
        self.shares.lock().remove(&tab_id);
    }

    fn shows_mini_player(&self, tab_id: &TabId) -> bool {
        let state = self.store.snapshot();
        self.media.lock().shows_mini_player(&state, tab_id)
    }

    fn sidebar_player_tab(&self, window_id: &WindowId, profile_id: &ProfileId) -> Option<TabId> {
        let state = self.store.snapshot();
        self.media
            .lock()
            .sidebar_player_tab(&state, window_id, profile_id)
    }

    fn dispatch(&self, action: Action) {
        self.act(action);
    }

    fn navigate(&self, window: WindowId, tab: TabId, input: String) {
        self.record(HostCall::Navigate {
            window,
            tab: tab.clone(),
            input: input.clone(),
        });
        self.act(Action::Navigate {
            tab: tab.clone(),
            input,
        });
        let pending = self.store.read(|state| {
            state
                .tab(tab.as_str())
                .and_then(|t| t.live.navigation.clone())
        });
        if let Some(url) = pending {
            self.act(Action::UpdatePage {
                tab,
                update: PageUpdate {
                    url: Some(url),
                    loading: Some(false),
                    progress: Some(1.0),
                    ..PageUpdate::default()
                },
            });
        }
    }

    fn go_back(&self, tab: TabId) {
        self.record(HostCall::Back(tab));
    }

    fn go_forward(&self, tab: TabId) {
        self.record(HostCall::Forward(tab));
    }

    fn reload(&self, tab: TabId, ignore_cache: bool) {
        self.record(HostCall::Reload {
            tab,
            hard: ignore_cache,
        });
    }

    fn stop_loading(&self, tab: TabId) {
        self.record(HostCall::Stop(tab));
    }

    fn set_muted(&self, tab: TabId, muted: bool) {
        self.record(HostCall::Mute {
            tab: tab.clone(),
            muted,
        });
        self.act(Action::SetMuted { tab, muted });
    }

    fn set_zoom(&self, tab: TabId, factor: f64) {
        self.record(HostCall::Zoom {
            tab: tab.clone(),
            factor,
        });
        self.act(Action::SetZoom { tab, zoom: factor });
    }

    fn zoom_step(&self, tab: TabId, direction: i32) {
        let current = self
            .store
            .read(|state| state.tab(tab.as_str()).map_or(1.0, |t| t.zoom));
        self.set_zoom(tab, zoom_after(current, direction));
    }

    fn find_in_page(&self, tab: TabId, query: String, forward: bool) {
        self.record(HostCall::Find {
            tab: tab.clone(),
            query: query.clone(),
            forward,
        });
        let count = self.recorded.lock().find_matches;
        let find = self
            .store
            .read(|state| state.tab(tab.as_str()).map(|t| t.live.find.clone()));
        if let Some(find) = find {
            let active = if count == 0 {
                0
            } else if find.query == query && find.count.is_some() {
                if forward {
                    find.active % count + 1
                } else if find.active <= 1 {
                    count
                } else {
                    find.active - 1
                }
            } else {
                1
            };
            self.act(Action::SetFind {
                tab,
                find: FindState {
                    open: true,
                    query,
                    count: Some(count),
                    active,
                    replace: find.replace,
                },
            });
        }
    }

    fn stop_finding(&self, tab: TabId) {
        self.record(HostCall::StopFinding(tab));
    }

    fn replace_in_page(&self, tab: TabId, query: String, replacement: String, all: bool) {
        self.record(HostCall::Replace {
            tab,
            query,
            replacement,
            all,
        });
    }

    fn toggle_devtools(&self, tab: TabId) {
        self.record(HostCall::DevTools(tab));
    }

    fn enter_pip(&self, tab: TabId) {
        self.record(HostCall::Pip(tab));
    }

    fn show_cast(&self, tab: TabId) {
        self.record(HostCall::Cast(tab));
    }

    fn share_tab(&self, tab: TabId) {
        self.record(HostCall::Share(tab));
    }

    fn tab_native_views(&self, tab_id: TabId) -> Option<HostTabView> {
        let (page, devtools) = *self.recorded.lock().views.get(&tab_id)?;
        let handle = |raw: usize| (raw != 0).then_some(NativeViewHandle(raw as *mut c_void));
        Some(HostTabView {
            tab_id,
            page_view: handle(page),
            devtools_view: handle(devtools),
        })
    }

    fn icon_theme_for(&self, tab_id: TabId) -> Option<IconTheme> {
        let recorded = self.recorded.lock().icon_themes.get(&tab_id).copied();
        recorded.or_else(|| {
            self.store
                .read(|state| state.tab(tab_id.as_str()).and_then(|t| t.live.icon_theme))
        })
    }

    fn download_command(&self, download_id: String, command: DownloadCommand) {
        self.record(HostCall::Download {
            id: download_id,
            command,
        });
    }

    fn reveal_path(&self, path: String) {
        self.record(HostCall::Reveal(path));
    }

    fn resolve_permission(&self, request_id: String, result: PermissionResult, remember: bool) {
        self.record(HostCall::Permission {
            request: request_id,
            result,
            remember,
        });
    }

    fn resolve_password_prompt(
        &self,
        tab_id: TabId,
        action: String,
        username: Option<String>,
        _password: Option<String>,
    ) {
        self.record(HostCall::Password {
            tab: tab_id,
            action,
            username,
        });
    }

    fn resolve_autofill_prompt(&self, tab_id: TabId, prompt_id: i64, action: String) {
        self.record(HostCall::Autofill {
            tab: tab_id,
            prompt: prompt_id,
            action,
        });
    }

    fn execute_extension_action(&self, tab_id: TabId, extension_id: String) {
        self.record(HostCall::Extension {
            tab: tab_id,
            extension: extension_id,
        });
    }

    fn open_little_ardia_in_main(&self, window_id: WindowId) {
        self.record(HostCall::LittleToMain(window_id.clone()));
        self.act(Action::PromoteLittleArdia { window: window_id });
    }

    fn open_utility_window(&self, kind: UtilityWindowKind) {
        self.record(HostCall::Utility(kind));
    }

    fn start_import(&self, source: String, profile_id: ProfileId) {
        self.record(HostCall::Import {
            source: source.clone(),
            profile: profile_id,
        });
        let (browser, data) = source.split_once(':').unwrap_or((source.as_str(), ""));
        let stages = data
            .split(',')
            .filter(|key| !key.is_empty())
            .map(|key| ImportStage::new(key, key))
            .collect();
        let run = {
            let mut recorded = self.recorded.lock();
            recorded.imports += 1;
            recorded.imports
        };
        let mut progress = ImportProgress::new(run, browser, stages);
        if let Some(first) = progress.stages.first_mut() {
            first.state = StageState::Running;
        }
        self.set_import_progress(Some(progress));
    }

    fn request_window_close(&self, window_id: WindowId) {
        self.record(HostCall::CloseWindow(window_id.clone()));
        self.act(Action::CloseWindow { window: window_id });
    }

    fn register_gpui_window(&self, window_id: WindowId, _handle: AnyWindowHandle) {
        self.record(HostCall::Register(window_id));
    }

    fn unregister_gpui_window(&self, window_id: WindowId) {
        self.record(HostCall::Unregister(window_id));
    }

    fn host_signal(&self) -> Option<&HostSignal> {
        Some(&self.signal)
    }

    fn plugins(&self) -> Option<Arc<dyn crate::plugins::PluginHost>> {
        self.plugins.lock().clone()
    }

    fn extensions(&self, window_id: &WindowId) -> ExtensionList {
        let profile = self.store.read(|state| {
            state
                .window(window_id.as_str())
                .map(|w| w.profile_id.clone())
        });
        ExtensionList {
            profile,
            loaded: true,
            items: Arc::new(self.recorded.lock().extensions.clone()),
        }
    }

    fn set_extension_pinned(&self, window_id: WindowId, extension_id: String, pinned: bool) {
        self.record(HostCall::PinExtension {
            window: window_id,
            extension: extension_id.clone(),
            pinned,
        });
        let changed = {
            let mut recorded = self.recorded.lock();
            let next = recorded
                .extensions
                .iter()
                .filter_map(|item| item.pinned_index)
                .max()
                .map_or(0, |last| last + 1);
            recorded
                .extensions
                .iter_mut()
                .find(|item| item.id == extension_id)
                .map(|item| {
                    item.pinned = pinned;
                    item.pinned_index = pinned.then_some(next);
                })
                .is_some()
        };
        if changed {
            self.signal.emit(HostTopics::EXTENSIONS);
        }
    }

    fn extension_popup(&self, window_id: &WindowId) -> Option<ExtensionPopupView> {
        let (extension_id, name, view, size, sized) =
            self.recorded.lock().popups.get(window_id).cloned()?;
        Some(ExtensionPopupView {
            extension_id,
            name,
            view: (view != 0).then_some(NativeViewHandle(view as *mut c_void)),
            size,
            sized,
        })
    }

    fn close_extension_popup(&self, window_id: WindowId) {
        self.record(HostCall::CloseExtensionPopup(window_id.clone()));
        if self.recorded.lock().popups.remove(&window_id).is_some() {
            self.signal.emit(HostTopics::EXTENSIONS);
        }
    }

    fn remove_extension(&self, window_id: WindowId, extension_id: String) {
        self.record(HostCall::RemoveExtension {
            window: window_id,
            extension: extension_id.clone(),
        });
        self.recorded
            .lock()
            .extensions
            .retain(|item| item.id != extension_id);
        self.signal.emit(HostTopics::EXTENSIONS);
    }

    fn casting(&self, _window_id: &WindowId) -> bool {
        self.recorded
            .lock()
            .casts
            .values()
            .any(|panel| panel.devices.iter().any(|device| device.casting()))
    }

    fn cast_panel(&self, tab_id: &TabId) -> Option<CastPanel> {
        self.recorded.lock().casts.get(tab_id).cloned()
    }

    fn start_casting(&self, tab_id: TabId, device_id: String) {
        let choice = {
            let recorded = self.recorded.lock();
            recorded.casts.get(&tab_id).and_then(|panel| {
                panel
                    .devices
                    .iter()
                    .find(|device| device.id == device_id)
                    .map(|device| crate::host_data::cast_mode::click(device.modes, panel.screen))
            })
        };
        match choice {
            Some(crate::host_data::cast_mode::CastClick::Start(mode)) => {
                self.record(HostCall::StartCasting {
                    tab: tab_id.clone(),
                    device: device_id.clone(),
                    mode,
                });
                self.change_cast(&tab_id, &device_id, |device| {
                    device.state = CastDeviceState::Connected;
                    device.route_id = format!("route-{}", device.id);
                });
            }
            Some(crate::host_data::cast_mode::CastClick::ShowScreenSource) => {
                self.set_cast_source(tab_id, true);
            }
            _ => {}
        }
    }

    fn set_cast_source(&self, tab_id: TabId, screen: bool) {
        self.record(HostCall::CastSource {
            tab: tab_id.clone(),
            screen,
        });
        let changed = self
            .recorded
            .lock()
            .casts
            .get_mut(&tab_id)
            .map(|panel| panel.screen = screen)
            .is_some();
        if changed {
            self.signal.emit(HostTopics::CAST);
        }
    }

    fn stop_casting(&self, tab_id: TabId, device_id: String) {
        self.record(HostCall::StopCasting {
            tab: tab_id.clone(),
            device: device_id.clone(),
        });
        self.change_cast(&tab_id, &device_id, |device| {
            device.state = CastDeviceState::Available;
            device.route_id.clear();
        });
    }

    fn import_progress(&self) -> Option<ImportProgress> {
        self.recorded.lock().import.clone()
    }

    fn import_browsers(&self) -> Option<Vec<crate::host_data::ImportBrowser>> {
        self.recorded.lock().browsers.clone()
    }

    fn refresh_import_browsers(&self) {
        self.record(HostCall::RefreshImportBrowsers);
    }

    fn run_import(&self, plan: crate::host_data::ImportPlan) {
        self.record(HostCall::RunImport(plan.clone()));
        let stages = plan
            .kinds
            .iter()
            .map(|key| ImportStage::new(key, key))
            .collect();
        let run = {
            let mut recorded = self.recorded.lock();
            recorded.imports += 1;
            recorded.imports
        };
        let mut progress = ImportProgress::new(run, &plan.source_name, stages);
        progress.preparing = plan.profiles.len().max(1);
        if let Some(first) = progress.stages.first_mut() {
            first.state = StageState::Running;
        }
        self.set_import_progress(Some(progress));
    }

    fn cancel_import(&self) {
        self.record(HostCall::CancelImport);
    }

    fn sync_status(&self) -> SyncStatus {
        self.recorded.lock().sync.clone()
    }

    fn refresh_sync_status(&self) {
        self.record(HostCall::RefreshSync);
    }

    fn set_sync_type(&self, data_type: String, on: bool) {
        self.record(HostCall::SyncType {
            data_type: data_type.clone(),
            on,
        });
        let mut status = self.recorded.lock().sync.clone();
        status.data_types.insert(data_type, on);
        self.set_sync_status(status);
    }

    fn sync_action(&self, action: crate::sync_api::SyncAction) -> crate::sync_api::SyncReply {
        let mut recorded = self.recorded.lock();
        let answer = match &action {
            crate::sync_api::SyncAction::FolderInfo(_)
                if !matches!(
                    recorded.sync_answers.front(),
                    Some(crate::sync_api::SyncAnswer::Folder(_))
                ) =>
            {
                crate::sync_api::SyncAnswer::Folder(None)
            }
            _ => recorded
                .sync_answers
                .pop_front()
                .unwrap_or(crate::sync_api::SyncAnswer::Done),
        };
        recorded.sync_actions.push(action);
        crate::sync_api::answered(answer)
    }

    fn favicon_image(&self, _profile: &ProfileId, url: &str) -> Option<Arc<Image>> {
        self.recorded.lock().favicons.get(url).cloned()
    }

    fn pinned_backdrop(
        &self,
        icon: &crate::primitives::favicon::Favicon,
        look: crate::host::PinnedBackdrop,
    ) -> Option<Arc<Image>> {
        let mut recorded = self.recorded.lock();
        recorded.backdrop_asks.push((icon.clone(), look));
        recorded.backdrop.clone()
    }

    fn favicon_inker(&self, url: &str) -> Option<crate::primitives::favicon::FaviconInker> {
        self.recorded.lock().inkers.get(url).cloned()
    }

    fn page_favicon(&self, _profile: &ProfileId, url: &str) -> Option<Arc<Image>> {
        self.recorded.lock().page_favicons.get(url).cloned()
    }

    fn open_file(&self, window_id: WindowId) {
        self.record(HostCall::OpenFile(window_id));
    }

    fn settings_value(
        &self,
        query: &crate::settings::data::SettingsQuery,
    ) -> Option<serde_json::Value> {
        self.recorded.lock().settings_values.get(query).cloned()
    }

    fn settings_revision(&self, query: &crate::settings::data::SettingsQuery) -> Option<u64> {
        self.recorded.lock().settings_revisions.get(query).copied()
    }

    fn settings_call(
        &self,
        call: crate::settings::data::SettingsCall,
    ) -> crate::settings::data::CallReply {
        let variant = format!("{call:?}");
        let variant = variant
            .split(['(', ' ', '{'])
            .next()
            .unwrap_or_default()
            .to_owned();
        self.record(HostCall::Settings(call));
        let reply = {
            let mut recorded = self.recorded.lock();
            let at = recorded
                .settings_replies
                .iter()
                .position(|(name, _)| *name == variant);
            at.map(|at| recorded.settings_replies.remove(at).1)
        };
        let (answer, receiver) = futures::channel::oneshot::channel();
        let _ = answer.send(Ok(reply.unwrap_or_else(|| serde_json::json!({}))));
        receiver
    }

    fn confirm_in_window(
        &self,
        window_id: WindowId,
        question: Confirmation,
    ) -> futures::channel::oneshot::Receiver<bool> {
        self.record(HostCall::Confirm {
            window: window_id,
            question,
        });
        let (answer, reply) = futures::channel::oneshot::channel();
        let _ = answer.send(self.recorded.lock().confirm_answer);
        reply
    }

    fn clear_browsing_data(
        &self,
        profile_id: ProfileId,
        request: ClearBrowsingData,
    ) -> futures::channel::oneshot::Receiver<bool> {
        self.record(HostCall::ClearBrowsingData {
            profile: profile_id.clone(),
            request,
        });
        if request.history {
            self.act(Action::ClearHistory {
                profile: profile_id,
                since: request.since,
                until: request.started_at,
            });
        }
        let (answer, reply) = futures::channel::oneshot::channel();
        let _ = answer.send(true);
        reply
    }

    fn show_menu(
        &self,
        items: Vec<NativeMenuItem>,
    ) -> Option<futures::channel::oneshot::Receiver<Option<String>>> {
        let pick = self.recorded.lock().menu_pick.clone()?;
        self.record(HostCall::ShowMenu(items));
        let (answer, reply) = futures::channel::oneshot::channel();
        let _ = answer.send(pick);
        Some(reply)
    }

    fn native_menus(&self) -> bool {
        self.recorded.lock().menu_pick.is_some()
    }

    fn prompt_in_window(
        &self,
        window: WindowId,
        prompt: crate::host::TextPrompt,
    ) -> Option<futures::channel::oneshot::Receiver<Option<String>>> {
        let _ = window;
        let answer = self.recorded.lock().prompt_answer.clone()?;
        self.record(HostCall::Prompt(prompt));
        let (tx, reply) = futures::channel::oneshot::channel();
        let _ = tx.send(answer);
        Some(reply)
    }

    fn arc_themes(&self) -> futures::channel::oneshot::Receiver<Vec<crate::host::ArcThemeChoice>> {
        let themes = self.recorded.lock().arc_themes.clone();
        let (answer, reply) = futures::channel::oneshot::channel();
        let _ = answer.send(themes);
        reply
    }

    fn open_path(&self, path: String) {
        self.record(HostCall::OpenPath(path));
    }

    fn move_to_trash(&self, path: String) -> futures::channel::oneshot::Receiver<bool> {
        self.record(HostCall::Trash(path));
        let (answer, reply) = futures::channel::oneshot::channel();
        let _ = answer.send(true);
        reply
    }

    fn opens_when_done(&self, download_id: &str) -> bool {
        self.recorded
            .lock()
            .open_when_done
            .iter()
            .any(|id| id == download_id)
    }

    fn toggle_open_when_done(&self, download_id: String) {
        self.record(HostCall::OpenWhenDone(download_id.clone()));
        let mut recorded = self.recorded.lock();
        if let Some(at) = recorded
            .open_when_done
            .iter()
            .position(|id| *id == download_id)
        {
            recorded.open_when_done.remove(at);
        } else {
            recorded.open_when_done.push(download_id);
        }
    }

    fn page_command(&self, tab_id: TabId, command: PageCommand) {
        self.record(HostCall::PageCommand {
            tab: tab_id,
            command,
        });
    }

    fn reader_status(&self, tab_id: &TabId) -> ReaderStatus {
        self.recorded
            .lock()
            .readers
            .get(tab_id)
            .copied()
            .unwrap_or_default()
    }

    fn toggle_reader(&self, tab_id: TabId) {
        self.record(HostCall::ToggleReader(tab_id));
    }

    fn toggle_page_engine(&self, tab_id: TabId) {
        self.record(HostCall::TogglePageEngine(tab_id));
    }

    fn reset_page_engine(&self, tab_id: TabId) {
        self.record(HostCall::ResetPageEngine(tab_id));
    }

    fn open_page_in(&self, tab_id: TabId, engine: ardia_state::model::PageEngine) {
        self.record(HostCall::OpenPageIn(tab_id, engine));
    }

    fn set_engine_mode(&self, mode: ardia_state::settings::EngineMode) {
        self.record(HostCall::SetEngineMode(mode));
    }

    fn engine_mode_switching(&self) -> bool {
        self.recorded.lock().engine_switching
    }

    fn webkit_passkeys_entitled(&self) -> bool {
        self.recorded.lock().passkeys_entitled
    }

    fn offers_engine_choice(&self) -> bool {
        self.recorded.lock().webkit
    }

    fn site_page(&self, tab_id: &TabId) -> Option<crate::site::SitePage> {
        self.recorded.lock().site_pages.get(tab_id).cloned()
    }

    fn site_panel(&self, tab_id: &TabId) -> crate::site::SitePanel {
        self.recorded
            .lock()
            .site_panels
            .get(tab_id)
            .cloned()
            .unwrap_or_default()
    }

    fn refresh_site_panel(&self, tab_id: TabId) {
        self.record(HostCall::RefreshSitePanel(tab_id));
    }

    fn site_answer(&self, tab_id: TabId, answer: crate::site::SiteAnswer) {
        self.record(HostCall::SiteAnswer(tab_id, answer));
    }

    fn page_selection(&self, tab_id: &TabId) -> Option<crate::site::model::PageSelection> {
        self.recorded.lock().selections.get(tab_id).cloned()
    }

    fn content_blocker(&self) -> Option<crate::site::model::ContentBlockerView> {
        self.recorded.lock().content_blocker.clone()
    }

    fn content_blocker_command(&self, command: crate::site::model::ContentBlockerCommand) {
        self.record(HostCall::ContentBlocker(command));
    }

    fn save_onboarding(&self, record: crate::host::OnboardingRecord) {
        self.record(HostCall::SaveOnboarding(record));
    }

    fn apply_onboarding_system(&self, choice: crate::host::OnboardingSystemChoice) {
        self.record(HostCall::OnboardingSystem(choice));
    }

    fn set_sharing(
        &self,
        on: bool,
        _source: ardia_telemetry::SharingSource,
        _placement: Option<ardia_telemetry::AskPlacement>,
    ) {
        self.record(HostCall::Sharing(on));
    }

    fn set_profile_synced(&self, profile: ProfileId, on: bool) {
        self.record(HostCall::ProfileSynced(profile, on));
    }

    fn set_profile_tabs_synced(&self, profile: ProfileId, on: bool) {
        self.record(HostCall::ProfileTabsSynced(profile, on));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn zoom_steps_walk_chrome_levels() {
        assert_eq!(zoom_after(1.0, 1), 1.1);
        assert_eq!(zoom_after(1.0, -1), 0.9);
        assert_eq!(zoom_after(5.0, 1), 5.0);
        assert_eq!(zoom_after(0.25, -1), 0.25);
        assert_eq!(zoom_after(1.3, 0), 1.0);
    }

    #[test]
    fn the_mock_host_records_engine_calls_and_updates_the_store() {
        let host = MockUiHost::fresh();
        let window = host
            .open_window(WindowKind::Main, Some("https://example.com"))
            .expect("a window");
        let tab = host
            .store()
            .read(|state| state.active_tab(window.as_str()).map(|t| t.id.clone()))
            .expect("a tab");
        host.zoom_step(tab.clone(), 1);
        host.set_muted(tab.clone(), true);
        host.find_in_page(tab.clone(), "ardia".into(), true);
        let state = host.store().snapshot();
        let shown = state.tab(tab.as_str()).expect("the tab");
        assert_eq!(shown.zoom, 1.1);
        assert!(shown.muted);
        assert_eq!(shown.live.find.count, Some(3));
        assert_eq!(host.calls().len(), 3);
        host.request_window_close(window.clone());
        assert!(host.store().snapshot().window(window.as_str()).is_none());
    }
}
