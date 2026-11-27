use std::cell::RefCell;
use std::collections::HashMap;
use std::time::{Duration, Instant};

use crate::scale::px;
use ardia_state::WindowId;
use ardia_theme::motion::CubicBezier;
use gpui::{AnyElement, IntoElement, Styled, canvas};

use crate::sidebar::strip_layout::{EDGE_FADE, TabWidths};

pub const SLIDE: Duration = Duration::from_millis(200);
pub const APPEAR: Duration = Duration::from_millis(140);
pub const GHOST_FADE: Duration = Duration::from_millis(100);
pub const TOGGLE: Duration = Duration::from_millis(180);
pub const TUCK_FADE: Duration = Duration::from_millis(120);
pub const EDGE_FADE_FLOOR: f32 = 0.25;
pub const EDGE_FADE_ONSET: f32 = 24.0;

pub fn slide_ease(t: f32) -> f32 {
    let t = t.clamp(0.0, 1.0);
    1.0 - (1.0 - t) * (1.0 - t)
}

pub fn appear_ease(t: f32) -> f32 {
    CubicBezier::EASE_OUT.ease(f64::from(t.clamp(0.0, 1.0))) as f32
}

pub fn toggle_ease(t: f32) -> f32 {
    let t = t.clamp(0.0, 1.0);
    1.0 - (1.0 - t).powi(3)
}

fn progress(start: Instant, now: Instant, length: Duration) -> f32 {
    if length.is_zero() {
        return 1.0;
    }
    now.saturating_duration_since(start).as_secs_f32() / length.as_secs_f32()
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Slide {
    pub from: f32,
    pub start: Instant,
}

impl Slide {
    pub fn offset(&self, now: Instant) -> f32 {
        self.from * (1.0 - slide_ease(progress(self.start, now, SLIDE)))
    }

    pub fn done(&self, now: Instant) -> bool {
        progress(self.start, now, SLIDE) >= 1.0
    }
}

#[derive(Clone, Debug)]
pub struct Ghost {
    pub key: String,
    pub x: f32,
    pub width: f32,
    pub title: String,
    pub favicon: crate::primitives::favicon::Favicon,
    pub start: Instant,
}

impl Ghost {
    pub fn opacity(&self, now: Instant) -> f32 {
        1.0 - appear_ease(progress(self.start, now, GHOST_FADE))
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Toggle {
    pub from: f32,
    pub to: f32,
    pub start: Instant,
}

impl Toggle {
    pub fn value(&self, now: Instant) -> f32 {
        self.from + (self.to - self.from) * toggle_ease(progress(self.start, now, TOGGLE))
    }

    pub fn running(&self, now: Instant) -> bool {
        progress(self.start, now, TOGGLE) < 1.0
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Held {
    pub widths: TabWidths,
    pub end: f32,
}

#[derive(Default)]
pub struct StripMotion {
    pub xs: HashMap<String, (f32, f32)>,
    pub slides: HashMap<String, Slide>,
    pub appears: HashMap<String, Instant>,
    pub ghosts: Vec<Ghost>,
    pub groups: HashMap<String, (bool, Toggle, Toggle)>,
    pub held: Option<Held>,
    pub last_widths: Option<Held>,
    pub hovered: bool,
    pub count: usize,
    pub page_width: f32,
    pub seeded: bool,
    pub last: HashMap<String, (String, crate::primitives::favicon::Favicon)>,
}

thread_local! {
    static MOTION: RefCell<HashMap<WindowId, StripMotion>> = RefCell::new(HashMap::new());
}

pub fn with<R>(window: &WindowId, f: impl FnOnce(&mut StripMotion) -> R) -> R {
    MOTION.with(|m| f(m.borrow_mut().entry(window.clone()).or_default()))
}

pub struct Shot {
    pub key: String,
    pub x: f32,
    pub width: f32,
    pub label: Option<(String, crate::primitives::favicon::Favicon)>,
}

pub struct Plan {
    pub moved: Vec<String>,
    pub appeared: Vec<String>,
    pub closed: Vec<String>,
}

pub fn plan(before: &HashMap<String, (f32, f32)>, after: &[Shot], viewport: (f32, f32)) -> Plan {
    let seen = |x: f32, w: f32| x + w > viewport.0 - 48.0 && x < viewport.1 + 48.0;
    let keys: Vec<&String> = after.iter().map(|s| &s.key).collect();
    let moved = after
        .iter()
        .filter(|s| {
            before
                .get(&s.key)
                .is_some_and(|(x, _)| (x - s.x).abs() > 0.25)
        })
        .map(|s| s.key.clone())
        .collect();
    let appeared = after
        .iter()
        .filter(|s| !before.contains_key(&s.key) && seen(s.x, s.width))
        .map(|s| s.key.clone())
        .collect();
    let closed = before
        .iter()
        .filter(|(k, (x, w))| !keys.contains(k) && seen(*x, *w))
        .map(|(k, _)| k.clone())
        .collect();
    Plan {
        moved,
        appeared,
        closed,
    }
}

impl StripMotion {
    pub fn advance(
        &mut self,
        shots: Vec<Shot>,
        page_width: f32,
        viewport: (f32, f32),
        now: Instant,
        still: bool,
    ) {
        let resized = (self.page_width - page_width).abs() > 0.5;
        self.page_width = page_width;
        if !self.seeded || resized || still {
            self.seeded = true;
            self.slides.clear();
            self.appears.clear();
            self.ghosts.clear();
        } else {
            let plan = plan(&self.xs, &shots, viewport);
            for key in plan.moved {
                let Some(new) = shots.iter().find(|s| s.key == key) else {
                    continue;
                };
                let (old, _) = self.xs[&key];
                let shown = old + self.slides.get(&key).map_or(0.0, |s| s.offset(now));
                self.slides.insert(
                    key,
                    Slide {
                        from: shown - new.x,
                        start: now,
                    },
                );
            }
            for key in plan.appeared.into_iter().filter(|k| !k.starts_with('~')) {
                ardia_telemetry::counts::count("tab_strip_open_motions");
                self.appears.insert(key, now);
            }
            ardia_telemetry::counts::add("tab_strip_close_motions", plan.closed.len() as u64);
            for key in plan.closed {
                let (x, width) = self.xs[&key];
                if let Some((title, favicon)) = self.last.get(&key).cloned() {
                    self.ghosts.push(Ghost {
                        key: key.clone(),
                        x,
                        width,
                        title,
                        favicon,
                        start: now,
                    });
                }
            }
        }
        self.slides.retain(|_, s| !s.done(now));
        self.appears
            .retain(|_, at| progress(*at, now, APPEAR) < 1.0);
        self.ghosts
            .retain(|g| progress(g.start, now, GHOST_FADE) < 1.0);
        self.xs = shots
            .iter()
            .map(|s| (s.key.clone(), (s.x, s.width)))
            .collect();
        self.last = shots
            .into_iter()
            .filter_map(|s| s.label.map(|l| (s.key, l)))
            .collect();
    }

    pub fn offset(&self, key: &str, now: Instant) -> f32 {
        self.slides.get(key).map_or(0.0, |s| s.offset(now))
    }

    pub fn shown(&self, key: &str, now: Instant) -> f32 {
        self.appears
            .get(key)
            .map_or(1.0, |at| appear_ease(progress(*at, now, APPEAR)))
    }

    pub fn running(&self, now: Instant) -> bool {
        !self.slides.is_empty()
            || !self.appears.is_empty()
            || !self.ghosts.is_empty()
            || self
                .groups
                .values()
                .any(|(_, a, b)| a.running(now) || b.running(now))
    }

    pub fn group(
        &mut self,
        key: &str,
        expanded: bool,
        width: f32,
        now: Instant,
        still: bool,
    ) -> (f32, f32) {
        let open = if expanded { 1.0 } else { 0.0 };
        let entry = self.groups.entry(key.to_owned()).or_insert((
            expanded,
            Toggle {
                from: open,
                to: open,
                start: now,
            },
            Toggle {
                from: width,
                to: width,
                start: now,
            },
        ));
        if still {
            *entry = (
                expanded,
                Toggle {
                    from: open,
                    to: open,
                    start: now,
                },
                Toggle {
                    from: width,
                    to: width,
                    start: now,
                },
            );
        } else {
            if entry.0 != expanded || (entry.1.to - open).abs() > f32::EPSILON {
                entry.1 = Toggle {
                    from: entry.1.value(now),
                    to: open,
                    start: now,
                };
                entry.0 = expanded;
            }
            if (entry.2.to - width).abs() > 0.25 {
                entry.2 = Toggle {
                    from: entry.2.value(now),
                    to: width,
                    start: now,
                };
            }
        }
        (entry.1.value(now), entry.2.value(now))
    }

    pub fn hold(&mut self, count: usize) -> Option<Held> {
        let closed_while_in = self.hovered && count < self.count;
        if closed_while_in && self.held.is_none() {
            self.held = self.last_widths;
        }
        if count > self.count {
            self.held = None;
        }
        self.count = count;
        self.held
    }

    pub fn remember(&mut self, widths: TabWidths, end: f32) {
        self.last_widths = Some(Held { widths, end });
    }
}

pub fn edge_strength(scroll: f32, viewport: f32, content: f32) -> (f32, f32) {
    let last = (content - viewport).max(0.0);
    (
        (scroll / EDGE_FADE_ONSET).clamp(0.0, 1.0),
        ((last - scroll) / EDGE_FADE_ONSET).clamp(0.0, 1.0),
    )
}

pub fn edge_mask_at(x: f32, width: f32, strength: (f32, f32)) -> f32 {
    let from_left = (1.0 - x / EDGE_FADE).clamp(0.0, 1.0) * strength.0;
    let from_right = (1.0 - (width - x) / EDGE_FADE).clamp(0.0, 1.0) * strength.1;
    1.0 - (1.0 - EDGE_FADE_FLOOR) * (from_left + from_right).min(1.0)
}

pub fn frame_driver(running: bool) -> AnyElement {
    canvas(
        move |_, window, _| {
            if running {
                window.request_animation_frame();
            }
        },
        |_, _, _, _| {},
    )
    .absolute()
    .size(px(0.))
    .into_any_element()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn slides_start_where_the_chip_was_and_settle_without_overshoot() {
        let now = Instant::now();
        let slide = Slide {
            from: -177.0,
            start: now,
        };
        assert_eq!(slide.offset(now), -177.0);
        let mid = slide.offset(now + SLIDE / 2);
        assert!(mid > -177.0 && mid < 0.0);
        assert_eq!(slide.offset(now + SLIDE), 0.0);
        assert!(slide.done(now + SLIDE));
    }

    #[test]
    fn closing_a_tab_slides_the_rest_and_leaves_a_ghost() {
        let now = Instant::now();
        let mut m = StripMotion::default();
        let shot = |k: &str, x: f32| Shot {
            key: k.into(),
            x,
            width: 173.0,
            label: Some((k.into(), crate::primitives::favicon::Favicon::Letter('a'))),
        };
        m.advance(
            vec![shot("a", 0.0), shot("b", 177.0), shot("c", 354.0)],
            900.0,
            (0.0, 900.0),
            now,
            false,
        );
        assert!(!m.running(now));
        m.advance(
            vec![shot("a", 0.0), shot("c", 177.0)],
            900.0,
            (0.0, 900.0),
            now,
            false,
        );
        assert_eq!(m.offset("c", now), 177.0);
        assert_eq!(m.ghosts.len(), 1);
        assert!(m.running(now));
        m.advance(
            vec![shot("a", 0.0), shot("c", 177.0), shot("d", 354.0)],
            900.0,
            (0.0, 900.0),
            now + SLIDE,
            false,
        );
        assert!(m.shown("d", now + SLIDE) < 0.01);
        assert!((m.shown("d", now + SLIDE + APPEAR) - 1.0).abs() < 1e-4);
    }

    #[test]
    fn group_toggles_glide_in_180ms() {
        let now = Instant::now();
        let mut m = StripMotion::default();
        assert_eq!(m.group("g", false, 50.0, now, false), (0.0, 50.0));
        let (open, width) = m.group("g", true, 400.0, now, false);
        assert_eq!((open, width), (0.0, 50.0));
        let (open, width) = m.group("g", true, 400.0, now + TOGGLE, false);
        assert_eq!((open, width), (1.0, 400.0));
    }

    #[test]
    fn widths_hold_after_a_close_while_the_pointer_is_in() {
        let mut m = StripMotion::default();
        let w = TabWidths {
            chip: 100.0,
            titled: 100.0,
            selected: 173.0,
        };
        assert_eq!(m.hold(5), None);
        m.remember(w, 600.0);
        m.hovered = true;
        assert_eq!(
            m.hold(4),
            Some(Held {
                widths: w,
                end: 600.0
            })
        );
        m.hovered = false;
        m.held = None;
        assert_eq!(m.hold(4), None);
    }

    #[test]
    fn edges_fade_to_the_floor_only_where_more_tabs_hide() {
        assert_eq!(edge_strength(0.0, 500.0, 500.0), (0.0, 0.0));
        let s = edge_strength(100.0, 500.0, 1000.0);
        assert_eq!(s, (1.0, 1.0));
        assert!((edge_mask_at(0.0, 500.0, s) - EDGE_FADE_FLOOR).abs() < 1e-6);
        assert_eq!(edge_mask_at(250.0, 500.0, s), 1.0);
    }
}
