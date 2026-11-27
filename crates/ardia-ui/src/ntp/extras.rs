use std::sync::{Arc, OnceLock};
use std::time::{Duration, Instant};

use crate::scale::px;
use ardia_state::ntp_extras::{
    ASK_BODY, ASK_NOT_NOW, ASK_SHARE, ASK_TITLE, CHECK_IN_ACTION, CHECK_IN_TITLE, NtpExtras,
    NtpExtrasChange, ReleaseNotes, WHATS_SENT,
};
use ardia_theme::RgbaColor;
use gpui::{
    Animation, AnimationExt, AnyElement, App, ElementId, Entity, FontWeight, Hsla, Image,
    ImageFormat, IntoElement, MouseButton, ParentElement, RenderOnce, SharedString, Styled, Window,
    div, img, linear_color_stop, linear_gradient, prelude::*, rgba,
};

use crate::host::UiHost;
use crate::look::Palette;
use crate::msg::{Emit, Msg};
use crate::ntp::motion::{Curve, SMOOTH, SNAPPY, Tween};
use crate::primitives::controls::{shadow, tooltip};
use crate::primitives::icons::{Icon, icon};
use crate::primitives::theme_bridge::hsla;
use crate::window::chrome::Chrome;
use crate::window::layout::Rect;

pub const SLOT_PAD: f32 = 8.0;
pub const CHECK_IN_WIDTH: f32 = 282.0;
pub const CHECK_IN_HEIGHT: f32 = 69.0;
pub const CHECK_IN_ICON: f32 = 36.0;
pub const ASK_WIDTH: f32 = 300.0;
pub const ASK_ESTIMATED_HEIGHT: f32 = 118.0;
pub const ASK_CLEAR_OF_BAR: f32 = 24.0;
pub const CARD_RADIUS: f32 = 12.0;
pub const CARD_BORDER: f32 = 1.0;
pub const CLOSE_BOX: f32 = 23.0;
pub const CLOSE_OFFSET: f32 = -8.0;
pub const CHECK_IN_DELAY_MS: u64 = 300;
pub const ASK_DELAY_MS: u64 = 600;
pub const APPEAR_MS: u64 = 250;
pub const PROMPT_HEIGHT: f32 = 28.0;
pub const POSTCARD_WIDTH: f32 = 320.0;
pub const POSTCARD_HEIGHT: f32 = 200.0;
pub const POSTCARD_OVERHANG_RIGHT: f32 = 40.0;
pub const POSTCARD_OVERHANG_TOP: f32 = 30.0;
pub const POSTCARD_MIN_WIDTH: f32 = 560.0;
pub const POSTCARD_MIN_HEIGHT: f32 = 420.0;
pub const TOOLTIP_HEIGHT: f32 = 28.0;
pub const TOOLTIP_GAP: f32 = 4.0;
pub const PAGE_MAX_WIDTH: f32 = 860.0;
pub const PAGE_MAX_HEIGHT: f32 = 520.0;
pub const PAGE_MARGIN: f32 = 64.0;
pub const PAGE_GUTTER: f32 = 116.0;
pub const LIFT_HOVER: f32 = 1.02;
pub const LIFT_PRESSED: f32 = 0.98;
pub const LEAVE_SCALE: f32 = 0.98;
pub const LEAVE_SECONDS: f32 = 0.25;
pub const POSTCARD_TILT: f32 = 2.0;
pub const POSTCARD_HOVER_SCALE: f32 = 1.05;
pub const POSTCARD_HOVER_SECONDS: f32 = 0.15;
pub const POSTCARD_LEAVE_SCALE: f32 = 0.96;
pub const POSTCARD_LEAVE_SECONDS: f32 = 0.15;
pub const POSTCARD_DROP: f32 = 280.0;
pub const POSTCARD_DROP_SECONDS: f32 = 1.2;
pub const PAGE_TILT: f32 = -1.0;
pub const PAGE_CLOSE_SECONDS: f32 = 0.25;
pub const STAMP_TILT: f32 = -14.0;

#[derive(Clone, Copy)]
struct NtpInk {
    card_fill: Hsla,
    card_border: Hsla,
    card_shadow: f32,
    title: Hsla,
    body: Hsla,
    arrow: Hsla,
    badge: Hsla,
    badge_glyph: Hsla,
    postcard_tooltip: Hsla,
    scrim: Hsla,
}

fn ntp_ink(dark: bool) -> NtpInk {
    let c = |value: u32| Hsla::from(rgba(value));
    if dark {
        NtpInk {
            card_fill: c(0xFFFFFF17),
            card_border: c(0xFFFFFF0A),
            card_shadow: 0.3,
            title: c(0xFFFFFFCC),
            body: c(0xFFFFFF99),
            arrow: c(0xFFFFFF99),
            badge: c(0xFFFFFF14),
            badge_glyph: c(0xFFFFFFCC),
            postcard_tooltip: c(0xFFFFFF2E),
            scrim: c(0x0A0A0A59),
        }
    } else {
        NtpInk {
            card_fill: c(0xFFFFFF80),
            card_border: c(0x00000014),
            card_shadow: 0.1,
            title: c(0x000000CC),
            body: c(0x00000087),
            arrow: c(0x00000087),
            badge: c(0x0000000A),
            badge_glyph: c(0x000000B3),
            postcard_tooltip: c(0x000000CC),
            scrim: c(0xFFFFFF59),
        }
    }
}

pub fn app_icon() -> Arc<Image> {
    static ICON: OnceLock<Arc<Image>> = OnceLock::new();
    Arc::clone(ICON.get_or_init(|| {
        Arc::new(Image::from_bytes(
            ImageFormat::Png,
            include_bytes!("../../assets/app-icon.png").to_vec(),
        ))
    }))
}

#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct PeekOverlaps {
    pub left: f32,
    pub right: f32,
}

pub fn peek_overlaps(peek: Option<(f32, f32)>, x: f32, width: f32) -> PeekOverlaps {
    let Some((start, end)) = peek else {
        return PeekOverlaps::default();
    };
    let within = |value: f32| value.clamp(0.0, width);
    PeekOverlaps {
        left: if start <= x { within(end - x) } else { 0.0 },
        right: if end >= x + width {
            within(x + width - start)
        } else {
            0.0
        },
    }
}

pub fn ask_has_room(size: (f32, f32), bar: Rect, height: f32) -> bool {
    let top = size.1 - SLOT_PAD - height;
    let right = SLOT_PAD + ASK_WIDTH;
    bar.x >= right + ASK_CLEAR_OF_BAR || bar.y + bar.h + ASK_CLEAR_OF_BAR <= top
}

pub fn postcard_frame(width: f32) -> Rect {
    Rect::new(
        width + POSTCARD_OVERHANG_RIGHT - POSTCARD_WIDTH,
        -POSTCARD_OVERHANG_TOP,
        POSTCARD_WIDTH,
        POSTCARD_HEIGHT,
    )
}

pub fn notes_page_size(size: (f32, f32)) -> (f32, f32) {
    let width = PAGE_MAX_WIDTH.min(size.0 - PAGE_MARGIN);
    let height = PAGE_MAX_HEIGHT.min(size.1 - PAGE_MARGIN).min(width * 0.62);
    (width.max(0.0), height.max(0.0))
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Card {
    CheckIn,
    Ask,
}

#[derive(Clone, Copy, Debug)]
struct Leaving {
    card: Card,
    since: Instant,
    change: NtpExtrasChange,
    report: bool,
    share: bool,
}

#[derive(Clone)]
struct ExtrasUi {
    notes_page: bool,
    page: Tween,
    lift: Tween,
    hovered: bool,
    pressed: bool,
    leaving: Vec<Leaving>,
    postcard_drop: Option<Instant>,
    postcard_scale: Tween,
    postcard_leaving: Option<Instant>,
    ask_counted: std::cell::Cell<bool>,
}

impl Default for ExtrasUi {
    fn default() -> Self {
        ExtrasUi {
            notes_page: false,
            page: Tween::rest(0.0),
            lift: Tween::rest(1.0),
            hovered: false,
            pressed: false,
            leaving: Vec::new(),
            postcard_drop: None,
            postcard_scale: Tween::rest(1.0),
            postcard_leaving: None,
            ask_counted: std::cell::Cell::new(false),
        }
    }
}

static ASK_SHOWN_TABS: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

impl ExtrasUi {
    fn lift_target(&self) -> f32 {
        if self.pressed {
            LIFT_PRESSED
        } else if self.hovered {
            LIFT_HOVER
        } else {
            1.0
        }
    }

    fn leaving(&self, card: Card) -> Option<Leaving> {
        self.leaving.iter().copied().find(|l| l.card == card)
    }

    fn animating(&self, now: Instant) -> bool {
        !self.leaving.is_empty()
            || !self.lift.done(now)
            || !self.page.done(now)
            || !self.postcard_scale.done(now)
            || self.postcard_leaving.is_some()
            || self.postcard_drop.is_some_and(|start| {
                now.saturating_duration_since(start).as_secs_f32() < POSTCARD_DROP_SECONDS
            })
    }
}

fn leave_progress(since: Instant, now: Instant) -> f32 {
    Tween::starting(0.0, 1.0, Curve::EaseOut(LEAVE_SECONDS), since).value(now)
}

fn start_leaving(ui: &Entity<ExtrasUi>, leaving: Leaving, window: &mut Window, cx: &mut App) {
    ui.update(cx, |ui, cx| {
        if ui.leaving(leaving.card).is_none() {
            ui.leaving.push(leaving);
        }
        cx.notify();
    });
    window.refresh();
}

fn retarget_lift(ui: &Entity<ExtrasUi>, cx: &mut App, edit: impl FnOnce(&mut ExtrasUi)) {
    ui.update(cx, |ui, cx| {
        edit(ui);
        let target = ui.lift_target();
        ui.lift
            .retarget(target, Curve::Spring(SNAPPY), Instant::now());
        cx.notify();
    });
}

fn leave(card: Card, change: NtpExtrasChange) -> Leaving {
    Leaving {
        card,
        since: Instant::now(),
        change,
        report: false,
        share: false,
    }
}

#[derive(IntoElement)]
pub struct NtpExtrasLayer {
    id: SharedString,
    extras: NtpExtras,
    incognito: bool,
    size: (f32, f32),
    bar: Rect,
    overlaps: PeekOverlaps,
    dark: bool,
    p: Palette,
    accent: RgbaColor,
    emit: Emit,
    host: Arc<dyn UiHost>,
    corner: AnyElement,
}

impl NtpExtrasLayer {
    pub fn new(c: &Chrome, page: Rect, bar: Rect, corner: AnyElement) -> Self {
        let peek = c.layout.peek.map(|r| (r.x, r.right()));
        let absolute_page = c.layout.page();
        NtpExtrasLayer {
            id: SharedString::from(format!("ntp-extras:{}", c.window.id.as_str())),
            extras: c.host.ntp_extras(),
            incognito: c.window.kind == ardia_state::windows::WindowKind::Incognito,
            size: (page.w, page.h),
            bar,
            overlaps: peek_overlaps(peek, absolute_page.x, absolute_page.w),
            dark: c.look.dark,
            p: *c.p,
            accent: c
                .look
                .theme
                .power_up_color
                .unwrap_or(c.look.theme.roles.accent),
            emit: c.emit.clone(),
            host: Arc::clone(c.host),
            corner,
        }
    }
}

fn appear(id: impl Into<ElementId>, delay_ms: u64, element: gpui::Div) -> AnyElement {
    let total = delay_ms + APPEAR_MS;
    let start = delay_ms as f32 / total as f32;
    element
        .with_animation(
            id,
            Animation::new(Duration::from_millis(total)),
            move |this, t| {
                let x = ((t - start) / (1.0 - start)).clamp(0.0, 1.0);
                this.opacity(1.0 - (1.0 - x).powi(3))
            },
        )
        .into_any_element()
}

fn close_button(
    id: &'static str,
    group: &'static str,
    p: &Palette,
    on_close: impl Fn(&mut Window, &mut App) + 'static,
) -> AnyElement {
    let fill = p.popover_fill;
    let border = p.popover_border;
    div()
        .id(id)
        .absolute()
        .right(px(CLOSE_OFFSET))
        .top(px(CLOSE_OFFSET))
        .size(px(CLOSE_BOX))
        .rounded_full()
        .bg(fill)
        .border(px(1.))
        .border_color(border)
        .flex()
        .items_center()
        .justify_center()
        .opacity(0.)
        .group_hover(group, |style| style.opacity(1.))
        .tooltip(tooltip("Dismiss".into(), p))
        .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
        .on_click(move |_, window, cx| on_close(window, cx))
        .child(icon(Icon::XMark, 10., p.text_secondary))
        .into_any_element()
}

fn card_surface(ink: NtpInk) -> gpui::Div {
    div()
        .rounded(px(CARD_RADIUS))
        .bg(ink.card_fill)
        .border(px(CARD_BORDER))
        .border_color(ink.card_border)
        .shadow(vec![shadow(
            gpui::black().opacity(ink.card_shadow),
            10.,
            24.,
        )])
}

fn check_in(
    layer: &NtpExtrasLayer,
    ink: NtpInk,
    ui: &Entity<ExtrasUi>,
    state: &ExtrasUi,
    now: Instant,
) -> AnyElement {
    let group = "ntp-check-in";
    let leaving = state.leaving(Card::CheckIn);
    let (scale, opacity) = match leaving {
        Some(l) => {
            let t = leave_progress(l.since, now);
            (1.0 + (LEAVE_SCALE - 1.0) * t, 1.0 - t)
        }
        None => (state.lift.value(now), 1.0),
    };
    let hover_ui = ui.clone();
    let down_ui = ui.clone();
    let up_ui = ui.clone();
    let click_ui = ui.clone();
    let close_ui = ui.clone();
    let card = card_surface(ink)
        .id("ntp-check-in")
        .debug_selector(|| "ntp-check-in".into())
        .group(group)
        .relative()
        .w(px(CHECK_IN_WIDTH))
        .h(px(CHECK_IN_HEIGHT))
        .px(px(10.))
        .gap(px(10.))
        .flex()
        .items_center()
        .cursor_pointer()
        .scale(scale)
        .opacity(opacity)
        .on_hover(move |hovered, window, cx| {
            retarget_lift(&hover_ui, cx, |ui| ui.hovered = *hovered);
            window.refresh();
        })
        .on_mouse_down(MouseButton::Left, move |_, window, cx| {
            retarget_lift(&down_ui, cx, |ui| ui.pressed = true);
            window.refresh();
        })
        .on_mouse_up(MouseButton::Left, move |_, window, cx| {
            retarget_lift(&up_ui, cx, |ui| ui.pressed = false);
            window.refresh();
        })
        .on_click(move |_, window, cx| {
            let mut leaving = leave(Card::CheckIn, NtpExtrasChange::CheckInFeedback);
            leaving.report = true;
            start_leaving(&click_ui, leaving, window, cx);
        })
        .child(img(app_icon()).flex_none().size(px(CHECK_IN_ICON)))
        .child(
            div()
                .flex_1()
                .pl(px(4.))
                .flex()
                .flex_col()
                .gap(px(2.))
                .child(
                    div()
                        .truncate()
                        .text_size(px(13.))
                        .font_weight(FontWeight::MEDIUM)
                        .text_color(ink.title)
                        .child(CHECK_IN_TITLE),
                )
                .child(
                    div()
                        .flex()
                        .items_center()
                        .gap(px(4.))
                        .child(
                            div()
                                .text_size(px(12.))
                                .text_color(ink.body)
                                .child(CHECK_IN_ACTION),
                        )
                        .child(
                            div()
                                .size(px(11.))
                                .flex()
                                .items_center()
                                .justify_center()
                                .child(icon(Icon::ArrowUpRight, 11., ink.arrow)),
                        ),
                ),
        )
        .child(close_button(
            "ntp-check-in-close",
            group,
            &layer.p,
            move |window, cx| {
                start_leaving(
                    &close_ui,
                    leave(Card::CheckIn, NtpExtrasChange::CheckInDismissed),
                    window,
                    cx,
                )
            },
        ));
    appear(
        "ntp-check-in-appear",
        CHECK_IN_DELAY_MS,
        div()
            .absolute()
            .left(px(SLOT_PAD))
            .top(px(SLOT_PAD))
            .child(card),
    )
}

fn prompt_button(
    id: &'static str,
    title: &'static str,
    p: &Palette,
    on_press: impl Fn(&mut Window, &mut App) + 'static,
) -> AnyElement {
    let fill = p.prompt_fill;
    let hover = p.prompt_fill_hover;
    let pressed = p.prompt_fill_pressed;
    div()
        .id(id)
        .flex_1()
        .h(px(PROMPT_HEIGHT))
        .px(px(12.))
        .rounded(px(8.))
        .bg(fill)
        .hover(move |style| style.bg(hover))
        .active(move |style| style.bg(pressed))
        .flex()
        .items_center()
        .justify_center()
        .cursor_pointer()
        .text_size(px(13.))
        .font_weight(FontWeight::MEDIUM)
        .text_color(p.text)
        .on_click(move |_, window, cx| on_press(window, cx))
        .child(title)
        .into_any_element()
}

fn telemetry_ask(
    layer: &NtpExtrasLayer,
    ink: NtpInk,
    ui: &Entity<ExtrasUi>,
    state: &ExtrasUi,
    now: Instant,
) -> AnyElement {
    let group = "ntp-telemetry-ask";
    let emit = layer.emit.clone();
    let (scale, opacity) = match state.leaving(Card::Ask) {
        Some(l) => {
            let t = leave_progress(l.since, now);
            (1.0 + (LEAVE_SCALE - 1.0) * t, 1.0 - t)
        }
        None => (1.0, 1.0),
    };
    let share_ui = ui.clone();
    let not_now_ui = ui.clone();
    let close_ui = ui.clone();
    let card = card_surface(ink)
        .id("ntp-telemetry-ask")
        .debug_selector(|| "ntp-telemetry-ask".into())
        .group(group)
        .relative()
        .scale(scale)
        .opacity(opacity)
        .w(px(ASK_WIDTH))
        .p(px(12.))
        .flex()
        .flex_col()
        .gap(px(12.))
        .child(
            div()
                .flex()
                .gap(px(10.))
                .child(
                    div()
                        .flex_none()
                        .size(px(28.))
                        .rounded(px(8.))
                        .bg(ink.badge)
                        .flex()
                        .items_center()
                        .justify_center()
                        .child(icon(Icon::Stethoscope, 13., ink.badge_glyph)),
                )
                .child(
                    div()
                        .flex_1()
                        .min_w_0()
                        .flex()
                        .flex_col()
                        .gap(px(2.))
                        .child(
                            div()
                                .text_size(px(13.))
                                .font_weight(FontWeight::MEDIUM)
                                .text_color(ink.title)
                                .child(ASK_TITLE),
                        )
                        .child(
                            div()
                                .text_size(px(11.))
                                .line_height(px(14.))
                                .text_color(ink.body)
                                .child(ask_body_with_link(emit)),
                        ),
                ),
        )
        .child(
            div()
                .flex()
                .gap(px(8.))
                .child(prompt_button(
                    "ntp-telemetry-not-now",
                    ASK_NOT_NOW,
                    &layer.p,
                    move |window, cx| {
                        start_leaving(
                            &not_now_ui,
                            leave(Card::Ask, NtpExtrasChange::TelemetryNotNow),
                            window,
                            cx,
                        )
                    },
                ))
                .child(prompt_button(
                    "ntp-telemetry-share",
                    ASK_SHARE,
                    &layer.p,
                    move |window, cx| {
                        let mut leaving = leave(Card::Ask, NtpExtrasChange::TelemetryShare);
                        leaving.share = true;
                        start_leaving(&share_ui, leaving, window, cx)
                    },
                )),
        )
        .child(close_button(
            "ntp-telemetry-close",
            group,
            &layer.p,
            move |window, cx| {
                start_leaving(
                    &close_ui,
                    leave(Card::Ask, NtpExtrasChange::TelemetryAskDismissed),
                    window,
                    cx,
                )
            },
        ));
    appear(
        "ntp-telemetry-appear",
        ASK_DELAY_MS,
        div()
            .absolute()
            .left(px(SLOT_PAD))
            .bottom(px(SLOT_PAD))
            .child(card),
    )
}

fn artwork_colors(accent: RgbaColor) -> (Hsla, Hsla) {
    let light = RgbaColor::new(1.0, 1.0, 1.0, 1.0);
    let dark = RgbaColor::new(
        0x10 as f32 / 255.0,
        0x12 as f32 / 255.0,
        0x1A as f32 / 255.0,
        1.0,
    );
    (hsla(accent.mix(light, 0.45)), hsla(accent.mix(dark, 0.5)))
}

fn artwork(
    notes: &ReleaseNotes,
    accent: RgbaColor,
    radius: f32,
    title: f32,
    hidden: (f32, f32),
) -> AnyElement {
    let (from, to) = artwork_colors(accent);
    let k = title / 44.0;
    let pad = 24.0 * k;
    div()
        .size_full()
        .rounded(px(radius))
        .overflow_hidden()
        .bg(linear_gradient(
            150.,
            linear_color_stop(from, 0.),
            linear_color_stop(to, 1.),
        ))
        .p(px(pad))
        .pt(px(pad + hidden.0))
        .pr(px(pad + hidden.1))
        .flex()
        .flex_col()
        .justify_between()
        .child(
            div()
                .text_size(px(11. * k))
                .font_weight(FontWeight::BOLD)
                .text_color(Hsla::from(rgba(0xFFFFFFCC)))
                .child(SharedString::from(format!("ARDIA {}", notes.version))),
        )
        .child(
            div()
                .text_size(px(title))
                .font_weight(FontWeight::LIGHT)
                .italic()
                .text_color(gpui::white())
                .child("What's new"),
        )
        .into_any_element()
}

fn postcard(
    layer: &NtpExtrasLayer,
    notes: &'static ReleaseNotes,
    open: impl Fn(&mut Window, &mut App) + Clone + 'static,
    ui: &Entity<ExtrasUi>,
    state: &ExtrasUi,
    now: Instant,
) -> Option<AnyElement> {
    if layer.size.1 < POSTCARD_MIN_HEIGHT || layer.size.0 < POSTCARD_MIN_WIDTH {
        return None;
    }
    let card = postcard_frame(layer.size.0);
    let group = "ntp-postcard";
    let ink = ntp_ink(layer.dark);
    let open_tip = open.clone();
    let dropped = state.postcard_drop.unwrap_or(now);
    let drop_seconds = now.saturating_duration_since(dropped).as_secs_f32();
    let drop = 1.0 - SMOOTH.value(f64::from(drop_seconds), 0.0) as f32;
    let shown = Tween::starting(0.0, 1.0, Curve::EaseOut(LEAVE_SECONDS), dropped).value(now);
    let (leave_scale, leave_opacity) = match state.postcard_leaving {
        Some(since) => {
            let t =
                Tween::starting(0.0, 1.0, Curve::EaseIn(POSTCARD_LEAVE_SECONDS), since).value(now);
            (1.0 + (POSTCARD_LEAVE_SCALE - 1.0) * t, 1.0 - t)
        }
        None => (1.0, 1.0),
    };
    let hover_ui = ui.clone();
    let retire_ui = ui.clone();
    Some(
        div()
            .id("ntp-postcard")
            .debug_selector(|| "ntp-postcard".into())
            .group(group)
            .absolute()
            .left(px(card.x))
            .top(px(card.y - POSTCARD_DROP * drop))
            .opacity(shown * leave_opacity)
            .on_hover(move |hovered, window, cx| {
                hover_ui.update(cx, |ui, cx| {
                    let target = if *hovered { POSTCARD_HOVER_SCALE } else { 1.0 };
                    ui.postcard_scale.retarget(
                        target,
                        Curve::EaseOut(POSTCARD_HOVER_SECONDS),
                        Instant::now(),
                    );
                    cx.notify();
                });
                window.refresh();
            })
            .w(px(card.w))
            .h(px(card.h + TOOLTIP_GAP + TOOLTIP_HEIGHT))
            .child(
                div()
                    .id("ntp-postcard-card")
                    .w(px(card.w))
                    .h(px(card.h))
                    .rounded(px(CARD_RADIUS))
                    .shadow(vec![shadow(gpui::black().opacity(0.3), -6., 20.)])
                    .scale(state.postcard_scale.value(now) * leave_scale)
                    .rotate(gpui::radians(POSTCARD_TILT.to_radians()))
                    .cursor_pointer()
                    .on_click(move |_, window, cx| open(window, cx))
                    .child(artwork(
                        notes,
                        layer.accent,
                        CARD_RADIUS,
                        40.,
                        (POSTCARD_OVERHANG_TOP, POSTCARD_OVERHANG_RIGHT),
                    )),
            )
            .child(
                div()
                    .mt(px(TOOLTIP_GAP))
                    .flex()
                    .justify_center()
                    .opacity(0.)
                    .group_hover(group, |style| style.opacity(1.))
                    .child(
                        div()
                            .id("ntp-postcard-tooltip")
                            .h(px(TOOLTIP_HEIGHT))
                            .rounded(px(6.))
                            .bg(ink.postcard_tooltip)
                            .pl(px(8.))
                            .pr(px(4.))
                            .flex()
                            .items_center()
                            .gap(px(8.))
                            .cursor_pointer()
                            .on_click(move |_, window, cx| open_tip(window, cx))
                            .child(
                                div()
                                    .text_size(px(12.))
                                    .font_weight(FontWeight::MEDIUM)
                                    .text_color(Hsla::from(rgba(0xFFFFFFD9)))
                                    .child("Latest Release Notes"),
                            )
                            .child(
                                div()
                                    .id("ntp-postcard-dismiss")
                                    .size(px(18.))
                                    .rounded_full()
                                    .flex()
                                    .items_center()
                                    .justify_center()
                                    .tooltip(tooltip("Dismiss release notes".into(), &layer.p))
                                    .on_mouse_down(MouseButton::Left, |_, _, cx| {
                                        cx.stop_propagation()
                                    })
                                    .on_click(move |_, window, cx| {
                                        cx.stop_propagation();
                                        retire_ui.update(cx, |ui, cx| {
                                            ui.postcard_leaving.get_or_insert(Instant::now());
                                            cx.notify();
                                        });
                                        window.refresh();
                                    })
                                    .child(icon(Icon::XMark, 9., Hsla::from(rgba(0xFFFFFFD9)))),
                            ),
                    ),
            )
            .into_any_element(),
    )
}

fn postage_stamp() -> AnyElement {
    let frame = Hsla::from(rgba(0x1D1B1A33));
    let ring = Hsla::from(rgba(0x1D1B1A59));
    let label = Hsla::from(rgba(0x1D1B1A80));
    let size = 58.0;
    let scale = size / 80.0;
    div()
        .relative()
        .child(
            div()
                .p(px(4.))
                .border(px(1.5))
                .border_dashed()
                .border_color(frame)
                .rounded(px(6.))
                .bg(gpui::white())
                .child(img(app_icon()).size(px(54.))),
        )
        .child(
            div()
                .absolute()
                .right(px(52.))
                .top(px(18.))
                .size(px(size))
                .rounded_full()
                .border(px(1.6 * scale))
                .border_color(ring)
                .flex()
                .items_center()
                .justify_center()
                .text_size(px(9. * scale))
                .font_weight(FontWeight::BOLD)
                .text_color(label)
                .rotate(gpui::radians(STAMP_TILT.to_radians()))
                .child("WHAT'S NEW"),
        )
        .into_any_element()
}

fn notes_page(
    layer: &NtpExtrasLayer,
    notes: &'static ReleaseNotes,
    close: impl Fn(&mut Window, &mut App) + Clone + 'static,
    t: f32,
) -> AnyElement {
    let ink = ntp_ink(layer.dark);
    let (width, height) = notes_page_size(layer.size);
    let card = postcard_frame(layer.size.0);
    let from_x = card.x + card.w / 2.0 - layer.size.0 / 2.0;
    let from_y = card.y + card.h / 2.0 - layer.size.1 / 2.0;
    let page_opacity = (t / 0.3).clamp(0.0, 1.0);
    let page_scale = POSTCARD_WIDTH / width.max(1.0) + (1.0 - POSTCARD_WIDTH / width.max(1.0)) * t;
    let page_tilt = POSTCARD_TILT + (PAGE_TILT - POSTCARD_TILT) * t;
    let split = width >= 640.0;
    let paper_ink = Hsla::from(rgba(0x1D1B1AFF));
    let close_button = close.clone();
    let art = div()
        .when(split, |this| this.w(gpui::relative(0.46)).h_full())
        .when(!split, |this| this.h(px(150.)).w_full())
        .child(artwork(notes, layer.accent, 6., 46., (0., 0.)));
    let column = div()
        .relative()
        .flex_1()
        .pt(px(10.))
        .pr(px(8.))
        .flex()
        .flex_col()
        .child(div().absolute().right_0().top_0().child(postage_stamp()))
        .child(
            div()
                .mr(px(PAGE_GUTTER))
                .text_size(px(11.))
                .font_weight(FontWeight::SEMIBOLD)
                .text_color(Hsla::from(rgba(0x1D1B1A80)))
                .child(notes.date.to_uppercase()),
        )
        .child(
            div()
                .mt(px(6.))
                .mr(px(PAGE_GUTTER))
                .text_size(px(26.))
                .font_weight(FontWeight::LIGHT)
                .text_color(paper_ink)
                .child(notes.title),
        )
        .child(
            div()
                .mt(px(8.))
                .mr(px(PAGE_GUTTER))
                .text_size(px(13.))
                .line_height(px(18.))
                .text_color(Hsla::from(rgba(0x1D1B1AB3)))
                .child(notes.summary),
        )
        .child(
            div()
                .id("ntp-notes-items")
                .mt(px(16.))
                .flex_1()
                .overflow_y_scroll()
                .flex()
                .flex_col()
                .gap(px(12.))
                .pb(px(8.))
                .children(notes.items.iter().map(|item| {
                    div()
                        .pb(px(10.))
                        .border_b(px(1.))
                        .border_color(Hsla::from(rgba(0x1D1B1A14)))
                        .flex()
                        .flex_col()
                        .gap(px(2.))
                        .child(
                            div()
                                .text_size(px(13.))
                                .font_weight(FontWeight::SEMIBOLD)
                                .text_color(paper_ink)
                                .child(item.title),
                        )
                        .child(
                            div()
                                .text_size(px(12.))
                                .line_height(px(17.))
                                .text_color(Hsla::from(rgba(0x1D1B1A99)))
                                .child(item.body),
                        )
                })),
        );
    div()
        .absolute()
        .inset_0()
        .child(
            div()
                .id("ntp-notes-scrim")
                .absolute()
                .inset_0()
                .bg(ink.scrim)
                .opacity(t.clamp(0.0, 1.0))
                .occlude()
                .on_click(move |_, window, cx| close(window, cx)),
        )
        .child(
            div()
                .absolute()
                .inset_0()
                .flex()
                .items_center()
                .justify_center()
                .child(
                    div()
                        .id("ntp-notes-page")
                        .debug_selector(|| "ntp-notes-page".into())
                        .relative()
                        .left(px(from_x * (1.0 - t)))
                        .top(px(from_y * (1.0 - t)))
                        .opacity(page_opacity)
                        .scale(page_scale)
                        .rotate(gpui::radians(page_tilt.to_radians()))
                        .occlude()
                        .w(px(width))
                        .h(px(height))
                        .rounded(px(8.))
                        .bg(Hsla::from(rgba(0xFCFCFAFF)))
                        .border(px(0.5))
                        .border_color(Hsla::from(rgba(0x00000014)))
                        .shadow(vec![shadow(gpui::black().opacity(0.3), 18., 40.)])
                        .p(px(16.))
                        .flex()
                        .when(split, |this| this.flex_row())
                        .when(!split, |this| this.flex_col())
                        .gap(px(24.))
                        .child(art)
                        .child(column)
                        .child(
                            div()
                                .id("ntp-notes-close")
                                .absolute()
                                .right(px(-CLOSE_BOX / 2.))
                                .top(px(-CLOSE_BOX / 2.))
                                .size(px(CLOSE_BOX))
                                .rounded_full()
                                .bg(layer.p.popover_fill)
                                .border(px(1.))
                                .border_color(layer.p.popover_border)
                                .flex()
                                .items_center()
                                .justify_center()
                                .cursor_pointer()
                                .tooltip(tooltip("Close release notes".into(), &layer.p))
                                .on_click(move |_, window, cx| close_button(window, cx))
                                .child(icon(Icon::XMark, 10., layer.p.text_secondary)),
                        ),
                ),
        )
        .into_any_element()
}

impl NtpExtrasLayer {
    fn finish(&self, ui: &Entity<ExtrasUi>, now: Instant, window: &mut Window, cx: &mut App) {
        let state = ui.read(cx);
        let done: Vec<Leaving> = state
            .leaving
            .iter()
            .copied()
            .filter(|l| now.saturating_duration_since(l.since).as_secs_f32() >= LEAVE_SECONDS)
            .collect();
        let postcard_gone = state.postcard_leaving.is_some_and(|since| {
            now.saturating_duration_since(since).as_secs_f32() >= POSTCARD_LEAVE_SECONDS
        });
        let page_closed = !state.page.done(now) || state.page.to > 0.0 || !state.notes_page;
        if done.is_empty() && !postcard_gone && page_closed {
            return;
        }
        let host = Arc::clone(&self.host);
        let emit = self.emit.clone();
        let ui = ui.clone();
        window.defer(cx, move |window, cx| {
            for leaving in &done {
                if leaving.share {
                    host.set_sharing(
                        true,
                        ardia_telemetry::SharingSource::Ask,
                        Some(ardia_telemetry::AskPlacement {
                            shown_tabs: ASK_SHOWN_TABS.load(std::sync::atomic::Ordering::Relaxed),
                        }),
                    );
                }
                host.change_ntp_extras(leaving.change);
                if leaving.report {
                    emit.send(Msg::command("reportProblem"), window, cx);
                }
            }
            if postcard_gone {
                host.change_ntp_extras(NtpExtrasChange::ReleaseNotesRetired);
            }
            ui.update(cx, |ui, cx| {
                ui.leaving
                    .retain(|l| !done.iter().any(|d| d.card == l.card));
                if postcard_gone {
                    ui.postcard_leaving = None;
                }
                if !page_closed {
                    ui.notes_page = false;
                }
                cx.notify();
            });
            window.refresh();
        });
    }
}

impl RenderOnce for NtpExtrasLayer {
    fn render(self, window: &mut Window, cx: &mut App) -> impl IntoElement {
        let ui = window.use_keyed_state(ElementId::Name(self.id.clone()), cx, |_, _| {
            ExtrasUi::default()
        });
        let now = Instant::now();
        let ink = ntp_ink(self.dark);
        let notes = self.extras.release_notes;
        let showing_card = notes.is_some() && !self.incognito;
        ui.update(cx, |ui, _| {
            if showing_card && ui.postcard_drop.is_none() {
                ui.postcard_drop = Some(now);
            }
        });
        self.finish(&ui, now, window, cx);
        let state = ui.read(cx);
        if state.animating(now) {
            window.request_animation_frame();
        }
        let page_open = state.notes_page;
        let ask = (self.extras.telemetry_ask_due(self.incognito, false)
            && ask_has_room(self.size, self.bar, ASK_ESTIMATED_HEIGHT))
            || state.leaving(Card::Ask).is_some();
        let left = (self.extras.check_in && !self.incognito)
            .then(|| check_in(&self, ink, &ui, state, now));
        if ask && state.leaving(Card::Ask).is_none() && !state.ask_counted.get() {
            ASK_SHOWN_TABS.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
            state.ask_counted.set(true);
        }
        let ask = ask.then(|| telemetry_ask(&self, ink, &ui, state, now));
        let opener = {
            let ui = ui.clone();
            let host = Arc::clone(&self.host);
            move |window: &mut Window, cx: &mut App| {
                host.change_ntp_extras(NtpExtrasChange::ReleaseNotesRetired);
                ui.update(cx, |ui, cx| {
                    ui.notes_page = true;
                    ui.page = Tween::starting(0.0, 1.0, Curve::Spring(SMOOTH), Instant::now());
                    cx.notify();
                });
                window.refresh();
            }
        };
        let closer = {
            let ui = ui.clone();
            move |window: &mut Window, cx: &mut App| {
                ui.update(cx, |ui, cx| {
                    ui.page
                        .retarget(0.0, Curve::EaseIn(PAGE_CLOSE_SECONDS), Instant::now());
                    cx.notify();
                });
                window.refresh();
            }
        };
        let card = notes
            .filter(|_| !self.incognito && !page_open)
            .and_then(|notes| postcard(&self, notes, opener, &ui, state, now));
        let page = notes
            .or_else(|| ardia_state::ntp_extras::RELEASE_NOTES.first())
            .filter(|_| page_open)
            .map(|notes| notes_page(&self, notes, closer, state.page.value(now)));
        let shift = self.overlaps;
        div()
            .absolute()
            .inset_0()
            .child(
                div()
                    .absolute()
                    .top_0()
                    .bottom_0()
                    .left(px(shift.left))
                    .w(px(self.size.0))
                    .children(left)
                    .children(ask),
            )
            .child(
                div()
                    .absolute()
                    .top_0()
                    .bottom_0()
                    .left(px(-shift.right))
                    .w(px(self.size.0))
                    .child(self.corner)
                    .children(card),
            )
            .children(page)
    }
}

fn ask_body_with_link(emit: Emit) -> impl IntoElement {
    let body = format!("{ASK_BODY} {WHATS_SENT}");
    let link = body.len() - WHATS_SENT.len()..body.len();
    let underline = gpui::HighlightStyle {
        underline: Some(gpui::UnderlineStyle {
            thickness: px(1.),
            color: None,
            wavy: false,
        }),
        ..Default::default()
    };
    gpui::InteractiveText::new(
        "ntp-telemetry-whats-sent",
        gpui::StyledText::new(body).with_highlights([(link.clone(), underline)]),
    )
    .on_click(vec![link], move |_, window, cx| {
        emit.send(
            Msg::SettingsAt(crate::settings::rows::Pane::General),
            window,
            cx,
        )
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_peek_over_either_side_pushes_that_sides_cards_away() {
        assert_eq!(peek_overlaps(None, 100., 800.), PeekOverlaps::default());
        let left = peek_overlaps(Some((0., 300.)), 100., 800.);
        assert_eq!(
            left,
            PeekOverlaps {
                left: 200.,
                right: 0.
            }
        );
        let right = peek_overlaps(Some((700., 1000.)), 100., 800.);
        assert_eq!(
            right,
            PeekOverlaps {
                left: 0.,
                right: 200.
            }
        );
    }

    #[test]
    fn the_ask_needs_room_beside_or_below_the_bar() {
        let bar = Rect::new(400., 300., 652., 112.);
        assert!(ask_has_room((1400., 900.), bar, 118.));
        let tight = Rect::new(100., 700., 652., 112.);
        assert!(!ask_has_room((800., 900.), tight, 118.));
    }

    #[test]
    fn the_postcard_overhangs_the_top_right_and_the_page_fits_the_window() {
        let card = postcard_frame(1200.);
        assert_eq!((card.x, card.y), (1200. + 40. - 320., -30.));
        assert_eq!(notes_page_size((1400., 900.)), (860., 520.));
        let (w, h) = notes_page_size((700., 500.));
        assert_eq!(w, 636.);
        assert!((h - (636. * 0.62)).abs() < 1e-3);
    }
}
