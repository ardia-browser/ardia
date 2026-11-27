use std::time::{Duration, Instant};

use ardia_theme::motion::{CubicBezier, ease_in_out_cubic, ease_out_cubic};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Curve {
    EaseOut,
    EaseInOut,
    EaseInQuad,
    EaseInOutQuad,
    DockSlide,
    Linear,
}

pub const DOCK_SLIDE_MS: u64 = 200;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DockMove {
    Jump,
    ArcHide,
    Slide,
}

pub fn dock_move(open: bool, animated: bool, arc: bool, peek_out: bool) -> DockMove {
    if !animated || (arc && open && peek_out) {
        DockMove::Jump
    } else if arc && !open {
        DockMove::ArcHide
    } else {
        DockMove::Slide
    }
}

impl Curve {
    pub fn apply(self, t: f32) -> f32 {
        let t = t.clamp(0.0, 1.0);
        match self {
            Curve::EaseOut => ease_out_cubic(f64::from(t)) as f32,
            Curve::EaseInOut => ease_in_out_cubic(f64::from(t)) as f32,
            Curve::EaseInQuad => t * t,
            Curve::EaseInOutQuad => {
                if t < 0.5 {
                    2.0 * t * t
                } else {
                    1.0 - (-2.0 * t + 2.0).powi(2) / 2.0
                }
            }
            Curve::DockSlide => CubicBezier::EASE_IN_OUT.ease(f64::from(t)) as f32,
            Curve::Linear => t,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Motion {
    from: f32,
    to: f32,
    start: Option<Instant>,
    duration: Duration,
    curve: Curve,
}

impl Motion {
    pub const fn rest(value: f32) -> Self {
        Motion {
            from: value,
            to: value,
            start: None,
            duration: Duration::ZERO,
            curve: Curve::Linear,
        }
    }

    pub fn target(&self) -> f32 {
        self.to
    }

    pub fn value(&self, now: Instant) -> f32 {
        let Some(start) = self.start else {
            return self.to;
        };
        if self.duration.is_zero() {
            return self.to;
        }
        let elapsed = now.saturating_duration_since(start).as_secs_f32();
        let t = (elapsed / self.duration.as_secs_f32()).min(1.0);
        self.from + (self.to - self.from) * self.curve.apply(t)
    }

    pub fn running(&self, now: Instant) -> bool {
        self.start
            .is_some_and(|start| now.saturating_duration_since(start) < self.duration)
    }

    pub fn go(&mut self, to: f32, duration: Duration, curve: Curve, now: Instant) {
        if (self.to - to).abs() < f32::EPSILON && !self.running(now) {
            self.snap(to);
            return;
        }
        let from = self.value(now);
        *self = Motion {
            from,
            to,
            start: (!duration.is_zero()).then_some(now),
            duration,
            curve,
        };
    }

    pub fn snap(&mut self, value: f32) {
        *self = Motion::rest(value);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn motions_run_from_where_they_are_to_their_target_without_overshoot() {
        let start = Instant::now();
        let mut peek = Motion::rest(0.0);
        peek.go(1.0, Duration::from_millis(150), Curve::EaseOut, start);
        assert_eq!(peek.value(start), 0.0);
        let mid = peek.value(start + Duration::from_millis(75));
        assert!(mid > 0.5 && mid < 1.0);
        assert_eq!(peek.value(start + Duration::from_millis(150)), 1.0);
        assert!(peek.running(start + Duration::from_millis(10)));
        assert!(!peek.running(start + Duration::from_millis(200)));
        let samples: Vec<f32> = (0..=30)
            .map(|step| peek.value(start + Duration::from_millis(step * 5)))
            .collect();
        assert!(samples.windows(2).all(|pair| pair[1] >= pair[0]));
        assert!(samples.iter().all(|value| *value <= 1.0));
        peek.go(
            0.0,
            Duration::from_millis(150),
            Curve::EaseInOut,
            start + Duration::from_millis(75),
        );
        assert!((peek.value(start + Duration::from_millis(75)) - mid).abs() < 1e-5);
        peek.snap(1.0);
        assert_eq!(peek.target(), 1.0);
        assert!(!peek.running(start));
    }

    #[test]
    fn quad_curves_match_react_natives_easings() {
        assert_eq!(Curve::EaseInQuad.apply(0.5), 0.25);
        assert_eq!(Curve::EaseInOutQuad.apply(0.25), 0.125);
        assert_eq!(Curve::EaseInOutQuad.apply(0.75), 0.875);
        assert_eq!(Curve::EaseInOutQuad.apply(1.0), 1.0);
    }

    #[test]
    fn the_dock_jumps_hides_or_slides_like_the_old_sidebar() {
        assert_eq!(dock_move(true, false, false, false), DockMove::Jump);
        assert_eq!(dock_move(true, true, true, true), DockMove::Jump);
        assert_eq!(dock_move(false, true, true, false), DockMove::ArcHide);
        assert_eq!(dock_move(false, true, false, false), DockMove::Slide);
        assert_eq!(dock_move(true, true, true, false), DockMove::Slide);
        assert!((Curve::DockSlide.apply(0.5) - 0.5).abs() < 1e-4);
        assert!(Curve::DockSlide.apply(0.25) < 0.25);
    }

    #[test]
    fn a_zero_duration_motion_lands_at_once() {
        let now = Instant::now();
        let mut dock = Motion::rest(1.0);
        dock.go(0.0, Duration::ZERO, Curve::EaseOut, now);
        assert_eq!(dock.value(now), 0.0);
        assert!(!dock.running(now));
    }
}
