use std::time::{Duration, Instant};

use crate::scale::px;
use ardia_theme::motion::{CubicBezier, Spring, ease_out_cubic};
use gpui::{BoxShadow, Hsla, black, point};

pub use ardia_theme::tokens::{
    DISABLED_OPACITY, ShadowLevel, capsule, concentric, hairline, radius, shadow, sheet_width,
    space, swatch, toast_layout,
};

pub mod type_size {
    use ardia_theme::tokens::TypeSize;

    pub const BADGE: f32 = TypeSize::Badge.points();
    pub const TINY: f32 = TypeSize::Tiny.points();
    pub const CAPTION: f32 = TypeSize::Caption.points();
    pub const SMALL: f32 = TypeSize::Small.points();
    pub const BODY: f32 = TypeSize::Body.points();
    pub const TITLE: f32 = TypeSize::Title.points();
    pub const LARGE: f32 = TypeSize::Large.points();
}

pub mod line_height {
    use ardia_theme::tokens::TypeSize;

    pub const BADGE: f32 = TypeSize::Badge.line_height();
    pub const TINY: f32 = TypeSize::Tiny.line_height();
    pub const CAPTION: f32 = TypeSize::Caption.line_height();
    pub const SMALL: f32 = TypeSize::Small.line_height();
    pub const BODY: f32 = TypeSize::Body.line_height();
    pub const TITLE: f32 = TypeSize::Title.line_height();
    pub const LARGE: f32 = TypeSize::Large.line_height();
    pub const PROSE_SMALL: f32 = 17.0;
    pub const PROSE_BODY: f32 = 18.0;
}

pub const HAIRLINE: f32 = hairline::PANEL;
pub const THICK_HAIRLINE: f32 = hairline::PANEL * 2.0;

pub mod duration {
    use std::time::Duration;

    pub const FAST: Duration = Duration::from_millis(100);
    pub const BASE: Duration = Duration::from_millis(150);
    pub const SLOW: Duration = Duration::from_millis(250);
    pub const LONG: Duration = Duration::from_millis(400);
}

pub mod hover_fade {
    use std::time::Duration;

    pub const SHOW: Duration = Duration::from_millis(50);
    pub const HIDE: Duration = Duration::from_millis(200);
}

pub mod press_scale {
    pub const ICON: f32 = 0.96;
    pub const CONTROL: f32 = 0.985;
}

pub const SNAPPY: Spring = Spring::new(0.2, 0.9);

pub mod empty_state {
    pub const ICON: f32 = 30.0;
    pub const ICON_BOX: f32 = 40.0;
    pub const LIFT_BOTTOM: f32 = 80.0;
    pub const SUBTITLE_MAX_WIDTH: f32 = 360.0;
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SheetSize {
    Xs,
    S,
    M,
    L,
    Xl,
}

impl SheetSize {
    pub const fn width(self) -> f32 {
        match self {
            SheetSize::Xs => sheet_width::XS,
            SheetSize::S => sheet_width::S,
            SheetSize::M => sheet_width::M,
            SheetSize::L => sheet_width::L,
            SheetSize::Xl => sheet_width::XL,
        }
    }
}

pub fn shadow_color(level: &ShadowLevel, dark: bool) -> Hsla {
    black().opacity(level.opacity(dark))
}

pub fn box_shadow(level: &ShadowLevel, dark: bool) -> BoxShadow {
    BoxShadow {
        color: shadow_color(level, dark),
        offset: point(px(level.offset[0]), px(level.offset[1])),
        blur_radius: px(level.radius),
        spread_radius: px(0.),
        inset: false,
    }
}

pub fn shadows(level: &ShadowLevel, dark: bool) -> Vec<BoxShadow> {
    vec![box_shadow(level, dark)]
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Curve {
    Linear,
    Enter,
    Exit,
    Move,
    Fade,
}

impl Curve {
    pub fn ease(self, progress: f32) -> f32 {
        let t = f64::from(progress.clamp(0.0, 1.0));
        let eased = match self {
            Curve::Linear => t,
            Curve::Enter => ease_out_cubic(t),
            Curve::Exit => t * t,
            Curve::Move => {
                if t < 0.5 {
                    2.0 * t * t
                } else {
                    1.0 - (-2.0 * t + 2.0).powi(2) / 2.0
                }
            }
            Curve::Fade => CubicBezier::HOVER_CARD.ease(t),
        };
        eased as f32
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Tween {
    pub from: f32,
    pub to: f32,
    pub started: Option<Instant>,
    pub duration: Duration,
    pub curve: Curve,
}

impl Tween {
    pub fn at(value: f32) -> Self {
        Tween {
            from: value,
            to: value,
            started: None,
            duration: Duration::ZERO,
            curve: Curve::Linear,
        }
    }

    pub fn value(&self, now: Instant) -> f32 {
        let Some(started) = self.started else {
            return self.to;
        };
        if self.duration.is_zero() {
            return self.to;
        }
        let progress =
            now.saturating_duration_since(started).as_secs_f32() / self.duration.as_secs_f32();
        if progress >= 1.0 {
            return self.to;
        }
        self.from + (self.to - self.from) * self.curve.ease(progress)
    }

    pub fn running(&self, now: Instant) -> bool {
        self.started
            .is_some_and(|started| now.saturating_duration_since(started) < self.duration)
    }

    pub fn retarget(&mut self, to: f32, duration: Duration, curve: Curve, now: Instant) {
        if (self.to - to).abs() < f32::EPSILON {
            return;
        }
        self.from = self.value(now);
        self.to = to;
        self.started = Some(now);
        self.duration = duration;
        self.curve = curve;
    }

    pub fn jump(&mut self, to: f32) {
        *self = Tween::at(to);
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct SpringPair {
    pub from: (f32, f32),
    pub to: (f32, f32),
    pub started: Option<Instant>,
}

impl SpringPair {
    pub fn at(value: (f32, f32)) -> Self {
        SpringPair {
            from: value,
            to: value,
            started: None,
        }
    }

    fn progress(&self, now: Instant, spring: Spring) -> Option<f32> {
        let started = self.started?;
        let seconds = now.saturating_duration_since(started).as_secs_f64();
        if seconds >= spring.settling_time(0.001) {
            return None;
        }
        Some(spring.value(seconds, 0.0) as f32)
    }

    pub fn value(&self, now: Instant, spring: Spring) -> (f32, f32) {
        match self.progress(now, spring) {
            Some(t) => (
                self.from.0 + (self.to.0 - self.from.0) * t,
                self.from.1 + (self.to.1 - self.from.1) * t,
            ),
            None => self.to,
        }
    }

    pub fn running(&self, now: Instant, spring: Spring) -> bool {
        self.progress(now, spring).is_some()
    }

    pub fn retarget(&mut self, to: (f32, f32), now: Instant, spring: Spring) {
        if self.to == to {
            return;
        }
        self.from = self.value(now, spring);
        self.to = to;
        self.started = Some(now);
    }

    pub fn jump(&mut self, to: (f32, f32)) {
        *self = SpringPair::at(to);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tokens_match_the_old_tokens_ts() {
        assert_eq!(space::ML, 10.0);
        assert_eq!(space::XXXL, 24.0);
        assert_eq!(radius::CONTROL, 4.0);
        assert_eq!(radius::TILE, 8.0);
        assert_eq!(radius::SHEET, 16.0);
        assert_eq!(SheetSize::Xs.width(), 320.0);
        assert_eq!(SheetSize::Xl.width(), 560.0);
        assert_eq!(toast_layout::BOTTOM, 24.0);
        assert_eq!(toast_layout::EDGE, 12.0);
        assert_eq!(concentric(4.0, 1.0), 3.0);
        assert_eq!(concentric(1.0, 4.0), 0.0);
        assert_eq!(capsule(18.0), 9.0);
        assert!((shadow::CARD.opacity(true) - 0.4).abs() < 1e-6);
        assert!((shadow::CARD.opacity(false) - 0.144).abs() < 1e-6);
        assert_eq!(box_shadow(&shadow::DIALOG, false).blur_radius, px(24.));
        assert_eq!(duration::BASE, Duration::from_millis(150));
    }

    #[test]
    fn curves_start_at_zero_and_end_at_one() {
        for curve in [
            Curve::Linear,
            Curve::Enter,
            Curve::Exit,
            Curve::Move,
            Curve::Fade,
        ] {
            assert!(curve.ease(0.0).abs() < 1e-4);
            assert!((curve.ease(1.0) - 1.0).abs() < 1e-4);
        }
        assert!(Curve::Enter.ease(0.5) > 0.5);
        assert!(Curve::Exit.ease(0.5) < 0.5);
    }

    #[test]
    fn tweens_retarget_from_where_they_are() {
        let start = Instant::now();
        let mut tween = Tween::at(0.0);
        tween.retarget(1.0, duration::BASE, Curve::Enter, start);
        assert_eq!(tween.value(start), 0.0);
        assert!(tween.running(start + Duration::from_millis(75)));
        let mid = tween.value(start + Duration::from_millis(75));
        assert!(mid > 0.5 && mid < 1.0);
        assert_eq!(tween.value(start + Duration::from_millis(150)), 1.0);
        tween.retarget(
            0.0,
            duration::BASE,
            Curve::Enter,
            start + Duration::from_millis(75),
        );
        assert!((tween.value(start + Duration::from_millis(75)) - mid).abs() < 1e-6);
        tween.jump(1.0);
        assert!(!tween.running(start));
        assert_eq!(tween.value(start), 1.0);
    }

    #[test]
    fn springs_settle_on_the_target() {
        let start = Instant::now();
        let mut pair = SpringPair::at((0.0, 40.0));
        pair.retarget((60.0, 50.0), start, SNAPPY);
        assert!(pair.running(start + Duration::from_millis(50), SNAPPY));
        let (x, _) = pair.value(start + Duration::from_millis(50), SNAPPY);
        assert!(x > 0.0 && x < 60.0);
        assert_eq!(
            pair.value(start + Duration::from_secs(2), SNAPPY),
            (60.0, 50.0)
        );
    }
}
