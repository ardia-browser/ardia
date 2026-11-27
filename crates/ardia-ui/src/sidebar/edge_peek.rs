use std::cell::Cell;
use std::rc::Rc;
use std::sync::Arc;
use std::time::{Duration, Instant};

use ardia_theme::layout::{PEEK_EDGE_STRIP, TAB_DRAG_EDGE_STRIP};
use gpui::{
    AnyElement, DispatchPhase, IntoElement, MouseExitEvent, MouseMoveEvent, Styled, canvas,
};

use crate::msg::{Emit, Msg};

pub use crate::sidebar::tab_strip::PEEK_CLOSE_DELAY;

pub const EDGE_REACH: f32 = 24.0;

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct SidebarEdgeWatch {
    pub hold: f32,
    pub trailing: bool,
    pub while_pressed: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ScreenEdge {
    Crossed,
    Returned,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct SidebarEdgeEvent {
    pub over: bool,
    pub point: [f32; 2],
    pub screen_edge: Option<ScreenEdge>,
}

pub type SidebarEdgeSink = Arc<dyn Fn(SidebarEdgeEvent) + Send + Sync>;

pub fn edge_strip_over_page(inset: f32) -> bool {
    inset < PEEK_EDGE_STRIP
}

pub fn edge_reveal_allowed(
    watches_edge: bool,
    has_sidebar: bool,
    page_holds_pointer: bool,
) -> bool {
    watches_edge && has_sidebar && !page_holds_pointer
}

pub fn reveal_band(dragging_tab: bool) -> f32 {
    if dragging_tab {
        TAB_DRAG_EDGE_STRIP
    } else {
        PEEK_EDGE_STRIP
    }
}

pub fn edge_watch_width(holding: bool, dragging_tab: bool, hold_width: f32, inset: f32) -> f32 {
    if holding {
        hold_width
    } else if dragging_tab {
        TAB_DRAG_EDGE_STRIP
    } else if edge_strip_over_page(inset) {
        PEEK_EDGE_STRIP
    } else {
        0.0
    }
}

pub fn at_reveal_edge(x: f32, trailing: bool, window_width: f32, band: f32) -> bool {
    if trailing {
        x >= window_width - band
    } else {
        x < band
    }
}

pub fn edge_event_reveals(
    holding: bool,
    x: f32,
    trailing: bool,
    window_width: f32,
    band: f32,
) -> bool {
    holding || at_reveal_edge(x, trailing, window_width, band)
}

pub fn close_delay(crossed: bool) -> Duration {
    if crossed {
        Duration::ZERO
    } else {
        PEEK_CLOSE_DELAY
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct PointerWatch {
    pub holding: bool,
    pub band: f32,
    pub hold_width: f32,
    pub trailing: bool,
    pub width: f32,
    pub height: f32,
}

impl PointerWatch {
    pub fn over(&self, x: f32, y: f32) -> bool {
        let slack = if self.holding { EDGE_REACH } else { 0.0 };
        if y < -slack || y >= self.height + slack {
            return false;
        }
        let column = if self.holding {
            self.hold_width
        } else {
            self.band
        };
        if self.trailing {
            x >= self.width - column && x < self.width + EDGE_REACH
        } else {
            x >= -EDGE_REACH && x < column
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum EdgeSource {
    Strip,
    Native,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct EdgeArm {
    pub armed: bool,
    pub strip: bool,
    pub native: bool,
}

impl EdgeArm {
    pub const ARMED: EdgeArm = EdgeArm {
        armed: true,
        strip: false,
        native: false,
    };
    pub const DISARMED: EdgeArm = EdgeArm {
        armed: false,
        strip: false,
        native: false,
    };

    pub fn seen(self, source: EdgeSource, over: bool) -> EdgeArm {
        let mut next = self;
        match source {
            EdgeSource::Strip => next.strip = over,
            EdgeSource::Native => next.native = over,
        }
        if !next.strip && !next.native {
            next.armed = true;
        }
        next
    }

    pub fn closed(self) -> EdgeArm {
        EdgeArm {
            armed: !self.strip && !self.native,
            ..self
        }
    }
}

impl Default for EdgeArm {
    fn default() -> Self {
        EdgeArm::ARMED
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct PeekGate {
    out: bool,
    hide_at: Option<Instant>,
    held_back: bool,
    waiting_for_focus: bool,
}

impl PeekGate {
    pub fn is_out(&self) -> bool {
        self.out
    }

    pub fn waiting_for_focus(&self) -> bool {
        self.waiting_for_focus
    }

    pub fn hide_at(&self) -> Option<Instant> {
        self.hide_at
    }

    pub fn show(&mut self, enabled: bool, app_in_front: bool) -> bool {
        self.hide_at = None;
        self.held_back = false;
        if !enabled {
            return false;
        }
        if !self.out && !app_in_front {
            self.waiting_for_focus = true;
            return false;
        }
        self.waiting_for_focus = false;
        let opened = !self.out;
        self.out = true;
        opened
    }

    pub fn cancel_pending(&mut self, pointer_still_at_edge: bool) {
        self.waiting_for_focus &= pointer_still_at_edge;
    }

    pub fn hide(&mut self, now: Instant, crossed: bool) -> Option<Instant> {
        self.hide_at = None;
        if !self.out {
            self.cancel_pending(false);
            return None;
        }
        let at = now + close_delay(crossed);
        self.hide_at = Some(at);
        Some(at)
    }

    pub fn due(&mut self, now: Instant, held: bool) -> bool {
        let Some(at) = self.hide_at else {
            return false;
        };
        if now < at {
            return false;
        }
        self.hide_at = None;
        self.held_back = held;
        if held {
            return false;
        }
        self.out = false;
        true
    }

    pub fn recheck(&mut self, now: Instant, held: bool) -> Option<Instant> {
        if !self.held_back || held {
            return None;
        }
        self.held_back = false;
        self.hide(now, false)
    }

    pub fn focus_gained(&mut self, enabled: bool) -> bool {
        self.waiting_for_focus && self.show(enabled, true)
    }

    pub fn reset(&mut self) {
        *self = PeekGate::default();
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct EdgeOutcome {
    pub opened: bool,
    pub closed: bool,
    pub hide_at: Option<Instant>,
    pub crossed: bool,
}

#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct EdgePeek {
    pub gate: PeekGate,
    pub arm: EdgeArm,
    pub strip_over: bool,
    pub native_over: bool,
}

impl EdgePeek {
    pub fn pointer_at_edge(&self) -> bool {
        self.strip_over || self.native_over
    }

    fn reveal(&mut self, enabled: bool, app_in_front: bool) -> EdgeOutcome {
        if !self.arm.armed {
            ardia_telemetry::counts::count("sidebar_peek_reveals_held_back");
        }
        EdgeOutcome {
            opened: self.arm.armed && self.gate.show(enabled, app_in_front),
            ..EdgeOutcome::default()
        }
    }

    pub fn strip(
        &mut self,
        over: bool,
        enabled: bool,
        app_in_front: bool,
        now: Instant,
    ) -> EdgeOutcome {
        let was = self.strip_over;
        self.strip_over = over;
        self.arm = self.arm.seen(EdgeSource::Strip, over);
        if over {
            return self.reveal(enabled, app_in_front);
        }
        if !self.gate.is_out() {
            self.gate.cancel_pending(self.native_over);
            return EdgeOutcome::default();
        }
        if self.native_over || !was {
            return EdgeOutcome::default();
        }
        EdgeOutcome {
            hide_at: self.gate.hide(now, false),
            ..EdgeOutcome::default()
        }
    }

    pub fn native(
        &mut self,
        event: SidebarEdgeEvent,
        reveals: bool,
        enabled: bool,
        app_in_front: bool,
        now: Instant,
    ) -> Option<EdgeOutcome> {
        if event.over && event.screen_edge != Some(ScreenEdge::Returned) && !reveals {
            return None;
        }
        let crossed = event.screen_edge == Some(ScreenEdge::Crossed);
        self.native_over = event.over;
        self.arm = self.arm.seen(EdgeSource::Native, event.over);
        if crossed {
            self.strip_over = false;
            self.arm = self.arm.seen(EdgeSource::Strip, false);
        }
        if event.over {
            return Some(EdgeOutcome {
                crossed,
                ..self.reveal(enabled, app_in_front)
            });
        }
        if self.strip_over {
            return Some(EdgeOutcome::default());
        }
        Some(EdgeOutcome {
            hide_at: self.gate.hide(now, crossed),
            crossed,
            ..EdgeOutcome::default()
        })
    }

    pub fn due(&mut self, now: Instant, held: bool) -> bool {
        let closed = self.gate.due(now, held);
        if closed {
            self.arm = self.arm.closed();
        }
        closed
    }

    pub fn disable(&mut self) -> bool {
        let was_out = self.gate.is_out();
        self.gate.reset();
        if was_out {
            self.arm = self.arm.closed();
        }
        was_out
    }

    pub fn docked(&mut self) {
        self.gate.reset();
    }

    pub fn undocked(&mut self) {
        self.arm = EdgeArm::DISARMED;
        self.strip_over = false;
        self.native_over = false;
    }
}

pub fn edge_watch(emit: &Emit, watch: PointerWatch, reported: bool, rearm: bool) -> AnyElement {
    let emit = emit.clone();
    canvas(
        |_, _, _| {},
        move |_, _, window, _| {
            let last = Rc::new(Cell::new((reported, rearm)));
            let moved = (emit.clone(), Rc::clone(&last));
            window.on_mouse_event(move |event: &MouseMoveEvent, phase, window, cx| {
                if phase != DispatchPhase::Capture {
                    return;
                }
                let (x, y) = crate::scale::logical_point(event.position);
                let over = watch.over(x, y);
                let (was, rearm) = moved.1.get();
                if over != was || (rearm && !over) {
                    moved.1.set((over, false));
                    moved.0.send(Msg::EdgeHover(over), window, cx);
                }
            });
            let exited = (emit.clone(), last);
            window.on_mouse_event(move |_: &MouseExitEvent, phase, window, cx| {
                let (was, rearm) = exited.1.get();
                if phase == DispatchPhase::Capture && (was || rearm) {
                    exited.1.set((false, false));
                    exited.0.send(Msg::EdgeHover(false), window, cx);
                }
            });
        },
    )
    .absolute()
    .size_0()
    .into_any_element()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_page_holding_the_pointer_keeps_the_sidebar_from_peeking() {
        assert!(edge_reveal_allowed(true, true, false));
        assert!(!edge_reveal_allowed(true, true, true));
        assert!(!edge_reveal_allowed(false, true, false));
        assert!(!edge_reveal_allowed(true, false, false));
    }

    fn watch(holding: bool, band: f32) -> PointerWatch {
        PointerWatch {
            holding,
            band,
            hold_width: 239.0,
            trailing: false,
            width: 1000.0,
            height: 700.0,
        }
    }

    #[test]
    fn the_reveal_band_is_three_points_and_eight_while_dragging_a_tab() {
        assert_eq!(reveal_band(false), 3.0);
        assert_eq!(reveal_band(true), 8.0);
        let rest = watch(false, reveal_band(false));
        assert!(rest.over(0.0, 300.0));
        assert!(rest.over(2.9, 300.0));
        assert!(!rest.over(3.0, 300.0));
        assert!(!rest.over(5.0, 300.0));
        assert!(rest.over(-24.0, 300.0));
        assert!(!rest.over(-24.5, 300.0));
        let dragging = watch(false, reveal_band(true));
        assert!(dragging.over(7.0, 300.0));
        assert!(!dragging.over(8.0, 300.0));
        let trailing = PointerWatch {
            trailing: true,
            ..rest
        };
        assert!(trailing.over(997.0, 10.0));
        assert!(!trailing.over(996.5, 10.0));
        assert!(trailing.over(1020.0, 10.0));
    }

    #[test]
    fn the_hold_column_spans_the_peek_plus_forty_points() {
        let frame = ardia_theme::layout::PageFrame::default_window(9.0);
        assert_eq!(frame.peek_hold_width(190.0), 9.0 + 190.0 + 40.0);
        let held = watch(true, 3.0);
        assert!(held.over(238.0, 300.0));
        assert!(!held.over(239.0, 300.0));
        assert!(held.over(100.0, -24.0));
        assert!(!held.over(100.0, -24.5));
        assert!(held.over(100.0, 723.0));
        assert!(!held.over(100.0, 724.0));
        assert!(!watch(false, 3.0).over(1.0, -1.0));
    }

    #[test]
    fn the_native_watch_width_follows_the_old_dock() {
        assert_eq!(edge_watch_width(true, false, 239.0, 9.0), 239.0);
        assert_eq!(edge_watch_width(false, true, 239.0, 9.0), 8.0);
        assert_eq!(edge_watch_width(false, false, 239.0, 9.0), 0.0);
        assert_eq!(edge_watch_width(false, false, 239.0, 3.0), 0.0);
        assert_eq!(edge_watch_width(false, false, 239.0, 2.0), 3.0);
        assert_eq!(edge_watch_width(false, false, 239.0, 0.0), 3.0);
        assert!(edge_event_reveals(true, 500.0, false, 1000.0, 3.0));
        assert!(edge_event_reveals(false, 2.0, false, 1000.0, 3.0));
        assert!(!edge_event_reveals(false, 3.0, false, 1000.0, 3.0));
        assert!(edge_event_reveals(false, -10.0, false, 1000.0, 3.0));
        assert!(edge_event_reveals(false, 997.0, true, 1000.0, 3.0));
    }

    #[test]
    fn the_close_waits_two_hundred_ms_unless_the_screen_edge_was_crossed() {
        assert_eq!(close_delay(false), Duration::from_millis(200));
        assert_eq!(close_delay(true), Duration::ZERO);
        let now = Instant::now();
        let mut gate = PeekGate::default();
        assert!(gate.show(true, true));
        let at = gate.hide(now, false).expect("timer");
        assert_eq!(at - now, Duration::from_millis(200));
        assert!(!gate.due(now + Duration::from_millis(199), false));
        assert!(gate.is_out());
        assert!(gate.due(now + Duration::from_millis(200), false));
        assert!(!gate.is_out());
        assert!(gate.show(true, true));
        assert_eq!(gate.hide(now, true), Some(now));
        assert!(gate.due(now, false));
    }

    #[test]
    fn coming_back_before_the_delay_keeps_the_peek() {
        let now = Instant::now();
        let mut gate = PeekGate::default();
        gate.show(true, true);
        gate.hide(now, false);
        assert!(!gate.show(true, true));
        assert_eq!(gate.hide_at(), None);
        assert!(!gate.due(now + Duration::from_secs(1), false));
        assert!(gate.is_out());
    }

    #[test]
    fn a_held_peek_closes_once_the_hold_lets_go() {
        let now = Instant::now();
        let mut gate = PeekGate::default();
        gate.show(true, true);
        gate.hide(now, false);
        assert!(!gate.due(now + PEEK_CLOSE_DELAY, true));
        assert!(gate.is_out());
        assert_eq!(gate.recheck(now, true), None);
        let at = gate.recheck(now, false).expect("hides again");
        assert!(gate.due(at, false));
    }

    #[test]
    fn the_peek_waits_for_app_focus() {
        let mut gate = PeekGate::default();
        assert!(!gate.show(true, false));
        assert!(gate.waiting_for_focus());
        assert!(gate.focus_gained(true));
        assert!(gate.is_out());
        let mut left = PeekGate::default();
        left.show(true, false);
        left.cancel_pending(false);
        assert!(!left.focus_gained(true));
        let mut stayed = PeekGate::default();
        stayed.show(true, false);
        stayed.cancel_pending(true);
        assert!(stayed.focus_gained(true));
        let mut disabled = PeekGate::default();
        assert!(!disabled.show(false, true));
        assert!(!disabled.is_out());
    }

    #[test]
    fn the_edge_rearms_only_after_the_pointer_leaves() {
        assert_eq!(
            EdgeArm::DISARMED.seen(EdgeSource::Strip, true),
            EdgeArm {
                armed: false,
                strip: true,
                native: false
            }
        );
        assert!(
            EdgeArm::DISARMED
                .seen(EdgeSource::Strip, true)
                .seen(EdgeSource::Strip, false)
                .armed
        );
        let both = EdgeArm::ARMED
            .seen(EdgeSource::Strip, true)
            .seen(EdgeSource::Native, true);
        assert!(!both.closed().armed);
        assert!(!both.closed().seen(EdgeSource::Strip, false).armed);
        assert!(
            both.closed()
                .seen(EdgeSource::Strip, false)
                .seen(EdgeSource::Native, false)
                .armed
        );
        assert!(EdgeArm::ARMED.closed().armed);
    }

    #[test]
    fn hiding_the_sidebar_at_the_edge_does_not_peek_until_the_pointer_leaves() {
        let now = Instant::now();
        let mut edge = EdgePeek::default();
        edge.undocked();
        assert!(!edge.strip(true, true, true, now).opened);
        assert!(!edge.gate.is_out());
        edge.strip(false, true, true, now);
        assert!(edge.strip(true, true, true, now).opened);
    }

    #[test]
    fn a_peek_closed_under_the_pointer_stays_closed_until_it_leaves() {
        let now = Instant::now();
        let mut edge = EdgePeek::default();
        assert!(edge.strip(true, true, true, now).opened);
        let at = edge.strip(false, true, true, now).hide_at.expect("timer");
        edge.strip_over = true;
        edge.arm = edge.arm.seen(EdgeSource::Strip, true);
        assert!(edge.due(at, false));
        assert!(!edge.strip(true, true, true, now).opened);
        edge.strip(false, true, true, now);
        assert!(edge.strip(true, true, true, now).opened);
    }

    #[test]
    fn the_native_watch_holds_and_crossing_the_screen_edge_closes_at_once() {
        let now = Instant::now();
        let mut edge = EdgePeek::default();
        let over = |x: f32| SidebarEdgeEvent {
            over: true,
            point: [x, 300.0],
            screen_edge: None,
        };
        assert_eq!(edge.native(over(5.0), false, true, true, now), None);
        let opened = edge
            .native(over(-10.0), true, true, true, now)
            .expect("seen");
        assert!(opened.opened);
        edge.strip(true, true, true, now);
        let crossed = edge
            .native(
                SidebarEdgeEvent {
                    over: false,
                    point: [-30.0, 300.0],
                    screen_edge: Some(ScreenEdge::Crossed),
                },
                false,
                true,
                true,
                now,
            )
            .expect("seen");
        assert!(crossed.crossed);
        assert_eq!(crossed.hide_at, Some(now));
        assert!(edge.due(now, edge.pointer_at_edge()));
        let mut slow = EdgePeek::default();
        slow.native(over(1.0), true, true, true, now);
        let left = slow
            .native(
                SidebarEdgeEvent {
                    over: false,
                    point: [400.0, 300.0],
                    screen_edge: None,
                },
                false,
                true,
                true,
                now,
            )
            .expect("seen");
        assert_eq!(left.hide_at, Some(now + PEEK_CLOSE_DELAY));
    }

    #[test]
    fn a_strip_exit_does_not_close_while_the_native_watch_still_holds() {
        let now = Instant::now();
        let mut edge = EdgePeek::default();
        edge.native(
            SidebarEdgeEvent {
                over: true,
                point: [-5.0, 10.0],
                screen_edge: None,
            },
            true,
            true,
            true,
            now,
        );
        edge.strip(true, true, true, now);
        assert_eq!(edge.strip(false, true, true, now).hide_at, None);
        assert!(edge.gate.is_out());
    }

    #[test]
    fn disabling_closes_and_disarms_under_the_pointer() {
        let now = Instant::now();
        let mut edge = EdgePeek::default();
        edge.strip(true, true, true, now);
        assert!(edge.disable());
        assert!(!edge.gate.is_out());
        assert!(!edge.arm.armed);
        assert!(!edge.disable());
    }
}
