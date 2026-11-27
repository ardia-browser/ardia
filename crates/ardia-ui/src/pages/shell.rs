use crate::scale::px;
use gpui::{
    AnyElement, App, ElementId, Entity, FontWeight, IntoElement, ParentElement, SharedString,
    Styled, Window, div, prelude::*,
};

use crate::look::Palette;
use crate::primitives::icons::{Icon, icon};
use crate::primitives::text_input::{InputStyle, TextInput};

pub const SEARCH_MAX_WIDTH: f32 = 480.0;

pub fn search_field(
    key: impl Into<SharedString>,
    placeholder: &'static str,
    initial: &str,
    p: &Palette,
    window: &mut Window,
    cx: &mut App,
) -> Entity<TextInput> {
    let style = InputStyle {
        text: p.text,
        placeholder: p.placeholder,
        caret: p.caret,
        selection: p.selection,
        font_size: 13.0,
        weight: FontWeight::NORMAL,
    };
    let initial = initial.to_owned();
    window.use_keyed_state(ElementId::Name(key.into()), cx, move |_, cx| {
        let mut input = TextInput::new(placeholder, cx);
        input.set_style(style, cx);
        if !initial.is_empty() {
            input.set_text(initial, false, cx);
        }
        input
    })
}

pub const EMPTY_ICON: f32 = 30.0;
pub const EMPTY_ICON_BOX: f32 = 40.0;
pub const EMPTY_LIFT: f32 = 80.0;

pub fn empty_state(glyph: Icon, title: impl Into<SharedString>, p: &Palette) -> AnyElement {
    div()
        .size_full()
        .flex()
        .flex_col()
        .items_center()
        .justify_center()
        .gap(px(8.))
        .pb(px(EMPTY_LIFT))
        .child(
            div()
                .size(px(EMPTY_ICON_BOX))
                .flex()
                .items_center()
                .justify_center()
                .child(icon(glyph, EMPTY_ICON, p.text_tertiary)),
        )
        .child(
            div()
                .text_size(px(15.))
                .font_weight(FontWeight::MEDIUM)
                .text_color(p.text_secondary)
                .child(title.into()),
        )
        .into_any_element()
}

pub const PAGE_WIDTH: f32 = 880.0;
pub const PAGE_TOOLBAR_HEIGHT: f32 = 64.0;
pub const PAGE_TOOLBAR_PAD_X: f32 = 24.0;
pub const PAGE_TOOLBAR_GAP: f32 = 16.0;
pub const PAGE_SIDE_WIDTH: f32 = 200.0;
pub const PAGE_TITLE_SIZE: f32 = 22.0;
pub const PAGE_TITLE_NUDGE: f32 = -2.0;

pub fn page_header(
    title: &'static str,
    search: Option<AnyElement>,
    actions: Option<AnyElement>,
    p: &Palette,
) -> AnyElement {
    div()
        .flex_none()
        .h(px(PAGE_TOOLBAR_HEIGHT))
        .px(px(PAGE_TOOLBAR_PAD_X))
        .flex()
        .items_center()
        .gap(px(PAGE_TOOLBAR_GAP))
        .child(
            div()
                .flex_none()
                .w(px(PAGE_SIDE_WIDTH))
                .relative()
                .top(px(PAGE_TITLE_NUDGE))
                .text_size(px(PAGE_TITLE_SIZE))
                .font_weight(FontWeight::SEMIBOLD)
                .text_color(p.text)
                .child(title),
        )
        .child(div().flex_1().min_w_0().flex().justify_center().when_some(
            search,
            |this, search| {
                this.child(
                    div()
                        .id("page-search")
                        .debug_selector(|| "page-search".into())
                        .w_full()
                        .max_w(px(SEARCH_MAX_WIDTH))
                        .h(px(28.))
                        .px(px(8.))
                        .rounded(px(7.))
                        .bg(p.field)
                        .border(px(0.5))
                        .border_color(p.field_border)
                        .flex()
                        .items_center()
                        .gap(px(6.))
                        .child(icon(Icon::Search, 12., p.text_tertiary))
                        .child(div().flex_1().min_w_0().child(search)),
                )
            },
        ))
        .child(
            div()
                .flex_none()
                .w(px(PAGE_SIDE_WIDTH))
                .flex()
                .justify_end()
                .items_center()
                .gap(px(8.))
                .children(actions),
        )
        .into_any_element()
}

pub fn page_frame_with(
    id: &'static str,
    header: AnyElement,
    body: AnyElement,
    overlay: Option<AnyElement>,
) -> AnyElement {
    div()
        .id(id)
        .debug_selector(move || id.into())
        .size_full()
        .relative()
        .flex()
        .flex_col()
        .overflow_hidden()
        .child(header)
        .child(div().flex_1().min_h_0().relative().child(body))
        .children(overlay)
        .into_any_element()
}
