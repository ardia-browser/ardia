use std::cell::RefCell;
use std::collections::HashMap;
use std::time::Duration;

use ardia_state::TabId;
use ardia_theme::motion::{CubicBezier, HOVER_CARD_FADE_MS};
use gpui::{
    AnchoredPositionMode, Animation, AnimationExt, AnyElement, App, Bounds, IntoElement,
    ParentElement, Pixels, Styled, Window, anchored, canvas, deferred, div, point, prelude::*,
};

use crate::window::chrome::{Chrome, TabHoverCard};

pub const SHOW_MS: u64 = 500;
pub const LEAVE_MS: u64 = 160;
pub const CARD_WIDTH: f32 = 264.0;
pub const CARD_GAP: f32 = 4.0;
pub const CARD_MARGIN: f32 = 8.0;

#[derive(Clone, Debug, PartialEq)]
pub struct Card {
    pub tab: TabId,
    pub anchor: Bounds<Pixels>,
    pub generation: u64,
}

#[derive(Clone, Debug, Default)]
pub struct StripHover {
    pub pointed: Option<TabId>,
    pub pressed: Option<TabId>,
    pub ticket: u64,
    pub leave: u64,
    pub generation: u64,
    pub shown: Option<Card>,
    pub leaving: Option<Card>,
    pub anchors: HashMap<TabId, Bounds<Pixels>>,
    pub show_when_placed: Option<u64>,
    pub pointed_other_profile: bool,
}

#[derive(Clone, Copy, Debug)]
pub struct Chip {
    pub hovered: bool,
    pub cards_on: bool,
    pub other_profile: bool,
}

fn note_shown(other_profile: bool) {
    ardia_telemetry::counts::count("tab_strip_hover_cards");
    if other_profile {
        ardia_telemetry::counts::count("tab_strip_hover_cards_other_profile");
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Next {
    Nothing,
    ShowNow,
    ShowAfter(u64),
}

impl StripHover {
    pub fn entered(&mut self, tab: &TabId, cards_on: bool) -> Next {
        self.leave += 1;
        self.pointed = Some(tab.clone());
        if self.pressed.as_ref() == Some(tab) {
            return Next::Nothing;
        }
        self.pressed = None;
        if !cards_on {
            self.hide();
            return Next::Nothing;
        }
        self.ticket += 1;
        if self.shown.is_some() {
            Next::ShowNow
        } else {
            Next::ShowAfter(self.ticket)
        }
    }

    pub fn left(&mut self, tab: &TabId) -> Option<u64> {
        if self.pointed.as_ref() != Some(tab) {
            return None;
        }
        self.pointed = None;
        self.pressed = None;
        self.ticket += 1;
        self.leave += 1;
        Some(self.leave)
    }

    pub fn pressed(&mut self, tab: &TabId) {
        self.pressed = Some(tab.clone());
        self.dismiss();
    }

    pub fn dismiss(&mut self) {
        self.ticket += 1;
        self.leave += 1;
        self.hide();
    }

    pub fn show(&mut self, ticket: Option<u64>, blocked: bool) -> bool {
        self.show_when_placed = None;
        if ticket.is_some_and(|t| t != self.ticket) || blocked {
            return false;
        }
        let Some(tab) = self.pointed.clone() else {
            return false;
        };
        let Some(anchor) = self.anchors.get(&tab).copied() else {
            self.show_when_placed = Some(self.ticket);
            return false;
        };
        let generation = match &self.shown {
            Some(card) => card.generation,
            None => {
                self.generation += 1;
                self.generation
            }
        };
        let next = Card {
            tab,
            anchor,
            generation,
        };
        let changed = self.shown.as_ref() != Some(&next);
        self.leaving = None;
        self.shown = Some(next);
        changed
    }

    pub fn leave_due(&mut self, leave: u64) -> bool {
        if leave != self.leave {
            return false;
        }
        self.hide()
    }

    pub fn hide(&mut self) -> bool {
        match self.shown.take() {
            Some(card) => {
                self.leaving = Some(card);
                true
            }
            None => false,
        }
    }
}

thread_local! {
    static HOVERS: RefCell<HashMap<String, StripHover>> = RefCell::new(HashMap::new());
}

pub fn with<R>(window: &str, f: impl FnOnce(&mut StripHover) -> R) -> R {
    HOVERS.with(|h| f(h.borrow_mut().entry(window.to_owned()).or_default()))
}

pub fn shown_tab(window: &str) -> Option<TabId> {
    with(window, |s| s.shown.as_ref().map(|card| card.tab.clone()))
}

pub fn card_left(anchor_x: f32, anchor_right: f32, window_width: f32) -> f32 {
    let near = anchor_x.max(anchor_right - CARD_WIDTH);
    near.min(window_width - CARD_WIDTH - CARD_MARGIN)
        .max(CARD_MARGIN)
}

fn blocked(window_key: &str, cx: &App) -> bool {
    cx.has_active_drag() || crate::window::hover_hold::hover_held(window_key)
}

fn after(window: &mut Window, cx: &mut App, wait: u64, then: impl FnOnce(&App) -> bool + 'static) {
    window
        .spawn(cx, async move |cx| {
            cx.background_executor()
                .timer(Duration::from_millis(wait))
                .await;
            let _ = cx.update(|window, cx| {
                if then(cx) {
                    window.refresh();
                }
            });
        })
        .detach();
}

fn fade_out_later(key: String, window: &mut Window, cx: &mut App) {
    let generation = with(&key, |s| s.leaving.as_ref().map(|card| card.generation));
    let Some(generation) = generation else {
        return;
    };
    after(window, cx, HOVER_CARD_FADE_MS, move |_| {
        with(&key, |s| {
            let done = s
                .leaving
                .as_ref()
                .is_some_and(|card| card.generation == generation);
            if done {
                s.leaving = None;
            }
            done
        })
    });
}

pub fn chip_hovered(window_key: &str, tab: &TabId, chip: Chip, window: &mut Window, cx: &mut App) {
    let key = window_key.to_owned();
    let Chip {
        hovered,
        cards_on,
        other_profile,
    } = chip;
    if hovered {
        with(window_key, |s| s.pointed_other_profile = other_profile);
        let hid = with(window_key, |s| s.shown.is_some()) && !cards_on;
        match with(window_key, |s| s.entered(tab, cards_on)) {
            Next::Nothing => {
                if hid {
                    window.refresh();
                    fade_out_later(key, window, cx);
                }
            }
            Next::ShowNow => {
                if with(window_key, |s| s.show(None, blocked(window_key, cx))) {
                    note_shown(other_profile);
                    window.refresh();
                }
            }
            Next::ShowAfter(ticket) => after(window, cx, SHOW_MS, move |cx| {
                let held = blocked(&key, cx);
                let shown = with(&key, |s| s.show(Some(ticket), held));
                if shown {
                    note_shown(other_profile);
                }
                shown
            }),
        }
        return;
    }
    let Some(leave) = with(window_key, |s| s.left(tab)) else {
        return;
    };
    window
        .spawn(cx, async move |cx| {
            cx.background_executor()
                .timer(Duration::from_millis(LEAVE_MS))
                .await;
            let _ = cx.update(|window, cx| {
                if with(&key, |s| s.leave_due(leave)) {
                    window.refresh();
                    fade_out_later(key, window, cx);
                }
            });
        })
        .detach();
}

pub fn chip_pressed(window_key: &str, tab: &TabId, window: &mut Window, cx: &mut App) {
    if with(window_key, |s| {
        let had = s.shown.is_some();
        s.pressed(tab);
        had
    }) {
        window.refresh();
        fade_out_later(window_key.to_owned(), window, cx);
    }
}

pub fn anchor_probe(window_key: &str, tab: &TabId) -> AnyElement {
    let key = window_key.to_owned();
    let tab = tab.clone();
    canvas(
        move |bounds, window, _| {
            let placed = with(&key, |s| {
                s.anchors.insert(tab.clone(), bounds);
                if let Some(card) = s.shown.as_mut().filter(|card| card.tab == tab) {
                    card.anchor = bounds;
                }
                let waiting =
                    s.show_when_placed == Some(s.ticket) && s.pointed.as_ref() == Some(&tab);
                let shown =
                    waiting && s.show(Some(s.ticket), crate::window::hover_hold::hover_held(&key));
                if shown {
                    note_shown(s.pointed_other_profile);
                }
                shown
            });
            if placed {
                window.request_animation_frame();
            }
        },
        |_, _, _, _| {},
    )
    .absolute()
    .inset_0()
    .into_any_element()
}

pub fn overlay(c: &Chrome, strip_bottom: f32) -> Option<AnyElement> {
    let key = c.window.id.as_str();
    with(key, |s| s.anchors.clear());
    if !c.state.settings.show_tab_hover_menu {
        with(key, |s| {
            s.shown = None;
            s.leaving = None;
        });
        return None;
    }
    let (card, entering) = with(key, |s| match (&s.shown, &s.leaving) {
        (Some(card), _) => Some((card.clone(), true)),
        (None, Some(card)) => Some((card.clone(), false)),
        (None, None) => None,
    })?;
    let tab = c.state.tab(card.tab.as_str())?;
    let scale = crate::scale::current();
    let left = card_left(
        crate::scale::points(card.anchor.origin.x),
        crate::scale::points(card.anchor.right()),
        c.layout.width,
    );
    let top = strip_bottom + CARD_GAP;
    let body = TabHoverCard::new(
        tab,
        c.favicon(tab),
        crate::sidebar::strip_layout::FAVICON,
        c.state.settings.show_full_url_in_tab_hover_menu,
        c.p,
    )
    .body();
    let panel = div()
        .id(("strip-hover-card", card.generation as usize))
        .child(body);
    let ease = |t: f32| CubicBezier::HOVER_CARD.ease(f64::from(t)) as f32;
    let animated = panel
        .with_animation(
            (
                if entering {
                    "strip-card-in"
                } else {
                    "strip-card-out"
                },
                card.generation as usize,
            ),
            Animation::new(Duration::from_millis(HOVER_CARD_FADE_MS)).with_easing(ease),
            move |el, t| el.opacity(if entering { t } else { 1.0 - t }),
        )
        .into_any_element();
    Some(
        deferred(
            anchored()
                .position_mode(AnchoredPositionMode::Window)
                .position(point(gpui::px(left * scale), gpui::px(top * scale)))
                .child(animated),
        )
        .with_priority(2)
        .into_any_element(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tab(id: &str) -> TabId {
        id.into()
    }

    fn bounds() -> Bounds<Pixels> {
        Bounds::new(
            point(gpui::px(100.), gpui::px(5.)),
            gpui::size(gpui::px(120.), gpui::px(32.)),
        )
    }

    fn ready(s: &mut StripHover, id: &str) {
        s.anchors.insert(tab(id), bounds());
    }

    #[test]
    fn a_card_waits_for_its_ticket_and_switches_at_once_when_one_is_shown() {
        let mut s = StripHover::default();
        ready(&mut s, "a");
        ready(&mut s, "b");
        let Next::ShowAfter(ticket) = s.entered(&tab("a"), true) else {
            panic!("waits")
        };
        assert!(s.show(Some(ticket), false));
        let generation = s.shown.as_ref().unwrap().generation;
        assert!(s.left(&tab("a")).is_some());
        assert_eq!(s.entered(&tab("b"), true), Next::ShowNow);
        assert!(s.show(None, false));
        let card = s.shown.clone().unwrap();
        assert_eq!(card.tab, tab("b"));
        assert_eq!(card.generation, generation);
    }

    #[test]
    fn a_stale_ticket_or_a_drag_never_shows_a_card() {
        let mut s = StripHover::default();
        ready(&mut s, "a");
        let Next::ShowAfter(ticket) = s.entered(&tab("a"), true) else {
            panic!("waits")
        };
        assert!(!s.show(Some(ticket), true));
        let _ = s.left(&tab("a"));
        assert!(!s.show(Some(ticket), false));
        assert!(s.shown.is_none());
    }

    #[test]
    fn pressing_a_chip_hides_its_card_until_the_pointer_leaves_it() {
        let mut s = StripHover::default();
        ready(&mut s, "a");
        let Next::ShowAfter(ticket) = s.entered(&tab("a"), true) else {
            panic!("waits")
        };
        assert!(s.show(Some(ticket), false));
        s.pressed(&tab("a"));
        assert!(s.shown.is_none());
        assert!(s.leaving.is_some());
        assert_eq!(s.entered(&tab("a"), true), Next::Nothing);
        let _ = s.left(&tab("a"));
        assert!(matches!(s.entered(&tab("a"), true), Next::ShowAfter(_)));
    }

    #[test]
    fn leaving_hides_after_the_leave_delay_unless_the_pointer_comes_back() {
        let mut s = StripHover::default();
        ready(&mut s, "a");
        let Next::ShowAfter(ticket) = s.entered(&tab("a"), true) else {
            panic!("waits")
        };
        assert!(s.show(Some(ticket), false));
        let leave = s.left(&tab("a")).unwrap();
        assert_eq!(s.entered(&tab("a"), true), Next::ShowNow);
        assert!(!s.leave_due(leave));
        assert!(s.shown.is_some());
        let leave = s.left(&tab("a")).unwrap();
        assert!(s.leave_due(leave));
        assert!(s.shown.is_none());
    }

    #[test]
    fn the_setting_off_hides_the_card() {
        let mut s = StripHover::default();
        ready(&mut s, "a");
        let Next::ShowAfter(ticket) = s.entered(&tab("a"), true) else {
            panic!("waits")
        };
        assert!(s.show(Some(ticket), false));
        assert_eq!(s.entered(&tab("a"), false), Next::Nothing);
        assert!(s.shown.is_none());
    }

    #[test]
    fn a_switch_to_an_unplaced_chip_shows_once_it_is_placed() {
        let mut s = StripHover::default();
        ready(&mut s, "a");
        let Next::ShowAfter(ticket) = s.entered(&tab("a"), true) else {
            panic!("waits")
        };
        assert!(s.show(Some(ticket), false));
        let _ = s.left(&tab("a"));
        assert_eq!(s.entered(&tab("b"), true), Next::ShowNow);
        assert!(!s.show(None, false));
        assert_eq!(s.show_when_placed, Some(s.ticket));
    }

    #[test]
    fn the_card_starts_at_the_chip_and_stays_inside_the_window() {
        assert_eq!(card_left(100.0, 220.0, 1200.0), 100.0);
        assert_eq!(card_left(100.0, 400.0, 1200.0), 136.0);
        assert_eq!(card_left(1100.0, 1180.0, 1200.0), 1200.0 - 264.0 - 8.0);
        assert_eq!(card_left(2.0, 40.0, 1200.0), 8.0);
    }
}
