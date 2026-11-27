use std::collections::VecDeque;
use std::time::{Duration, Instant};

use ardia_state::{BrowserState, WindowId};

pub const OPEN_WAIT: Duration = Duration::from_secs(5);
pub const ENTER_WAIT: Duration = Duration::from_secs(3);

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Turn {
    Record,
    Hold,
    Enter,
    GiveUp(WindowId),
    Refocus,
}

#[derive(Debug, Default)]
pub struct FullScreenRestore {
    armed: bool,
    queue: VecDeque<WindowId>,
    entering: Option<Instant>,
    turn_since: Option<Instant>,
    focus: Option<WindowId>,
    toggled: bool,
}

impl gpui::Global for FullScreenRestore {}

pub fn saved_order(state: &BrowserState) -> Vec<WindowId> {
    let mut saved: Vec<_> = state
        .window_order
        .iter()
        .filter_map(|id| state.window(id.as_str()))
        .filter(|w| w.kind == ardia_state::windows::WindowKind::Main)
        .filter_map(|w| w.full_screen.map(|stamp| (stamp, w.id.clone())))
        .collect();
    saved.sort_by_key(|(stamp, _)| *stamp);
    saved.into_iter().map(|(_, id)| id).collect()
}

impl FullScreenRestore {
    pub fn armed(&self) -> bool {
        self.armed
    }

    pub fn busy(&self) -> bool {
        !self.queue.is_empty() || self.toggled
    }

    pub fn arm(&mut self, queue: Vec<WindowId>, focus: Option<WindowId>, now: Instant) {
        self.armed = true;
        self.queue = queue.into();
        self.entering = None;
        self.turn_since = Some(now);
        self.focus = focus;
        self.toggled = false;
    }

    fn next_turn(&mut self, now: Instant) {
        self.queue.pop_front();
        self.entering = None;
        self.turn_since = Some(now);
    }

    pub fn step(&mut self, me: &WindowId, full: bool, now: Instant) -> Turn {
        let Some(front) = self.queue.front().cloned() else {
            if self.toggled && self.focus.as_ref() == Some(me) {
                self.toggled = false;
                return Turn::Refocus;
            }
            return Turn::Record;
        };
        if front == *me {
            return match self.entering {
                _ if full => {
                    self.next_turn(now);
                    Turn::Record
                }
                None => {
                    self.entering = Some(now);
                    self.toggled = true;
                    Turn::Enter
                }
                Some(at) if now.saturating_duration_since(at) >= ENTER_WAIT => {
                    self.next_turn(now);
                    Turn::GiveUp(front)
                }
                Some(_) => Turn::Hold,
            };
        }
        let waited = self
            .turn_since
            .is_some_and(|since| now.saturating_duration_since(since) >= OPEN_WAIT);
        if self.entering.is_none() && waited {
            self.next_turn(now);
            return Turn::GiveUp(front);
        }
        if self.queue.contains(me) {
            Turn::Hold
        } else {
            Turn::Record
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn id(name: &str) -> WindowId {
        WindowId::new(name)
    }

    #[test]
    fn windows_go_full_screen_one_at_a_time_oldest_first_then_focus_returns() {
        let now = Instant::now();
        let mut restore = FullScreenRestore::default();
        restore.arm(vec![id("old"), id("new")], Some(id("new")), now);
        assert_eq!(restore.step(&id("new"), false, now), Turn::Hold);
        assert_eq!(restore.step(&id("old"), false, now), Turn::Enter);
        assert_eq!(restore.step(&id("old"), false, now), Turn::Hold);
        assert_eq!(restore.step(&id("new"), false, now), Turn::Hold);
        assert_eq!(restore.step(&id("old"), true, now), Turn::Record);
        assert_eq!(restore.step(&id("new"), false, now), Turn::Enter);
        assert_eq!(restore.step(&id("new"), true, now), Turn::Record);
        assert_eq!(restore.step(&id("old"), true, now), Turn::Record);
        assert_eq!(restore.step(&id("new"), true, now), Turn::Refocus);
        assert_eq!(restore.step(&id("new"), true, now), Turn::Record);
    }

    #[test]
    fn a_window_that_never_enters_or_never_opens_is_given_up() {
        let now = Instant::now();
        let mut restore = FullScreenRestore::default();
        restore.arm(vec![id("stuck"), id("gone"), id("other")], None, now);
        assert_eq!(restore.step(&id("stuck"), false, now), Turn::Enter);
        let later = now + ENTER_WAIT;
        assert_eq!(
            restore.step(&id("stuck"), false, later),
            Turn::GiveUp(id("stuck"))
        );
        let much_later = later + OPEN_WAIT;
        assert_eq!(
            restore.step(&id("other"), false, much_later),
            Turn::GiveUp(id("gone"))
        );
        assert_eq!(restore.step(&id("other"), false, much_later), Turn::Enter);
    }
}
