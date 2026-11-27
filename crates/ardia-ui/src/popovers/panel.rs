use ardia_theme::layout::panel;
use ardia_theme::tokens::{TypeSize, radius, space};
use gpui::{
    AnyElement, App, ClickEvent, ElementId, FontWeight, Hsla, IntoElement, ParentElement,
    SharedString, Styled, Window, div, prelude::*,
};

use crate::look::Palette;
use crate::primitives::controls::{glass_panel, shadow};
use crate::primitives::icons::{Icon, icon};
use crate::scale::px;

pub const PILL_HEIGHT: f32 = 28.0;
pub const VALUE_HEIGHT: f32 = 22.0;
pub const VALUE_PAD: f32 = space::S;

pub fn surface(id: impl Into<ElementId>, width: f32, p: &Palette) -> gpui::Stateful<gpui::Div> {
    glass_panel(id, false, panel::RADIUS, p)
        .w(px(width))
        .flex()
        .flex_col()
        .text_color(p.text)
}

pub fn header(
    glyph: AnyElement,
    title: impl Into<SharedString>,
    accessory: Option<AnyElement>,
    p: &Palette,
) -> AnyElement {
    div()
        .flex()
        .items_center()
        .gap(px(panel::ICON_GAP))
        .px(px(panel::INSET))
        .pt(px(panel::INSET))
        .pb(px(panel::HEADER_GAP))
        .child(
            div()
                .flex_none()
                .size(px(panel::ICON_SLOT))
                .flex()
                .items_center()
                .justify_center()
                .child(glyph),
        )
        .child(
            div()
                .flex_1()
                .min_w_0()
                .truncate()
                .text_size(px(TypeSize::Body.points()))
                .line_height(px(TypeSize::Body.line_height()))
                .font_weight(FontWeight::SEMIBOLD)
                .text_color(p.text)
                .child(title.into()),
        )
        .children(accessory)
        .into_any_element()
}

pub fn pill_with(
    primary: bool,
    id: impl Into<ElementId>,
    title: impl Into<SharedString>,
    p: &Palette,
    on_click: impl Fn(&ClickEvent, &mut Window, &mut App) + 'static,
) -> AnyElement {
    let (fill, hover, pressed, ink) = if primary {
        (p.go, p.go_hover, p.go_pressed, p.on_go)
    } else {
        (
            p.prompt_fill,
            p.prompt_fill_hover,
            p.prompt_fill_pressed,
            p.text,
        )
    };
    div()
        .id(id)
        .flex_none()
        .h(px(PILL_HEIGHT))
        .px(px(space::L))
        .rounded(px(radius::TILE))
        .flex()
        .items_center()
        .justify_center()
        .bg(fill)
        .hover(move |style| style.bg(hover))
        .active(move |style| style.bg(pressed))
        .cursor_pointer()
        .text_size(px(TypeSize::Body.points()))
        .font_weight(FontWeight::MEDIUM)
        .text_color(ink)
        .on_click(move |event, window, cx| {
            cx.stop_propagation();
            on_click(event, window, cx);
        })
        .child(title.into())
        .into_any_element()
}

pub fn pill(
    id: impl Into<ElementId>,
    title: impl Into<SharedString>,
    p: &Palette,
    on_click: impl Fn(&ClickEvent, &mut Window, &mut App) + 'static,
) -> AnyElement {
    pill_with(false, id, title, p, on_click)
}

pub fn primary_pill(
    id: impl Into<ElementId>,
    title: impl Into<SharedString>,
    p: &Palette,
    on_click: impl Fn(&ClickEvent, &mut Window, &mut App) + 'static,
) -> AnyElement {
    pill_with(true, id, title, p, on_click)
}

pub fn value_button(
    id: impl Into<ElementId>,
    title: impl Into<SharedString>,
    chevron: Icon,
    p: &Palette,
    on_click: impl Fn(&ClickEvent, &mut Window, &mut App) + 'static,
) -> AnyElement {
    let hover = p.toolbar_hover;
    div()
        .id(id)
        .flex_none()
        .mr(px(-VALUE_PAD))
        .h(px(VALUE_HEIGHT))
        .pl(px(space::M))
        .pr(px(VALUE_PAD))
        .rounded(px(radius::CONTROL))
        .flex()
        .items_center()
        .gap(px(space::XS))
        .hover(move |style| style.bg(hover))
        .cursor_pointer()
        .on_click(on_click)
        .child(
            div()
                .text_size(px(TypeSize::Small.points()))
                .text_color(p.text_secondary)
                .child(title.into()),
        )
        .child(icon(chevron, 9., p.text_secondary))
        .into_any_element()
}

pub fn icon_tile(glyph: Icon, fill: Hsla, ink: Hsla) -> AnyElement {
    div()
        .flex_none()
        .size(px(28.))
        .rounded(px(radius::TILE))
        .bg(fill)
        .flex()
        .items_center()
        .justify_center()
        .child(icon(glyph, 13., ink))
        .into_any_element()
}

pub fn card_shadow(p: &Palette) -> Vec<gpui::BoxShadow> {
    vec![shadow(p.shadow.opacity(0.8), 6., 16.)]
}
