use std::rc::Rc;
use std::time::Instant;

use ardia_state::{Action, Topics};
use gpui::{Context, PinchEvent, Window};

use crate::content::peek_motion::{DriveInput, PeekOutcome, PeekPhase, stage_input};
use crate::content::peek_overlay::{PeekShown, peek_click_point};
use crate::window::browser_window::BrowserWindowView;
use crate::window::layout::{ChromeLayout, Rect};

impl BrowserWindowView {
    pub(crate) fn drive_peek(
        &mut self,
        layout: &ChromeLayout,
        page: Rect,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let state = std::sync::Arc::clone(&self.state);
        let shown = state.shown_peek(self.window_id.as_str());
        let hidden = state
            .window(self.window_id.as_str())
            .and_then(|w| w.chrome.peek.as_ref())
            .filter(|_| shown.is_none())
            .map(|peek| &peek.tab_id);
        let ready = shown
            .and_then(|peek| state.tab(peek.tab_id.as_str()))
            .is_some_and(|tab| {
                let painted = !tab.title.is_empty() || !tab.live.loading;
                let attached = self
                    .host
                    .tab_native_views(tab.id.clone())
                    .and_then(|views| views.page_view)
                    .is_some();
                painted && attached
            });
        let stage = shown.map(|peek| {
            stage_input(
                layout.card,
                page,
                layout.frame.inset,
                layout.frame.radius,
                state.settings.peek_buttons,
                peek_click_point(peek, page, window.scale_factor()),
            )
        });
        let outcome = self.peek_motion.drive(
            DriveInput {
                peek: shown.map(|peek| &peek.tab_id),
                hidden_peek: hidden,
                ready,
                reduce: cx.reduce_motion(),
                stage,
            },
            Instant::now(),
        );
        if let Some(outcome) = outcome {
            cx.defer_in(window, move |view, window, cx| {
                view.finish_peek(outcome, window, cx)
            });
        }
        if self.peek_motion.motion().animating() {
            window.request_animation_frame();
        }
    }

    pub(crate) fn peek_shown(&self, cx: &mut Context<Self>) -> Option<PeekShown> {
        let geometry = *self.peek_motion.motion().geometry()?;
        let frame = self.peek_motion.frame()?;
        let listener = cx.listener(Self::on_peek_pinch);
        Some(PeekShown {
            geometry,
            frame,
            on_pinch: Some(Rc::new(listener)),
        })
    }

    fn on_peek_pinch(&mut self, event: &PinchEvent, _: &mut Window, cx: &mut Context<Self>) {
        let Some(area) = self.layout.map(|layout| layout.card) else {
            return;
        };
        let at = [
            crate::scale::points(event.position.x) - area.x,
            crate::scale::points(event.position.y) - area.y,
        ];
        let claimed = self.peek_motion.claims_pinch();
        self.peek_motion
            .pinch(event.phase, event.delta, at, Instant::now());
        if claimed || self.peek_motion.claims_pinch() {
            cx.stop_propagation();
        }
        cx.notify();
    }

    pub(crate) fn peek_motion_takes(&mut self, action: &Action, cx: &mut Context<Self>) -> bool {
        let (closing, target) = match action {
            Action::ClosePeek { window } => (true, window),
            Action::PromotePeek { window } => (false, window),
            _ => return false,
        };
        if *target != self.window_id {
            return false;
        }
        let Some(peek) = self.state.shown_peek(self.window_id.as_str()) else {
            return false;
        };
        if !self.peek_motion.owns(&peek.tab_id) {
            return false;
        }
        let now = Instant::now();
        let started = if closing {
            self.peek_motion.close(now)
        } else {
            self.peek_motion.promote(now)
        };
        let busy = matches!(
            self.peek_motion.motion().phase(),
            PeekPhase::Closing | PeekPhase::Promoting | PeekPhase::Finished
        );
        if started && self.peek_motion.take_outcome().is_some() {
            return false;
        }
        if started || busy {
            cx.notify();
            return true;
        }
        false
    }

    fn finish_peek(&mut self, outcome: PeekOutcome, window: &mut Window, cx: &mut Context<Self>) {
        let still_shown = self
            .state
            .shown_peek(self.window_id.as_str())
            .is_some_and(|peek| self.peek_motion.tab() == Some(&peek.tab_id));
        if !still_shown {
            return;
        }
        let action = match outcome {
            PeekOutcome::Closed => Action::ClosePeek {
                window: self.window_id.clone(),
            },
            PeekOutcome::Promoted => Action::PromotePeek {
                window: self.window_id.clone(),
            },
        };
        self.host.dispatch(action);
        self.on_store(Topics::ALL, window, cx);
    }
}
