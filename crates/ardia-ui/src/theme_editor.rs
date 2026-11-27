use std::cell::Cell;
use std::rc::Rc;
use std::sync::{Arc, OnceLock};

use ardia_theme::profile_theme::{
    MAX_THEME_STOPS, PAD_LIGHTNESS, ThemeColor, ThemeMode, ThemeStop, pad_color, pad_position,
    stop_lightness,
};
use ardia_theme::{ProfileTheme, RgbaColor, ThemeLook, ThemeTexture};
use gpui::{
    AnyElement, App, Bounds, DragMoveEvent, FontWeight, Image, ImageFormat, IntoElement,
    MouseButton, MouseDownEvent, MouseUpEvent, ParentElement, Pixels, SharedString, Styled, Window,
    canvas, div, img, prelude::*,
};

use crate::look::Palette;
use crate::primitives::controls::{EmptyDrag, PopUp};
use crate::primitives::theme_bridge::hsla;
use crate::scale::px;

type Slide = Rc<dyn Fn(f64, bool, &mut Window, &mut App)>;

pub const PAD: f32 = 172.0;
pub const KNOB: f32 = 22.0;
pub const LABEL: f32 = 112.0;
pub const LIGHTNESS_STEPS: usize = 24;
pub const THUMB: f32 = 14.0;
pub const DIAL: f32 = 28.0;
pub const DIAL_SNAP: f64 = 4.0;
pub const DIAL_HUB: f32 = 5.0;
pub const KNOB_OUTLINE: u32 = 0x0000_0040;
pub const THUMB_BORDER: u32 = 0x0000_0033;
const SAME_VALUE: f64 = 1e-9;
const SAME_COLOUR: f64 = 0.002;
const SAME_ANGLE: f64 = 0.5;

pub type Change = Rc<dyn Fn(ProfileTheme, bool, &mut Window, &mut App)>;
pub type Pick = Rc<dyn Fn(usize, &mut Window, &mut App)>;
pub type Action = Rc<dyn Fn(&mut Window, &mut App)>;

pub fn texture_name(texture: ThemeTexture) -> &'static str {
    match texture {
        ThemeTexture::Grain => "Grain",
        ThemeTexture::Sand => "Sand",
        ThemeTexture::Denim => "Denim",
        ThemeTexture::Tweed => "Tweed",
    }
}

fn near(a: f64, b: f64, within: f64) -> bool {
    (a - b).abs() <= within
}

pub fn preset_starting_theme(swatch: RgbaColor) -> ProfileTheme {
    let color = ThemeColor::from_rgba(swatch);
    let (x, y) = pad_position(color);
    ProfileTheme {
        look: ThemeLook {
            stops: vec![ThemeStop { color, x, y }],
            intensity: 0.6,
            grain: 0.0,
            texture: ThemeTexture::Grain,
            translucency: 1.0,
            angle: None,
        },
        mode: ThemeMode::Auto,
        dark: None,
    }
}

pub fn same_look(a: &ThemeLook, b: &ThemeLook) -> bool {
    a.texture == b.texture
        && a.stops.len() == b.stops.len()
        && near(a.intensity, b.intensity, SAME_VALUE)
        && near(a.grain, b.grain, SAME_VALUE)
        && near(a.translucency, b.translucency, SAME_VALUE)
        && near(a.angle(), b.angle(), SAME_ANGLE)
        && a.stops.iter().zip(&b.stops).all(|(s, o)| {
            near(s.x, o.x, SAME_VALUE)
                && near(s.y, o.y, SAME_VALUE)
                && near(s.color.r, o.color.r, SAME_COLOUR)
                && near(s.color.g, o.color.g, SAME_COLOUR)
                && near(s.color.b, o.color.b, SAME_COLOUR)
                && near(s.color.a, o.color.a, SAME_COLOUR)
        })
}

pub fn is_untouched(theme: &ProfileTheme, start: &ProfileTheme) -> bool {
    theme.dark.is_none() && theme.mode == start.mode && same_look(&theme.look, &start.look)
}

pub fn snap_to_start(value: f64, start: f64, pixels: f64) -> f64 {
    if (value - start).abs() * pixels <= 0.5 {
        start
    } else {
        value
    }
}

pub fn snap_point_to_start(point: (f64, f64), start: (f64, f64), pad: f64) -> (f64, f64) {
    if (point.0 - start.0).abs() * pad <= 0.5 && (point.1 - start.1).abs() * pad <= 0.5 {
        start
    } else {
        point
    }
}

pub fn inside_circle(p: (f64, f64)) -> (f64, f64) {
    let (dx, dy) = (p.0 - 0.5, p.1 - 0.5);
    let r = dx.hypot(dy);
    if r <= 0.5 {
        p
    } else {
        (0.5 + dx / r * 0.5, 0.5 + dy / r * 0.5)
    }
}

pub fn dial_angle(dx: f64, dy: f64) -> f64 {
    let degrees = (dx.atan2(-dy).to_degrees() + 360.0) % 360.0;
    let notch = (degrees / 45.0).round() * 45.0;
    (if (degrees - notch).abs() <= DIAL_SNAP {
        notch
    } else {
        degrees.round()
    }) % 360.0
}

fn hex_of(c: ardia_theme::ThemeColor) -> gpui::Hsla {
    hsla(c.to_rgba())
}

pub(crate) fn bmp(width: usize, height: usize, bgra: &[u8]) -> Vec<u8> {
    let header = 14 + 108;
    let size = header + bgra.len();
    let mut out = Vec::with_capacity(size);
    out.extend_from_slice(b"BM");
    out.extend_from_slice(&(size as u32).to_le_bytes());
    out.extend_from_slice(&[0, 0, 0, 0]);
    out.extend_from_slice(&(header as u32).to_le_bytes());
    out.extend_from_slice(&108u32.to_le_bytes());
    out.extend_from_slice(&(width as i32).to_le_bytes());
    out.extend_from_slice(&(-(height as i32)).to_le_bytes());
    out.extend_from_slice(&1u16.to_le_bytes());
    out.extend_from_slice(&32u16.to_le_bytes());
    out.extend_from_slice(&3u32.to_le_bytes());
    out.extend_from_slice(&(bgra.len() as u32).to_le_bytes());
    out.extend_from_slice(&2835i32.to_le_bytes());
    out.extend_from_slice(&2835i32.to_le_bytes());
    out.extend_from_slice(&0u32.to_le_bytes());
    out.extend_from_slice(&0u32.to_le_bytes());
    out.extend_from_slice(&0x00FF_0000u32.to_le_bytes());
    out.extend_from_slice(&0x0000_FF00u32.to_le_bytes());
    out.extend_from_slice(&0x0000_00FFu32.to_le_bytes());
    out.extend_from_slice(&0xFF00_0000u32.to_le_bytes());
    out.extend_from_slice(b"BGRs");
    out.extend_from_slice(&[0u8; 48]);
    out.extend_from_slice(bgra);
    out
}

pub fn pad_pixels(side: usize) -> Vec<u8> {
    let mut bgra = vec![0u8; side * side * 4];
    let half = side as f64 / 2.0;
    for row in 0..side {
        for col in 0..side {
            let (x, y) = (
                (col as f64 + 0.5) / side as f64,
                (row as f64 + 0.5) / side as f64,
            );
            let r = ((col as f64 + 0.5) - half).hypot((row as f64 + 0.5) - half);
            let alpha = (half - r + 0.5).clamp(0.0, 1.0);
            if alpha <= 0.0 {
                continue;
            }
            let c = pad_color(x, y, PAD_LIGHTNESS);
            let i = (row * side + col) * 4;
            let channel = |v: f64| (v.clamp(0.0, 1.0) * alpha * 255.0).round() as u8;
            bgra[i] = channel(c.b);
            bgra[i + 1] = channel(c.g);
            bgra[i + 2] = channel(c.r);
            bgra[i + 3] = (alpha * 255.0).round() as u8;
        }
    }
    bgra
}

pub fn pad_image() -> Arc<Image> {
    static PAD_IMAGE: OnceLock<Arc<Image>> = OnceLock::new();
    Arc::clone(PAD_IMAGE.get_or_init(|| {
        let side = (PAD * 2.0) as usize;
        Arc::new(Image::from_bytes(
            ImageFormat::Bmp,
            bmp(side, side, &pad_pixels(side)),
        ))
    }))
}

pub struct ThemeEditor {
    pub id: SharedString,
    pub theme: ProfileTheme,
    pub start: Option<ProfileTheme>,
    pub selected: usize,
    pub stacked: bool,
    pub p: Palette,
    pub on_change: Change,
    pub on_select: Pick,
    pub on_reset: Option<Action>,
    pub on_texture_menu: Action,
    pub native_form: bool,
}

#[derive(Clone, Copy)]
struct PadDrag(u64);
#[derive(Clone, Copy)]
struct TrackDrag(u64);
#[derive(Clone, Copy)]
struct DialDrag(u64);

fn key(id: &str, part: &str) -> u64 {
    format!("{id}:{part}")
        .bytes()
        .fold(0xcbf2_9ce4_8422_2325u64, |h, b| {
            (h ^ u64::from(b)).wrapping_mul(0x0100_0000_01b3)
        })
}

fn label(text: &'static str, p: &Palette) -> AnyElement {
    div()
        .text_size(px(12.))
        .text_color(p.text)
        .whitespace_nowrap()
        .child(text)
        .into_any_element()
}

#[allow(clippy::too_many_arguments)]
fn track(
    id: SharedString,
    value: f32,
    snap: Option<f64>,
    bar: AnyElement,
    thumb: Option<gpui::Hsla>,
    p: &Palette,
    on_change: Slide,
) -> AnyElement {
    let _ = p;
    let bounds = Rc::new(Cell::new(Bounds::<Pixels>::default()));
    let recorded = Rc::clone(&bounds);
    let drag_key = key(&id, "track");
    let value_at = move |x: Pixels, b: Bounds<Pixels>| {
        let width = f64::from(f32::from(b.size.width));
        if width <= 0.0 {
            return None;
        }
        let v =
            ((f64::from(f32::from(x)) - f64::from(f32::from(b.left()))) / width).clamp(0.0, 1.0);
        Some(snap.map_or(v, |s| snap_to_start(v, s, width)))
    };
    let (down, moved, up) = (on_change.clone(), on_change.clone(), on_change);
    let down_bounds = Rc::clone(&bounds);
    let up_bounds = Rc::clone(&bounds);
    div()
        .id(id)
        .px(px(THUMB / 2.))
        .child(
            div()
                .relative()
                .h(px(20.))
                .flex()
                .items_center()
                .child(
                    canvas(move |b, _, _| recorded.set(b), |_, _, _, _| {})
                        .absolute()
                        .size_full(),
                )
                .child(div().w_full().child(bar))
                .child(
                    div()
                        .absolute()
                        .left(gpui::relative(value))
                        .ml(px(-THUMB / 2.))
                        .size(px(THUMB))
                        .rounded_full()
                        .bg(thumb.unwrap_or(gpui::white()))
                        .border(px(if thumb.is_some() { 2.0 } else { 1.0 }))
                        .border_color(if thumb.is_some() {
                            gpui::white()
                        } else {
                            hsla(ardia_theme::RgbaColor::hexa(THUMB_BORDER))
                        })
                        .when(thumb.is_some(), |this| {
                            this.child(
                                div()
                                    .absolute()
                                    .inset(px(-5.))
                                    .rounded_full()
                                    .border(px(1.))
                                    .border_color(hsla(ardia_theme::RgbaColor::hexa(KNOB_OUTLINE))),
                            )
                        }),
                ),
        )
        .cursor_pointer()
        .on_mouse_down(MouseButton::Left, move |e: &MouseDownEvent, window, cx| {
            cx.stop_propagation();
            if let Some(v) = value_at(e.position.x, down_bounds.get()) {
                down(v, false, window, cx);
            }
        })
        .on_mouse_up(MouseButton::Left, move |e: &MouseUpEvent, window, cx| {
            if let Some(v) = value_at(e.position.x, up_bounds.get()) {
                up(v, true, window, cx);
            }
        })
        .on_drag(TrackDrag(drag_key), |_, _, _, cx| cx.new(|_| EmptyDrag))
        .on_drag_move(move |e: &DragMoveEvent<TrackDrag>, window, cx| {
            if e.drag(cx).0 != drag_key {
                return;
            }
            if let Some(v) = value_at(e.event.position.x, bounds.get()) {
                moved(v, false, window, cx);
            }
        })
        .into_any_element()
}

fn amount_bar(value: f32, p: &Palette) -> AnyElement {
    div()
        .relative()
        .h(px(4.))
        .w_full()
        .rounded_full()
        .bg(p.switch_off)
        .child(
            div()
                .absolute()
                .left_0()
                .top_0()
                .bottom_0()
                .w(gpui::relative(value))
                .rounded_full()
                .bg(p.form_accent),
        )
        .into_any_element()
}

impl ThemeEditor {
    fn slider(
        &self,
        part: &'static str,
        title: &'static str,
        value: f64,
        snap: Option<f64>,
        apply: fn(&mut ThemeLook, f64),
        trailing: Option<AnyElement>,
    ) -> AnyElement {
        let base = self.theme.clone();
        let change = self.on_change.clone();
        let on: Slide = Rc::new(move |v, settle, window, cx| {
            let mut next = base.clone();
            apply(&mut next.look, v);
            change(next, settle, window, cx);
        });
        let bar = track(
            SharedString::from(format!("{}-{part}", self.id)),
            value as f32,
            snap,
            amount_bar(value as f32, &self.p),
            None,
            &self.p,
            on,
        );
        let control = div()
            .flex()
            .flex_row()
            .items_center()
            .gap(px(8.))
            .child(div().flex_1().child(bar))
            .children(trailing);
        if self.stacked {
            div()
                .flex()
                .flex_col()
                .gap(px(6.))
                .child(label(title, &self.p))
                .child(control)
                .into_any_element()
        } else {
            div()
                .flex()
                .flex_row()
                .items_center()
                .gap(px(10.))
                .child(div().w(px(LABEL)).child(label(title, &self.p)))
                .child(div().flex_1().child(control))
                .into_any_element()
        }
    }

    fn pad(&self) -> AnyElement {
        let theme = self.theme.clone();
        let stops = theme.look.stops.clone();
        let selected = self.selected.min(stops.len().saturating_sub(1));
        let bounds = Rc::new(Cell::new(Bounds::<Pixels>::default()));
        let recorded = Rc::clone(&bounds);
        let drag_key = key(&self.id, "pad");
        let dragging = Rc::new(Cell::new(selected));
        let start = self
            .start
            .clone()
            .filter(|s| s.look.stops.len() == theme.look.stops.len());
        let point = move |x: Pixels, y: Pixels, b: Bounds<Pixels>| {
            let px_ = f64::from(f32::from(x) - f32::from(b.left()))
                / f64::from(PAD)
                / f64::from(crate::scale::current());
            let py_ = f64::from(f32::from(y) - f32::from(b.top()))
                / f64::from(PAD)
                / f64::from(crate::scale::current());
            (px_.clamp(0.0, 1.0), py_.clamp(0.0, 1.0))
        };
        let place = {
            move |p: (f64, f64), index: usize, base: &ProfileTheme| {
                let p = inside_circle(p);
                let p = match start.as_ref().and_then(|s| s.look.stops.get(index)) {
                    Some(origin) => snap_point_to_start(p, (origin.x, origin.y), f64::from(PAD)),
                    None => p,
                };
                let mut next = base.clone();
                next.look = next.look.with_stop_at(index, p.0, p.1);
                next
            }
        };
        let (change_down, change_move, change_up) = (
            self.on_change.clone(),
            self.on_change.clone(),
            self.on_change.clone(),
        );
        let select = self.on_select.clone();
        let (down_theme, move_theme, up_theme) = (theme.clone(), theme.clone(), theme);
        let (down_bounds, up_bounds) = (Rc::clone(&bounds), Rc::clone(&bounds));
        let (down_drag, move_drag, up_drag) = (
            Rc::clone(&dragging),
            Rc::clone(&dragging),
            Rc::clone(&dragging),
        );
        let (place_down, place_move, place_up) = (place.clone(), place.clone(), place);
        let knobs = stops.iter().enumerate().map(|(i, s)| {
            div()
                .absolute()
                .left(px(s.x as f32 * PAD - KNOB / 2.))
                .top(px(s.y as f32 * PAD - KNOB / 2.))
                .size(px(KNOB))
                .rounded_full()
                .border(px(if i == selected { 3.0 } else { 2.0 }))
                .border_color(gpui::white())
                .bg(hex_of(s.color))
                .child(
                    div()
                        .absolute()
                        .inset(px(-4.))
                        .rounded_full()
                        .border(px(1.))
                        .border_color(hsla(ardia_theme::RgbaColor::hexa(KNOB_OUTLINE))),
                )
        });
        div()
            .id(SharedString::from(format!("{}-pad", self.id)))
            .debug_selector(|| "theme-pad".into())
            .relative()
            .flex_none()
            .size(px(PAD))
            .child(
                canvas(move |b, _, _| recorded.set(b), |_, _, _, _| {})
                    .absolute()
                    .size_full(),
            )
            .child(img(pad_image()).absolute().inset_0().size(px(PAD)))
            .children(knobs)
            .on_mouse_down(MouseButton::Left, move |e: &MouseDownEvent, window, cx| {
                cx.stop_propagation();
                let b = down_bounds.get();
                let p = point(e.position.x, e.position.y, b);
                let hit = down_theme.look.stops.iter().position(|s| {
                    ((s.x - p.0) * f64::from(PAD)).hypot((s.y - p.1) * f64::from(PAD))
                        <= f64::from(KNOB / 2.0 + 3.0)
                });
                let index = hit.unwrap_or(selected);
                down_drag.set(index);
                select(index, window, cx);
                if hit.is_none() {
                    change_down(place_down(p, index, &down_theme), false, window, cx);
                }
            })
            .on_drag(PadDrag(drag_key), |_, _, _, cx| cx.new(|_| EmptyDrag))
            .on_drag_move(move |e: &DragMoveEvent<PadDrag>, window, cx| {
                if e.drag(cx).0 != drag_key {
                    return;
                }
                let p = point(e.event.position.x, e.event.position.y, e.bounds);
                change_move(
                    place_move(p, move_drag.get(), &move_theme),
                    false,
                    window,
                    cx,
                );
            })
            .on_mouse_up(MouseButton::Left, move |e: &MouseUpEvent, window, cx| {
                let p = point(e.position.x, e.position.y, up_bounds.get());
                change_up(place_up(p, up_drag.get(), &up_theme), true, window, cx);
            })
            .into_any_element()
    }

    fn lightness(&self) -> AnyElement {
        let index = self
            .selected
            .min(self.theme.look.stops.len().saturating_sub(1));
        let Some(stop) = self.theme.look.stops.get(index).cloned() else {
            return div().into_any_element();
        };
        let snap = self
            .start
            .as_ref()
            .filter(|s| s.look.stops.len() == self.theme.look.stops.len())
            .and_then(|s| s.look.stops.get(index))
            .map(stop_lightness);
        let base = self.theme.clone();
        let change = self.on_change.clone();
        let on: Slide = Rc::new(move |v, settle, window, cx| {
            let mut next = base.clone();
            next.look = next.look.with_stop_lightness(index, v);
            change(next, settle, window, cx);
        });
        let bar = div()
            .h(px(8.))
            .rounded_full()
            .overflow_hidden()
            .flex()
            .flex_row()
            .children((0..LIGHTNESS_STEPS).map(|i| {
                div()
                    .flex_1()
                    .h_full()
                    .when(i == 0, |this| this.rounded_l_full())
                    .when(i + 1 == LIGHTNESS_STEPS, |this| this.rounded_r_full())
                    .bg(hex_of(pad_color(
                        stop.x,
                        stop.y,
                        i as f64 / (LIGHTNESS_STEPS - 1) as f64,
                    )))
            }))
            .into_any_element();
        div()
            .w(px(PAD))
            .child(track(
                SharedString::from(format!("{}-lightness", self.id)),
                stop_lightness(&stop) as f32,
                snap,
                bar,
                Some(hex_of(stop.color)),
                &self.p,
                on,
            ))
            .into_any_element()
    }

    fn stop_row(&self) -> AnyElement {
        let p = self.p;
        let count = self.theme.look.stops.len();
        let index = self.selected.min(count.saturating_sub(1));
        let stepper = |id: &'static str,
                       glyph: crate::primitives::icons::Icon,
                       tooltip: &'static str,
                       enabled: bool,
                       run: Action| {
            crate::primitives::controls::StepperButton::new(
                SharedString::from(format!("{}-{id}", self.id)),
                glyph,
                tooltip,
                &p,
            )
            .disabled(!enabled)
            .on_click(move |_, window, cx| run(window, cx))
        };
        let remove = {
            let base = self.theme.clone();
            let change = self.on_change.clone();
            let select = self.on_select.clone();
            Rc::new(move |window: &mut Window, cx: &mut App| {
                let mut next = base.clone();
                next.look = next.look.without_stop(index);
                change(next, true, window, cx);
                select(index.saturating_sub(1), window, cx);
            }) as Action
        };
        let add = {
            let base = self.theme.clone();
            let change = self.on_change.clone();
            let select = self.on_select.clone();
            Rc::new(move |window: &mut Window, cx: &mut App| {
                let mut next = base.clone();
                next.look = next.look.with_added_stop();
                change(next, true, window, cx);
                select(count, window, cx);
            }) as Action
        };
        let reset = self.on_reset.clone();
        div()
            .w(px(PAD))
            .flex()
            .flex_row()
            .items_center()
            .justify_between()
            .child(
                div()
                    .text_size(px(11.))
                    .text_color(p.text_secondary)
                    .child(SharedString::from(format!(
                        "{count} of {MAX_THEME_STOPS} colours"
                    ))),
            )
            .child(
                div()
                    .flex()
                    .flex_row()
                    .items_center()
                    .gap(px(4.))
                    .when_some(reset, |this, reset| {
                        this.child(
                            div()
                                .id(SharedString::from(format!("{}-reset", self.id)))
                                .cursor_pointer()
                                .text_size(px(11.))
                                .font_weight(FontWeight::MEDIUM)
                                .text_color(p.accent)
                                .hover(|s| s.underline())
                                .on_click(move |_, window, cx| reset(window, cx))
                                .child("Reset"),
                        )
                    })
                    .child(stepper(
                        "remove",
                        crate::primitives::icons::Icon::Minus,
                        "Remove Colour",
                        count > 1,
                        remove,
                    ))
                    .child(stepper(
                        "add",
                        crate::primitives::icons::Icon::Plus,
                        "Add Colour",
                        count < MAX_THEME_STOPS,
                        add,
                    )),
            )
            .into_any_element()
    }

    fn dial(&self) -> AnyElement {
        let p = self.p;
        let angle = self.theme.look.angle();
        let bounds = Rc::new(Cell::new(Bounds::<Pixels>::default()));
        let recorded = Rc::clone(&bounds);
        let drag_key = key(&self.id, "dial");
        let at = |x: Pixels, y: Pixels, b: Bounds<Pixels>| {
            let c = b.center();
            dial_angle(f64::from(f32::from(x - c.x)), f64::from(f32::from(y - c.y)))
        };
        let base = self.theme.clone();
        let change = self.on_change.clone();
        let set = Rc::new(
            move |degrees: f64, settle: bool, window: &mut Window, cx: &mut App| {
                let mut next = base.clone();
                next.look = next.look.with_angle(degrees);
                change(next, settle, window, cx);
            },
        );
        let (down, moved, up) = (Rc::clone(&set), Rc::clone(&set), set);
        let (down_bounds, up_bounds) = (Rc::clone(&bounds), Rc::clone(&bounds));
        let radians = angle.to_radians() as f32;
        let accent = p.form_accent;
        let needle = canvas(
            |_, _, _| {},
            move |bounds, _, window, _| {
                let c = bounds.center();
                let scale = crate::scale::current();
                let reach = (DIAL / 2.0 - 4.0) * scale;
                let tip = gpui::point(
                    c.x + gpui::px(reach * radians.sin()),
                    c.y - gpui::px(reach * radians.cos()),
                );
                let mut path = gpui::PathBuilder::stroke(gpui::px(2.0 * scale));
                path.move_to(c);
                path.line_to(tip);
                if let Ok(path) = path.build() {
                    window.paint_path(path, accent);
                }
            },
        )
        .absolute()
        .size_full();
        let control = div()
            .id(SharedString::from(format!("{}-dial", self.id)))
            .relative()
            .flex_none()
            .size(px(DIAL))
            .rounded_full()
            .bg(p.control)
            .border(px(1.))
            .border_color(p.control_border)
            .cursor_pointer()
            .child(
                canvas(move |b, _, _| recorded.set(b), |_, _, _, _| {})
                    .absolute()
                    .size_full(),
            )
            .child(needle)
            .child(
                div()
                    .absolute()
                    .left(px(DIAL / 2.0 - DIAL_HUB / 2.0 - 1.0))
                    .top(px(DIAL / 2.0 - DIAL_HUB / 2.0 - 1.0))
                    .size(px(DIAL_HUB))
                    .rounded_full()
                    .bg(p.form_accent),
            )
            .on_mouse_down(MouseButton::Left, move |e: &MouseDownEvent, window, cx| {
                cx.stop_propagation();
                down(
                    at(e.position.x, e.position.y, down_bounds.get()),
                    false,
                    window,
                    cx,
                );
            })
            .on_drag(DialDrag(drag_key), |_, _, _, cx| cx.new(|_| EmptyDrag))
            .on_drag_move(move |e: &DragMoveEvent<DialDrag>, window, cx| {
                if e.drag(cx).0 == drag_key {
                    moved(
                        at(e.event.position.x, e.event.position.y, e.bounds),
                        false,
                        window,
                        cx,
                    );
                }
            })
            .on_mouse_up(MouseButton::Left, move |e: &MouseUpEvent, window, cx| {
                up(
                    at(e.position.x, e.position.y, up_bounds.get()),
                    true,
                    window,
                    cx,
                );
            });
        let row = div()
            .flex()
            .flex_row()
            .items_center()
            .gap(px(10.))
            .child(control)
            .child(
                div()
                    .text_size(px(11.))
                    .text_color(p.text_secondary)
                    .child(SharedString::from(format!("{}°", angle.round() as i64))),
            );
        if self.stacked {
            div()
                .flex()
                .flex_col()
                .gap(px(6.))
                .child(label("Direction", &p))
                .child(row)
                .into_any_element()
        } else {
            div()
                .flex()
                .flex_row()
                .items_center()
                .child(div().w(px(LABEL + 10.)).child(label("Direction", &p)))
                .child(row)
                .into_any_element()
        }
    }

    pub fn render(self) -> AnyElement {
        self.render_with(None, None)
    }

    pub fn render_full(self, preview: AnyElement, appearance: AnyElement) -> AnyElement {
        self.render_with(Some(preview), Some(appearance))
    }

    fn render_with(
        self,
        preview: Option<AnyElement>,
        appearance: Option<AnyElement>,
    ) -> AnyElement {
        let look = &self.theme.look;
        let start = self.start.as_ref().map(|s| s.look.clone());
        let menu = self.on_texture_menu.clone();
        let noise_pop = PopUp::new(
            SharedString::from(format!("{}-texture", self.id)),
            texture_name(look.texture),
            &self.p,
        )
        .min_width(78.)
        .native(self.native_form)
        .on_click(move |_, window, cx| menu(window, cx))
        .into_any_element();
        let stops = div()
            .flex()
            .flex_col()
            .gap(px(8.))
            .child(self.pad())
            .child(self.lightness())
            .child(self.stop_row());
        let controls = div()
            .flex_1()
            .flex()
            .flex_col()
            .gap(px(if self.stacked { 16.0 } else { 12.0 }))
            .children(preview)
            .child(self.slider(
                "intensity",
                "Intensity",
                look.intensity,
                start.as_ref().map(|s| s.intensity),
                |l, v| l.intensity = v,
                None,
            ))
            .child(self.slider(
                "blur",
                "Pass-through blur",
                look.translucency,
                start.as_ref().map(|s| s.translucency),
                |l, v| l.translucency = v,
                None,
            ))
            .child(self.slider(
                "noise",
                "Noise",
                look.grain,
                start.as_ref().map(|s| s.grain),
                |l, v| l.grain = v,
                Some(noise_pop),
            ))
            .child(self.dial())
            .children(appearance);
        div()
            .id(self.id.clone())
            .flex()
            .flex_row()
            .gap(px(16.))
            .text_color(self.p.text)
            .font_weight(FontWeight::NORMAL)
            .child(stops)
            .child(controls)
            .into_any_element()
    }
}

pub fn texture_menu_items(current: ThemeTexture) -> Vec<crate::host::NativeMenuItem> {
    ThemeTexture::ALL
        .iter()
        .map(|t| {
            crate::host::NativeMenuItem::new(t.key(), texture_name(*t), "").checked(*t == current)
        })
        .collect()
}

pub fn with_texture(theme: &ProfileTheme, texture: ThemeTexture) -> ProfileTheme {
    let mut next = theme.clone();
    next.look = next.look.with_texture(texture);
    if next.look.grain == 0.0 {
        next.look.grain = 0.5;
    }
    next
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_dial_snaps_to_45_degree_notches_within_4_degrees() {
        assert_eq!(dial_angle(0.0, -1.0), 0.0);
        assert_eq!(dial_angle(1.0, 0.0), 90.0);
        let near_notch = dial_angle(47f64.to_radians().sin(), -(47f64.to_radians().cos()));
        assert_eq!(near_notch, 45.0);
        let off = dial_angle(60f64.to_radians().sin(), -(60f64.to_radians().cos()));
        assert_eq!(off, 60.0);
    }

    #[test]
    fn points_stay_in_the_pad_circle_and_snap_home() {
        assert_eq!(inside_circle((0.5, 0.5)), (0.5, 0.5));
        let (x, y) = inside_circle((1.0, 0.5));
        assert!((x - 1.0).abs() < 1e-9 && (y - 0.5).abs() < 1e-9);
        let (x, y) = inside_circle((1.0, 1.0));
        assert!(((x - 0.5).hypot(y - 0.5) - 0.5).abs() < 1e-9);
        assert_eq!(
            snap_point_to_start((0.501, 0.5), (0.5, 0.5), 172.0),
            (0.5, 0.5)
        );
        assert_eq!(snap_to_start(0.61, 0.6, 100.0), 0.61);
        assert_eq!(snap_to_start(0.604, 0.6, 100.0), 0.6);
    }

    #[test]
    fn untouched_starting_themes_count_as_the_preset() {
        let start = preset_starting_theme(ardia_theme::ProfileColor::Blue.spec().swatch);
        assert!(is_untouched(&start, &start));
        let mut moved = start.clone();
        moved.look.intensity += 0.1;
        assert!(!is_untouched(&moved, &start));
    }

    #[test]
    fn the_pad_bitmap_is_a_well_formed_circle() {
        let pixels = pad_pixels(20);
        assert_eq!(pixels[3], 0);
        assert_eq!(pixels[(10 * 20 + 10) * 4 + 3], 255);
        let file = bmp(20, 20, &pixels);
        assert_eq!(&file[0..2], b"BM");
        assert_eq!(file.len(), 14 + 108 + 20 * 20 * 4);
    }
}
