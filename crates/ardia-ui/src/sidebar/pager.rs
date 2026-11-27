use std::cell::RefCell;
use std::collections::HashMap;
use std::time::{Duration, Instant};

use ardia_state::ProfileId;

pub const TRACKING_SCALE: f32 = 0.5;
pub const RUBBER_LIMIT: f32 = 255.0;
pub const RUBBER_COEFFICIENT: f32 = 0.15;
pub const RELEASE_VELOCITY: f32 = 5.0;
pub const SETTLE_RESPONSE: f32 = 0.25;
pub const WHEEL_THRESHOLD: f32 = 1.0;
pub const WHEEL_BURST: Duration = Duration::from_millis(49);
pub const WHEEL_COOLDOWN: Duration = Duration::from_millis(250);
const SAMPLE_WINDOW: Duration = Duration::from_millis(100);
pub const START_DISTANCE: f32 = 4.0;
pub const START_DOMINANCE: f32 = 1.5;
pub const CANCEL_DOMINANCE: f32 = 2.0;
pub const PAGER_VERTICAL_INTENT: f32 = 3.0 * START_DISTANCE;
const REST: f32 = 0.0005;

pub fn rubber_band(over: f32) -> f32 {
    if over <= 0.0 {
        return 0.0;
    }
    RUBBER_LIMIT * (1.0 - 1.0 / (RUBBER_COEFFICIENT * over / RUBBER_LIMIT + 1.0))
}

pub fn banded(points: f32, last: f32) -> f32 {
    if points < 0.0 {
        -rubber_band(-points)
    } else if points > last {
        last + rubber_band(points - last)
    } else {
        points
    }
}

pub fn release_target(position: f32, velocity: f32, began: usize, pages: usize) -> usize {
    if pages == 0 {
        return 0;
    }
    let last = (pages - 1) as f32;
    let raw = if velocity.abs() >= RELEASE_VELOCITY {
        if velocity > 0.0 {
            position.floor() + 1.0
        } else {
            position.ceil() - 1.0
        }
    } else {
        position.round()
    };
    let began = began as f32;
    raw.clamp(0.0, last)
        .clamp((began - 1.0).max(0.0), (began + 1.0).min(last)) as usize
}

pub fn settle_omega() -> f32 {
    std::f32::consts::TAU / SETTLE_RESPONSE
}

pub fn critically_damped(from: f32, to: f32, velocity: f32, elapsed: f32) -> (f32, f32) {
    let omega = settle_omega();
    let x0 = from - to;
    let b = velocity + omega * x0;
    let decay = (-omega * elapsed).exp();
    let x = (x0 + b * elapsed) * decay;
    let v = (b - omega * (x0 + b * elapsed)) * decay;
    (to + x, v)
}

#[derive(Clone, Copy, Debug, PartialEq)]
struct Settle {
    from: f32,
    to: f32,
    velocity: f32,
    start: Instant,
}

#[derive(Clone, Debug, PartialEq)]
struct Tracking {
    home: usize,
    start: f32,
    lo: usize,
    hi: usize,
    dx: f32,
    dy: f32,
    samples: Vec<(Duration, f32)>,
    clock: SampleClock,
    detent: usize,
    decided: bool,
}

#[derive(Clone, Copy, Debug, PartialEq)]
enum SampleClock {
    Event,
    Handled(Instant),
}

impl SampleClock {
    fn starting(now: Instant, event_time: Option<Duration>) -> Self {
        match event_time {
            Some(_) => SampleClock::Event,
            None => SampleClock::Handled(now),
        }
    }

    fn read(self, now: Instant, event_time: Option<Duration>) -> Option<Duration> {
        match self {
            SampleClock::Event => event_time,
            SampleClock::Handled(origin) => Some(now.saturating_duration_since(origin)),
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Gate {
    Wait,
    Track,
    Reject,
}

pub fn start_gate(dx: f32, dy: f32) -> Gate {
    if dy.abs() >= PAGER_VERTICAL_INTENT && CANCEL_DOMINANCE * dx.abs() < dy.abs() {
        Gate::Reject
    } else if dx == 0.0 || START_DOMINANCE * dx.abs() < dy.abs() {
        Gate::Wait
    } else {
        Gate::Track
    }
}

pub fn drag_bounds(home: usize, position: f32, pages: usize) -> (usize, usize) {
    let last = pages.saturating_sub(1);
    let lo = (home.saturating_sub(1) as f32)
        .min(position.floor())
        .max(0.0) as usize;
    let hi = ((home + 1).min(last) as f32)
        .max(position.ceil())
        .min(last as f32) as usize;
    (lo, hi)
}

pub fn banded_between(raw: f32, lo: f32, hi: f32, width: f32) -> f32 {
    if raw > hi {
        hi + rubber_band((raw - hi) * width) / width
    } else if raw < lo {
        lo - rubber_band((lo - raw) * width) / width
    } else {
        raw
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct SwipeOutcome {
    pub target: Option<usize>,
    pub detent: bool,
}

#[derive(Clone, Debug, Default, PartialEq)]
struct Wheel {
    sum: f32,
    last: Option<Instant>,
    trigger: Option<Instant>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Pager {
    profile: Option<ProfileId>,
    position: f32,
    settle: Option<Settle>,
    tracking: Option<Tracking>,
    ignoring_momentum: bool,
    swallowing: bool,
    holding: bool,
    index: usize,
    wheel: Wheel,
    own_switch: Option<ProfileId>,
}

impl Default for Pager {
    fn default() -> Self {
        Pager {
            profile: None,
            position: 0.0,
            settle: None,
            tracking: None,
            ignoring_momentum: false,
            swallowing: false,
            holding: false,
            index: 0,
            wheel: Wheel::default(),
            own_switch: None,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Phase {
    Prepare,
    Started,
    Moved,
    Ended,
    Cancelled,
}

impl Pager {
    pub fn sync(&mut self, profile: &ProfileId, index: Option<usize>, now: Instant) -> f32 {
        let Some(index) = index else {
            self.index = 0;
            self.profile = Some(profile.clone());
            self.settle = None;
            self.tracking = None;
            self.position = 0.0;
            return 0.0;
        };
        self.index = index;
        if self.profile.as_ref() != Some(profile) {
            let ours = self.own_switch.as_ref() == Some(profile);
            self.own_switch = None;
            self.profile = Some(profile.clone());
            if !ours {
                self.settle = None;
                self.tracking = None;
                self.position = index as f32;
            }
        }
        if self.tracking.is_none()
            && self.settle.is_none()
            && !self.holding
            && (self.position - index as f32).abs() > REST
        {
            self.position = index as f32;
        }
        self.position(now)
    }

    pub fn position(&mut self, now: Instant) -> f32 {
        if let Some(settle) = self.settle {
            let elapsed = now.saturating_duration_since(settle.start).as_secs_f32();
            let (x, v) = critically_damped(settle.from, settle.to, settle.velocity, elapsed);
            if (x - settle.to).abs() < REST && v.abs() < 0.01 {
                self.position = settle.to;
                self.settle = None;
            } else {
                self.position = x;
            }
        }
        self.position
    }

    pub fn moving(&self) -> bool {
        self.settle.is_some() || self.holding || self.tracking.as_ref().is_some_and(|t| t.decided)
    }

    pub fn tracking(&self) -> bool {
        self.tracking.as_ref().is_some_and(|t| t.decided)
    }

    pub fn engaged(&self) -> bool {
        self.holding || self.tracking.is_some()
    }

    pub fn animating(&self) -> bool {
        self.settle.is_some()
    }

    pub fn swallows_momentum(&self) -> bool {
        self.swallowing
    }

    pub fn momentum_ended(&mut self) {
        self.swallowing = false;
    }

    fn abandon(&mut self, now: Instant) {
        self.tracking = None;
        if self.holding || (self.position - self.index as f32).abs() > REST {
            self.holding = false;
            self.settle_to(self.index as f32, 0.0, now);
        }
    }

    fn settle_to(&mut self, to: f32, velocity: f32, now: Instant) {
        self.settle = Some(Settle {
            from: self.position,
            to,
            velocity,
            start: now,
        });
    }

    pub fn page_to(&mut self, profile: &ProfileId, index: usize, now: Instant, animate: bool) {
        self.position(now);
        self.tracking = None;
        self.own_switch = Some(profile.clone());
        if animate {
            let velocity = self.settle.map_or(0.0, |s| {
                critically_damped(
                    s.from,
                    s.to,
                    s.velocity,
                    now.saturating_duration_since(s.start).as_secs_f32(),
                )
                .1
            });
            self.settle_to(index as f32, velocity, now);
        } else {
            self.settle = None;
            self.position = index as f32;
        }
    }

    pub fn swipe(
        &mut self,
        phase: Phase,
        dx: f32,
        dy: f32,
        width: f32,
        pages: usize,
        now: Instant,
    ) -> SwipeOutcome {
        self.swipe_at(phase, dx, dy, width, pages, now, None)
    }

    #[allow(clippy::too_many_arguments)]
    pub fn swipe_at(
        &mut self,
        phase: Phase,
        dx: f32,
        dy: f32,
        width: f32,
        pages: usize,
        now: Instant,
        event_time: Option<Duration>,
    ) -> SwipeOutcome {
        let none = SwipeOutcome::default();
        if width <= 0.0 || pages < 2 {
            return none;
        }
        match phase {
            Phase::Prepare => {
                self.swallowing = false;
                self.ignoring_momentum = false;
                if self.settle.is_some() {
                    self.position(now);
                    self.settle = None;
                    self.holding = true;
                }
                none
            }
            Phase::Started => {
                self.swallowing = false;
                self.ignoring_momentum = false;
                let position = self.position(now);
                self.settle = None;
                let home = self.index.min(pages - 1);
                let (lo, hi) = drag_bounds(home, position, pages);
                self.tracking = Some(Tracking {
                    home,
                    start: position,
                    lo,
                    hi,
                    dx: 0.0,
                    dy: 0.0,
                    samples: Vec::new(),
                    clock: SampleClock::starting(now, event_time),
                    detent: (position.round().max(lo as f32) as usize).min(hi),
                    decided: false,
                });
                self.track(dx, dy, width, now, event_time)
            }
            Phase::Moved => {
                if self.ignoring_momentum || self.tracking.is_none() {
                    return none;
                }
                self.track(dx, dy, width, now, event_time)
            }
            Phase::Ended | Phase::Cancelled => {
                self.ignoring_momentum = true;
                let Some(mut tracking) = self.tracking.take() else {
                    if self.holding {
                        self.abandon(now);
                    }
                    return none;
                };
                if !tracking.decided {
                    self.abandon(now);
                    return none;
                }
                tracking.dx += dx;
                tracking.dy += dy;
                self.position = self.placed(&tracking, width);
                let velocity = sample_velocity(&tracking.samples);
                let target = if phase == Phase::Cancelled {
                    tracking.home
                } else {
                    release_target(self.position, velocity, tracking.home, pages)
                };
                let toward = (target as f32 - self.position) * velocity > 0.0;
                self.holding = false;
                self.swallowing = true;
                self.settle_to(
                    target as f32,
                    if toward { velocity / width } else { 0.0 },
                    now,
                );
                SwipeOutcome {
                    target: Some(target),
                    detent: false,
                }
            }
        }
    }

    fn placed(&self, tracking: &Tracking, width: f32) -> f32 {
        let raw = tracking.start - tracking.dx * TRACKING_SCALE / width;
        banded_between(raw, tracking.lo as f32, tracking.hi as f32, width)
    }

    fn track(
        &mut self,
        dx: f32,
        dy: f32,
        width: f32,
        now: Instant,
        event_time: Option<Duration>,
    ) -> SwipeOutcome {
        let none = SwipeOutcome::default();
        let Some(mut tracking) = self.tracking.take() else {
            return none;
        };
        tracking.dx += dx;
        tracking.dy += dy;
        if !tracking.decided {
            match start_gate(tracking.dx, tracking.dy) {
                Gate::Reject => {
                    self.abandon(now);
                    return none;
                }
                Gate::Wait => {
                    self.tracking = Some(tracking);
                    return none;
                }
                Gate::Track => {
                    tracking.decided = true;
                    self.holding = false;
                }
            }
        }
        let position = self.placed(&tracking, width);
        self.position = position;
        if let Some(at) = tracking.clock.read(now, event_time) {
            tracking.samples.push((at, position * width));
            tracking
                .samples
                .retain(|(sampled, _)| at.saturating_sub(*sampled) <= SAMPLE_WINDOW);
        }
        let nearest = (position.round().max(tracking.lo as f32) as usize).min(tracking.hi);
        let detent = nearest != tracking.detent;
        tracking.detent = nearest;
        self.tracking = Some(tracking);
        SwipeOutcome {
            target: None,
            detent,
        }
    }

    pub fn note_switch(&mut self, profile: &ProfileId) {
        self.own_switch = Some(profile.clone());
    }

    pub fn wheel(&mut self, dx: f32, now: Instant) -> Option<i32> {
        if self
            .wheel
            .trigger
            .is_some_and(|at| now.saturating_duration_since(at) <= WHEEL_COOLDOWN)
        {
            return None;
        }
        if self
            .wheel
            .last
            .is_none_or(|at| now.saturating_duration_since(at) > WHEEL_BURST)
        {
            self.wheel.sum = 0.0;
        }
        self.wheel.last = Some(now);
        self.wheel.sum += dx;
        if self.wheel.sum.abs() <= WHEEL_THRESHOLD {
            return None;
        }
        let step = if self.wheel.sum > 0.0 { -1 } else { 1 };
        self.wheel.sum = 0.0;
        self.wheel.trigger = Some(now);
        Some(step)
    }
}

pub fn sample_velocity(samples: &[(Duration, f32)]) -> f32 {
    let (Some(first), Some(last)) = (samples.first(), samples.last()) else {
        return 0.0;
    };
    let span = last.0.saturating_sub(first.0).as_secs_f32();
    if span <= 0.0 {
        return 0.0;
    }
    (last.1 - first.1) / span
}

thread_local! {
    static PAGERS: RefCell<HashMap<String, Pager>> = RefCell::new(HashMap::new());
}

pub fn with_pager<R>(window: &str, f: impl FnOnce(&mut Pager) -> R) -> R {
    PAGERS.with(|pagers| {
        let mut pagers = pagers.borrow_mut();
        f(pagers.entry(window.to_owned()).or_default())
    })
}

pub fn tint_toward(
    order: &[ProfileId],
    current: &ProfileId,
    position: f32,
) -> Option<(ProfileId, f32)> {
    let index = order.iter().position(|id| id == current)? as f32;
    let delta = position - index;
    if delta.abs() < REST {
        return None;
    }
    let neighbour = if delta > 0.0 {
        index + 1.0
    } else {
        index - 1.0
    };
    let neighbour = order
        .get(neighbour.max(0.0) as usize)
        .filter(|_| neighbour >= 0.0)?;
    Some((neighbour.clone(), delta.abs().min(1.0)))
}

pub fn stray_phase(gesture: gpui::ScrollPhase, touch: gpui::TouchPhase) -> Option<Phase> {
    match gesture {
        gpui::ScrollPhase::MayBegin | gpui::ScrollPhase::Began => Some(Phase::Cancelled),
        gpui::ScrollPhase::Changed | gpui::ScrollPhase::Stationary => Some(Phase::Moved),
        gpui::ScrollPhase::Ended => Some(Phase::Ended),
        gpui::ScrollPhase::Cancelled => Some(Phase::Cancelled),
        gpui::ScrollPhase::None => match touch {
            gpui::TouchPhase::Ended => Some(Phase::Ended),
            gpui::TouchPhase::Cancelled => Some(Phase::Cancelled),
            _ => None,
        },
    }
}

pub fn paging(window: &str) -> bool {
    PAGERS.with(|pagers| pagers.borrow().get(window).is_some_and(Pager::moving))
}

pub fn pager_position(window: &str, now: Instant) -> Option<f32> {
    PAGERS.with(|pagers| {
        pagers
            .borrow_mut()
            .get_mut(window)
            .filter(|pager| pager.moving())
            .map(|pager| pager.position(now))
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_backdrop_blends_toward_the_page_coming_into_view() {
        let order: Vec<ProfileId> = ["a", "b", "c"].into_iter().map(ProfileId::new).collect();
        assert_eq!(tint_toward(&order, &order[1], 1.0), None);
        assert_eq!(
            tint_toward(&order, &order[1], 1.25),
            Some((order[2].clone(), 0.25))
        );
        assert_eq!(
            tint_toward(&order, &order[1], 0.5),
            Some((order[0].clone(), 0.5))
        );
        assert_eq!(tint_toward(&order, &order[0], -0.2), None);
        assert_eq!(tint_toward(&order, &order[2], 2.3), None);
    }

    #[test]
    fn the_rubber_band_follows_dias_curve() {
        assert_eq!(rubber_band(0.0), 0.0);
        let at = rubber_band(255.0);
        assert!((at - 255.0 * (1.0 - 1.0 / 1.15)).abs() < 1e-3);
        assert!(rubber_band(10_000.0) < 255.0);
        assert_eq!(banded(-0.0, 100.0), 0.0);
        assert!(banded(150.0, 100.0) < 150.0);
    }

    #[test]
    fn a_fast_release_goes_to_the_next_page_and_a_slow_one_to_the_nearest() {
        assert_eq!(release_target(1.2, 6.0, 1, 4), 2);
        assert_eq!(release_target(1.8, -6.0, 1, 4), 1);
        assert_eq!(release_target(1.4, 1.0, 1, 4), 1);
        assert_eq!(release_target(1.6, 1.0, 1, 4), 2);
    }

    #[test]
    fn a_release_moves_at_most_one_page_from_where_it_began() {
        assert_eq!(release_target(2.7, 100.0, 1, 4), 2);
        assert_eq!(release_target(-0.4, -100.0, 0, 4), 0);
        assert_eq!(release_target(3.3, 100.0, 3, 4), 3);
    }

    #[test]
    fn the_settle_is_critically_damped_and_done_in_a_quarter_second() {
        let (start, _) = critically_damped(0.0, 1.0, 0.0, 0.0);
        assert_eq!(start, 0.0);
        let mut last = 0.0;
        for step in 1..=25 {
            let (x, _) = critically_damped(0.0, 1.0, 0.0, step as f32 * 0.01);
            assert!(x >= last && x <= 1.0 + 1e-6);
            last = x;
        }
        assert!(1.0 - critically_damped(0.0, 1.0, 0.0, 0.25).0 < 0.02);
        assert!(1.0 - critically_damped(0.0, 1.0, 0.0, 0.4).0 < 0.001);
    }

    #[test]
    fn tracking_moves_at_half_the_scroll_distance() {
        let now = Instant::now();
        let mut pager = Pager::default();
        let profile = ProfileId::new("a");
        pager.sync(&profile, Some(1), now);
        pager.swipe(Phase::Started, 0.0, 0.0, 200.0, 3, now);
        pager.swipe(Phase::Moved, -40.0, 0.0, 200.0, 3, now);
        assert!((pager.position(now) - 1.1).abs() < 1e-5);
        let outcome = pager.swipe(
            Phase::Ended,
            0.0,
            0.0,
            200.0,
            3,
            now + Duration::from_millis(16),
        );
        assert_eq!(outcome.target, Some(1));
        assert!(pager.moving());
        assert!(pager.swallows_momentum());
    }

    #[test]
    fn the_start_waits_for_a_dominant_horizontal_motion() {
        assert_eq!(start_gate(0.0, 0.0), Gate::Wait);
        assert_eq!(start_gate(3.0, 5.0), Gate::Wait);
        assert_eq!(start_gate(6.0, 3.0), Gate::Track);
        assert_eq!(start_gate(2.0, 12.0), Gate::Reject);
        assert_eq!(start_gate(7.0, 12.0), Gate::Wait);
    }

    #[test]
    fn release_velocity_reads_the_event_timestamps_not_the_handling_time() {
        let now = Instant::now();
        let ms = Duration::from_millis;
        let mut pager = Pager::default();
        pager.sync(&ProfileId::new("a"), Some(1), now);
        pager.swipe_at(Phase::Started, 0.0, 0.0, 200.0, 3, now, Some(ms(1000)));
        pager.swipe_at(Phase::Moved, -10.0, 0.0, 200.0, 3, now, Some(ms(1008)));
        pager.swipe_at(Phase::Moved, -10.0, 0.0, 200.0, 3, now, Some(ms(1016)));
        pager.swipe_at(Phase::Moved, -10.0, 0.0, 200.0, 3, now, None);
        pager.swipe_at(Phase::Moved, -10.0, 0.0, 200.0, 3, now, Some(ms(1032)));
        let velocity = pager.tracking.as_ref().map(|t| sample_velocity(&t.samples));
        assert!((velocity.unwrap_or_default() - 30.0 * 0.5 / 0.024).abs() < 1e-2);
        assert_eq!(sample_velocity(&[(ms(5), 0.0), (ms(5), 40.0)]), 0.0);
        assert_eq!(sample_velocity(&[(ms(5), 40.0)]), 0.0);
        assert!((sample_velocity(&[(ms(0), 0.0), (ms(2), 10.0)]) - 5000.0).abs() < 1e-2);
    }

    #[test]
    fn vertical_gestures_never_page() {
        let now = Instant::now();
        let mut pager = Pager::default();
        pager.sync(&ProfileId::new("a"), Some(0), now);
        pager.swipe(Phase::Started, 0.0, 0.0, 200.0, 3, now);
        pager.swipe(Phase::Moved, -2.0, -30.0, 200.0, 3, now);
        pager.swipe(Phase::Moved, -80.0, 0.0, 200.0, 3, now);
        assert_eq!(pager.position(now), 0.0);
        assert_eq!(
            pager.swipe(Phase::Ended, 0.0, 0.0, 200.0, 3, now).target,
            None
        );
    }

    #[test]
    fn a_slight_vertical_start_still_pages_once_horizontal_wins() {
        let now = Instant::now();
        let mut pager = Pager::default();
        pager.sync(&ProfileId::new("a"), Some(0), now);
        pager.swipe(Phase::Started, 0.0, 0.0, 200.0, 3, now);
        pager.swipe(Phase::Moved, -1.0, -2.0, 200.0, 3, now);
        assert!(!pager.tracking());
        pager.swipe(Phase::Moved, -40.0, 0.0, 200.0, 3, now);
        assert!(pager.tracking());
        assert!((pager.position(now) - 41.0 * 0.5 / 200.0).abs() < 1e-5);
    }

    #[test]
    fn dragging_stops_one_page_away_with_a_rubber_band() {
        let now = Instant::now();
        let mut pager = Pager::default();
        pager.sync(&ProfileId::new("a"), Some(0), now);
        pager.swipe(Phase::Started, 0.0, 0.0, 200.0, 4, now);
        let mut detents = 0;
        for _ in 0..20 {
            if pager.swipe(Phase::Moved, -100.0, 0.0, 200.0, 4, now).detent {
                detents += 1;
            }
        }
        let position = pager.position(now);
        assert!(position > 1.0 && position < 2.0);
        assert_eq!(detents, 1);
    }

    #[test]
    fn a_finger_down_holds_a_settling_page_and_lifting_resettles_it() {
        let now = Instant::now();
        let mut pager = Pager::default();
        pager.sync(&ProfileId::new("a"), Some(0), now);
        pager.page_to(&ProfileId::new("b"), 1, now, true);
        pager.sync(&ProfileId::new("b"), Some(1), now);
        let later = now + Duration::from_millis(40);
        pager.swipe(Phase::Prepare, 0.0, 0.0, 200.0, 3, later);
        pager.sync(&ProfileId::new("b"), Some(1), later);
        let held = pager.position(later);
        assert!(held < 1.0);
        assert_eq!(pager.position(later + Duration::from_millis(100)), held);
        pager.swipe(Phase::Ended, 0.0, 0.0, 200.0, 3, later);
        assert_eq!(pager.position(later + Duration::from_millis(600)), 1.0);
    }

    #[test]
    fn momentum_after_the_lift_is_ignored() {
        let now = Instant::now();
        let mut pager = Pager::default();
        pager.sync(&ProfileId::new("a"), Some(0), now);
        pager.swipe(Phase::Started, 0.0, 0.0, 200.0, 3, now);
        pager.swipe(Phase::Ended, 0.0, 0.0, 200.0, 3, now);
        assert_eq!(
            pager.swipe(Phase::Moved, -80.0, 0.0, 200.0, 3, now).target,
            None
        );
        assert_eq!(pager.position(now), 0.0);
    }

    #[test]
    fn a_gesture_that_ends_outside_the_sidebar_still_settles_on_a_page() {
        let now = Instant::now();
        let mut pager = Pager::default();
        let a = ProfileId::new("a");
        pager.sync(&a, Some(1), now);
        pager.swipe(Phase::Started, 0.0, 0.0, 200.0, 3, now);
        pager.swipe(Phase::Moved, 60.0, 0.0, 200.0, 3, now);
        assert!(pager.engaged());
        let stuck = pager.sync(&a, Some(1), now + Duration::from_secs(2));
        assert!((stuck - 1.0).abs() > 0.05, "{stuck}");
        let phase =
            stray_phase(gpui::ScrollPhase::Ended, gpui::TouchPhase::Moved).expect("an end phase");
        let at = now + Duration::from_secs(2);
        let outcome = pager.swipe(phase, 0.0, 0.0, 200.0, 3, at);
        assert_eq!(outcome.target, Some(1));
        assert!(!pager.engaged());
        let settled = pager.sync(&a, Some(1), at + Duration::from_millis(800));
        assert_eq!(settled, 1.0);
        assert!(!pager.moving());
    }

    #[test]
    fn a_new_gesture_elsewhere_releases_a_held_page() {
        let now = Instant::now();
        let mut pager = Pager::default();
        let a = ProfileId::new("a");
        let b = ProfileId::new("b");
        pager.sync(&a, Some(0), now);
        pager.page_to(&b, 1, now, true);
        pager.sync(&b, Some(1), now);
        let later = now + Duration::from_millis(40);
        pager.swipe(Phase::Prepare, 0.0, 0.0, 200.0, 3, later);
        assert!(pager.engaged());
        let phase =
            stray_phase(gpui::ScrollPhase::Began, gpui::TouchPhase::Started).expect("a release");
        pager.swipe(phase, 0.0, 0.0, 200.0, 3, later);
        assert!(!pager.engaged());
        assert_eq!(
            pager.sync(&b, Some(1), later + Duration::from_millis(800)),
            1.0
        );
        assert_eq!(
            stray_phase(gpui::ScrollPhase::None, gpui::TouchPhase::Moved),
            None
        );
    }

    #[test]
    fn a_wheel_burst_pages_once_then_cools_down() {
        let now = Instant::now();
        let mut pager = Pager::default();
        assert_eq!(pager.wheel(-0.6, now), None);
        assert_eq!(pager.wheel(-0.6, now + Duration::from_millis(20)), Some(1));
        assert_eq!(pager.wheel(-5.0, now + Duration::from_millis(100)), None);
        assert_eq!(pager.wheel(3.0, now + Duration::from_millis(400)), Some(-1));
    }

    #[test]
    fn an_outside_switch_jumps_and_our_own_switch_slides() {
        let now = Instant::now();
        let mut pager = Pager::default();
        let a = ProfileId::new("a");
        let b = ProfileId::new("b");
        let c = ProfileId::new("c");
        pager.sync(&a, Some(0), now);
        assert_eq!(pager.sync(&c, Some(2), now), 2.0);
        assert!(!pager.moving());
        pager.page_to(&b, 1, now, true);
        assert_eq!(pager.sync(&b, Some(1), now), 2.0);
        assert!(pager.moving());
        let later = now + Duration::from_millis(600);
        assert_eq!(pager.sync(&b, Some(1), later), 1.0);
        assert!(!pager.moving());
    }

    #[test]
    fn a_batch_release_then_catch_keeps_a_finite_position_between_pages() {
        let now = Instant::now();
        let mut pager = Pager::default();
        let a = ProfileId::new("a");
        let b = ProfileId::new("b");
        pager.sync(&a, Some(0), now);
        pager.swipe(Phase::Started, 0.0, 0.0, 233.0, 4, now);
        let mut at = now;
        for dx in [-80.0, -80.0, -60.0] {
            at += Duration::from_millis(8);
            pager.swipe(Phase::Moved, dx, 0.0, 233.0, 4, at);
        }
        let now = at + Duration::from_millis(8);
        let outcome = pager.swipe(Phase::Ended, 0.0, 0.0, 233.0, 4, now);
        assert_eq!(outcome.target, Some(1));
        pager.note_switch(&b);
        pager.swipe(Phase::Prepare, 0.0, 0.0, 233.0, 4, now);
        let held = pager.sync(&b, Some(1), now);
        assert!(held.is_finite() && held > 0.0 && held < 1.0, "{held}");
    }

    #[test]
    fn a_burst_of_events_arriving_together_does_not_fling_the_page() {
        let now = Instant::now();
        let mut pager = Pager::default();
        pager.sync(&ProfileId::new("a"), Some(0), now);
        let mut stamp = Duration::from_secs(10);
        pager.swipe_at(Phase::Started, 0.0, 0.0, 233.0, 4, now, Some(stamp));
        let mut at = now;
        for _ in 0..3 {
            at += Duration::from_micros(20);
            stamp += Duration::from_millis(16);
            pager.swipe_at(Phase::Moved, -70.0, 0.0, 233.0, 4, at, Some(stamp));
        }
        pager.swipe_at(Phase::Ended, 0.0, 0.0, 233.0, 4, at, Some(stamp));
        let later = at + Duration::from_millis(30);
        let position = pager.position(later);
        assert!((0.0..=1.2).contains(&position), "{position}");
    }
}
