use std::time::{Duration, Instant};

use crate::primitives::gradient_fill::gradient_fill;
use crate::scale::px;
use gpui::{
    App, ElementId, Hsla, IntoElement, ParentElement, RenderOnce, Styled, Window, div,
    prelude::FluentBuilder,
};

pub const FLOOR: f32 = 0.1;
pub const TAIL: f32 = 120.0;
pub const CAP: f32 = 72.0;
pub const FRONT_SHARE: f32 = 0.4;
pub const TAIL_CEILING: f32 = 0.2;
pub const LINE: f32 = 1.5;
pub const TAIL_FADE: [f32; 6] = [1.0, 0.55, 0.38, 0.33, 0.3, 0.0];
pub const CAP_FADE: [f32; 10] = [1.0, 0.78, 0.59, 0.43, 0.3, 0.19, 0.11, 0.05, 0.01, 0.0];
pub const GLOW: [(f32, f32); 8] = [
    (0.0, 0.08),
    (0.07, 0.13),
    (0.45, 0.17),
    (0.65, 0.2),
    (0.78, 0.28),
    (0.87, 0.4),
    (0.94, 0.6),
    (1.0, 0.7),
];
pub const CORNER_TAPER: [f32; 5] = [0.09, 0.28, 0.52, 0.76, 0.96];
pub const LASTING_AFTER: Duration = Duration::from_millis(150);
pub const PULSE_WAIT: Duration = Duration::from_millis(1000);
pub const PULSE_STEP: f32 = 0.025;
pub const PULSE_PERIOD: Duration = Duration::from_millis(1800);
pub const PULSE_LOW: f32 = 0.87;
pub const SHOW: Duration = Duration::from_millis(200);
pub const PROGRESS: Duration = Duration::from_millis(250);
pub const FINISH: Duration = Duration::from_millis(300);
pub const HOLD: Duration = Duration::from_millis(200);
pub const HIDE: Duration = Duration::from_millis(250);

pub type Stop = (f32, f32);

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Front {
    pub tail: f32,
    pub cap: f32,
}

pub fn front_of(width: f32) -> Front {
    let scale = (width * FRONT_SHARE / TAIL).clamp(0.0, 1.0);
    Front {
        tail: TAIL * scale,
        cap: CAP * scale,
    }
}

pub fn filled_at(progress: f32, width: f32) -> f32 {
    if width <= 0.0 {
        return FLOOR;
    }
    let tail = front_of(width).tail;
    FLOOR.max(progress.min(1.0 - tail / width))
}

pub fn fading_past(body: f32, front: f32, falloff: &[f32]) -> Vec<Stop> {
    let span = body + front;
    if span <= 0.0 || falloff.len() < 2 {
        return vec![(0.0, 1.0)];
    }
    let last = (falloff.len() - 1) as f32;
    std::iter::once((0.0, 1.0))
        .chain(
            falloff
                .iter()
                .enumerate()
                .map(|(i, alpha)| ((body + front * i as f32 / last) / span, *alpha)),
        )
        .collect()
}

fn lined(glow: &[Stop], height: f32) -> Vec<Stop> {
    let line_top = if height > 0.0 {
        1.0 - LINE / height
    } else {
        1.0
    };
    glow.iter()
        .map(|(at, alpha)| (at * line_top, *alpha))
        .chain([(line_top, 1.0), (1.0, 1.0)])
        .collect()
}

#[derive(Clone, Debug, PartialEq)]
pub struct Plate {
    pub glow: Vec<Stop>,
    pub fade: Vec<Stop>,
    pub extra: f32,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Plates {
    pub tail: Plate,
    pub cap: Plate,
    pub comet: Plate,
}

pub fn plates(width: f32, height: f32) -> Plates {
    let front = front_of(width);
    let tail_glow: Vec<Stop> = GLOW
        .iter()
        .map(|(at, a)| (*at, a.min(TAIL_CEILING)))
        .collect();
    let cap_glow: Vec<Stop> = GLOW
        .iter()
        .map(|(at, a)| (*at, a - a.min(TAIL_CEILING)))
        .collect();
    let cap_fade = fading_past(width, front.cap, &CAP_FADE);
    let mut comet_fade = cap_fade.clone();
    if let Some(first) = comet_fade.first_mut() {
        *first = (0.0, 0.0);
    }
    Plates {
        tail: Plate {
            glow: tail_glow,
            fade: fading_past(width, front.tail, &TAIL_FADE),
            extra: front.tail,
        },
        cap: Plate {
            glow: lined(&cap_glow, height),
            fade: cap_fade,
            extra: front.cap,
        },
        comet: Plate {
            glow: lined(&GLOW, height),
            fade: comet_fade,
            extra: front.cap,
        },
    }
}

pub fn stop_at(stops: &[Stop], at: f32) -> f32 {
    let Some(first) = stops.first() else {
        return 0.0;
    };
    if at <= first.0 {
        return first.1;
    }
    for pair in stops.windows(2) {
        let ((a, va), (b, vb)) = (pair[0], pair[1]);
        if at <= b {
            return if b - a <= f32::EPSILON {
                vb
            } else {
                va + (vb - va) * (at - a) / (b - a)
            };
        }
    }
    stops.last().map_or(0.0, |last| last.1)
}

pub fn ease_enter(t: f32) -> f32 {
    let t = t.clamp(0.0, 1.0);
    1.0 - (1.0 - t).powi(3)
}

pub fn ease_exit(t: f32) -> f32 {
    let t = t.clamp(0.0, 1.0);
    t * t
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Glide {
    from: f32,
    to: f32,
    start: Instant,
    delay: Duration,
    duration: Duration,
    exit: bool,
}

impl Glide {
    pub fn rest(value: f32, now: Instant) -> Self {
        Glide {
            from: value,
            to: value,
            start: now,
            delay: Duration::ZERO,
            duration: Duration::ZERO,
            exit: false,
        }
    }

    pub fn value(&self, now: Instant) -> f32 {
        let elapsed = now.saturating_duration_since(self.start);
        if elapsed < self.delay {
            return self.from;
        }
        if self.duration.is_zero() {
            return self.to;
        }
        let t = (elapsed - self.delay).as_secs_f32() / self.duration.as_secs_f32();
        let eased = if self.exit {
            ease_exit(t)
        } else {
            ease_enter(t)
        };
        self.from + (self.to - self.from) * eased
    }

    pub fn running(&self, now: Instant) -> bool {
        now.saturating_duration_since(self.start) < self.delay + self.duration
            && (self.to - self.from).abs() > f32::EPSILON
    }

    pub fn ends(&self) -> Instant {
        self.start + self.delay + self.duration
    }

    fn go(&mut self, to: f32, duration: Duration, delay: Duration, exit: bool, now: Instant) {
        *self = Glide {
            from: self.value(now),
            to,
            start: now,
            delay,
            duration,
            exit,
        };
    }

    fn set(&mut self, value: f32, now: Instant) {
        *self = Glide::rest(value, now);
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Phase {
    Idle,
    Loading,
    Finishing,
}

#[derive(Clone, Debug)]
pub struct LoadFill {
    pub phase: Phase,
    loading_since: Option<Instant>,
    filled: Glide,
    opacity: Glide,
    comet: Glide,
    anchor: f32,
    progress: Option<f32>,
    waiting_since: Option<Instant>,
    width: f32,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct LoadFrame {
    pub filled: f32,
    pub opacity: f32,
    pub comet: f32,
}

impl LoadFill {
    pub fn new(now: Instant) -> Self {
        LoadFill {
            phase: Phase::Idle,
            loading_since: None,
            filled: Glide::rest(0.0, now),
            opacity: Glide::rest(0.0, now),
            comet: Glide::rest(0.0, now),
            anchor: 0.0,
            progress: None,
            waiting_since: None,
            width: 0.0,
        }
    }

    fn show(&mut self, progress: f32, now: Instant, still: bool) {
        self.phase = Phase::Loading;
        self.filled.set(0.0, now);
        self.comet.set(0.0, now);
        self.opacity.go(1.0, SHOW, Duration::ZERO, false, now);
        self.anchor = progress;
        self.waiting_since = (!still).then_some(now);
        self.progress = None;
        self.refit(progress, now, still);
    }

    fn refit(&mut self, progress: f32, now: Instant, still: bool) {
        if self.width <= 0.0 {
            return;
        }
        let to = filled_at(progress, self.width);
        if self.progress == Some(progress) && (self.filled.to - to).abs() < 1e-4 {
            return;
        }
        self.progress = Some(progress);
        if still {
            self.filled.set(to, now);
        } else {
            self.filled.go(to, PROGRESS, Duration::ZERO, false, now);
        }
    }

    fn finish(&mut self, now: Instant, still: bool) {
        self.phase = Phase::Finishing;
        self.waiting_since = None;
        self.progress = None;
        if still {
            self.filled.set(1.0, now);
            self.comet.set(1.0, now);
            self.opacity.go(0.0, HIDE, HOLD, true, now);
        } else {
            self.filled.go(1.0, FINISH, Duration::ZERO, false, now);
            self.comet.go(1.0, FINISH, Duration::ZERO, false, now);
            self.opacity.go(0.0, HIDE, FINISH + HOLD, true, now);
        }
    }

    pub fn sync(&mut self, loading: bool, progress: f32, width: f32, now: Instant, still: bool) {
        let resized = (self.width - width).abs() > 0.25;
        self.width = width;
        if loading {
            let since = *self.loading_since.get_or_insert(now);
            let lasting = now.saturating_duration_since(since) >= LASTING_AFTER;
            if lasting && self.phase != Phase::Loading {
                self.show(progress, now, still);
            } else if self.phase == Phase::Loading {
                if self.progress != Some(progress) {
                    if progress < self.anchor || progress - self.anchor >= PULSE_STEP {
                        self.anchor = progress;
                        self.waiting_since = (!still).then_some(now);
                    }
                    self.refit(progress, now, still);
                } else if resized {
                    self.progress = None;
                    self.refit(progress, now, still);
                }
                if still {
                    self.waiting_since = None;
                }
            }
        } else {
            self.loading_since = None;
            if self.phase == Phase::Loading {
                self.finish(now, still);
            }
        }
        if self.phase == Phase::Finishing && now >= self.opacity.ends() {
            self.phase = Phase::Idle;
        }
    }

    pub fn pulse(&self, now: Instant) -> f32 {
        let Some(since) = self.waiting_since.filter(|_| self.phase == Phase::Loading) else {
            return 0.0;
        };
        let start = since + PULSE_WAIT;
        if now < start {
            return 0.0;
        }
        let t = now.saturating_duration_since(start).as_secs_f32() / PULSE_PERIOD.as_secs_f32();
        (1.0 - (std::f32::consts::TAU * t.fract()).cos()) / 2.0
    }

    pub fn frame(&self, now: Instant) -> LoadFrame {
        let brightness = 1.0 - (1.0 - PULSE_LOW) * self.pulse(now);
        LoadFrame {
            filled: self.filled.value(now),
            opacity: self.opacity.value(now) * brightness,
            comet: self.comet.value(now),
        }
    }

    pub fn animating(&self, now: Instant) -> bool {
        match self.phase {
            Phase::Idle => self.loading_since.is_some(),
            Phase::Loading => true,
            Phase::Finishing => now < self.opacity.ends(),
        }
    }

    pub fn shown(&self, now: Instant) -> bool {
        self.phase != Phase::Idle || self.opacity.value(now) > 0.0
    }
}

pub fn rim_radius(width: f32, height: f32, radius: f32) -> f32 {
    radius.max(0.0).min(width / 2.0).min(height / 2.0)
}

fn drop_line(stops: &[Stop]) -> Vec<Stop> {
    stops[..stops.len().saturating_sub(2)].to_vec()
}

fn fade_at(plate: &Plate, width: f32, travel: f32, x: f32) -> f32 {
    let plate_w = width + plate.extra;
    if plate_w <= 0.0 {
        return 0.0;
    }
    stop_at(&plate.fade, (x - travel) / plate_w)
}

fn plate_layer(color: Hsla, glow: &[Stop], plate: &Plate, width: f32, travel: f32) -> gpui::Div {
    div()
        .absolute()
        .top_0()
        .bottom_0()
        .left(px(travel))
        .w(px(width + plate.extra))
        .child(gradient_fill(color, glow).fade(&plate.fade))
}

fn rim_layer(
    color: Hsla,
    plate: &Plate,
    width: f32,
    height: f32,
    corner: f32,
    travel: f32,
) -> gpui::Div {
    let mut rim = div().absolute().inset_0().child(
        div()
            .absolute()
            .left(px(corner))
            .right(px(corner))
            .bottom_0()
            .h(px(LINE))
            .overflow_hidden()
            .child(
                div()
                    .absolute()
                    .top_0()
                    .bottom_0()
                    .left(px(travel - corner))
                    .w(px(width + plate.extra))
                    .child(gradient_fill(color, &[(0.0, 1.0), (1.0, 1.0)]).fade(&plate.fade)),
            ),
    );
    if corner <= 0.0 {
        return rim;
    }
    let slices = CORNER_TAPER.len() as f32;
    for right in [false, true] {
        let x = if right { width - corner } else { corner };
        let mut box_ = div()
            .absolute()
            .bottom_0()
            .size(px(corner))
            .overflow_hidden()
            .opacity(fade_at(plate, width, travel, x));
        box_ = if right { box_.right_0() } else { box_.left_0() };
        for (i, taper) in CORNER_TAPER.iter().enumerate() {
            let top = corner * i as f32 / slices;
            let bottom = corner * (1.0 - (i as f32 + 1.0) / slices);
            let mut ring = div()
                .absolute()
                .bottom(px(-bottom))
                .w(px(width))
                .h(px(height))
                .rounded(px(corner))
                .border(px(LINE))
                .border_color(color);
            ring = if right { ring.right_0() } else { ring.left_0() };
            box_ = box_.child(
                div()
                    .absolute()
                    .left_0()
                    .right_0()
                    .top(px(top))
                    .bottom(px(bottom))
                    .opacity(*taper)
                    .overflow_hidden()
                    .child(ring),
            );
        }
        rim = rim.child(box_);
    }
    rim
}

pub fn layers(frame: LoadFrame, color: Hsla, width: f32, height: f32, radius: f32) -> gpui::Div {
    let corner = rim_radius(width, height, radius);
    let shapes = plates(width, height);
    let travel = -width * (1.0 - frame.filled);
    let steady = 1.0 - frame.comet;
    div()
        .absolute()
        .inset_0()
        .rounded(px(radius))
        .overflow_hidden()
        .opacity(frame.opacity)
        .child(
            div()
                .absolute()
                .inset_0()
                .opacity(steady)
                .child(plate_layer(
                    color,
                    &shapes.tail.glow,
                    &shapes.tail,
                    width,
                    travel,
                ))
                .child(plate_layer(
                    color,
                    &drop_line(&shapes.cap.glow),
                    &shapes.cap,
                    width,
                    travel,
                )),
        )
        .child(
            div()
                .absolute()
                .inset_0()
                .opacity(frame.comet)
                .child(plate_layer(
                    color,
                    &drop_line(&shapes.comet.glow),
                    &shapes.comet,
                    width,
                    travel,
                )),
        )
        .child(rim_layer(color, &shapes.cap, width, height, corner, travel).opacity(steady))
        .child(rim_layer(color, &shapes.comet, width, height, corner, travel).opacity(frame.comet))
}

#[derive(IntoElement)]
pub struct FieldLoadFill {
    pub id: ElementId,
    pub loading: bool,
    pub progress: f32,
    pub width: f32,
    pub height: f32,
    pub color: Hsla,
    pub radius: f32,
}

impl RenderOnce for FieldLoadFill {
    fn render(self, window: &mut Window, cx: &mut App) -> impl IntoElement {
        let now = Instant::now();
        let still = cx.reduce_motion();
        let state = window.use_keyed_state(self.id, cx, |_, _| LoadFill::new(now));
        let (frame, shown, animating) = state.update(cx, |fill, _| {
            fill.sync(self.loading, self.progress, self.width, now, still);
            (fill.frame(now), fill.shown(now), fill.animating(now))
        });
        if animating {
            window.request_animation_frame();
        }
        div()
            .absolute()
            .inset_0()
            .when(shown && frame.opacity > 0.0, |this| {
                this.child(layers(
                    frame,
                    self.color,
                    self.width,
                    self.height,
                    self.radius,
                ))
            })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_front_shrinks_with_narrow_fields() {
        assert_eq!(
            front_of(1000.0),
            Front {
                tail: 120.0,
                cap: 72.0
            }
        );
        let narrow = front_of(150.0);
        assert!((narrow.tail - 60.0).abs() < 1e-4);
        assert!((narrow.cap - 36.0).abs() < 1e-4);
    }

    #[test]
    fn the_fill_keeps_its_floor_and_leaves_room_for_the_tail() {
        assert_eq!(filled_at(0.0, 600.0), FLOOR);
        assert!((filled_at(0.5, 600.0) - 0.5).abs() < 1e-6);
        assert!((filled_at(1.0, 600.0) - (1.0 - 120.0 / 600.0)).abs() < 1e-6);
        assert_eq!(filled_at(0.5, 0.0), FLOOR);
    }

    #[test]
    fn fades_run_full_over_the_body_then_fall_off_past_the_front() {
        let fade = fading_past(400.0, 120.0, &TAIL_FADE);
        assert_eq!(fade[0], (0.0, 1.0));
        assert!((fade[1].0 - 400.0 / 520.0).abs() < 1e-6);
        assert_eq!(fade.last().map(|s| s.1), Some(0.0));
        assert!((stop_at(&fade, 0.2) - 1.0).abs() < 1e-6);
        let plates = plates(400.0, 30.0);
        assert_eq!(plates.comet.fade[0], (0.0, 0.0));
        assert!((plates.tail.glow.last().unwrap().1 - TAIL_CEILING).abs() < 1e-6);
        let cap_glow = drop_line(&plates.cap.glow);
        assert!((cap_glow.last().unwrap().1 - 0.5).abs() < 1e-6);
        assert!((cap_glow.last().unwrap().0 - (1.0 - LINE / 30.0)).abs() < 1e-6);
        assert_eq!(plates.cap.glow.last(), Some(&(1.0, 1.0)));
    }

    #[test]
    fn short_loads_never_show_and_lasting_loads_fade_in_then_sweep_out() {
        let t0 = Instant::now();
        let mut fill = LoadFill::new(t0);
        fill.sync(true, 0.2, 500.0, t0, false);
        assert_eq!(fill.phase, Phase::Idle);
        fill.sync(false, 0.2, 500.0, t0 + Duration::from_millis(100), false);
        assert_eq!(fill.phase, Phase::Idle);
        assert!(!fill.shown(t0 + Duration::from_millis(100)));

        let start = t0 + Duration::from_millis(200);
        fill.sync(true, 0.3, 500.0, start, false);
        fill.sync(true, 0.3, 500.0, start + LASTING_AFTER, false);
        assert_eq!(fill.phase, Phase::Loading);
        let shown = start + LASTING_AFTER + SHOW;
        let frame = fill.frame(shown + PROGRESS);
        assert!((frame.opacity - 1.0).abs() < 1e-4);
        assert!((frame.filled - 0.3).abs() < 1e-4);
        assert_eq!(frame.comet, 0.0);

        let done = shown + Duration::from_millis(500);
        fill.sync(false, 1.0, 500.0, done, false);
        assert_eq!(fill.phase, Phase::Finishing);
        let swept = fill.frame(done + FINISH);
        assert!((swept.filled - 1.0).abs() < 1e-4 && (swept.comet - 1.0).abs() < 1e-4);
        assert!((swept.opacity - 1.0).abs() < 1e-4);
        let gone = done + FINISH + HOLD + HIDE;
        fill.sync(false, 1.0, 500.0, gone, false);
        assert_eq!(fill.phase, Phase::Idle);
        assert_eq!(fill.frame(gone).opacity, 0.0);
    }

    #[test]
    fn stalled_progress_starts_a_gentle_pulse() {
        let t0 = Instant::now();
        let mut fill = LoadFill::new(t0);
        fill.sync(true, 0.4, 500.0, t0, false);
        fill.sync(true, 0.4, 500.0, t0 + LASTING_AFTER, false);
        let quiet = t0 + LASTING_AFTER + PULSE_WAIT;
        assert_eq!(fill.pulse(quiet), 0.0);
        let peak = quiet + PULSE_PERIOD / 2;
        assert!((fill.pulse(peak) - 1.0).abs() < 1e-3);
        assert!((fill.frame(peak).opacity - PULSE_LOW).abs() < 1e-3);
        fill.sync(true, 0.5, 500.0, peak, false);
        assert_eq!(fill.pulse(peak + Duration::from_millis(10)), 0.0);
        let mut still = LoadFill::new(t0);
        still.sync(true, 0.4, 500.0, t0, true);
        still.sync(true, 0.4, 500.0, t0 + LASTING_AFTER, true);
        assert_eq!(still.pulse(t0 + Duration::from_secs(5)), 0.0);
    }

    #[test]
    fn plates_drop_their_line_and_corners_fade_with_the_front() {
        assert_eq!(rim_radius(20.0, 30.0, 16.0), 10.0);
        let shapes = plates(400.0, 30.0);
        assert_eq!(drop_line(&shapes.cap.glow).len(), GLOW.len());
        assert!(fade_at(&shapes.cap, 400.0, 0.0, 8.0) > 0.99);
        assert_eq!(fade_at(&shapes.cap, 400.0, -1000.0, 8.0), 0.0);
    }
}
