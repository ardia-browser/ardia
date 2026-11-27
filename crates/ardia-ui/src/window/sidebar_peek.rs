use std::sync::Arc;
use std::time::{Duration, Instant};

use ardia_state::Action;
use ardia_state::model::EffectiveLayout;
use ardia_theme::motion::{ARC_PEEK_OUT_MS, PEEK_IN_MS};
use futures::StreamExt as _;
use futures::channel::mpsc;
use gpui::{AnyElement, Context, Subscription, Task, Window};

use crate::sidebar::edge_peek::{
    EdgeOutcome, EdgePeek, EdgeSource, PointerWatch, ScreenEdge, SidebarEdgeEvent, SidebarEdgeSink,
    SidebarEdgeWatch, edge_event_reveals, edge_watch, edge_watch_width, reveal_band,
};
use crate::window::browser_window::BrowserWindowView;
use crate::window::layout::ChromeLayout;
use crate::window::motion::Curve;

pub(crate) struct SidebarEdge {
    pub(crate) peek: EdgePeek,
    sent: Option<SidebarEdgeWatch>,
    sink: SidebarEdgeSink,
    timer: Option<Task<()>>,
    full_screen_peek_at: Option<Instant>,
    _events: Task<()>,
    _activation: Subscription,
}

impl SidebarEdge {
    pub(crate) fn new(window: &mut Window, cx: &mut Context<BrowserWindowView>) -> Self {
        let (sender, mut receiver) = mpsc::unbounded::<SidebarEdgeEvent>();
        let sink: SidebarEdgeSink = Arc::new(move |event| {
            let _ = sender.unbounded_send(event);
        });
        let events = cx.spawn_in(window, async move |view, cx| {
            while let Some(event) = receiver.next().await {
                if view
                    .update_in(cx, |view, window, cx| {
                        view.native_sidebar_edge(event, window, cx)
                    })
                    .is_err()
                {
                    break;
                }
            }
        });
        let activation = cx.observe_window_activation(window, |view, window, cx| {
            if window.is_window_active() {
                view.sidebar_edge_focus_gained(window, cx);
            }
        });
        SidebarEdge {
            peek: EdgePeek::default(),
            sent: None,
            sink,
            timer: None,
            full_screen_peek_at: None,
            _events: events,
            _activation: activation,
        }
    }
}

fn watches_edge(layout: &ChromeLayout) -> bool {
    layout.sidebar.is_none() && layout.strip.is_none()
}

impl BrowserWindowView {
    fn sidebar_edge_enabled(&self) -> bool {
        let held = self
            .visible_tabs()
            .iter()
            .any(|tab| self.host.page_holds_pointer(&tab.id));
        crate::sidebar::edge_peek::edge_reveal_allowed(
            self.layout.as_ref().is_some_and(watches_edge),
            self.has_sidebar(),
            held,
        )
    }

    fn app_in_front(&self) -> bool {
        crate::window::keeps_key_look() || self.host.app_active()
    }

    fn sidebar_peek_held(&self) -> bool {
        self.sidebar_edge.peek.pointer_at_edge()
            || self.ui.peek_hover
            || self.ui.menu.is_some()
            || self.ui.rename.is_some()
    }

    pub(crate) fn sidebar_edge_strip(
        &mut self,
        over: bool,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.ui.edge = over;
        let (enabled, front) = (self.sidebar_edge_enabled(), self.app_in_front());
        let outcome = self
            .sidebar_edge
            .peek
            .strip(over, enabled, front, Instant::now());
        self.apply_sidebar_edge(outcome, window, cx);
    }

    pub(crate) fn sidebar_peek_hover(
        &mut self,
        hovered: bool,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.ui.peek_hover = hovered;
        let held = self.sidebar_peek_held();
        let at = self.sidebar_edge.peek.gate.recheck(Instant::now(), held);
        self.schedule_sidebar_close(at, window, cx);
    }

    fn native_sidebar_edge(
        &mut self,
        event: SidebarEdgeEvent,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let Some(layout) = self.layout else {
            return;
        };
        if !self.sidebar_edge_enabled() {
            return;
        }
        match event.screen_edge {
            Some(ScreenEdge::Crossed) => {
                ardia_telemetry::counts::count("sidebar_screen_edge_crossings")
            }
            Some(ScreenEdge::Returned) => {
                ardia_telemetry::counts::count("sidebar_screen_edge_returns")
            }
            None => {}
        }
        let scale = crate::scale::current();
        let x = event.point[0] / scale;
        let dragging = crate::sidebar::drag::live_drag(self.window_id.as_str()).is_some();
        let reveals = edge_event_reveals(
            self.sidebar_edge.peek.gate.is_out(),
            x,
            layout.trailing,
            layout.width,
            reveal_band(dragging),
        );
        let front = self.app_in_front();
        let Some(outcome) =
            self.sidebar_edge
                .peek
                .native(event, reveals, true, front, Instant::now())
        else {
            return;
        };
        if outcome.crossed {
            self.ui.edge = false;
            self.ui.url_hover = false;
        }
        self.apply_sidebar_edge(outcome, window, cx);
    }

    fn sidebar_edge_focus_gained(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let enabled = self.sidebar_edge_enabled();
        if self.sidebar_edge.peek.gate.focus_gained(enabled) {
            self.update_peek(window, cx);
        }
    }

    fn apply_sidebar_edge(
        &mut self,
        outcome: EdgeOutcome,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.schedule_sidebar_close(outcome.hide_at, window, cx);
        if outcome.opened || outcome.closed {
            self.update_peek(window, cx);
        }
    }

    fn schedule_sidebar_close(
        &mut self,
        at: Option<Instant>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if self.sidebar_edge.peek.gate.hide_at().is_none() {
            self.sidebar_edge.timer = None;
        }
        let Some(at) = at else {
            return;
        };
        let wait = at.saturating_duration_since(Instant::now());
        if wait.is_zero() {
            self.sidebar_edge.timer = None;
            self.sidebar_close_due(at, window, cx);
            return;
        }
        self.sidebar_edge.timer = Some(cx.spawn_in(window, async move |view, cx| {
            cx.background_executor().timer(wait).await;
            let _ = view.update_in(cx, |view, window, cx| {
                view.sidebar_close_due(at, window, cx)
            });
        }));
    }

    fn sidebar_close_due(&mut self, at: Instant, window: &mut Window, cx: &mut Context<Self>) {
        let held = self.sidebar_peek_held();
        self.sidebar_edge.timer = None;
        if self.sidebar_edge.peek.due(at, held) {
            self.ui.url_hover = false;
            self.update_peek(window, cx);
        }
    }

    pub(crate) fn sidebar_dock_changed(&mut self, shown: bool) {
        self.sidebar_edge.timer = None;
        if shown {
            self.sidebar_edge.peek.docked();
        } else {
            self.sidebar_edge.peek.undocked();
        }
        self.ui.edge = false;
        self.ui.peek_hover = false;
    }

    pub(crate) fn sync_sidebar_edge(
        &mut self,
        layout: &ChromeLayout,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Option<AnyElement> {
        if !(watches_edge(layout) && self.has_sidebar()) {
            if self.sidebar_edge.sent.take().is_some() {
                self.host
                    .watch_sidebar_edge(window, self.window_id.clone(), None);
            }
            let waiting = self.sidebar_edge.peek.gate.waiting_for_focus();
            if self.sidebar_edge.peek.disable() || waiting {
                self.sidebar_edge.timer = None;
                cx.defer_in(window, |view, window, cx| view.update_peek(window, cx));
            }
            return None;
        }
        let dragging = crate::sidebar::drag::live_drag(self.window_id.as_str()).is_some();
        let holding = self.sidebar_edge.peek.gate.is_out();
        let hold_width = layout.frame.peek_hold_width(layout.sidebar_width);
        let native = SidebarEdgeWatch {
            hold: edge_watch_width(holding, dragging, hold_width, layout.frame.inset)
                * crate::scale::current(),
            trailing: layout.trailing,
            while_pressed: holding || dragging,
        };
        let fresh = self.sidebar_edge.sent.is_none();
        if self.sidebar_edge.sent != Some(native) {
            self.sidebar_edge.sent = Some(native);
            self.host.watch_sidebar_edge(
                window,
                self.window_id.clone(),
                Some((native, Arc::clone(&self.sidebar_edge.sink))),
            );
        }
        let pointer = PointerWatch {
            holding,
            band: reveal_band(dragging),
            hold_width,
            trailing: layout.trailing,
            width: layout.width,
            height: layout.height,
        };
        if fresh {
            let (x, y) = crate::scale::logical_point(window.mouse_position());
            let over = window.is_window_hovered() && pointer.over(x, y);
            let edge = &mut self.sidebar_edge.peek;
            edge.strip_over = over;
            edge.arm = edge.arm.seen(EdgeSource::Strip, over);
        }
        let held = self.sidebar_peek_held();
        if let Some(at) = self.sidebar_edge.peek.gate.recheck(Instant::now(), held) {
            self.schedule_sidebar_close(Some(at), window, cx);
        }
        Some(edge_watch(
            &self.emit,
            pointer,
            self.sidebar_edge.peek.strip_over,
            !self.sidebar_edge.peek.arm.armed,
        ))
    }

    pub(crate) fn update_peek(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let wanted = self.sidebar_edge.peek.gate.is_out()
            && self.sidebar_edge_enabled()
            && self.has_sidebar();
        let now = Instant::now();
        if wanted != (self.peek.target() > 0.5) {
            let reduce = self.reduce_motion(cx);
            let arc =
                self.state.effective_layout(self.window_id.as_str()) == EffectiveLayout::ArcSidebar;
            let (duration, curve) = if wanted {
                (Duration::from_millis(PEEK_IN_MS), Curve::EaseOut)
            } else if arc {
                (Duration::from_millis(ARC_PEEK_OUT_MS), Curve::EaseInOut)
            } else {
                (Duration::from_millis(PEEK_IN_MS), Curve::EaseOut)
            };
            if wanted {
                note_sidebar_peek(
                    self.peek.value(now) > 0.0,
                    self.state.settings.auto_hide_tabs,
                );
            }
            self.peek.go(
                if wanted { 1.0 } else { 0.0 },
                if reduce { Duration::ZERO } else { duration },
                curve,
                now,
            );
            self.note_peek_turned(wanted, window, now);
            self.host.dispatch(Action::SetSidebarPeeking {
                window: self.window_id.clone(),
                peeking: wanted,
            });
        }
        cx.notify();
    }

    fn note_peek_turned(&mut self, shown: bool, window: &Window, now: Instant) {
        use ardia_telemetry::counts::count;
        if shown {
            if self.state.fullscreen_tab(self.window_id.as_str()).is_some() {
                count("sidebar_page_full_screen_peeks");
            }
            if self.layout.is_some_and(|l| l.frame.inset < 4.0) {
                count("sidebar_thin_frame_peeks");
            }
            let full_screen = self.window_full_screen(window);
            if full_screen {
                count("sidebar_full_screen_peeks");
            }
            self.sidebar_edge.full_screen_peek_at = full_screen.then_some(now);
            return;
        }
        if self.ui.sidebar_drag.is_some() {
            count("sidebar_peek_closes_while_resizing");
        }
        if let Some(at) = self.sidebar_edge.full_screen_peek_at.take()
            && now.saturating_duration_since(at) < Duration::from_millis(500)
        {
            count("sidebar_full_screen_peek_quick_closes");
        }
    }
}

fn note_sidebar_peek(bounce: bool, auto_hide_tabs: bool) {
    ardia_telemetry::counts::count("sidebar_peeks");
    if bounce {
        ardia_telemetry::counts::count("sidebar_peek_bounces");
    }
    if !auto_hide_tabs {
        ardia_telemetry::counts::count("tab_peeks_with_auto_hide_off");
    }
}
