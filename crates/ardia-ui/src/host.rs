use std::sync::Arc;

use ardia_engine::{DownloadCommand, NativeViewHandle, PermissionResult};
use ardia_state::{Action, BrowserStore, ProfileId, TabId, WindowId};
use ardia_theme::IconTheme;
use gpui::{AnyWindowHandle, App, ExternalWindowHandle, Image};

use crate::pages::reader::ReaderStatus;

pub const SETTINGS_WINDOW_ID: &str = "settings";

use crate::host_data::{
    CastPanel, ExtensionList, ExtensionPopupView, HostSignal, ImportProgress, SyncStatus,
};

#[derive(Clone, Debug)]
pub struct HostTabView {
    pub tab_id: TabId,
    pub page_view: Option<NativeViewHandle>,
    pub devtools_view: Option<NativeViewHandle>,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct RetiringPage {
    pub view: NativeViewHandle,
    pub above: bool,
}

#[derive(Clone, Debug, Default)]
pub struct OpenWindowTarget {
    pub window_id: WindowId,
    pub host_window: Option<ExternalWindowHandle>,
    pub background: bool,
}

pub trait UiHost: Send + Sync + 'static {
    fn store(&self) -> &Arc<BrowserStore>;
    fn dispatch(&self, action: Action);
    fn navigate(&self, window_id: WindowId, tab_id: TabId, input: String);
    fn go_back(&self, tab_id: TabId);
    fn go_forward(&self, tab_id: TabId);
    fn reload(&self, tab_id: TabId, ignore_cache: bool);
    fn stop_loading(&self, tab_id: TabId);
    fn set_muted(&self, tab_id: TabId, muted: bool);
    fn set_zoom(&self, tab_id: TabId, factor: f64);
    fn zoom_step(&self, tab_id: TabId, direction: i32);
    fn find_in_page(&self, tab_id: TabId, query: String, forward: bool);
    fn stop_finding(&self, tab_id: TabId);
    fn toggle_devtools(&self, tab_id: TabId);
    fn enter_pip(&self, tab_id: TabId);
    fn show_cast(&self, tab_id: TabId);
    fn share_tab(&self, tab_id: TabId);
    fn tab_native_views(&self, tab_id: TabId) -> Option<HostTabView>;
    fn icon_theme_for(&self, tab_id: TabId) -> Option<IconTheme>;
    fn download_command(&self, download_id: String, command: DownloadCommand);
    fn reveal_path(&self, path: String);
    fn toast_command(&self, _command: &str) -> bool {
        false
    }
    fn resolve_permission(&self, request_id: String, result: PermissionResult, remember: bool);
    fn resolve_password_prompt(
        &self,
        tab_id: TabId,
        action: String,
        username: Option<String>,
        password: Option<String>,
    );
    fn resolve_autofill_prompt(&self, tab_id: TabId, prompt_id: i64, action: String);
    fn execute_extension_action(&self, tab_id: TabId, extension_id: String);
    fn open_little_ardia_in_main(&self, window_id: WindowId);
    fn open_utility_window(&self, kind: UtilityWindowKind);
    fn start_import(&self, source: String, profile_id: ProfileId);
    fn request_window_close(&self, window_id: WindowId);
    fn register_gpui_window(&self, window_id: WindowId, handle: AnyWindowHandle);
    fn unregister_gpui_window(&self, window_id: WindowId);

    fn replace_in_page(&self, _tab_id: TabId, _query: String, _replacement: String, _all: bool) {}

    fn replace_note(&self, _tab_id: &TabId) -> Option<ReplaceNote> {
        None
    }

    fn host_signal(&self) -> Option<&HostSignal> {
        None
    }

    fn extensions(&self, _window_id: &WindowId) -> ExtensionList {
        ExtensionList::default()
    }

    fn set_extension_pinned(&self, _window_id: WindowId, _extension_id: String, _pinned: bool) {}

    fn extension_popup(&self, _window_id: &WindowId) -> Option<ExtensionPopupView> {
        None
    }

    fn close_extension_popup(&self, _window_id: WindowId) {}

    fn remove_extension(&self, _window_id: WindowId, _extension_id: String) {}

    fn cast_panel(&self, _tab_id: &TabId) -> Option<CastPanel> {
        None
    }

    fn start_casting(&self, _tab_id: TabId, _device_id: String) {}

    fn stop_casting(&self, _tab_id: TabId, _device_id: String) {}

    fn set_cast_source(&self, _tab_id: TabId, _screen: bool) {}

    fn casting(&self, window_id: &WindowId) -> bool {
        !self.cast_routes(window_id).is_empty()
    }

    fn cast_routes(&self, _window_id: &WindowId) -> Vec<crate::host_data::CastRouteInfo> {
        Vec::new()
    }

    fn stop_cast_route(&self, _route_id: String) {}

    fn move_extension(&self, _window_id: WindowId, _extension_id: String, _to: usize) {}

    fn side_panel(&self, _window_id: &WindowId) -> Option<crate::host_data::SidePanelView> {
        None
    }

    fn toggle_side_panel(&self, _window_id: WindowId, _extension_id: String) {}

    fn close_side_panel(&self, _window_id: WindowId) {}

    fn side_panel_wanted(&self, window_id: &WindowId) -> bool {
        self.side_panel(window_id).is_some()
    }

    fn extension_install(
        &self,
        _window_id: &WindowId,
    ) -> Option<crate::host_data::ExtensionInstallView> {
        None
    }

    fn resolve_extension_install(&self, _request_id: String, _accepted: bool) {}

    fn pin_dialog_open(&self, _window_id: &WindowId) -> bool {
        false
    }

    fn set_pin_dialog(&self, _window_id: WindowId, _open: bool) {}

    fn install_crx(&self, _window_id: WindowId, _path: String) {}

    fn tab_capture(&self, _tab_id: &TabId) -> Option<crate::host_data::CaptureBadge> {
        None
    }

    fn media_session(&self, _tab_id: &TabId) -> Option<crate::media::session::Session> {
        None
    }

    fn media_action(&self, _tab_id: TabId, _action: crate::media::session::MediaAction) {}

    fn dismiss_player(&self, _tab_id: TabId) {}

    fn shows_mini_player(&self, _tab_id: &TabId) -> bool {
        false
    }

    fn sidebar_player_tab(&self, _window_id: &WindowId, _profile_id: &ProfileId) -> Option<TabId> {
        None
    }

    fn media_pip_open(&self, _tab_id: &TabId) -> bool {
        false
    }

    fn display_request(&self, _tab_id: &TabId) -> Option<crate::media::share::DisplayRequest> {
        None
    }

    fn answer_display_request(&self, _tab_id: TabId, _source: Option<String>, _audio: bool) {}

    fn share_tab_with(&self, _tab_id: TabId, _shared: TabId, _audio: bool) {}

    fn display_sources(&self) -> Vec<crate::media::share::DisplaySource> {
        Vec::new()
    }

    fn screen_recording_allowed(&self) -> bool {
        false
    }

    fn request_screen_recording(&self) {}

    fn display_thumbnails(
        &self,
        _ids: &[String],
        _width: f64,
    ) -> std::collections::HashMap<String, Arc<Image>> {
        std::collections::HashMap::new()
    }

    fn share_bar(&self, _tab_id: &TabId) -> Option<(TabId, crate::media::share::TabShare)> {
        None
    }

    fn stop_sharing(&self, _capturer: TabId) {}

    fn share_instead(&self, _capturer: TabId, _tab_id: TabId) {}

    fn dismiss_share_bar(&self, _capturer: TabId, _tab_id: TabId) {}

    fn toggle_media_pip(&self, tab_id: TabId) {
        self.enter_pip(tab_id);
    }

    fn import_progress(&self) -> Option<ImportProgress> {
        None
    }

    fn import_browsers(&self) -> Option<Vec<crate::host_data::ImportBrowser>> {
        Some(Vec::new())
    }

    fn refresh_import_browsers(&self) {}

    fn run_import(&self, _plan: crate::host_data::ImportPlan) {}

    fn cancel_import(&self) {}

    fn safari_access(&self) -> bool {
        false
    }

    fn unlock_import(
        &self,
        browser_id: String,
        browser_name: String,
    ) -> futures::channel::oneshot::Receiver<Result<(), String>> {
        let _ = (browser_id, browser_name);
        let (answer, reply) = futures::channel::oneshot::channel();
        let _ = answer.send(Ok(()));
        reply
    }

    fn browser_icon(&self, browser_id: &str, points: f32) -> Option<Arc<Image>> {
        let _ = (browser_id, points);
        None
    }

    fn app_icon_for_pid(&self, pid: i32, points: f32) -> Option<Arc<Image>> {
        let _ = (pid, points);
        None
    }

    fn tab_preview(&self, tab_id: &TabId) -> Option<Arc<Image>> {
        let _ = tab_id;
        None
    }

    fn open_full_disk_access_settings(&self) {}

    fn open_extension_store_pages(&self, _profile_id: ProfileId, _urls: Vec<String>) {}

    fn note_store_pages_opened(&self) {}

    fn note_theme_preset(&self, event: ThemePresetEvent) {
        let _ = event;
    }

    fn sync_status(&self) -> SyncStatus {
        SyncStatus::default()
    }

    fn refresh_sync_status(&self) {}

    fn set_sync_type(&self, _data_type: String, _on: bool) {}

    fn set_open_tabs_synced(&self, _on: bool) {}

    fn set_profile_synced(&self, _profile: ProfileId, _on: bool) {}

    fn set_profile_tabs_synced(&self, _profile: ProfileId, _on: bool) {}

    fn sync_action(&self, action: crate::sync_api::SyncAction) -> crate::sync_api::SyncReply {
        let _ = action;
        crate::sync_api::answered(crate::sync_api::SyncAnswer::Failed(
            "unavailable".to_owned(),
        ))
    }

    fn haptic_alignment(&self) {}
    fn favicon_image(&self, profile: &ProfileId, url: &str) -> Option<Arc<Image>> {
        let _ = (profile, url);
        None
    }

    fn pinned_backdrop(
        &self,
        icon: &crate::primitives::favicon::Favicon,
        look: PinnedBackdrop,
    ) -> Option<Arc<Image>> {
        let _ = (icon, look);
        None
    }

    fn favicon_inker(&self, url: &str) -> Option<crate::primitives::favicon::FaviconInker> {
        let _ = url;
        None
    }

    fn open_file(&self, window_id: WindowId) {
        let _ = window_id;
    }

    fn page_command(&self, tab_id: TabId, command: PageCommand) {
        let _ = (tab_id, command);
    }

    fn clear_site_data(&self, tab_id: TabId) {
        let _ = tab_id;
    }

    fn back_to_new_tab(&self, tab_id: &TabId) -> bool {
        let _ = tab_id;
        false
    }

    fn page_holds_pointer(&self, tab_id: &TabId) -> bool {
        let _ = tab_id;
        false
    }

    fn page_full_screen_takes_window(&self, tab_id: &TabId) -> bool {
        let _ = tab_id;
        true
    }

    fn exit_page_full_screen(&self, tab_id: TabId) {
        let _ = tab_id;
    }

    fn act_window_full_screen(&self, window_id: WindowId, on: bool) {
        let _ = (window_id, on);
    }

    fn move_window_to_display(&self, window_id: WindowId, display: String) {
        let _ = (window_id, display);
    }

    fn window_transitions(&self, window_id: &WindowId) -> u64 {
        let _ = window_id;
        0
    }

    fn cover_page(&self, tab_id: TabId) -> futures::channel::oneshot::Receiver<bool> {
        let _ = tab_id;
        let (tx, rx) = futures::channel::oneshot::channel();
        let _ = tx.send(false);
        rx
    }

    fn uncover_page(&self, tab_id: TabId, fade: bool) {
        let _ = (tab_id, fade);
    }

    fn page_draw_state(
        &self,
        tab_id: TabId,
    ) -> futures::channel::oneshot::Receiver<Option<PageDrawState>> {
        let _ = tab_id;
        let (tx, rx) = futures::channel::oneshot::channel();
        let _ = tx.send(None);
        rx
    }

    fn new_tab_shown(&self, tab_id: &TabId) -> bool {
        let _ = tab_id;
        false
    }

    fn scrolled_down(&self, tab_id: &TabId) -> bool {
        let _ = tab_id;
        false
    }

    fn reveal_toolbar(&self, tab_id: &TabId) {
        let _ = tab_id;
    }

    fn media_access(&self, tab_id: &TabId) -> crate::host_data::MediaCapture {
        let _ = tab_id;
        crate::host_data::MediaCapture::default()
    }

    fn run_bookmarklet(&self, tab_id: TabId, url: String) {
        let _ = (tab_id, url);
    }

    fn start_dictation(&self) {}

    fn power_up_frame(
        &self,
        request: &crate::ntp::power_up::PowerUpRequest,
    ) -> Option<crate::ntp::power_up::PowerUpFrame> {
        let _ = request;
        None
    }

    fn search_suggestions(
        &self,
        profile_id: ProfileId,
        url: String,
    ) -> futures::channel::oneshot::Receiver<Option<String>> {
        let _ = (profile_id, url);
        let (answer, reply) = futures::channel::oneshot::channel();
        let _ = answer.send(None);
        reply
    }

    fn ntp_extras(&self) -> ardia_state::ntp_extras::NtpExtras {
        ardia_state::ntp_extras::NtpExtras::default()
    }

    fn change_ntp_extras(&self, change: ardia_state::ntp_extras::NtpExtrasChange) {
        let _ = change;
    }

    fn export_bookmarks(&self, window_id: WindowId, profile_id: ProfileId) {
        let _ = (window_id, profile_id);
    }

    fn confirm_attached(
        &self,
        window: &mut gpui::Window,
        question: Confirmation,
    ) -> futures::channel::oneshot::Receiver<bool> {
        let _ = window;
        self.confirm_in_window(WindowId::new(SETTINGS_WINDOW_ID), question)
    }

    fn confirm_in_window(
        &self,
        window_id: WindowId,
        question: Confirmation,
    ) -> futures::channel::oneshot::Receiver<bool> {
        let _ = (window_id, question);
        let (answer, reply) = futures::channel::oneshot::channel();
        let _ = answer.send(false);
        reply
    }

    fn clear_browsing_data(
        &self,
        profile_id: ProfileId,
        request: ClearBrowsingData,
    ) -> futures::channel::oneshot::Receiver<bool> {
        let _ = (profile_id, request);
        let (answer, reply) = futures::channel::oneshot::channel();
        let _ = answer.send(false);
        reply
    }

    fn show_menu(
        &self,
        items: Vec<NativeMenuItem>,
    ) -> Option<futures::channel::oneshot::Receiver<Option<String>>> {
        let _ = items;
        None
    }

    fn native_menus(&self) -> bool {
        false
    }

    fn prompt_in_window(
        &self,
        window: WindowId,
        prompt: TextPrompt,
    ) -> Option<futures::channel::oneshot::Receiver<Option<String>>> {
        let _ = (window, prompt);
        None
    }

    fn arc_themes(&self) -> futures::channel::oneshot::Receiver<Vec<ArcThemeChoice>> {
        let (answer, reply) = futures::channel::oneshot::channel();
        let _ = answer.send(Vec::new());
        reply
    }

    fn page_favicon(&self, profile: &ProfileId, url: &str) -> Option<Arc<Image>> {
        let _ = (profile, url);
        None
    }

    fn page_favicon_inker(
        &self,
        profile: &ProfileId,
        url: &str,
    ) -> Option<crate::primitives::favicon::FaviconInker> {
        let _ = (profile, url);
        None
    }

    fn file_icon(&self, path: &str, points: f32) -> Option<Arc<Image>> {
        let _ = (path, points);
        None
    }

    fn open_path(&self, path: String) {
        let _ = path;
    }

    fn move_to_trash(&self, path: String) -> futures::channel::oneshot::Receiver<bool> {
        let _ = path;
        let (answer, reply) = futures::channel::oneshot::channel();
        let _ = answer.send(false);
        reply
    }

    fn opens_when_done(&self, download_id: &str) -> bool {
        let _ = download_id;
        false
    }

    fn toggle_open_when_done(&self, download_id: String) {
        let _ = download_id;
    }

    fn site_page(&self, tab_id: &TabId) -> Option<crate::site::SitePage> {
        let _ = tab_id;
        None
    }

    fn site_panel(&self, tab_id: &TabId) -> crate::site::SitePanel {
        let _ = tab_id;
        crate::site::SitePanel::default()
    }

    fn refresh_site_panel(&self, tab_id: TabId) {
        let _ = tab_id;
    }

    fn site_answer(&self, tab_id: TabId, answer: crate::site::SiteAnswer) {
        let _ = (tab_id, answer);
    }

    fn page_selection(&self, tab_id: &TabId) -> Option<crate::site::model::PageSelection> {
        let _ = tab_id;
        None
    }

    fn translate_view(&self, tab_id: &TabId) -> crate::site::model::TranslateView {
        let _ = tab_id;
        crate::site::model::TranslateView::default()
    }

    fn translate_languages(&self, tab_id: &TabId) -> Vec<crate::site::model::TranslateLanguage> {
        let _ = tab_id;
        Vec::new()
    }

    fn content_blocker(&self) -> Option<crate::site::model::ContentBlockerView> {
        None
    }

    fn content_blocker_command(&self, command: crate::site::model::ContentBlockerCommand) {
        let _ = command;
    }

    fn reader_status(&self, tab_id: &TabId) -> ReaderStatus {
        let _ = tab_id;
        ReaderStatus::default()
    }

    fn toggle_reader(&self, tab_id: TabId) {
        let _ = tab_id;
    }

    fn note_system_dark(&self, dark: bool) {
        let _ = dark;
    }

    fn plugins(&self) -> Option<Arc<dyn crate::plugins::PluginHost>> {
        None
    }

    fn live(&self) -> Option<Arc<ardia_state::live::LiveState>> {
        None
    }

    fn live_command(&self, command: ardia_state::live::LiveCommand) {
        let _ = command;
    }

    fn report(&self) -> Option<Arc<crate::report::state::ReportView>> {
        None
    }

    fn report_command(&self, command: crate::report::state::ReportCommand) {
        let _ = command;
    }

    fn report_record(&self, window: &mut gpui::Window, cx: &mut App) {
        let _ = (window, cx);
    }

    fn report_player(&self, path: Option<&str>) -> Option<ardia_engine::NativeViewHandle> {
        let _ = path;
        None
    }

    fn calendar(&self) -> Option<Arc<crate::live::CalendarView>> {
        None
    }

    fn calendar_command(&self, command: crate::live::CalendarCommand) {
        let _ = command;
    }

    fn live_status_text(&self, folder: &str) -> String {
        let _ = folder;
        String::new()
    }

    fn symbol_image(
        &self,
        request: crate::icon_picker::symbols::SymbolRequest<'_>,
    ) -> Option<Arc<Image>> {
        let _ = request;
        None
    }

    fn take_page_swipes(
        &self,
        _window_id: &WindowId,
    ) -> Vec<crate::window::swipe_overlay::PageSwipe> {
        Vec::new()
    }

    fn note_swipe_list(&self, _window_id: &WindowId, _open: bool) {}

    fn page_scroll(
        &self,
        _window_id: &WindowId,
        _tab_id: Option<&TabId>,
        _input: crate::window::swipe_tracker::ScrollInput,
    ) -> bool {
        false
    }

    fn swipe_haptic(&self, _haptic: crate::window::swipe_overlay::SwipeHaptic) {}

    fn frozen_picture(&self, _window_id: &WindowId) -> Option<Arc<Image>> {
        None
    }

    fn page_overlay(&self, tab_id: &TabId) -> crate::window::page_overlays::PageOverlay {
        let _ = tab_id;
        crate::window::page_overlays::PageOverlay::default()
    }

    fn new_tab_notice(
        &self,
        window_id: &WindowId,
    ) -> Option<crate::window::page_overlays::NewTabNotice> {
        let _ = window_id;
        None
    }

    fn navigation_steps(
        &self,
        tab_id: &TabId,
    ) -> Vec<crate::window::page_overlays::NavigationStep> {
        let _ = tab_id;
        Vec::new()
    }

    fn program_control(&self) -> crate::window::page_overlays::ProgramControl {
        crate::window::page_overlays::ProgramControl::default()
    }

    fn stop_program_control(&self) {}

    fn dismiss_control_pill(&self) {}

    fn focus_page(&self, tab_id: TabId) {
        let _ = tab_id;
    }

    fn go_to_offset(&self, tab_id: TabId, offset: i32) {
        let _ = (tab_id, offset);
    }

    fn recover_crashed_page(&self, tab_id: TabId) {
        self.reload(tab_id, false);
    }

    fn resolve_unresponsive(&self, tab_id: TabId, exit: bool) {
        let _ = (tab_id, exit);
    }

    fn open_meadow(&self, night: bool, creeper: bool) -> Option<ardia_engine::NativeViewHandle> {
        let _ = (night, creeper);
        None
    }

    fn meadow_events(&self) -> Vec<String> {
        Vec::new()
    }

    fn set_meadow_alpha(&self, alpha: f64) {
        let _ = alpha;
    }

    fn close_meadow(&self) {}

    fn app_active(&self) -> bool {
        true
    }

    fn watch_sidebar_edge(
        &self,
        window: &gpui::Window,
        window_id: WindowId,
        watch: Option<(
            crate::sidebar::edge_peek::SidebarEdgeWatch,
            crate::sidebar::edge_peek::SidebarEdgeSink,
        )>,
    ) {
        let _ = (window, window_id, watch);
    }

    fn cover_screen(&self, window: &gpui::Window) {
        let _ = window;
    }

    fn play_intro_music(&self, muted: bool) {
        let _ = muted;
    }

    fn set_intro_music_muted(&self, muted: bool) {
        let _ = muted;
    }

    fn stop_intro_music(&self, fade: f64) {
        let _ = fade;
    }

    fn intro_music_muted(&self) -> bool {
        false
    }

    fn save_intro_music_muted(&self, muted: bool) {
        let _ = muted;
    }

    fn official_plugins(&self) -> Option<Vec<OfficialPlugin>> {
        None
    }

    fn updater(&self) -> Option<UpdaterState> {
        None
    }

    fn set_automatic_updates(&self, on: bool) {
        let _ = on;
    }

    fn set_update_channel(&self, channel: UpdateChannel) {
        let _ = channel;
    }

    fn check_for_updates(&self) {}

    fn plugin_detail(&self, name: &str) -> Option<PluginDetail> {
        let _ = name;
        None
    }

    fn plugin_command(&self, name: &str, command: PluginCommand) {
        let _ = (name, command);
    }

    fn install_official_plugin(
        &self,
        name: String,
    ) -> Option<futures::channel::oneshot::Receiver<Result<(), String>>> {
        let _ = name;
        None
    }

    fn cancel_official_install(&self, name: String) {
        let _ = name;
    }

    fn official_install_progress(&self, name: String) -> Option<OfficialInstallPhase> {
        let _ = name;
        None
    }

    fn linked_programs(&self, plugin: String) -> Vec<LinkedProgram> {
        let _ = plugin;
        Vec::new()
    }

    fn install_id(&self) -> String {
        "00000000-0000-4000-8000-000000000000".to_owned()
    }

    fn icon_theme_of(&self, bytes: &[u8]) -> ardia_theme::IconTheme {
        let _ = bytes;
        ardia_theme::IconTheme::Default
    }

    fn onboarding_record(&self) -> Option<OnboardingRecord> {
        None
    }

    fn save_onboarding(&self, record: OnboardingRecord) {
        let _ = record;
    }

    fn onboarding_system(&self) -> OnboardingSystem {
        OnboardingSystem::default()
    }

    fn apply_onboarding_system(&self, choice: OnboardingSystemChoice) {
        let _ = choice;
    }

    fn sharing(&self) -> bool {
        false
    }

    fn set_sharing(
        &self,
        on: bool,
        source: ardia_telemetry::SharingSource,
        placement: Option<ardia_telemetry::AskPlacement>,
    ) {
        let _ = (on, source, placement);
    }

    fn default_browser(&self) -> Option<bool> {
        None
    }

    fn make_default_browser(&self) {}

    fn open_at_login(&self) -> Option<LoginItemState> {
        None
    }

    fn set_open_at_login(&self, on: bool) {
        let _ = on;
    }

    fn app_icons(&self) -> Vec<AppIconChoice> {
        Vec::new()
    }

    fn app_icon_count(&self) -> usize {
        self.app_icons().len()
    }

    fn current_app_icon(&self) -> Option<String> {
        None
    }

    fn set_app_icon(&self, id: String) {
        let _ = id;
    }

    fn about(&self) -> Option<AboutInfo> {
        None
    }

    fn open_page_in(&self, tab_id: TabId, engine: ardia_state::model::PageEngine) {
        let _ = (tab_id, engine);
    }

    fn toggle_page_engine(&self, tab_id: TabId) {
        let _ = tab_id;
    }

    fn reset_page_engine(&self, tab_id: TabId) {
        let _ = tab_id;
    }

    fn retiring_page(&self, tab_id: TabId) -> Option<RetiringPage> {
        let _ = tab_id;
        None
    }

    fn set_engine_mode(&self, mode: ardia_state::settings::EngineMode) {
        let _ = mode;
    }

    fn engine_mode_switching(&self) -> bool {
        false
    }

    fn webkit_passkeys_entitled(&self) -> bool {
        false
    }

    fn webkit_passkey_access(&self) -> crate::settings::engines::PasskeyAccess {
        if self.webkit_passkeys_entitled() {
            crate::settings::engines::PasskeyAccess::AUTHORIZED
        } else {
            crate::settings::engines::PasskeyAccess::default()
        }
    }

    fn request_webkit_passkey_access(&self) {}

    fn webkit_passkey_requesting(&self) -> bool {
        false
    }

    fn offers_engine_choice(&self) -> bool {
        false
    }

    fn settings_value(
        &self,
        query: &crate::settings::data::SettingsQuery,
    ) -> Option<serde_json::Value> {
        let _ = query;
        None
    }

    fn settings_revision(&self, query: &crate::settings::data::SettingsQuery) -> Option<u64> {
        let _ = query;
        None
    }

    fn settings_call(
        &self,
        call: crate::settings::data::SettingsCall,
    ) -> crate::settings::data::CallReply {
        let _ = call;
        let (answer, reply) = futures::channel::oneshot::channel();
        let _ = answer.send(Err("unavailable".to_owned()));
        reply
    }

    fn profile_flags(&self, profile: &ProfileId) -> Option<ProfileFlags> {
        let _ = profile;
        None
    }

    fn set_profile_flag(&self, profile: ProfileId, flag: ProfileFlagKind, on: bool) {
        let _ = (profile, flag, on);
    }

    fn plugin_rows(&self) -> Vec<PluginRow> {
        Vec::new()
    }

    fn plugin_folder(&self) -> Option<String> {
        None
    }

    fn turn_plugin_off(&self, name: String) {
        let _ = name;
    }

    fn download_settings(&self, profile: &ProfileId) -> Option<DownloadSettings> {
        let _ = profile;
        None
    }

    fn set_download_settings(
        &self,
        profiles: Vec<ProfileId>,
        folder: Option<String>,
        ask_where_to_save: Option<bool>,
    ) {
        let _ = (profiles, folder, ask_where_to_save);
    }

    fn app_links(&self, profile: &ProfileId) -> Option<Vec<crate::settings::automations::AppLink>> {
        let _ = profile;
        None
    }

    fn remove_app_link(&self, profile: ProfileId, origin: String, scheme: String) {
        let _ = (profile, origin, scheme);
    }

    fn recent_source_apps(&self) -> Vec<ardia_state::air_traffic::SourceApp> {
        Vec::new()
    }

    fn live_connect(
        &self,
        request: crate::settings::automations::LiveConnect,
    ) -> futures::channel::mpsc::UnboundedReceiver<crate::settings::automations::ConnectProgress>
    {
        let _ = request;
        let (sender, receiver) = futures::channel::mpsc::unbounded();
        let _ = sender.unbounded_send(crate::settings::automations::ConnectProgress::Done(Err(
            "Couldn't connect".into(),
        )));
        receiver
    }

    fn cancel_live_connect(&self) {}

    fn automation_rules(&self) -> crate::settings::automations::AutomationRulesView {
        crate::settings::automations::AutomationRulesView::default()
    }

    fn approve_automation_rule(&self, key: String) {
        let _ = key;
    }

    fn revoke_automation_rule(&self, key: String) {
        let _ = key;
    }

    fn automation_approved(&self, key: &str) -> bool {
        let _ = key;
        false
    }
}

#[derive(Clone, Debug)]
pub struct AppIconChoice {
    pub id: String,
    pub name: String,
    pub flat: bool,
    pub preview: Option<Arc<Image>>,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct AboutInfo {
    pub app_version: String,
    pub chromium_version: Option<String>,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct ProfileFlags {
    pub passwords_offered: bool,
    pub addresses_autofilled: bool,
    pub cards_autofilled: bool,
    pub preload_pages: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ProfileFlagKind {
    PasswordsOffered,
    AddressesAutofilled,
    CardsAutofilled,
    PreloadPages,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct PluginRow {
    pub name: String,
    pub active: bool,
    pub problems: Vec<String>,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct DownloadSettings {
    pub folder: String,
    pub ask_where_to_save: bool,
    pub managed: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct LoginItemState {
    pub on: bool,
    pub needs_approval: bool,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct OnboardingRecord {
    pub completed: bool,
    pub step: Option<String>,
    pub source: Option<String>,
    pub preset: Option<String>,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct OnboardingSystem {
    pub is_default: bool,
    pub in_dock: bool,
    pub dock_available: bool,
    pub login_enabled: bool,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct OnboardingSystemChoice {
    pub set_default: bool,
    pub trial: bool,
    pub login: bool,
    pub dock: bool,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Confirmation {
    pub title: String,
    pub message: String,
    pub confirm: String,
    pub destructive: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ThemePresetEvent {
    Edited,
    Reset,
}

#[derive(Clone, Debug, PartialEq)]
pub struct ArcThemeChoice {
    pub id: String,
    pub title: String,
    pub swatch: u32,
    pub theme: ardia_theme::ProfileTheme,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct TextPrompt {
    pub title: String,
    pub message: String,
    pub value: String,
    pub placeholder: String,
    pub confirm: String,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct NativeMenuItem {
    pub id: String,
    pub title: String,
    pub symbol: Option<String>,
    pub swatch: Option<u32>,
    pub enabled: bool,
    pub checked: bool,
    pub alternate: bool,
    pub separator: bool,
    pub key: String,
    pub modifiers: Vec<String>,
    pub children: Vec<NativeMenuItem>,
}

impl NativeMenuItem {
    pub fn new(id: &str, title: impl Into<String>, symbol: &str) -> Self {
        NativeMenuItem {
            id: id.to_owned(),
            title: title.into(),
            symbol: (!symbol.is_empty()).then(|| symbol.to_owned()),
            enabled: true,
            ..NativeMenuItem::default()
        }
    }

    pub fn separator() -> Self {
        NativeMenuItem {
            separator: true,
            ..NativeMenuItem::default()
        }
    }

    pub fn enabled(mut self, enabled: bool) -> Self {
        self.enabled = enabled;
        self
    }

    pub fn checked(mut self, checked: bool) -> Self {
        self.checked = checked;
        self
    }

    pub fn alternate(mut self) -> Self {
        self.alternate = true;
        self
    }

    pub fn swatch(mut self, rgb: u32) -> Self {
        self.swatch = Some(rgb);
        self
    }

    pub fn children(mut self, children: Vec<NativeMenuItem>) -> Self {
        self.children = children;
        self
    }

    pub fn key_equivalent(mut self, key: impl Into<String>, modifiers: &[&str]) -> Self {
        self.key = key.into();
        self.modifiers = modifiers.iter().map(|m| (*m).to_owned()).collect();
        self
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ClearBrowsingData {
    pub history: bool,
    pub site_data: bool,
    pub since: Option<i64>,
    pub started_at: i64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum OfficialPluginState {
    Available,
    Installed,
    ComingSoon,
    Unsupported,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LinkedProgram {
    pub program: String,
    pub version: Option<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum OfficialInstallPhase {
    Downloading { received: u64, total: u64 },
    Asking,
    Installing,
}

impl OfficialInstallPhase {
    pub fn status(&self) -> Option<String> {
        match self {
            OfficialInstallPhase::Downloading { received, total } if *total > 0 => Some(format!(
                "Downloading\u{2026} {}%",
                (received.saturating_mul(100) / total).min(100)
            )),
            OfficialInstallPhase::Downloading { .. } => Some("Downloading\u{2026}".to_owned()),
            OfficialInstallPhase::Asking => None,
            OfficialInstallPhase::Installing => Some("Installing\u{2026}".to_owned()),
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct OfficialPlugin {
    pub name: String,
    pub title: String,
    pub blurb: String,
    pub icon: String,
    pub state: OfficialPluginState,
    pub version: Option<String>,
    pub update: Option<String>,
    pub example: Option<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum PageCommand {
    Print,
    PrintWithSystemDialog,
    SavePage,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct PageDrawState {
    pub width: f64,
    pub height: f64,
    pub full_screen: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum UtilityWindowKind {
    Settings,
    Import,
    Onboarding,
    Intro,
}

pub fn bind_global_keybindings(cx: &mut App) {
    crate::keybindings::bind_defaults(cx);
}

pub const REPLACE_NOTE_MS: i64 = 2200;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ReplaceNote {
    pub text: String,
    pub error: bool,
    pub at_ms: i64,
}

impl ReplaceNote {
    pub fn of(field: bool, count: u32, all: bool, at_ms: i64) -> Option<ReplaceNote> {
        if !field {
            return Some(ReplaceNote {
                text: "Not in a text field".to_owned(),
                error: true,
                at_ms,
            });
        }
        if !all && count > 0 {
            return None;
        }
        Some(ReplaceNote {
            text: if count > 0 {
                format!("{count} replaced")
            } else {
                "No matches".to_owned()
            },
            error: count == 0,
            at_ms,
        })
    }

    pub fn shown_at(&self, now_ms: i64) -> bool {
        now_ms >= self.at_ms && now_ms - self.at_ms < REPLACE_NOTE_MS
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct PinnedBackdrop {
    pub width: f32,
    pub height: f32,
    pub radius: f32,
    pub stroke: f32,
    pub dark: bool,
    pub glass: bool,
    pub scale: f32,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum UpdateChannel {
    Stable,
    Nightly,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SwitchPhase {
    Waiting,
    Checking,
    Found,
    UpToDate,
    NewerThanLatest,
    Failed,
    Downloading,
    Installing,
    Ready,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct UpdaterReport {
    pub phase: SwitchPhase,
    pub channel: UpdateChannel,
    pub version: Option<String>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct UpdaterState {
    pub configured: bool,
    pub automatic_checks: bool,
    pub automatic_downloads: bool,
    pub can_check: bool,
    pub session_in_progress: bool,
    pub last_check_ms: Option<f64>,
    pub version: String,
    pub display_version: String,
    pub channel: UpdateChannel,
    pub switch_check: Option<UpdaterReport>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PluginLine {
    pub icon: String,
    pub text: String,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct PluginDetail {
    pub name: String,
    pub title: String,
    pub version: Option<String>,
    pub description: String,
    pub icon: Option<String>,
    pub loads: bool,
    pub official: bool,
    pub ignores_user_folder: bool,
    pub active: bool,
    pub enabled: bool,
    pub needs_review: bool,
    pub status: Option<String>,
    pub program: Option<(String, String)>,
    pub programs: Vec<String>,
    pub full_control: bool,
    pub consent: Vec<PluginLine>,
    pub problems: Vec<String>,
    pub password_manager: bool,
    pub plugins_folder: String,
    pub unsaved: bool,
    pub auto_update: Option<(String, String)>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PluginCommand {
    Restart,
    ShowLog,
    Remove,
}
