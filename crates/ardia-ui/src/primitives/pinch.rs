use gpui::{PinchEvent, TouchPhase};

pub const PINCH_OPEN_AT: f32 = 0.3;
pub const PINCH_CLOSE_AT: f32 = -0.25;
pub const SPREAD_TO_TAB: f32 = 0.4;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PinchOutcome {
    Open,
    Close,
    Stay,
}

pub fn pinch_outcome(magnification: f32) -> PinchOutcome {
    if magnification >= PINCH_OPEN_AT {
        PinchOutcome::Open
    } else if magnification <= PINCH_CLOSE_AT {
        PinchOutcome::Close
    } else {
        PinchOutcome::Stay
    }
}

fn unit(value: f32) -> f32 {
    if value.is_nan() {
        0.0
    } else {
        value.clamp(0.0, 1.0)
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct PinchFollow {
    pub progress: f32,
    pub expand: f32,
}

pub fn pinch_follow(magnification: f32, start_scale: f32) -> PinchFollow {
    if magnification >= 0.0 {
        return PinchFollow {
            progress: 1.0,
            expand: unit(magnification / SPREAD_TO_TAB),
        };
    }
    let span = 1.0 - start_scale;
    PinchFollow {
        progress: if span.abs() < f32::EPSILON {
            0.0
        } else {
            unit((1.0 + magnification - start_scale) / span)
        },
        expand: 0.0,
    }
}

pub fn pinch_scale(magnification: f32, smallest: f32, largest: f32) -> f32 {
    if magnification >= 0.0 {
        1.0 + (largest - 1.0) * unit(magnification / SPREAD_TO_TAB)
    } else {
        smallest.max(1.0 + magnification)
    }
}

pub trait PinchMotion {
    fn reduce(&self) -> bool;
    fn idle(&self) -> bool;
    fn begin(&mut self);
    fn follow(&mut self, magnification: f32);
    fn settle(&mut self);
    fn open(&mut self);
    fn close(&mut self);
}

#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct PinchTracker {
    magnification: f32,
}

impl PinchTracker {
    pub fn magnification(&self) -> f32 {
        self.magnification
    }

    pub fn step(&mut self, event: &PinchEvent, motion: &mut impl PinchMotion) {
        if event.phase == TouchPhase::Started {
            self.magnification = 0.0;
        }
        if event.delta.is_finite() {
            self.magnification += event.delta;
        }
        pinch_step(motion, event.phase, self.magnification);
        if matches!(event.phase, TouchPhase::Ended | TouchPhase::Cancelled) {
            self.magnification = 0.0;
        }
    }
}

pub fn pinch_step(motion: &mut impl PinchMotion, phase: TouchPhase, magnification: f32) {
    if motion.idle() {
        return;
    }
    if phase == TouchPhase::Started && !motion.reduce() {
        motion.begin();
    }
    if matches!(phase, TouchPhase::Ended | TouchPhase::Cancelled) {
        let outcome = if phase == TouchPhase::Ended {
            pinch_outcome(magnification)
        } else {
            PinchOutcome::Stay
        };
        match outcome {
            PinchOutcome::Close => motion.close(),
            PinchOutcome::Open => motion.open(),
            PinchOutcome::Stay => {
                if !motion.reduce() {
                    motion.settle();
                }
            }
        }
        return;
    }
    if !motion.reduce() {
        motion.follow(magnification);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(Default)]
    struct Log {
        reduce: bool,
        idle: bool,
        calls: Vec<String>,
    }

    impl PinchMotion for Log {
        fn reduce(&self) -> bool {
            self.reduce
        }
        fn idle(&self) -> bool {
            self.idle
        }
        fn begin(&mut self) {
            self.calls.push("begin".into());
        }
        fn follow(&mut self, magnification: f32) {
            self.calls.push(format!("follow {magnification:.2}"));
        }
        fn settle(&mut self) {
            self.calls.push("settle".into());
        }
        fn open(&mut self) {
            self.calls.push("open".into());
        }
        fn close(&mut self) {
            self.calls.push("close".into());
        }
    }

    #[test]
    fn outcomes_use_the_old_thresholds() {
        assert_eq!(pinch_outcome(0.3), PinchOutcome::Open);
        assert_eq!(pinch_outcome(-0.25), PinchOutcome::Close);
        assert_eq!(pinch_outcome(0.1), PinchOutcome::Stay);
    }

    #[test]
    fn follow_and_scale_match_the_old_curves() {
        assert_eq!(
            pinch_follow(0.2, 0.6),
            PinchFollow {
                progress: 1.0,
                expand: 0.5
            }
        );
        let shrink = pinch_follow(-0.2, 0.6);
        assert!((shrink.progress - 0.5).abs() < 1e-5 && shrink.expand == 0.0);
        assert!((pinch_scale(0.4, 0.5, 1.2) - 1.2).abs() < 1e-5);
        assert_eq!(pinch_scale(-0.8, 0.5, 1.2), 0.5);
    }

    #[test]
    fn a_step_follows_then_settles_or_commits() {
        let mut log = Log::default();
        pinch_step(&mut log, TouchPhase::Started, 0.0);
        pinch_step(&mut log, TouchPhase::Moved, 0.1);
        pinch_step(&mut log, TouchPhase::Ended, 0.1);
        assert_eq!(log.calls, ["begin", "follow 0.00", "follow 0.10", "settle"]);
        let mut log = Log::default();
        pinch_step(&mut log, TouchPhase::Ended, 0.5);
        pinch_step(&mut log, TouchPhase::Cancelled, -0.5);
        assert_eq!(log.calls, ["open", "settle"]);
        let mut reduced = Log {
            reduce: true,
            ..Log::default()
        };
        pinch_step(&mut reduced, TouchPhase::Started, 0.0);
        pinch_step(&mut reduced, TouchPhase::Ended, -0.3);
        assert_eq!(reduced.calls, ["close"]);
        let mut idle = Log {
            idle: true,
            ..Log::default()
        };
        pinch_step(&mut idle, TouchPhase::Ended, 0.5);
        assert!(idle.calls.is_empty());
    }
}
