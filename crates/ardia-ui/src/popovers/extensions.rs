use std::cell::RefCell;
use std::collections::HashMap;

use ardia_state::WindowId;
use ardia_theme::layout::panel;
use gpui::{
    AnyElement, Bounds, Hsla, IntoElement, ParentElement, Pixels, Styled, canvas, div, prelude::*,
    rgba,
};

use crate::host_data::ExtensionPopupView;
use crate::popovers::panel::card_shadow;
use crate::scale::px;
use crate::window::chrome::Chrome;

pub const POPUP_MIN: (f32, f32) = (25.0, 25.0);
pub const POPUP_MAX: (f32, f32) = (800.0, 600.0);
pub const POPUP_EDGE: f32 = 8.0;
pub const POPUP_GAP: f32 = 6.0;
pub const MANAGE_URL: &str = "chrome://extensions";
pub const WEB_STORE_URL: &str = "https://chromewebstore.google.com/category/extensions";

thread_local! {
    static ANCHORS: RefCell<HashMap<(WindowId, String), Bounds<Pixels>>> = RefCell::new(HashMap::new());
}

pub fn record_anchor(window: &WindowId, slot: &str, bounds: Bounds<Pixels>) {
    ANCHORS.with(|anchors| {
        anchors
            .borrow_mut()
            .insert((window.clone(), slot.to_owned()), bounds);
    });
}

pub fn anchor_of(window: &WindowId, slot: &str) -> Option<Bounds<Pixels>> {
    ANCHORS.with(|anchors| {
        let anchors = anchors.borrow();
        anchors
            .get(&(window.clone(), slot.to_owned()))
            .or_else(|| anchors.get(&(window.clone(), "*".to_owned())))
            .copied()
    })
}

pub fn anchor_probe(window: &WindowId, slot: &str) -> AnyElement {
    let window = window.clone();
    let slot = slot.to_owned();
    canvas(
        move |bounds, _, _| record_anchor(&window, &slot, bounds),
        |_, _, _, _| {},
    )
    .absolute()
    .inset_0()
    .into_any_element()
}

fn border(c: &Chrome) -> Hsla {
    if c.look.dark {
        rgba(0xFFFFFF29).into()
    } else {
        rgba(0x00000024).into()
    }
}

pub fn popup_size(popup: &ExtensionPopupView) -> (f32, f32) {
    let (width, height) = if popup.sized { popup.size } else { POPUP_MIN };
    let clamp = |value: f32, min: f32, max: f32| {
        if value.is_finite() {
            value.ceil().clamp(min, max)
        } else {
            min
        }
    };
    (
        clamp(width, POPUP_MIN.0, POPUP_MAX.0) + 1.0,
        clamp(height, POPUP_MIN.1, POPUP_MAX.1) + 1.0,
    )
}

pub fn popup_origin(anchor: (f32, f32, f32, f32), width: f32, window_width: f32) -> (f32, f32) {
    let (x, y, w, h) = anchor;
    let right = x + w - width;
    let left = if window_width > 0.0 {
        right.min(window_width - width - POPUP_EDGE).max(POPUP_EDGE)
    } else {
        right.max(POPUP_EDGE)
    };
    (left, y + h + POPUP_GAP)
}

pub fn extension_popup(
    c: &Chrome,
    popup: &ExtensionPopupView,
    window_width: f32,
    body: Option<AnyElement>,
) -> AnyElement {
    let (width, height) = popup_size(popup);
    let anchor = anchor_of(&c.window.id, &popup.extension_id)
        .map(|bounds| {
            (
                crate::scale::points(bounds.origin.x),
                crate::scale::points(bounds.origin.y),
                crate::scale::points(bounds.size.width),
                crate::scale::points(bounds.size.height),
            )
        })
        .unwrap_or_else(|| {
            let page = c.layout.page();
            (
                page.right() - panel::POPOVER_MARGIN,
                page.y - POPUP_GAP,
                0.0,
                0.0,
            )
        });
    let (left, top) = popup_origin(anchor, width, window_width);
    let sized = popup.sized;
    let card = div()
        .id("extension-popup")
        .debug_selector(|| "extension-popup".into())
        .w(px(width))
        .h(px(height))
        .occlude()
        .opacity(if popup.sized { 1.0 } else { 0.0 })
        .rounded(px(panel::RADIUS))
        .border(px(0.5))
        .border_color(border(c))
        .shadow(card_shadow(c.p))
        .child(
            div()
                .size_full()
                .rounded(px(panel::RADIUS))
                .overflow_hidden()
                .bg(gpui::white())
                .children(body),
        );
    let card = if sized {
        crate::primitives::appear::rise(
            "extension-popup-in",
            card,
            crate::primitives::appear::Rise::lift(false),
        )
    } else {
        card.into_any_element()
    };
    div()
        .absolute()
        .left(px(left))
        .top(px(top))
        .child(card)
        .into_any_element()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn popup(size: (f32, f32), sized: bool) -> ExtensionPopupView {
        ExtensionPopupView {
            extension_id: "x".into(),
            name: "X".into(),
            view: None,
            size,
            sized,
        }
    }

    #[test]
    fn popups_size_like_the_old_action_popup() {
        assert_eq!(popup_size(&popup((320.0, 480.0), true)), (321.0, 481.0));
        assert_eq!(popup_size(&popup((5000.0, 1.0), true)), (801.0, 26.0));
        assert_eq!(
            popup_size(&popup((f32::NAN, f32::INFINITY), true)),
            (26.0, 26.0)
        );
        assert_eq!(popup_size(&popup((320.0, 480.0), false)), (26.0, 26.0));
    }

    #[test]
    fn popups_hang_under_their_button_and_stay_on_screen() {
        assert_eq!(
            popup_origin((900.0, 10.0, 28.0, 28.0), 300.0, 1200.0),
            (628.0, 44.0)
        );
        assert_eq!(
            popup_origin((100.0, 10.0, 28.0, 28.0), 300.0, 1200.0),
            (8.0, 44.0)
        );
        assert_eq!(
            popup_origin((1180.0, 10.0, 28.0, 28.0), 300.0, 1200.0),
            (892.0, 44.0)
        );
    }
}
