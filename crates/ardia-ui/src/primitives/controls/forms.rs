use std::cell::{Cell, RefCell};
use std::rc::Rc;
use std::time::{Duration, Instant};

use crate::scale::px;
use gpui::{
    AnyElement, App, Bounds, DragMoveEvent, ElementId, Hsla, IntoElement, MouseButton,
    MouseDownEvent, ParentElement, Pixels, RenderOnce, SharedString, Styled, Window, canvas, div,
    prelude::*, relative,
};
use smallvec::SmallVec;

use crate::look::Palette;
use crate::primitives::hover_fill::{Interaction, press_state, resolve_interaction, track_press};
use crate::primitives::icons::{Icon, icon};
use crate::primitives::tokens::press_scale;
use crate::primitives::tokens::{
    Curve, DISABLED_OPACITY, SNAPPY, SpringPair, THICK_HAIRLINE, Tween, capsule, duration,
    hover_fade, line_height, radius, space, swatch, type_size,
};

use super::*;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ToggleLook {
    Form,
    NativeForm,
    Panel,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct SwitchMetrics {
    pub width: f32,
    pub height: f32,
    pub knob: f32,
    pub inset: f32,
}

impl SwitchMetrics {
    pub fn travel(&self) -> f32 {
        self.width - self.knob - self.inset * 2.0
    }
}

impl ToggleLook {
    pub const fn metrics(self) -> SwitchMetrics {
        match self {
            ToggleLook::Form => SwitchMetrics {
                width: 32.,
                height: 18.,
                knob: 15.,
                inset: 1.5,
            },
            ToggleLook::NativeForm => SwitchMetrics {
                width: 26.,
                height: 15.,
                knob: 13.,
                inset: 1.,
            },
            ToggleLook::Panel => SwitchMetrics {
                width: 30.,
                height: 17.,
                knob: 14.,
                inset: 1.5,
            },
        }
    }

    pub const fn animates_external_changes(self) -> bool {
        matches!(self, ToggleLook::Panel)
    }

    fn colors(self, p: &Palette) -> (Hsla, Hsla, Option<Hsla>) {
        match self {
            ToggleLook::Panel => (p.toggle_off, p.accent, None),
            ToggleLook::Form | ToggleLook::NativeForm => {
                (p.switch_off, p.form_accent, Some(p.knob_border))
            }
        }
    }
}

pub const SWITCH_WIDTH: f32 = ToggleLook::Form.metrics().width;
pub const SWITCH_HEIGHT: f32 = ToggleLook::Form.metrics().height;
pub const SWITCH_HIT_SLOP: f32 = 6.;
pub const USER_CHANGE_WINDOW: Duration = Duration::from_millis(2000);

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct ToggleMotion {
    pub progress: Tween,
    pub target: bool,
    pressed_at: Option<Instant>,
    pending: Option<(bool, Instant)>,
}

impl ToggleMotion {
    pub fn new(on: bool) -> Self {
        ToggleMotion {
            progress: Tween::at(if on { 1.0 } else { 0.0 }),
            target: on,
            pressed_at: None,
            pending: None,
        }
    }

    fn slide(&mut self, on: bool, now: Instant) {
        self.target = on;
        self.progress.retarget(
            if on { 1.0 } else { 0.0 },
            duration::BASE,
            Curve::Enter,
            now,
        );
    }

    fn jump(&mut self, on: bool) {
        self.target = on;
        self.progress.jump(if on { 1.0 } else { 0.0 });
    }

    pub fn sync(&mut self, value: bool, now: Instant, animate_external: bool) {
        if let Some((target, at)) = self.pending {
            if value != target && now.saturating_duration_since(at) < USER_CHANGE_WINDOW {
                return;
            }
            self.pending = None;
        }
        if self.target == value {
            return;
        }
        let user = self
            .pressed_at
            .is_some_and(|at| now.saturating_duration_since(at) < USER_CHANGE_WINDOW);
        if animate_external || user {
            self.slide(value, now);
        } else {
            self.jump(value);
        }
    }

    pub fn press(&mut self, now: Instant, asks_first: bool) -> bool {
        let next = !self.target;
        self.pressed_at = Some(now);
        if !asks_first {
            self.slide(next, now);
            self.pending = Some((next, now));
        }
        next
    }
}

#[derive(IntoElement)]
pub struct Toggle {
    id: ElementId,
    on: bool,
    disabled: bool,
    look: ToggleLook,
    asks_first: bool,
    p: Palette,
    on_toggle: Option<ValueHandler<bool>>,
}

impl Toggle {
    pub fn new(id: impl Into<ElementId>, on: bool, p: &Palette) -> Self {
        Toggle {
            id: id.into(),
            on,
            disabled: false,
            look: ToggleLook::Form,
            asks_first: false,
            p: *p,
            on_toggle: None,
        }
    }

    pub fn disabled(mut self, disabled: bool) -> Self {
        self.disabled = disabled;
        self
    }

    pub fn look(mut self, look: ToggleLook) -> Self {
        self.look = look;
        self
    }

    pub fn native(self, native: bool) -> Self {
        if native {
            self.look(ToggleLook::NativeForm)
        } else {
            self
        }
    }

    pub fn panel(self) -> Self {
        self.look(ToggleLook::Panel)
    }

    pub fn asks_first(mut self, asks_first: bool) -> Self {
        self.asks_first = asks_first;
        self
    }

    pub fn on_toggle(mut self, handler: impl Fn(bool, &mut Window, &mut App) + 'static) -> Self {
        self.on_toggle = Some(Rc::new(handler));
        self
    }
}

impl RenderOnce for Toggle {
    fn render(self, window: &mut Window, cx: &mut App) -> impl IntoElement {
        let now = Instant::now();
        let on = self.on;
        let look = self.look;
        let m = look.metrics();
        let (off_color, on_color, knob_border) = look.colors(&self.p);
        let state = window.use_keyed_state(self.id.clone(), cx, |_, _| ToggleMotion::new(on));
        let (progress, running) = state.update(cx, |motion, _| {
            motion.sync(on, now, look.animates_external_changes());
            (motion.progress.value(now), motion.progress.running(now))
        });
        if running {
            window.request_animation_frame();
        }
        let asks_first = self.asks_first;
        let handler = self.on_toggle.filter(|_| !self.disabled);
        div()
            .id(self.id)
            .flex_none()
            .p(px(SWITCH_HIT_SLOP))
            .m(px(-SWITCH_HIT_SLOP))
            .when(self.disabled, |this| this.opacity(DISABLED_OPACITY))
            .when_some(handler, |this, handler| {
                this.on_click(move |_, window, cx| {
                    cx.stop_propagation();
                    let next = state.update(cx, |motion, cx| {
                        let next = motion.press(Instant::now(), asks_first);
                        cx.notify();
                        next
                    });
                    handler(next, window, cx);
                })
            })
            .child(
                div()
                    .relative()
                    .w(px(m.width))
                    .h(px(m.height))
                    .rounded(px(capsule(m.height)))
                    .bg(off_color)
                    .overflow_hidden()
                    .child(
                        div()
                            .absolute()
                            .inset_0()
                            .rounded(px(capsule(m.height)))
                            .bg(on_color.opacity(progress)),
                    )
                    .child(
                        div()
                            .absolute()
                            .top(px(m.inset))
                            .left(px(m.inset + m.travel() * progress))
                            .size(px(m.knob))
                            .rounded(px(capsule(m.knob)))
                            .bg(self.p.knob)
                            .when_some(knob_border, |this, border| {
                                this.border(px(crate::primitives::tokens::HAIRLINE))
                                    .border_color(border)
                            }),
                    ),
            )
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct SliderDrag(pub u64);

pub fn slider_value(position: f32, left: f32, width: f32, steps: Option<u32>) -> f32 {
    if width <= 0.0 || !position.is_finite() {
        return 0.0;
    }
    let raw = ((position - left) / width).clamp(0.0, 1.0);
    match steps {
        Some(steps) if steps > 0 => (raw * steps as f32).round() / steps as f32,
        _ => raw,
    }
}

#[derive(IntoElement)]
pub struct Slider {
    id: ElementId,
    key: u64,
    value: f32,
    steps: Option<u32>,
    p: Palette,
    on_change: Option<ValueHandler<f32>>,
}

impl Slider {
    pub fn new(id: impl Into<SharedString>, value: f32, p: &Palette) -> Self {
        let name: SharedString = id.into();
        let key = name.bytes().fold(0xcbf2_9ce4_8422_2325u64, |hash, byte| {
            (hash ^ u64::from(byte)).wrapping_mul(0x0100_0000_01b3)
        });
        Slider {
            id: ElementId::Name(name),
            key,
            value: value.clamp(0.0, 1.0),
            steps: None,
            p: *p,
            on_change: None,
        }
    }

    pub fn steps(mut self, steps: u32) -> Self {
        self.steps = Some(steps);
        self
    }

    pub fn on_change(mut self, handler: impl Fn(f32, &mut Window, &mut App) + 'static) -> Self {
        self.on_change = Some(Rc::new(handler));
        self
    }
}

impl RenderOnce for Slider {
    fn render(self, _: &mut Window, _: &mut App) -> impl IntoElement {
        let track = Rc::new(Cell::new(Bounds::<Pixels>::default()));
        let steps = self.steps;
        let key = self.key;
        let knob = 16.;
        let recorded = Rc::clone(&track);
        let pressed = self.on_change.clone();
        let dragged = self.on_change.clone();
        div()
            .id(self.id)
            .relative()
            .h(px(20.))
            .w_full()
            .flex()
            .items_center()
            .cursor_pointer()
            .child(
                canvas(move |bounds, _, _| recorded.set(bounds), |_, _, _, _| {})
                    .absolute()
                    .size_full(),
            )
            .child(
                div()
                    .h(px(4.))
                    .w_full()
                    .rounded_full()
                    .bg(self.p.switch_off),
            )
            .child(
                div()
                    .absolute()
                    .left_0()
                    .h(px(4.))
                    .w(relative(self.value))
                    .rounded_full()
                    .bg(self.p.form_accent),
            )
            .child(
                div()
                    .absolute()
                    .left(relative(self.value))
                    .ml(px(-knob / 2.))
                    .size(px(knob))
                    .rounded_full()
                    .bg(self.p.knob)
                    .border(px(0.5))
                    .border_color(self.p.knob_border)
                    .shadow(vec![shadow(self.p.shadow.opacity(0.6), 1., 2.5)]),
            )
            .on_mouse_down(
                MouseButton::Left,
                move |event: &MouseDownEvent, window, cx| {
                    cx.stop_propagation();
                    let bounds = track.get();
                    if let Some(handler) = &pressed {
                        let value = slider_value(
                            f32::from(event.position.x),
                            f32::from(bounds.left()),
                            f32::from(bounds.size.width),
                            steps,
                        );
                        handler(value, window, cx);
                    }
                },
            )
            .on_drag(SliderDrag(key), |_, _, _, cx| cx.new(|_| EmptyDrag))
            .on_drag_move(move |event: &DragMoveEvent<SliderDrag>, window, cx| {
                if event.drag(cx).0 != key {
                    return;
                }
                if let Some(handler) = &dragged {
                    let value = slider_value(
                        f32::from(event.event.position.x),
                        f32::from(event.bounds.left()),
                        f32::from(event.bounds.size.width),
                        steps,
                    );
                    handler(value, window, cx);
                }
            })
    }
}

pub mod segmented_metrics {
    use crate::primitives::tokens::{THICK_HAIRLINE, concentric, radius};

    pub const INSET: f32 = THICK_HAIRLINE;
    pub const HEIGHT: f32 = 20.;
    pub const IMAGE_WIDTH: f32 = 30.;
    pub const GLYPH: f32 = 11.;
    pub const GLYPH_BOX: f32 = 14.;

    pub fn segment_radius() -> f32 {
        concentric(radius::CONTROL, INSET)
    }
}

type Slots = Rc<RefCell<SmallVec<[Option<(f32, f32)>; 4]>>>;

struct SegmentedMotion {
    slots: Slots,
    row_left: Rc<Cell<f32>>,
    shown: usize,
    thumb: SpringPair,
}

impl SegmentedMotion {
    fn slot(&self, index: usize) -> Option<(f32, f32)> {
        self.slots.borrow().get(index).copied().flatten()
    }

    fn sync(&mut self, selected: usize, now: Instant, reduce: bool) {
        if selected == self.shown {
            return;
        }
        let from = if self.thumb.running(now, SNAPPY) {
            Some(self.thumb.value(now, SNAPPY))
        } else {
            self.slot(self.shown)
        };
        self.shown = selected;
        match (from, self.slot(selected)) {
            (Some(from), Some(to)) if !reduce => {
                self.thumb.jump(from);
                self.thumb.retarget(to, now, SNAPPY);
            }
            (_, Some(to)) => self.thumb.jump(to),
            _ => {}
        }
    }
}

#[derive(IntoElement)]
pub struct Segmented {
    id: ElementId,
    options: SmallVec<[(SharedString, Option<Icon>); 4]>,
    selected: usize,
    fill: bool,
    p: Palette,
    on_select: Option<ValueHandler<usize>>,
}

impl Segmented {
    pub fn new(id: impl Into<ElementId>, selected: usize, p: &Palette) -> Self {
        Segmented {
            id: id.into(),
            options: SmallVec::new(),
            selected,
            fill: false,
            p: *p,
            on_select: None,
        }
    }

    pub fn option(mut self, label: impl Into<SharedString>, glyph: Option<Icon>) -> Self {
        self.options.push((label.into(), glyph));
        self
    }

    pub fn fill(mut self, fill: bool) -> Self {
        self.fill = fill;
        self
    }

    pub fn on_select(mut self, handler: impl Fn(usize, &mut Window, &mut App) + 'static) -> Self {
        self.on_select = Some(Rc::new(handler));
        self
    }
}

impl RenderOnce for Segmented {
    fn render(self, window: &mut Window, cx: &mut App) -> impl IntoElement {
        use segmented_metrics as seg;
        let now = Instant::now();
        let reduce = cx.reduce_motion();
        let p = self.p;
        let selected = self.selected;
        let count = self.options.len();
        let state = window.use_keyed_state(self.id.clone(), cx, |_, _| SegmentedMotion {
            slots: Rc::new(RefCell::new(SmallVec::new())),
            row_left: Rc::new(Cell::new(0.0)),
            shown: selected,
            thumb: SpringPair::at((0.0, 0.0)),
        });
        let (slots, row_left, thumb) = state.update(cx, |motion, _| {
            motion.slots.borrow_mut().resize(count, None);
            motion.sync(selected, now, reduce);
            let thumb = motion
                .thumb
                .running(now, SNAPPY)
                .then(|| motion.thumb.value(now, SNAPPY));
            (Rc::clone(&motion.slots), Rc::clone(&motion.row_left), thumb)
        });
        if thumb.is_some() {
            window.request_animation_frame();
        }
        let handler = self.on_select;
        let fill = self.fill;
        let thumb_radius = seg::segment_radius();
        let row_origin = Rc::clone(&row_left);
        let segment_presses: SmallVec<[(gpui::Stateful<gpui::Div>, Interaction); 4]> = (0..count)
            .map(|index| {
                pressing(
                    div().id(("segment", index)),
                    press_key(&self.id, format!("segment-{index}")),
                    Some(press_scale::CONTROL),
                    window,
                    cx,
                )
            })
            .collect();
        div()
            .id(self.id)
            .flex_none()
            .when(fill, |this| this.w_full())
            .rounded(px(radius::CONTROL))
            .bg(p.control)
            .border(px(seg::INSET))
            .border_color(p.control_border)
            .p(px(seg::INSET))
            .child(
                div()
                    .relative()
                    .flex()
                    .flex_row()
                    .child(
                        canvas(
                            move |bounds, _, _| row_origin.set(f32::from(bounds.left())),
                            |_, _, _, _| {},
                        )
                        .absolute()
                        .size_full(),
                    )
                    .when_some(thumb, |this, (x, width)| {
                        this.child(
                            div()
                                .absolute()
                                .top_0()
                                .bottom_0()
                                .left(px(x))
                                .w(px(width))
                                .rounded(px(thumb_radius))
                                .bg(p.form_accent),
                        )
                    })
                    .children(
                        self.options
                            .into_iter()
                            .zip(segment_presses)
                            .enumerate()
                            .map(|(index, ((label, glyph), (segment, pressed)))| {
                                let on = index == selected;
                                let handler = handler.clone();
                                let slots = Rc::clone(&slots);
                                let row_left = Rc::clone(&row_left);
                                let ink = if on { p.on_accent } else { p.icon };
                                let text = if on { p.on_accent } else { p.text };
                                let image = glyph.is_some();
                                segment
                                    .relative()
                                    .h(px(seg::HEIGHT))
                                    .flex()
                                    .items_center()
                                    .justify_center()
                                    .when(image, |this| this.w(px(seg::IMAGE_WIDTH)))
                                    .when(!image, |this| this.px(px(space::M)))
                                    .when(fill && !image, |this| this.flex_1())
                                    .when(on && thumb.is_none(), |this| {
                                        this.rounded(px(thumb_radius)).bg(p.form_accent)
                                    })
                                    .child(
                                        canvas(
                                            move |bounds, _, _| {
                                                let left =
                                                    f32::from(bounds.left()) - row_left.get();
                                                if let Some(slot) =
                                                    slots.borrow_mut().get_mut(index)
                                                {
                                                    *slot =
                                                        Some((left, f32::from(bounds.size.width)));
                                                }
                                            },
                                            |_, _, _, _| {},
                                        )
                                        .absolute()
                                        .size_full(),
                                    )
                                    .when_some(handler, |this, handler| {
                                        this.on_click(move |_, window, cx| {
                                            handler(index, window, cx)
                                        })
                                    })
                                    .map(|this| match glyph {
                                        Some(glyph) => this
                                            .tooltip(tooltip(label.clone(), &p))
                                            .child(press_scaled(
                                                div()
                                                    .size(px(seg::GLYPH_BOX))
                                                    .flex()
                                                    .items_center()
                                                    .justify_center()
                                                    .child(icon(glyph, seg::GLYPH, ink)),
                                                pressed.scale,
                                            )),
                                        None => this
                                            .text_size(px(type_size::SMALL))
                                            .line_height(px(line_height::SMALL))
                                            .text_color(text)
                                            .child(press_scaled(div().child(label), pressed.scale)),
                                    })
                            }),
                    ),
            )
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CheckLook {
    Form,
    Ring,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CheckSize {
    S,
    M,
}

impl CheckSize {
    pub const fn ring(self) -> (f32, f32) {
        match self {
            CheckSize::S => (14., 8.),
            CheckSize::M => (18., 10.),
        }
    }
}

pub const CHECK_BOX: f32 = 14.;
pub const CHECK_GLYPH: f32 = 9.;
pub const CHECK_RING_BORDER: f32 = 1.5;
pub const RING_CHECK_REST_SCALE: f32 = 0.6;

#[derive(IntoElement)]
pub struct Checkbox {
    id: ElementId,
    checked: bool,
    mixed: bool,
    disabled: bool,
    look: CheckLook,
    size: CheckSize,
    label: SharedString,
    p: Palette,
    on_toggle: Option<ValueHandler<bool>>,
}

impl Checkbox {
    pub fn new(
        id: impl Into<ElementId>,
        checked: bool,
        label: impl Into<SharedString>,
        p: &Palette,
    ) -> Self {
        Checkbox {
            id: id.into(),
            checked,
            mixed: false,
            disabled: false,
            look: CheckLook::Form,
            size: CheckSize::M,
            label: label.into(),
            p: *p,
            on_toggle: None,
        }
    }

    pub fn mixed(mut self, mixed: bool) -> Self {
        self.mixed = mixed;
        self
    }

    pub fn disabled(mut self, disabled: bool) -> Self {
        self.disabled = disabled;
        self
    }

    pub fn ring(mut self, size: CheckSize) -> Self {
        self.look = CheckLook::Ring;
        self.size = size;
        self
    }

    pub fn on_toggle(mut self, handler: impl Fn(bool, &mut Window, &mut App) + 'static) -> Self {
        self.on_toggle = Some(Rc::new(handler));
        self
    }
}

pub fn check_glyph(checked: bool, mixed: bool) -> Option<Mark> {
    match (checked, mixed) {
        (true, _) => Some(Mark::Check),
        (false, true) => Some(Mark::Dash),
        (false, false) => None,
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Mark {
    Check,
    Dash,
}

pub const MARK_STROKE_PER_POINT: f32 = 1.6 / CHECK_GLYPH;

pub fn mark_points(mark: Mark, glyph: f32) -> SmallVec<[(f32, f32); 3]> {
    let unit = glyph / CHECK_GLYPH;
    let points: &[(f32, f32)] = match mark {
        Mark::Check => &[(-4.4, 0.2), (-1.4, 3.3), (3.1, -3.6)],
        Mark::Dash => &[(-3.5, 0.0), (3.5, 0.0)],
    };
    points.iter().map(|(x, y)| (x * unit, y * unit)).collect()
}

pub fn mark(mark: Mark, glyph: f32, side: f32, color: Hsla) -> impl IntoElement {
    canvas(
        |_, _, _| {},
        move |bounds, _, window, _| {
            let center = bounds.center();
            let options = gpui::StrokeOptions {
                line_width: glyph * MARK_STROKE_PER_POINT * crate::scale::current(),
                line_cap: gpui::LineCap::Round,
                line_join: gpui::LineJoin::Round,
                ..Default::default()
            };
            let mut builder =
                gpui::PathBuilder::stroke(px(0.)).with_style(gpui::PathStyle::Stroke(options));
            for (index, (x, y)) in mark_points(mark, glyph).into_iter().enumerate() {
                let at = gpui::point(center.x + px(x), center.y + px(y));
                if index == 0 {
                    builder.move_to(at);
                } else {
                    builder.line_to(at);
                }
            }
            if let Ok(path) = builder.build() {
                window.paint_path(path, color);
            }
        },
    )
    .flex_none()
    .size(px(side))
}

impl RenderOnce for Checkbox {
    fn render(self, window: &mut Window, cx: &mut App) -> impl IntoElement {
        let p = self.p;
        let checked = self.checked;
        let on = checked || self.mixed;
        let interactive = self.on_toggle.is_some() && !self.disabled;
        let (row, pressed) = pressing(
            div().id(self.id.clone()),
            press_key(&self.id, "check"),
            interactive.then_some(press_scale::ICON),
            window,
            cx,
        );
        let face = match self.look {
            CheckLook::Ring => ring_check(self.id.clone(), on, self.size, &p, window, cx),
            CheckLook::Form => div()
                .flex_none()
                .size(px(CHECK_BOX))
                .rounded(px(radius::CONTROL))
                .flex()
                .items_center()
                .justify_center()
                .when(on, |this| this.bg(p.form_accent))
                .when(!on, |this| {
                    this.bg(p.control)
                        .border(px(THICK_HAIRLINE))
                        .border_color(p.control_border)
                })
                .when_some(check_glyph(checked, self.mixed), |this, glyph| {
                    this.child(mark(glyph, CHECK_GLYPH, CHECK_BOX, p.on_accent))
                })
                .into_any_element(),
        };
        let label = self.label;
        let face = press_scaled(div().flex_none().child(face), pressed.scale);
        row.flex()
            .items_center()
            .gap(px(space::M))
            .text_size(px(type_size::BODY))
            .text_color(p.text)
            .when(self.disabled, |this| this.opacity(DISABLED_OPACITY))
            .when_some(self.on_toggle.filter(|_| interactive), |this, handler| {
                this.on_click(move |_, window, cx| handler(!checked, window, cx))
            })
            .child(face)
            .when(!label.is_empty() && self.look == CheckLook::Form, |this| {
                this.child(label)
            })
    }
}

struct FadeMotion {
    on: bool,
    tween: Tween,
}

fn ring_check(
    id: ElementId,
    on: bool,
    size: CheckSize,
    p: &Palette,
    window: &mut Window,
    cx: &mut App,
) -> AnyElement {
    let now = Instant::now();
    let (side, glyph) = size.ring();
    let state = window.use_keyed_state(
        ElementId::NamedChild(std::sync::Arc::new(id), "ring".into()),
        cx,
        |_, _| FadeMotion {
            on,
            tween: Tween::at(if on { 1.0 } else { 0.0 }),
        },
    );
    let (t, running) = state.update(cx, |motion, _| {
        if motion.on != on {
            motion.on = on;
            motion.tween.retarget(
                if on { 1.0 } else { 0.0 },
                duration::BASE,
                Curve::Enter,
                now,
            );
        }
        (motion.tween.value(now), motion.tween.running(now))
    });
    if running {
        window.request_animation_frame();
    }
    let scale = RING_CHECK_REST_SCALE + (1.0 - RING_CHECK_REST_SCALE) * t;
    let disc = side * scale;
    let offset = (side - disc) / 2.0 - CHECK_RING_BORDER;
    div()
        .flex_none()
        .relative()
        .size(px(side))
        .rounded(px(capsule(side)))
        .bg(p.ring_radio_fill)
        .border(px(CHECK_RING_BORDER))
        .border_color(p.ring_radio_border)
        .overflow_hidden()
        .when(t > 0.0, |this| {
            this.child(
                div()
                    .absolute()
                    .left(px(offset))
                    .top(px(offset))
                    .size(px(disc))
                    .rounded(px(capsule(disc)))
                    .bg(p.ring_radio_on.opacity(t))
                    .flex()
                    .items_center()
                    .justify_center()
                    .child(icon(Icon::Check, glyph * scale, p.on_go.opacity(t))),
            )
        })
        .into_any_element()
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RadioLook {
    Form,
    Compact,
    Ring,
}

pub mod radio_metrics {
    pub const RING_BOX: f32 = 16.;
    pub const RING_ON: f32 = 5.;
    pub const RING_OFF: f32 = 1.5;
    pub const COMPACT_BOX: f32 = 14.;
    pub const COMPACT_DOT: f32 = 5.;
    pub const FORM_BOX: f32 = 16.;
    pub const FORM_DOT: f32 = 6.;
}

pub fn radio(on: bool, look: RadioLook, p: &Palette) -> gpui::Div {
    use radio_metrics as r;
    let dot = |side: f32, color: Hsla| div().size(px(side)).rounded(px(capsule(side))).bg(color);
    match look {
        RadioLook::Ring => div()
            .flex_none()
            .size(px(r::RING_BOX))
            .rounded(px(capsule(r::RING_BOX)))
            .bg(p.ring_radio_fill)
            .border(px(if on { r::RING_ON } else { r::RING_OFF }))
            .border_color(if on {
                p.ring_radio_on
            } else {
                p.ring_radio_border
            }),
        RadioLook::Compact => div()
            .flex_none()
            .size(px(r::COMPACT_BOX))
            .rounded(px(capsule(r::COMPACT_BOX)))
            .flex()
            .items_center()
            .justify_center()
            .when(on, |this| {
                this.bg(p.form_accent)
                    .child(dot(r::COMPACT_DOT, p.on_accent))
            })
            .when(!on, |this| {
                this.bg(p.control)
                    .border(px(THICK_HAIRLINE))
                    .border_color(p.field_border)
            }),
        RadioLook::Form => div()
            .flex_none()
            .size(px(r::FORM_BOX))
            .rounded(px(capsule(r::FORM_BOX)))
            .flex()
            .items_center()
            .justify_center()
            .when(on, |this| {
                this.bg(p.form_accent).child(dot(r::FORM_DOT, p.on_accent))
            })
            .when(!on, |this| {
                this.bg(p.control)
                    .border(px(THICK_HAIRLINE))
                    .border_color(p.control_border)
            }),
    }
}

pub mod lively_swatch {
    use crate::primitives::tokens::swatch;

    pub const REST_INSET: f32 = swatch::INSET + swatch::RING;
    pub const HOVER_INSET: f32 = swatch::RING + 1.0;
    pub const SELECTED_INSET: f32 = 2.0 * (swatch::INSET + swatch::RING) - swatch::RING;
    pub const REST_OPACITY: f32 = 0.85;

    pub fn disc(size: f32, hovered: bool, selected: f32) -> f32 {
        let rest = size - 2.0 * if hovered { HOVER_INSET } else { REST_INSET };
        let chosen = size - 2.0 * SELECTED_INSET;
        rest + (chosen - rest) * selected
    }
}

struct SwatchMotion {
    selected: bool,
    hovered: bool,
    tween: Tween,
}

#[derive(IntoElement)]
pub struct Swatch {
    id: ElementId,
    selected: bool,
    ring: Hsla,
    fill: Option<Hsla>,
    size: f32,
    animated: bool,
    children: SmallVec<[AnyElement; 1]>,
    on_click: Option<ClickHandler>,
}

impl Swatch {
    pub fn new(id: impl Into<ElementId>, selected: bool, ring: impl Into<Hsla>) -> Self {
        Swatch {
            id: id.into(),
            selected,
            ring: ring.into(),
            fill: None,
            size: swatch::SIZE,
            animated: false,
            children: SmallVec::new(),
            on_click: None,
        }
    }

    pub fn fill(mut self, fill: impl Into<Hsla>) -> Self {
        self.fill = Some(fill.into());
        self
    }

    pub fn size(mut self, size: f32) -> Self {
        self.size = size;
        self
    }

    pub fn animated(mut self, animated: bool) -> Self {
        self.animated = animated;
        self
    }

    pub fn on_click(
        mut self,
        handler: impl Fn(&gpui::ClickEvent, &mut Window, &mut App) + 'static,
    ) -> Self {
        self.on_click = Some(Rc::new(handler));
        self
    }
}

impl ParentElement for Swatch {
    fn extend(&mut self, elements: impl IntoIterator<Item = AnyElement>) {
        self.children.extend(elements);
    }
}

impl RenderOnce for Swatch {
    fn render(self, window: &mut Window, cx: &mut App) -> impl IntoElement {
        let size = self.size;
        let shell = div()
            .id(self.id.clone())
            .flex_none()
            .size(px(size))
            .when_some(self.on_click, |this, handler| {
                this.on_click(move |event, window, cx| handler(event, window, cx))
            });
        if !self.animated {
            return shell
                .p(px(swatch::INSET))
                .border(px(swatch::RING))
                .border_color(if self.selected {
                    self.ring
                } else {
                    gpui::transparent_black()
                })
                .rounded(px(capsule(size)))
                .child(
                    div()
                        .size_full()
                        .overflow_hidden()
                        .rounded(px(capsule(size) - swatch::INSET))
                        .when_some(self.fill, |this, fill| this.bg(fill))
                        .children(self.children),
                );
        }
        let now = Instant::now();
        let selected = self.selected;
        let state = window.use_keyed_state(self.id, cx, |_, _| SwatchMotion {
            selected,
            hovered: false,
            tween: Tween::at(if selected { 1.0 } else { 0.0 }),
        });
        let (t, hovered, running) = state.update(cx, |motion, _| {
            if motion.selected != selected {
                motion.selected = selected;
                motion.tween.retarget(
                    if selected { 1.0 } else { 0.0 },
                    duration::BASE,
                    Curve::Enter,
                    now,
                );
            }
            (
                motion.tween.value(now),
                motion.hovered,
                motion.tween.running(now),
            )
        });
        if running {
            window.request_animation_frame();
        }
        let disc = lively_swatch::disc(size, hovered, t);
        let hover_state = state.clone();
        shell
            .relative()
            .flex()
            .items_center()
            .justify_center()
            .on_hover(move |hovered, _, cx| {
                hover_state.update(cx, |motion, cx| {
                    motion.hovered = *hovered;
                    cx.notify();
                })
            })
            .child(
                div()
                    .absolute()
                    .inset_0()
                    .rounded(px(capsule(size)))
                    .border(px(swatch::RING))
                    .border_color(self.ring.opacity(t)),
            )
            .child(
                div()
                    .size(px(disc))
                    .rounded(px(capsule(size)))
                    .overflow_hidden()
                    .when_some(self.fill, |this, fill| this.bg(fill))
                    .opacity(if hovered || selected {
                        1.0
                    } else {
                        lively_swatch::REST_OPACITY
                    })
                    .children(self.children),
            )
    }
}

pub mod pop_up_metrics {
    pub const HEIGHT: f32 = 22.;
    pub const MIN_WIDTH: f32 = 120.;
    pub const INDICATOR: f32 = 16.;
    pub const INDICATOR_GLYPH: f32 = 8.;
    pub const PLAIN_MAX_WIDTH: f32 = 260.;
    pub const PLAIN_GLYPH: f32 = 9.;
    pub const PLAIN_GLYPH_BOX: (f32, f32) = (10., 14.);
}

#[derive(IntoElement)]
pub struct PopUp {
    id: ElementId,
    title: SharedString,
    min_width: f32,
    disabled: bool,
    native: bool,
    p: Palette,
    on_click: Option<ClickHandler>,
}

impl PopUp {
    pub fn new(id: impl Into<ElementId>, title: impl Into<SharedString>, p: &Palette) -> Self {
        PopUp {
            id: id.into(),
            title: title.into(),
            min_width: pop_up_metrics::MIN_WIDTH,
            disabled: false,
            native: false,
            p: *p,
            on_click: None,
        }
    }

    pub fn min_width(mut self, min_width: f32) -> Self {
        self.min_width = min_width;
        self
    }

    pub fn disabled(mut self, disabled: bool) -> Self {
        self.disabled = disabled;
        self
    }

    pub fn native(mut self, native: bool) -> Self {
        self.native = native;
        self
    }

    pub fn on_click(
        mut self,
        handler: impl Fn(&gpui::ClickEvent, &mut Window, &mut App) + 'static,
    ) -> Self {
        self.on_click = Some(Rc::new(handler));
        self
    }
}

impl RenderOnce for PopUp {
    fn render(self, window: &mut Window, cx: &mut App) -> impl IntoElement {
        use pop_up_metrics as m;
        let p = self.p;
        let enabled = !self.disabled;
        if !self.native {
            return self.desktop(window, cx).into_any_element();
        }
        let base = div()
            .id(self.id)
            .h(px(m::HEIGHT))
            .rounded(px(radius::CONTROL))
            .flex()
            .flex_row()
            .items_center()
            .text_size(px(type_size::BODY))
            .text_color(p.text)
            .when(self.disabled, |this| this.opacity(DISABLED_OPACITY))
            .when(enabled, |this| {
                this.hover(move |style| style.bg(p.control_hover))
                    .active(move |style| style.bg(p.control_pressed))
            })
            .when_some(self.on_click.filter(|_| enabled), |this, handler| {
                this.on_click(move |event, window, cx| handler(event, window, cx))
            });
        base.max_w(px(m::PLAIN_MAX_WIDTH))
            .pl(px(space::S))
            .pr(px(space::XXS))
            .justify_end()
            .gap(px(space::XS))
            .child(div().flex_shrink(1.).min_w_0().truncate().child(self.title))
            .child(
                div()
                    .flex_none()
                    .w(px(m::PLAIN_GLYPH_BOX.0))
                    .h(px(m::PLAIN_GLYPH_BOX.1))
                    .flex()
                    .items_center()
                    .justify_center()
                    .child(icon(Icon::ChevronUpDown, m::PLAIN_GLYPH, p.text_secondary)),
            )
            .into_any_element()
    }
}

impl PopUp {
    fn desktop(self, window: &mut Window, cx: &mut App) -> impl IntoElement {
        use pop_up_metrics as m;
        let p = self.p;
        let enabled = !self.disabled;
        let key = press_key(&self.id, "pop-up");
        let (element, shown) = pressing(
            div().id(self.id),
            key,
            enabled.then_some(press_scale::CONTROL),
            window,
            cx,
        );
        let fill = match (enabled && shown.pressed, enabled && shown.hovered) {
            (true, _) => p.control_pressed,
            (false, true) => p.control_hover,
            _ => p.control,
        };
        let body = div()
            .h(px(m::HEIGHT))
            .min_w(px(self.min_width))
            .rounded(px(radius::CONTROL))
            .flex()
            .flex_row()
            .items_center()
            .pl(px(space::M))
            .pr(px(space::XS))
            .gap(px(space::S))
            .bg(fill)
            .border(px(THICK_HAIRLINE))
            .border_color(p.control_border)
            .text_size(px(type_size::BODY))
            .text_color(p.text)
            .child(div().flex_1().min_w_0().truncate().child(self.title))
            .child(
                div()
                    .flex_none()
                    .size(px(m::INDICATOR))
                    .rounded(px(radius::CONTROL))
                    .bg(p.form_accent)
                    .flex()
                    .items_center()
                    .justify_center()
                    .child(icon(Icon::ChevronUpDown, m::INDICATOR_GLYPH, p.on_accent)),
            );
        element
            .flex_none()
            .when(self.disabled, |this| this.opacity(DISABLED_OPACITY))
            .when_some(self.on_click.filter(|_| enabled), |this, handler| {
                this.on_click(move |event, window, cx| handler(event, window, cx))
            })
            .child(press_scaled(body, shown.scale))
    }
}

fn press_key(id: &ElementId, part: impl Into<SharedString>) -> ElementId {
    ElementId::NamedChild(std::sync::Arc::new(id.clone()), part.into())
}

fn pressing(
    element: gpui::Stateful<gpui::Div>,
    key: ElementId,
    scale: Option<f32>,
    window: &mut Window,
    cx: &mut App,
) -> (gpui::Stateful<gpui::Div>, Interaction) {
    let state = press_state(&key, window, cx);
    let shown = resolve_interaction(&state, |_, _| false, true, window, cx);
    (track_press(element, &state, scale, cx), shown)
}

pub mod field_metrics {
    pub const TEXT_HEIGHT: f32 = 24.;
    pub const MULTILINE_HEIGHT: f32 = 96.;
    pub const SEARCH_HEIGHT: f32 = 28.;
    pub const SEARCH_GLYPH: f32 = 12.;
    pub const SEARCH_GLYPH_BOX: f32 = 14.;
    pub const BARE_SEARCH_GLYPH: f32 = 13.;
    pub const BARE_SEARCH_GLYPH_BOX: f32 = 16.;
    pub const CLEAR_GLYPH: f32 = 12.;
    pub const CLEAR_DISC: f32 = 10.;
    pub const CLEAR_CROSS: f32 = 6.;
    pub const CLEAR_GLYPH_BOX: f32 = 16.;
}

pub fn field_box(p: &Palette) -> gpui::Div {
    div()
        .h(px(28.))
        .px(px(8.))
        .rounded(px(7.))
        .bg(p.field)
        .border(px(0.5))
        .border_color(p.field_border)
        .flex()
        .items_center()
}

pub fn text_field_box(p: &Palette, invalid: bool) -> gpui::Div {
    div()
        .h(px(field_metrics::TEXT_HEIGHT))
        .px(px(space::M))
        .rounded(px(radius::CONTROL))
        .bg(p.field)
        .border(px(THICK_HAIRLINE))
        .border_color(if invalid {
            p.destructive
        } else {
            p.field_border
        })
        .flex()
        .items_center()
        .text_size(px(type_size::BODY))
        .text_color(p.text)
}

pub fn multiline_field_box(p: &Palette, invalid: bool) -> gpui::Div {
    text_field_box(p, invalid)
        .h(px(field_metrics::MULTILINE_HEIGHT))
        .py(px(space::M))
        .items_start()
        .line_height(px(line_height::PROSE_BODY))
}

pub fn search_field_box(p: &Palette) -> gpui::Div {
    div()
        .h(px(field_metrics::SEARCH_HEIGHT))
        .px(px(space::M))
        .gap(px(space::XS))
        .rounded(px(radius::TILE))
        .bg(p.field)
        .border(px(THICK_HAIRLINE))
        .border_color(p.field_border)
        .flex()
        .flex_row()
        .items_center()
        .text_size(px(type_size::BODY))
        .text_color(p.text)
        .child(
            div()
                .flex_none()
                .size(px(field_metrics::SEARCH_GLYPH_BOX))
                .flex()
                .items_center()
                .justify_center()
                .child(icon(
                    Icon::Search,
                    field_metrics::SEARCH_GLYPH,
                    p.text_secondary,
                )),
        )
}

pub fn bare_search_field(p: &Palette) -> gpui::Div {
    div()
        .flex()
        .flex_row()
        .items_center()
        .gap(px(space::S))
        .text_size(px(type_size::TITLE))
        .text_color(p.text)
        .child(
            div()
                .flex_none()
                .size(px(field_metrics::BARE_SEARCH_GLYPH_BOX))
                .flex()
                .items_center()
                .justify_center()
                .child(icon(
                    Icon::Search,
                    field_metrics::BARE_SEARCH_GLYPH,
                    p.text_secondary,
                )),
        )
}

pub fn search_clear_button(
    id: impl Into<ElementId>,
    p: &Palette,
    on_clear: impl Fn(&gpui::ClickEvent, &mut Window, &mut App) + 'static,
) -> impl IntoElement {
    SearchClear {
        id: id.into(),
        p: *p,
        on_clear: Rc::new(on_clear),
    }
}

#[derive(IntoElement)]
struct SearchClear {
    id: ElementId,
    p: Palette,
    on_clear: ClickHandler,
}

impl RenderOnce for SearchClear {
    fn render(self, window: &mut Window, cx: &mut App) -> impl IntoElement {
        let p = self.p;
        let key = press_key(&self.id, "clear");
        let (element, shown) =
            pressing(div().id(self.id), key, Some(press_scale::ICON), window, cx);
        let on_clear = self.on_clear;
        element
            .flex_none()
            .size(px(field_metrics::CLEAR_GLYPH_BOX))
            .flex()
            .items_center()
            .justify_center()
            .tooltip(tooltip("Clear".into(), &p))
            .on_click(move |event, window, cx| on_clear(event, window, cx))
            .child(press_scaled(
                div()
                    .size(px(field_metrics::CLEAR_GLYPH_BOX))
                    .flex()
                    .items_center()
                    .justify_center()
                    .child(
                        div()
                            .size(px(field_metrics::CLEAR_DISC))
                            .rounded(px(capsule(field_metrics::CLEAR_DISC)))
                            .bg(p.text_tertiary)
                            .flex()
                            .items_center()
                            .justify_center()
                            .child(icon(Icon::XMark, field_metrics::CLEAR_CROSS, p.field)),
                    ),
                shown.scale,
            ))
    }
}

pub fn hover_fill_tween(tween: &mut Tween, shown: bool, instant: bool, now: Instant) {
    let target = if shown { 1.0 } else { 0.0 };
    if instant {
        tween.jump(target);
    } else {
        tween.retarget(
            target,
            if shown {
                hover_fade::SHOW
            } else {
                hover_fade::HIDE
            },
            Curve::Fade,
            now,
        );
    }
}

#[cfg(test)]
mod form_tests {
    use super::*;

    #[test]
    fn switch_metrics_match_the_old_looks() {
        assert_eq!(ToggleLook::Form.metrics().travel(), 14.);
        assert_eq!(ToggleLook::NativeForm.metrics().travel(), 11.);
        assert_eq!(ToggleLook::Panel.metrics().travel(), 13.);
        assert_eq!(SWITCH_WIDTH, 32.);
        assert_eq!(SWITCH_HEIGHT, 18.);
        assert!(ToggleLook::Panel.animates_external_changes());
        assert!(!ToggleLook::Form.animates_external_changes());
    }

    #[test]
    fn a_pressed_switch_slides_at_once_and_holds_until_the_value_lands() {
        let start = Instant::now();
        let mut motion = ToggleMotion::new(false);
        assert!(motion.press(start, false));
        assert!(motion.progress.running(start + Duration::from_millis(10)));
        motion.sync(false, start + Duration::from_millis(20), false);
        assert!(motion.target);
        motion.sync(true, start + Duration::from_millis(30), false);
        assert_eq!(
            motion.progress.value(start + Duration::from_millis(200)),
            1.0
        );
    }

    #[test]
    fn form_switches_jump_on_outside_changes_and_panel_switches_slide() {
        let start = Instant::now();
        let mut form = ToggleMotion::new(false);
        form.sync(true, start, false);
        assert!(!form.progress.running(start));
        assert_eq!(form.progress.value(start), 1.0);
        let mut panel = ToggleMotion::new(false);
        panel.sync(true, start, true);
        assert!(panel.progress.running(start + Duration::from_millis(10)));
    }

    #[test]
    fn an_asking_switch_waits_for_the_answer() {
        let start = Instant::now();
        let mut motion = ToggleMotion::new(false);
        assert!(motion.press(start, true));
        assert!(!motion.target);
        motion.sync(true, start + Duration::from_millis(500), false);
        assert!(motion.progress.running(start + Duration::from_millis(510)));
    }

    #[test]
    fn a_refused_press_slides_back_after_the_window() {
        let start = Instant::now();
        let mut motion = ToggleMotion::new(false);
        motion.press(start, false);
        motion.sync(false, start + USER_CHANGE_WINDOW, false);
        assert!(!motion.target);
    }

    #[test]
    fn segment_and_check_geometry_match_the_old_tokens() {
        assert_eq!(segmented_metrics::segment_radius(), 3.);
        assert_eq!(CheckSize::S.ring(), (14., 8.));
        assert_eq!(CheckSize::M.ring(), (18., 10.));
        assert_eq!(check_glyph(true, true), Some(Mark::Check));
        assert_eq!(check_glyph(false, true), Some(Mark::Dash));
        assert_eq!(mark_points(Mark::Dash, 18.)[1], (7., 0.));
        assert_eq!(check_glyph(false, false), None);
    }

    #[test]
    fn lively_swatch_discs_shrink_when_chosen() {
        assert_eq!(lively_swatch::disc(20., false, 0.), 12.);
        assert_eq!(lively_swatch::disc(20., true, 0.), 14.);
        assert_eq!(lively_swatch::disc(20., false, 1.), 8.);
    }

    #[test]
    fn hover_fills_fade_in_fast_and_out_slow() {
        let start = Instant::now();
        let mut tween = Tween::at(0.0);
        hover_fill_tween(&mut tween, true, false, start);
        assert_eq!(tween.duration, hover_fade::SHOW);
        hover_fill_tween(&mut tween, false, false, start + Duration::from_millis(60));
        assert_eq!(tween.duration, hover_fade::HIDE);
        hover_fill_tween(&mut tween, true, true, start);
        assert!(!tween.running(start));
    }
}
