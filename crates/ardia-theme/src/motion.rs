use std::f64::consts::TAU;
use std::time::Duration;

pub const PEEK_IN_MS: u64 = 150;
pub const ARC_PEEK_OUT_MS: u64 = 150;
pub const ARC_HIDE_MS: u64 = 100;
pub const TAB_SLIDE_MS: u64 = 140;
pub const TAB_FADE_MS: u64 = 100;
pub const TAB_APPEAR_MS: u64 = 140;
pub const HOVER_CARD_FADE_MS: u64 = 100;
pub const HOVER_CARD_DELAY_MS: u64 = 800;
pub const HOVER_CARD_LEAVE_TOWARD_MS: u64 = 160;
pub const HOVER_CARD_PEEK_GRACE_MS: u64 = 400;
pub const HOVER_IN_MS: u64 = 50;
pub const HOVER_OUT_MS: u64 = 200;
pub const CLOSE_GLYPH_FADE_MS: u64 = 100;
pub const SCROLL_EDGE_FADE_MS: u64 = 100;
pub const PROFILE_SETTLE_MS: u64 = 250;
pub const SPINNER_PERIOD_MS: u64 = 1880;
pub const SPLIT_TARGET_SLIDE_MS: u64 = 110;
pub const DRAG_CARD_GROW_MS: u64 = 200;
pub const PIP_SCRIM_FADE_MS: u64 = 200;
pub const PIP_CLOSE_FADE_MS: u64 = 100;
pub const PIP_BACK_TO_TAB_FADE_MS: u64 = 70;
pub const HALO_DELAY_MS: u64 = 180;
pub const POWER_UP_FINISH_MS: u64 = 3750;

pub const fn millis(ms: u64) -> Duration {
    Duration::from_millis(ms)
}

pub fn ease_out_cubic(progress: f64) -> f64 {
    let t = progress.clamp(0.0, 1.0);
    1.0 - (1.0 - t).powi(3)
}

pub fn ease_in_out_cubic(progress: f64) -> f64 {
    let t = progress.clamp(0.0, 1.0);
    if t < 0.5 {
        4.0 * t * t * t
    } else {
        1.0 - (-2.0 * t + 2.0).powi(3) / 2.0
    }
}

pub fn ease_out_expo(progress: f64) -> f64 {
    let t = progress.clamp(0.0, 1.0);
    if t >= 1.0 {
        1.0
    } else {
        1.0 - 2f64.powf(-10.0 * t)
    }
}

pub fn rubber_band(overshoot: f64) -> f64 {
    let x = overshoot.abs();
    (255.0 * (1.0 - 1.0 / (0.15 * x / 255.0 + 1.0))).copysign(overshoot)
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct CubicBezier {
    pub x1: f64,
    pub y1: f64,
    pub x2: f64,
    pub y2: f64,
}

impl CubicBezier {
    pub const LINEAR: Self = Self::new(0.0, 0.0, 1.0, 1.0);
    pub const CORE_ANIMATION_DEFAULT: Self = Self::new(0.25, 0.1, 0.25, 1.0);
    pub const EASE_OUT: Self = Self::new(0.0, 0.0, 0.58, 1.0);
    pub const EASE_IN: Self = Self::new(0.42, 0.0, 1.0, 1.0);
    pub const EASE_IN_OUT: Self = Self::new(0.42, 0.0, 0.58, 1.0);
    pub const EASE_OUT_CUBIC: Self = Self::new(0.215, 0.61, 0.355, 1.0);
    pub const HOVER_CARD: Self = Self::new(0.25, 0.46, 0.45, 0.94);

    pub const fn new(x1: f64, y1: f64, x2: f64, y2: f64) -> Self {
        Self { x1, y1, x2, y2 }
    }

    pub fn ease(&self, progress: f64) -> f64 {
        if progress <= 0.0 {
            return 0.0;
        }
        if progress >= 1.0 {
            return 1.0;
        }
        let t = self.solve_x(progress);
        sample(self.y1, self.y2, t)
    }

    fn solve_x(&self, x: f64) -> f64 {
        let mut t = x;
        for _ in 0..8 {
            let error = sample(self.x1, self.x2, t) - x;
            if error.abs() < 1e-7 {
                return t;
            }
            let slope = slope(self.x1, self.x2, t);
            if slope.abs() < 1e-6 {
                break;
            }
            t -= error / slope;
        }
        let (mut low, mut high) = (0.0, 1.0);
        t = x;
        for _ in 0..64 {
            let value = sample(self.x1, self.x2, t);
            if (value - x).abs() < 1e-7 {
                break;
            }
            if value < x {
                low = t
            } else {
                high = t
            }
            t = (low + high) / 2.0;
        }
        t
    }
}

fn sample(p1: f64, p2: f64, t: f64) -> f64 {
    let c = 3.0 * p1;
    let b = 3.0 * (p2 - p1) - c;
    let a = 1.0 - c - b;
    ((a * t + b) * t + c) * t
}

fn slope(p1: f64, p2: f64, t: f64) -> f64 {
    let c = 3.0 * p1;
    let b = 3.0 * (p2 - p1) - c;
    let a = 1.0 - c - b;
    (3.0 * a * t + 2.0 * b) * t + c
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Spring {
    pub response: f64,
    pub damping_ratio: f64,
}

impl Spring {
    pub const SIDEBAR_SHOW: Self = Self::new(0.215, 0.79);
    pub const GROUP_EXPAND: Self = Self::new(0.30, 0.82);
    pub const REORDER: Self = Self::new(TAU / 90.0, 1.0);
    pub const PROFILE_SETTLE: Self = Self::new(0.25, 1.0);
    pub const SPLIT_SIZE: Self = Self::new(0.2, 0.9);
    pub const PIP_THROW: Self = Self::new(0.9, 0.9);
    pub const HOVER_CARD_SHOW: Self = Self::new(0.25, 0.75);
    pub const HOVER_CARD_DISMISS: Self = Self::new(0.2, 0.6);
    pub const ARC_PEEK: Self = Self::new(0.18, 0.8);
    pub const NEW_TAB_ENTRANCE: Self = Self::new(0.7, 1.0);
    pub const SNAPPY: Self = Self::new(0.18, 1.0);

    pub const fn new(response: f64, damping_ratio: f64) -> Self {
        Self {
            response,
            damping_ratio,
        }
    }

    pub fn angular_frequency(&self) -> f64 {
        TAU / self.response.max(1e-6)
    }

    pub fn stiffness(&self) -> f64 {
        self.angular_frequency().powi(2)
    }

    pub fn damping(&self) -> f64 {
        4.0 * std::f64::consts::PI * self.damping_ratio / self.response.max(1e-6)
    }

    pub fn value(&self, seconds: f64, initial_velocity: f64) -> f64 {
        if seconds <= 0.0 {
            return 0.0;
        }
        let w = self.angular_frequency();
        let z = self.damping_ratio.max(0.0);
        let v0 = initial_velocity;
        if (z - 1.0).abs() < 1e-9 {
            return 1.0 + (-1.0 + (v0 - w) * seconds) * (-w * seconds).exp();
        }
        if z < 1.0 {
            let wd = w * (1.0 - z * z).sqrt();
            let decay = (-z * w * seconds).exp();
            return 1.0
                + decay * (-(wd * seconds).cos() + ((v0 - z * w) / wd) * (wd * seconds).sin());
        }
        let root = (z * z - 1.0).sqrt();
        let r1 = -w * (z - root);
        let r2 = -w * (z + root);
        let c1 = (v0 + r2) / (r1 - r2);
        let c2 = -1.0 - c1;
        1.0 + c1 * (r1 * seconds).exp() + c2 * (r2 * seconds).exp()
    }

    pub fn settling_time(&self, epsilon: f64) -> f64 {
        let step = 1.0 / 240.0;
        let mut last_outside = 0.0;
        let mut t = 0.0;
        while t < 10.0 {
            if (self.value(t, 0.0) - 1.0).abs() > epsilon {
                last_outside = t;
            }
            t += step;
        }
        last_outside + step
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bezier_endpoints_and_monotone_ease_out() {
        for curve in [
            CubicBezier::EASE_OUT,
            CubicBezier::HOVER_CARD,
            CubicBezier::CORE_ANIMATION_DEFAULT,
            CubicBezier::EASE_IN_OUT,
        ] {
            assert_eq!(curve.ease(0.0), 0.0);
            assert_eq!(curve.ease(1.0), 1.0);
            let mut last = 0.0;
            for i in 1..=100 {
                let v = curve.ease(i as f64 / 100.0);
                assert!(v >= last - 1e-9);
                last = v;
            }
        }
        assert!((CubicBezier::LINEAR.ease(0.37) - 0.37).abs() < 1e-6);
    }

    #[test]
    fn ease_out_cubic_peek_lands_on_the_measured_frames() {
        let at = |ms: f64| ease_out_cubic(ms / PEEK_IN_MS as f64);
        for (ms, expected) in [
            (17.0, 0.30),
            (33.0, 0.53),
            (50.0, 0.70),
            (67.0, 0.83),
            (83.0, 0.91),
            (100.0, 0.96),
            (117.0, 0.99),
        ] {
            assert!((at(ms) - expected).abs() < 0.012, "{ms} {}", at(ms));
        }
        assert_eq!(at(150.0), 1.0);
        assert!((ease_in_out_cubic(0.5) - 0.5).abs() < 1e-12);
        assert_eq!(ease_out_expo(1.0), 1.0);
    }

    #[test]
    fn rubber_band_follows_the_paging_formula() {
        assert_eq!(rubber_band(0.0), 0.0);
        assert!((rubber_band(255.0) - 255.0 * (1.0 - 1.0 / 1.15)).abs() < 1e-9);
        assert_eq!(rubber_band(-100.0), -rubber_band(100.0));
        assert!(rubber_band(1e9) < 255.0);
    }

    #[test]
    fn sidebar_spring_covers_ninety_percent_in_a_tenth_of_a_second() {
        let v = Spring::SIDEBAR_SHOW.value(0.1, 0.0);
        assert!((v - 0.896).abs() < 0.01, "{v}");
        let peak = (1..120)
            .map(|i| Spring::SIDEBAR_SHOW.value(i as f64 / 240.0, 0.0))
            .fold(0.0, f64::max);
        assert!(peak > 1.0 && peak < 1.03);
    }

    #[test]
    fn critical_and_overdamped_springs_never_overshoot() {
        for spring in [
            Spring::PROFILE_SETTLE,
            Spring::new(0.3, 1.4),
            Spring::REORDER,
        ] {
            for i in 0..2400 {
                let v = spring.value(i as f64 / 240.0, 0.0);
                assert!(v <= 1.0 + 1e-9, "{spring:?} {v}");
            }
        }
        assert!(Spring::REORDER.settling_time(0.01) < 0.12);
    }

    #[test]
    fn spring_coefficients_follow_response_and_ratio() {
        let s = Spring::new(0.25, 0.75);
        assert!((s.stiffness() - (TAU / 0.25).powi(2)).abs() < 1e-9);
        assert!((s.damping() - 4.0 * std::f64::consts::PI * 0.75 / 0.25).abs() < 1e-9);
        assert_eq!(millis(TAB_SLIDE_MS), Duration::from_millis(140));
    }
}
