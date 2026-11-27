use ardia_theme::tokens::{TypeSize, radius, shadow, space};
use gpui::{
    AnyElement, App, FontWeight, IntoElement, MouseButton, MouseDownEvent, ParentElement,
    SharedString, Styled, Window, deferred, div, prelude::*,
};

use super::tokens::dialog;
use crate::look::Palette;
use crate::primitives::sheets::panel_surface;
use crate::scale::px;

pub fn dialog_frame(
    id: &'static str,
    width: f32,
    pad: f32,
    max_height: Option<f32>,
    p: &Palette,
    content: AnyElement,
    on_dismiss: impl Fn(&MouseDownEvent, &mut Window, &mut App) + 'static,
) -> AnyElement {
    let surface = panel_surface(p, radius::SHEET, shadow::DIALOG)
        .id(SharedString::new_static(id))
        .debug_selector(move || id.to_owned())
        .occlude()
        .w(px(width))
        .when_some(max_height, |this, h| this.max_h(px(h)))
        .p(px(pad))
        .text_color(p.text)
        .flex()
        .flex_col()
        .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
        .child(content);
    deferred(
        div()
            .absolute()
            .inset_0()
            .flex()
            .items_center()
            .justify_center()
            .child(
                div()
                    .absolute()
                    .inset_0()
                    .bg(p.scrim)
                    .on_mouse_down(MouseButton::Left, on_dismiss),
            )
            .child(surface),
    )
    .with_priority(3)
    .into_any_element()
}

pub fn dialog_title(
    title: impl Into<SharedString>,
    subtitle: Option<String>,
    leading: Option<AnyElement>,
    p: &Palette,
) -> AnyElement {
    let text = div()
        .flex_1()
        .flex()
        .flex_col()
        .child(
            div()
                .text_size(px(TypeSize::Title.points()))
                .line_height(px(TypeSize::Title.line_height()))
                .font_weight(FontWeight::SEMIBOLD)
                .child(title.into()),
        )
        .when_some(subtitle, |this, subtitle| {
            this.child(
                div()
                    .mt(px(dialog::SUBTITLE_TOP))
                    .text_size(px(TypeSize::Small.points()))
                    .line_height(px(17.))
                    .text_color(p.text_secondary)
                    .child(subtitle),
            )
        });
    match leading {
        None => text.into_any_element(),
        Some(leading) => div()
            .flex()
            .items_center()
            .gap(px(dialog::TITLE_GAP))
            .child(leading)
            .child(text)
            .into_any_element(),
    }
}

pub fn dialog_actions(buttons: Vec<AnyElement>) -> AnyElement {
    div()
        .flex()
        .items_center()
        .gap(px(space::M))
        .mt(px(dialog::ACTIONS_TOP))
        .child(div().flex_1())
        .children(buttons)
        .into_any_element()
}
