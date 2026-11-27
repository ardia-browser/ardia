use std::sync::Arc;
use std::time::{Duration, Instant};

use ardia_state::{BrowserState, ProfileId};
use ardia_theme::motion::rubber_band;
use gpui::{BackdropLayerSpec, TouchPhase, WindowAppearance};

use crate::look::Look;
use crate::window::motion::{Curve, Motion};

pub const PAGER_SETTLE: Duration = Duration::from_millis(250);
pub const PAGER_COMMIT: f32 = 0.5;
pub const WHEEL_THRESHOLD: f32 = 1.0;
pub const WHEEL_BURST: Duration = Duration::from_millis(49);
pub const WHEEL_COOLDOWN: Duration = Duration::from_millis(250);

#[derive(Clone, Debug, PartialEq)]
pub enum PagerOutcome {
    None,
    Moved,
    SwitchTo(ProfileId),
}

#[derive(Clone, Copy, Debug, Default)]
struct WheelBurst {
    sum: f32,
    last: Option<Instant>,
    trigger: Option<Instant>,
}

#[derive(Clone, Debug, Default)]
pub struct ProfilePager {
    tracking: bool,
    horizontal: Option<bool>,
    travel: f32,
    offset: f32,
    settle: Option<Motion>,
    previous: Option<ProfileId>,
    next: Option<ProfileId>,
    neighbour: Option<(ProfileId, BackdropLayerSpec, gpui::BackdropGradients)>,
    wheel: WheelBurst,
}

pub fn neighbours(
    state: &BrowserState,
    current: &ProfileId,
) -> (Option<ProfileId>, Option<ProfileId>) {
    let order = &state.profile_order;
    let Some(at) = order.iter().position(|id| id == current) else {
        return (None, None);
    };
    (
        at.checked_sub(1).and_then(|i| order.get(i)).cloned(),
        order.get(at + 1).cloned(),
    )
}

pub fn page_offset(travel: f32, width: f32, has_previous: bool, has_next: bool) -> f32 {
    let width = width.max(1.0);
    let raw = -travel / width;
    let open = (raw > 0.0 && has_next) || (raw < 0.0 && has_previous);
    if open {
        raw.clamp(-1.0, 1.0)
    } else {
        rubber_band(f64::from(-travel)) as f32 / width
    }
}

pub fn neighbour_backdrop(
    state: &BrowserState,
    window: &str,
    profile: &ProfileId,
    appearance: WindowAppearance,
    active: bool,
    frame: [f32; 4],
    viewport: [f32; 2],
) -> Option<(BackdropLayerSpec, gpui::BackdropGradients)> {
    let mut shown = state.clone();
    let mut windows = (*shown.windows).clone();
    let listed = windows.get_mut(window)?;
    let mut moved = (**listed).clone();
    moved.profile_id = profile.clone();
    *listed = Arc::new(moved);
    shown.windows = Arc::new(windows);
    let look = Look::new(&shown, window, appearance);
    let [width, height, x, y] = frame;
    Some((
        look.backdrop_in(active, [width, height], [x, y]),
        look.backdrop_gradients(viewport),
    ))
}

impl ProfilePager {
    pub fn tracking(&self) -> bool {
        self.tracking
    }

    pub fn offset(&self, now: Instant) -> f32 {
        match self.settle {
            Some(settle) => settle.value(now),
            None => self.offset,
        }
    }

    pub fn running(&self, now: Instant) -> bool {
        self.tracking || self.settle.is_some_and(|settle| settle.running(now))
    }

    pub fn neighbour_toward(&self, offset: f32) -> Option<&ProfileId> {
        if offset > 0.0 {
            self.next.as_ref()
        } else if offset < 0.0 {
            self.previous.as_ref()
        } else {
            None
        }
    }

    pub fn neighbour_spec(
        &self,
    ) -> Option<&(ProfileId, BackdropLayerSpec, gpui::BackdropGradients)> {
        self.neighbour.as_ref()
    }

    pub fn set_neighbour_spec(
        &mut self,
        spec: Option<(ProfileId, BackdropLayerSpec, gpui::BackdropGradients)>,
    ) {
        self.neighbour = spec;
    }

    pub fn begin(&mut self, state: &BrowserState, current: &ProfileId) {
        let (previous, next) = neighbours(state, current);
        self.previous = previous;
        self.next = next;
        self.tracking = true;
        self.horizontal = None;
        self.travel = 0.0;
        self.offset = 0.0;
        self.settle = None;
        self.neighbour = None;
    }

    pub fn precise(
        &mut self,
        phase: TouchPhase,
        dx: f32,
        dy: f32,
        width: f32,
        now: Instant,
    ) -> PagerOutcome {
        if !self.tracking {
            return PagerOutcome::None;
        }
        if self.horizontal.is_none() && (dx != 0.0 || dy != 0.0) {
            self.horizontal = Some(dx.abs() > dy.abs());
        }
        if self.horizontal != Some(true) {
            if phase == TouchPhase::Ended {
                self.tracking = false;
            }
            return PagerOutcome::None;
        }
        self.travel += dx;
        self.offset = page_offset(
            self.travel,
            width,
            self.previous.is_some(),
            self.next.is_some(),
        );
        if phase != TouchPhase::Ended {
            return PagerOutcome::Moved;
        }
        self.tracking = false;
        let commits = self.offset.abs() >= PAGER_COMMIT;
        let target = self
            .neighbour_toward(self.offset)
            .cloned()
            .filter(|_| commits);
        let from = match target {
            Some(_) => self.offset - self.offset.signum(),
            None => self.offset,
        };
        let mut settle = Motion::rest(from);
        settle.go(0.0, PAGER_SETTLE, Curve::EaseOut, now);
        self.settle = Some(settle);
        ardia_telemetry::counts::count("profile_pager_settles");
        if target.is_none() {
            ardia_telemetry::counts::count("profile_pager_settles_without_switch");
        }
        match target {
            Some(profile) => PagerOutcome::SwitchTo(profile),
            None => PagerOutcome::Moved,
        }
    }

    pub fn wheel(
        &mut self,
        state: &BrowserState,
        current: &ProfileId,
        dx: f32,
        now: Instant,
    ) -> PagerOutcome {
        let burst = &mut self.wheel;
        if burst
            .trigger
            .is_some_and(|at| now.saturating_duration_since(at) <= WHEEL_COOLDOWN)
        {
            return PagerOutcome::None;
        }
        if burst
            .last
            .is_none_or(|at| now.saturating_duration_since(at) > WHEEL_BURST)
        {
            burst.sum = 0.0;
        }
        burst.last = Some(now);
        burst.sum -= dx;
        if burst.sum.abs() <= WHEEL_THRESHOLD {
            return PagerOutcome::None;
        }
        let forward = burst.sum > 0.0;
        burst.sum = 0.0;
        burst.trigger = Some(now);
        let (previous, next) = neighbours(state, current);
        match if forward { next } else { previous } {
            Some(profile) => PagerOutcome::SwitchTo(profile),
            None => PagerOutcome::None,
        }
    }

    pub fn settled(&mut self, now: Instant) {
        if self.settle.is_some_and(|settle| !settle.running(now)) {
            self.settle = None;
            self.offset = 0.0;
            self.neighbour = None;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_page_follows_the_fingers_and_rubber_bands_past_the_ends() {
        assert_eq!(page_offset(-100.0, 200.0, true, true), 0.5);
        assert_eq!(page_offset(100.0, 200.0, true, true), -0.5);
        assert_eq!(page_offset(-400.0, 200.0, true, true), 1.0);
        let banded = page_offset(-100.0, 200.0, true, false);
        assert!(banded > 0.0 && banded < 0.5);
        let banded_back = page_offset(100.0, 200.0, false, true);
        assert!(banded_back < 0.0 && banded_back > -0.5);
    }

    #[test]
    fn a_half_page_swipe_commits_and_a_short_one_settles_back() {
        let now = Instant::now();
        let mut pager = ProfilePager {
            tracking: true,
            next: Some(ProfileId::new("b")),
            previous: Some(ProfileId::new("a")),
            ..ProfilePager::default()
        };
        assert_eq!(
            pager.precise(TouchPhase::Started, -10.0, 0.0, 200.0, now),
            PagerOutcome::Moved
        );
        pager.precise(TouchPhase::Moved, -100.0, 1.0, 200.0, now);
        assert_eq!(
            pager.precise(TouchPhase::Ended, 0.0, 0.0, 200.0, now),
            PagerOutcome::SwitchTo(ProfileId::new("b"))
        );
        assert!((pager.offset(now) + 0.45).abs() < 1e-4);
        pager.tracking = true;
        pager.travel = 0.0;
        pager.horizontal = None;
        pager.precise(TouchPhase::Moved, 20.0, 0.0, 200.0, now);
        assert_eq!(
            pager.precise(TouchPhase::Ended, 0.0, 0.0, 200.0, now),
            PagerOutcome::Moved
        );
        assert!(pager.offset(now) < 0.0);
        pager.settled(now + PAGER_SETTLE);
        assert_eq!(pager.offset(now + PAGER_SETTLE), 0.0);
    }

    #[test]
    fn vertical_scrolls_are_left_to_the_tab_list() {
        let now = Instant::now();
        let mut pager = ProfilePager {
            tracking: true,
            next: Some(ProfileId::new("b")),
            ..ProfilePager::default()
        };
        assert_eq!(
            pager.precise(TouchPhase::Moved, 2.0, -30.0, 200.0, now),
            PagerOutcome::None
        );
        assert_eq!(
            pager.precise(TouchPhase::Moved, -300.0, 0.0, 200.0, now),
            PagerOutcome::None
        );
    }
}
