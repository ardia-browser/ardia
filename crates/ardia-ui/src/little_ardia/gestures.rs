use std::time::{Duration, Instant};

use ardia_theme::motion::{CubicBezier, Spring};

use crate::window::swipe_overlay::{PageSwipe, SwipePhase};

pub const PINCH_SMALLEST: f32 = 0.6;
pub const PINCH_LARGEST: f32 = 1.04;
pub const SWIPE_DISTANCE: f32 = 120.0;
pub const SWIPE_VELOCITY: f32 = 600.0;
pub const SWIPE_FADE_OVER: f32 = 280.0;
pub const SWIPE_LEAVE: Duration = Duration::from_millis(140);
pub const SETTLE_SPRING: Spring = Spring::new(0.2, 0.9);
pub const REST_DISPLACEMENT: f32 = 0.001;
pub const SPREAD_STARTS: f32 = 0.0001;

#[derive(Clone, Copy, Debug, PartialEq)]
struct Settle {
    from: f32,
    to: f32,
    start: Instant,
}

impl Settle {
    fn value(&self, now: Instant) -> (f32, bool) {
        let t = now.saturating_duration_since(self.start).as_secs_f64();
        let p = SETTLE_SPRING.value(t, 0.0).min(1.0) as f32;
        let value = self.from + (self.to - self.from) * p;
        let span = (self.to - self.from).abs().max(1e-6);
        let done = (self.to - value).abs() <= REST_DISPLACEMENT * span.max(1.0) || p >= 1.0;
        (if done { self.to } else { value }, done)
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct LittleZoom {
    value: f32,
    settle: Option<Settle>,
}

impl Default for LittleZoom {
    fn default() -> Self {
        LittleZoom {
            value: 1.0,
            settle: None,
        }
    }
}

impl LittleZoom {
    pub fn value(&mut self, now: Instant) -> f32 {
        if let Some(settle) = self.settle {
            let (value, done) = settle.value(now);
            self.value = value;
            if done {
                self.settle = None;
            }
        }
        self.value
    }

    pub fn running(&self) -> bool {
        self.settle.is_some()
    }

    pub fn stop(&mut self, now: Instant) {
        self.value(now);
        self.settle = None;
    }

    pub fn follow(&mut self, magnification: f32) {
        self.settle = None;
        self.value =
            crate::primitives::pinch::pinch_scale(magnification, PINCH_SMALLEST, PINCH_LARGEST);
    }

    pub fn settle(&mut self, now: Instant) {
        let from = self.value(now);
        self.settle = ((from - 1.0).abs() > 1e-6).then_some(Settle {
            from,
            to: 1.0,
            start: now,
        });
    }
}

pub fn zoomed_corner(
    scale: f32,
    width: f32,
    height: f32,
    inset: f32,
    card_radius: f32,
    window_radius: f32,
) -> Option<f32> {
    if inset <= 0.0 || width <= 0.0 || height <= 0.0 {
        return None;
    }
    let spreading = 1.0 + SPREAD_STARTS;
    let touches_edge = (1.0 + 2.0 * inset / width.max(height)).max(spreading + SPREAD_STARTS);
    let radius = if scale <= 1.0 {
        0.0
    } else if scale <= spreading {
        card_radius * (scale - 1.0) / SPREAD_STARTS
    } else if scale < touches_edge {
        card_radius
            + (window_radius - card_radius) * (scale - spreading) / (touches_edge - spreading)
    } else {
        window_radius
    };
    Some(radius / scale.max(1e-3))
}

pub fn swipe_closes(
    direction: crate::window::page_overlays::HistoryDirection,
    can_go_back: bool,
    full_screen: bool,
) -> bool {
    direction == crate::window::page_overlays::HistoryDirection::Back
        && !can_go_back
        && !full_screen
}

#[derive(Clone, Copy, Debug, PartialEq)]
enum SwipeMotion {
    Rest,
    Following,
    Leaving { from: f32, start: Instant },
    Settling(Settle),
    Gone,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct LittleSwipe {
    x: f32,
    motion: SwipeMotion,
    sample: Option<(Instant, f32)>,
    velocity: f32,
    closing: bool,
}

impl Default for LittleSwipe {
    fn default() -> Self {
        LittleSwipe {
            x: 0.0,
            motion: SwipeMotion::Rest,
            sample: None,
            velocity: 0.0,
            closing: false,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SwipeOutcome {
    None,
    Close,
}

impl LittleSwipe {
    pub fn offset(&mut self, now: Instant) -> f32 {
        match self.motion {
            SwipeMotion::Leaving { from, start } => {
                let t =
                    now.saturating_duration_since(start).as_secs_f64() / SWIPE_LEAVE.as_secs_f64();
                let eased = CubicBezier::EASE_IN_OUT.ease(t.min(1.0)) as f32;
                self.x = from + (SWIPE_FADE_OVER - from) * eased;
            }
            SwipeMotion::Settling(settle) => {
                let (value, done) = settle.value(now);
                self.x = value;
                if done {
                    self.motion = SwipeMotion::Rest;
                }
            }
            SwipeMotion::Gone => self.x = SWIPE_FADE_OVER,
            _ => {}
        }
        self.x
    }

    pub fn opacity(x: f32) -> f32 {
        (1.0 - x / SWIPE_FADE_OVER).clamp(0.0, 1.0)
    }

    pub fn running(&self) -> bool {
        matches!(
            self.motion,
            SwipeMotion::Leaving { .. } | SwipeMotion::Settling(_)
        )
    }

    pub fn left(&mut self, now: Instant) -> bool {
        if let SwipeMotion::Leaving { start, .. } = self.motion
            && now.saturating_duration_since(start) >= SWIPE_LEAVE
        {
            self.motion = SwipeMotion::Gone;
            return true;
        }
        false
    }

    pub fn reset(&mut self) {
        *self = LittleSwipe::default();
    }

    pub fn close(&mut self, reduce: bool, now: Instant) -> SwipeOutcome {
        ardia_telemetry::counts::count("little_ardia_swipe_closes");
        if reduce {
            return SwipeOutcome::Close;
        }
        let from = self.offset(now);
        self.motion = SwipeMotion::Leaving { from, start: now };
        SwipeOutcome::None
    }

    pub fn on_swipe(
        &mut self,
        swipe: &PageSwipe,
        can_go_back: bool,
        reduce: bool,
        now: Instant,
    ) -> SwipeOutcome {
        if matches!(self.motion, SwipeMotion::Leaving { .. } | SwipeMotion::Gone) {
            return SwipeOutcome::None;
        }
        if matches!(swipe.phase, SwipePhase::Began | SwipePhase::Swipe) {
            self.closing = swipe.direction == crate::window::page_overlays::HistoryDirection::Back
                && !can_go_back;
        }
        if !self.closing {
            return SwipeOutcome::None;
        }
        match swipe.phase {
            SwipePhase::Swipe => self.close(reduce, now),
            SwipePhase::Began => {
                self.offset(now);
                self.motion = SwipeMotion::Following;
                self.sample = Some((now, swipe.distance));
                self.velocity = 0.0;
                SwipeOutcome::None
            }
            SwipePhase::Changed => {
                if let Some((at, last)) = self.sample {
                    let dt = now.saturating_duration_since(at).as_secs_f32();
                    if dt > 0.001 {
                        self.velocity = (swipe.distance - last) / dt;
                    }
                }
                self.sample = Some((now, swipe.distance));
                self.motion = SwipeMotion::Following;
                self.x = swipe.distance.max(0.0);
                SwipeOutcome::None
            }
            SwipePhase::Ended | SwipePhase::Cancelled => {
                let far = swipe.distance >= SWIPE_DISTANCE;
                let velocity = if swipe.velocity != 0.0 {
                    swipe.velocity
                } else {
                    self.velocity
                };
                let fast = swipe.distance > 0.0 && velocity >= SWIPE_VELOCITY;
                if swipe.phase == SwipePhase::Ended && (far || fast) {
                    return self.close(reduce, now);
                }
                ardia_telemetry::counts::count("little_ardia_swipe_close_cancels");
                let from = self.offset(now);
                self.motion = SwipeMotion::Settling(Settle {
                    from,
                    to: 0.0,
                    start: now,
                });
                SwipeOutcome::None
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::window::page_overlays::HistoryDirection;
    use ardia_state::TabId;

    #[test]
    fn only_a_back_swipe_without_history_outside_full_screen_closes() {
        assert!(swipe_closes(HistoryDirection::Back, false, false));
        assert!(!swipe_closes(HistoryDirection::Back, true, false));
        assert!(!swipe_closes(HistoryDirection::Forward, false, false));
        assert!(!swipe_closes(HistoryDirection::Back, false, true));
    }

    fn swipe(phase: SwipePhase, distance: f32) -> PageSwipe {
        PageSwipe {
            tab: TabId::new("t"),
            phase,
            direction: HistoryDirection::Back,
            distance,
            dy: 0.0,
            velocity: 0.0,
        }
    }

    #[test]
    fn a_pinch_follows_the_old_curve_and_springs_back_without_overshoot() {
        let now = Instant::now();
        let mut zoom = LittleZoom::default();
        zoom.follow(-0.2);
        assert!((zoom.value(now) - 0.8).abs() < 1e-5);
        zoom.follow(-0.9);
        assert_eq!(zoom.value(now), PINCH_SMALLEST);
        zoom.follow(0.4);
        assert!((zoom.value(now) - PINCH_LARGEST).abs() < 1e-5);
        zoom.settle(now);
        let mut last = zoom.value(now);
        for i in 1..120 {
            let v = zoom.value(now + Duration::from_millis(i * 5));
            assert!(v <= last + 1e-6 && v >= 1.0 - 1e-6);
            last = v;
        }
        assert_eq!(zoom.value(now + Duration::from_secs(2)), 1.0);
        assert!(!zoom.running());
    }

    #[test]
    fn the_corner_rounds_only_while_spreading() {
        assert_eq!(zoomed_corner(1.0, 900.0, 640.0, 8.0, 10.0, 16.0), Some(0.0));
        assert_eq!(zoomed_corner(0.8, 900.0, 640.0, 8.0, 10.0, 16.0), Some(0.0));
        let edge = 1.0 + 16.0 / 900.0;
        let at_edge = zoomed_corner(edge, 900.0, 640.0, 8.0, 10.0, 16.0).unwrap();
        assert!((at_edge - 16.0 / edge).abs() < 1e-3);
        let spreading = zoomed_corner(1.0 + SPREAD_STARTS, 900.0, 640.0, 8.0, 10.0, 16.0).unwrap();
        assert!((spreading - 10.0).abs() < 1e-2);
        assert_eq!(zoomed_corner(1.02, 900.0, 640.0, 0.0, 10.0, 16.0), None);
    }

    #[test]
    fn a_back_swipe_with_no_history_slides_away_and_closes() {
        let now = Instant::now();
        let mut s = LittleSwipe::default();
        assert_eq!(
            s.on_swipe(&swipe(SwipePhase::Swipe, 0.0), false, false, now),
            SwipeOutcome::None
        );
        let mid = s.offset(now + Duration::from_millis(70));
        assert!((mid - SWIPE_FADE_OVER / 2.0).abs() < 1.0);
        assert!(!s.left(now + Duration::from_millis(100)));
        assert!(s.left(now + SWIPE_LEAVE));
        assert_eq!(LittleSwipe::opacity(s.offset(now + SWIPE_LEAVE)), 0.0);
    }

    #[test]
    fn the_engine_velocity_flings_a_short_swipe_closed() {
        let now = Instant::now();
        let mut s = LittleSwipe::default();
        s.on_swipe(&swipe(SwipePhase::Began, 0.0), false, false, now);
        let mut fling = swipe(SwipePhase::Ended, 40.0);
        fling.velocity = 900.0;
        s.on_swipe(&fling, false, false, now);
        assert!(s.left(now + SWIPE_LEAVE));
    }

    #[test]
    fn a_short_swipe_springs_back_and_history_wins() {
        let now = Instant::now();
        let mut s = LittleSwipe::default();
        s.on_swipe(&swipe(SwipePhase::Began, 0.0), false, false, now);
        s.on_swipe(
            &swipe(SwipePhase::Changed, 60.0),
            false,
            false,
            now + Duration::from_millis(200),
        );
        assert_eq!(s.offset(now), 60.0);
        s.on_swipe(
            &swipe(SwipePhase::Ended, 60.0),
            false,
            false,
            now + Duration::from_millis(200),
        );
        assert!(s.running());
        assert_eq!(s.offset(now + Duration::from_secs(2)), 0.0);
        let mut far = LittleSwipe::default();
        far.on_swipe(&swipe(SwipePhase::Began, 0.0), false, false, now);
        far.on_swipe(
            &swipe(SwipePhase::Changed, 130.0),
            false,
            false,
            now + Duration::from_millis(400),
        );
        far.on_swipe(
            &swipe(SwipePhase::Ended, 130.0),
            false,
            false,
            now + Duration::from_millis(400),
        );
        assert!(far.left(now + Duration::from_secs(1)));
        let mut history = LittleSwipe::default();
        history.on_swipe(&swipe(SwipePhase::Swipe, 0.0), true, false, now);
        assert!(!history.running());
        assert_eq!(
            LittleSwipe::default().on_swipe(&swipe(SwipePhase::Swipe, 0.0), false, true, now),
            SwipeOutcome::Close
        );
    }
}
