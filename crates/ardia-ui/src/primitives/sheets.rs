use std::rc::Rc;
use std::time::{Duration, Instant};

use crate::scale::px;
use gpui::{
    AnyElement, App, ClickEvent, ElementId, FocusHandle, FontWeight, IntoElement, KeyDownEvent,
    ParentElement, RenderOnce, SharedString, Styled, Window, div, prelude::*,
};
use smallvec::SmallVec;

use crate::look::Palette;
use crate::primitives::controls::{ClickHandler, material_layer};
use crate::primitives::icons::{Icon, icon};
use crate::primitives::tokens::{
    Curve, HAIRLINE, ShadowLevel, SheetSize, Tween, capsule, duration, line_height, radius, shadow,
    shadows, space, toast_layout, type_size,
};

pub const DIALOG_REST_SCALE: f32 = 0.96;
pub const TOAST_MATERIAL: gpui::VisualEffectMaterial = gpui::VisualEffectMaterial::HudWindow;

pub fn dialog_scale(appear: f32) -> f32 {
    DIALOG_REST_SCALE + (1.0 - DIALOG_REST_SCALE) * appear
}

pub fn panel_surface(p: &Palette, corner: f32, level: ShadowLevel) -> gpui::Div {
    div()
        .rounded(px(corner))
        .bg(p.panel)
        .border(px(HAIRLINE))
        .border_color(p.panel_border)
        .shadow(shadows(&level, p.dark))
}

struct DialogMotion {
    appear: Tween,
    focus: Option<FocusHandle>,
    focused_once: bool,
}

type DismissHandler = Rc<dyn Fn(&mut Window, &mut App)>;

#[derive(IntoElement)]
pub struct Dialog {
    id: ElementId,
    width: SheetSize,
    pad: f32,
    animated: bool,
    max_height: Option<gpui::Length>,
    backdrop_closes: bool,
    p: Palette,
    on_dismiss: Option<DismissHandler>,
    on_submit: Option<DismissHandler>,
    children: SmallVec<[AnyElement; 4]>,
}

impl Dialog {
    pub fn new(id: impl Into<ElementId>, width: SheetSize, p: &Palette) -> Self {
        Dialog {
            id: id.into(),
            width,
            pad: space::XXL,
            animated: false,
            max_height: None,
            backdrop_closes: true,
            p: *p,
            on_dismiss: None,
            on_submit: None,
            children: SmallVec::new(),
        }
    }

    pub fn sheet(id: impl Into<ElementId>, size: SheetSize, p: &Palette) -> Self {
        Dialog::new(id, size, p).max_height(gpui::relative(0.9).into())
    }

    pub fn pad(mut self, pad: f32) -> Self {
        self.pad = pad;
        self
    }

    pub fn animated(mut self, animated: bool) -> Self {
        self.animated = animated;
        self
    }

    pub fn max_height(mut self, max_height: gpui::Length) -> Self {
        self.max_height = Some(max_height);
        self
    }

    pub fn backdrop_closes(mut self, closes: bool) -> Self {
        self.backdrop_closes = closes;
        self
    }

    pub fn on_dismiss(mut self, handler: impl Fn(&mut Window, &mut App) + 'static) -> Self {
        self.on_dismiss = Some(Rc::new(handler));
        self
    }

    pub fn on_submit(mut self, handler: impl Fn(&mut Window, &mut App) + 'static) -> Self {
        self.on_submit = Some(Rc::new(handler));
        self
    }
}

impl ParentElement for Dialog {
    fn extend(&mut self, elements: impl IntoIterator<Item = AnyElement>) {
        self.children.extend(elements);
    }
}

pub fn dialog_backdrop_closes(animated: bool, backdrop_closes: bool) -> bool {
    animated || backdrop_closes
}

impl RenderOnce for Dialog {
    fn render(self, window: &mut Window, cx: &mut App) -> impl IntoElement {
        let now = Instant::now();
        let p = self.p;
        let animated = self.animated;
        let keyed = self.on_submit.is_some();
        let state = window.use_keyed_state(self.id.clone(), cx, |_, cx| {
            let mut appear = Tween::at(if animated { 0.0 } else { 1.0 });
            if animated {
                appear.retarget(1.0, duration::BASE, Curve::Enter, now);
            }
            DialogMotion {
                appear,
                focus: keyed.then(|| cx.focus_handle()),
                focused_once: false,
            }
        });
        let (appear, running, focus, focus_now) = state.update(cx, |motion, _| {
            let focus_now = !motion.focused_once && motion.focus.is_some();
            motion.focused_once = true;
            (
                motion.appear.value(now),
                motion.appear.running(now),
                motion.focus.clone(),
                focus_now,
            )
        });
        if running {
            window.request_animation_frame();
        }
        if focus_now && let Some(focus) = &focus {
            window.focus(focus, cx);
        }
        let dismiss = self.on_dismiss.clone();
        let closes = dialog_backdrop_closes(animated, self.backdrop_closes);
        let key_dismiss = self.on_dismiss;
        let submit = self.on_submit;
        let key_focus = focus.clone();
        let surface = panel_surface(&p, radius::SHEET, shadow::DIALOG)
            .id(ElementId::NamedChild(
                std::sync::Arc::new(self.id.clone()),
                "surface".into(),
            ))
            .occlude()
            .w(px(self.width.width()))
            .when_some(self.max_height, |this, max| this.max_h(max))
            .p(px(self.pad))
            .flex()
            .flex_col()
            .text_color(p.text)
            .text_size(px(type_size::BODY))
            .opacity(appear)
            .when(appear < 1.0, |this| this.scale(dialog_scale(appear)))
            .when_some(focus, |this, focus| {
                this.track_focus(&focus)
                    .on_key_down(move |event: &KeyDownEvent, window, cx| {
                        match event.keystroke.key.as_str() {
                            "escape" => {
                                if let Some(dismiss) = &key_dismiss {
                                    cx.stop_propagation();
                                    dismiss(window, cx);
                                }
                            }
                            "enter"
                                if key_focus
                                    .as_ref()
                                    .is_some_and(|focus| focus.is_focused(window)) =>
                            {
                                if let Some(submit) = &submit {
                                    cx.stop_propagation();
                                    submit(window, cx);
                                }
                            }
                            _ => {}
                        }
                    })
            })
            .children(self.children);
        div()
            .id(self.id)
            .absolute()
            .inset_0()
            .flex()
            .items_center()
            .justify_center()
            .child(
                div()
                    .id("dialog-backdrop")
                    .absolute()
                    .inset_0()
                    .bg(p.scrim.opacity(appear))
                    .when_some(dismiss.filter(|_| closes), |this, dismiss| {
                        this.on_click(move |_, window, cx| dismiss(window, cx))
                    }),
            )
            .child(surface)
    }
}

pub fn dialog_title(
    title: impl Into<SharedString>,
    subtitle: Option<SharedString>,
    leading: Option<AnyElement>,
    p: &Palette,
) -> gpui::Div {
    let text = div()
        .flex()
        .flex_col()
        .child(
            div()
                .text_size(px(type_size::TITLE))
                .line_height(px(line_height::TITLE))
                .font_weight(FontWeight::SEMIBOLD)
                .text_color(p.text)
                .child(title.into()),
        )
        .when_some(subtitle, |this, subtitle| {
            this.child(
                div()
                    .mt(px(space::S))
                    .text_size(px(type_size::SMALL))
                    .line_height(px(line_height::PROSE_SMALL))
                    .text_color(p.text_secondary)
                    .child(subtitle),
            )
        });
    match leading {
        None => text,
        Some(leading) => div()
            .flex()
            .flex_row()
            .items_center()
            .gap(px(space::L))
            .child(leading)
            .child(text.flex_1().min_w_0()),
    }
}

pub fn dialog_actions(
    leading: Option<AnyElement>,
    note: Option<SharedString>,
    buttons: impl IntoIterator<Item = AnyElement>,
    p: &Palette,
) -> gpui::Div {
    div()
        .flex()
        .flex_row()
        .items_center()
        .gap(px(space::M))
        .mt(px(space::XL))
        .children(leading)
        .child(div().flex_1().when_some(note, |this, note| {
            this.text_size(px(type_size::CAPTION))
                .line_height(px(line_height::CAPTION))
                .text_color(p.text_secondary)
                .child(note)
        }))
        .children(buttons)
}

pub const TOAST_FADE_IN: (Duration, Curve) = (duration::BASE, Curve::Enter);
pub const TOAST_FADE_OUT: (Duration, Curve) = (duration::SLOW, Curve::Exit);
pub const TOAST_ICON: f32 = 15.;
pub const TOAST_ICON_BOX: f32 = 20.;
pub const TOAST_CHIP_HEIGHT: f32 = 24.;

pub fn toast_width(room: Option<f32>, two_actions: bool) -> f32 {
    let cap = if two_actions {
        toast_layout::TWO_ACTION_MAX_WIDTH
    } else {
        toast_layout::MAX_WIDTH
    };
    match room {
        None => cap,
        Some(room) => cap.min(room - 2.0 * toast_layout::EDGE).max(0.0),
    }
}

pub fn toast_card(
    p: &Palette,
    title: impl Into<SharedString>,
    message: Option<SharedString>,
    glyph: Option<Icon>,
    room: Option<f32>,
    actions: Vec<AnyElement>,
) -> gpui::Div {
    toast_card_lines(p, title, message, glyph, room, actions, None)
}

pub fn toast_card_lines(
    p: &Palette,
    title: impl Into<SharedString>,
    message: Option<SharedString>,
    glyph: Option<Icon>,
    room: Option<f32>,
    actions: Vec<AnyElement>,
    title_lines: Option<usize>,
) -> gpui::Div {
    let two_actions = actions.len() > 1;
    div()
        .max_w(px(toast_width(room, two_actions)))
        .px(px(space::XL))
        .py(px(space::ML))
        .rounded(px(radius::PANEL))
        .bg(p.toast_fill)
        .border(px(HAIRLINE))
        .border_color(p.popover_border)
        .shadow(shadows(&shadow::CARD, p.dark))
        .relative()
        .child(material_layer(TOAST_MATERIAL, radius::PANEL, HAIRLINE))
        .flex()
        .flex_row()
        .items_center()
        .gap(px(space::ML))
        .text_size(px(type_size::BODY))
        .text_color(p.text)
        .when_some(glyph, |this, glyph| {
            this.child(
                div()
                    .flex_none()
                    .size(px(TOAST_ICON_BOX))
                    .flex()
                    .items_center()
                    .justify_center()
                    .child(icon(glyph, TOAST_ICON, p.icon)),
            )
        })
        .child(
            div()
                .flex_shrink(1.)
                .min_w_0()
                .flex()
                .flex_col()
                .child(
                    div()
                        .font_weight(FontWeight::SEMIBOLD)
                        .line_height(px(line_height::BODY))
                        .when_some(title_lines, |this, lines| {
                            this.line_clamp(lines).text_ellipsis()
                        })
                        .child(title.into()),
                )
                .when_some(message, |this, message| {
                    this.child(
                        div()
                            .text_size(px(type_size::SMALL))
                            .line_height(px(line_height::SMALL))
                            .text_color(p.text_secondary)
                            .child(message),
                    )
                }),
        )
        .when(!actions.is_empty(), |this| {
            this.child(
                div()
                    .flex()
                    .flex_row()
                    .flex_none()
                    .gap(px(space::ML))
                    .children(actions),
            )
        })
}

fn chip_base(
    id: impl Into<ElementId>,
    title: impl Into<SharedString>,
    p: &Palette,
) -> gpui::Stateful<gpui::Div> {
    let (hover, pressed) = (p.toolbar_hover, p.toolbar_pressed);
    div()
        .id(id.into())
        .flex_none()
        .h(px(TOAST_CHIP_HEIGHT))
        .px(px(space::M))
        .rounded(px(capsule(TOAST_CHIP_HEIGHT)))
        .bg(p.url_pill)
        .flex()
        .items_center()
        .justify_center()
        .gap(px(space::XS))
        .text_size(px(type_size::SMALL))
        .font_weight(FontWeight::MEDIUM)
        .text_color(p.text)
        .hover(move |style| style.bg(hover))
        .active(move |style| style.bg(pressed))
        .child(title.into())
}

pub fn chip_button(
    id: impl Into<ElementId>,
    title: impl Into<SharedString>,
    p: &Palette,
    on_click: impl Fn(&ClickEvent, &mut Window, &mut App) + 'static,
) -> impl IntoElement {
    let handler: ClickHandler = Rc::new(on_click);
    chip_base(id, title, p).on_click(move |event, window, cx| handler(event, window, cx))
}

type PressHandler = Rc<dyn Fn(&mut Window, &mut App)>;

pub fn chip_button_focusable(
    id: impl Into<ElementId>,
    title: impl Into<SharedString>,
    p: &Palette,
    focus: &FocusHandle,
    tab_index: isize,
    on_press: impl Fn(&mut Window, &mut App) + 'static,
) -> impl IntoElement {
    let handler: PressHandler = Rc::new(on_press);
    let keyed = handler.clone();
    let ring = p.accent;
    chip_base(id, title, p)
        .track_focus(focus)
        .tab_index(tab_index)
        .focus_visible(move |style| style.border(px(2.)).border_color(ring))
        .on_click(move |_, window, cx| handler(window, cx))
        .on_key_down(move |event: &KeyDownEvent, window, cx| {
            if is_press_key(&event.keystroke.key) {
                cx.stop_propagation();
                keyed(window, cx);
            }
        })
}

pub fn is_press_key(key: &str) -> bool {
    matches!(key, "enter" | "space")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn toasts_fit_the_room_left_by_the_edges() {
        assert_eq!(toast_width(None, false), 420.);
        assert_eq!(toast_width(None, true), 600.);
        assert_eq!(toast_width(Some(300.), false), 276.);
        assert_eq!(toast_width(Some(1000.), true), 600.);
        assert_eq!(toast_width(Some(10.), false), 0.);
    }

    #[test]
    fn animated_dialogs_always_close_from_the_backdrop() {
        assert!(dialog_backdrop_closes(true, false));
        assert!(!dialog_backdrop_closes(false, false));
        assert!(dialog_backdrop_closes(false, true));
    }

    #[test]
    fn dialogs_grow_from_ninety_six_percent_as_they_fade_in() {
        assert_eq!(dialog_scale(0.0), 0.96);
        assert!((dialog_scale(0.5) - 0.98).abs() < 1e-6);
        assert_eq!(dialog_scale(1.0), 1.0);
    }

    #[test]
    fn toast_fades_follow_the_old_timings() {
        assert_eq!(TOAST_FADE_IN.0, Duration::from_millis(150));
        assert_eq!(TOAST_FADE_OUT.0, Duration::from_millis(250));
        assert_eq!(TOAST_FADE_OUT.1, Curve::Exit);
    }
}
