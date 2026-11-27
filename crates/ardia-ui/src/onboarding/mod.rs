pub mod anon;
pub mod copy;
pub mod intro_window;
pub mod flow;
pub mod mock;
pub mod overlay_motion;
pub mod parts;
pub mod plugins_step;
pub mod preview;
mod screens;
pub mod setup_code;
mod setup_screen;
pub mod source;
pub mod steer;
pub mod tour;

use std::rc::Rc;
use std::sync::Arc;
use std::time::Instant;

use ardia_state::actions::{NewTab, ProfilePatch};
use ardia_state::model::TabPin;
use ardia_state::omnibox::url::host_of;
use ardia_state::settings::SettingsPatch;
use ardia_state::{Action, BrowserState, Interest, ProfileId, Topics, WindowId};
use ardia_theme::layout::lights;
use ardia_theme::motion::CubicBezier;
use ardia_theme::{ProfileColor, ProfileTheme};
use gpui::{
    AnyElement, App, ClickEvent, Context, FocusHandle, Focusable, FontWeight, IntoElement,
    KeyDownEvent, MouseButton, ParentElement, Render, ScrollEvent, SharedString, Styled, Window,
    div, img, prelude::*,
};
use serde_json::{Map, Value};

use crate::host::{
    OnboardingRecord, OnboardingSystem, OnboardingSystemChoice, UiHost, UtilityWindowKind,
};
use crate::keybindings::{Dismiss, RunCommand, RunReservedCommand};
use crate::look::{Look, UI_FONT};
use crate::ntp::mark_image;
use crate::primitives::theme_bridge::traffic_light_origin;
use crate::scale::px;
use crate::store_link::StoreLink;
use crate::window::backdrop::BackdropDriver;

use flow::{Context as FlowContext, Effect, Flow, QuestionId, Source};
use parts::{
    BAR_HEIGHT, COLUMN, COLUMN_PAD, Click, Ink, PEEK_OPACITY, PREVIEW_BELOW, SECTION_GAP,
    SECTION_SCROLL_MS, TITLE_BAR,
};

pub use flow::Step;

pub const ONBOARDING_SIZE: [f32; 2] = [1360.0, 860.0];

pub const SECTION_EDGE: f32 = 32.0;

pub const LEAVE: std::time::Duration = std::time::Duration::from_millis(400);

pub const SECTION_EASE: CubicBezier = CubicBezier::new(0.5, 1.0, 0.89, 1.0);

pub mod intro {
    pub const ICON: f32 = 96.0;
    pub const INSET: f32 = 28.0;
    pub const ICON_FROM: f32 = 0.6;
    pub const LETTER_RISE: f32 = 14.0;
    pub const TAGLINE_RISE: f32 = 6.0;
    pub const EXIT_SCALE_RISE: f32 = 0.08;
    pub const EXIT_HOLD: f32 = 0.6;
    pub const WORDMARK: &str = "Ardia";
    pub const TAGLINE: &str = "Your new home on the internet";
    pub const LETTER: f32 = 0.52;
    pub const TAGLINE_IN: f32 = 0.6;
    pub const EXIT: f32 = 0.65;
    pub const ICON_AT: f32 = 0.25;
    pub const LETTERS_AT: f32 = 1.15;
    pub const LETTER_STEP: f32 = 0.055;
    pub const SKIP_MS: f32 = 250.0;

    pub fn tagline_at() -> f32 {
        LETTERS_AT + (WORDMARK.len() as f32 - 1.0) * LETTER_STEP + LETTER + 0.15
    }

    pub fn exit_at() -> f32 {
        tagline_at() + TAGLINE_IN + 1.1
    }

    pub fn end() -> f32 {
        exit_at() + EXIT
    }
}

pub(crate) struct LookBaseline {
    profile: ProfileId,
    color: ProfileColor,
    theme: Option<Arc<ProfileTheme>>,
}

pub struct OnboardingWindowView {
    pub(crate) host: Arc<dyn UiHost>,
    pub(crate) state: Arc<BrowserState>,
    pub(crate) look: Look,
    pub(crate) flow: Flow,
    pub(crate) target: Option<WindowId>,
    pub(crate) system: OnboardingSystem,
    pub(crate) tiles: Vec<source::SourceTile>,
    pub(crate) source_motion: source::SourceMotion,
    pub(crate) mock_focus: mock::MockFocus,
    pub(crate) mock: mock::MockWindow,
    pub(crate) director: mock::SceneDirector,
    pub(crate) stage: preview::Stage,
    pub(crate) style_started: Option<Instant>,
    pub(crate) setup_code: Option<setup_screen::SetupCode>,
    pub(crate) leaving: Option<(Instant, bool)>,
    pub(crate) overlay: overlay_motion::OverlayMotion,
    pub(crate) ring_themes: Vec<(u64, ardia_theme::IconTheme)>,
    pub(crate) anon_started: Option<Instant>,
    pub(crate) editor_shown: Option<Instant>,
    pub(crate) theme_stop: usize,
    pub(crate) wants_frame: bool,
    pub(crate) intro_music_started: bool,
    pub(crate) intro_muted: bool,
    pub(crate) importing: Option<Source>,
    pub(crate) intro_started: Instant,
    pub(crate) intro_skipped: Option<Instant>,
    pub(crate) moved: Option<(Instant, f32)>,
    pub(crate) look_baseline: Option<LookBaseline>,
    pub(crate) plugins_step: plugins_step::PluginsStep,
    steer: steer::WheelSteer,
    steer_epoch: Instant,
    scroll_y: crate::window::motion::Motion,
    active_height: std::rc::Rc<std::cell::Cell<f32>>,
    fitted_height: f32,
    placed_section: Option<usize>,
    measure_frames: u8,
    backward_place: bool,
    focus: FocusHandle,
    backdrop: BackdropDriver,
    _store: StoreLink,
    _plugins: crate::host_data::HostLink,
}

impl Focusable for OnboardingWindowView {
    fn focus_handle(&self, _: &App) -> FocusHandle {
        self.focus.clone()
    }
}

impl OnboardingWindowView {
    pub fn new(host: Arc<dyn UiHost>, window: &mut Window, cx: &mut Context<Self>) -> Self {
        let state = host.store().snapshot();
        crate::scale::sync(&state, cx);
        crate::look::note_window_glass(window);
        let look = Look::new(&state, "", window.appearance());
        let store = StoreLink::new(
            host.store(),
            Interest::Topics(Topics::SETTINGS | Topics::PROFILES | Topics::WINDOWS),
            window,
            cx,
            Self::sync,
        );
        let plugins_link = crate::host_data::HostLink::new(
            host.host_signal(),
            crate::host_data::HostTopics::PLUGINS,
            window,
            cx,
            |_, _, _, cx| cx.notify(),
        );
        let target = state.main_window_for(None).cloned();
        let record = host.onboarding_record();
        let flow = match &record {
            Some(saved) if saved.completed => {
                ardia_telemetry::counts::count("onboarding_redo_opened");
                Flow::redo(
                    saved.source.as_deref().and_then(Source::from_key),
                    saved.preset.as_deref().and_then(Source::from_key),
                )
            }
            Some(saved) if saved.step.is_some() => Flow::resume(
                saved.step.as_deref().and_then(Step::from_key),
                saved.source.as_deref().and_then(Source::from_key),
                saved.preset.as_deref().and_then(Source::from_key),
            ),
            _ => Flow::new(),
        };
        let system = host.onboarding_system();
        let mut view = OnboardingWindowView {
            host,
            state,
            look,
            flow,
            target,
            system,
            tiles: source::source_tiles(|path| std::path::Path::new(path).exists()),
            source_motion: source::SourceMotion::default(),
            mock_focus: mock::MockFocus::default(),
            mock: mock::MockWindow::new(),
            director: mock::SceneDirector::new(None),
            stage: preview::Stage::default(),
            style_started: None,
            setup_code: None,
            leaving: None,
            overlay: overlay_motion::OverlayMotion::new(Instant::now()),
            ring_themes: Vec::new(),
            anon_started: None,
            editor_shown: None,
            theme_stop: 0,
            wants_frame: false,
            intro_music_started: false,
            intro_muted: false,
            importing: None,
            intro_started: Instant::now(),
            intro_skipped: None,
            moved: None,
            look_baseline: None,
            plugins_step: plugins_step::PluginsStep::default(),
            steer: steer::WheelSteer::default(),
            steer_epoch: Instant::now(),
            scroll_y: crate::window::motion::Motion::rest(0.0),
            active_height: std::rc::Rc::new(std::cell::Cell::new(0.0)),
            fitted_height: 0.0,
            placed_section: None,
            measure_frames: 3,
            backward_place: false,
            focus: cx.focus_handle(),
            backdrop: BackdropDriver::default(),
            _store: store,
            _plugins: plugins_link,
        };
        if view.flow.step != Step::Intro {
            let flow_cx = view.context();
            view.flow.settle(&flow_cx);
        }
        if !view.flow.redo && record.is_none() {
            view.save_progress();
        }
        view.backdrop.aim(
            view.look.backdrop(crate::window::looks_active(window)),
            false,
            Instant::now(),
        );
        view.backdrop.apply(window, Instant::now());
        view.backdrop
            .place_lights(traffic_light_origin(lights::SETTINGS_CENTER), window);
        window.focus(&view.focus, cx);
        view
    }

    pub fn step(&self) -> Step {
        self.flow.step
    }

    pub fn flow(&self) -> &Flow {
        &self.flow
    }

    pub fn current(&self) -> Option<QuestionId> {
        self.flow.current(&self.context())
    }

    pub(crate) fn context(&self) -> FlowContext {
        let mut cx = FlowContext::of(&self.state, self.target.as_ref().map(WindowId::as_str));
        cx.glass = crate::look::liquid_glass_available();
        cx.plugins_offered = plugins_step::shown(self.host.official_plugins().as_deref());
        cx
    }

    pub(crate) fn focus_handle_of(&self) -> FocusHandle {
        self.focus.clone()
    }

    pub(crate) fn section_key(&self, id: QuestionId) -> String {
        let cx = self.context();
        self.flow
            .sections(&cx)
            .into_iter()
            .find(|(_, _, q)| *q == id)
            .map_or_else(
                || format!("{id:?}"),
                |(step, _, q)| format!("{}.{q:?}", step.key()),
            )
    }

    pub(crate) fn active_question(&self) -> Option<QuestionId> {
        self.flow.current(&self.context())
    }

    pub(crate) fn ink(&self) -> Ink {
        Ink::of(&self.look)
    }

    pub(crate) fn profile(&self) -> ProfileId {
        self.target
            .as_ref()
            .and_then(|id| self.state.window(id.as_str()))
            .map(|w| w.profile_id.clone())
            .unwrap_or_else(|| self.state.last_active_profile())
    }

    fn sync(&mut self, _: Topics, window: &mut Window, cx: &mut Context<Self>) {
        self.state = self.host.store().snapshot();
        crate::scale::sync(&self.state, cx);
        if self.look.refresh(&self.state, "", window.appearance()) {
            self.backdrop.aim(
                self.look.backdrop(crate::window::looks_active(window)),
                true,
                Instant::now(),
            );
        }
        cx.notify();
    }

    fn refresh_state(&mut self) {
        self.state = self.host.store().snapshot();
    }

    pub(crate) fn apply(&mut self, effects: Vec<Effect>) {
        for effect in effects {
            match effect {
                Effect::Settings { values, from_sync } => {
                    self.host.dispatch(Action::UpdateSettings {
                        patch: SettingsPatch(values.into_iter().collect()),
                        from_sync,
                    })
                }
                Effect::WindowLayout(layout) => {
                    if let Some(window) = self.target.clone() {
                        self.host.dispatch(Action::SetTabLayout {
                            window: Some(window),
                            layout,
                        });
                    }
                }
            }
        }
        self.refresh_state();
    }

    fn revert_color(&mut self, touched: bool) {
        if !touched {
            return;
        }
        if let Some(baseline) = self.look_baseline.take() {
            self.host.dispatch(Action::UpdateProfile {
                profile: baseline.profile,
                patch: ProfilePatch {
                    color: Some(baseline.color),
                    theme: Some(baseline.theme),
                    ..ProfilePatch::default()
                },
            });
            self.refresh_state();
        }
    }

    fn save_progress(&self) {
        if self.flow.redo {
            return;
        }
        self.host.save_onboarding(OnboardingRecord {
            completed: false,
            step: Some(self.flow.step.key().to_owned()),
            source: self.flow.source.map(|s| s.key().to_owned()),
            preset: Some(self.flow.preset.key().to_owned()),
        });
    }

    fn moved_from(&mut self, before: usize, cx: &FlowContext) {
        let after = self.flow.section_index(cx);
        if after != before {
            let direction = if after > before { 1.0 } else { -1.0 };
            self.moved = Some((Instant::now(), direction));
            self.entered_section();
        }
    }

    fn entered_section(&mut self) {
        let cx = self.context();
        let live: &[&str] = match self.flow.step {
            Step::Layout => &["tabLayout", "addressBar", "commandBarPlacement"],
            Step::Look => &["appearance", "extendWebsiteColor", "interfaceStyle"],
            _ => &[],
        };
        if live.is_empty() || self.flow.sub != 0 {
            return;
        }
        let values = flow::pick(&self.flow, live, &cx);
        let effects = self.flow.live(values, &cx);
        self.apply(effects);
    }

    pub(crate) fn after_step(
        &mut self,
        before: usize,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let flow_cx = self.context();
        if self.flow.finished {
            self.finish(window, cx);
            return;
        }
        self.moved_from(before, &flow_cx);
        if self.flow.step != Step::Source {
            self.setup_code = None;
        }
        self.save_progress();
        cx.notify();
    }

    pub(crate) fn change(&mut self, patch: Map<String, Value>, live: bool, cx: &mut Context<Self>) {
        if live {
            let flow_cx = self.context();
            let effects = self.flow.live(patch, &flow_cx);
            self.apply(effects);
        } else {
            self.flow.change(patch);
        }
        cx.notify();
    }

    pub(crate) fn preview_color(&mut self, color: ProfileColor, cx: &mut Context<Self>) {
        let profile = self.profile();
        if self.look_baseline.is_none()
            && let Some(current) = self.state.profile(profile.as_str())
        {
            self.look_baseline = Some(LookBaseline {
                profile: profile.clone(),
                color: current.color.preset(),
                theme: current.theme.clone(),
            });
            self.flow.note_color(current.color.preset().key());
        }
        self.host.dispatch(Action::UpdateProfile {
            profile,
            patch: ProfilePatch {
                color: Some(color),
                theme: Some(None),
                ..ProfilePatch::default()
            },
        });
        self.refresh_state();
        cx.notify();
    }

    pub(crate) fn preview_theme(&mut self, theme: Option<ProfileTheme>, cx: &mut Context<Self>) {
        let profile = self.profile();
        if self.look_baseline.is_none()
            && let Some(current) = self.state.profile(profile.as_str())
        {
            self.look_baseline = Some(LookBaseline {
                profile: profile.clone(),
                color: current.color.preset(),
                theme: current.theme.clone(),
            });
            self.flow.note_color(current.color.preset().key());
        }
        self.host.dispatch(Action::UpdateProfile {
            profile,
            patch: ProfilePatch {
                theme: Some(theme.map(Arc::new)),
                ..ProfilePatch::default()
            },
        });
        self.refresh_state();
        cx.notify();
    }

    pub(crate) fn theme_editor_card(&mut self, cx: &mut Context<Self>) -> Option<AnyElement> {
        let profile = self.state.profile(self.profile().as_str())?.clone();
        let original = crate::theme_editor::preset_starting_theme(profile.color.preset().spec().swatch);
        let editing = profile.theme.as_deref().cloned().unwrap_or_else(|| original.clone());
        let started = *self.editor_shown.get_or_insert_with(Instant::now);
        let t = ease_out_cubic((started.elapsed().as_secs_f32() / 0.15).min(1.0));
        let weak = cx.weak_entity();
        let start = original.clone();
        let on_change: crate::theme_editor::Change = Rc::new(move |next, _settle, _window, cx| {
            let kept = (!crate::theme_editor::is_untouched(&next, &start)).then_some(next);
            let _ = weak.update(cx, |this, cx| this.preview_theme(kept, cx));
        });
        let weak = cx.weak_entity();
        let on_select: crate::theme_editor::Pick = Rc::new(move |index, _window, cx| {
            let _ = weak.update(cx, |this, cx| {
                this.theme_stop = index;
                cx.notify();
            });
        });
        let weak = cx.weak_entity();
        let on_reset: Option<crate::theme_editor::Action> = profile.theme.is_some().then(|| {
            Rc::new(move |_: &mut Window, cx: &mut App| {
                let _ = weak.update(cx, |this, cx| this.preview_theme(None, cx));
            }) as crate::theme_editor::Action
        });
        let weak = cx.weak_entity();
        let host = self.host.clone();
        let current = editing.clone();
        let on_texture_menu: crate::theme_editor::Action = Rc::new(move |window, cx| {
            let Some(reply) = host.show_menu(crate::theme_editor::texture_menu_items(current.look.texture)) else {
                return;
            };
            let weak = weak.clone();
            let current = current.clone();
            window
                .spawn(cx, async move |cx| {
                    if let Ok(Some(id)) = reply.await
                        && let Some(texture) = ardia_theme::ThemeTexture::from_key(&id)
                    {
                        let next = crate::theme_editor::with_texture(&current, texture);
                        let _ = weak.update(cx, |this, cx| this.preview_theme(Some(next), cx));
                    }
                })
                .detach();
        });
        if t < 1.0 {
            self.wants_frame = true;
        }
        let ink = self.ink();
        let editor = crate::theme_editor::ThemeEditor {
            id: "onboarding-theme".into(),
            theme: editing,
            start: Some(original),
            selected: self.theme_stop,
            stacked: true,
            p: self.look.p,
            on_change,
            on_select,
            on_reset,
            on_texture_menu,
            native_form: false,
        }
        .render();
        Some(
            parts::card_face(
                div().id("onboarding-theme-card").p(px(ardia_theme::tokens::space::XL)).rounded(px(ardia_theme::tokens::radius::PANEL)).border(px(1.)).border_color(ink.tile_border),
                "onboarding-theme-card-face".into(),
                ardia_theme::tokens::radius::PANEL,
                true,
                false,
                &ink,
            )
            .opacity(t)
            .mt(px((1.0 - t) * 4.0))
            .child(editor)
            .into_any_element(),
        )
    }

    pub(crate) fn confirm(
        &mut self,
        question: QuestionId,
        patch: Map<String, Value>,
        picked: Vec<String>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let flow_cx = self.context();
        let before = self.flow.section_index(&flow_cx);
        if question == QuestionId::Color {
            self.look_baseline = None;
        }
        if question != QuestionId::Outro {
            ardia_telemetry::counts::count("onboarding_steps_completed");
        }
        let effects = self.flow.confirm(question, patch, picked, &flow_cx);
        self.apply(effects);
        self.after_step(before, window, cx);
    }

    pub(crate) fn skip(&mut self, whole_step: bool, window: &mut Window, cx: &mut Context<Self>) {
        ardia_telemetry::counts::count("onboarding_steps_skipped");
        let flow_cx = self.context();
        let before = self.flow.section_index(&flow_cx);
        if self.flow.step == Step::Source {
            let redo_source = if self.flow.redo {
                self.flow.redo_source
            } else {
                None
            };
            self.flow.choose_source(redo_source);
        }
        let (effects, color) = self.flow.skip(whole_step, &flow_cx);
        self.apply(effects);
        self.revert_color(color.is_some());
        self.after_step(before, window, cx);
    }

    pub(crate) fn back(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let flow_cx = self.context();
        let before = self.flow.section_index(&flow_cx);
        self.flow.back(&flow_cx);
        self.after_step(before, window, cx);
    }

    pub(crate) fn go_to_section(
        &mut self,
        index: usize,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let flow_cx = self.context();
        let before = self.flow.section_index(&flow_cx);
        if index == before + 1 {
            self.forward(window, cx);
            if self.flow.section_index(&self.context()) != before {
                ardia_telemetry::counts::count("onboarding_click_moves");
            }
            return;
        }
        if let Some((step, sub, _)) = self.flow.sections(&flow_cx).get(index).copied()
            && index < before
        {
            ardia_telemetry::counts::count("onboarding_click_moves");
            self.flow.go_to(step, sub);
            self.after_step(before, window, cx);
        }
    }

    pub(crate) fn skip_intro(&mut self, cx: &mut Context<Self>) {
        if self.flow.step == Step::Intro && self.intro_skipped.is_none() {
            self.intro_skipped = Some(Instant::now());
            self.host.stop_intro_music(0.35);
            cx.notify();
        }
    }

    pub(crate) fn end_intro(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let flow_cx = self.context();
        let before = self.flow.section_index(&flow_cx);
        self.flow.next(&flow_cx);
        if self.flow.section_index(&flow_cx) == before {
            self.entered_section();
        }
        self.after_step(before, window, cx);
    }

    pub(crate) fn finish_with_tour(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.finish_as(true, window, cx);
    }

    pub(crate) fn finish(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.finish_as(false, window, cx);
    }

    fn finish_as(&mut self, tour: bool, _: &mut Window, cx: &mut Context<Self>) {
        if self.leaving.is_some() {
            return;
        }
        let (effects, color) = self.flow.revert_all();
        self.apply(effects);
        self.revert_color(color.is_some());
        if self.flow.redo {
            ardia_telemetry::counts::count("onboarding_redo_completed");
        }
        let record = if self.flow.redo {
            OnboardingRecord {
                completed: true,
                step: None,
                source: self.flow.source.map(|s| s.key().to_owned()),
                preset: Some(self.flow.source.unwrap_or(Source::Dia).key().to_owned()),
            }
        } else {
            OnboardingRecord {
                completed: true,
                step: Some(self.flow.step.key().to_owned()),
                source: self.flow.source.map(|s| s.key().to_owned()),
                preset: Some(self.flow.preset.key().to_owned()),
            }
        };
        self.host.save_onboarding(record);
        let now = Instant::now();
        self.leaving = Some((now, tour && !self.flow.redo));
        self.overlay.leave(now);
        cx.notify();
    }

    fn dismiss(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let tour = self.leaving.is_some_and(|(_, tour)| tour);
        if tour && let Some(target) = self.target.clone() {
            let keys = crate::keybindings::hint(&self.state, "toggleSidebar");
            tour::start(target, keys, cx);
        } else if self.flow.redo {
            crate::settings::request_pane(crate::settings::rows::Pane::General, cx);
            self.host.open_utility_window(UtilityWindowKind::Settings);
        }
        window.remove_window();
    }

    fn overlay_frame(
        &mut self,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> overlay_motion::OverlayFrame {
        let now = Instant::now();
        self.overlay.show_card(self.flow.step != Step::Intro, now);
        if self.leaving.is_some() && self.overlay.left(now) {
            self.dismiss(window, cx);
        }
        let frame = self.overlay.frame(now);
        if frame.moving {
            window.request_animation_frame();
        }
        frame
    }

    pub(crate) fn cancel(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if !self.flow.redo {
            return;
        }
        ardia_telemetry::counts::count("onboarding_redo_cancelled");
        let (effects, color) = self.flow.revert_all();
        self.apply(effects);
        self.revert_color(color.is_some());
        crate::settings::request_pane(crate::settings::rows::Pane::General, cx);
        self.host.open_utility_window(UtilityWindowKind::Settings);
        window.remove_window();
    }

    pub(crate) fn open_import(&mut self, source: Source, cx: &mut Context<Self>) {
        ardia_telemetry::counts::count("onboarding_imports");
        match source {
            Source::Helium => ardia_telemetry::counts::count("onboarding_helium_imports"),
            Source::Chromium | Source::Vivaldi | Source::Opera => {
                ardia_telemetry::counts::count("onboarding_listed_only_imports")
            }
            _ => {}
        }
        self.importing = Some(source);
        self.host.open_utility_window(UtilityWindowKind::Import);
        cx.notify();
    }

    pub(crate) fn pin_sites(&mut self, ids: &[String]) {
        let Some(window) = self.target.clone() else {
            return;
        };
        let pinned = screens::pinned_hosts(&self.state, &window);
        let profile = self.profile();
        for site in copy::PINNABLE_SITES {
            if ids.iter().any(|id| id == site.id) && !pinned.contains(&host_of(site.url)) {
                self.host.dispatch(Action::NewTab {
                    window: window.clone(),
                    tab: NewTab {
                        url: Some(site.url.to_owned()),
                        profile: Some(profile.clone()),
                        background: true,
                        pin: Some(TabPin::TILE),
                        ..NewTab::default()
                    },
                });
            }
        }
        self.refresh_state();
    }

    pub(crate) fn apply_system(&mut self) -> Vec<String> {
        let extras = &self.flow.extras;
        let set_default = extras.set_default.unwrap_or(true);
        let trial = !self.flow.redo && extras.trial.unwrap_or(false);
        let dock = extras.dock.unwrap_or(true);
        let login = extras.login.unwrap_or(self.system.login_enabled);
        let wants_default = !self.system.is_default && (set_default || trial);
        self.host.apply_onboarding_system(OnboardingSystemChoice {
            set_default: wants_default,
            trial: wants_default && !set_default,
            login,
            dock: dock && self.system.dock_available && !self.system.in_dock,
        });
        if !wants_default {
            Vec::new()
        } else if set_default {
            vec!["Ardia is your default browser".to_owned()]
        } else {
            vec!["A week as your default browser".to_owned()]
        }
    }

    pub(crate) fn listen(
        &self,
        cx: &mut Context<Self>,
        run: impl Fn(&mut Self, &mut Window, &mut Context<Self>) + 'static,
    ) -> Click {
        Box::new(cx.listener(move |this, _: &ClickEvent, window, cx| run(this, window, cx)))
    }

    fn on_run_command(&mut self, action: &RunCommand, window: &mut Window, cx: &mut Context<Self>) {
        self.command(action.id.as_ref(), window, cx);
    }

    fn on_reserved(
        &mut self,
        action: &RunReservedCommand,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.command(action.id.as_ref(), window, cx);
    }

    fn command(&mut self, id: &str, window: &mut Window, cx: &mut Context<Self>) {
        match id {
            "onboarding:next" => self.forward(window, cx),
            "onboarding:back" => self.back(window, cx),
            "onboarding:skip" => self.skip(false, window, cx),
            "onboarding:done" => self.finish(window, cx),
            "std:closeWindow:" | "closeTab" => window.remove_window(),
            _ => {}
        }
    }

    fn on_dismiss(&mut self, _: &Dismiss, _: &mut Window, cx: &mut Context<Self>) {
        self.skip_intro(cx);
    }

    fn on_wheel(&mut self, event: &ScrollEvent, window: &mut Window, cx: &mut Context<Self>) {
        if self.flow.step == Step::Intro {
            return;
        }
        let now_ms = self.steer_epoch.elapsed().as_secs_f64() * 1000.0;
        let phase = |p: gpui::ScrollPhase| match p {
            gpui::ScrollPhase::MayBegin => steer::Phase::MayBegin,
            gpui::ScrollPhase::Began => steer::Phase::Began,
            gpui::ScrollPhase::Changed | gpui::ScrollPhase::Stationary => steer::Phase::Changed,
            gpui::ScrollPhase::Ended => steer::Phase::Ended,
            gpui::ScrollPhase::Cancelled => steer::Phase::Cancelled,
            _ => steer::Phase::None,
        };
        let (dy, precise) = match event.delta {
            gpui::ScrollDelta::Pixels(delta) => (f32::from(delta.y) / crate::scale::current(), true),
            gpui::ScrollDelta::Lines(delta) => (delta.y, false),
        };
        let momentum = event.momentum_phase != gpui::ScrollPhase::None;
        let input = steer::Input {
            dy,
            phase: if momentum { phase(event.momentum_phase) } else { phase(event.gesture_phase) },
            momentum,
            precise,
        };
        let range = self.steer_range(window);
        let at = self.scroll_y.target();
        let now = Instant::now();
        match self.steer.read(input, at, range, now_ms) {
            steer::Action::None => return,
            steer::Action::Place(y) => self.scroll_y.snap(y),
            steer::Action::Ease(y) => self.scroll_y.go(y, std::time::Duration::from_millis(self.steer.tune.notch_ease_ms as u64), crate::window::motion::Curve::EaseOut, now),
            steer::Action::Settle => {
                let kept = at.clamp(range.lo, range.hi);
                self.scroll_y.go(kept, std::time::Duration::from_millis(self.steer.tune.notch_ease_ms as u64), crate::window::motion::Curve::EaseOut, now);
            }
            steer::Action::Move(direction) => {
                self.steer.glide_started(f64::from(SECTION_SCROLL_MS), now_ms);
                self.counted_move("onboarding_wheel_moves", direction > 0, window, cx);
            }
        }
        cx.notify();
    }

    fn counted_move(
        &mut self,
        field: &'static str,
        forward: bool,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let before = self.flow.section_index(&self.context());
        if forward {
            self.key_forward(window, cx);
        } else {
            self.back(window, cx);
        }
        if self.flow.section_index(&self.context()) != before {
            ardia_telemetry::counts::count(field);
        }
    }

    fn on_key(&mut self, event: &KeyDownEvent, window: &mut Window, cx: &mut Context<Self>) {
        let keystroke = &event.keystroke;
        if keystroke.modifiers.platform || keystroke.modifiers.control || keystroke.modifiers.alt {
            return;
        }
        match keystroke.key.as_str() {
            "escape" => self.skip_intro(cx),
            "down" | "pagedown" if self.flow.step != Step::Intro => {
                self.counted_move("onboarding_key_moves", true, window, cx)
            }
            "up" | "pageup" if self.flow.step != Step::Intro => {
                self.counted_move("onboarding_key_moves", false, window, cx)
            }
            _ => return,
        }
        cx.stop_propagation();
    }

    pub(crate) fn intro_done(&self, now: Instant) -> bool {
        match self.intro_skipped {
            Some(at) => now.duration_since(at).as_secs_f32() * 1000.0 >= intro::SKIP_MS,
            None => now.duration_since(self.intro_started).as_secs_f32() >= intro::end(),
        }
    }

    fn intro(&mut self, window: &mut Window, cx: &mut Context<Self>) -> AnyElement {
        let now = Instant::now();
        let elapsed = now.duration_since(self.intro_started).as_secs_f32();
        let skip_fade = self
            .intro_skipped
            .map(|at| now.duration_since(at).as_secs_f32() * 1000.0 / intro::SKIP_MS);
        let exit = match skip_fade {
            Some(fade) => ease_out_cubic(fade.min(1.0)),
            None => ease_in_out_quad(((elapsed - intro::exit_at()) / intro::EXIT).clamp(0.0, 1.0)),
        };
        window.request_animation_frame();
        let ink = self.ink();
        let fade =
            |start: f32, length: f32| ease_out_cubic(((elapsed - start) / length).clamp(0.0, 1.0));
        let icon_t = fade(intro::ICON_AT, 0.45);
        let tagline_t = fade(intro::tagline_at(), intro::TAGLINE_IN);
        let opacity = if skip_fade.is_some() {
            1.0 - exit
        } else {
            let hold = intro::EXIT_HOLD;
            if exit <= hold {
                1.0
            } else {
                1.0 - (exit - hold) / (1.0 - hold)
            }
        };
        let scale = 1.0 + intro::EXIT_SCALE_RISE * exit;
        let icon_side =
            intro::ICON * (intro::ICON_FROM + (1.0 - intro::ICON_FROM) * icon_t) * scale;
        if !self.intro_music_started {
            self.intro_music_started = true;
            self.intro_muted = self.host.intro_music_muted();
            self.host.play_intro_music(self.intro_muted);
        }
        let muted = self.intro_muted;
        let mute = self.listen(cx, move |this, _, cx| {
            this.intro_muted = !muted;
            this.host.set_intro_music_muted(!muted);
            this.host.save_intro_music_muted(!muted);
            cx.notify();
        });
        let mute_label = if muted { "Unmute intro music" } else { "Mute intro music" };
        let mute_button = div()
            .id("onboarding-intro-mute")
            .debug_selector(|| "onboarding-intro-mute".into())
            .size(px(parts::BUTTON_HEIGHT))
            .rounded_full()
            .relative()
            .flex()
            .items_center()
            .justify_center()
            .cursor_pointer()
            .when(ink.glass, |this| this.child(parts::glass_fill(parts::BUTTON_HEIGHT / 2., None)))
            .when(!ink.glass, |this| this.border(px(1.)).border_color(ink.no_thanks_border))
            .hover(move |s| s.bg(ink.outlined_hover))
            .tooltip(crate::primitives::controls::tooltip(mute_label.into(), &self.look.p))
            .on_click(mute)
            .child(crate::icon_picker::symbols::symbol(
                self.host.as_ref(),
                if muted { "speaker.slash.fill" } else { "speaker.wave.3.fill" },
                13.,
                20.,
                crate::icon_picker::symbols::SymbolWeight::Medium,
                ink.no_thanks_text,
            ));
        let skip = self.listen(cx, |this, _, cx| this.skip_intro(cx));
        div()
            .id("onboarding-intro")
            .debug_selector(|| "onboarding-intro".into())
            .absolute()
            .inset_0()
            .bg(if ink.dark {
                gpui::black()
            } else {
                gpui::white()
            })
            .opacity(opacity)
            .flex()
            .flex_col()
            .items_center()
            .justify_center()
            .gap(px(16. * scale))
            .child(
                div()
                    .size(px(intro::ICON * scale))
                    .flex()
                    .items_center()
                    .justify_center()
                    .opacity((icon_t / 0.4).min(1.0))
                    .child(img(mark_image()).size(px(icon_side))),
            )
            .child(
                div()
                    .flex()
                    .flex_row()
                    .children(intro::WORDMARK.chars().enumerate().map(|(i, ch)| {
                        let t = fade(
                            intro::LETTERS_AT + i as f32 * intro::LETTER_STEP,
                            intro::LETTER,
                        );
                        div()
                            .mt(px(intro::LETTER_RISE * (1.0 - t)))
                            .opacity(t)
                            .text_size(px(64. * scale))
                            .font_weight(FontWeight::EXTRA_LIGHT)
                            .text_color(ink.title)
                            .child(SharedString::from(ch.to_string()))
                    })),
            )
            .child(
                div()
                    .mt(px(intro::TAGLINE_RISE * (1.0 - tagline_t)))
                    .opacity(tagline_t)
                    .text_size(px(17. * scale))
                    .font_weight(FontWeight::LIGHT)
                    .text_color(ink.subtitle)
                    .child(intro::TAGLINE),
            )
            .child(
                div()
                    .absolute()
                    .left(px(intro::INSET))
                    .bottom(px(intro::INSET))
                    .child(mute_button),
            )
            .child(
                div()
                    .absolute()
                    .right(px(intro::INSET))
                    .bottom(px(intro::INSET))
                    .child(parts::secondary_button(
                        "onboarding-intro-skip",
                        "Skip",
                        false,
                        &ink,
                        skip,
                    )),
            )
            .into_any_element()
    }

    fn viewport_height(window: &Window) -> f32 {
        (f32::from(window.viewport_size().height) / crate::scale::current() - TITLE_BAR - BAR_HEIGHT).max(1.0)
    }

    fn section_fit(&self, window: &Window) -> steer::Fit {
        steer::fit(self.active_height.get(), Self::viewport_height(window), SECTION_EDGE)
    }

    fn steer_range(&self, window: &Window) -> steer::Range {
        let fit = self.section_fit(window);
        let flow_cx = self.context();
        let sections = self.flow.sections(&flow_cx);
        let active = self.flow.section_index(&flow_cx);
        steer::Range {
            lo: fit.lo,
            hi: fit.hi,
            forward: active + 1 < sections.len(),
            back: active > 0,
        }
    }

    fn section_stack(&mut self, window: &mut Window, cx: &mut Context<Self>) -> AnyElement {
        let now = Instant::now();
        let flow_cx = self.context();
        let sections = self.flow.sections(&flow_cx);
        let active = self.flow.section_index(&flow_cx);
        let viewport = Self::viewport_height(window);
        let fit = self.section_fit(window);
        if self.placed_section != Some(active) {
            let backward = self.placed_section.is_some_and(|placed| placed > active);
            self.placed_section = Some(active);
            self.scroll_y.snap(if backward { fit.hi } else { fit.lo });
            self.fitted_height = 0.0;
            self.measure_frames = 3;
            self.backward_place = backward;
        } else if (self.fitted_height - self.active_height.get()).abs() > 0.5 {
            let first = self.fitted_height <= 0.0;
            self.fitted_height = self.active_height.get();
            let kept = if first {
                if self.backward_place { fit.hi } else { fit.lo }
            } else {
                self.scroll_y.target().clamp(fit.lo, fit.hi)
            };
            self.scroll_y.snap(kept);
            self.measure_frames = 3;
        }
        if self.measure_frames > 0 {
            self.measure_frames -= 1;
            window.request_animation_frame();
        }
        let glide = self.moved.map(|(at, direction)| {
            let t = (now.duration_since(at).as_secs_f32() * 1000.0 / SECTION_SCROLL_MS).min(1.0);
            (SECTION_EASE.ease(t as f64) as f32, direction)
        });
        if glide.is_some_and(|(t, _)| t < 1.0) || self.scroll_y.running(now) {
            window.request_animation_frame();
        }
        if glide.is_some_and(|(t, _)| t >= 1.0) {
            self.moved = None;
        }
        let (t, direction) = glide.unwrap_or((1.0, 0.0));
        let shift = (1.0 - t) * direction * SECTION_GAP;
        let active_top = -self.scroll_y.value(now) + shift;
        let active_height = self.active_height.get();
        let peek = |this: &mut Self, index: usize, cx: &mut Context<Self>| -> Option<AnyElement> {
            let (_, _, id) = *sections.get(index)?;
            let body = this.section(id, cx);
            let reachable = index == active + 1 || index < active;
            let go = this.listen(cx, move |this, window, cx| this.go_to_section(index, window, cx));
            Some(
                div()
                    .id(SharedString::from(format!("onboarding-peek-{index}")))
                    .relative()
                    .opacity(PEEK_OPACITY)
                    .child(body)
                    .child(
                        div()
                            .id(SharedString::from(format!("onboarding-peek-cover-{index}")))
                            .absolute()
                            .inset_0()
                            .occlude()
                            .when(reachable, |this| this.cursor_pointer().on_click(go)),
                    )
                    .into_any_element(),
            )
        };
        let before = active.checked_sub(1).and_then(|i| peek(self, i, cx));
        let after = peek(self, active + 1, cx);
        let current = sections.get(active).copied().map(|(_, _, id)| self.section(id, cx));
        let active_opacity = PEEK_OPACITY + (1.0 - PEEK_OPACITY) * t;
        let measured = self.active_height.clone();
        let probe = gpui::canvas(
            move |bounds, _, _| {
                measured.set(f32::from(bounds.size.height) / crate::scale::current());
            },
            |_, _, _, _| {},
        )
        .absolute()
        .inset_0();
        div()
            .id("onboarding-sections")
            .relative()
            .flex_1()
            .min_h_0()
            .overflow_hidden()
            .children(before.map(|before| {
                div()
                    .absolute()
                    .left(px(COLUMN_PAD))
                    .right(px(COLUMN_PAD))
                    .bottom(px(viewport - (active_top - SECTION_GAP)))
                    .child(before)
            }))
            .child(
                div()
                    .absolute()
                    .left(px(COLUMN_PAD))
                    .right(px(COLUMN_PAD))
                    .top(px(active_top))
                    .opacity(active_opacity)
                    .debug_selector(|| "onboarding-active".into())
                    .child(probe)
                    .children(current),
            )
            .children(after.map(|after| {
                div()
                    .absolute()
                    .left(px(COLUMN_PAD))
                    .right(px(COLUMN_PAD))
                    .top(px(active_top + active_height + SECTION_GAP))
                    .child(after)
            }))
            .into_any_element()
    }

    fn header(&self, cx: &mut Context<Self>) -> AnyElement {
        let ink = self.ink();
        let cancel = self.listen(cx, |this, window, cx| this.cancel(window, cx));
        div()
            .h(px(TITLE_BAR))
            .flex_none()
            .px(px(COLUMN_PAD))
            .flex()
            .flex_row()
            .items_center()
            .justify_end()
            .on_mouse_down(MouseButton::Left, |_, window, _| window.start_window_move())
            .when(self.flow.redo, |this| {
                this.child(
                    div()
                        .id("onboarding-cancel")
                        .cursor_pointer()
                        .text_size(px(13.))
                        .text_color(ink.subtitle)
                        .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
                        .on_click(cancel)
                        .child("Cancel"),
                )
            })
            .into_any_element()
    }
}

pub fn ease_out_cubic(t: f32) -> f32 {
    1.0 - (1.0 - t).powi(3)
}

pub fn ease_in_out_quad(t: f32) -> f32 {
    if t < 0.5 {
        2.0 * t * t
    } else {
        1.0 - (-2.0 * t + 2.0).powi(2) / 2.0
    }
}

impl Render for OnboardingWindowView {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let started = std::time::Instant::now();
        crate::profiled::profiled_root(
            ardia_profile::FrameSlot::Onboarding,
            started,
            self.render_root(window, cx),
        )
    }
}

impl OnboardingWindowView {
    fn render_root(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement + use<> {
        self.backdrop.fit(&self.look, window);
        if self.backdrop.apply(window, Instant::now()) {
            window.request_animation_frame();
        }
        let ink = self.ink();
        let overlay = self.overlay_frame(window, cx);
        let fade = (overlay.presence < 1.0).then_some(overlay.presence);
        let width = f32::from(window.viewport_size().width) / crate::scale::current();
        let show_preview = width >= PREVIEW_BELOW;
        let root = div()
            .when_some(fade, |this, fade| this.opacity(fade))
            .id("onboarding-window")
            .key_context("ArdiaWindow OnboardingWindow")
            .track_focus(&self.focus)
            .size_full()
            .relative()
            .font_family(UI_FONT)
            .text_color(ink.title)
            .on_action(cx.listener(Self::on_run_command))
            .on_action(cx.listener(Self::on_reserved))
            .on_action(cx.listener(Self::on_dismiss))
            .on_key_down(cx.listener(Self::on_key))
            .on_scroll(cx.listener(Self::on_wheel));
        if self.flow.step == Step::Intro && self.intro_done(Instant::now()) {
            self.end_intro(window, cx);
        }
        if self.flow.step == Step::Intro {
            let intro = self.intro(window, cx);
            return root
                .child(
                    div()
                        .absolute()
                        .top_0()
                        .left_0()
                        .right_0()
                        .h(px(TITLE_BAR))
                        .on_mouse_down(MouseButton::Left, |_, window, _| {
                            window.start_window_move()
                        }),
                )
                .child(intro);
        }
        let active_key = self.active_question().map(|id| self.section_key(id));
        self.mock_focus.show(active_key);
        let header = self.header(cx);
        let stack = self.section_stack(window, cx);
        if std::mem::take(&mut self.wants_frame) {
            window.request_animation_frame();
        }
        let actions = self.actions(cx);
        let plugin_consent = self.plugins_consent(window, cx);
        let preview = show_preview.then(|| self.preview_stage(window, cx));
        let card = div()
            .id("onboarding-card")
            .debug_selector(|| "onboarding-card".into())
            .absolute()
            .left_0()
            .right_0()
            .top(px(overlay.card_rise))
            .h_full()
            .when(overlay.card_opacity < 1.0, |this| {
                this.opacity(overlay.card_opacity)
            })
            .when((overlay.card_scale - 1.0).abs() > 1e-5, |this| {
                this.scale(overlay.card_scale)
            })
            .flex()
            .flex_row()
            .when(!show_preview, |this| this.justify_center())
            .child(
                div()
                    .w(px(COLUMN.min(width)))
                    .flex_none()
                    .h_full()
                    .flex()
                    .flex_col()
                    .child(header)
                    .child(stack)
                    .child(
                        div()
                            .h(px(BAR_HEIGHT))
                            .flex_none()
                            .px(px(COLUMN_PAD))
                            .flex()
                            .flex_row()
                            .items_center()
                            .gap(px(ardia_theme::tokens::space::ML))
                            .debug_selector(|| "onboarding-actions".into())
                            .children(actions),
                    ),
            )
            .children(preview);
        root.child(card).children(plugin_consent)
    }
}

#[cfg(test)]
mod tests;
