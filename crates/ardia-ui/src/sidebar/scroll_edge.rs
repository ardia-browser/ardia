use std::cell::RefCell;
use std::collections::{HashMap, HashSet};
use std::time::Duration;

use crate::scale::px;
use ardia_theme::layout::sidebar;
use gpui::{
    Animation, AnimationExt, AnyElement, ElementId, IntoElement, ScrollHandle, SharedString,
    Styled, div, prelude::*,
};

use crate::window::chrome::Chrome;

pub const EDGE_GAP: f32 = 4.0;
pub const EDGE_INSET: f32 = 1.0;
pub const EDGE_FADE: Duration = Duration::from_millis(ardia_theme::motion::SCROLL_EDGE_FADE_MS);
pub const SCROLLED_PAST: f32 = 0.5;

pub fn scrolled_past_top(offset: f32) -> bool {
    offset >= SCROLLED_PAST
}

pub fn hidden_below(offset: f32, viewport: f32, content: f32) -> bool {
    viewport > 0.0 && offset + viewport < content - 1.0
}

pub fn toolbar_edge_lift(header: f32, card_top: f32, toolbar: f32) -> f32 {
    let sidebar_line =
        header + (sidebar::PINNED_TOP - sidebar::HEADER) - EDGE_INSET - sidebar::SCROLL_EDGE_LINE;
    let toolbar_line = card_top + toolbar - sidebar::SCROLL_EDGE_LINE;
    (sidebar_line - toolbar_line).max(0.0)
}

#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct Span {
    pub offset: f32,
    pub viewport: f32,
    pub content: f32,
}

pub fn span_of(handle: &ScrollHandle) -> Span {
    let viewport = crate::scale::points(handle.bounds().size.height);
    let max = crate::scale::points(handle.max_offset().y);
    Span {
        offset: -crate::scale::points(handle.offset().y),
        viewport,
        content: viewport + max,
    }
}

thread_local! {
    static HANDLES: RefCell<HashMap<String, ScrollHandle>> = RefCell::new(HashMap::new());
    static SEEN: RefCell<HashSet<String>> = RefCell::new(HashSet::new());
}

pub fn handle(key: &str) -> ScrollHandle {
    HANDLES.with(|handles| {
        handles
            .borrow_mut()
            .entry(key.to_owned())
            .or_default()
            .clone()
    })
}

fn seen(key: &str, shown: bool) -> bool {
    SEEN.with(|seen| {
        let mut seen = seen.borrow_mut();
        if shown {
            seen.insert(key.to_owned());
            true
        } else {
            seen.contains(key)
        }
    })
}

pub fn edge_line(c: &Chrome, key: String, shown: bool) -> Option<AnyElement> {
    if !seen(&key, shown) {
        return None;
    }
    let color = c.p.divider;
    let id = ElementId::Name(SharedString::from(format!(
        "{key}:{}",
        if shown { "in" } else { "out" }
    )));
    Some(
        div()
            .id(ElementId::Name(SharedString::from(key)))
            .h(px(sidebar::SCROLL_EDGE_LINE))
            .w_full()
            .bg(color)
            .with_animation(
                id,
                Animation::new(EDGE_FADE).with_easing(|t| {
                    ardia_theme::motion::CubicBezier::HOVER_CARD.ease(f64::from(t)) as f32
                }),
                move |this, delta| this.opacity(if shown { delta } else { 1.0 - delta }),
            )
            .into_any_element(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_top_edge_shows_once_scrolled_half_a_point() {
        assert!(!scrolled_past_top(0.0));
        assert!(!scrolled_past_top(0.4));
        assert!(scrolled_past_top(0.5));
    }

    #[test]
    fn the_bottom_edge_shows_while_rows_hide_below() {
        assert!(hidden_below(0.0, 300.0, 600.0));
        assert!(!hidden_below(300.0, 300.0, 600.0));
        assert!(!hidden_below(299.5, 300.0, 600.0));
        assert!(!hidden_below(0.0, 0.0, 600.0));
    }

    #[test]
    fn the_edge_lifts_to_the_toolbar_line_when_lower() {
        assert_eq!(toolbar_edge_lift(46.0, 9.0, 44.0), 0.0);
        assert_eq!(toolbar_edge_lift(46.0, 6.0, 40.0), 7.0);
    }
}
