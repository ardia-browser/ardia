use ardia_state::settings::Settings;
use ardia_theme::{RgbaColor, Theme};
use gpui::{Div, LiquidGlassStyle, ParentElement, Rgba, Styled, div, liquid_glass, prelude::*};

use crate::look::Look;
use crate::primitives::glass_glow::gradient_rim;
use crate::primitives::theme_bridge::rgba;
use crate::scale::px;

pub const PROFILE_SHARE: f32 = 0.15;
pub const TINT_LIFT_PER_SHARE: f32 = 0.25;
pub const CONTROL_FILL_SHARE: f32 = 0.15;
pub const CONTROL_GLASS_STRENGTH: f32 = 0.5;
pub const PANEL_TINT_SHARE: f32 = 0.85;
pub const PANEL_GLASS_STRENGTH: f32 = 0.5;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum GlassState {
    Rest,
    Lit,
    Pressed,
    Active,
}

impl GlassState {
    pub const fn gain(self) -> f32 {
        match self {
            GlassState::Rest => 1.0,
            GlassState::Lit => 2.0,
            GlassState::Pressed => 3.0,
            GlassState::Active => 6.0,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct GlassLook {
    pub controls: bool,
    pub panes: bool,
    pub tint: f32,
}

impl GlassLook {
    pub fn of(settings: &Settings) -> Self {
        let glass = crate::look::glass_shown(settings, crate::look::liquid_glass_available());
        GlassLook {
            controls: glass,
            panes: glass,
            tint: if settings.glass_tint_with_theme {
                settings.glass_tint_amount.clamp(0.0, 1.0) as f32
            } else {
                0.0
            },
        }
    }
}

fn profile_tinted(color: RgbaColor, tinted: bool, share: f32, toward: RgbaColor) -> RgbaColor {
    if !tinted {
        return color;
    }
    let mix = |c: f32, p: f32| c + (p - c) * share;
    RgbaColor::new(
        mix(color.r, toward.r),
        mix(color.g, toward.g),
        mix(color.b, toward.b),
        color.a,
    )
}

pub fn control_glass_tint(theme: &Theme, state: GlassState, tint: f32) -> RgbaColor {
    control_glass_tint_of(theme.roles.pinned_resting, theme.roles.accent, state, tint)
}

pub fn control_glass_tint_of(
    rest: RgbaColor,
    accent: RgbaColor,
    state: GlassState,
    tint: f32,
) -> RgbaColor {
    let alpha = (rest.a * CONTROL_FILL_SHARE * state.gain() + tint * TINT_LIFT_PER_SHARE).min(1.0);
    profile_tinted(rest.with_alpha(alpha), tint > 0.0, tint, accent)
}

pub fn panel_glass_tint(theme: &Theme, fill: RgbaColor, tint: f32) -> RgbaColor {
    let glassy = 1.0 - (fill.a * PANEL_TINT_SHARE).min(1.0);
    profile_tinted(
        fill.with_alpha(1.0 - glassy * PANEL_GLASS_STRENGTH),
        tint > 0.0,
        PROFILE_SHARE,
        theme.backdrop.tint.color,
    )
}

fn glass_rgba(color: RgbaColor) -> Rgba {
    rgba(color)
}

pub const CONTROL_GLASS_ID: &str = "control-glass";
pub const PANEL_GLASS_ID: &str = "panel-glass";
pub const PINNED_GRID_GLASS_GROUP: u64 = 0x7069_6e6e_6564_6772;

pub fn control_glass(look: &Look, radius: f32, state: GlassState) -> Div {
    control_glass_in(look, radius, state, None)
}

pub fn grouped_control_glass(look: &Look, radius: f32, state: GlassState, group: u64) -> Div {
    control_glass_in(look, radius, state, Some(group))
}

fn control_glass_in(look: &Look, radius: f32, state: GlassState, group: Option<u64>) -> Div {
    let tint = GlassLook::of_look(look).tint;
    let glass = liquid_glass()
        .id(CONTROL_GLASS_ID)
        .absolute()
        .inset_0()
        .corner_radius(px(radius))
        .style(LiquidGlassStyle::Clear)
        .alpha(CONTROL_GLASS_STRENGTH)
        .tint(glass_rgba(control_glass_tint(&look.theme, state, tint)));
    div()
        .absolute()
        .inset_0()
        .rounded(px(radius))
        .child(match group {
            Some(group) => glass.group_id(group),
            None => glass,
        })
}

pub const DARK_GLASS_LIFT: f32 = 0.063;
pub const DARK_GLASS_LIFT_TINT: [f32; 3] = [208.0 / 255.0, 224.0 / 255.0, 1.0];
pub const SURFACE_GLASS_RIM: f32 = 1.0;
pub const SURFACE_GLASS_RIM_DARK: [f32; 2] = [0.25, 0.25];
pub const SURFACE_GLASS_RIM_LIGHT: [f32; 2] = [1.0, 0.4];
pub const SURFACE_GLASS_SHEEN_DARK: f32 = 0.015;
pub const SURFACE_GLASS_SHEEN_LIGHT: f32 = 0.25;
pub const SURFACE_GLASS_SHEEN_END: f32 = 0.7;

pub fn painted_control_glass_fill(theme: &Theme, state: GlassState, tint: f32) -> RgbaColor {
    let glass = control_glass_tint(theme, state, tint);
    glass.with_alpha(glass.a * CONTROL_GLASS_STRENGTH)
}

pub fn painted_glass_lift(theme: &Theme, from: GlassState, to: GlassState, tint: f32) -> RgbaColor {
    let low = painted_control_glass_fill(theme, from, tint);
    let high = painted_control_glass_fill(theme, to, tint);
    high.with_alpha((high.a - low.a).max(0.0))
}

pub fn control_glass_on_surface(look: &Look, radius: f32, state: GlassState) -> Div {
    let tint = GlassLook::of_look(look).tint;
    surface_glass(
        painted_control_glass_fill(&look.theme, state, tint),
        look.dark,
        radius,
    )
}

pub fn surface_glass(fill: RgbaColor, dark: bool, radius: f32) -> Div {
    let (rim, sheen) = if dark {
        (SURFACE_GLASS_RIM_DARK, SURFACE_GLASS_SHEEN_DARK)
    } else {
        (SURFACE_GLASS_RIM_LIGHT, SURFACE_GLASS_SHEEN_LIGHT)
    };
    div()
        .absolute()
        .inset_0()
        .rounded(px(radius))
        .bg(gpui::Hsla::from(glass_rgba(fill)))
        .when(dark, |this| {
            this.child(
                div()
                    .absolute()
                    .inset_0()
                    .rounded(px(radius))
                    .bg(gpui::Hsla::from(gpui::Rgba {
                        r: DARK_GLASS_LIFT_TINT[0],
                        g: DARK_GLASS_LIFT_TINT[1],
                        b: DARK_GLASS_LIFT_TINT[2],
                        a: DARK_GLASS_LIFT,
                    }))
                    .shadow(surface_edge_glow()),
            )
        })
        .child(
            div()
                .absolute()
                .inset_0()
                .rounded(px(radius))
                .bg(gpui::linear_gradient(
                    180.,
                    gpui::linear_color_stop(gpui::white().opacity(sheen), 0.),
                    gpui::linear_color_stop(gpui::white().opacity(0.), SURFACE_GLASS_SHEEN_END),
                )),
        )
        .children(surface_rim(dark, radius, rim))
}

pub const SURFACE_EDGE_GLOW: f32 = 0.07;
pub const SURFACE_EDGE_GLOW_BLUR: f32 = 1.5;
pub const SURFACE_EDGE_GLOW_OFFSET: f32 = 1.0;

pub fn surface_edge_glow() -> Vec<gpui::BoxShadow> {
    [SURFACE_EDGE_GLOW_OFFSET, -SURFACE_EDGE_GLOW_OFFSET]
        .into_iter()
        .map(|dy| gpui::BoxShadow {
            color: gpui::white().opacity(SURFACE_EDGE_GLOW),
            offset: gpui::point(gpui::px(0.), px(dy)),
            blur_radius: px(SURFACE_EDGE_GLOW_BLUR),
            spread_radius: gpui::px(0.),
            inset: true,
        })
        .collect()
}

pub fn surface_rim(dark: bool, radius: f32, rim: [f32; 2]) -> Vec<gpui::AnyElement> {
    let stroke = gpui::px(SURFACE_GLASS_RIM);
    let edge = |from: (f32, f32), to: (f32, f32)| {
        gradient_rim(
            px(radius),
            stroke,
            gpui::linear_gradient(
                180.,
                gpui::linear_color_stop(gpui::white().opacity(from.0), from.1),
                gpui::linear_color_stop(gpui::white().opacity(to.0), to.1),
            ),
        )
        .into_any_element()
    };
    if dark {
        vec![edge((rim[0], 0.), (0., 0.5)), edge((0., 0.5), (rim[1], 1.))]
    } else {
        vec![edge((rim[0], 0.), (rim[1], 1.))]
    }
}

pub fn panel_glass(look: &Look, radius: f32, fill: RgbaColor) -> Div {
    let tint = GlassLook::of_look(look).tint;
    div().absolute().inset_0().rounded(px(radius)).child(
        liquid_glass()
            .id(PANEL_GLASS_ID)
            .absolute()
            .inset_0()
            .corner_radius(px(radius))
            .style(LiquidGlassStyle::Regular)
            .tint(glass_rgba(panel_glass_tint(&look.theme, fill, tint))),
    )
}

impl GlassLook {
    pub fn of_look(look: &Look) -> Self {
        GlassLook {
            controls: look.glass,
            panes: look.glass,
            tint: look.glass_tint,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use ardia_theme::{ProfileColor, ThemeFamily};

    fn close(a: f32, b: f32) -> bool {
        (a - b).abs() < 1e-5
    }

    #[test]
    fn a_lit_control_adds_only_the_step_above_rest() {
        let theme = Theme::preset(ThemeFamily::Preset(ProfileColor::Green), true);
        let lift = painted_glass_lift(&theme, GlassState::Rest, GlassState::Lit, 0.0);
        let rest = painted_control_glass_fill(&theme, GlassState::Rest, 0.0);
        let lit = painted_control_glass_fill(&theme, GlassState::Lit, 0.0);
        assert!(close(lift.a, lit.a - rest.a));
        assert!(lift.a > 0.0);
        assert!(close(
            painted_glass_lift(&theme, GlassState::Lit, GlassState::Rest, 0.0).a,
            0.0
        ));
    }

    #[test]
    fn dark_surface_glass_lights_its_top_and_bottom_edges() {
        assert_eq!(surface_rim(true, 8., SURFACE_GLASS_RIM_DARK).len(), 2);
        assert_eq!(surface_rim(false, 8., SURFACE_GLASS_RIM_LIGHT).len(), 1);
        assert!(close(SURFACE_GLASS_RIM_DARK[0], SURFACE_GLASS_RIM_DARK[1]));
    }

    #[test]
    fn control_glass_gains_alpha_with_each_state() {
        let theme = Theme::preset(ThemeFamily::Preset(ProfileColor::Green), true);
        let rest = theme.roles.pinned_resting;
        for state in [
            GlassState::Rest,
            GlassState::Lit,
            GlassState::Pressed,
            GlassState::Active,
        ] {
            let shown = control_glass_tint(&theme, state, 0.0);
            assert!(close(shown.a, (rest.a * 0.15 * state.gain()).min(1.0)));
            assert!(close(shown.r, rest.r) && close(shown.b, rest.b));
        }
    }

    #[test]
    fn a_tinted_control_leans_toward_the_accent_and_lifts_its_alpha() {
        let theme = Theme::preset(ThemeFamily::Preset(ProfileColor::Plum), false);
        let rest = theme.roles.pinned_resting;
        let accent = theme.roles.accent;
        let shown = control_glass_tint(&theme, GlassState::Lit, 0.2);
        assert!(close(shown.a, (rest.a * 0.15 * 2.0 + 0.2 * 0.25).min(1.0)));
        assert!(close(shown.r, rest.r + (accent.r - rest.r) * 0.2));
    }

    #[test]
    fn panel_glass_keeps_half_the_glass_left_by_the_fill() {
        let theme = Theme::preset(ThemeFamily::Preset(ProfileColor::Blue), true);
        let fill = RgbaColor::new(0.15, 0.15, 0.15, 0.94);
        let plain = panel_glass_tint(&theme, fill, 0.0);
        let glassy = 1.0 - (0.94_f32 * 0.85).min(1.0);
        assert!(close(plain.a, 1.0 - glassy * 0.5));
        assert!(close(plain.r, 0.15));
        let toward = theme.backdrop.tint.color;
        let tinted = panel_glass_tint(&theme, fill, 0.5);
        assert!(close(tinted.r, 0.15 + (toward.r - 0.15) * 0.15));
    }

    #[test]
    fn painted_glass_over_a_dark_card_matches_the_native_measurement() {
        let theme = Theme::preset(ThemeFamily::Preset(ProfileColor::Green), true);
        let fill = painted_control_glass_fill(&theme, GlassState::Rest, 0.17);
        let under = 45.0 / 255.0;
        let over = |c: f32, lift: f32| {
            let glassed = under * (1.0 - fill.a) + c * fill.a;
            (glassed + (lift - glassed) * DARK_GLASS_LIFT) * 255.0
        };
        let [lift_r, lift_g, lift_b] = DARK_GLASS_LIFT_TINT;
        assert!((over(fill.r, lift_r) - 61.0).abs() < 3.0);
        assert!((over(fill.g, lift_g) - 62.0).abs() < 3.0);
        assert!((over(fill.b, lift_b) - 65.0).abs() < 3.0);
        assert!(over(fill.b, lift_b) - over(fill.r, lift_r) > 2.0);
        let light = Theme::preset(ThemeFamily::Preset(ProfileColor::Green), false);
        let fill = painted_control_glass_fill(&light, GlassState::Rest, 0.17);
        let paper = 254.0 / 255.0;
        let shown = (paper * (1.0 - fill.a) + fill.g * fill.a) * 255.0;
        assert!((shown - 249.0).abs() < 2.0);
    }

    #[test]
    fn the_glass_tint_follows_the_settings() {
        let plain = Settings {
            glass_tint_with_theme: false,
            ..Settings::default()
        };
        assert_eq!(GlassLook::of(&plain).tint, 0.0);
        let tinted = Settings {
            glass_tint_with_theme: true,
            glass_tint_amount: 0.17,
            ..Settings::default()
        };
        assert!(close(GlassLook::of(&tinted).tint, 0.17));
    }

    struct GlassRow {
        look: Look,
        lead: bool,
    }

    impl gpui::Render for GlassRow {
        fn render(
            &mut self,
            _: &mut gpui::Window,
            _: &mut gpui::Context<Self>,
        ) -> impl gpui::IntoElement {
            let cell = |id: &'static str, x: f32, glass: Div| {
                div()
                    .id(id)
                    .absolute()
                    .left(px(x))
                    .top(px(0.))
                    .size(px(40.))
                    .child(glass)
            };
            div()
                .size_full()
                .when(self.lead, |this| {
                    this.child(cell(
                        "lead",
                        0.,
                        control_glass(&self.look, 8., GlassState::Rest),
                    ))
                })
                .child(cell(
                    "a",
                    50.,
                    grouped_control_glass(
                        &self.look,
                        8.,
                        GlassState::Rest,
                        PINNED_GRID_GLASS_GROUP,
                    ),
                ))
                .child(cell(
                    "b",
                    100.,
                    grouped_control_glass(
                        &self.look,
                        8.,
                        GlassState::Active,
                        PINNED_GRID_GLASS_GROUP,
                    ),
                ))
                .child(cell(
                    "panel",
                    150.,
                    panel_glass(&self.look, 12., self.look.theme.roles.panel),
                ))
        }
    }

    #[gpui::test]
    fn grouped_and_lone_glass_render_as_siblings_come_and_go(cx: &mut gpui::TestAppContext) {
        use ardia_state::BrowserState;
        use ardia_state::persistence::session::{LoadOptions, SessionData};
        let state = BrowserState::from_session(SessionData::fresh(LoadOptions::default()), 0);
        let look = Look::new(&state, "missing", gpui::WindowAppearance::Dark);
        assert!(look.glass);
        let window = cx.add_window(|_, _| GlassRow { look, lead: true });
        cx.run_until_parked();
        window
            .update(cx, |row, _, cx| {
                row.lead = false;
                cx.notify();
            })
            .unwrap();
        cx.run_until_parked();
        window.update(cx, |row, _, _| assert!(!row.lead)).unwrap();
    }

    #[test]
    fn glass_ids_and_the_pinned_group_are_distinct() {
        assert_ne!(CONTROL_GLASS_ID, PANEL_GLASS_ID);
        assert_ne!(PINNED_GRID_GLASS_GROUP, 0);
    }
}
