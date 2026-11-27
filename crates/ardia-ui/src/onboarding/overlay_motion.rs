use std::time::{Duration, Instant};

use ardia_theme::motion::Spring;

pub const OVERLAY_IN: Duration = Duration::from_millis(250);
pub const OVERLAY_OUT: Duration = Duration::from_millis(400);
pub const CARD_SPRING: Spring = Spring::new(0.4, 0.85);
pub const CARD_RISE: f32 = 24.0;
pub const CARD_FROM_SCALE: f32 = 0.97;
pub const CARD_AWAY_SCALE: f32 = 1.03;
const CARD_REST_DISPLACEMENT: f64 = 0.001;

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct OverlayFrame {
    pub presence: f32,
    pub card_opacity: f32,
    pub card_rise: f32,
    pub card_scale: f32,
    pub moving: bool,
}

#[derive(Clone, Copy, Debug)]
pub struct OverlayMotion {
    shown_at: Instant,
    card_from: Option<Instant>,
    leaving_from: Option<(Instant, f32, f32)>,
}

fn ease_out_cubic(t: f32) -> f32 {
    1.0 - (1.0 - t).powi(3)
}

fn ease_in_quad(t: f32) -> f32 {
    t * t
}

fn progress(elapsed: Duration, span: Duration) -> f32 {
    (elapsed.as_secs_f32() / span.as_secs_f32()).clamp(0.0, 1.0)
}

fn interpolate(value: f32, outputs: [f32; 3]) -> f32 {
    if value <= 1.0 {
        outputs[0] + (outputs[1] - outputs[0]) * value
    } else {
        outputs[1] + (outputs[2] - outputs[1]) * (value - 1.0)
    }
}

impl OverlayMotion {
    pub fn new(now: Instant) -> Self {
        OverlayMotion {
            shown_at: now,
            card_from: None,
            leaving_from: None,
        }
    }

    pub fn show_card(&mut self, past_intro: bool, now: Instant) {
        match (past_intro, self.card_from) {
            (true, None) => self.card_from = Some(now),
            (false, Some(_)) => self.card_from = None,
            _ => {}
        }
    }

    pub fn leave(&mut self, now: Instant) {
        if self.leaving_from.is_some() {
            return;
        }
        let (presence, card) = self.raw(now);
        self.leaving_from = Some((now, presence, card));
    }

    pub fn left(&self, now: Instant) -> bool {
        self.leaving_from
            .is_some_and(|(at, _, _)| now.saturating_duration_since(at) >= OVERLAY_OUT)
    }

    fn card_value(&self, now: Instant) -> (f32, bool) {
        let Some(from) = self.card_from else {
            return (0.0, false);
        };
        let t = now.saturating_duration_since(from).as_secs_f64();
        let settled = t >= CARD_SPRING.settling_time(CARD_REST_DISPLACEMENT);
        if settled {
            (1.0, false)
        } else {
            (CARD_SPRING.value(t, 0.0) as f32, true)
        }
    }

    fn raw(&self, now: Instant) -> (f32, f32) {
        let presence = ease_out_cubic(progress(
            now.saturating_duration_since(self.shown_at),
            OVERLAY_IN,
        ));
        (presence, self.card_value(now).0)
    }

    pub fn frame(&self, now: Instant) -> OverlayFrame {
        let (presence, card, moving) = match self.leaving_from {
            Some((at, presence, card)) => {
                let eased = ease_in_quad(progress(now.saturating_duration_since(at), OVERLAY_OUT));
                (
                    presence * (1.0 - eased),
                    card + (2.0 - card) * eased,
                    eased < 1.0,
                )
            }
            None => {
                let shown = now.saturating_duration_since(self.shown_at);
                let presence = ease_out_cubic(progress(shown, OVERLAY_IN));
                let (card, springing) = self.card_value(now);
                (presence, card, shown < OVERLAY_IN || springing)
            }
        };
        OverlayFrame {
            presence,
            card_opacity: interpolate(card, [0.0, 1.0, 0.0]).clamp(0.0, 1.0),
            card_rise: interpolate(card, [CARD_RISE, 0.0, 0.0]),
            card_scale: interpolate(card, [CARD_FROM_SCALE, 1.0, CARD_AWAY_SCALE]),
            moving,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ms(n: u64) -> Duration {
        Duration::from_millis(n)
    }

    #[test]
    fn the_overlay_fades_in_over_250ms_easing_out() {
        let t0 = Instant::now();
        let m = OverlayMotion::new(t0);
        assert_eq!(m.frame(t0).presence, 0.0);
        let half = m.frame(t0 + ms(125)).presence;
        assert!((half - 0.875).abs() < 1e-3);
        assert_eq!(m.frame(t0 + OVERLAY_IN).presence, 1.0);
        assert!(m.frame(t0).moving);
    }

    #[test]
    fn the_card_waits_for_the_intro_then_springs_up_into_place() {
        let t0 = Instant::now();
        let mut m = OverlayMotion::new(t0);
        m.show_card(false, t0 + ms(300));
        assert_eq!(m.frame(t0 + ms(300)).card_opacity, 0.0);
        m.show_card(true, t0 + ms(500));
        let start = m.frame(t0 + ms(500));
        assert_eq!(start.card_rise, CARD_RISE);
        assert_eq!(start.card_scale, CARD_FROM_SCALE);
        let early = m.frame(t0 + ms(600));
        let expected = CARD_SPRING.value(0.1, 0.0) as f32;
        assert!((early.card_rise - CARD_RISE * (1.0 - expected)).abs() < 1e-3);
        assert!(early.card_opacity > 0.0 && early.card_opacity < 1.0);
        let done = m.frame(t0 + ms(2500));
        assert_eq!(
            (done.card_opacity, done.card_rise, done.card_scale),
            (1.0, 0.0, 1.0)
        );
        assert!(!done.moving);
    }

    #[test]
    fn an_overshooting_card_dips_like_the_old_interpolation() {
        let t0 = Instant::now();
        let mut m = OverlayMotion::new(t0);
        m.show_card(true, t0);
        let peak = (1..200)
            .map(|i| m.frame(t0 + ms(i * 5)))
            .fold(0.0f32, |a, f| a.max(f.card_scale));
        assert!(peak > 1.0 && peak < CARD_AWAY_SCALE);
    }

    #[test]
    fn leaving_fades_out_and_grows_the_card_over_400ms() {
        let t0 = Instant::now();
        let mut m = OverlayMotion::new(t0);
        m.show_card(true, t0);
        let at = t0 + ms(3000);
        m.leave(at);
        m.leave(at + ms(100));
        let half = m.frame(at + ms(200));
        assert!((half.presence - 0.75).abs() < 1e-3);
        assert!((half.card_scale - 1.0075).abs() < 1e-4);
        assert!((half.card_opacity - 0.75).abs() < 1e-3);
        assert!(!m.left(at + ms(399)));
        assert!(m.left(at + OVERLAY_OUT));
        let gone = m.frame(at + OVERLAY_OUT);
        assert_eq!(gone.presence, 0.0);
        assert!((gone.card_scale - CARD_AWAY_SCALE).abs() < 1e-5);
    }
}
