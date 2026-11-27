use std::rc::Rc;
use std::time::Instant;

use crate::scale::px;
use gpui::{
    AnyElement, App, ClickEvent, ElementId, FontWeight, Hsla, IntoElement, MouseButton,
    MouseDownEvent, ParentElement, RenderOnce, SharedString, Styled, Window, div, prelude::*,
};
use smallvec::SmallVec;

use crate::look::Palette;
use crate::primitives::controls::{ClickHandler, hover_fill_tween};
use crate::primitives::icons::{Icon, icon};
use crate::primitives::tokens::{
    THICK_HAIRLINE, Tween, empty_state as empty, line_height, radius, space, type_size,
};

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct ListRowState {
    pub hovered: bool,
    pub pressed: bool,
    pub selected: bool,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum SelectedTone {
    #[default]
    Row,
    Accent,
}

struct HoverMotion {
    hovered: bool,
    pressed: bool,
    shown: bool,
    instant: bool,
    fill: Tween,
}

impl HoverMotion {
    fn new() -> Self {
        HoverMotion {
            hovered: false,
            pressed: false,
            shown: false,
            instant: false,
            fill: Tween::at(0.0),
        }
    }

    fn sync(&mut self, shown: bool, instant: bool, now: Instant) {
        if self.shown == shown && self.instant == instant {
            return;
        }
        self.shown = shown;
        self.instant = instant;
        hover_fill_tween(&mut self.fill, shown, instant, now);
    }
}

pub fn hover_fill_layer(color: Hsla, radius: f32, opacity: f32) -> impl IntoElement {
    div()
        .absolute()
        .inset_0()
        .rounded(px(radius))
        .bg(color.opacity(opacity))
}

type StateChild = Box<dyn FnOnce(ListRowState) -> AnyElement>;
type HoverHandler = Rc<dyn Fn(bool, &mut Window, &mut App)>;
type PressHandler = Rc<dyn Fn(&MouseDownEvent, &mut Window, &mut App)>;

#[derive(IntoElement)]
pub struct ListRow {
    id: ElementId,
    selected: bool,
    tone: SelectedTone,
    height: Option<f32>,
    p: Palette,
    on_click: Option<ClickHandler>,
    on_press_in: Option<PressHandler>,
    on_hover: Option<HoverHandler>,
    children: SmallVec<[AnyElement; 4]>,
    with_state: Option<StateChild>,
}

impl ListRow {
    pub fn new(id: impl Into<ElementId>, p: &Palette) -> Self {
        ListRow {
            id: id.into(),
            selected: false,
            tone: SelectedTone::Row,
            height: None,
            p: *p,
            on_click: None,
            on_press_in: None,
            on_hover: None,
            children: SmallVec::new(),
            with_state: None,
        }
    }

    pub fn selected(mut self, selected: bool) -> Self {
        self.selected = selected;
        self
    }

    pub fn selected_tone(mut self, tone: SelectedTone) -> Self {
        self.tone = tone;
        self
    }

    pub fn height(mut self, height: f32) -> Self {
        self.height = Some(height);
        self
    }

    pub fn on_click(
        mut self,
        handler: impl Fn(&ClickEvent, &mut Window, &mut App) + 'static,
    ) -> Self {
        self.on_click = Some(Rc::new(handler));
        self
    }

    pub fn on_press_in(
        mut self,
        handler: impl Fn(&MouseDownEvent, &mut Window, &mut App) + 'static,
    ) -> Self {
        self.on_press_in = Some(Rc::new(handler));
        self
    }

    pub fn on_hover(mut self, handler: impl Fn(bool, &mut Window, &mut App) + 'static) -> Self {
        self.on_hover = Some(Rc::new(handler));
        self
    }

    pub fn with_state(mut self, build: impl FnOnce(ListRowState) -> AnyElement + 'static) -> Self {
        self.with_state = Some(Box::new(build));
        self
    }
}

impl ParentElement for ListRow {
    fn extend(&mut self, elements: impl IntoIterator<Item = AnyElement>) {
        self.children.extend(elements);
    }
}

pub fn list_row_fill(selected: bool, tone: SelectedTone, p: &Palette) -> Option<Hsla> {
    match (selected, tone) {
        (false, _) => None,
        (true, SelectedTone::Row) => Some(p.row_selected),
        (true, SelectedTone::Accent) => Some(p.form_accent),
    }
}

impl RenderOnce for ListRow {
    fn render(self, window: &mut Window, cx: &mut App) -> impl IntoElement {
        let now = Instant::now();
        let selected = self.selected;
        let state = window.use_keyed_state(self.id.clone(), cx, |_, _| HoverMotion::new());
        let (row_state, opacity, running) = state.update(cx, |motion, _| {
            motion.sync(motion.hovered && !selected, selected, now);
            (
                ListRowState {
                    hovered: motion.hovered,
                    pressed: motion.pressed,
                    selected,
                },
                motion.fill.value(now),
                motion.fill.running(now),
            )
        });
        if running {
            window.request_animation_frame();
        }
        let p = self.p;
        let hover_state = state.clone();
        let press_state = state.clone();
        let release_state = state;
        let notify = self.on_hover;
        let press_in = self.on_press_in;
        div()
            .id(self.id)
            .relative()
            .when_some(self.height, |this, height| this.h(px(height)))
            .px(px(space::M))
            .rounded(px(radius::TILE))
            .flex()
            .flex_row()
            .items_center()
            .gap(px(space::M))
            .when_some(list_row_fill(selected, self.tone, &p), |this, fill| {
                this.bg(fill)
            })
            .on_hover(move |hovered, window, cx| {
                hover_state.update(cx, |motion, cx| {
                    motion.hovered = *hovered;
                    if !*hovered {
                        motion.pressed = false;
                    }
                    cx.notify();
                });
                if let Some(notify) = &notify {
                    notify(*hovered, window, cx);
                }
            })
            .on_mouse_down(MouseButton::Left, move |_, _, cx| {
                press_state.update(cx, |motion, cx| {
                    motion.pressed = true;
                    cx.notify();
                });
            })
            .on_mouse_up(MouseButton::Left, move |_, _, cx| {
                release_state.update(cx, |motion, cx| {
                    motion.pressed = false;
                    cx.notify();
                });
            })
            .when_some(press_in, |this, handler| {
                this.on_mouse_down(MouseButton::Left, move |event, window, cx| {
                    handler(event, window, cx)
                })
            })
            .when_some(self.on_click, |this, handler| {
                this.on_click(move |event, window, cx| handler(event, window, cx))
            })
            .when(opacity > 0.0, |this| {
                this.child(hover_fill_layer(p.row_hover, radius::TILE, opacity))
            })
            .children(self.children)
            .when_some(self.with_state, |this, build| this.child(build(row_state)))
    }
}

pub mod row_metrics {
    pub const MIN_HEIGHT: f32 = 40.;
    pub const NATIVE_MIN_HEIGHT: f32 = 34.;
    pub const CHEVRON: f32 = 11.;
    pub const CHEVRON_BOX: (f32, f32) = (12., 14.);
}

#[derive(IntoElement)]
pub struct Row {
    id: ElementId,
    title: Option<AnyElement>,
    description: Option<AnyElement>,
    icon: Option<AnyElement>,
    native: bool,
    p: Palette,
    on_click: Option<ClickHandler>,
    children: SmallVec<[AnyElement; 2]>,
}

impl Row {
    pub fn new(id: impl Into<ElementId>, p: &Palette) -> Self {
        Row {
            id: id.into(),
            title: None,
            description: None,
            icon: None,
            native: false,
            p: *p,
            on_click: None,
            children: SmallVec::new(),
        }
    }

    pub fn title(mut self, title: impl Into<SharedString>) -> Self {
        self.title = Some(
            div()
                .text_size(px(type_size::BODY))
                .text_color(self.p.text)
                .child(title.into())
                .into_any_element(),
        );
        self
    }

    pub fn title_element(mut self, title: impl IntoElement) -> Self {
        self.title = Some(title.into_any_element());
        self
    }

    pub fn description(mut self, description: impl Into<SharedString>) -> Self {
        self.description = Some(row_description(description, &self.p).into_any_element());
        self
    }

    pub fn description_element(mut self, description: impl IntoElement) -> Self {
        self.description = Some(description.into_any_element());
        self
    }

    pub fn icon(mut self, icon: impl IntoElement) -> Self {
        self.icon = Some(icon.into_any_element());
        self
    }

    pub fn native(mut self, native: bool) -> Self {
        self.native = native;
        self
    }

    pub fn on_click(
        mut self,
        handler: impl Fn(&ClickEvent, &mut Window, &mut App) + 'static,
    ) -> Self {
        self.on_click = Some(Rc::new(handler));
        self
    }
}

impl ParentElement for Row {
    fn extend(&mut self, elements: impl IntoIterator<Item = AnyElement>) {
        self.children.extend(elements);
    }
}

pub fn row_description(text: impl Into<SharedString>, p: &Palette) -> gpui::Div {
    div()
        .mt(px(space::XXS))
        .text_size(px(type_size::CAPTION))
        .line_height(px(line_height::CAPTION))
        .text_color(p.text_secondary)
        .child(text.into())
}

pub fn row_padding(native: bool) -> (f32, f32, f32) {
    if native {
        (row_metrics::NATIVE_MIN_HEIGHT, space::L, space::S)
    } else {
        (row_metrics::MIN_HEIGHT, space::L, space::M)
    }
}

impl RenderOnce for Row {
    fn render(self, window: &mut Window, cx: &mut App) -> impl IntoElement {
        let p = self.p;
        let (min_height, pad_x, pad_y) = row_padding(self.native);
        let linked = self.on_click.is_some();
        let fill = linked.then(|| {
            let now = Instant::now();
            let state = window.use_keyed_state(self.id.clone(), cx, |_, _| HoverMotion::new());
            let (opacity, running) = state.update(cx, |motion, _| {
                motion.sync(motion.hovered, false, now);
                (motion.fill.value(now), motion.fill.running(now))
            });
            if running {
                window.request_animation_frame();
            }
            (state, opacity)
        });
        div()
            .id(self.id)
            .relative()
            .min_h(px(min_height))
            .px(px(pad_x))
            .py(px(pad_y))
            .flex()
            .flex_row()
            .items_center()
            .gap(px(space::L))
            .when_some(fill, |this, (state, opacity)| {
                this.on_hover(move |hovered, _, cx| {
                    state.update(cx, |motion, cx| {
                        motion.hovered = *hovered;
                        cx.notify();
                    })
                })
                .when(opacity > 0.0, |this| {
                    this.child(hover_fill_layer(p.row_hover, radius::NONE, opacity))
                })
            })
            .when_some(self.on_click, |this, handler| {
                this.on_click(move |event, window, cx| handler(event, window, cx))
            })
            .children(self.icon)
            .child(
                div()
                    .flex_1()
                    .min_w_0()
                    .flex()
                    .flex_col()
                    .children(self.title)
                    .children(self.description),
            )
            .children(self.children)
            .when(linked, |this| {
                this.child(
                    div()
                        .flex_none()
                        .w(px(row_metrics::CHEVRON_BOX.0))
                        .h(px(row_metrics::CHEVRON_BOX.1))
                        .flex()
                        .items_center()
                        .justify_center()
                        .child(icon(
                            Icon::ChevronRight,
                            row_metrics::CHEVRON,
                            p.text_tertiary,
                        )),
                )
            })
    }
}

pub fn divider(p: &Palette, thick: bool, inset: f32) -> gpui::Div {
    div()
        .h(px(if thick {
            THICK_HAIRLINE
        } else {
            crate::primitives::tokens::HAIRLINE
        }))
        .mx(px(inset))
        .bg(p.divider)
}

pub fn group(p: &Palette, rows: impl IntoIterator<Item = AnyElement>) -> gpui::Div {
    div()
        .rounded(px(radius::PANEL))
        .bg(p.group_fill)
        .border(px(THICK_HAIRLINE))
        .border_color(p.group_border)
        .overflow_hidden()
        .children(rows.into_iter().enumerate().map(|(index, row)| {
            div()
                .when(index > 0, |this| this.child(divider(p, true, space::L)))
                .child(row)
        }))
}

pub fn empty_state(
    glyph: Icon,
    title: impl Into<SharedString>,
    subtitle: Option<SharedString>,
    p: &Palette,
) -> gpui::Div {
    div()
        .flex_1()
        .flex()
        .flex_col()
        .items_center()
        .justify_center()
        .gap(px(space::M))
        .pb(px(empty::LIFT_BOTTOM))
        .child(
            div()
                .size(px(empty::ICON_BOX))
                .flex()
                .items_center()
                .justify_center()
                .child(icon(glyph, empty::ICON, p.text_tertiary)),
        )
        .child(
            div()
                .text_size(px(type_size::TITLE))
                .line_height(px(line_height::TITLE))
                .font_weight(FontWeight::MEDIUM)
                .text_color(p.text_secondary)
                .child(title.into()),
        )
        .when_some(subtitle, |this, subtitle| {
            this.child(
                div()
                    .max_w(px(empty::SUBTITLE_MAX_WIDTH))
                    .text_center()
                    .text_size(px(type_size::BODY))
                    .line_height(px(line_height::BODY))
                    .text_color(p.text_tertiary)
                    .child(subtitle),
            )
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rows_use_the_old_padding() {
        assert_eq!(row_padding(false), (40., 12., 8.));
        assert_eq!(row_padding(true), (34., 12., 6.));
    }

    #[test]
    fn hover_fills_hide_at_once_under_a_selection() {
        let start = Instant::now();
        let mut motion = HoverMotion::new();
        motion.sync(true, false, start);
        assert!(motion.fill.running(start));
        motion.sync(false, true, start);
        assert!(!motion.fill.running(start));
        assert_eq!(motion.fill.value(start), 0.0);
    }
}
