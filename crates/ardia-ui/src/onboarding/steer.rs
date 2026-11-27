#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Phase {
    None,
    MayBegin,
    Began,
    Changed,
    Ended,
    Cancelled,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Input {
    pub dy: f32,
    pub phase: Phase,
    pub momentum: bool,
    pub precise: bool,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Range {
    pub lo: f32,
    pub hi: f32,
    pub forward: bool,
    pub back: bool,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Action {
    None,
    Place(f32),
    Ease(f32),
    Move(i32),
    Settle,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Tuning {
    pub commit: f32,
    pub follow: f32,
    pub follow_max: f32,
    pub gesture_gap_ms: f64,
    pub line: f32,
    pub notch_pending_ms: f64,
    pub glide_hold_share: f64,
    pub notch_ease_ms: f64,
    pub edge_rest_ms: f64,
}

pub const STANDARD: Tuning = Tuning {
    commit: 28.0,
    follow: 0.4,
    follow_max: 26.0,
    gesture_gap_ms: 220.0,
    line: 40.0,
    notch_pending_ms: 360.0,
    glide_hold_share: 0.7,
    notch_ease_ms: 200.0,
    edge_rest_ms: 300.0,
};

pub fn clamp(range: Range, y: f32) -> f32 {
    y.max(range.lo).min(range.hi)
}

fn allows(range: Range, by: f32) -> bool {
    if by > 0.0 { range.forward } else { range.back }
}

#[derive(Clone, Debug)]
pub struct WheelSteer {
    pub tune: Tuning,
    accum: f32,
    committed: bool,
    scrolled_inside: bool,
    last_at: f64,
    inside_at: f64,
    hold_until: f64,
    pending_since: f64,
}

impl Default for WheelSteer {
    fn default() -> Self {
        WheelSteer::new(STANDARD)
    }
}

impl WheelSteer {
    pub fn new(tune: Tuning) -> Self {
        WheelSteer {
            tune,
            accum: 0.0,
            committed: false,
            scrolled_inside: false,
            last_at: f64::NEG_INFINITY,
            inside_at: f64::NEG_INFINITY,
            hold_until: f64::NEG_INFINITY,
            pending_since: f64::NEG_INFINITY,
        }
    }

    pub fn glide_started(&mut self, ms: f64, now: f64) {
        if now - self.pending_since >= self.tune.notch_pending_ms {
            return;
        }
        self.hold_until = self.hold_until.max(now + ms * self.tune.glide_hold_share);
        self.pending_since = f64::NEG_INFINITY;
    }

    pub fn read(&mut self, input: Input, at: f32, range: Range, now: f64) -> Action {
        let ending = matches!(input.phase, Phase::Ended | Phase::Cancelled);
        let starting = input.precise
            && !input.momentum
            && matches!(input.phase, Phase::Began | Phase::MayBegin);
        if starting {
            self.restart();
        }
        if !input.dy.is_finite() || (input.dy == 0.0 && !ending) {
            return Action::None;
        }
        if input.precise {
            self.swipe(
                input.dy,
                input.phase,
                input.momentum,
                ending,
                starting,
                at,
                range,
                now,
            )
        } else {
            self.notch(input.dy, at, range, now)
        }
    }

    fn restart(&mut self) {
        self.accum = 0.0;
        self.committed = false;
        self.scrolled_inside = false;
    }

    fn inside(&self, by: f32, at: f32, range: Range) -> Option<f32> {
        if range.hi <= range.lo {
            return None;
        }
        let within = clamp(range, at);
        let at_edge = if by > 0.0 {
            within >= range.hi - 0.01
        } else {
            within <= range.lo + 0.01
        };
        (!at_edge).then(|| clamp(range, within + by))
    }

    fn notch(&mut self, dy: f32, at: f32, range: Range, now: f64) -> Action {
        let by = -dy * self.tune.line;
        if now < self.hold_until {
            return Action::None;
        }
        if let Some(next) = self.inside(by, at, range) {
            self.inside_at = now;
            return Action::Ease(next);
        }
        if now - self.inside_at < self.tune.edge_rest_ms || !allows(range, by) {
            return Action::None;
        }
        self.commit(by, now)
    }

    fn commit(&mut self, by: f32, now: f64) -> Action {
        self.hold_until = now + self.tune.notch_pending_ms;
        self.pending_since = now;
        Action::Move(if by > 0.0 { 1 } else { -1 })
    }

    #[allow(clippy::too_many_arguments)]
    fn swipe(
        &mut self,
        dy: f32,
        phase: Phase,
        momentum: bool,
        ending: bool,
        starting: bool,
        at: f32,
        range: Range,
        now: f64,
    ) -> Action {
        let by = -dy;
        if momentum {
            if self.committed {
                return Action::None;
            }
            return self
                .inside(by, at, range)
                .map_or(Action::None, Action::Place);
        }
        if ending {
            return if self.committed || self.scrolled_inside {
                Action::None
            } else {
                Action::Settle
            };
        }
        let phaseless = phase == Phase::None;
        let paused = phaseless && now - self.last_at > self.tune.gesture_gap_ms;
        let spent = phaseless && self.committed && now >= self.hold_until;
        let rested =
            phaseless && self.scrolled_inside && now - self.inside_at >= self.tune.edge_rest_ms;
        if !starting && (paused || spent || rested) {
            self.restart();
        }
        self.last_at = now;
        if self.committed {
            return Action::None;
        }
        if let Some(next) = self.inside(by, at, range) {
            self.scrolled_inside = true;
            self.inside_at = now;
            return Action::Place(next);
        }
        if self.scrolled_inside || now < self.hold_until {
            return Action::None;
        }
        if !allows(range, self.accum + by) {
            let pulled = self.accum;
            self.accum = 0.0;
            return if pulled == 0.0 {
                Action::None
            } else {
                Action::Place(if pulled > 0.0 { range.hi } else { range.lo })
            };
        }
        self.accum += by;
        if self.accum.abs() >= self.tune.commit {
            self.committed = true;
            let accum = self.accum;
            return self.commit(accum, now);
        }
        let pull =
            (self.accum * self.tune.follow).clamp(-self.tune.follow_max, self.tune.follow_max);
        Action::Place(if self.accum > 0.0 { range.hi } else { range.lo } + pull)
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Fit {
    pub lo: f32,
    pub hi: f32,
}

pub fn fit(height: f32, viewport: f32, edge: f32) -> Fit {
    if height + edge * 2.0 <= viewport {
        let centre = height / 2.0 - viewport / 2.0;
        return Fit {
            lo: centre,
            hi: centre,
        };
    }
    Fit {
        lo: -edge,
        hi: height + edge - viewport,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn swipe(dy: f32, phase: Phase) -> Input {
        Input {
            dy,
            phase,
            momentum: false,
            precise: true,
        }
    }

    #[test]
    fn a_swipe_follows_then_commits_one_section() {
        let mut steer = WheelSteer::default();
        let range = Range {
            lo: 0.0,
            hi: 0.0,
            forward: true,
            back: true,
        };
        assert_eq!(
            steer.read(swipe(-10.0, Phase::Began), 0.0, range, 0.0),
            Action::Place(4.0)
        );
        assert_eq!(
            steer.read(swipe(-10.0, Phase::Changed), 0.0, range, 10.0),
            Action::Place(8.0)
        );
        assert_eq!(
            steer.read(swipe(-10.0, Phase::Changed), 0.0, range, 20.0),
            Action::Move(1)
        );
        assert_eq!(
            steer.read(swipe(-50.0, Phase::Changed), 0.0, range, 30.0),
            Action::None
        );
        assert_eq!(
            steer.read(swipe(0.0, Phase::Ended), 0.0, range, 40.0),
            Action::None
        );
    }

    #[test]
    fn a_short_swipe_settles_back() {
        let mut steer = WheelSteer::default();
        let range = Range {
            lo: 0.0,
            hi: 0.0,
            forward: true,
            back: true,
        };
        steer.read(swipe(-5.0, Phase::Began), 0.0, range, 0.0);
        assert_eq!(
            steer.read(swipe(0.0, Phase::Ended), 0.0, range, 10.0),
            Action::Settle
        );
    }

    #[test]
    fn notches_scroll_inside_a_tall_section_before_moving() {
        let mut steer = WheelSteer::default();
        let range = Range {
            lo: 0.0,
            hi: 100.0,
            forward: true,
            back: true,
        };
        let notch = Input {
            dy: -1.0,
            phase: Phase::None,
            momentum: false,
            precise: false,
        };
        assert_eq!(steer.read(notch, 0.0, range, 0.0), Action::Ease(40.0));
        assert_eq!(steer.read(notch, 100.0, range, 100.0), Action::None);
        assert_eq!(steer.read(notch, 100.0, range, 500.0), Action::Move(1));
        assert_eq!(steer.read(notch, 100.0, range, 600.0), Action::None);
    }

    #[test]
    fn tall_sections_fit_to_the_edge() {
        assert_eq!(
            fit(200.0, 600.0, 32.0),
            Fit {
                lo: -200.0,
                hi: -200.0
            }
        );
        assert_eq!(
            fit(700.0, 600.0, 32.0),
            Fit {
                lo: -32.0,
                hi: 132.0
            }
        );
    }
}
