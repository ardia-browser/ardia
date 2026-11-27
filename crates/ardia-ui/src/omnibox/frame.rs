use crate::window::layout::Rect;

pub const PANEL_TEXT_LEFT: f32 = 48.0;
pub const RIGHT_OF_URL: f32 = 40.0;
pub const ABOVE_PANE: f32 = 5.5;
pub const MIN_WIDTH: f32 = 420.0;
pub const WINDOW_MARGIN: f32 = 12.0;
pub const DROPDOWN_MIN_WIDTH: f32 = 350.0;
pub const DROPDOWN_PAST_FIELD: f32 = 137.0;
pub const CENTRED_TOP_SHARE: f32 = 0.22;
pub const MIN_TOP: f32 = 0.5;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Variant {
    Panel,
    Floating,
    Hero,
    Dropdown,
}

impl Variant {
    pub fn hero(self) -> bool {
        self == Variant::Hero
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct UrlAnchor {
    pub left: f32,
    pub top: f32,
    pub width: f32,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Frame {
    pub left: f32,
    pub top: f32,
    pub width: f32,
}

pub fn url_text_left(insecure: bool) -> f32 {
    use crate::content::toolbar::{FIELD_TEXT_LEFT, LOCK_GAP, LOCK_LEFT, LOCK_WIDTH};
    if insecure {
        LOCK_LEFT + LOCK_WIDTH + LOCK_GAP
    } else {
        FIELD_TEXT_LEFT
    }
}

fn room(window_width: f32, left: f32, fallback: f32) -> f32 {
    if window_width > 0.0 {
        window_width - left - WINDOW_MARGIN
    } else {
        fallback
    }
}

pub fn field_frame(anchor: UrlAnchor, insecure: bool, window_width: f32) -> Frame {
    let left = (anchor.left + url_text_left(insecure) - PANEL_TEXT_LEFT).max(WINDOW_MARGIN);
    let top = (anchor.top - ABOVE_PANE).max(MIN_TOP);
    let covering = anchor.left + anchor.width + RIGHT_OF_URL - left;
    let width = covering
        .max(MIN_WIDTH)
        .min(room(window_width, left, covering));
    Frame { left, top, width }
}

pub fn bar_width(view_width: f32) -> f32 {
    let content = if view_width < 708.0 {
        if view_width <= 636.0 {
            view_width - 20.0
        } else {
            616.0
        }
    } else if view_width < 1700.0 {
        652.0
    } else {
        774.0
    };
    content.min(view_width - 28.0)
}

pub fn centred_bar_left(card: Rect, width: f32, window_width: f32) -> f32 {
    let centre = if window_width > 0.0 {
        window_width / 2.0
    } else {
        card.x + card.w / 2.0
    };
    (centre - width / 2.0).max(card.x).min(card.right() - width)
}

pub fn centred_frame(card: Rect, window_width: f32) -> Frame {
    let width = bar_width(card.w);
    let left = centred_bar_left(card, width, window_width);
    let top = card.y + WINDOW_MARGIN.max((card.h * CENTRED_TOP_SHARE).round());
    Frame { left, top, width }
}

pub fn dropdown_frame(anchor: UrlAnchor, sidebar_right: bool, window_width: f32) -> Frame {
    let shown =
        anchor.left >= 0.0 && (!sidebar_right || window_width <= 0.0 || anchor.left < window_width);
    let wanted = DROPDOWN_MIN_WIDTH.max(anchor.width + DROPDOWN_PAST_FIELD);
    let end = if shown {
        anchor.left + anchor.width
    } else {
        window_width - WINDOW_MARGIN
    };
    let left = if sidebar_right {
        WINDOW_MARGIN.max(end - wanted)
    } else if shown {
        anchor.left
    } else {
        WINDOW_MARGIN
    };
    let width = if sidebar_right {
        end - left
    } else {
        wanted.min(room(window_width, left, DROPDOWN_MIN_WIDTH))
    };
    Frame {
        left,
        top: anchor.top,
        width,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_field_panel_sits_over_the_url_text_like_the_old_one() {
        let anchor = UrlAnchor {
            left: 300.0 + 145.0,
            top: 6.0,
            width: 800.0,
        };
        let frame = field_frame(anchor, false, 1512.0);
        assert_eq!(frame.left, 445.0 + 8.0 - 48.0);
        assert_eq!(frame.top, 0.5);
        assert_eq!(frame.width, 445.0 + 800.0 + 40.0 - 405.0);
        let insecure = field_frame(anchor, true, 1512.0);
        assert_eq!(insecure.left, 445.0 + 29.0 - 48.0);
        let low = field_frame(
            UrlAnchor {
                top: 50.0,
                ..anchor
            },
            false,
            1512.0,
        );
        assert_eq!(low.top, 44.5);
    }

    #[test]
    fn a_short_url_field_still_gets_the_minimum_width_unless_the_window_is_narrower() {
        let anchor = UrlAnchor {
            left: 100.0,
            top: 6.0,
            width: 120.0,
        };
        assert_eq!(field_frame(anchor, false, 1400.0).width, 420.0);
        let narrow = field_frame(anchor, false, 400.0);
        assert_eq!(narrow.width, 400.0 - narrow.left - 12.0);
        assert_eq!(
            field_frame(
                UrlAnchor {
                    left: 0.0,
                    ..anchor
                },
                false,
                1400.0
            )
            .left,
            12.0
        );
    }

    #[test]
    fn the_centred_bar_takes_the_new_tab_width_and_sits_a_fifth_down() {
        let card = Rect::new(310.0, 6.0, 1196.0, 900.0);
        let frame = centred_frame(card, 1512.0);
        assert_eq!(frame.width, 652.0);
        assert_eq!(frame.left, 756.0 - 326.0);
        assert_eq!(frame.top, 6.0 + 198.0);
        assert_eq!(bar_width(1700.0), 774.0);
        assert_eq!(bar_width(1699.0), 652.0);
        assert_eq!(bar_width(650.0), 616.0);
        assert_eq!(bar_width(600.0), 572.0);
        let tight = centred_frame(Rect::new(900.0, 6.0, 700.0, 50.0), 1000.0);
        assert_eq!(tight.left, 900.0);
        assert_eq!(tight.top, 18.0);
    }

    #[test]
    fn the_sidebar_dropdown_grows_past_the_field() {
        let anchor = UrlAnchor {
            left: 10.0,
            top: 40.0,
            width: 220.0,
        };
        let left = dropdown_frame(anchor, false, 1400.0);
        assert_eq!((left.left, left.top, left.width), (10.0, 40.0, 357.0));
        let right = dropdown_frame(
            UrlAnchor {
                left: 1170.0,
                ..anchor
            },
            true,
            1400.0,
        );
        assert_eq!(right.left + right.width, 1390.0);
        assert_eq!(right.width, 357.0);
    }
}
