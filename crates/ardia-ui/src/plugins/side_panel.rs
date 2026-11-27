use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Duration, Instant};

use ardia_state::WindowId;
use ardia_theme::tokens::space;
use gpui::{App, Global, Window};

use super::model::{PluginHost, SidePanelCard, SidePanelState};
use super::tokens::side_panel;
use crate::host::UiHost;
use crate::window::motion::Curve;

pub const APPEAR: Duration = Duration::from_millis(150);
pub const HEADER_PAD_LEFT: f32 = space::L;
pub const HEADER_PAD_RIGHT: f32 = space::S;
pub const BODY_PAD: f32 = space::S;
pub const MISSING_PAD: f32 = space::L;
pub const MISSING: &str = "This panel isn't available any more.";

#[derive(Clone, Debug, PartialEq)]
pub struct PanelMotion {
    pub shown: bool,
    pub from: f32,
    pub since: Option<Instant>,
    pub width: f32,
    pub leaving: Option<SidePanelCard>,
    pub last_shown: Option<SidePanelCard>,
}

impl Default for PanelMotion {
    fn default() -> Self {
        PanelMotion {
            shown: false,
            from: 0.0,
            since: None,
            width: side_panel::INITIAL,
            leaving: None,
            last_shown: None,
        }
    }
}

impl PanelMotion {
    pub fn appear(&self, now: Instant) -> f32 {
        let target = if self.shown { 1.0 } else { 0.0 };
        let Some(since) = self.since else {
            return target;
        };
        let t = (now.saturating_duration_since(since).as_secs_f32() / APPEAR.as_secs_f32())
            .clamp(0.0, 1.0);
        self.from + (target - self.from) * Curve::EaseOut.apply(t)
    }

    pub fn running(&self, now: Instant) -> bool {
        self.since
            .is_some_and(|since| now.saturating_duration_since(since) < APPEAR)
    }

    pub fn update(&mut self, state: &SidePanelState, now: Instant) {
        let shown = state.shown.is_some();
        if shown != self.shown {
            self.from = self.appear(now);
            self.shown = shown;
            self.since = Some(now);
            self.leaving = if shown { None } else { self.last_shown.clone() };
        }
        if let Some(card) = &state.shown {
            if self
                .last_shown
                .as_ref()
                .is_some_and(|last| last.key() != card.key())
            {
                self.leaving = None;
            }
            self.last_shown = Some(card.clone());
        }
        if !shown && !self.running(now) && self.appear(now) <= 0.0 {
            self.leaving = None;
        }
    }

    pub fn cards(&self, state: &SidePanelState) -> Vec<SidePanelCard> {
        let mut rendered = state.retained.clone();
        for extra in [state.shown.as_ref(), self.leaving.as_ref()]
            .into_iter()
            .flatten()
        {
            if !rendered.iter().any(|card| card.key() == extra.key()) {
                rendered.push(extra.clone());
            }
        }
        rendered
    }

    pub fn current_key(&self, state: &SidePanelState) -> Option<String> {
        state
            .shown
            .as_ref()
            .or(self.leaving.as_ref())
            .map(SidePanelCard::key)
    }

    pub fn resize(&mut self, width: f32) {
        self.width = width.clamp(side_panel::MIN, side_panel::MAX);
    }

    pub fn reset_width(&mut self) {
        self.width = side_panel::INITIAL;
    }
}

#[derive(Default)]
pub struct PanelMotions(pub HashMap<WindowId, PanelMotion>);

impl Global for PanelMotions {}

pub fn plugins_of(host: &Arc<dyn UiHost>, window: &WindowId) -> Option<Arc<dyn PluginHost>> {
    host.plugins()
        .filter(|plugins| plugins.window_eligible(window))
}

pub fn room(
    host: &Arc<dyn UiHost>,
    window_id: &WindowId,
    gap: f32,
    window: &mut Window,
    cx: &mut App,
) -> f32 {
    let Some(plugins) = plugins_of(host, window_id) else {
        return 0.0;
    };
    let state = plugins.side_panel(window_id);
    let now = Instant::now();
    let motions = cx.default_global::<PanelMotions>();
    let motion = motions.0.entry(window_id.clone()).or_default();
    motion.update(&state, now);
    if motion.cards(&state).is_empty() {
        return 0.0;
    }
    if motion.running(now) {
        window.request_animation_frame();
    }
    motion.appear(now) * (motion.width + gap)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::plugins::model::PanelContent;

    fn card(id: &str) -> SidePanelCard {
        SidePanelCard {
            plugin: "p".into(),
            panel: id.into(),
            generation: 1,
            title: id.into(),
            icon: "puzzlepiece".into(),
            content: PanelContent::Missing,
        }
    }

    #[test]
    fn appears_over_150ms_and_keeps_the_leaving_card_until_gone() {
        let start = Instant::now();
        let mut motion = PanelMotion::default();
        let open = SidePanelState {
            shown: Some(card("a")),
            retained: Vec::new(),
        };
        motion.update(&open, start);
        assert_eq!(motion.appear(start), 0.0);
        assert!(motion.running(start + Duration::from_millis(100)));
        assert!(motion.appear(start + Duration::from_millis(75)) > 0.5);
        assert_eq!(motion.appear(start + APPEAR), 1.0);
        let closed = SidePanelState::default();
        let later = start + Duration::from_millis(400);
        motion.update(&closed, later);
        assert_eq!(motion.cards(&closed).len(), 1);
        assert_eq!(motion.current_key(&closed), Some("p:a:1".into()));
        motion.update(&closed, later + APPEAR);
        assert!(motion.cards(&closed).is_empty());
        motion.resize(9000.0);
        assert_eq!(motion.width, side_panel::MAX);
        motion.reset_width();
        assert_eq!(motion.width, side_panel::INITIAL);
    }
}
