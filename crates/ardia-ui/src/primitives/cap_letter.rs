use gpui::{AnyElement, FontWeight, Hsla, IntoElement, ParentElement, SharedString, Styled, div};

use crate::scale::px;

pub const CAP_HEIGHT: f32 = 0.7046;
pub const INITIAL_SCALE: f32 = 0.64;
pub const INITIAL_NUDGE_X: f32 = 0.25;
pub const NUDGED_UP_TO_PIXELS_PER_POINT: f32 = 2.5;
pub const RETINA_PIXELS_PER_POINT: f32 = 2.0;

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct InitialGlyph {
    pub font_size: f32,
    pub shift_x: f32,
}

fn whole_pixels(pixels: f32) -> bool {
    (pixels - pixels.round()).abs() < 1e-4
}

pub fn cap_fitted_font_size(font_size: f32, side: f32, pixels_per_point: f32) -> f32 {
    let box_pixels = (side * pixels_per_point).round() as i64;
    let cap_pixels = font_size * CAP_HEIGHT * pixels_per_point;
    let below = cap_pixels.floor() as i64;
    let same_parity = if (below - box_pixels).rem_euclid(2) == 0 {
        below
    } else {
        below - 1
    };
    let fitted = if cap_pixels - same_parity as f32 <= 1.0 {
        same_parity
    } else {
        same_parity + 2
    };
    if fitted > 0 {
        fitted as f32 / (CAP_HEIGHT * pixels_per_point)
    } else {
        font_size
    }
}

pub fn initial_glyph(tile: f32, pixels_per_point: f32) -> InitialGlyph {
    let font_size = (tile * INITIAL_SCALE).round();
    if !whole_pixels(tile * pixels_per_point) {
        return InitialGlyph {
            font_size,
            shift_x: 0.0,
        };
    }
    let shift_x = if pixels_per_point <= NUDGED_UP_TO_PIXELS_PER_POINT {
        (2.0 * INITIAL_NUDGE_X * pixels_per_point).floor() / (2.0 * pixels_per_point)
    } else {
        0.0
    };
    if !whole_pixels(pixels_per_point) {
        return InitialGlyph { font_size, shift_x };
    }
    InitialGlyph {
        font_size: cap_fitted_font_size(font_size, tile, pixels_per_point),
        shift_x,
    }
}

pub fn cap_centered_letter(
    letter: impl Into<SharedString>,
    side: f32,
    glyph: InitialGlyph,
    weight: FontWeight,
    color: Hsla,
) -> AnyElement {
    div()
        .flex_none()
        .size(px(side))
        .pl(px(2.0 * glyph.shift_x))
        .flex()
        .items_center()
        .justify_center()
        .text_size(px(glyph.font_size))
        .line_height(px(side))
        .font_weight(weight)
        .text_color(color)
        .whitespace_nowrap()
        .child(letter.into())
        .into_any_element()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn retina_initials_snap_their_cap_height_to_the_tile_parity() {
        let glyph = initial_glyph(14.0, 2.0);
        assert!((glyph.font_size - 12.0 / (CAP_HEIGHT * 2.0)).abs() < 1e-3);
        assert_eq!(glyph.shift_x, 0.25);
        let plain = initial_glyph(14.0, 1.5);
        assert_eq!(plain.font_size, 9.0);
        assert_eq!(plain.shift_x, 0.0);
        let three = initial_glyph(14.0, 3.0);
        assert_eq!(three.shift_x, 0.0);
    }

    #[test]
    fn cap_fit_keeps_the_size_when_nothing_fits() {
        assert_eq!(cap_fitted_font_size(0.4, 14.0, 2.0), 0.4);
    }
}
