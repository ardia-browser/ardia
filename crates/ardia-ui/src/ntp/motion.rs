use std::time::Instant;

use ardia_theme::motion::Spring;

pub const SNAPPY: Spring = Spring::new(0.2, 0.9);
pub const SMOOTH: Spring = Spring::new(0.4, 0.85);
pub const SETTLE_EPSILON: f64 = 0.001;

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Curve {
    Spring(Spring),
    EaseOut(f32),
    EaseIn(f32),
}

impl Curve {
    fn progress(self, seconds: f32) -> f32 {
        match self {
            Curve::Spring(spring) => spring.value(f64::from(seconds), 0.0) as f32,
            Curve::EaseOut(length) => {
                let x = (seconds / length.max(f32::EPSILON)).clamp(0.0, 1.0);
                1.0 - (1.0 - x).powi(3)
            }
            Curve::EaseIn(length) => {
                let x = (seconds / length.max(f32::EPSILON)).clamp(0.0, 1.0);
                x * x
            }
        }
    }

    fn length(self) -> f32 {
        match self {
            Curve::Spring(spring) => spring.settling_time(SETTLE_EPSILON) as f32,
            Curve::EaseOut(length) | Curve::EaseIn(length) => length,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Tween {
    pub from: f32,
    pub to: f32,
    pub start: Instant,
    pub curve: Curve,
}

impl Tween {
    pub fn rest(value: f32) -> Self {
        Tween {
            from: value,
            to: value,
            start: Instant::now(),
            curve: Curve::EaseOut(0.0),
        }
    }

    pub fn starting(from: f32, to: f32, curve: Curve, start: Instant) -> Self {
        Tween {
            from,
            to,
            start,
            curve,
        }
    }

    pub fn elapsed(&self, now: Instant) -> f32 {
        now.saturating_duration_since(self.start).as_secs_f32()
    }

    pub fn value(&self, now: Instant) -> f32 {
        let t = self.elapsed(now);
        if t >= self.curve.length() {
            return self.to;
        }
        self.from + (self.to - self.from) * self.curve.progress(t)
    }

    pub fn done(&self, now: Instant) -> bool {
        self.elapsed(now) >= self.curve.length()
    }

    pub fn retarget(&mut self, to: f32, curve: Curve, now: Instant) {
        if (to - self.to).abs() < f32::EPSILON {
            return;
        }
        *self = Tween::starting(self.value(now), to, curve, now);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    #[test]
    fn tweens_run_from_start_to_target_and_retarget_from_where_they_are() {
        let start = Instant::now();
        let mut tween = Tween::starting(1.0, 1.02, Curve::Spring(SNAPPY), start);
        assert!((tween.value(start) - 1.0).abs() < 1e-6);
        let later = start + Duration::from_secs(2);
        assert!((tween.value(later) - 1.02).abs() < 1e-6);
        assert!(tween.done(later));
        let mid = start + Duration::from_millis(50);
        let at = tween.value(mid);
        tween.retarget(0.98, Curve::Spring(SNAPPY), mid);
        assert!((tween.value(mid) - at).abs() < 1e-6);
        let ease = Tween::starting(0.0, 1.0, Curve::EaseOut(0.25), start);
        assert!(ease.value(start + Duration::from_millis(125)) > 0.5);
    }
}
