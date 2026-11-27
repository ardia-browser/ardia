use std::sync::{Arc, OnceLock};
use std::time::Instant;

use ardia_state::{TabId, WindowId};
use gpui::{AnyElement, ScrollDelta, ScrollEvent, ScrollPhase, div, prelude::*};

use crate::host::UiHost;
use crate::window::layout::Rect;
use crate::window::page_overlays::HistoryDirection;
use crate::window::swipe_overlay::{PageSwipe, SwipePhase};

pub const START_DISTANCE: f32 = 4.0;
pub const START_DOMINANCE: f32 = 1.5;
pub const CANCEL_DOMINANCE: f32 = 2.0;
pub const MOMENTUM_START_WAIT: f64 = 0.1;
pub const DISCRETE_MIN: f32 = 0.5;
const SAMPLES: usize = 6;
const VELOCITY_WINDOW: f64 = 0.1;
const VELOCITY_MIN_SPAN: f64 = 0.004;

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct ScrollInput {
    pub phase: ScrollPhase,
    pub momentum: ScrollPhase,
    pub dx: f32,
    pub dy: f32,
    pub precise: bool,
    pub time: f64,
}

impl ScrollInput {
    pub fn of(event: &ScrollEvent, time: f64) -> Self {
        let (dx, dy, precise) = match event.delta {
            ScrollDelta::Pixels(delta) => (f32::from(delta.x), f32::from(delta.y), true),
            ScrollDelta::Lines(delta) => (delta.x, delta.y, false),
        };
        ScrollInput {
            phase: event.gesture_phase,
            momentum: event.momentum_phase,
            dx,
            dy,
            precise,
            time,
        }
    }
}

pub fn input_seconds() -> f64 {
    static START: OnceLock<Instant> = OnceLock::new();
    START.get_or_init(Instant::now).elapsed().as_secs_f64()
}

pub fn pane_at(panes: &[(TabId, Rect)], x: f32, y: f32) -> Option<&TabId> {
    panes
        .iter()
        .find(|(_, rect)| rect.contains(x, y))
        .map(|(tab, _)| tab)
}

pub fn swipe_area(
    host: Arc<dyn UiHost>,
    window: WindowId,
    panes: Vec<(TabId, Rect)>,
    content: AnyElement,
) -> AnyElement {
    div()
        .id("page-swipes")
        .absolute()
        .inset_0()
        .child(content)
        .on_scroll(move |event, _, cx| {
            let (x, y) = crate::scale::logical_point(event.position);
            let input = ScrollInput::of(event, input_seconds());
            if host.page_scroll(&window, pane_at(&panes, x, y), input) {
                cx.stop_propagation();
            }
        })
        .into_any_element()
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum RendererScroll {
    #[default]
    AwaitingBegin,
    AwaitingFirstUpdate,
    FirstUpdateUnconsumed,
    FirstUpdateConsumed,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct RendererState {
    pub scroll: RendererScroll,
    pub overscrolled: bool,
    pub overscroll_allowed: bool,
}

impl RendererState {
    pub fn acked(&mut self, begin: bool, consumed: bool) {
        if begin {
            if self.scroll == RendererScroll::AwaitingBegin {
                self.scroll = RendererScroll::AwaitingFirstUpdate;
            }
        } else if self.scroll == RendererScroll::AwaitingFirstUpdate {
            self.scroll = if consumed {
                RendererScroll::FirstUpdateConsumed
            } else {
                RendererScroll::FirstUpdateUnconsumed
            };
        }
    }

    pub fn overscrolled(&mut self, allowed: bool) {
        self.overscrolled = true;
        self.overscroll_allowed = allowed;
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Availability {
    pub back: bool,
    pub forward: bool,
    pub allows_vertical: bool,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SwipeBegin {
    pub window: WindowId,
    pub tab: TabId,
    pub page: Option<u64>,
}

pub trait SwipeLookup {
    fn begin(&mut self) -> Option<SwipeBegin>;
    fn system_swipe(&self) -> bool;
    fn take_swipes(&mut self, page: u64) -> bool;
    fn availability(&self, window: &WindowId, tab: &TabId) -> Availability;
    fn points_per_window_point(&self) -> f32 {
        1.0
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
enum State {
    #[default]
    Idle,
    Pending,
    Tracking,
    Ignored,
}

#[derive(Clone, Copy, Debug, Default, PartialEq)]
struct OwnedMomentum {
    ended_at: f64,
    flowing: bool,
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct Handled {
    pub swallow: bool,
    pub emitted: Option<(WindowId, PageSwipe)>,
}

impl Handled {
    fn pass() -> Self {
        Handled::default()
    }

    fn swallowed() -> Self {
        Handled {
            swallow: true,
            emitted: None,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Verdict {
    Track,
    Wait,
    Reject,
}

#[derive(Clone, Debug, Default)]
pub struct SwipeTracker {
    state: State,
    begin: Option<SwipeBegin>,
    renderer: Option<(u64, RendererState)>,
    dx: f32,
    dy: f32,
    direction: i8,
    time: f64,
    times: [f64; SAMPLES],
    deltas: [f32; SAMPLES],
    samples: usize,
    momentum: Option<OwnedMomentum>,
}

impl SwipeTracker {
    pub fn tracking(&self) -> bool {
        self.state == State::Tracking
    }

    pub fn renderer_acked(&mut self, view: u64, begin: bool, consumed: bool) {
        if let Some((key, state)) = self.renderer.as_mut()
            && *key == view
        {
            state.acked(begin, consumed);
        }
    }

    pub fn renderer_overscrolled(&mut self, view: u64, allowed: bool) {
        if let Some((key, state)) = self.renderer.as_mut()
            && *key == view
        {
            state.overscrolled(allowed);
        }
    }

    pub fn scroll(&mut self, input: ScrollInput, lookup: &mut impl SwipeLookup) -> Handled {
        if input.phase == ScrollPhase::None && input.momentum == ScrollPhase::None {
            return Handled::pass();
        }
        if !input.precise {
            return Handled::pass();
        }
        if input.phase == ScrollPhase::None {
            return if self.swallow_owned_momentum(input) {
                Handled::swallowed()
            } else {
                Handled::pass()
            };
        }
        self.momentum = None;
        if input.phase == ScrollPhase::MayBegin {
            return Handled::pass();
        }
        if input.phase == ScrollPhase::Began {
            self.start(lookup);
        }
        if !matches!(self.state, State::Pending | State::Tracking) {
            return Handled::pass();
        }
        self.dx += input.dx;
        self.dy += input.dy;
        self.time = input.time;
        self.sample(input);
        if matches!(input.phase, ScrollPhase::Ended | ScrollPhase::Cancelled) {
            if self.state != State::Tracking {
                self.state = State::Idle;
                return Handled::pass();
            }
            let phase = if input.phase == ScrollPhase::Ended {
                SwipePhase::Ended
            } else {
                SwipePhase::Cancelled
            };
            let emitted = self.emit(phase, self.release_velocity(input.time), lookup);
            self.state = State::Idle;
            if !self.begin.as_ref().is_some_and(|b| b.page.is_some()) {
                self.momentum = Some(OwnedMomentum {
                    ended_at: input.time,
                    flowing: false,
                });
            }
            return Handled {
                swallow: false,
                emitted,
            };
        }
        if self.state == State::Pending {
            match self.should_track(lookup) {
                Verdict::Track => {}
                Verdict::Wait => return Handled::pass(),
                Verdict::Reject => {
                    self.state = State::Ignored;
                    return Handled::pass();
                }
            }
            self.state = State::Tracking;
            return Handled {
                swallow: true,
                emitted: self.emit(SwipePhase::Began, 0.0, lookup),
            };
        }
        let allows_vertical = self
            .begin
            .as_ref()
            .is_some_and(|b| lookup.availability(&b.window, &b.tab).allows_vertical);
        if !allows_vertical && CANCEL_DOMINANCE * self.dx.abs() < self.dy.abs() {
            let emitted = self.emit(SwipePhase::Cancelled, 0.0, lookup);
            self.state = State::Ignored;
            return Handled {
                swallow: false,
                emitted,
            };
        }
        let velocity = self.release_velocity(input.time);
        Handled {
            swallow: true,
            emitted: self.emit(SwipePhase::Changed, velocity, lookup),
        }
    }

    pub fn discrete(
        &mut self,
        dx: f32,
        lookup: &mut impl SwipeLookup,
    ) -> Option<(WindowId, PageSwipe)> {
        if dx.abs() < DISCRETE_MIN {
            return None;
        }
        let begin = lookup.begin()?;
        let back = dx > 0.0;
        let availability = lookup.availability(&begin.window, &begin.tab);
        if !(if back {
            availability.back
        } else {
            availability.forward
        }) {
            return None;
        }
        Some((
            begin.window,
            PageSwipe {
                tab: begin.tab,
                phase: SwipePhase::Swipe,
                direction: if back {
                    HistoryDirection::Back
                } else {
                    HistoryDirection::Forward
                },
                distance: 0.0,
                dy: 0.0,
                velocity: 0.0,
            },
        ))
    }

    fn start(&mut self, lookup: &mut impl SwipeLookup) {
        *self = SwipeTracker::default();
        let Some(begin) = lookup.begin() else {
            self.state = State::Ignored;
            return;
        };
        if !lookup.system_swipe() {
            self.state = State::Ignored;
            return;
        }
        self.state = State::Pending;
        self.renderer = begin
            .page
            .filter(|page| lookup.take_swipes(*page))
            .map(|page| (page, RendererState::default()));
        self.begin = Some(begin);
    }

    pub fn verdict(
        dx: f32,
        dy: f32,
        renderer: Option<RendererState>,
        availability: Availability,
    ) -> (Verdict, i8) {
        if dy.abs() >= START_DISTANCE && CANCEL_DOMINANCE * dx.abs() < dy.abs() {
            return (Verdict::Reject, 0);
        }
        if dx.abs() < START_DISTANCE || START_DOMINANCE * dx.abs() < dy.abs() {
            return (Verdict::Wait, 0);
        }
        let direction: i8 = if dx > 0.0 { 1 } else { -1 };
        if let Some(renderer) = renderer {
            match renderer.scroll {
                RendererScroll::FirstUpdateConsumed => return (Verdict::Reject, direction),
                RendererScroll::FirstUpdateUnconsumed => {}
                RendererScroll::AwaitingBegin | RendererScroll::AwaitingFirstUpdate => {
                    return (Verdict::Wait, direction);
                }
            }
            if !renderer.overscrolled {
                return (Verdict::Wait, direction);
            }
            if !renderer.overscroll_allowed {
                return (Verdict::Reject, direction);
            }
        }
        let available = if direction > 0 {
            availability.back
        } else {
            availability.forward
        };
        if !available {
            return (Verdict::Reject, direction);
        }
        (Verdict::Track, direction)
    }

    fn should_track(&mut self, lookup: &impl SwipeLookup) -> Verdict {
        let Some(begin) = self.begin.as_ref() else {
            return Verdict::Reject;
        };
        let availability = lookup.availability(&begin.window, &begin.tab);
        let (verdict, direction) = Self::verdict(
            self.dx,
            self.dy,
            self.renderer.map(|(_, state)| state),
            availability,
        );
        if verdict == Verdict::Track {
            self.direction = direction;
        }
        verdict
    }

    fn emit(
        &self,
        phase: SwipePhase,
        velocity: f32,
        lookup: &impl SwipeLookup,
    ) -> Option<(WindowId, PageSwipe)> {
        let begin = self.begin.as_ref()?;
        let scale = lookup.points_per_window_point();
        let direction = f32::from(self.direction);
        Some((
            begin.window.clone(),
            PageSwipe {
                tab: begin.tab.clone(),
                phase,
                direction: if self.direction > 0 {
                    HistoryDirection::Back
                } else {
                    HistoryDirection::Forward
                },
                distance: self.dx * direction * scale,
                dy: self.dy * scale,
                velocity: velocity * direction * scale,
            },
        ))
    }

    fn sample(&mut self, input: ScrollInput) {
        let slot = self.samples % SAMPLES;
        self.samples += 1;
        self.times[slot] = input.time;
        self.deltas[slot] = input.dx;
    }

    fn release_velocity(&self, now: f64) -> f32 {
        let count = self.samples.min(SAMPLES);
        let mut sum = 0.0;
        let mut oldest = now;
        for k in 0..count {
            if now - self.times[k] > VELOCITY_WINDOW {
                continue;
            }
            sum += self.deltas[k];
            oldest = oldest.min(self.times[k]);
        }
        let span = now - oldest;
        if span > VELOCITY_MIN_SPAN {
            (f64::from(sum) / span) as f32
        } else {
            0.0
        }
    }

    fn swallow_owned_momentum(&mut self, input: ScrollInput) -> bool {
        let Some(mut momentum) = self.momentum else {
            return false;
        };
        if !momentum.flowing {
            momentum.flowing = input.momentum == ScrollPhase::Began
                && input.time - momentum.ended_at <= MOMENTUM_START_WAIT;
            if !momentum.flowing {
                self.momentum = None;
                return false;
            }
        }
        self.momentum = if matches!(input.momentum, ScrollPhase::Ended | ScrollPhase::Cancelled) {
            None
        } else {
            Some(momentum)
        };
        true
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Lookup {
        begin: Option<SwipeBegin>,
        system: bool,
        availability: Availability,
        scale: f32,
        begins: usize,
        taken: Vec<u64>,
    }

    impl Lookup {
        fn page(renderer: Option<u64>) -> Self {
            Lookup {
                begin: Some(SwipeBegin {
                    window: WindowId::new("w"),
                    tab: TabId::new("t"),
                    page: renderer,
                }),
                system: true,
                availability: Availability {
                    back: true,
                    forward: false,
                    allows_vertical: false,
                },
                scale: 1.0,
                begins: 0,
                taken: Vec::new(),
            }
        }
    }

    impl SwipeLookup for Lookup {
        fn begin(&mut self) -> Option<SwipeBegin> {
            self.begins += 1;
            self.begin.clone()
        }

        fn system_swipe(&self) -> bool {
            self.system
        }

        fn take_swipes(&mut self, page: u64) -> bool {
            self.taken.push(page);
            true
        }

        fn availability(&self, _: &WindowId, _: &TabId) -> Availability {
            self.availability
        }

        fn points_per_window_point(&self) -> f32 {
            self.scale
        }
    }

    fn step(phase: ScrollPhase, dx: f32, dy: f32, time: f64) -> ScrollInput {
        ScrollInput {
            phase,
            momentum: ScrollPhase::None,
            dx,
            dy,
            precise: true,
            time,
        }
    }

    fn momentum(phase: ScrollPhase, time: f64) -> ScrollInput {
        ScrollInput {
            phase: ScrollPhase::None,
            momentum: phase,
            dx: 3.0,
            dy: 0.0,
            precise: true,
            time,
        }
    }

    fn phases(out: &[Handled]) -> Vec<SwipePhase> {
        out.iter()
            .filter_map(|h| h.emitted.as_ref().map(|(_, s)| s.phase))
            .collect()
    }

    #[test]
    fn a_horizontal_swipe_over_gpui_content_tracks_from_four_points() {
        let mut lookup = Lookup::page(None);
        let mut tracker = SwipeTracker::default();
        let began = tracker.scroll(step(ScrollPhase::Began, 2.0, 0.0, 0.0), &mut lookup);
        assert_eq!(began, Handled::pass());
        let tracked = tracker.scroll(step(ScrollPhase::Changed, 3.0, 0.5, 0.01), &mut lookup);
        assert!(tracked.swallow);
        let (window, swipe) = tracked.emitted.unwrap();
        assert_eq!(window, WindowId::new("w"));
        assert_eq!(swipe.phase, SwipePhase::Began);
        assert_eq!(swipe.direction, HistoryDirection::Back);
        assert_eq!(swipe.distance, 5.0);
        let moved = tracker.scroll(step(ScrollPhase::Changed, 70.0, 0.0, 0.02), &mut lookup);
        assert_eq!(moved.emitted.as_ref().unwrap().1.distance, 75.0);
        assert!(moved.emitted.unwrap().1.velocity > 0.0);
        let ended = tracker.scroll(step(ScrollPhase::Ended, 0.0, 0.0, 0.03), &mut lookup);
        assert!(!ended.swallow);
        assert_eq!(ended.emitted.unwrap().1.phase, SwipePhase::Ended);
    }

    #[test]
    fn a_vertical_scroll_is_never_a_swipe() {
        let mut lookup = Lookup::page(None);
        let mut tracker = SwipeTracker::default();
        let out: Vec<Handled> = [
            step(ScrollPhase::Began, 0.0, -3.0, 0.0),
            step(ScrollPhase::Changed, 1.0, -6.0, 0.01),
            step(ScrollPhase::Changed, 40.0, 0.0, 0.02),
            step(ScrollPhase::Ended, 0.0, 0.0, 0.03),
        ]
        .into_iter()
        .map(|s| tracker.scroll(s, &mut lookup))
        .collect();
        assert!(phases(&out).is_empty());
        assert!(out.iter().all(|h| !h.swallow));
    }

    #[test]
    fn a_diagonal_start_waits_until_it_turns_horizontal() {
        assert_eq!(
            SwipeTracker::verdict(3.0, 3.0, None, Lookup::page(None).availability).0,
            Verdict::Wait
        );
        assert_eq!(
            SwipeTracker::verdict(5.0, 3.5, None, Lookup::page(None).availability).0,
            Verdict::Track
        );
        assert_eq!(
            SwipeTracker::verdict(5.0, 8.0, None, Lookup::page(None).availability).0,
            Verdict::Wait
        );
        assert_eq!(
            SwipeTracker::verdict(1.0, 4.0, None, Lookup::page(None).availability).0,
            Verdict::Reject
        );
    }

    #[test]
    fn turning_vertical_mid_swipe_cancels_unless_the_list_is_open() {
        let mut lookup = Lookup::page(None);
        let mut tracker = SwipeTracker::default();
        tracker.scroll(step(ScrollPhase::Began, 2.0, 0.0, 0.0), &mut lookup);
        let began = tracker.scroll(step(ScrollPhase::Changed, 10.0, 0.0, 0.01), &mut lookup);
        assert_eq!(began.emitted.unwrap().1.phase, SwipePhase::Began);
        let turned = tracker.scroll(step(ScrollPhase::Changed, 0.0, 50.0, 0.02), &mut lookup);
        assert_eq!(turned.emitted.unwrap().1.phase, SwipePhase::Cancelled);
        assert!(!turned.swallow);
        assert!(
            tracker
                .scroll(step(ScrollPhase::Changed, 30.0, 0.0, 0.03), &mut lookup)
                .emitted
                .is_none()
        );

        lookup.availability.allows_vertical = true;
        tracker.scroll(step(ScrollPhase::Began, 10.0, 0.0, 1.0), &mut lookup);
        tracker.scroll(step(ScrollPhase::Changed, 80.0, 0.0, 1.01), &mut lookup);
        let picking = tracker.scroll(step(ScrollPhase::Changed, 0.0, 160.0, 1.02), &mut lookup);
        let (_, swipe) = picking.emitted.unwrap();
        assert_eq!(swipe.phase, SwipePhase::Changed);
        assert_eq!(swipe.dy, 160.0);
        assert!(picking.swallow);
    }

    #[test]
    fn an_unavailable_direction_is_left_to_the_page() {
        let mut lookup = Lookup::page(None);
        let mut tracker = SwipeTracker::default();
        tracker.scroll(step(ScrollPhase::Began, -10.0, 0.0, 0.0), &mut lookup);
        let out = tracker.scroll(step(ScrollPhase::Changed, -10.0, 0.0, 0.01), &mut lookup);
        assert_eq!(out, Handled::pass());
        lookup.availability.forward = true;
        tracker.scroll(step(ScrollPhase::Began, -10.0, 0.0, 1.0), &mut lookup);
        let out = tracker.scroll(step(ScrollPhase::Changed, -10.0, 0.0, 1.01), &mut lookup);
        assert_eq!(out.emitted.unwrap().1.direction, HistoryDirection::Forward);
    }

    #[test]
    fn the_page_keeps_the_swipe_until_it_reports_an_unconsumed_overscroll() {
        let mut lookup = Lookup::page(Some(7));
        let mut tracker = SwipeTracker::default();
        tracker.scroll(step(ScrollPhase::Began, 10.0, 0.0, 0.0), &mut lookup);
        assert_eq!(
            tracker.scroll(step(ScrollPhase::Changed, 10.0, 0.0, 0.01), &mut lookup),
            Handled::pass()
        );
        tracker.renderer_acked(7, true, true);
        tracker.renderer_acked(8, false, true);
        tracker.renderer_acked(7, false, false);
        assert_eq!(
            tracker.scroll(step(ScrollPhase::Changed, 5.0, 0.0, 0.02), &mut lookup),
            Handled::pass()
        );
        tracker.renderer_overscrolled(7, true);
        let out = tracker.scroll(step(ScrollPhase::Changed, 5.0, 0.0, 0.03), &mut lookup);
        assert_eq!(lookup.taken, vec![7]);
        assert!(out.swallow);
        assert_eq!(out.emitted.unwrap().1.distance, 30.0);
    }

    #[test]
    fn a_page_that_scrolls_sideways_or_forbids_overscroll_keeps_the_gesture() {
        let mut lookup = Lookup::page(Some(7));
        let mut tracker = SwipeTracker::default();
        tracker.scroll(step(ScrollPhase::Began, 10.0, 0.0, 0.0), &mut lookup);
        tracker.renderer_acked(7, true, false);
        tracker.renderer_acked(7, false, true);
        tracker.renderer_overscrolled(7, true);
        let out: Vec<Handled> = (1..5)
            .map(|i| {
                tracker.scroll(
                    step(ScrollPhase::Changed, 20.0, 0.0, f64::from(i) * 0.01),
                    &mut lookup,
                )
            })
            .collect();
        assert!(phases(&out).is_empty());

        tracker.scroll(step(ScrollPhase::Began, 10.0, 0.0, 1.0), &mut lookup);
        tracker.renderer_acked(7, true, false);
        tracker.renderer_acked(7, false, false);
        tracker.renderer_overscrolled(7, false);
        let out = tracker.scroll(step(ScrollPhase::Changed, 10.0, 0.0, 1.01), &mut lookup);
        assert_eq!(out, Handled::pass());
    }

    #[test]
    fn renderer_state_follows_the_first_update_only() {
        let mut state = RendererState::default();
        state.acked(false, true);
        assert_eq!(state.scroll, RendererScroll::AwaitingBegin);
        state.acked(true, false);
        state.acked(false, false);
        state.acked(false, true);
        assert_eq!(state.scroll, RendererScroll::FirstUpdateUnconsumed);
    }

    #[test]
    fn swipes_need_the_system_setting_and_precise_phased_deltas() {
        let mut lookup = Lookup::page(None);
        lookup.system = false;
        let mut tracker = SwipeTracker::default();
        tracker.scroll(step(ScrollPhase::Began, 10.0, 0.0, 0.0), &mut lookup);
        assert_eq!(
            tracker.scroll(step(ScrollPhase::Changed, 10.0, 0.0, 0.01), &mut lookup),
            Handled::pass()
        );
        lookup.system = true;
        let wheel = step(ScrollPhase::None, 40.0, 0.0, 1.0);
        assert_eq!(tracker.scroll(wheel, &mut lookup), Handled::pass());
        let mut coarse = step(ScrollPhase::Began, 40.0, 0.0, 1.0);
        coarse.precise = false;
        assert_eq!(tracker.scroll(coarse, &mut lookup), Handled::pass());
        assert_eq!(lookup.begins, 1);
    }

    #[test]
    fn momentum_after_a_swipe_off_the_page_is_swallowed_once_it_flows() {
        let mut lookup = Lookup::page(None);
        let mut tracker = SwipeTracker::default();
        tracker.scroll(step(ScrollPhase::Began, 10.0, 0.0, 0.0), &mut lookup);
        tracker.scroll(step(ScrollPhase::Changed, 90.0, 0.0, 0.01), &mut lookup);
        tracker.scroll(step(ScrollPhase::Ended, 0.0, 0.0, 0.02), &mut lookup);
        assert!(
            tracker
                .scroll(momentum(ScrollPhase::Began, 0.05), &mut lookup)
                .swallow
        );
        assert!(
            tracker
                .scroll(momentum(ScrollPhase::Changed, 0.06), &mut lookup)
                .swallow
        );
        assert!(
            tracker
                .scroll(momentum(ScrollPhase::Ended, 0.07), &mut lookup)
                .swallow
        );
        assert!(
            !tracker
                .scroll(momentum(ScrollPhase::Changed, 0.08), &mut lookup)
                .swallow
        );

        tracker.scroll(step(ScrollPhase::Began, 10.0, 0.0, 1.0), &mut lookup);
        tracker.scroll(step(ScrollPhase::Changed, 90.0, 0.0, 1.01), &mut lookup);
        tracker.scroll(step(ScrollPhase::Ended, 0.0, 0.0, 1.02), &mut lookup);
        assert!(
            !tracker
                .scroll(momentum(ScrollPhase::Began, 1.5), &mut lookup)
                .swallow
        );
    }

    #[test]
    fn momentum_after_a_page_swipe_goes_to_the_page() {
        let mut lookup = Lookup::page(Some(1));
        let mut tracker = SwipeTracker::default();
        tracker.scroll(step(ScrollPhase::Began, 10.0, 0.0, 0.0), &mut lookup);
        tracker.renderer_acked(1, true, false);
        tracker.renderer_acked(1, false, false);
        tracker.renderer_overscrolled(1, true);
        tracker.scroll(step(ScrollPhase::Changed, 90.0, 0.0, 0.01), &mut lookup);
        tracker.scroll(step(ScrollPhase::Ended, 0.0, 0.0, 0.02), &mut lookup);
        assert!(
            !tracker
                .scroll(momentum(ScrollPhase::Began, 0.03), &mut lookup)
                .swallow
        );
    }

    #[test]
    fn an_untracked_end_resets_and_distances_follow_the_interface_scale() {
        let mut lookup = Lookup::page(None);
        lookup.scale = 0.5;
        let mut tracker = SwipeTracker::default();
        tracker.scroll(step(ScrollPhase::Began, 1.0, 0.0, 0.0), &mut lookup);
        assert_eq!(
            tracker.scroll(step(ScrollPhase::Ended, 1.0, 0.0, 0.01), &mut lookup),
            Handled::pass()
        );
        assert!(!tracker.tracking());
        tracker.scroll(step(ScrollPhase::Began, 10.0, 0.0, 1.0), &mut lookup);
        let out = tracker.scroll(step(ScrollPhase::Changed, 10.0, 2.0, 1.01), &mut lookup);
        let (_, swipe) = out.emitted.unwrap();
        assert_eq!(swipe.distance, 10.0);
        assert_eq!(swipe.dy, 1.0);
    }

    #[test]
    fn a_discrete_swipe_needs_history_that_way() {
        let mut lookup = Lookup::page(None);
        let mut tracker = SwipeTracker::default();
        assert!(tracker.discrete(0.2, &mut lookup).is_none());
        let (_, swipe) = tracker.discrete(1.0, &mut lookup).unwrap();
        assert_eq!(swipe.phase, SwipePhase::Swipe);
        assert_eq!(swipe.direction, HistoryDirection::Back);
        assert!(tracker.discrete(-1.0, &mut lookup).is_none());
    }

    #[test]
    fn a_gpui_scroll_event_keeps_its_phases() {
        let event = ScrollEvent {
            delta: ScrollDelta::Pixels(gpui::point(gpui::px(6.0), gpui::px(-2.0))),
            gesture_phase: ScrollPhase::Changed,
            ..ScrollEvent::default()
        };
        let input = ScrollInput::of(&event, 2.0);
        assert_eq!(input.phase, ScrollPhase::Changed);
        assert_eq!((input.dx, input.dy, input.precise), (6.0, -2.0, true));
        let lines = ScrollEvent {
            delta: ScrollDelta::Lines(gpui::point(1.0, 0.0)),
            ..ScrollEvent::default()
        };
        assert!(!ScrollInput::of(&lines, 0.0).precise);
    }
}
