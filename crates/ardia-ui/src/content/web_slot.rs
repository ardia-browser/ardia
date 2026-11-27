use crate::scale::px;
use ardia_state::omnibox::url::display_url;
use ardia_state::tabs::Tab;
use gpui::{
    AnyElement, FontWeight, IntoElement, NativeView, ParentElement, SharedString, Styled, div,
    prelude::*, relative,
};

use crate::look::Palette;
use crate::primitives::controls::spinner;
use crate::primitives::favicon::render_favicon;
use crate::window::chrome::{Chrome, tab_title};

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct SlotCorners {
    pub top: f32,
    pub bottom: f32,
}

impl SlotCorners {
    pub fn native(&self) -> gpui::Corners<gpui::Pixels> {
        gpui::Corners {
            top_left: px(self.top),
            top_right: px(self.top),
            bottom_right: px(self.bottom),
            bottom_left: px(self.bottom),
        }
    }
}

pub fn placeholder(c: &Chrome, tab: &Tab, corners: SlotCorners) -> AnyElement {
    let p: &Palette = c.p;
    let url = SharedString::from(display_url(&tab.url));
    let loading = tab.live.loading;
    div()
        .id(SharedString::from(format!("web-placeholder:{}", tab.id)))
        .debug_selector(|| "web-placeholder".into())
        .size_full()
        .relative()
        .rounded_t(px(corners.top))
        .rounded_b(px(corners.bottom))
        .bg(p.card)
        .overflow_hidden()
        .flex()
        .flex_col()
        .items_center()
        .justify_center()
        .gap(px(10.))
        .when(loading, |this| {
            this.child(
                div()
                    .absolute()
                    .left_0()
                    .top_0()
                    .h(px(2.))
                    .w(relative(tab.live.progress.clamp(0.05, 1.0)))
                    .bg(p.accent),
            )
        })
        .child(render_favicon(&c.favicon(tab), 32., p))
        .child(
            div()
                .max_w(px(520.))
                .px(px(24.))
                .text_size(px(15.))
                .font_weight(FontWeight::SEMIBOLD)
                .text_color(p.text)
                .truncate()
                .child(tab_title(tab)),
        )
        .child(
            div()
                .max_w(px(520.))
                .px(px(24.))
                .text_size(px(12.))
                .text_color(p.text_tertiary)
                .truncate()
                .child(url),
        )
        .when(loading, |this| this.child(spinner(14., p.text_secondary)))
        .into_any_element()
}

pub fn web_slot(
    c: &Chrome,
    tab: &Tab,
    page: Option<NativeView>,
    devtools: Option<NativeView>,
    corners: SlotCorners,
) -> AnyElement {
    if let Some(internal) = crate::pages::InternalPage::of(&tab.url)
        .and_then(|internal| crate::pages::internal_page(c, tab, &internal))
    {
        return div()
            .size_full()
            .rounded_t(px(corners.top))
            .rounded_b(px(corners.bottom))
            .overflow_hidden()
            .child(internal)
            .into_any_element();
    }
    let Some(page) = page else {
        return placeholder(c, tab, corners);
    };
    div()
        .size_full()
        .flex()
        .rounded_t(px(corners.top))
        .rounded_b(px(corners.bottom))
        .overflow_hidden()
        .child(div().flex_1().min_w_0().h_full().child(page))
        .when_some(devtools, |this, devtools| {
            this.child(
                div()
                    .flex_none()
                    .w(relative(0.38))
                    .h_full()
                    .border_l(px(1.))
                    .border_color(c.p.divider)
                    .child(devtools),
            )
        })
        .into_any_element()
}
