use std::time::{Duration, Instant};

use ardia_state::TabId;

const ASK_LIMIT: Duration = Duration::from_secs(3);

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Step {
    Stay,
    EnterWindow,
    LeaveWindow,
    ExitPage(TabId),
}

#[derive(Debug, Default)]
pub struct PageFullScreen {
    entered: bool,
    asked: Option<(bool, Instant)>,
    window_was_full: bool,
    leaving: Option<TabId>,
    acted: bool,
}

impl PageFullScreen {
    pub fn acted(&self) -> bool {
        self.acted
    }

    pub fn set_acted(&mut self, on: bool) {
        self.acted = on;
    }

    pub fn entered_for_page(&self) -> bool {
        self.entered
    }

    pub fn step(
        &mut self,
        page: Option<&TabId>,
        takes_window: bool,
        window_full: bool,
        now: Instant,
    ) -> Step {
        let was_full = std::mem::replace(&mut self.window_was_full, window_full);
        if self.leaving.as_ref() != page {
            self.leaving = None;
        }
        if let Some((target, at)) = self.asked {
            if window_full != target && now.saturating_duration_since(at) < ASK_LIMIT {
                return Step::Stay;
            }
            self.asked = None;
            if window_full != target {
                self.entered = window_full && self.entered;
            }
        } else if was_full && !window_full {
            self.entered = false;
            if let Some(tab) = page {
                self.leaving = Some(tab.clone());
                return Step::ExitPage(tab.clone());
            }
        }
        let wants_window = page.is_some() && takes_window && self.leaving.is_none();
        match (wants_window, window_full) {
            (true, false) if !self.entered => {
                self.entered = true;
                self.asked = Some((true, now));
                Step::EnterWindow
            }
            (false, true) if self.entered && page.is_none() => {
                self.entered = false;
                self.asked = Some((false, now));
                Step::LeaveWindow
            }
            (false, false) if page.is_none() => {
                self.entered = false;
                Step::Stay
            }
            _ => Step::Stay,
        }
    }
}

pub const DRAW_WAIT: Duration = Duration::from_millis(400);
pub const COVER_LIMIT: Duration = Duration::from_secs(4);
pub const UNCOVER_AFTER_DRAW: Duration = Duration::from_millis(34);

pub fn page_drew(
    drawn: Option<crate::host::PageDrawState>,
    entering: bool,
    pixels: [f64; 2],
) -> bool {
    let Some(drawn) = drawn else {
        return true;
    };
    let sized = (drawn.width - pixels[0]).abs() <= 2.0 && (drawn.height - pixels[1]).abs() <= 2.0;
    if entering {
        drawn.full_screen && sized
    } else {
        !drawn.full_screen
    }
}

#[derive(Clone, Debug)]
pub struct Covers {
    pub tabs: Vec<TabId>,
    pub since: Instant,
    pub transitions: u64,
}

impl Covers {
    pub fn lifts(&self, transitions: u64, now: Instant) -> bool {
        transitions != self.transitions || now.saturating_duration_since(self.since) >= COVER_LIMIT
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tab() -> TabId {
        TabId::new("video")
    }

    #[test]
    fn a_page_going_full_screen_takes_the_window_and_gives_it_back() {
        let now = Instant::now();
        let mut fs = PageFullScreen::default();
        assert_eq!(fs.step(None, true, false, now), Step::Stay);
        assert_eq!(fs.step(Some(&tab()), true, false, now), Step::EnterWindow);
        assert_eq!(fs.step(Some(&tab()), true, false, now), Step::Stay);
        assert_eq!(fs.step(Some(&tab()), true, true, now), Step::Stay);
        assert!(fs.entered_for_page());
        assert_eq!(fs.step(None, true, true, now), Step::LeaveWindow);
        assert_eq!(fs.step(None, true, true, now), Step::Stay);
        assert_eq!(fs.step(None, true, false, now), Step::Stay);
        assert!(!fs.entered_for_page());
    }

    #[test]
    fn a_window_already_full_screen_stays_full_screen_when_the_page_leaves() {
        let now = Instant::now();
        let mut fs = PageFullScreen::default();
        assert_eq!(fs.step(None, true, true, now), Step::Stay);
        assert_eq!(fs.step(Some(&tab()), true, true, now), Step::Stay);
        assert!(!fs.entered_for_page());
        assert_eq!(fs.step(None, true, true, now), Step::Stay);
    }

    #[test]
    fn leaving_window_full_screen_by_hand_ends_the_page_full_screen() {
        let now = Instant::now();
        let mut fs = PageFullScreen::default();
        fs.step(Some(&tab()), true, false, now);
        fs.step(Some(&tab()), true, true, now);
        assert_eq!(
            fs.step(Some(&tab()), true, false, now),
            Step::ExitPage(tab())
        );
        assert_eq!(fs.step(Some(&tab()), true, false, now), Step::Stay);
        assert_eq!(fs.step(None, true, false, now), Step::Stay);
    }

    #[test]
    fn leaving_a_window_that_was_already_full_screen_ends_the_page_too() {
        let now = Instant::now();
        let mut fs = PageFullScreen::default();
        fs.step(None, true, true, now);
        fs.step(Some(&tab()), true, true, now);
        assert_eq!(
            fs.step(Some(&tab()), true, false, now),
            Step::ExitPage(tab())
        );
    }

    #[test]
    fn pages_that_bring_their_own_full_screen_window_leave_this_one_alone() {
        let now = Instant::now();
        let mut fs = PageFullScreen::default();
        assert_eq!(fs.step(Some(&tab()), false, false, now), Step::Stay);
        assert_eq!(fs.step(None, false, false, now), Step::Stay);
    }

    #[test]
    fn the_window_waits_for_the_page_to_draw_at_full_size_before_toggling() {
        use crate::host::PageDrawState;
        let drawn = |w: f64, h: f64, full_screen| {
            Some(PageDrawState {
                width: w,
                height: h,
                full_screen,
            })
        };
        assert!(page_drew(
            drawn(3024.0, 1718.0, true),
            true,
            [3024.0, 1718.0]
        ));
        assert!(!page_drew(
            drawn(2548.0, 1620.0, true),
            true,
            [3024.0, 1718.0]
        ));
        assert!(!page_drew(
            drawn(3024.0, 1718.0, false),
            true,
            [3024.0, 1718.0]
        ));
        assert!(page_drew(
            drawn(2548.0, 1620.0, false),
            false,
            [3024.0, 1718.0]
        ));
        assert!(page_drew(None, true, [3024.0, 1718.0]));
    }

    #[test]
    fn covers_lift_after_the_transition_or_the_limit() {
        let now = Instant::now();
        let covers = Covers {
            tabs: vec![tab()],
            since: now,
            transitions: 3,
        };
        assert!(!covers.lifts(3, now));
        assert!(covers.lifts(4, now));
        assert!(covers.lifts(3, now + COVER_LIMIT));
    }

    #[test]
    fn a_refused_transition_is_asked_again_after_the_limit() {
        let now = Instant::now();
        let mut fs = PageFullScreen::default();
        assert_eq!(fs.step(Some(&tab()), true, false, now), Step::EnterWindow);
        let later = now + ASK_LIMIT + Duration::from_millis(1);
        assert_eq!(fs.step(Some(&tab()), true, false, later), Step::EnterWindow);
    }
}
