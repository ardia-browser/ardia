pub mod panes;
pub mod rows;
pub mod mini_window;
pub mod keyword_phrases;
pub mod theme_section;
pub mod data;
pub mod subpages;
pub mod general_subpages;
pub mod automations;
pub mod profiles;
pub mod engines;
pub mod updates;
pub mod extras;
pub mod plugin_values;
pub mod sync_sheets;
pub(crate) mod memo;

const RESULTS_LIST: &str = "settings:results";

use std::sync::Arc;

use crate::scale::px;
use ardia_state::shortcuts::{Key, Modifiers, Shortcut};
use ardia_state::{Action, BrowserState, Interest, Topics};
use ardia_theme::layout::lights;
use gpui::{
    AnyElement, App, Context, Entity, FocusHandle, Focusable, IntoElement, Keystroke, MouseButton,
    ParentElement, Render, SharedString, Styled, Subscription, Window, div, prelude::*,
};

use crate::host::UiHost;
use crate::host_data::{HostLink, HostTopics, SyncStatus};
use crate::keybindings::{self, Dismiss, RunCommand, RunReservedCommand};
use crate::look::{Look, UI_FONT};
use crate::msg::{Emit, Msg};
use crate::primitives::controls::{IconButton, field_box};
use crate::primitives::icons::{Icon, icon};
use crate::primitives::text_input::{InputEvent, InputStyle, TextInput};
use crate::primitives::theme_bridge::hsla;
use crate::settings::rows::Pane;
use crate::store_link::StoreLink;
use crate::window::backdrop::BackdropDriver;

pub const TITLEBAR: f32 = 52.0;
pub const NAV_WIDTH: f32 = 214.0;
pub const PANE_ROW_HEIGHT: f32 = 30.0;
pub const PANE_TILE: f32 = 20.0;
pub const PANE_SYMBOL: f32 = 11.0;
pub const FLASH_IN_MS: f32 = 100.0;
pub const FLASH_HOLD_MS: f32 = 900.0;
pub const FLASH_OUT_MS: f32 = 400.0;
pub const FLASH_MS: u64 = (FLASH_IN_MS + FLASH_HOLD_MS + FLASH_OUT_MS) as u64;

pub fn flash_envelope(elapsed_ms: f32) -> f32 {
    use crate::primitives::tokens::Curve;
    if elapsed_ms < FLASH_IN_MS {
        Curve::Enter.ease(elapsed_ms / FLASH_IN_MS)
    } else if elapsed_ms < FLASH_IN_MS + FLASH_HOLD_MS {
        1.0
    } else {
        1.0 - Curve::Move.ease((elapsed_ms - FLASH_IN_MS - FLASH_HOLD_MS) / FLASH_OUT_MS)
    }
}
pub const PREVIEW_DELAY_MS: u64 = 140;
const PROFILE_COMMAND: &str = "settings:profile:";
pub const SETTINGS_PEOPLE_WINDOW: &str = "settings";
const KEYS_COMMAND: &str = "settings:revealKeys:";

fn bold() -> gpui::HighlightStyle {
    gpui::HighlightStyle {
        font_weight: Some(gpui::FontWeight::BOLD),
        ..gpui::HighlightStyle::default()
    }
}
const REVEAL_COMMAND: &str = "settings:reveal:";
const FILTER_COMMAND: &str = "settings:shortcutFilter:";
pub const SETTINGS_SIZE: [f32; 2] = [820.0, 640.0];

pub fn shortcut_of(keystroke: &Keystroke) -> Option<Shortcut> {
    let name = keystroke.key.as_str();
    let key = match name {
        "up" => Key::Up,
        "down" => Key::Down,
        "left" => Key::Left,
        "right" => Key::Right,
        "pageup" => Key::PageUp,
        "pagedown" => Key::PageDown,
        "home" => Key::Home,
        "end" => Key::End,
        "delete" => Key::ForwardDelete,
        "backspace" => Key::Backspace,
        "tab" => Key::Tab,
        "enter" => Key::Enter,
        "space" => Key::Space,
        "escape" => return None,
        other => {
            if let Some(number) = other.strip_prefix('f').and_then(|n| n.parse::<u8>().ok()) {
                Key::Function(number)
            } else {
                let mut chars = other.chars();
                let c = chars.next()?;
                if chars.next().is_some() {
                    return None;
                }
                Key::Char(c.to_lowercase().next().unwrap_or(c))
            }
        }
    };
    let m = keystroke.modifiers;
    let function_key = matches!(key, Key::Function(_));
    if !(m.platform || m.control || m.alt || function_key) {
        return None;
    }
    Some(Shortcut::new(
        key,
        Modifiers {
            control: m.control,
            option: m.alt,
            shift: m.shift,
            command: m.platform,
            function: m.function && !function_key,
        },
    ))
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct RequestedPane(pub Pane);

impl gpui::Global for RequestedPane {}

pub fn request_pane(pane: Pane, cx: &mut App) {
    cx.set_global(RequestedPane(pane));
}

fn take_requested(cx: &mut App) -> Option<Pane> {
    let pane = cx
        .try_global::<RequestedPane>()
        .map(|requested| requested.0)?;
    cx.remove_global::<RequestedPane>();
    Some(pane)
}

pub struct SettingsWindowView {
    pub(crate) host: Arc<dyn UiHost>,
    pub(crate) state: Arc<BrowserState>,
    pub(crate) look: Look,
    pub(crate) emit: Emit,
    pub(crate) focus: FocusHandle,
    pub(crate) search: Entity<TextInput>,
    pub(crate) query: String,
    pub(crate) pane: Pane,
    pub(crate) recording: Option<SharedString>,
    pub(crate) sync_status: SyncStatus,
    pub(crate) sync: sync_sheets::SyncUi,
    pub(crate) scale_menu: bool,
    pub(crate) system: rows::System,
    pub(crate) login: Option<crate::host::LoginItemState>,
    pub(crate) menu: Option<SharedString>,
    pub(crate) profile: Option<ardia_state::ProfileId>,
    pub(crate) selected_result: usize,
    pub(crate) shortcut_search: Entity<TextInput>,
    pub(crate) hovered_shortcut: Option<&'static str>,
    pub(crate) key_searching: bool,
    pub(crate) theme_stop: usize,
    previewing: bool,
    preview_task: Option<gpui::Task<()>>,
    pub(crate) rename_input: Entity<TextInput>,
    pub(crate) rename_sheet: Option<ardia_state::ProfileId>,
    pub(crate) people: Entity<crate::profiles::layer::PeopleLayer>,
    pub(crate) new_tab_url: Entity<TextInput>,
    pub(crate) new_tab_typed: String,
    new_tab_saved: Option<String>,
    pub(crate) swatch_hover: Option<ardia_theme::ProfileColor>,
    pub(crate) profile_name: Entity<TextInput>,
    pub(crate) sheet_amount: Entity<TextInput>,
    pub(crate) site_input: Entity<TextInput>,
    pub(crate) site_typed: String,
    pub(crate) site_sheet: Option<Option<&'static str>>,
    pub(crate) clean_up_sheet: Option<(&'static str, bool)>,
    pub(crate) automations: automations::Automations,
    pub(crate) extras: extras::Extras,
    profile_name_for: Option<ardia_state::ProfileId>,
    pub(crate) shortcut_query: String,
    pub(crate) shortcut_filter: panes::ShortcutFilter,
    history: PaneHistory,
    pub(crate) sub: subpages::SubState,
    flash: Option<&'static str>,
    flash_at: Option<std::time::Instant>,
    flash_task: Option<gpui::Task<()>>,
    pub(crate) scroll: gpui::ScrollHandle,
    backdrop: BackdropDriver,
    interceptor: Option<Subscription>,
    _store: StoreLink,
    _host: HostLink,
    _subscriptions: Vec<Subscription>,
}

impl Focusable for SettingsWindowView {
    fn focus_handle(&self, _: &App) -> FocusHandle {
        self.focus.clone()
    }
}

impl SettingsWindowView {
    pub fn new(host: Arc<dyn UiHost>, window: &mut Window, cx: &mut Context<Self>) -> Self {
        let state = host.store().snapshot();
        crate::scale::sync(&state, cx);
        crate::look::note_window_glass(window);
        let look = Look::new(&state, "", window.appearance());
        let search = cx.new(|cx| TextInput::new("Search", cx));
        let shortcut_search = cx.new(|cx| TextInput::new("Search menu commands", cx));
        let profile_name = cx.new(|cx| TextInput::new("", cx));
        let sheet_amount = cx.new(|cx| TextInput::new("", cx));
        let new_tab_url = cx.new(|cx| TextInput::new("New Tab page", cx));
        let rename_input = cx.new(|cx| TextInput::new("Profile name", cx));
        let site_input = cx.new(|cx| TextInput::new("youtube.com", cx));
        let style = InputStyle {
            text: look.p.text,
            placeholder: look.p.placeholder,
            caret: hsla(look.theme.caret_color(ardia_theme::FieldSurface::Field)),
            selection: look.p.selection,
            font_size: 13.0,
            weight: gpui::FontWeight::NORMAL,
        };
        search.update(cx, |input, cx| input.set_style(style, cx));
        shortcut_search.update(cx, |input, cx| input.set_style(style, cx));
        profile_name.update(cx, |input, cx| input.set_style(style, cx));
        sheet_amount.update(cx, |input, cx| input.set_style(style, cx));
        new_tab_url.update(cx, |input, cx| input.set_style(style, cx));
        rename_input.update(cx, |input, cx| input.set_style(style, cx));
        site_input.update(cx, |input, cx| input.set_style(style, cx));
        let automations = automations::Automations::new(style, window, cx);
        let extras = extras::Extras::new(style, window, cx);
        let people = cx.new(|_| {
            crate::profiles::layer::PeopleLayer::new(
                Arc::clone(&host),
                ardia_state::WindowId::new(SETTINGS_PEOPLE_WINDOW),
            )
        });
        let subscriptions = vec![
            cx.subscribe_in(&search, window, Self::on_search),
            cx.subscribe_in(&shortcut_search, window, Self::on_shortcut_search),
            cx.subscribe_in(&profile_name, window, Self::on_profile_name),
            cx.subscribe_in(&sheet_amount, window, Self::on_sheet_amount),
            cx.subscribe_in(&new_tab_url, window, Self::on_new_tab_url),
            cx.subscribe_in(&rename_input, window, Self::on_rename_input),
            cx.subscribe_in(&site_input, window, Self::on_site_input),
            cx.observe_window_appearance(window, |this, window, cx| {
                this.sync(Topics::ALL, window, cx)
            }),
            cx.observe_window_activation(window, |this, window, cx| {
                if !window.is_window_active() {
                    this.stop_recording(cx);
                } else {
                    this.refresh_system();
                }
                this.sync(Topics::ALL, window, cx)
            }),
            cx.observe_global::<RequestedPane>(|this, cx| {
                if let Some(pane) = take_requested(cx) {
                    this.go_to(pane, cx);
                }
            }),
        ];
        let requested = take_requested(cx);
        let store = StoreLink::new(
            host.store(),
            Interest::Topics(
                Topics::SETTINGS | Topics::PROFILES | Topics::WINDOWS | Topics::AIR_TRAFFIC,
            ),
            window,
            cx,
            Self::sync,
        );
        let host_link = HostLink::new(
            host.host_signal(),
            HostTopics::SYNC | HostTopics::PLUGINS | HostTopics::PEOPLE,
            window,
            cx,
            Self::on_host_data,
        );
        host.refresh_sync_status();
        let sync_status = host.sync_status();
        let mut view = SettingsWindowView {
            emit: Emit::new(cx.weak_entity(), Self::handle),
            host,
            state,
            look,
            focus: cx.focus_handle(),
            search,
            query: String::new(),
            pane: requested.unwrap_or(Pane::General),
            recording: None,
            sync_status,
            sync: sync_sheets::SyncUi::default(),
            scale_menu: false,
            system: rows::System::default(),
            login: None,
            menu: None,
            profile: None,
            selected_result: 0,
            shortcut_search,
            hovered_shortcut: None,
            key_searching: false,
            theme_stop: 0,
            previewing: false,
            preview_task: None,
            rename_input,
            rename_sheet: None,
            people,
            new_tab_url,
            new_tab_typed: String::new(),
            new_tab_saved: None,
            swatch_hover: None,
            profile_name,
            sheet_amount,
            site_input,
            site_typed: String::new(),
            site_sheet: None,
            clean_up_sheet: None,
            automations,
            extras,
            profile_name_for: None,
            shortcut_query: String::new(),
            shortcut_filter: panes::ShortcutFilter::All,
            history: PaneHistory::default(),
            sub: subpages::SubState::default(),
            flash: None,
            flash_at: None,
            flash_task: None,
            scroll: gpui::ScrollHandle::new(),
            backdrop: BackdropDriver::default(),
            interceptor: None,
            _store: store,
            _host: host_link,
            _subscriptions: subscriptions,
        };
        view.backdrop.aim(
            sidebar_material(view.look.backdrop(crate::window::looks_active(window))),
            false,
            std::time::Instant::now(),
        );
        view.backdrop.apply(window, std::time::Instant::now());
        view.backdrop.place_lights(
            crate::primitives::theme_bridge::traffic_light_origin(lights::SETTINGS_CENTER),
            window,
        );
        view.refresh_system();
        sync_sheets::start(&mut view, cx);
        window.focus(&view.focus, cx);
        view
    }

    pub fn pane(&self) -> Pane {
        self.pane
    }

    pub fn state(&self) -> &Arc<BrowserState> {
        &self.state
    }

    pub fn recording(&self) -> Option<&SharedString> {
        self.recording.as_ref()
    }

    pub fn select(&mut self, pane: Pane, cx: &mut Context<Self>) {
        self.go_to(pane, cx);
    }

    pub fn go_to(&mut self, pane: Pane, cx: &mut Context<Self>) {
        if pane == Pane::General && self.pane != Pane::General {
            self.host.refresh_sync_status();
        }
        if pane != self.pane || self.sub.detail.is_some() {
            if self.new_tab_saved.as_deref() != Some(self.new_tab_typed.as_str()) {
                self.save_new_tab_url();
            }
            self.history.visit((self.pane, self.sub.detail.take()));
            self.sub.sheet = None;
            self.menu = None;
            self.scroll.set_offset(gpui::point(px(0.), px(0.)));
        }
        self.pane = pane;
        cx.notify();
    }

    fn step_history(&mut self, back: bool, cx: &mut Context<Self>) {
        let current = (self.pane, self.sub.detail.clone());
        let target = if back {
            self.history.back(current)
        } else {
            self.history.forward(current)
        };
        if let Some((pane, detail)) = target {
            if pane == Pane::General {
                self.host.refresh_sync_status();
            }
            self.pane = pane;
            self.sub.detail = detail;
            self.sub.sheet = None;
            self.menu = None;
            self.scroll.set_offset(gpui::point(px(0.), px(0.)));
            cx.notify();
        }
    }

    pub(crate) fn visit_detail(
        &mut self,
        detail: Option<subpages::Detail>,
        cx: &mut Context<Self>,
    ) {
        if detail == self.sub.detail {
            return;
        }
        self.history.visit((self.pane, self.sub.detail.take()));
        self.sub.detail = detail;
        self.menu = None;
        self.scroll.set_offset(gpui::point(px(0.), px(0.)));
        cx.notify();
    }

    pub(crate) fn leave_detail(&mut self, cx: &mut Context<Self>) {
        if self.sub.detail.take().is_some() {
            self.history.back.retain(|(_, detail)| detail.is_none());
            self.history.forward.clear();
            self.scroll.set_offset(gpui::point(px(0.), px(0.)));
            cx.notify();
        }
    }

    pub fn detail(&self) -> Option<&subpages::Detail> {
        self.sub.detail.as_ref()
    }

    pub fn can_go_back(&self) -> bool {
        !self.history.back.is_empty()
    }

    pub fn can_go_forward(&self) -> bool {
        !self.history.forward.is_empty()
    }

    pub(crate) fn flashing(&self, id: &str) -> bool {
        self.flash == Some(id)
    }

    pub(crate) fn flash_glow(&self, id: &str) -> f32 {
        match self.flash_at {
            Some(at) if self.flash == Some(id) => {
                flash_envelope(at.elapsed().as_secs_f32() * 1000.0)
            }
            _ => 0.0,
        }
    }

    pub fn flashed(&self) -> Option<&'static str> {
        self.flash
    }

    fn schedule_preview(&mut self, cx: &mut Context<Self>) {
        self.preview_task = Some(cx.spawn(async move |this, cx| {
            cx.background_executor()
                .timer(std::time::Duration::from_millis(PREVIEW_DELAY_MS))
                .await;
            let _ = this.update(cx, |view, cx| view.preview_selected(cx));
        }));
    }

    pub fn preview_selected(&mut self, cx: &mut Context<Self>) {
        if self.query.trim().is_empty() || !panes::key_hits(self).is_empty() {
            return;
        }
        let Some(row) = panes::result_rows(self).get(self.selected_result).copied() else {
            return;
        };
        if self.previewing && row.pane != self.pane {
            self.pane = row.pane;
            self.menu = None;
            self.history.forward.clear();
        }
        self.previewing = true;
        self.reveal(row.id, cx);
    }

    pub fn reveal(&mut self, id: &str, cx: &mut Context<Self>) {
        let Some(row) = rows::find(id) else {
            return;
        };
        self.go_to(row.pane, cx);
        self.flash = Some(row.id);
        self.flash_at = Some(std::time::Instant::now());
        if let Some(index) =
            panes::block_index(&self.state.settings, &self.system, row.pane, row.id)
        {
            self.scroll.scroll_to_item(index);
        } else {
            ardia_telemetry::counts::count("settings_reveal_misses");
        }
        self.flash_task = Some(cx.spawn(async move |this, cx| {
            cx.background_executor()
                .timer(std::time::Duration::from_millis(FLASH_MS))
                .await;
            let _ = this.update(cx, |view, cx| {
                view.flash = None;
                view.flash_at = None;
                cx.notify();
            });
        }));
        cx.notify();
    }

    pub fn sync_status(&self) -> &SyncStatus {
        &self.sync_status
    }

    fn on_host_data(&mut self, _: HostTopics, _: &mut Window, cx: &mut Context<Self>) {
        self.sync_status = self.host.sync_status();
        sync_sheets::refresh(self, cx);
        self.refresh_system();
        cx.notify();
    }

    fn confirm_delete_profile(&mut self, cx: &mut Context<Self>) {
        let Some(profile) = panes::selected_profile(self) else {
            return;
        };
        let Some(name) = self.state.profile(profile.as_str()).map(|p| p.name.clone()) else {
            return;
        };
        if self.state.profile_order.len() <= 1 {
            return;
        }
        let Some(window) = self.state.main_window_for(None).cloned() else {
            return;
        };
        let answer = self
            .host
            .confirm_in_window(window, delete_profile_question(&name));
        let host = self.host.clone();
        cx.spawn(async move |_, _| {
            if answer.await.unwrap_or(false) {
                host.dispatch(Action::DeleteProfile { profile });
            }
        })
        .detach();
    }

    fn download_targets(&self, every: bool) -> Vec<ardia_state::ProfileId> {
        if every {
            let mut profiles = vec![panes::default_profile(self)];
            for profile in self.state.profile_order.iter() {
                if !profiles.contains(profile) {
                    profiles.push(profile.clone());
                }
            }
            profiles
        } else {
            panes::selected_profile(self).into_iter().collect()
        }
    }

    fn pick_downloads(&mut self, every: bool, window: &mut Window, cx: &mut Context<Self>) {
        let targets = self.download_targets(every);
        let paths = cx.prompt_for_paths(gpui::PathPromptOptions {
            files: false,
            directories: true,
            multiple: false,
            prompt: Some("Use Folder".into()),
        });
        let host = self.host.clone();
        cx.spawn_in(window, async move |_, _| {
            let Ok(Ok(Some(paths))) = paths.await else {
                return;
            };
            let Some(folder) = paths.into_iter().next() else {
                return;
            };
            host.set_download_settings(targets, Some(folder.to_string_lossy().into_owned()), None);
        })
        .detach();
    }

    fn set_separate_downloads(&mut self, on: bool) {
        self.host.dispatch(Action::UpdateSettings {
            patch: ardia_state::settings::SettingsPatch::new().set("separateDownloadFolders", on),
            from_sync: false,
        });
        if on {
            return;
        }
        let main = panes::default_profile(self);
        let Some(current) = self.host.download_settings(&main).filter(|c| !c.managed) else {
            return;
        };
        let others: Vec<_> = self
            .download_targets(true)
            .into_iter()
            .filter(|profile| *profile != main)
            .collect();
        self.host.set_download_settings(
            others,
            Some(current.folder),
            Some(current.ask_where_to_save),
        );
    }

    pub(crate) fn refresh_system(&mut self) {
        self.login = self.host.open_at_login();
        self.system = rows::System {
            default_browser: self.host.default_browser(),
            login_items: self.login.is_some(),
            app_icons: self.host.app_icon_count() >= 2,
            calendar: self
                .host
                .calendar()
                .is_some_and(|calendar| calendar.access.connected()),
            sync_on: self.sync_status.enabled,
            webkit: self.host.offers_engine_choice(),
            updater: self.host.updater().is_some(),
            official_plugins: self
                .host
                .official_plugins()
                .is_some_and(|plugins| extras::official_in_settings(&plugins)),
            official_ai: self.host.official_plugins().is_some_and(|plugins| {
                plugins.iter().any(|p| {
                    p.name == "ai" && p.state != crate::host::OfficialPluginState::Unsupported
                })
            }),
        };
    }

    fn sync(&mut self, _: Topics, window: &mut Window, cx: &mut Context<Self>) {
        self.state = self.host.store().snapshot();
        crate::scale::sync(&self.state, cx);
        if self.look.refresh(&self.state, "", window.appearance()) {
            self.backdrop.aim(
                sidebar_material(self.look.backdrop(crate::window::looks_active(window))),
                false,
                std::time::Instant::now(),
            );
        }
        self.backdrop.apply(window, std::time::Instant::now());
        keybindings::sync(&self.state, cx);
        cx.notify();
    }

    fn on_search(
        &mut self,
        input: &Entity<TextInput>,
        event: &InputEvent,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        match event {
            InputEvent::Changed { .. } => {
                let started = self.query.trim().is_empty();
                self.query = input.read(cx).text().to_owned();
                self.selected_result = 0;
                note_search_typed(self, started, cx);
                if self.query.trim().is_empty() {
                    self.previewing = false;
                    self.preview_task = None;
                } else {
                    self.schedule_preview(cx);
                }
                cx.notify();
            }
            InputEvent::Cancel => {
                input.update(cx, |input, cx| input.set_text("", false, cx));
                self.query.clear();
                self.previewing = false;
                self.preview_task = None;
                window.focus(&self.focus, cx);
                cx.notify();
            }
            InputEvent::Up | InputEvent::Down => {
                let count = panes::result_rows(self).len() + panes::key_hits(self).len();
                if count > 0 {
                    let step = if matches!(event, InputEvent::Up) {
                        count - 1
                    } else {
                        1
                    };
                    self.selected_result = (self.selected_result + step) % count;
                    self.schedule_preview(cx);
                    cx.notify();
                }
            }
            InputEvent::Submit(_) => {
                let keys = panes::key_hits(self);
                if let Some(hit) = keys.get(self.selected_result) {
                    note_search_reveal(true, self.selected_result, false);
                    let command = format!("{KEYS_COMMAND}{}", hit.keys);
                    self.run_command(&command, window, cx);
                } else if let Some(row) = panes::result_rows(self)
                    .get(self.selected_result.saturating_sub(keys.len()))
                {
                    note_search_reveal(
                        true,
                        self.selected_result,
                        !row.shown_in(&self.state.settings, &self.system),
                    );
                    self.reveal(row.id, cx);
                }
            }
            _ => {}
        }
    }

    fn on_site_input(
        &mut self,
        input: &Entity<TextInput>,
        event: &InputEvent,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        match event {
            InputEvent::Submit(_) => self.add_kept_site(window, cx),
            InputEvent::Cancel => self.close_sheets(window, cx),
            InputEvent::Changed { .. } => {
                self.site_typed = input.read(cx).text().to_owned();
                if let Some(error) = self.site_sheet.as_mut() {
                    *error = None;
                }
                cx.notify();
            }
            _ => {}
        }
    }

    pub fn open_kept_site_sheet(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.site_sheet = Some(None);
        self.site_typed.clear();
        self.site_input
            .update(cx, |input, cx| input.set_text("", false, cx));
        cx.defer_in(window, |view, window, cx| {
            crate::primitives::text_input::focus_input(&view.site_input, window, cx);
        });
        cx.notify();
    }

    fn add_kept_site(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.site_sheet.is_none() || self.site_typed.trim().is_empty() {
            return;
        }
        let site = rows::keep_active_site_of(&self.site_typed);
        if !rows::keep_active_site_valid(&site) {
            self.site_sheet = Some(Some("Enter a site, like youtube.com."));
            cx.notify();
            return;
        }
        let mut sites = self.state.settings.keep_active_sites.clone();
        if !sites.contains(&site) {
            sites.push(site);
            self.host.dispatch(Action::UpdateSettings {
                patch: ardia_state::settings::SettingsPatch::new().set("keepActiveSites", sites),
                from_sync: false,
            });
        }
        self.close_sheets(window, cx);
    }

    fn close_sheets(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.rename_sheet = None;
        self.site_sheet = None;
        self.clean_up_sheet = None;
        window.focus(&self.focus, cx);
        cx.notify();
    }

    fn on_rename_input(
        &mut self,
        _: &Entity<TextInput>,
        event: &InputEvent,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        match event {
            InputEvent::Submit(_) => self.rename_profile(window, cx),
            InputEvent::Cancel => self.close_sheets(window, cx),
            _ => {}
        }
    }

    fn open_rename(&mut self, profile: ardia_state::ProfileId, window: &mut Window, cx: &mut Context<Self>) {
        let name = self
            .state
            .profile(profile.as_str())
            .map(|p| p.name.clone())
            .unwrap_or_default();
        self.rename_sheet = Some(profile);
        self.rename_input
            .update(cx, |input, cx| input.set_text(name, true, cx));
        cx.defer_in(window, |view, window, cx| {
            crate::primitives::text_input::focus_input(&view.rename_input, window, cx);
        });
        cx.notify();
    }

    fn rename_profile(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(profile) = self.rename_sheet.clone() else {
            return;
        };
        let name = self.rename_input.read(cx).text().trim().to_owned();
        if !name.is_empty() {
            self.host.dispatch(Action::UpdateProfile {
                profile,
                patch: ardia_state::ProfilePatch {
                    name: Some(name),
                    ..ardia_state::ProfilePatch::default()
                },
            });
            self.profile_name_for = None;
        }
        self.close_sheets(window, cx);
    }

    fn profile_menu(&mut self, profile: ardia_state::ProfileId, window: &mut Window, cx: &mut Context<Self>) {
        use crate::host::NativeMenuItem;
        let Some(found) = self.state.profile(profile.as_str()) else {
            return;
        };
        let color = Some(found.color.preset());
        let shares_top_apps =
            (!ardia_state::profile_circles::sharing_profiles(&self.state, &profile).is_empty())
                .then_some(found.share_top_apps);
        let colors = ardia_theme::ProfileColor::ALL
            .into_iter()
            .map(|c| {
                NativeMenuItem::new(&format!("color:{}", c.key()), c.spec().name, "")
                    .swatch(c.spec().swatch.to_u32() >> 8)
                    .checked(color == Some(c))
            })
            .collect();
        let is_default = self.state.settings.default_profile_id == profile.as_str();
        let only = self.state.profile_order.len() <= 1;
        let items = vec![
            NativeMenuItem::new("rename", "Rename…", "pencil"),
            NativeMenuItem::new(
                "icon",
                if found.icon.is_some() { "Change Icon…" } else { "Add Icon…" },
                "photo",
            ),
            NativeMenuItem::new("color", "Color", "paintpalette").children(colors),
            NativeMenuItem::separator(),
        ];
        let mut items = items;
        if let Some(on) = shares_top_apps {
            items.push(
                NativeMenuItem::new("topApps", "Share Top Apps", "square.grid.2x2").checked(on),
            );
            items.push(NativeMenuItem::separator());
        }
        items.extend([
            NativeMenuItem::new("details", "Show Profile Details", "info.circle"),
            NativeMenuItem::new("default", "Make Default Profile", "star").enabled(!is_default),
            NativeMenuItem::separator(),
            NativeMenuItem::new("delete", "Delete Profile…", "trash").enabled(!only),
        ]);
        let Some(choice) = self.host.show_menu(items) else {
            return;
        };
        cx.spawn_in(window, async move |view, cx| {
            let Ok(Some(choice)) = choice.await else {
                return;
            };
            let _ = view.update_in(cx, |view, window, cx| {
                view.pick_profile_menu(profile, &choice, window, cx);
            });
        })
        .detach();
    }

    fn pick_profile_menu(
        &mut self,
        profile: ardia_state::ProfileId,
        choice: &str,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if let Some(key) = choice.strip_prefix("color:") {
            if let Some(color) = ardia_theme::ProfileColor::ALL.into_iter().find(|c| c.key() == key) {
                self.host.dispatch(Action::UpdateProfile {
                    profile,
                    patch: ardia_state::ProfilePatch {
                        color: Some(color),
                        ..ardia_state::ProfilePatch::default()
                    },
                });
            }
            return;
        }
        match choice {
            "rename" => self.open_rename(profile, window, cx),
            "details" => {
                self.profile = Some(profile);
                cx.notify();
            }
            "icon" => {
                let anchor = profiles::anchor_of(&profiles::pill_anchor_key(profile.as_str()));
                for msg in profiles::icon_picker_msgs(&profile, anchor) {
                    self.handle(msg, window, cx);
                }
            }
            "topApps" => {
                let on = self
                    .state
                    .profile(profile.as_str())
                    .is_some_and(|found| found.share_top_apps);
                self.host.dispatch(Action::UpdateProfile {
                    profile,
                    patch: ardia_state::ProfilePatch {
                        share_top_apps: Some(!on),
                        ..ardia_state::ProfilePatch::default()
                    },
                });
            }
            "default" => self.host.dispatch(Action::UpdateSettings {
                patch: ardia_state::settings::SettingsPatch::new()
                    .set("defaultProfileId", profile.to_string()),
                from_sync: false,
            }),
            "delete" => {
                self.profile = Some(profile);
                self.confirm_delete_profile(cx);
            }
            _ => {}
        }
    }

    fn on_new_tab_url(
        &mut self,
        input: &Entity<TextInput>,
        event: &InputEvent,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        match event {
            InputEvent::Changed { .. } => {
                self.new_tab_typed = input.read(cx).text().to_owned();
                cx.notify();
            }
            InputEvent::Submit(_) => {
                self.save_new_tab_url();
                window.focus(&self.focus, cx);
            }
            InputEvent::Cancel => {
                self.new_tab_saved = None;
                self.sync_new_tab_url(cx);
                window.focus(&self.focus, cx);
            }
            _ => {}
        }
    }

    fn save_new_tab_url(&mut self) {
        let value = self.new_tab_typed.trim().to_owned();
        if value != self.state.settings.new_tab_url {
            self.host.dispatch(Action::UpdateSettings {
                patch: ardia_state::settings::SettingsPatch::new().set("newTabUrl", value),
                from_sync: false,
            });
        }
    }

    fn sync_new_tab_url(&mut self, cx: &mut Context<Self>) {
        let saved = self.state.settings.new_tab_url.clone();
        if self.new_tab_saved.as_deref() == Some(saved.as_str()) {
            return;
        }
        self.new_tab_saved = Some(saved.clone());
        self.new_tab_typed = saved.clone();
        self.new_tab_url
            .update(cx, |input, cx| input.set_text(saved, false, cx));
    }

    fn on_sheet_amount(
        &mut self,
        _: &Entity<TextInput>,
        event: &InputEvent,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        match event {
            InputEvent::Submit(_) => self.save_clean_up(window, cx),
            InputEvent::Cancel => {
                self.clean_up_sheet = None;
                window.focus(&self.focus, cx);
                cx.notify();
            }
            InputEvent::Changed { .. } => {
                if let Some((_, invalid)) = self.clean_up_sheet.as_mut() {
                    *invalid = false;
                }
                cx.notify();
            }
            _ => {}
        }
    }

    pub fn open_clean_up_sheet(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let minutes = self
            .state
            .settings
            .clean_up_inactive_tabs_after_minutes
            .map_or(24 * 60, |minutes| minutes.round() as i64);
        let (amount, unit) = panes::duration_parts(minutes);
        self.clean_up_sheet = Some((unit, false));
        self.sheet_amount
            .update(cx, |input, cx| input.set_text(amount.to_string(), true, cx));
        cx.defer_in(window, |view, window, cx| {
            crate::primitives::text_input::focus_input(&view.sheet_amount, window, cx);
        });
        cx.notify();
    }

    fn save_clean_up(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some((unit, _)) = self.clean_up_sheet else {
            return;
        };
        let typed = self.sheet_amount.read(cx).text().to_owned();
        match panes::duration_minutes(&typed, unit) {
            Some(minutes) => {
                self.host.dispatch(Action::UpdateSettings {
                    patch: ardia_state::settings::SettingsPatch::new()
                        .set("cleanUpInactiveTabsAfterMinutes", minutes as f64),
                    from_sync: false,
                });
                self.clean_up_sheet = None;
                window.focus(&self.focus, cx);
            }
            None => self.clean_up_sheet = Some((unit, true)),
        }
        cx.notify();
    }

    fn on_profile_name(
        &mut self,
        _: &Entity<TextInput>,
        event: &InputEvent,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        match event {
            InputEvent::Submit(_) => {
                self.commit_profile_name(cx);
                window.focus(&self.focus, cx);
            }
            InputEvent::Cancel => {
                self.profile_name_for = None;
                self.sync_profile_name(cx);
                window.focus(&self.focus, cx);
            }
            _ => {}
        }
    }

    fn commit_profile_name(&mut self, cx: &mut Context<Self>) {
        let Some(profile) = self.profile_name_for.clone() else {
            return;
        };
        let typed = self.profile_name.read(cx).text().trim().to_owned();
        let saved = self
            .state
            .profile(profile.as_str())
            .map(|p| p.name.clone())
            .unwrap_or_default();
        if typed.is_empty() {
            self.profile_name
                .update(cx, |input, cx| input.set_text(saved, false, cx));
            return;
        }
        if typed != saved {
            self.host.dispatch(Action::UpdateProfile {
                profile,
                patch: ardia_state::ProfilePatch {
                    name: Some(typed),
                    ..ardia_state::ProfilePatch::default()
                },
            });
        }
    }

    fn sync_profile_name(&mut self, cx: &mut Context<Self>) {
        let selected = panes::selected_profile(self);
        if selected == self.profile_name_for {
            return;
        }
        if self.profile_name_for.is_some() {
            self.commit_profile_name(cx);
        }
        let name = selected
            .as_ref()
            .and_then(|id| self.state.profile(id.as_str()))
            .map(|p| p.name.clone())
            .unwrap_or_default();
        self.profile_name_for = selected;
        self.profile_name
            .update(cx, |input, cx| input.set_text(name, false, cx));
    }

    fn on_shortcut_search(
        &mut self,
        input: &Entity<TextInput>,
        event: &InputEvent,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        match event {
            InputEvent::Changed { .. } => {
                self.shortcut_query = input.read(cx).text().to_owned();
                if !self.shortcut_query.trim().is_empty() {
                    let empty = panes::shortcut_entries(self).is_empty();
                    count_when_settled(cx, "shortcuts_key_searches_typed", empty);
                }
                cx.notify();
            }
            InputEvent::Cancel => {
                input.update(cx, |input, cx| input.set_text("", false, cx));
                self.shortcut_query.clear();
                window.focus(&self.focus, cx);
                cx.notify();
            }
            _ => {}
        }
    }

    pub(crate) fn handle(&mut self, msg: Msg, window: &mut Window, cx: &mut Context<Self>) {
        let Some(msg) = msg.deliver(&*self.host, None, cx) else {
            self.sync(Topics::ALL, window, cx);
            return;
        };
        match msg {
            Msg::SettingsPane(index) => {
                self.stop_recording(cx);
                if let Some(pane) = Pane::ALL.get(index) {
                    self.go_to(*pane, cx);
                }
                cx.notify();
            }
            Msg::Recording(id) => self.record(id, window, cx),
            Msg::Command(id) => self.run_command(&id, window, cx),
            Msg::People(msg) => self
                .people
                .update(cx, |layer, cx| layer.handle(msg, window, cx)),
            Msg::CloseOverlays => {
                self.scale_menu = false;
                self.menu = None;
                self.recording = None;
                self.interceptor = None;
                cx.notify();
            }
            _ => {}
        }
    }

    fn record_mouse(&mut self, button: gpui::MouseButton, modifiers: gpui::Modifiers, cx: &mut Context<Self>) {
        let Some(id) = self.recording.clone() else {
            return;
        };
        let Some(stored) = mouse_stored(button, modifiers) else {
            return;
        };
        let mut mouse = self.state.settings.mouse_shortcuts.clone();
        mouse.insert(id.to_string(), stored);
        self.host.dispatch(Action::UpdateSettings {
            patch: ardia_state::settings::SettingsPatch::new().set("mouseShortcuts", mouse),
            from_sync: false,
        });
        self.recording = None;
        self.interceptor = None;
        cx.notify();
    }

    fn stop_recording(&mut self, cx: &mut Context<Self>) {
        self.key_searching = false;
        if self.recording.take().is_some() || self.interceptor.is_some() {
            self.interceptor = None;
            cx.notify();
        }
    }

    fn record(&mut self, id: Option<SharedString>, window: &mut Window, cx: &mut Context<Self>) {
        self.recording = id.clone();
        let own = window.window_handle().window_id();
        self.interceptor = id.map(|id| {
            let view = cx.weak_entity();
            cx.intercept_keystrokes(move |event, window, cx| {
                if window.window_handle().window_id() != own {
                    return;
                }
                let keystroke = event.keystroke.clone();
                let id = id.clone();
                if keystroke.key == "escape" {
                    cx.stop_propagation();
                    let _ = view.update(cx, |view, cx| {
                        view.recording = None;
                        view.interceptor = None;
                        cx.notify();
                    });
                    return;
                }
                let Some(shortcut) = shortcut_of(&keystroke) else {
                    return;
                };
                cx.stop_propagation();
                let _ = view.update(cx, |view, cx| {
                    view.host.dispatch(Action::SetShortcut {
                        id: id.to_string(),
                        shortcut: Some(shortcut),
                    });
                    view.recording = None;
                    view.interceptor = None;
                    view.state = view.host.store().snapshot();
                    keybindings::sync(&view.state, cx);
                    cx.notify();
                });
            })
        });
        cx.notify();
    }

    fn search_by_keys(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.key_searching {
            self.key_searching = false;
            self.interceptor = None;
            cx.notify();
            return;
        }
        self.recording = None;
        self.key_searching = true;
        let own = window.window_handle().window_id();
        let view = cx.weak_entity();
        self.interceptor = Some(cx.intercept_keystrokes(move |event, window, cx| {
            if window.window_handle().window_id() != own {
                return;
            }
            let keystroke = event.keystroke.clone();
            if keystroke.key == "escape" {
                cx.stop_propagation();
                let _ = view.update(cx, |view, cx| {
                    view.key_searching = false;
                    view.interceptor = None;
                    cx.notify();
                });
                return;
            }
            let Some(shortcut) = shortcut_of(&keystroke) else {
                return;
            };
            cx.stop_propagation();
            let keys = shortcut.format(ardia_state::shortcuts::Platform::current());
            let _ = view.update(cx, |view, cx| {
                view.key_searching = false;
                view.interceptor = None;
                view.shortcut_query = keys.clone();
                view.shortcut_search
                    .update(cx, |input, cx| input.set_text(keys, false, cx));
                ardia_telemetry::counts::count("shortcuts_key_searches_recorded");
                if panes::shortcut_entries(view).is_empty() {
                    ardia_telemetry::counts::count("shortcuts_key_searches_empty");
                }
                cx.notify();
            });
        }));
        cx.notify();
    }

    fn run_command(&mut self, id: &str, window: &mut Window, cx: &mut Context<Self>) {
        match id {
            other if other.starts_with(sync_sheets::PREFIX) => {
                sync_sheets::run(self, other, window, cx)
            }
            "settings:interfaceSizeMenu" => {
                self.scale_menu = !self.scale_menu;
                cx.notify();
            }
            other if other.starts_with("settings:syncType:") => {
                if let Some((kind, on)) = other["settings:syncType:".len()..].rsplit_once(':') {
                    self.host.set_sync_type(kind.to_owned(), on == "true");
                }
            }
            other if other.starts_with("settings:syncAllTabs:") => {
                self.host.set_open_tabs_synced(other.ends_with(":true"));
            }
            "std:closeWindow:" | "closeTab" => {
                if !self.query.trim().is_empty() {
                    ardia_telemetry::counts::count("settings_searches_closed");
                }
                window.remove_window()
            }
            "settings:makeDefaultBrowser" => {
                self.host.make_default_browser();
                self.refresh_system();
                cx.notify();
            }
            "settings:openAtLogin:true" | "settings:openAtLogin:false" => {
                self.host.set_open_at_login(id.ends_with(":true"));
                self.refresh_system();
                cx.notify();
            }
            "settings:deleteProfile" => self.confirm_delete_profile(cx),
            other if other.starts_with("settings:hoverShortcut:") => {
                let rest = &other["settings:hoverShortcut:".len()..];
                let next = match rest.split_once(':') {
                    Some(("in", id)) => ardia_state::commands::COMMANDS
                        .iter()
                        .map(|spec| spec.command.id())
                        .find(|known| *known == id),
                    Some(("out", id)) if self.hovered_shortcut == Some(id) => None,
                    _ => self.hovered_shortcut,
                };
                if next != self.hovered_shortcut {
                    self.hovered_shortcut = next;
                    cx.notify();
                }
            }
            other if other.starts_with("settings:profileFlag:") => {
                let rest = &other["settings:profileFlag:".len()..];
                let flag = [
                    crate::host::ProfileFlagKind::PasswordsOffered,
                    crate::host::ProfileFlagKind::AddressesAutofilled,
                    crate::host::ProfileFlagKind::CardsAutofilled,
                    crate::host::ProfileFlagKind::PreloadPages,
                ]
                .into_iter()
                .find(|flag| rest.starts_with(&format!("{}:", panes::flag_key(*flag))));
                if let (Some(flag), Some(profile)) = (flag, panes::selected_profile(self)) {
                    self.host
                        .set_profile_flag(profile, flag, rest.ends_with(":true"));
                    cx.notify();
                }
            }
            "settings:cleanUpCustom" => self.open_clean_up_sheet(window, cx),
            "settings:cleanUpSave" => self.save_clean_up(window, cx),
            "settings:sheetClose" => self.close_sheets(window, cx),
            "settings:keptSiteSheet" => self.open_kept_site_sheet(window, cx),
            "settings:keptSiteAdd" => self.add_kept_site(window, cx),
            other if other.starts_with("settings:keptSiteRemove:") => {
                let site = &other["settings:keptSiteRemove:".len()..];
                let sites: Vec<String> = self
                    .state
                    .settings
                    .keep_active_sites
                    .iter()
                    .filter(|kept| kept.as_str() != site)
                    .cloned()
                    .collect();
                if sites.len() != self.state.settings.keep_active_sites.len() {
                    self.host.dispatch(Action::UpdateSettings {
                        patch: ardia_state::settings::SettingsPatch::new()
                            .set("keepActiveSites", sites),
                        from_sync: false,
                    });
                }
            }
            other if other.starts_with("settings:cleanUpUnit:") => {
                let key = &other["settings:cleanUpUnit:".len()..];
                if let Some((unit, _, _)) = panes::DURATION_UNITS.iter().find(|(k, _, _)| *k == key)
                {
                    self.clean_up_sheet = Some((unit, false));
                    cx.notify();
                }
            }
            "settings:sharing:true" | "settings:sharing:false" => {
                self.host.set_sharing(
                    id.ends_with(":true"),
                    ardia_telemetry::SharingSource::Settings,
                    None,
                );
                cx.notify();
            }
            other if other.starts_with(theme_section::STOP_COMMAND) => {
                if let Ok(index) = other[theme_section::STOP_COMMAND.len()..].parse::<usize>() {
                    self.theme_stop = index;
                    cx.notify();
                }
            }
            other if other.starts_with("settings:swatchHover:") => {
                let rest = &other["settings:swatchHover:".len()..];
                let next = match rest.split_once(':') {
                    Some(("in", key)) => ardia_theme::ProfileColor::ALL
                        .into_iter()
                        .find(|color| color.key() == key),
                    Some(("out", key)) if self.swatch_hover.is_some_and(|c| c.key() == key) => None,
                    _ => self.swatch_hover,
                };
                if next != self.swatch_hover {
                    self.swatch_hover = next;
                    cx.notify();
                }
            }
            other if other.starts_with("settings:profileMenu:") => {
                let id = &other["settings:profileMenu:".len()..];
                if self.state.profile(id).is_some() {
                    self.profile_menu(ardia_state::ProfileId::from(id.to_owned()), window, cx);
                }
            }
            other if other.starts_with("settings:profileMove:") => {
                let rest = &other["settings:profileMove:".len()..];
                if let Some((moving, before)) = rest.split_once(':')
                    && let Some(order) = panes::reordered(&self.state.profile_order, moving, before)
                {
                    self.host.dispatch(Action::ReorderProfiles { order });
                }
            }
            "settings:renameSave" => self.rename_profile(window, cx),
            other if other.starts_with("settings:appIcon:") => {
                self.host
                    .set_app_icon(other["settings:appIcon:".len()..].to_owned());
                cx.notify();
            }
            other if other.starts_with(KEYS_COMMAND) => {
                if !self.query.trim().is_empty() {
                    ardia_telemetry::counts::count("settings_search_key_hit_opens");
                }
                let keys = other[KEYS_COMMAND.len()..].to_owned();
                self.go_to(Pane::Shortcuts, cx);
                self.shortcut_query = keys.clone();
                self.shortcut_search
                    .update(cx, |input, cx| input.set_text(keys, false, cx));
                cx.notify();
            }
            other if other.starts_with("settings:clearShortcut:") => {
                let id = &other["settings:clearShortcut:".len()..];
                if let Some(spec) = ardia_state::commands::COMMANDS
                    .iter()
                    .find(|spec| spec.command.id() == id)
                {
                    let id = id.to_owned();
                    self.host.dispatch(if spec.keys.is_empty() {
                        Action::ResetShortcut { id }
                    } else {
                        Action::SetShortcut { id, shortcut: None }
                    });
                }
            }
            other if other.starts_with("settings:clearMouseShortcut:") => {
                let id = &other["settings:clearMouseShortcut:".len()..];
                let mut mouse = self.state.settings.mouse_shortcuts.clone();
                if mouse.shift_remove(id).is_some() {
                    self.host.dispatch(Action::UpdateSettings {
                        patch: ardia_state::settings::SettingsPatch::new().set("mouseShortcuts", mouse),
                        from_sync: false,
                    });
                }
            }
            "settings:keySearch" => self.search_by_keys(window, cx),
            other if other.starts_with("settings:relinkPrograms:") => {
                if let Some(plugins) = self.host.plugins() {
                    let plugin = &other["settings:relinkPrograms:".len()..];
                    if let Err(problem) = plugins.relink_programs(plugin) {
                        log::debug!("programs for {plugin} weren't relinked: {problem}");
                    }
                    cx.notify();
                }
            }
            "settings:showPluginsFolder" => {
                if let Some(folder) = self.host.plugin_folder() {
                    self.host.reveal_path(folder);
                }
            }
            other if other.starts_with("settings:pluginOff:") => {
                self.host
                    .turn_plugin_off(other["settings:pluginOff:".len()..].to_owned());
            }
            "settings:pickDownloads:all" | "settings:pickDownloads:profile" => {
                self.pick_downloads(id.ends_with(":all"), window, cx);
            }
            "settings:separateDownloads:true" | "settings:separateDownloads:false" => {
                self.set_separate_downloads(id.ends_with(":true"));
            }
            "settings:askWhereToSave:true" | "settings:askWhereToSave:false" => {
                let profiles = self.download_targets(true);
                self.host
                    .set_download_settings(profiles, None, Some(id.ends_with(":true")));
            }
            "settings:back" => self.step_history(true, cx),
            "settings:forward" => self.step_history(false, cx),
            other if other.starts_with(automations::COMMAND) => {
                automations::run(self, other, window, cx);
            }
            other if other.starts_with(updates::COMMAND) => {
                updates::run(self, other, cx);
            }
            other if other.starts_with(extras::COMMAND) => {
                extras::run(self, other, window, cx);
            }
            other if panes::menu_of(other).is_some() => {
                let menu = panes::menu_of(other).map(|id| SharedString::from(id.to_owned()));
                self.menu = if self.menu == menu { None } else { menu };
                cx.notify();
            }
            other if other.starts_with(PROFILE_COMMAND) => {
                let id = &other[PROFILE_COMMAND.len()..];
                if self.state.profile(id).is_some() {
                    self.profile = Some(ardia_state::ProfileId::from(id.to_owned()));
                    cx.notify();
                }
            }
            other if other.starts_with(subpages::COMMAND) => {
                subpages::run(self, other, window, cx);
            }
            other if other.starts_with(REVEAL_COMMAND) => {
                let id = &other[REVEAL_COMMAND.len()..];
                if !self.query.trim().is_empty()
                    && let Some(rank) = panes::result_rows(self).iter().position(|row| row.id == id)
                {
                    let shown = panes::result_rows(self)[rank]
                        .shown_in(&self.state.settings, &self.system);
                    note_search_reveal(false, rank + panes::key_hits(self).len(), !shown);
                }
                self.reveal(id, cx);
            }
            other if other.starts_with(FILTER_COMMAND) => {
                let key = &other[FILTER_COMMAND.len()..];
                if let Some((filter, _)) = panes::ShortcutFilter::ALL
                    .iter()
                    .find(|(filter, _)| filter.key() == key)
                {
                    self.shortcut_filter = *filter;
                    cx.notify();
                }
            }
            "openSettings" => window.focus(&self.focus, cx),
            "findInPage" | "focusCommandBar" | "searchTabs" => {
                crate::primitives::text_input::focus_input(&self.search, window, cx);
            }
            other => {
                let main = self.state.main_window_for(None).cloned();
                if let Some(handle) =
                    main.and_then(|main| crate::window::WindowRegistry::get(&main, cx))
                {
                    let id = SharedString::from(other.to_owned());
                    let _ = handle.update(cx, |view, window, cx| {
                        view.run_command(&id, window, cx);
                        window.activate_window();
                    });
                } else if other == "newWindow" || other == "newTab" {
                    self.host.dispatch(Action::OpenWindow {
                        kind: ardia_state::windows::WindowKind::Main,
                        profile: None,
                        url: None,
                        frame: None,
                    });
                }
            }
        }
    }

    fn on_run_command(&mut self, action: &RunCommand, window: &mut Window, cx: &mut Context<Self>) {
        self.run_command(&action.id, window, cx);
    }

    fn on_reserved_command(
        &mut self,
        action: &RunReservedCommand,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.run_command(&action.id, window, cx);
    }

    fn on_dismiss(&mut self, _: &Dismiss, window: &mut Window, cx: &mut Context<Self>) {
        if self.sync.sheet.is_some() && self.menu.is_none() {
            sync_sheets::close(self, window, cx);
        } else if self.automations.has_sheet() && self.menu.is_none() {
            automations::close_sheet(self, cx);
        } else if self.clean_up_sheet.is_some() || self.site_sheet.is_some() || self.rename_sheet.is_some() {
            self.close_sheets(window, cx);
        } else if self.sub.sheet_open() && self.menu.is_none() {
            subpages::close_sheet(self, window, cx);
        } else if self.recording.is_some() || self.menu.is_some() {
            self.handle(Msg::CloseOverlays, window, cx);
        } else if !self.query.is_empty() {
            self.search
                .update(cx, |input, cx| input.set_text("", false, cx));
            self.query.clear();
            cx.notify();
        }
    }

    fn pane_list(&self) -> AnyElement {
        let p = self.look.p;
        div()
            .id("settings-panes")
            .flex_1()
            .min_h_0()
            .overflow_y_scroll()
            .px(px(10.))
            .pb(px(12.))
            .flex()
            .flex_col()
            .gap(px(4.))
            .children(Pane::ALL.iter().enumerate().map(|(index, pane)| {
                let selected = *pane == self.pane;
                let hover = p.row_hover;
                div()
                    .id(("settings-pane", index))
                    .debug_selector(move || format!("settings-pane:{}", pane.title()))
                    .flex_none()
                    .h(px(PANE_ROW_HEIGHT))
                    .px(px(8.))
                    .rounded(px(6.))
                    .flex()
                    .items_center()
                    .gap(px(8.))
                    .text_size(px(13.))
                    .text_color(if selected { p.on_accent } else { p.text })
                    .when(selected, |this| this.bg(p.form_accent))
                    .when(!selected, |this| this.hover(move |style| style.bg(hover)))
                    .on_mouse_down(MouseButton::Left, self.emit.on(Msg::SettingsPane(index)))
                    .child(
                        div()
                            .flex_none()
                            .size(px(PANE_TILE))
                            .rounded(px(5.))
                            .bg(gpui::rgb(pane.tint()))
                            .flex()
                            .items_center()
                            .justify_center()
                            .child(crate::icon_picker::symbols::symbol(
                                &*self.host,
                                pane.symbol(),
                                PANE_SYMBOL,
                                PANE_TILE,
                                crate::icon_picker::symbols::SymbolWeight::Semibold,
                                gpui::white(),
                            )),
                    )
                    .child(pane.title())
            }))
            .into_any_element()
    }

    fn results(&self) -> AnyElement {
        let p = self.look.p;
        let hit_listed = panes::result_list(self);
        let key_listed = panes::key_hit_list(self);
        let hits = &hit_listed.rows;
        let key_hits = &key_listed.rows;
        let handle = crate::primitives::virtual_list::scroll_handle(RESULTS_LIST);
        if hits.is_empty() && key_hits.is_empty() {
            handle.set_offset(gpui::point(px(0.), px(0.)));
            return div()
                .debug_selector(|| "settings-no-results".into())
                .px(px(16.))
                .pt(px(40.))
                .flex()
                .flex_col()
                .items_center()
                .gap(px(6.))
                .child(icon(Icon::Search, 24., p.text_tertiary))
                .child(
                    div()
                        .text_size(px(13.))
                        .font_weight(gpui::FontWeight::SEMIBOLD)
                        .child("No Results"),
                )
                .child(
                    div()
                        .text_center()
                        .text_size(px(11.))
                        .text_color(p.text_secondary)
                        .child(
                            match ardia_state::shortcuts::Shortcut::parse_glyphs(self.query.trim()) {
                                Some(combo) => format!(
                                    "No command or setting uses {}.",
                                    combo.format(ardia_state::shortcuts::Platform::current())
                                ),
                                None => format!(
                                    "Nothing matches \u{201c}{}\u{201d}. Try a setting's name or a shorter word, like \u{201c}dark\u{201d} or \u{201c}downloads\u{201d}.",
                                    self.query.trim()
                                ),
                            },
                        ),
                )
                .into_any_element();
        }
        let settings = &self.state.settings;
        let key_row = |index: usize, hit: &panes::KeyHit| {
                let selected = index == self.selected_result;
                let primary = if selected { p.on_accent } else { p.text };
                let secondary = if selected {
                    gpui::hsla(0.0, 0.0, 1.0, 0.8)
                } else {
                    p.text_secondary
                };
                let hover = p.row_hover;
                let id = hit.id;
                div()
                    .id(SharedString::from(format!("settings-keys:{id}")))
                    .debug_selector(move || format!("settings-keys:{id}"))
                    .flex_none()
                    .min_h(px(PANE_ROW_HEIGHT))
                    .px(px(8.))
                    .py(px(4.))
                    .rounded(px(6.))
                    .flex()
                    .flex_col()
                    .justify_center()
                    .when(selected, |this| this.bg(p.form_accent))
                    .when(!selected, |this| this.hover(move |style| style.bg(hover)))
                    .on_click(self.emit.click(Msg::Command(SharedString::from(format!(
                        "{KEYS_COMMAND}{}",
                        hit.keys
                    )))))
                    .child(
                        div()
                            .flex()
                            .text_size(px(13.))
                            .text_color(primary)
                            .child(div().flex_shrink(1.).min_w_0().truncate().child(hit.title))
                            .child(
                                div()
                                    .flex_none()
                                    .font_weight(gpui::FontWeight::BOLD)
                                    .child(format!("\u{a0}\u{2014}\u{a0}{}", hit.keys)),
                            ),
                    )
                    .child(
                        div()
                            .text_size(px(11.))
                            .text_color(secondary)
                            .child(hit.path.clone()),
                    )
        };
        let hit_row = |index: usize, row: &'static rows::Row| {
                let selected = index == self.selected_result;
                let primary = if selected { p.on_accent } else { p.text };
                let secondary = if selected {
                    gpui::hsla(0.0, 0.0, 1.0, 0.8)
                } else {
                    p.text_secondary
                };
                let hover = p.row_hover;
                let place = if row.section != row.title && row.section != row.pane.title() {
                    format!("{} \u{203a} {}", row.pane.title(), row.section)
                } else {
                    row.pane.title().to_owned()
                };
                let needs = (!row.shown_in(settings, &self.system) && !row.needs.is_empty())
                    .then_some(row.needs);
                div()
                    .id(SharedString::from(format!("settings-result:{}", row.id)))
                    .debug_selector(move || format!("settings-result:{}", row.id))
                    .flex_none()
                    .min_h(px(PANE_ROW_HEIGHT))
                    .px(px(8.))
                    .py(px(4.))
                    .rounded(px(6.))
                    .flex()
                    .flex_col()
                    .justify_center()
                    .when(selected, |this| this.bg(p.form_accent))
                    .when(!selected, |this| this.hover(move |style| style.bg(hover)))
                    .on_click(self.emit.click(Msg::Command(SharedString::from(format!(
                        "{REVEAL_COMMAND}{}",
                        row.id
                    )))))
                    .child(
                        div().text_size(px(13.)).text_color(primary).child(
                            gpui::StyledText::new(row.title).with_highlights(
                                rows::match_ranges(row.title, &self.query)
                                    .into_iter()
                                    .map(|range| (range, bold())),
                            ),
                        ),
                    )
                    .child(div().text_size(px(11.)).text_color(secondary).child({
                        let offset = place.len().saturating_sub(row.section.len());
                        let marks: Vec<_> = if place.ends_with(row.section) && place.len() > row.pane.title().len() {
                            rows::match_ranges(row.section, &self.query)
                                .into_iter()
                                .map(|range| (range.start + offset..range.end + offset, bold()))
                                .collect()
                        } else {
                            Vec::new()
                        };
                        gpui::StyledText::new(place).with_highlights(marks)
                    }))
                    .when_some(rows::keyword_note(row, &self.query), |this, (note, marks)| {
                        this.child(
                            div().text_size(px(11.)).text_color(secondary).child(
                                gpui::StyledText::new(note)
                                    .with_highlights(marks.into_iter().map(|range| (range, bold()))),
                            ),
                        )
                    })
                    .when_some(needs, |this, needs| {
                        this.child(div().text_size(px(11.)).text_color(secondary).child(needs))
                    })
        };
        let selected = key_listed
            .items
            .iter()
            .chain(&hit_listed.items)
            .nth(self.selected_result)
            .map(|item| item.key.clone());
        div()
            .id("settings-results")
            .flex_1()
            .min_h_0()
            .overflow_y_scroll()
            .track_scroll(&handle)
            .px(px(10.))
            .pt(px(2.))
            .pb(px(12.))
            .flex()
            .flex_col()
            .gap(px(2.))
            .child(
                crate::primitives::virtual_list::virtual_list(RESULTS_LIST, &handle)
                    .items(key_listed.items.iter().chain(&hit_listed.items).cloned())
                    .gap(2.)
                    .keep(selected)
                    .render(|index, _| match key_hits.get(index) {
                        Some(hit) => key_row(index, hit).into_any_element(),
                        None => hit_row(index, hits[index - key_hits.len()]).into_any_element(),
                    }),
            )
            .into_any_element()
    }

    fn nav(&self) -> AnyElement {
        let p = self.look.p;
        let searching = !self.query.trim().is_empty();
        div()
            .id("settings-nav")
            .flex_none()
            .w(px(NAV_WIDTH))
            .h_full()
            .pt(px(TITLEBAR))
            .flex()
            .flex_col()
            .child(
                div().px(px(10.)).mb(px(10.)).child(
                    field_box(&p)
                        .id("settings-search")
                        .debug_selector(|| "settings-search".into())
                        .gap(px(6.))
                        .child(icon(Icon::Search, 11., p.text_tertiary))
                        .child(div().flex_1().min_w_0().child(self.search.clone())),
                ),
            )
            .child(if searching {
                self.results()
            } else {
                crate::primitives::virtual_list::scroll_handle(RESULTS_LIST)
                    .set_offset(gpui::point(px(0.), px(0.)));
                self.pane_list()
            })
            .into_any_element()
    }

    fn toolbar(&self) -> AnyElement {
        let p = self.look.p;
        div()
            .id("settings-toolbar")
            .flex_none()
            .h(px(TITLEBAR))
            .px(px(12.))
            .flex()
            .items_center()
            .gap(px(2.))
            .on_mouse_down(MouseButton::Left, |event, window, _| {
                if event.click_count >= 2 {
                    window.titlebar_double_click();
                } else {
                    window.start_window_move();
                }
            })
            .child(
                div().debug_selector(|| "settings-back".into()).child(
                    IconButton::new("settings-back", Icon::ChevronLeft, &p)
                        .square(28., 6.)
                        .glyph(14.)
                        .disabled(!self.can_go_back())
                        .tooltip("Back", &p)
                        .on_click(
                            self.emit
                                .click(Msg::Command(SharedString::new_static("settings:back"))),
                        ),
                ),
            )
            .child(
                div().debug_selector(|| "settings-forward".into()).child(
                    IconButton::new("settings-forward", Icon::ChevronRight, &p)
                        .square(28., 6.)
                        .glyph(14.)
                        .disabled(!self.can_go_forward())
                        .tooltip("Forward", &p)
                        .on_click(
                            self.emit
                                .click(Msg::Command(SharedString::new_static("settings:forward"))),
                        ),
                ),
            )
            .child(
                div()
                    .debug_selector(|| "settings-title".into())
                    .ml(px(8.))
                    .text_size(px(15.))
                    .font_weight(gpui::FontWeight::SEMIBOLD)
                    .child(self.title()),
            )
            .into_any_element()
    }

    fn title(&self) -> SharedString {
        if let Some(title) = extras::plugin_title(self) {
            return title;
        }
        if self.pane == Pane::Profiles
            && let Some(profile) =
                panes::selected_profile(self).and_then(|id| self.state.profile(id.as_str()))
        {
            return SharedString::from(profile.name.clone());
        }
        SharedString::new_static(self.pane.title())
    }
}

impl Render for SettingsWindowView {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let started = std::time::Instant::now();
        crate::profiled::profiled_root(
            ardia_profile::FrameSlot::Settings,
            started,
            self.render_root(window, cx),
        )
    }
}

impl SettingsWindowView {
    fn render_root(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement + use<> {
        if self.backdrop.apply(window, std::time::Instant::now()) || self.flash.is_some() {
            window.request_animation_frame();
        }
        let p = self.look.p;
        let plugin_consent = crate::plugins::consent::settings_consent(&self.host, p, window, cx);
        self.sync_profile_name(cx);
        self.sync_new_tab_url(cx);
        plugin_values::sync(self, window, cx);
        self.sub.memo.frame = Default::default();
        let blocks = panes::content(self);
        div()
            .id("settings-window")
            .key_context("ArdiaWindow SettingsWindow")
            .track_focus(&self.focus)
            .size_full()
            .relative()
            .flex()
            .font_family(UI_FONT)
            .text_color(p.text)
            .on_action(cx.listener(Self::on_run_command))
            .on_action(cx.listener(Self::on_reserved_command))
            .on_action(cx.listener(Self::on_dismiss))
            .when(self.recording.is_some(), |this| {
                this.capture_any_mouse_down(cx.listener(|view, event: &gpui::MouseDownEvent, _, cx| {
                    if !matches!(event.button, gpui::MouseButton::Left | gpui::MouseButton::Right) {
                        cx.stop_propagation();
                        view.record_mouse(event.button, event.modifiers, cx);
                    }
                }))
            })
            .child(
                div()
                    .absolute()
                    .left_0()
                    .top_0()
                    .w(px(NAV_WIDTH))
                    .h(px(TITLEBAR))
                    .on_mouse_down(MouseButton::Left, |event, window, _| {
                        if event.click_count >= 2 {
                            window.titlebar_double_click();
                        } else {
                            window.start_window_move();
                        }
                    }),
            )
            .children(plugin_consent)
            .child(self.nav())
            .child(
                div()
                    .flex_none()
                    .w(px(1.))
                    .h_full()
                    .bg(panes::sidebar_divider(p.dark)),
            )
            .child(
                div()
                    .id("settings-card")
                    .debug_selector(|| "settings-card".into())
                    .flex_1()
                    .min_w_0()
                    .h_full()
                    .flex()
                    .flex_col()
                    .bg(panes::window_fill(p.dark))
                    .child(self.toolbar())
                    .child(
                        div()
                            .id("settings-content")
                            .flex_1()
                            .min_h_0()
                            .overflow_y_scroll()
                            .track_scroll(&self.scroll)
                            .flex()
                            .flex_col()
                            .items_center()
                            .children(blocks.into_iter().map(|block| {
                                div()
                                    .w_full()
                                    .max_w(px(panes::COLUMN_MAX_WIDTH))
                                    .px(px(panes::COLUMN_PAD_X))
                                    .child(block.element)
                            }))
                            .child(div().flex_none().h(px(panes::PANE_BOTTOM))),
                    ),
            )
            .when_some(self.clean_up_sheet, |this, (unit, invalid)| {
                this.child(panes::clean_up_sheet(self, unit, invalid))
            })
            .when_some(self.site_sheet, |this, error| {
                this.child(panes::kept_site_sheet(self, error))
            })
            .children(automations::sheet(self, cx))
            .when(self.rename_sheet.is_some(), |this| {
                this.child(panes::rename_sheet(self))
            })
            .children(subpages::sheet(self, cx))
            .children(sync_sheets::sheet(self, cx))
            .child(self.people.clone())
    }
}

pub fn mouse_stored(button: gpui::MouseButton, modifiers: gpui::Modifiers) -> Option<Vec<String>> {
    let key = match button {
        gpui::MouseButton::Middle => "mouse:middle",
        gpui::MouseButton::Navigate(gpui::NavigationDirection::Back) => "mouse:4",
        gpui::MouseButton::Navigate(gpui::NavigationDirection::Forward) => "mouse:5",
        _ => return None,
    };
    let mut stored = vec![key.to_owned()];
    for (on, name) in [
        (modifiers.control, "control"),
        (modifiers.alt, "option"),
        (modifiers.shift, "shift"),
        (modifiers.platform, "command"),
    ] {
        if on {
            stored.push(name.to_owned());
        }
    }
    Some(stored)
}

pub fn sidebar_material(spec: gpui::BackdropLayerSpec) -> gpui::BackdropLayerSpec {
    let clear = gpui::Rgba {
        r: 0.0,
        g: 0.0,
        b: 0.0,
        a: 0.0,
    };
    gpui::BackdropLayerSpec {
        top: clear,
        mid: clear,
        bottom: clear,
        base_tint: clear,
        grain_intensity: 0.0,
        ..spec
    }
}

pub fn delete_profile_question(name: &str) -> crate::host::Confirmation {
    crate::host::Confirmation {
        title: format!("Delete \u{201c}{name}\u{201d}?"),
        message:
            "All data associated with this Profile will be removed. This action cannot be undone."
                .to_owned(),
        confirm: "Delete Profile".to_owned(),
        destructive: true,
    }
}

#[derive(Debug, Default)]
struct PaneHistory {
    back: Vec<Place>,
    forward: Vec<Place>,
}

type Place = (Pane, Option<subpages::Detail>);

impl PaneHistory {
    fn visit(&mut self, from: Place) {
        self.back.push(from);
        self.forward.clear();
    }

    fn back(&mut self, current: Place) -> Option<Place> {
        let pane = self.back.pop()?;
        self.forward.push(current);
        Some(pane)
    }

    fn forward(&mut self, current: Place) -> Option<Place> {
        let pane = self.forward.pop()?;
        self.back.push(current);
        Some(pane)
    }
}

static SEARCH_EMPTY_NOTED: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
static SEARCH_SETTLE: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
const SEARCH_SETTLE_MS: u64 = 600;

fn note_search_typed(view: &SettingsWindowView, started: bool, cx: &mut Context<SettingsWindowView>) {
    use std::sync::atomic::Ordering;
    let query = view.query.trim();
    if query.is_empty() {
        return;
    }
    if started {
        SEARCH_EMPTY_NOTED.store(false, Ordering::Relaxed);
        ardia_telemetry::counts::count("settings_searches");
    }
    let keys = panes::key_hits(view);
    if keys.is_empty()
        && query.chars().count() >= 2
        && panes::result_rows(view).is_empty()
        && !SEARCH_EMPTY_NOTED.swap(true, Ordering::Relaxed)
    {
        ardia_telemetry::counts::count("settings_searches_empty");
    }
    if !keys.is_empty() {
        count_when_settled(cx, "settings_search_key_searches", false);
    }
}

fn count_when_settled(cx: &mut Context<SettingsWindowView>, field: &'static str, empty: bool) {
    use std::sync::atomic::Ordering;
    let generation = SEARCH_SETTLE.fetch_add(1, Ordering::Relaxed) + 1;
    cx.spawn(async move |_, cx| {
        cx.background_executor()
            .timer(std::time::Duration::from_millis(SEARCH_SETTLE_MS))
            .await;
        if SEARCH_SETTLE.load(Ordering::Relaxed) == generation {
            ardia_telemetry::counts::count(field);
            if empty {
                ardia_telemetry::counts::count("shortcuts_key_searches_empty");
            }
        }
    })
    .detach();
}

fn note_search_reveal(keyboard: bool, rank: usize, unshown: bool) {
    ardia_telemetry::counts::count(if keyboard {
        "settings_search_keyboard_reveals"
    } else {
        "settings_search_click_reveals"
    });
    ardia_telemetry::counts::count(match rank {
        0 => "settings_search_top_picks",
        1 | 2 => "settings_search_top3_picks",
        _ => "settings_search_lower_picks",
    });
    if unshown {
        ardia_telemetry::counts::count("settings_search_unshown_reveals");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_search_flash_rises_holds_and_fades_like_the_old_form() {
        assert_eq!(flash_envelope(0.0), 0.0);
        assert!(flash_envelope(50.0) > 0.8);
        assert_eq!(flash_envelope(500.0), 1.0);
        assert!((flash_envelope(1_200.0) - 0.5).abs() < 1e-4);
        assert_eq!(flash_envelope(1_400.0), 0.0);
        assert_eq!(FLASH_MS, 1_400);
    }

    #[test]
    fn recorded_keys_become_shortcuts() {
        let shortcut =
            shortcut_of(&Keystroke::parse("cmd-shift-y").expect("parses")).expect("a shortcut");
        assert_eq!(shortcut, Shortcut::parse_glyphs("⇧⌘Y").expect("parses"));
        assert!(shortcut_of(&Keystroke::parse("y").expect("parses")).is_none());
        assert!(shortcut_of(&Keystroke::parse("cmd-escape").expect("parses")).is_none());
        assert_eq!(
            shortcut_of(&Keystroke::parse("f5").expect("parses")),
            Some(Shortcut::new(Key::Function(5), Modifiers::NONE))
        );
        assert_eq!(
            shortcut_of(&Keystroke::parse("ctrl-alt-left").expect("parses")),
            Shortcut::parse_glyphs("⌃⌥←")
        );
    }
}

