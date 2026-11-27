use std::time::{Duration, Instant};

use crate::primitives::tokens::Curve;

#[derive(Clone, Debug)]
pub struct Leaving<T> {
    last: Option<T>,
    leaving: Option<(T, Instant)>,
}

impl<T> Default for Leaving<T> {
    fn default() -> Self {
        Leaving {
            last: None,
            leaving: None,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Switch {
    Keep,
    FadeOld,
}

impl<T: Clone + PartialEq> Leaving<T> {
    pub fn update(
        &mut self,
        current: Option<&T>,
        switch: Switch,
        now: Instant,
        span: Duration,
    ) -> Option<(T, f32)> {
        let changed = match (&self.last, current) {
            (Some(last), None) => Some(last.clone()),
            (Some(last), Some(now_shown)) if switch == Switch::FadeOld && last != now_shown => {
                Some(last.clone())
            }
            _ => None,
        };
        if let Some(gone) = changed {
            self.leaving = Some((gone, now));
        }
        if let (Some((gone, _)), Some(shown)) = (&self.leaving, current)
            && gone == shown
        {
            self.leaving = None;
        }
        self.last = current.cloned();
        let (gone, since) = self.leaving.clone()?;
        let elapsed = now.saturating_duration_since(since);
        if span.is_zero() || elapsed >= span {
            self.leaving = None;
            return None;
        }
        let progress = elapsed.as_secs_f32() / span.as_secs_f32();
        Some((gone, 1.0 - Curve::Exit.ease(progress)))
    }

    pub fn is_leaving(&self) -> bool {
        self.leaving.is_some()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const SPAN: Duration = Duration::from_millis(100);

    #[test]
    fn a_closed_value_stays_on_screen_and_fades_with_the_exit_curve() {
        let start = Instant::now();
        let mut presence = Leaving::default();
        assert_eq!(presence.update(Some(&1), Switch::Keep, start, SPAN), None);
        let (value, opacity) = presence.update(None, Switch::Keep, start, SPAN).unwrap();
        assert_eq!((value, opacity), (1, 1.0));
        let (_, half) = presence
            .update(None, Switch::Keep, start + SPAN / 2, SPAN)
            .unwrap();
        assert!((half - 0.75).abs() < 1e-3, "{half}");
        assert_eq!(
            presence.update(None, Switch::Keep, start + SPAN, SPAN),
            None
        );
        assert!(!presence.is_leaving());
    }

    #[test]
    fn reopening_the_same_value_cancels_the_fade() {
        let start = Instant::now();
        let mut presence = Leaving::default();
        presence.update(Some(&"zoom"), Switch::FadeOld, start, SPAN);
        presence.update(None, Switch::FadeOld, start, SPAN);
        assert_eq!(
            presence.update(Some(&"zoom"), Switch::FadeOld, start + SPAN / 4, SPAN),
            None
        );
    }

    #[test]
    fn switching_fades_the_old_one_only_when_asked() {
        let start = Instant::now();
        let mut kept = Leaving::default();
        kept.update(Some(&1), Switch::Keep, start, SPAN);
        assert_eq!(kept.update(Some(&2), Switch::Keep, start, SPAN), None);
        let mut faded = Leaving::default();
        faded.update(Some(&1), Switch::FadeOld, start, SPAN);
        assert_eq!(
            faded.update(Some(&2), Switch::FadeOld, start, SPAN),
            Some((1, 1.0))
        );
    }
}
