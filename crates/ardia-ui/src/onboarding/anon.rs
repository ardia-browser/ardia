use std::time::Instant;

use ardia_theme::RgbaColor;
use ardia_theme::tokens::{radius, space};
use gpui::{
    AnyElement, FontWeight, IntoElement, ParentElement, SharedString, Styled, Window, div,
    linear_color_stop, linear_gradient, prelude::*,
};

use super::OnboardingWindowView;
use crate::primitives::theme_bridge::hsla;
use crate::scale::px;

pub const WIDTH: f32 = 300.0;
pub const HEIGHT: f32 = 430.0;
pub const RADIUS: f32 = 18.0;
pub const INSET: f32 = 8.0;
pub const ART_HEIGHT: f32 = 150.0;
pub const ART_GLYPH: f32 = 76.0;
pub const SHEEN_WIDTH: f32 = 90.0;
pub const FLOAT_MS: f32 = 7000.0;
pub const SWING: f32 = 14.0;
pub const LIFT: f32 = 6.0;
pub const PERSPECTIVE: f32 = 900.0;
pub const GLARE_TURN: f32 = 20.0;
pub const TWIST_PER_DEGREE: f32 = 0.05;

pub fn flat_tilt(swing: f32, lift: f32) -> (f32, f32) {
    let (y, x) = (swing.to_radians(), lift.to_radians());
    let half_w = WIDTH / 2.0;
    let half_h = HEIGHT / 2.0;
    let near = |reach: f32, angle: f32| PERSPECTIVE / (PERSPECTIVE - reach * angle.sin().abs());
    let spread = (half_w * y.cos() * near(half_w, y) + half_h * x.cos() * near(half_h, x)) / (half_w + half_h);
    ((swing + lift) * TWIST_PER_DEGREE, spread)
}
pub const OFF_OPACITY: f32 = 0.55;
pub const ENERGY: f32 = 11.0;
pub const FOIL: [u32; 2] = [0xE1E1FE, 0xFD02F5];
pub const NEVER: &str = "Your browsing never leaves your Mac.";
pub const SHARED: &str = "Crash reports and usage counts. Nothing personal.";
pub const SHARED_OFF: &str = "Off. Only a daily open count.";

const ADJECTIVES: [&str; 24] = [
    "Quiet", "Swift", "Lucky", "Sleepy", "Brave", "Clever", "Cosmic", "Gentle", "Mellow", "Nimble",
    "Plucky", "Sunny", "Witty", "Zesty", "Breezy", "Curious", "Dapper", "Fuzzy", "Jolly", "Misty",
    "Noble", "Rusty", "Silky", "Velvet",
];

const CREATURES: [(&str, &str); 16] = [
    ("Otter", "🦦"),
    ("Fox", "🦊"),
    ("Owl", "🦉"),
    ("Panda", "🐼"),
    ("Koala", "🐨"),
    ("Penguin", "🐧"),
    ("Hedgehog", "🦔"),
    ("Octopus", "🐙"),
    ("Frog", "🐸"),
    ("Tiger", "🐯"),
    ("Whale", "🐳"),
    ("Sloth", "🦥"),
    ("Raccoon", "🦝"),
    ("Flamingo", "🦩"),
    ("Turtle", "🐢"),
    ("Bee", "🐝"),
];

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Identity {
    pub name: String,
    pub art: &'static str,
    pub serial: String,
    pub rarity: usize,
}

fn hash(text: &str) -> u32 {
    let mut h: u32 = 2_166_136_261;
    for unit in text.encode_utf16() {
        h = (h ^ u32::from(unit)).wrapping_mul(16_777_619);
    }
    h
}

pub fn identity(install_id: &str) -> Identity {
    let h = hash(install_id);
    let creature = CREATURES[(h as usize) % CREATURES.len()];
    let adjective = ADJECTIVES[((h as usize) / CREATURES.len()) % ADJECTIVES.len()];
    let mut hex: String = install_id
        .chars()
        .filter(char::is_ascii_hexdigit)
        .collect::<String>()
        .to_uppercase();
    while hex.len() < 8 {
        hex.push('0');
    }
    Identity {
        name: format!("{adjective} {}", creature.0),
        art: creature.1,
        serial: format!("{}·{}", &hex[0..4], &hex[4..8]),
        rarity: 1 + (hash(&format!("{install_id}:rarity")) as usize % 3),
    }
}

pub fn issued() -> String {
    use chrono::Datelike;
    let now = chrono::Local::now();
    const MONTHS: [&str; 12] = [
        "JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC",
    ];
    format!("{} {}", MONTHS[now.month0() as usize], now.year())
}

impl OnboardingWindowView {
    pub(crate) fn anon_card(&mut self, window: &mut Window) -> AnyElement {
        let ink = self.ink();
        let on = self.share();
        let me = identity(&self.host.install_id());
        let dark = self.look.dark;
        let accent = self.look.theme.roles.accent;
        let started = *self.anon_started.get_or_insert_with(Instant::now);
        window.request_animation_frame();
        let t = (started.elapsed().as_secs_f32() * 1000.0 / FLOAT_MS).fract();
        let glare_x = {
            let travel = WIDTH + SHEEN_WIDTH * 2.0;
            let steps = [travel / 2.0, travel, travel / 2.0, 0.0, travel / 2.0];
            let at = t * 4.0;
            let i = (at.floor() as usize).min(3);
            steps[i] + (steps[i + 1] - steps[i]) * (at - i as f32)
        };
        let glare_o = {
            let steps = [0.35, 1.0, 0.35, 1.0, 0.35];
            let at = t * 4.0;
            let i = (at.floor() as usize).min(3);
            steps[i] + (steps[i + 1] - steps[i]) * (at - i as f32)
        };
        let along = |steps: [f32; 5]| {
            let at = t * 4.0;
            let i = (at.floor() as usize).min(3);
            steps[i] + (steps[i + 1] - steps[i]) * (at - i as f32)
        };
        let swing = along([0.0, SWING, 0.0, -SWING, 0.0]);
        let lift = along([LIFT, 0.0, -LIFT, 0.0, LIFT]);
        let (turn, depth) = flat_tilt(swing, lift);
        let foil = |angle: f32| {
            linear_gradient(
                angle,
                linear_color_stop(hsla(accent), 0.0),
                linear_color_stop(hsla(RgbaColor::hex(FOIL[1])), 1.0),
            )
        };
        let mono = "Menlo";
        let label = |text: String, size: f32, weight: FontWeight, color: gpui::Hsla| {
            div()
                .text_size(px(size))
                .font_weight(weight)
                .text_color(color)
                .child(SharedString::from(text))
        };
        let caps = |text: &str| {
            label(text.to_owned(), 9., FontWeight::BOLD, ink.subtitle).font_family(mono)
        };
        let stat = |l: &str, v: &str| {
            div()
                .flex()
                .flex_col()
                .items_center()
                .gap(px(1.))
                .child(caps(l))
                .child(label(v.to_owned(), 11., FontWeight::SEMIBOLD, ink.title))
        };
        let energy = || {
            div()
                .size(px(ENERGY))
                .rounded_full()
                .bg(hsla(accent))
                .border(px(1.))
                .border_color(gpui::white())
        };
        let panel = div()
            .absolute()
            .inset(px(INSET))
            .rounded(px(RADIUS - INSET))
            .p(px(space::L))
            .flex()
            .flex_col()
            .gap(px(space::M))
            .bg(hsla(RgbaColor::hexa(if dark {
                0x121214EB
            } else {
                0xFFFFFFEB
            })))
            .child(
                div()
                    .flex()
                    .flex_row()
                    .justify_between()
                    .items_center()
                    .child(
                        label("ARDIA · ANON ID".into(), 10., FontWeight::BOLD, ink.title)
                            .font_family(mono),
                    )
                    .child(label(
                        format!("{}{}", "★".repeat(me.rarity), "☆".repeat(3 - me.rarity)),
                        10.,
                        FontWeight::NORMAL,
                        hsla(accent),
                    )),
            )
            .child(
                div()
                    .h(px(ART_HEIGHT))
                    .rounded(px(radius::CONTROL))
                    .overflow_hidden()
                    .bg(foil(30.))
                    .flex()
                    .items_center()
                    .justify_center()
                    .child(
                        div()
                            .text_size(px(ART_GLYPH))
                            .line_height(px(ART_GLYPH * 1.2))
                            .child(me.art),
                    ),
            )
            .child(
                div()
                    .flex()
                    .flex_col()
                    .gap(px(space::XS))
                    .child(
                        div()
                            .flex()
                            .flex_row()
                            .items_end()
                            .justify_between()
                            .gap(px(space::S))
                            .child(
                                label(
                                    if on {
                                        me.name.clone()
                                    } else {
                                        "Anonymous".into()
                                    },
                                    17.,
                                    FontWeight::SEMIBOLD,
                                    ink.title,
                                )
                                .truncate(),
                            )
                            .child(
                                div()
                                    .flex()
                                    .flex_row()
                                    .items_end()
                                    .gap(px(space::XS))
                                    .child(caps("PRIVACY"))
                                    .child(label(
                                        "100".into(),
                                        17.,
                                        FontWeight::BOLD,
                                        hsla(accent),
                                    )),
                            ),
                    )
                    .child(
                        div()
                            .flex()
                            .flex_row()
                            .justify_between()
                            .child(
                                label(
                                    if on {
                                        format!("№ {}", me.serial)
                                    } else {
                                        "№ ----·----".into()
                                    },
                                    10.,
                                    FontWeight::NORMAL,
                                    ink.subtitle,
                                )
                                .font_family(mono),
                            )
                            .child(
                                label(
                                    format!("ISSUED {}", issued()),
                                    10.,
                                    FontWeight::NORMAL,
                                    ink.subtitle,
                                )
                                .font_family(mono),
                            ),
                    ),
            )
            .child(div().h(px(0.5)).bg(ink.row_border))
            .child(
                div()
                    .flex()
                    .flex_col()
                    .gap(px(space::XS))
                    .child(
                        div()
                            .flex()
                            .flex_row()
                            .items_center()
                            .gap(px(space::S))
                            .child(
                                div()
                                    .px(px(space::S))
                                    .rounded(px(radius::HAIR))
                                    .bg(hsla(accent))
                                    .child(
                                        label(
                                            "ABILITY".into(),
                                            9.,
                                            FontWeight::BOLD,
                                            gpui::white(),
                                        )
                                        .font_family(mono),
                                    ),
                            )
                            .child(label(
                                "Ghost Mode".into(),
                                13.,
                                FontWeight::SEMIBOLD,
                                ink.title,
                            )),
                    )
                    .child(label(NEVER.into(), 11., FontWeight::NORMAL, ink.subtitle)),
            )
            .child(
                div()
                    .flex()
                    .flex_col()
                    .gap(px(space::XS))
                    .opacity(if on { 1.0 } else { OFF_OPACITY })
                    .child(
                        div()
                            .flex()
                            .flex_row()
                            .items_center()
                            .gap(px(space::S))
                            .child(energy())
                            .child(energy())
                            .child(label(
                                "Bug Report".into(),
                                13.,
                                FontWeight::SEMIBOLD,
                                ink.title,
                            )),
                    )
                    .child(
                        label(
                            (if on { SHARED } else { SHARED_OFF }).into(),
                            11.,
                            FontWeight::NORMAL,
                            ink.subtitle,
                        )
                        .line_clamp(2),
                    ),
            )
            .child(
                div().flex_1().flex().flex_col().justify_end().child(
                    div()
                        .flex()
                        .flex_row()
                        .justify_between()
                        .pt(px(space::M))
                        .border_t(px(0.5))
                        .border_color(ink.row_border)
                        .child(stat("WEAKNESS", "—"))
                        .child(stat("RESISTS", "Trackers"))
                        .child(stat("DATA SOLD", "0")),
                ),
            );
        div()
            .id("onboarding-anon-card")
            .debug_selector(|| "onboarding-anon-card".into())
            .relative()
            .w(px(WIDTH))
            .h(px(HEIGHT))
            .rounded(px(RADIUS))
            .overflow_hidden()
            .opacity(if on { 1.0 } else { OFF_OPACITY })
            .rotate(gpui::radians(turn.to_radians()))
            .scale(depth)
            .bg(foil(150.))
            .child(panel)
            .when(on, |this| {
                this.child(
                    div()
                        .absolute()
                        .top(px(-HEIGHT / 2.0))
                        .left(px(-SHEEN_WIDTH + glare_x))
                        .w(px(SHEEN_WIDTH))
                        .h(px(HEIGHT * 2.0))
                        .opacity(glare_o)
                        .rotate(gpui::radians(GLARE_TURN.to_radians()))
                        .bg(hsla(RgbaColor::hexa(0xFFFFFF33))),
                )
            })
            .into_any_element()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_flat_tilt_rests_level_and_leans_with_the_swing() {
        assert_eq!(flat_tilt(0.0, 0.0), (0.0, 1.0));
        let (turn, depth) = flat_tilt(SWING, 0.0);
        assert!(turn > 0.0 && turn < 2.0);
        assert!((depth - 1.0).abs() < 0.05);
        assert!(flat_tilt(-SWING, 0.0).0 < 0.0);
    }

    #[test]
    fn identities_follow_the_old_hash() {
        let me = identity("d0a3-3076-4a1c");
        assert_eq!(me.serial, "D0A3·3076");
        assert!((1..=3).contains(&me.rarity));
        assert_eq!(identity("d0a3-3076-4a1c"), me);
        assert_eq!(identity("").serial, "0000·0000");
    }
}
