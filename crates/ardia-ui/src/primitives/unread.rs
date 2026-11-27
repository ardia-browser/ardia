use std::time::Duration;

use ardia_state::unread::Unread;
use ardia_theme::motion::Spring;
use gpui::{
    Animation, AnimationExt, AnyElement, FontWeight, Hsla, IntoElement, ParentElement,
    SharedString, Styled, div, rgba,
};

use crate::scale::px;

pub const UNREAD_DOT: f32 = 6.0;
pub const UNREAD_INLINE_GAP: f32 = 6.0;
pub const TILE_INSET: f32 = 2.0;
pub const TILE_DOT_INSET: f32 = 5.5;
pub const SHOW_SPRING: Spring = Spring::new(0.3, 0.6);
pub const HIDDEN_SCALE: f32 = 0.5;

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct PillSize {
    pub height: f32,
    pub pad_x: f32,
    pub text: f32,
}

pub const ROW_PILL: PillSize = PillSize {
    height: 16.0,
    pad_x: 5.0,
    text: 11.0,
};

pub const TILE_PILL: PillSize = PillSize {
    height: 11.0,
    pad_x: 3.0,
    text: 9.0,
};

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct UnreadInk {
    pub row_fill: Hsla,
    pub row_ink: Hsla,
    pub row_dot: Hsla,
    pub tile_fill: Hsla,
}

pub fn unread_ink(dark: bool) -> UnreadInk {
    if dark {
        UnreadInk {
            row_fill: rgba(0xFFFFFF29).into(),
            row_ink: rgba(0xFFFFFFE6).into(),
            row_dot: rgba(0xFFFFFFCC).into(),
            tile_fill: rgba(0x55555AFF).into(),
        }
    } else {
        UnreadInk {
            row_fill: rgba(0x0000001C).into(),
            row_ink: rgba(0x000000CC).into(),
            row_dot: rgba(0x000000A6).into(),
            tile_fill: rgba(0xD4D4D8FF).into(),
        }
    }
}

pub fn ink_is_dark(ink: Option<Hsla>, dark: bool) -> bool {
    ink.map_or(dark, |ink| ink.l > 0.5)
}

fn animation_key(place: &str, unread: &Unread) -> SharedString {
    match unread {
        Unread::Dot => SharedString::from(format!("unread-{place}-dot")),
        Unread::Count(label) => SharedString::from(format!("unread-{place}-{label}")),
    }
}

fn shown(element: gpui::Div, key: SharedString) -> AnyElement {
    let settle = SHOW_SPRING.settling_time(0.01);
    element
        .with_animation(
            key,
            Animation::new(Duration::from_secs_f64(settle)),
            move |this, progress| {
                let value = SHOW_SPRING.value(f64::from(progress) * settle, 0.0) as f32;
                this.opacity(value.clamp(0.0, 1.0))
                    .scale(HIDDEN_SCALE + (1.0 - HIDDEN_SCALE) * value)
            },
        )
        .into_any_element()
}

fn pill(label: &str, size: PillSize, fill: Hsla, ink: Hsla) -> gpui::Div {
    div()
        .flex_none()
        .h(px(size.height))
        .min_w(px(size.height))
        .px(px(size.pad_x))
        .rounded(px(size.height / 2.0))
        .bg(fill)
        .flex()
        .items_center()
        .justify_center()
        .text_size(px(size.text))
        .line_height(px(size.height))
        .font_weight(FontWeight::SEMIBOLD)
        .text_color(ink)
        .whitespace_nowrap()
        .child(SharedString::from(label.to_owned()))
}

fn dot(color: Hsla) -> gpui::Div {
    div()
        .flex_none()
        .size(px(UNREAD_DOT))
        .rounded_full()
        .bg(color)
}

pub fn unread_count(unread: &Unread, row_ink: Option<Hsla>, dark: bool) -> AnyElement {
    let ink = unread_ink(ink_is_dark(row_ink, dark));
    let badge = match unread {
        Unread::Dot => dot(ink.row_dot),
        Unread::Count(label) => pill(label, ROW_PILL, ink.row_fill, ink.row_ink),
    };
    shown(
        div().flex_none().ml(px(UNREAD_INLINE_GAP)).child(badge),
        animation_key("row", unread),
    )
}

pub fn tile_unread(unread: &Unread, dark: bool) -> AnyElement {
    let ink = unread_ink(dark);
    let (inset, badge) = match unread {
        Unread::Dot => (TILE_DOT_INSET, dot(ink.row_dot)),
        Unread::Count(label) => (
            TILE_INSET,
            pill(label, TILE_PILL, ink.tile_fill, ink.row_ink),
        ),
    };
    shown(
        div()
            .absolute()
            .top(px(inset))
            .right(px(inset))
            .child(badge),
        animation_key("tile", unread),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn row_ink_follows_the_ink_it_sits_on() {
        assert!(ink_is_dark(Some(gpui::white()), false));
        assert!(!ink_is_dark(Some(gpui::black()), true));
        assert!(ink_is_dark(None, true));
        let dark = unread_ink(true);
        assert!((dark.row_fill.a - 0.16).abs() < 0.01);
        let light = unread_ink(false);
        assert!((light.row_fill.a - 0.11).abs() < 0.01);
    }

    #[test]
    fn the_show_spring_settles_inside_a_second() {
        let settle = SHOW_SPRING.settling_time(0.01);
        assert!(settle > 0.2 && settle < 1.0);
    }
}
