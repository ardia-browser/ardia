use ardia_state::tabs::Tab;
use gpui::{AnyElement, IntoElement, ParentElement, Styled, div, rgba};

use crate::host_data::CaptureBadge;
use crate::primitives::icons::{Icon, icon};
use crate::scale::px;
use crate::window::chrome::Chrome;

pub const CAPTURE_DOT_RIM: u32 = 0xFFFFFFE6;

pub fn screen_diameter(size: f32) -> f32 {
    (size * 0.72).round()
}

pub fn dot_diameter(size: f32) -> f32 {
    (size * 0.44).round().max(6.0)
}

pub fn capture_badge(c: &Chrome, badge: CaptureBadge, size: f32) -> AnyElement {
    let p = c.p;
    match badge {
        CaptureBadge::Screen => {
            let d = screen_diameter(size);
            div()
                .absolute()
                .right(px(-d / 3.0))
                .bottom(px(-d / 3.0))
                .size(px(d))
                .rounded_full()
                .bg(p.destructive)
                .flex()
                .items_center()
                .justify_center()
                .child(icon(Icon::ScreenShare, d * 0.5, gpui::white()))
                .into_any_element()
        }
        CaptureBadge::Recording => {
            let d = dot_diameter(size);
            div()
                .absolute()
                .right(px(-d / 4.0))
                .bottom(px(-d / 4.0))
                .size(px(d))
                .rounded_full()
                .bg(p.destructive)
                .border(px(1.0))
                .border_color(rgba(CAPTURE_DOT_RIM))
                .into_any_element()
        }
    }
}

pub fn with_badges(c: &Chrome, tab: &Tab, size: f32, favicon: AnyElement) -> AnyElement {
    match c.host.tab_capture(&tab.id) {
        Some(badge) => div()
            .relative()
            .flex_none()
            .child(favicon)
            .child(capture_badge(c, badge, size))
            .into_any_element(),
        None => favicon,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn badges_scale_with_the_favicon_like_the_old_ones() {
        assert_eq!(screen_diameter(16.0), 12.0);
        assert_eq!(dot_diameter(16.0), 7.0);
        assert_eq!(dot_diameter(10.0), 6.0);
    }
}
