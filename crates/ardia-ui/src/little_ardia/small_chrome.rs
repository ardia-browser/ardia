use crate::scale::px;
use ardia_state::omnibox::url::breadcrumb_host;
use ardia_state::tabs::{SecurityState, Tab};
use gpui::{
    AnyElement, FontWeight, IntoElement, ParentElement, SharedString, Styled, div, prelude::*,
};

use crate::look::Palette;
use crate::primitives::controls::IconButton;
use crate::primitives::fade_label::fade_label;
use crate::primitives::favicon::render_favicon;
use crate::primitives::icons::{Icon, icon};
use crate::window::chrome::Chrome;

pub const SMALL_BAR_BUTTON: f32 = 28.0;
pub const SMALL_BAR_GAP: f32 = 2.0;
pub const SMALL_FIELD_GAP: f32 = 6.0;
pub const SMALL_FIELD_HEIGHT: f32 = 28.0;
pub const SMALL_BUTTON_RADIUS: f32 = 7.0;
pub const SMALL_BUTTON_GLYPH: f32 = 13.0;
pub const SMALL_INSET: f32 = ardia_theme::layout::CARD_INSET;
pub const SMALL_WINDOW_RADIUS: f32 = 16.0;
pub const TRAFFIC_LIGHT_PITCH: f32 = 23.0;
pub const NAV_CENTER_PAST_ZOOM: f32 = 27.0;
pub const PAGE_ICON_BOX: f32 = 16.0;
pub const PAGE_ICON_GLYPH: f32 = 12.0;
pub const FIELD_RADIUS: f32 = 8.0;
pub const HOST_MAX_SHARE: f32 = 0.6;
pub const TITLE_FADE: f32 = 14.0;
pub const TITLE_LEAD: f32 = 2.0;
pub const SEARCH_PLACEHOLDER: &str = "Search or enter address";

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct SmallWindowFrame {
    pub outer_rim: (f32, f32),
    pub inner_rim: (f32, f32),
    pub shadow_opacity: f32,
    pub shadow_radius: f32,
    pub shadow_y: f32,
}

pub const fn small_window_frame(dark: bool) -> SmallWindowFrame {
    if dark {
        SmallWindowFrame {
            outer_rim: (0.0, 0.95),
            inner_rim: (1.0, 0.1),
            shadow_opacity: 0.66,
            shadow_radius: 23.0,
            shadow_y: 21.0,
        }
    } else {
        SmallWindowFrame {
            outer_rim: (0.0, 0.15),
            inner_rim: (1.0, 0.0),
            shadow_opacity: 0.38,
            shadow_radius: 23.0,
            shadow_y: 21.0,
        }
    }
}

pub fn buttons_width(count: usize) -> f32 {
    count as f32 * SMALL_BAR_BUTTON + count.saturating_sub(1) as f32 * SMALL_BAR_GAP
}

pub fn page_host_label(url: &str) -> String {
    if url.starts_with("file:") {
        "File".to_owned()
    } else {
        breadcrumb_host(url)
    }
}

pub struct SmallButton {
    pub id: SharedString,
    pub glyph: Icon,
    pub tooltip: SharedString,
    pub disabled: bool,
    pub msg: crate::msg::Msg,
}

pub fn small_button(c: &Chrome, button: SmallButton) -> AnyElement {
    shaped_small_button(c, button, SMALL_BUTTON_RADIUS)
}

pub fn shaped_small_button(c: &Chrome, button: SmallButton, radius: f32) -> AnyElement {
    let selector = button.id.to_string();
    div()
        .flex_none()
        .debug_selector(move || selector)
        .child(
            IconButton::new(button.id, button.glyph, c.p)
                .square(SMALL_BAR_BUTTON, radius)
                .glyph(SMALL_BUTTON_GLYPH)
                .disabled(button.disabled)
                .tooltip(button.tooltip, c.p)
                .on_click(c.emit.click(button.msg)),
        )
        .into_any_element()
}

pub fn page_label(c: &Chrome, tab: &Tab, hovered: bool) -> AnyElement {
    let p: &Palette = c.p;
    let insecure = !tab.url.is_empty()
        && matches!(
            tab.live.security,
            SecurityState::Insecure | SecurityState::Dangerous
        );
    let leading = if insecure {
        div()
            .flex_none()
            .size(px(16.))
            .flex()
            .items_center()
            .justify_center()
            .child(
                icon(Icon::LockWarning, PAGE_ICON_GLYPH, p.text_secondary)
                    .fit_within(PAGE_ICON_BOX, PAGE_ICON_BOX),
            )
            .into_any_element()
    } else if !tab.url.is_empty() {
        render_favicon(&c.favicon(tab), 16., p)
    } else {
        div()
            .flex_none()
            .size(px(16.))
            .flex()
            .items_center()
            .justify_center()
            .child(
                icon(Icon::Search, PAGE_ICON_GLYPH, p.placeholder)
                    .fit_within(PAGE_ICON_BOX, PAGE_ICON_BOX),
            )
            .into_any_element()
    };
    let host = page_host_label(&tab.url);
    let title = tab.own_title();
    let body = if tab.url.is_empty() {
        div()
            .flex_1()
            .min_w_0()
            .truncate()
            .text_size(px(13.))
            .text_color(p.placeholder)
            .child(SEARCH_PLACEHOLDER)
            .into_any_element()
    } else {
        div()
            .flex_1()
            .min_w_0()
            .flex()
            .items_center()
            .overflow_hidden()
            .child(
                div()
                    .flex_none()
                    .max_w(gpui::relative(HOST_MAX_SHARE))
                    .truncate()
                    .text_size(px(13.))
                    .font_weight(FontWeight::MEDIUM)
                    .text_color(p.text)
                    .child(SharedString::from(host.clone())),
            )
            .when(!title.is_empty() && title != host, |this| {
                this.child(
                    div()
                        .flex_1()
                        .min_w_0()
                        .pl(px(TITLE_LEAD))
                        .h(px(18.))
                        .child(
                            fade_label(format!("\u{a0}\u{a0}{title}"), p.text_secondary, 13.)
                                .fade_width(TITLE_FADE),
                        ),
                )
            })
            .into_any_element()
    };
    div()
        .size_full()
        .flex()
        .items_center()
        .gap(px(8.))
        .px(px(8.))
        .rounded(px(FIELD_RADIUS))
        .when(hovered, |this| this.bg(p.toolbar_hover))
        .child(leading)
        .child(body)
        .into_any_element()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn small_bar_buttons_sit_two_points_apart() {
        assert_eq!(buttons_width(0), 0.0);
        assert_eq!(buttons_width(1), 28.0);
        assert_eq!(buttons_width(3), 88.0);
    }

    #[test]
    fn a_page_glyph_wider_than_its_box_shrinks_to_fit_like_the_old_symbol_view() {
        let fit =
            crate::primitives::symbol_glyphs::symbol_fit(18.4, 15.0, PAGE_ICON_BOX, PAGE_ICON_BOX);
        assert!((fit - 16.0 / 18.4).abs() < 1e-4);
        assert_eq!(
            crate::primitives::symbol_glyphs::symbol_fit(14.0, 12.0, PAGE_ICON_BOX, PAGE_ICON_BOX),
            1.0
        );
    }

    #[test]
    fn file_pages_are_labelled_file() {
        assert_eq!(page_host_label("file:///Users/me/a.html"), "File");
        assert_eq!(
            page_host_label("https://www.example.com/a"),
            breadcrumb_host("https://www.example.com/a")
        );
    }
}
