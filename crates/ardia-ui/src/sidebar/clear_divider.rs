use crate::scale::px;
use gpui::{
    AnyElement, FontWeight, Hsla, IntoElement, MouseButton, ParentElement, Styled, div, prelude::*,
};

use crate::msg::{MenuTarget, Msg};
use crate::primitives::controls::tooltip;
use crate::primitives::icons::{Icon, icon};
use crate::window::chrome::Chrome;

pub const DIVIDER_GROUP: &str = "clear-divider";
pub const PADDING: f32 = ardia_theme::layout::sidebar::ROW_CONTENT_LEFT;
pub const LABEL_SIZE: f32 = 10.0;
pub const ACTION_GAP: f32 = 8.0;
pub const ICON_GAP: f32 = 4.0;
pub const FOLD_TITLES: (&str, &str) = ("Collapse Pinned Tabs", "Expand Pinned Tabs");

pub fn pinned_collapsed(c: &Chrome) -> bool {
    c.state
        .profiles
        .get(&c.window.profile_id)
        .and_then(|profile| profile.pinned_collapsed)
        .unwrap_or(false)
}

#[derive(Clone, Copy)]
struct Inks {
    rest: Hsla,
    hover: Hsla,
    pressed: Hsla,
}

fn inks(c: &Chrome) -> Inks {
    Inks {
        rest: c.p.text_tertiary,
        hover: c.p.text,
        pressed: c.p.text_secondary,
    }
}

fn divider_button(
    c: &Chrome,
    id: &'static str,
    title: &'static str,
    label: &'static str,
    glyph: Icon,
    glyph_frame: (f32, f32),
    msg: Msg,
) -> AnyElement {
    let ink = inks(c);
    let height = c.look.text_size.clear_divider_height();
    div()
        .id(id)
        .debug_selector(move || id.into())
        .group(id)
        .flex_none()
        .h(px(height))
        .pl(px(ACTION_GAP))
        .flex()
        .items_center()
        .text_size(px(c.points(LABEL_SIZE)))
        .font_weight(FontWeight::MEDIUM)
        .text_color(ink.rest)
        .cursor_pointer()
        .hover(move |style| style.text_color(ink.hover))
        .active(move |style| style.text_color(ink.pressed))
        .tooltip(tooltip(label.into(), c.p))
        .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
        .on_click(c.emit.click(msg))
        .child(hover_glyph(glyph, 9., glyph_frame, ink.rest, ink.hover, id))
        .child(title)
        .into_any_element()
}

pub const DASH: f32 = 3.0;

pub fn dash_starts(width: f32, dash: f32) -> Vec<f32> {
    if dash <= 0.0 {
        return Vec::new();
    }
    let mut out = Vec::new();
    let mut x = 0.0;
    while x < width {
        out.push(x);
        x += dash * 2.0;
    }
    out
}

fn dashes(color: gpui::Hsla) -> AnyElement {
    gpui::canvas(
        |_, _, _| {},
        move |bounds, _, window, _| {
            let dash = crate::scale::px(DASH);
            let width = f32::from(bounds.size.width);
            for start in dash_starts(width, f32::from(dash)) {
                let w = (width - start).min(f32::from(dash));
                window.paint_quad(gpui::fill(
                    gpui::Bounds::new(
                        gpui::point(bounds.origin.x + gpui::px(start), bounds.origin.y),
                        gpui::size(gpui::px(w), bounds.size.height),
                    ),
                    color,
                ));
            }
        },
    )
    .size_full()
    .into_any_element()
}

pub fn reveal_when(slot: gpui::Div, shown: bool) -> gpui::Div {
    slot.when(!shown, |slot| slot.w(px(0.)).overflow_hidden().opacity(0.))
}

pub fn hover_glyph(
    glyph: Icon,
    size: f32,
    frame: (f32, f32),
    rest: Hsla,
    hover: Hsla,
    group: &'static str,
) -> AnyElement {
    div()
        .flex_none()
        .w(px(frame.0))
        .h(px(frame.1))
        .mr(px(ICON_GAP))
        .relative()
        .child(
            div()
                .absolute()
                .inset_0()
                .flex()
                .items_center()
                .justify_center()
                .group_hover(group, |style| style.opacity(0.))
                .child(icon(glyph, size, rest)),
        )
        .child(
            div()
                .absolute()
                .inset_0()
                .flex()
                .items_center()
                .justify_center()
                .opacity(0.)
                .group_hover(group, |style| style.opacity(1.))
                .child(icon(glyph, size, hover)),
        )
        .into_any_element()
}

fn fold_button(c: &Chrome, collapsed: bool) -> AnyElement {
    let ink = inks(c);
    let height = c.look.text_size.clear_divider_height();
    let label = if collapsed {
        FOLD_TITLES.1
    } else {
        FOLD_TITLES.0
    };
    div()
        .id("pinned-fold")
        .debug_selector(|| "pinned-fold".into())
        .group("pinned-fold")
        .flex_none()
        .h(px(height))
        .pr(px(ACTION_GAP))
        .flex()
        .items_center()
        .cursor_pointer()
        .text_size(px(c.points(LABEL_SIZE)))
        .font_weight(FontWeight::MEDIUM)
        .text_color(ink.rest)
        .hover(move |style| style.text_color(ink.hover))
        .active(move |style| style.text_color(ink.pressed))
        .tooltip(tooltip(label.into(), c.p))
        .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
        .on_click(c.emit.click(Msg::command("togglePinnedFold")))
        .child(hover_glyph(
            if collapsed {
                Icon::ChevronRight
            } else {
                Icon::ChevronDown
            },
            8.,
            (10., 10.),
            ink.rest,
            ink.hover,
            "pinned-fold",
        ))
        .child("Pinned")
        .into_any_element()
}

pub const ACTIONS_DIVIDER_LENGTH: f32 = 9.0;
pub const ACTIONS_DIVIDER_WIDTH: f32 = 1.0;

pub fn offers_tidy(c: &Chrome) -> bool {
    crate::sidebar::tidy_tabs::offers_tidy(c.state, c.window.id.as_str(), &c.window.profile_id)
}

fn broom_glyph(rest: Hsla, hover: Hsla, group: &'static str) -> AnyElement {
    let side = crate::sidebar::tidy_tabs::BROOM_SIZE;
    let layer = |color: Hsla| {
        gpui::svg()
            .data(&crate::sidebar::tidy_tabs::broom_mask())
            .size(px(side))
            .text_color(color)
    };
    div()
        .flex_none()
        .size(px(side))
        .mr(px(ICON_GAP))
        .relative()
        .child(
            div()
                .absolute()
                .inset_0()
                .group_hover(group, |style| style.opacity(0.))
                .child(layer(rest)),
        )
        .child(
            div()
                .absolute()
                .inset_0()
                .opacity(0.)
                .group_hover(group, |style| style.opacity(1.))
                .child(layer(hover)),
        )
        .into_any_element()
}

fn tidy_button(c: &Chrome) -> AnyElement {
    let ink = inks(c);
    let height = c.look.text_size.clear_divider_height();
    let id = "tidy-tabs";
    div()
        .id(id)
        .debug_selector(move || id.into())
        .group(id)
        .flex_none()
        .h(px(height))
        .pl(px(ACTION_GAP))
        .flex()
        .items_center()
        .text_size(px(c.points(LABEL_SIZE)))
        .font_weight(FontWeight::MEDIUM)
        .text_color(ink.rest)
        .cursor_pointer()
        .hover(move |style| style.text_color(ink.hover))
        .active(move |style| style.text_color(ink.pressed))
        .tooltip(tooltip("Tidy Tabs".into(), c.p))
        .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
        .on_click(
            c.emit
                .click(Msg::command(crate::sidebar::tidy_tabs::TIDY_COMMAND)),
        )
        .child(broom_glyph(ink.rest, ink.hover, id))
        .child("Tidy")
        .into_any_element()
}

fn actions_divider(c: &Chrome) -> AnyElement {
    div()
        .flex_none()
        .ml(px(ACTION_GAP))
        .w(px(ACTIONS_DIVIDER_WIDTH))
        .h(px(ACTIONS_DIVIDER_LENGTH))
        .bg(c.p.divider)
        .into_any_element()
}

pub fn clear_divider(c: &Chrome, clearable: usize) -> AnyElement {
    let height = c.look.text_size.clear_divider_height();
    let clear = c.state.settings.show_clear_button && clearable > 0;
    let tidy = offers_tidy(c);
    let pinned = !c.sections.pinned.is_empty();
    let collapsed = pinned && pinned_collapsed(c);
    let emit = c.emit.clone();
    let key = c.window.id.as_str().to_owned();
    let hovered = crate::sidebar::row_look::is_hovered(&key, DIVIDER_GROUP);
    div()
        .id("clear-divider")
        .on_hover(move |hovered, window, _| {
            crate::sidebar::row_look::set_hovered(&key, DIVIDER_GROUP, *hovered, window)
        })
        .debug_selector(|| "clear-divider".into())
        .group(DIVIDER_GROUP)
        .flex_none()
        .h(px(height))
        .px(px(PADDING))
        .flex()
        .items_center()
        .on_mouse_down(MouseButton::Right, move |event, window, cx| {
            cx.stop_propagation();
            emit.send(
                Msg::Menu(Some((MenuTarget::NewTab, event.position))),
                window,
                cx,
            );
        })
        .when(pinned, |this| {
            this.child(
                div()
                    .flex_none()
                    .when(!collapsed, |slot| reveal_when(slot, hovered))
                    .child(fold_button(c, collapsed)),
            )
        })
        .child(
            div()
                .flex_1()
                .h(px(1.))
                .overflow_hidden()
                .child(dashes(c.p.divider)),
        )
        .when(tidy || clear, |this| {
            this.child(
                reveal_when(div().flex_none(), hovered)
                    .flex()
                    .items_center()
                    .when(tidy, |this| this.child(tidy_button(c)))
                    .when(tidy && clear, |this| this.child(actions_divider(c)))
                    .when(clear, |this| {
                        this.child(divider_button(
                            c,
                            "clear-unpinned",
                            "Clear",
                            "Clear unpinned tabs",
                            Icon::ArrowDown,
                            (8., 11.),
                            Msg::ClearUnpinned,
                        ))
                    }),
            )
        })
        .into_any_element()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dashes_run_three_on_three_off() {
        assert_eq!(dash_starts(14.0, 3.0), vec![0.0, 6.0, 12.0]);
        assert!(dash_starts(10.0, 0.0).is_empty());
    }
}
