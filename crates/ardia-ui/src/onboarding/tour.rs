use std::cell::RefCell;
use std::collections::HashMap;
use std::time::{Duration, Instant};

use ardia_state::WindowId;
use ardia_theme::motion::Spring;
use ardia_theme::tokens::{radius, space};
use gpui::{
    AnyElement, App, Bounds, FontWeight, Global, IntoElement, ParentElement, Pixels, SharedString,
    Styled, Window, canvas, div, prelude::*,
};

use crate::msg::{Emit, Msg};
use crate::primitives::controls::{PillButton, panel_shadows};
use crate::primitives::theme_bridge::hsla;
use crate::scale::px;
use crate::window::chrome::Chrome;

pub const CARD_WIDTH: f32 = 296.0;
pub const GAP: f32 = 14.0;
pub const MARGIN: f32 = space::L;
pub const SCRIM_REACH: f32 = 6000.0;
pub const RING_OUT: f32 = 3.0;
pub const RING_WIDTH: f32 = 1.5;
pub const TOUR_IN: Duration = Duration::from_millis(250);
pub const TOUR_OUT: Duration = Duration::from_millis(150);
pub const PULSE_MS: f32 = 1100.0;
pub const SMOOTH: Spring = Spring::new(0.4, 0.85);

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Anchor {
    CommandBar,
    Tabs,
    SidebarButton,
    Page,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Placement {
    Below,
    BesideSidebar,
    Inside,
}

#[derive(Clone, Debug, PartialEq)]
pub struct TourStop {
    pub id: &'static str,
    pub title: &'static str,
    pub body: String,
    pub anchor: Option<Anchor>,
    pub placement: Placement,
    pub radius: f32,
    pub pad: f32,
}

pub fn sidebar_body(keys: Option<&str>) -> String {
    match keys {
        Some(keys) => format!("{keys} hides the sidebar. Move the pointer to the window's left edge to peek at your tabs while it's hidden."),
        None => "Hide Tabs hides the sidebar. Move the pointer to the window's left edge to peek at your tabs while it's hidden.".to_owned(),
    }
}

pub fn stops(sidebar_keys: Option<&str>) -> Vec<TourStop> {
    vec![
        TourStop {
            id: "commandBar",
            title: "Search or go anywhere",
            body: "Type a question, an address or the name of an open tab. ⌘L brings the command bar up from any page, and ⌘T opens a new tab.".to_owned(),
            anchor: Some(Anchor::CommandBar),
            placement: Placement::Below,
            radius: 20.0,
            pad: 6.0,
        },
        TourStop {
            id: "tabs",
            title: "Your tabs live in the sidebar",
            body: "New tabs land here. Drag them to reorder or group them; right-click one to pin it, so it's always a click away.".to_owned(),
            anchor: Some(Anchor::Tabs),
            placement: Placement::BesideSidebar,
            radius: 10.0,
            pad: 4.0,
        },
        TourStop {
            id: "sidebar",
            title: "Room to focus",
            body: sidebar_body(sidebar_keys),
            anchor: Some(Anchor::SidebarButton),
            placement: Placement::Below,
            radius: 9.0,
            pad: 3.0,
        },
        TourStop {
            id: "split",
            title: "Two pages, side by side",
            body: "Drag a tab onto the page to split the window, or press ⌃⇧=. ⌃⇧] and ⌃⇧[ move between the panes.".to_owned(),
            anchor: Some(Anchor::Page),
            placement: Placement::Inside,
            radius: 10.0,
            pad: -10.0,
        },
        TourStop {
            id: "done",
            title: "You're all set",
            body: "Everything else is in the menu bar and in Settings (⌘,). You can take this tour again from the Help menu.".to_owned(),
            anchor: None,
            placement: Placement::Below,
            radius: radius::TILE,
            pad: 4.0,
        },
    ]
}

thread_local! {
    static ANCHORS: RefCell<HashMap<(WindowId, Anchor), Rect>> = RefCell::new(HashMap::new());
}

#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct Rect {
    pub x: f32,
    pub y: f32,
    pub w: f32,
    pub h: f32,
}

fn to_rect(bounds: Bounds<Pixels>) -> Rect {
    let scale = crate::scale::current();
    Rect {
        x: f32::from(bounds.origin.x) / scale,
        y: f32::from(bounds.origin.y) / scale,
        w: f32::from(bounds.size.width) / scale,
        h: f32::from(bounds.size.height) / scale,
    }
}

pub fn probe(window: WindowId, anchor: Anchor) -> AnyElement {
    canvas(
        move |bounds, _, _| {
            let rect = to_rect(bounds);
            ANCHORS.with(|map| {
                if rect.w > 0.0 && rect.h > 0.0 {
                    map.borrow_mut().insert((window.clone(), anchor), rect);
                } else {
                    map.borrow_mut().remove(&(window.clone(), anchor));
                }
            });
        },
        |_, _, _, _| {},
    )
    .absolute()
    .inset_0()
    .into_any_element()
}

pub fn forget(window: &WindowId) {
    ANCHORS.with(|map| map.borrow_mut().retain(|(w, _), _| w != window));
}

fn anchor_rect(window: &WindowId, anchor: Anchor) -> Option<Rect> {
    ANCHORS.with(|map| map.borrow().get(&(window.clone(), anchor)).copied())
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Hole {
    pub x: f32,
    pub y: f32,
    pub w: f32,
    pub h: f32,
    pub r: f32,
}

pub fn spotlight(stop: &TourStop, target: Option<Rect>, size: (f32, f32)) -> Hole {
    match (stop.anchor, target) {
        (Some(_), Some(t)) => Hole {
            x: t.x - stop.pad,
            y: t.y - stop.pad,
            w: t.w + stop.pad * 2.0,
            h: t.h + stop.pad * 2.0,
            r: stop.radius + stop.pad.max(0.0),
        },
        _ => Hole {
            x: size.0 / 2.0,
            y: size.1 / 2.0,
            w: 0.0,
            h: 0.0,
            r: 0.0,
        },
    }
}

pub fn place_card(
    stop: &TourStop,
    spot: Hole,
    size: (f32, f32),
    height: f32,
    right_side: bool,
) -> (f32, f32) {
    let clamp_x = |x: f32| x.max(MARGIN).min(MARGIN.max(size.0 - CARD_WIDTH - MARGIN));
    let clamp_y = |y: f32| y.max(MARGIN).min(MARGIN.max(size.1 - height - MARGIN));
    let centre = (
        clamp_x(size.0 / 2.0 - CARD_WIDTH / 2.0),
        clamp_y(size.1 * 0.62 - height / 2.0),
    );
    if stop.anchor.is_none() || spot.w <= 0.0 {
        return centre;
    }
    match stop.placement {
        Placement::BesideSidebar => {
            if right_side {
                let x = spot.x - GAP - CARD_WIDTH;
                if x < MARGIN {
                    return (
                        clamp_x(spot.x + spot.w - CARD_WIDTH),
                        clamp_y(spot.y + spot.h + GAP),
                    );
                }
                return (x, clamp_y(spot.y + spot.h / 2.0 - 36.0));
            }
            let x = spot.x + spot.w + GAP;
            if x + CARD_WIDTH > size.0 - MARGIN {
                return (clamp_x(spot.x), clamp_y(spot.y + spot.h + GAP));
            }
            (x, clamp_y(spot.y + spot.h / 2.0 - 36.0))
        }
        Placement::Inside => (
            clamp_x(spot.x + spot.w / 2.0 - CARD_WIDTH / 2.0),
            clamp_y(spot.y + spot.h * 0.7 - height / 2.0),
        ),
        Placement::Below => {
            let below = spot.y + spot.h + GAP;
            let y = if below + height > size.1 - MARGIN {
                spot.y - GAP - height
            } else {
                below
            };
            let x = if spot.w < CARD_WIDTH / 2.0 {
                spot.x - 10.0
            } else {
                spot.x + spot.w / 2.0 - CARD_WIDTH / 2.0
            };
            (clamp_x(x), clamp_y(y))
        }
    }
}

#[derive(Clone, Copy, Debug)]
struct Sprung {
    from: f32,
    to: f32,
    start: Instant,
}

impl Sprung {
    fn at(value: f32, now: Instant) -> Sprung {
        Sprung {
            from: value,
            to: value,
            start: now,
        }
    }

    fn value(&self, now: Instant) -> f32 {
        let t = now.saturating_duration_since(self.start).as_secs_f64();
        let progress = SMOOTH.value(t, 0.0) as f32;
        self.from + (self.to - self.from) * progress
    }

    fn settled(&self, now: Instant) -> bool {
        now.saturating_duration_since(self.start).as_secs_f64() >= SMOOTH.settling_time(0.001)
    }

    fn aim(&mut self, to: f32, now: Instant) {
        if (self.to - to).abs() > 0.01 {
            *self = Sprung {
                from: self.value(now),
                to,
                start: now,
            };
        }
    }
}

#[derive(Debug)]
pub struct TourState {
    pub window: Option<WindowId>,
    pub stops: Vec<TourStop>,
    pub index: usize,
    pub session: u64,
    pending: Option<Vec<TourStop>>,
    shown_at: Option<Instant>,
    leaving: Option<Instant>,
    springs: Option<[Sprung; 7]>,
    pulse_start: Instant,
    card_height: f32,
}

impl Default for TourState {
    fn default() -> Self {
        TourState {
            window: None,
            stops: Vec::new(),
            index: 0,
            session: 0,
            pending: None,
            shown_at: None,
            leaving: None,
            springs: None,
            pulse_start: Instant::now(),
            card_height: 150.0,
        }
    }
}

impl Global for TourState {}

pub fn start(window: WindowId, sidebar_keys: Option<String>, cx: &mut App) {
    let state = cx.default_global::<TourState>();
    state.session += 1;
    state.window = Some(window);
    state.stops = Vec::new();
    state.index = 0;
    state.pending = Some(stops(sidebar_keys.as_deref()));
    state.shown_at = None;
    state.leaving = None;
    state.springs = None;
    cx.refresh_windows();
}

pub fn end(cx: &mut App) {
    let now = Instant::now();
    let state = cx.default_global::<TourState>();
    if state.window.is_some() && state.leaving.is_none() {
        state.leaving = Some(now);
        state.session += 1;
    }
    cx.refresh_windows();
}

pub fn step(delta: i32, cx: &mut App) {
    let state = cx.default_global::<TourState>();
    let next = state.index as i32 + delta;
    if next >= state.stops.len() as i32 {
        return end(cx);
    }
    state.index = next.max(0) as usize;
    cx.refresh_windows();
}

pub fn active_for(window: &WindowId, cx: &App) -> bool {
    cx.try_global::<TourState>()
        .is_some_and(|s| s.window.as_ref() == Some(window))
}

fn ease_out(t: f32) -> f32 {
    1.0 - (1.0 - t).powi(3)
}

fn ease_in_quad(t: f32) -> f32 {
    t * t
}

pub fn overlay(c: &Chrome, emit: &Emit, window: &mut Window, cx: &mut App) -> Option<AnyElement> {
    let id = c.window.id.clone();
    if !active_for(&id, cx) {
        return None;
    }
    let now = Instant::now();
    let size = (
        f32::from(window.viewport_size().width) / crate::scale::current(),
        f32::from(window.viewport_size().height) / crate::scale::current(),
    );
    let right_side = c.state.sidebar_side(id.as_str()) == ardia_state::model::SidebarSide::Right;
    let state = cx.global_mut::<TourState>();
    if let Some(candidates) = state.pending.take() {
        state.stops = candidates
            .into_iter()
            .filter(|stop| stop.anchor.is_none_or(|a| anchor_rect(&id, a).is_some()))
            .collect();
        state.shown_at = Some(now);
        state.pulse_start = now;
    }
    window.request_animation_frame();
    let presence = match (state.shown_at, state.leaving) {
        (_, Some(at)) => {
            let t = now.saturating_duration_since(at).as_secs_f32() / TOUR_OUT.as_secs_f32();
            if t >= 1.0 {
                state.window = None;
                state.stops.clear();
                state.leaving = None;
                return None;
            }
            1.0 - ease_in_quad(t)
        }
        (Some(at), None) => ease_out(
            (now.saturating_duration_since(at).as_secs_f32() / TOUR_IN.as_secs_f32()).min(1.0),
        ),
        (None, None) => return None,
    };
    let Some(stop) = state
        .stops
        .get(state.index.min(state.stops.len().saturating_sub(1)))
        .cloned()
    else {
        state.window = None;
        return None;
    };
    let target = stop.anchor.and_then(|a| anchor_rect(&id, a));
    let spot = spotlight(&stop, target, size);
    let card = place_card(&stop, spot, size, state.card_height, right_side);
    let goal = [spot.x, spot.y, spot.w, spot.h, spot.r, card.0, card.1];
    let springs = state
        .springs
        .get_or_insert_with(|| goal.map(|v| Sprung::at(v, now)));
    for (spring, to) in springs.iter_mut().zip(goal) {
        spring.aim(to, now);
    }
    let v: Vec<f32> = springs.iter().map(|s| s.value(now)).collect();
    let (hx, hy, hw, hh, hr, cx_, cy_) = (v[0], v[1], v[2], v[3], v[4].max(0.0), v[5], v[6]);
    let pulse_t = (now
        .saturating_duration_since(state.pulse_start)
        .as_secs_f32()
        * 1000.0
        / PULSE_MS)
        .rem_euclid(2.0);
    let sine = |t: f32| -(std::f32::consts::PI * t).cos() / 2.0 + 0.5;
    let pulse = if pulse_t < 1.0 {
        sine(pulse_t)
    } else {
        1.0 - sine(pulse_t - 1.0)
    };
    let count = state.stops.len();
    let index = state.index;
    let last = index + 1 == count;
    let p = *c.p;
    let scrim = hsla(if c.look.dark {
        ardia_theme::RgbaColor::black(0.5)
    } else {
        ardia_theme::RgbaColor::black(0.3)
    });
    let ring = hsla(ardia_theme::RgbaColor::hexa(0xFFFFFFB3));
    let height_probe = {
        canvas(
            |bounds, _, cx: &mut App| {
                let h = f32::from(bounds.size.height) / crate::scale::current();
                if let Some(state) = cx.try_global::<TourState>()
                    && (state.card_height - h).abs() > 0.5
                {
                    cx.global_mut::<TourState>().card_height = h;
                }
            },
            |_, _, _, _| {},
        )
        .absolute()
        .inset_0()
    };
    let skip = emit.clone();
    let back = emit.clone();
    let next = emit.clone();
    let buttons = div()
        .mt(px(space::M))
        .flex()
        .flex_row()
        .items_center()
        .gap(px(space::S))
        .when(!last, |this| {
            this.child(
                div()
                    .id("tour-skip")
                    .debug_selector(|| "tour-skip".into())
                    .cursor_pointer()
                    .text_size(px(13.))
                    .text_color(p.text_tertiary)
                    .on_click(move |_, window, cx| skip.send(Msg::command("tour:end"), window, cx))
                    .child("Skip Tour"),
            )
        })
        .child(div().flex_1())
        .when(index > 0 && !last, |this| {
            this.child(
                PillButton::new("tour-back", "Back", &p).on_click(move |_, window, cx| {
                    back.send(Msg::command("tour:back"), window, cx)
                }),
            )
        })
        .child(
            div().debug_selector(|| "tour-next".into()).child(
                PillButton::new("tour-next", if last { "Done" } else { "Next" }, &p)
                    .primary(true)
                    .on_click(move |_, window, cx| {
                        next.send(Msg::command("tour:next"), window, cx)
                    }),
            ),
        );
    let coach = div()
        .id("tour-card")
        .debug_selector(|| "tour-card".into())
        .absolute()
        .left(px(cx_))
        .top(px(cy_))
        .w(px(CARD_WIDTH))
        .occlude()
        .rounded(px(radius::SHEET))
        .bg(p.popover_fill)
        .border(px(0.5))
        .border_color(p.popover_border)
        .shadow(panel_shadows(&p))
        .px(px(space::XL))
        .py(px(space::XL))
        .flex()
        .flex_col()
        .gap(px(space::M))
        .child(height_probe)
        .child(
            div()
                .text_size(px(10.))
                .font_weight(FontWeight::SEMIBOLD)
                .text_color(p.text_tertiary)
                .child(SharedString::from(format!("{} OF {count}", index + 1))),
        )
        .child(
            div()
                .text_size(px(15.))
                .font_weight(FontWeight::SEMIBOLD)
                .text_color(p.text)
                .child(stop.title),
        )
        .child(
            div()
                .text_size(px(12.))
                .line_height(px(17.))
                .text_color(p.text_secondary)
                .child(SharedString::from(stop.body.clone())),
        )
        .child(buttons);
    let hole = div()
        .absolute()
        .left(px(hx - SCRIM_REACH))
        .top(px(hy - SCRIM_REACH))
        .w(px(hw + SCRIM_REACH * 2.0))
        .h(px(hh + SCRIM_REACH * 2.0))
        .border(px(SCRIM_REACH))
        .rounded(px(hr + SCRIM_REACH))
        .border_color(scrim);
    let ring_el = stop.anchor.map(|_| {
        div()
            .absolute()
            .left(px(hx - RING_OUT))
            .top(px(hy - RING_OUT))
            .w(px(hw + RING_OUT * 2.0))
            .h(px(hh + RING_OUT * 2.0))
            .rounded(px(hr + RING_OUT))
            .border(px(RING_WIDTH))
            .border_color(ring)
            .opacity(0.45 + 0.55 * pulse)
    });
    Some(
        div()
            .id("tour-overlay")
            .absolute()
            .inset_0()
            .opacity(presence)
            .child(hole)
            .children(ring_el)
            .child(coach)
            .into_any_element(),
    )
}

pub fn handle(command: &str, cx: &mut App) -> bool {
    match command {
        "tour:end" => end(cx),
        "tour:back" => step(-1, cx),
        "tour:next" => step(1, cx),
        _ => return false,
    }
    true
}

pub fn springs_settled(cx: &App) -> bool {
    let now = Instant::now();
    cx.try_global::<TourState>()
        .and_then(|s| s.springs)
        .is_none_or(|springs| springs.iter().all(|s| s.settled(now)))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn stop(placement: Placement) -> TourStop {
        TourStop {
            id: "x",
            title: "x",
            body: String::new(),
            anchor: Some(Anchor::CommandBar),
            placement,
            radius: 20.0,
            pad: 6.0,
        }
    }

    #[test]
    fn a_retargeted_spring_moves_from_where_it_was_to_the_new_place() {
        let start = Instant::now();
        let mut spring = Sprung::at(10.0, start);
        spring.aim(110.0, start);
        assert!((spring.value(start) - 10.0).abs() < 1e-3);
        let late = start + Duration::from_secs(3);
        assert!((spring.value(late) - 110.0).abs() < 0.5);
        let mid = spring.value(start + Duration::from_millis(150));
        assert!(mid > 10.0 && mid < 110.0);
    }

    #[test]
    fn the_hole_pads_the_anchor_and_rounds_with_it() {
        let hole = spotlight(
            &stop(Placement::Below),
            Some(Rect {
                x: 100.0,
                y: 50.0,
                w: 400.0,
                h: 30.0,
            }),
            (1200.0, 800.0),
        );
        assert_eq!(
            hole,
            Hole {
                x: 94.0,
                y: 44.0,
                w: 412.0,
                h: 42.0,
                r: 26.0
            }
        );
        let centred = spotlight(&stop(Placement::Below), None, (1200.0, 800.0));
        assert_eq!((centred.x, centred.y, centred.w), (600.0, 400.0, 0.0));
    }

    #[test]
    fn cards_sit_below_beside_or_inside_like_the_old_tour() {
        let size = (1200.0, 800.0);
        let hole = Hole {
            x: 94.0,
            y: 44.0,
            w: 412.0,
            h: 42.0,
            r: 26.0,
        };
        assert_eq!(
            place_card(&stop(Placement::Below), hole, size, 150.0, false),
            (152.0, 100.0)
        );
        let side = Hole {
            x: 8.0,
            y: 80.0,
            w: 180.0,
            h: 34.0,
            r: 14.0,
        };
        assert_eq!(
            place_card(&stop(Placement::BesideSidebar), side, size, 150.0, false),
            (202.0, 61.0)
        );
        let right = Hole {
            x: 1000.0,
            y: 80.0,
            w: 180.0,
            h: 34.0,
            r: 14.0,
        };
        assert_eq!(
            place_card(&stop(Placement::BesideSidebar), right, size, 150.0, true),
            (690.0, 61.0)
        );
        let page = Hole {
            x: 200.0,
            y: 60.0,
            w: 990.0,
            h: 730.0,
            r: 10.0,
        };
        assert_eq!(
            place_card(&stop(Placement::Inside), page, size, 150.0, false),
            (547.0, 496.0)
        );
        let done = TourStop {
            anchor: None,
            ..stop(Placement::Below)
        };
        assert_eq!(place_card(&done, page, size, 150.0, false), (452.0, 421.0));
    }

    #[test]
    fn the_sidebar_stop_names_the_shortcut() {
        assert!(sidebar_body(Some("⌘S")).starts_with("⌘S hides the sidebar."));
        assert!(sidebar_body(None).starts_with("Hide Tabs hides the sidebar."));
        assert_eq!(stops(None).len(), 5);
    }
}
