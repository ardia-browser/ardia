use std::time::{Duration, Instant};

use crate::window::motion::{Curve, Motion};

use ardia_theme::tokens::{radius, space};
use gpui::{
    AnyElement, Context, FontWeight, IntoElement, ParentElement, Styled, Window, div, img,
    prelude::*,
};

use super::OnboardingWindowView;
use super::copy;
use super::flow::QuestionId;
use super::parts::{self, MOCK_ASPECT, MOCK_MAX_WIDTH, PANE_MARGIN, PANE_PAD};
use super::screens::site_logo;
use crate::ntp::mark_image;
use crate::primitives::controls::shadow;
use crate::primitives::icons::{Icon, icon};
use crate::primitives::theme_bridge::hsla;
use crate::scale::px;

const TRAFFIC_LIGHTS: [u32; 3] = [0xFF5F57, 0xFEBC2E, 0x28C840];

fn light(color: u32, side: f32) -> AnyElement {
    div()
        .size(px(side))
        .rounded_full()
        .bg(hsla(ardia_theme::RgbaColor::hex(color)))
        .into_any_element()
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Overlay {
    Source,
    SetupBrings,
    SetupApplied,
    Style,
    Crash,
    Pins,
    Default,
    Plugins,
    Outro,
}

impl Overlay {
    pub fn of(question: Option<QuestionId>) -> Option<Overlay> {
        Some(match question? {
            QuestionId::Source => Overlay::Source,
            QuestionId::Style => Overlay::Style,
            QuestionId::Crash => Overlay::Crash,
            QuestionId::Pins => Overlay::Pins,
            QuestionId::Default => Overlay::Default,
            QuestionId::Plugins => Overlay::Plugins,
            QuestionId::Outro => Overlay::Outro,
            _ => return None,
        })
    }
}

pub const LAYER_RISE: f32 = 0.98;
pub const PREVIEW_SWAP: Duration = Duration::from_millis(400);

#[derive(Clone, Debug)]
pub struct Stage {
    mock_shown: Motion,
    layers: Vec<(Overlay, bool, Motion)>,
    placed: bool,
}

impl Default for Stage {
    fn default() -> Self {
        Stage {
            mock_shown: Motion::rest(1.0),
            layers: Vec::new(),
            placed: false,
        }
    }
}

impl Stage {
    pub fn aim(&mut self, overlay: Option<Overlay>, now: Instant) -> bool {
        let first = !self.placed;
        self.placed = true;
        let mock = if overlay.is_some() { 0.0 } else { 1.0 };
        if first {
            self.mock_shown.snap(mock);
        } else if (self.mock_shown.target() - mock).abs() > f32::EPSILON {
            self.mock_shown.go(mock, PREVIEW_SWAP, Curve::EaseOut, now);
        }
        for (key, live, motion) in &mut self.layers {
            let should = Some(*key) == overlay;
            if *live != should {
                *live = should;
                motion.go(
                    if should { 1.0 } else { 0.0 },
                    PREVIEW_SWAP,
                    Curve::EaseOut,
                    now,
                );
            }
        }
        if let Some(key) = overlay
            && !self.layers.iter().any(|(k, _, _)| *k == key)
        {
            let mut motion = Motion::rest(if first { 1.0 } else { 0.0 });
            if !first {
                motion.go(1.0, PREVIEW_SWAP, Curve::EaseOut, now);
            }
            self.layers.push((key, true, motion));
        }
        self.layers
            .retain(|(_, live, motion)| *live || motion.running(now) || motion.value(now) > 0.0);
        self.mock_shown.running(now) || self.layers.iter().any(|(_, _, m)| m.running(now))
    }
}

impl OnboardingWindowView {
    pub(crate) fn mock_inputs_settings(&self) -> ardia_state::settings::Settings {
        let fcx = self.context();
        let mut settings = (*self.state.settings).clone();
        let _ = settings.set("tabLayout", &self.flow.resolve("tabLayout", &fcx));
        for step in super::flow::Step::ALL {
            for question in super::flow::all_questions(step) {
                for key in question.keys {
                    let value = self.flow.resolve(key, &fcx);
                    if !value.is_null() || *key == "cleanUpInactiveTabsAfterMinutes" {
                        let _ = settings.set(key, &value);
                    }
                }
            }
        }
        settings
    }

    fn overlay_body(
        &mut self,
        overlay: Overlay,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        match overlay {
            Overlay::Source => self.source_preview(window, cx),
            Overlay::SetupBrings | Overlay::SetupApplied => self
                .setup_code_preview()
                .unwrap_or_else(|| div().into_any_element()),
            Overlay::Style => self.style_preview(window),
            Overlay::Crash => self.anon_card(window),
            Overlay::Pins => self.pinned_preview(),
            Overlay::Default => self.system_preview(),
            Overlay::Plugins => self.terminal_preview(),
            Overlay::Outro => self.postcard(),
        }
    }

    pub(crate) fn preview_stage(
        &mut self,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let now = Instant::now();
        let ink = self.ink();
        let current = self.active_question();
        let overlay = match (current, &self.setup_code) {
            (Some(QuestionId::Source), Some(super::setup_screen::SetupCode::Entering { .. })) => {
                Some(Overlay::SetupBrings)
            }
            (Some(QuestionId::Source), Some(super::setup_screen::SetupCode::Applied(_))) => {
                Some(Overlay::SetupApplied)
            }
            _ => Overlay::of(current),
        };
        let mut running = self.stage.aim(overlay, now);
        let size = window.viewport_size();
        let stage_w =
            (f32::from(size.width) / crate::scale::current() - parts::COLUMN - PANE_MARGIN)
                .max(0.0);
        let stage_h =
            (f32::from(size.height) / crate::scale::current() - PANE_MARGIN * 2.0).max(0.0);
        let room_w = stage_w - PANE_PAD * 2.0;
        let room_h = stage_h - PANE_PAD * 2.0;
        let width = MOCK_MAX_WIDTH
            .min(room_w)
            .min(room_h * MOCK_ASPECT)
            .max(0.0);
        let covered = overlay.is_some();
        let settings = self.mock_inputs_settings();
        let group = format!("{}.{}", self.flow.step.key(), self.flow.sub);
        let want = if covered {
            None
        } else {
            self.mock_focus.current()
        };
        let (shown, scene, waiting) = self.director.update(
            want,
            &settings,
            &group,
            parts::SECTION_SCROLL_MS as u64,
            now,
        );
        running |= waiting;
        let profile = self.state.profile(self.profile().as_str()).cloned();
        let accent = profile
            .as_ref()
            .map_or(ardia_theme::ProfileColor::Plum.spec().swatch, |p| {
                ardia_theme::profile_accent(p.look())
            });
        let inputs = super::mock::MockInputs {
            settings: &shown,
            accent,
            custom: profile.as_ref().and_then(|p| p.theme.clone()),
            system_dark: crate::look::system_dark(window.appearance()),
        };
        let host = self.host.clone();
        let (mock, mock_running) = self.mock.render(
            host.as_ref(),
            &inputs,
            scene,
            width,
            width / MOCK_ASPECT,
            now,
        );
        running |= mock_running;
        let mock_opacity = self.stage.mock_shown.value(now);
        #[expect(
            clippy::needless_collect,
            reason = "the collect ends the borrow of self before the &mut self and cx calls below"
        )]
        let layers: Vec<(Overlay, bool, f32)> = self
            .stage
            .layers
            .iter()
            .map(|(k, live, m)| (*k, *live, m.value(now)))
            .collect();
        let overlays: Vec<AnyElement> = layers
            .into_iter()
            .map(|(key, live, t)| {
                let body = self.overlay_body(key, window, cx);
                let scale = LAYER_RISE + (1.0 - LAYER_RISE) * t;
                div()
                    .absolute()
                    .inset_0()
                    .p(px(PANE_PAD))
                    .opacity(t)
                    .scale(scale)
                    .when(!live, |this| this.occlude())
                    .flex()
                    .items_center()
                    .justify_center()
                    .child(body)
                    .into_any_element()
            })
            .collect();
        if running {
            window.request_animation_frame();
        }
        div()
            .id("onboarding-stage")
            .debug_selector(|| "onboarding-stage".into())
            .relative()
            .flex_1()
            .m(px(PANE_MARGIN))
            .ml_0()
            .rounded(px(radius::SHEET))
            .bg(ink.stage)
            .border(px(1.))
            .border_color(ink.tile_border)
            .shadow(vec![shadow(ink.pane_shadow, 10., 24.)])
            .child(
                div()
                    .absolute()
                    .inset_0()
                    .rounded(px(radius::SHEET))
                    .overflow_hidden()
                    .child(
                        div()
                            .absolute()
                            .inset_0()
                            .opacity(mock_opacity)
                            .flex()
                            .items_center()
                            .justify_center()
                            .child(mock),
                    )
                    .children(overlays),
            )
            .into_any_element()
    }

    fn pinned_preview(&self) -> AnyElement {
        let ink = self.ink();
        let scale = 0.75;
        let selected = self.chosen_pins();
        let sites: Vec<&copy::PinnableSite> = copy::PINNABLE_SITES
            .iter()
            .filter(|s| selected.iter().any(|id| id == s.id))
            .collect();
        let rows = sites.len().div_ceil(3).max(2);
        let dark = self.look.dark;
        div()
            .w(px(236.))
            .p(px(space::XL))
            .rounded(px(radius::SHEET))
            .bg(ink.row)
            .border(px(1.))
            .border_color(ink.tile_border)
            .flex()
            .flex_col()
            .gap(px(space::L))
            .child(
                div()
                    .flex()
                    .flex_row()
                    .gap(px(space::M * scale))
                    .children(TRAFFIC_LIGHTS.map(|c| light(c, 12. * scale))),
            )
            .child(
                div()
                    .flex()
                    .flex_col()
                    .gap(px(space::S))
                    .children((0..rows).map(|row| {
                        div()
                            .flex()
                            .flex_row()
                            .gap(px(space::S))
                            .children((0..3).map(|column| {
                                let index = row * 3 + column;
                                let cell = div()
                                    .flex_1()
                                    .h(px(40.))
                                    .rounded(px(radius::CHROME * scale))
                                    .flex()
                                    .items_center()
                                    .justify_center();
                                match sites.get(index) {
                                    Some(site) => cell
                                        .bg(ink.button)
                                        .child(site_logo(site.url, 18., dark, &ink)),
                                    None => cell
                                        .border(px(1.))
                                        .border_dashed()
                                        .border_color(ink.tile_border),
                                }
                            }))
                    })),
            )
            .child(div().h(px(1.)).bg(ink.separator))
            .children([0.7f32, 0.5, 0.6].map(|share| {
                div()
                    .h(px(22.))
                    .flex()
                    .flex_row()
                    .items_center()
                    .gap(px(space::M))
                    .child(
                        div()
                            .size(px(12.))
                            .rounded(px(radius::HAIR))
                            .bg(ink.progress_track),
                    )
                    .child(
                        div()
                            .h(px(6.))
                            .w(gpui::relative(share))
                            .rounded(px(3.))
                            .bg(ink.progress_track),
                    )
            }))
            .into_any_element()
    }

    fn system_preview(&self) -> AnyElement {
        let ink = self.ink();
        let extras = &self.flow.extras;
        let system = self.system;
        let set_default = extras.set_default.unwrap_or(true);
        let trial = !self.flow.redo && extras.trial.unwrap_or(false);
        let default_on = system.is_default || set_default;
        let dock = system.in_dock || (extras.dock.unwrap_or(true) && system.dock_available);
        let login = extras.login.unwrap_or(system.login_enabled);
        let chip = |on: bool, glyph: Icon, label: &'static str| {
            div()
                .h(px(34.))
                .pl(px(space::L))
                .pr(px(space::ML))
                .rounded(px(17.))
                .bg(ink.tile)
                .border(px(1.))
                .border_color(ink.tile_border)
                .flex()
                .flex_row()
                .items_center()
                .gap(px(space::M))
                .opacity(if on { 1.0 } else { 0.45 })
                .child(icon(glyph, 13., ink.title))
                .child(
                    div()
                        .text_size(px(12.))
                        .font_weight(FontWeight::MEDIUM)
                        .text_color(ink.title)
                        .child(label),
                )
                .child(parts::check_ring(on, true, &ink))
        };
        div()
            .flex()
            .flex_col()
            .items_center()
            .gap(px(space::XXXL))
            .child(img(super::source::app_icon()).size(px(132.)))
            .child(
                div()
                    .flex()
                    .flex_col()
                    .items_center()
                    .gap(px(space::M))
                    .child(chip(
                        default_on || (!default_on && trial),
                        Icon::Globe,
                        "Default browser",
                    ))
                    .child(chip(dock, Icon::Window, "In your Dock"))
                    .child(chip(login, Icon::Plug, "Opens at login")),
            )
            .into_any_element()
    }

    fn postcard(&self) -> AnyElement {
        let ink = self.ink();
        let lines: Vec<String> = self.flow.picked_lines().into_iter().take(8).collect();
        let left = div()
            .flex_1()
            .min_w_0()
            .pr(px(space::XL))
            .flex()
            .flex_col()
            .gap(px(space::ML))
            .child(
                div()
                    .text_size(px(22.))
                    .font_weight(FontWeight::LIGHT)
                    .italic()
                    .text_color(ink.title)
                    .child("Hello!"),
            )
            .child(if lines.is_empty() {
                div()
                    .text_size(px(12.))
                    .line_height(px(17.))
                    .text_color(ink.subtitle)
                    .child("Glad you're here. Make yourself at home. Your tabs, bookmarks and pins are ready.")
                    .into_any_element()
            } else {
                div()
                    .flex()
                    .flex_col()
                    .gap(px(space::XS))
                    .child(div().text_size(px(11.)).text_color(ink.subtitle).child("You picked:"))
                    .children(lines.into_iter().map(|line| {
                        div()
                            .flex()
                            .flex_row()
                            .gap(px(space::S))
                            .child(div().pt(px(3.)).child(icon(Icon::Check, 8., ink.title)))
                            .child(div().flex_1().text_size(px(11.)).line_height(px(14.)).text_color(ink.title).child(line))
                    }))
                    .into_any_element()
            });
        let stamp = div()
            .w(px(56.))
            .h(px(66.))
            .border(px(1.))
            .border_color(ink.row_border)
            .flex()
            .flex_col()
            .items_center()
            .justify_center()
            .gap(px(space::XS))
            .child(img(mark_image()).size(px(28.)))
            .child(
                div()
                    .text_size(px(8.))
                    .font_weight(FontWeight::BOLD)
                    .text_color(ink.progress_track)
                    .child("WELCOME"),
            );
        div()
            .w(px(340.))
            .min_h(px(210.))
            .rotate(gpui::radians(POSTCARD_TURN.to_radians()))
            .p(px(space::XL))
            .bg(ink.card)
            .border(px(1.))
            .border_color(ink.row_border)
            .flex()
            .flex_row()
            .child(left)
            .child(div().flex_none().w(px(1.)).bg(ink.separator))
            .child(
                div()
                    .flex_none()
                    .w(px(96.))
                    .pl(px(space::XL))
                    .flex()
                    .flex_col()
                    .justify_between()
                    .items_end()
                    .child(stamp)
                    .child(
                        div()
                            .w_full()
                            .flex()
                            .flex_col()
                            .gap(px(space::L))
                            .children((0..3).map(|_| div().h(px(1.)).bg(ink.separator))),
                    ),
            )
            .into_any_element()
    }
}

pub fn terminal_lines(command: Option<&str>, version: Option<&str>) -> Vec<String> {
    match command {
        Some(command) => vec![
            format!("$ {command} --version"),
            match version {
                Some(version) => format!("{command} {version}"),
                None => command.to_owned(),
            },
            format!("$ {command} tabs"),
        ],
        None => vec!["$ ardia tabs".to_owned()],
    }
}

pub const POSTCARD_TURN: f32 = -3.0;
pub const STYLE_STAGE_W: f32 = 420.0;
pub const STYLE_STAGE_H: f32 = 380.0;
const STYLE_PAD: f32 = 22.0;
const STYLE_TILES_TOP: f32 = 50.0;
const STYLE_TILES_H: f32 = 84.0;
const STYLE_TILES_GAP: f32 = 14.0;
const STYLE_TILES_RADIUS: f32 = 18.0;
const STYLE_TILES_ICON: f32 = 30.0;
const STYLE_FIELD_TOP: f32 = 156.0;
const STYLE_FIELD_H: f32 = 52.0;
const STYLE_FIELD_RADIUS: f32 = 16.0;
const STYLE_BUTTONS_TOP: f32 = 232.0;
const STYLE_BUTTON: f32 = 50.0;
const STYLE_BUTTON_GAP: f32 = 12.0;
const STYLE_SUN: f32 = 72.0;
const STYLE_SUN_FROM: f32 = -90.0;
const STYLE_SUN_TO: f32 = STYLE_STAGE_W + 18.0;
const STYLE_SUN_LEG_MS: f32 = 6500.0;
const STYLE_SEA_H: f32 = 62.0;
const STYLE_SKY_BANDS: usize = 12;
const STYLE_GLINTS: [(f32, f32, f32); 3] = [
    (40.0, 18.0, 90.0),
    (190.0, 34.0, 140.0),
    (300.0, 12.0, 70.0),
];

pub fn sun_travel(elapsed_ms: f32) -> f32 {
    let leg = (elapsed_ms / STYLE_SUN_LEG_MS).rem_euclid(2.0);
    let pulse = |t: f32| -(std::f32::consts::PI * t).cos() / 2.0 + 0.5;
    if leg < 1.0 {
        pulse(leg)
    } else {
        1.0 - pulse(leg - 1.0)
    }
}

impl OnboardingWindowView {
    fn style_preview(&mut self, window: &mut Window) -> AnyElement {
        use ardia_theme::RgbaColor;
        let fcx = self.context();
        let style = self.flow.resolve_str("interfaceStyle", &fcx);
        let hovered = match self.mock_focus.current() {
            Some(super::mock::PreviewId::StyleGlass) => Some("glass"),
            Some(super::mock::PreviewId::StyleClassic) => Some("classic"),
            _ => None,
        };
        let glass =
            crate::look::liquid_glass_available() && hovered.unwrap_or(style.as_str()) == "glass";
        let tinted = self.flow.resolve_bool("glassTintWithTheme", &fcx);
        let tint = if tinted {
            self.flow
                .resolve_f64("glassTintAmount", &fcx)
                .unwrap_or(0.8) as f32
        } else {
            0.0
        };
        let dark = match self.flow.resolve_str("appearance", &fcx).as_str() {
            "dark" => true,
            "light" => false,
            _ => crate::look::system_dark(window.appearance()),
        };
        let profile = self.state.profile(self.profile().as_str()).cloned();
        let accent = profile
            .as_ref()
            .map_or(ardia_theme::ProfileColor::Plum.spec().swatch, |p| {
                ardia_theme::profile_accent(p.look())
            });
        let look = super::mock::MockLook::new(dark, accent);
        let started = *self.style_started.get_or_insert_with(Instant::now);
        window.request_animation_frame();
        let travel = sun_travel(started.elapsed().as_secs_f32() * 1000.0);
        let ink = if dark {
            (
                [0x0F1A2C, 0x34506E],
                0xFFB03B,
                0x2F8C78,
                0x1D5E50,
                0x2468B4,
                0x7FB4F0,
            )
        } else {
            (
                [0x6EC1F2, 0xF7CDB2],
                0xFFB627,
                0x5DBF8C,
                0x2C9867,
                0x2F95DB,
                0xBDE6FF,
            )
        };
        let col = |hex: u32| hsla(RgbaColor::hex(hex));
        let sky_top = RgbaColor::hex(ink.0[0]);
        let sky_bottom = RgbaColor::hex(ink.0[1]);
        let t = look.t;
        let face = |radius: f32, child: AnyElement| -> AnyElement {
            let base = div()
                .absolute()
                .inset_0()
                .rounded(px(radius))
                .flex()
                .flex_row()
                .items_center()
                .justify_center()
                .gap(px(space::S));
            if glass {
                let fill = crate::primitives::glass::control_glass_tint_of(
                    t.pinned_resting,
                    t.accent,
                    crate::primitives::glass::GlassState::Rest,
                    tint,
                );
                base.child(crate::primitives::glass::surface_glass(
                    fill.with_alpha(fill.a * crate::primitives::glass::CONTROL_GLASS_STRENGTH),
                    dark,
                    radius,
                ))
                .child(child)
                .into_any_element()
            } else {
                base.bg(hsla(look.card))
                    .child(
                        div()
                            .absolute()
                            .inset_0()
                            .rounded(px(radius))
                            .border(px(0.5))
                            .border_color(hsla(t.pinned_resting_stroke))
                            .bg(hsla(t.pinned_resting)),
                    )
                    .child(child)
                    .into_any_element()
            }
        };
        let host = self.host.clone();
        let sym = |name: &str, size: f32, boxed: f32| {
            crate::icon_picker::symbols::symbol(
                host.as_ref(),
                name,
                size,
                boxed,
                crate::icon_picker::symbols::SymbolWeight::Semibold,
                hsla(t.text_primary),
            )
        };
        let tile_w = (STYLE_STAGE_W - STYLE_PAD * 2.0 - STYLE_TILES_GAP * 2.0) / 3.0;
        let fav = |i: usize, size: f32| {
            let tb = super::mock::tab(i);
            div()
                .size(px(size))
                .rounded(px(size * 0.25))
                .bg(col(tb.color))
                .flex()
                .items_center()
                .justify_center()
                .child(crate::icon_picker::symbols::symbol(
                    host.as_ref(),
                    tb.icon,
                    size * 0.58,
                    size,
                    crate::icon_picker::symbols::SymbolWeight::Semibold,
                    gpui::white(),
                ))
                .into_any_element()
        };
        let at = |x: f32, y: f32, w: f32, h: f32| {
            div().absolute().left(px(x)).top(px(y)).w(px(w)).h(px(h))
        };
        let pill_x = STYLE_PAD + 3.0 * (STYLE_BUTTON + STYLE_BUTTON_GAP);
        let scene = div()
            .absolute()
            .inset_0()
            .bg(hsla(sky_top))
            .children((0..STYLE_SKY_BANDS - 1).map(|i| {
                div()
                    .absolute()
                    .left_0()
                    .right_0()
                    .bottom_0()
                    .top(px(
                        (i + 1) as f32 / STYLE_SKY_BANDS as f32 * (STYLE_STAGE_H - STYLE_SEA_H)
                    ))
                    .bg(hsla(sky_top.mix(
                        sky_bottom,
                        (i + 1) as f32 / (STYLE_SKY_BANDS - 1) as f32,
                    )))
            }))
            .child(
                div()
                    .absolute()
                    .left(px(STYLE_SUN_FROM + (STYLE_SUN_TO - STYLE_SUN_FROM) * travel))
                    .top(px(STYLE_TILES_TOP + (STYLE_TILES_H - STYLE_SUN) / 2.0))
                    .size(px(STYLE_SUN))
                    .rounded_full()
                    .bg(col(ink.1)),
            )
            .child(
                div()
                    .absolute()
                    .left(px(150.))
                    .top(px(196.))
                    .size(px(560.))
                    .rounded_full()
                    .bg(col(ink.2)),
            )
            .child(
                div()
                    .absolute()
                    .left(px(-240.))
                    .top(px(262.))
                    .size(px(520.))
                    .rounded_full()
                    .bg(col(ink.3)),
            )
            .child(
                div()
                    .absolute()
                    .left_0()
                    .right_0()
                    .bottom_0()
                    .h(px(STYLE_SEA_H))
                    .bg(col(ink.4))
                    .children(STYLE_GLINTS.map(|(x, y, w)| {
                        div()
                            .absolute()
                            .left(px(x))
                            .top(px(y))
                            .w(px(w))
                            .h(px(3.))
                            .rounded(px(1.5))
                            .bg(col(ink.5))
                    })),
            );
        let lights = div()
            .absolute()
            .left(px(STYLE_PAD + 1.0))
            .top(px(18.))
            .flex()
            .flex_row()
            .gap(px(8.))
            .children(TRAFFIC_LIGHTS.map(|color| light(color, 12.)));
        let surfaces = div()
            .absolute()
            .inset_0()
            .child(lights)
            .children((0..3).map(|i| {
                at(
                    STYLE_PAD + i as f32 * (tile_w + STYLE_TILES_GAP),
                    STYLE_TILES_TOP,
                    tile_w,
                    STYLE_TILES_H,
                )
                .child(face(STYLE_TILES_RADIUS, fav(i + 1, STYLE_TILES_ICON)))
            }))
            .child(
                at(
                    STYLE_PAD,
                    STYLE_FIELD_TOP,
                    STYLE_STAGE_W - STYLE_PAD * 2.0,
                    STYLE_FIELD_H,
                )
                .child(face(
                    STYLE_FIELD_RADIUS,
                    div()
                        .flex_1()
                        .flex()
                        .flex_row()
                        .items_center()
                        .gap(px(space::M))
                        .px(px(space::L))
                        .child(fav(0, 20.))
                        .child(
                            div()
                                .text_size(px(17.))
                                .font_weight(FontWeight::SEMIBOLD)
                                .text_color(hsla(t.text_primary))
                                .child(super::mock::tab(0).host),
                        )
                        .into_any_element(),
                )),
            )
            .children(
                ["chevron.left", "chevron.right", "arrow.clockwise"]
                    .into_iter()
                    .enumerate()
                    .map(|(i, name)| {
                        at(
                            STYLE_PAD + i as f32 * (STYLE_BUTTON + STYLE_BUTTON_GAP),
                            STYLE_BUTTONS_TOP,
                            STYLE_BUTTON,
                            STYLE_BUTTON,
                        )
                        .child(face(STYLE_BUTTON / 2.0, sym(name, 17., 22.)))
                    }),
            )
            .child(
                at(
                    pill_x,
                    STYLE_BUTTONS_TOP,
                    STYLE_STAGE_W - STYLE_PAD - pill_x,
                    STYLE_BUTTON,
                )
                .child(face(
                    STYLE_BUTTON / 2.0,
                    div()
                        .flex()
                        .flex_row()
                        .items_center()
                        .gap(px(space::S))
                        .child(sym("plus", 15., 20.))
                        .child(
                            div()
                                .text_size(px(17.))
                                .font_weight(FontWeight::SEMIBOLD)
                                .text_color(hsla(t.text_primary))
                                .child("New Tab"),
                        )
                        .into_any_element(),
                )),
            );
        let edge = RgbaColor::hexa(if dark { 0xFFFFFF2E } else { 0x0000002A });
        let corner = ardia_theme::layout::DEFAULT_WINDOW_CORNER_RADIUS;
        div()
            .id("onboarding-style-preview")
            .relative()
            .w(px(STYLE_STAGE_W))
            .h(px(STYLE_STAGE_H))
            .rounded(px(corner))
            .border(px(0.5))
            .border_color(hsla(edge))
            .shadow(vec![shadow(
                hsla(RgbaColor::black(if dark { 0.55 } else { 0.22 })),
                10.,
                22.,
            )])
            .child(
                div()
                    .absolute()
                    .inset_0()
                    .rounded(px(corner))
                    .overflow_hidden()
                    .child(scene)
                    .child(surfaces),
            )
            .into_any_element()
    }

    fn terminal_preview(&self) -> AnyElement {
        let ink = self.ink();
        let plugins = self.official_plugins();
        let subject = self
            .plugins_step
            .current
            .as_ref()
            .and_then(|name| plugins.iter().find(|p| &p.name == name))
            .or_else(|| plugins.first());
        let linked = subject
            .map(|p| self.host.linked_programs(p.name.clone()))
            .unwrap_or_default();
        let lines = terminal_lines(
            linked.first().map(|l| l.program.as_str()),
            subject
                .and_then(|p| p.version.as_deref())
                .or_else(|| linked.first().and_then(|l| l.version.as_deref())),
        );
        div()
            .w(px(320.))
            .rounded(px(radius::PANEL))
            .bg(ink.card)
            .border(px(1.))
            .border_color(ink.row_border)
            .overflow_hidden()
            .child(
                div()
                    .flex()
                    .flex_row()
                    .gap(px(space::S))
                    .px(px(space::L))
                    .py(px(space::ML))
                    .border_b(px(1.))
                    .border_color(ink.row_border)
                    .children(
                        (0..3).map(|_| div().size(px(9.)).rounded_full().bg(ink.progress_track)),
                    ),
            )
            .child(
                div()
                    .p(px(space::L))
                    .gap(px(space::S))
                    .min_h(px(96.))
                    .flex()
                    .flex_col()
                    .children(lines.into_iter().map(|line| {
                        div()
                            .font_family("Menlo")
                            .text_size(px(12.))
                            .text_color(if line.starts_with('$') {
                                ink.title
                            } else {
                                ink.subtitle
                            })
                            .child(line)
                    })),
            )
            .into_any_element()
    }
}
