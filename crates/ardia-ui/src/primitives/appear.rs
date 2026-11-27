use std::cell::RefCell;
use std::collections::HashMap;
use std::time::Duration;

use gpui::{
    Animation, AnimationExt, AnyElement, ElementId, IntoElement, ParentElement, Styled, canvas,
    div, prelude::*,
};

use crate::primitives::tokens::{Curve, duration};
use crate::scale::px;

pub const SHRUNK: f32 = 0.94;
pub const SPRING_REST: f32 = 0.999;

pub fn timing_default(t: f32) -> f32 {
    let ease = |x: f32| {
        ardia_theme::motion::CubicBezier::new(0.42, 0.0, 1.0, 1.0).ease(f64::from(x)) as f32
    };
    let t = t.clamp(0.0, 1.0);
    if t < 0.5 {
        ease(t * 2.0) / 2.0
    } else {
        1.0 - ease((1.0 - t) * 2.0) / 2.0
    }
}

pub fn spring_remaining(seconds: f32, response: f32) -> f32 {
    if seconds <= 0.0 || response <= 0.0 {
        return 1.0;
    }
    let w = std::f32::consts::TAU / response;
    (1.0 + w * seconds) * (-w * seconds).exp()
}

pub fn spring_span(response: f32) -> Duration {
    let mut t = 0.0f32;
    while 1.0 - spring_remaining(t, response) < SPRING_REST && t < 5.0 {
        t += 0.001;
    }
    Duration::from_secs_f32(t)
}

pub fn spring_ease(response: f32) -> (Duration, impl Fn(f32) -> f32 + Clone + 'static) {
    let span = spring_span(response);
    let seconds = span.as_secs_f32();
    (span, move |t: f32| {
        if t >= 1.0 {
            1.0
        } else {
            1.0 - spring_remaining(t * seconds, response)
        }
    })
}
pub const SHIFT: f32 = 4.0;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum OriginX {
    Left,
    Centre,
    Right,
    At(i32),
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Rise {
    pub scaled: bool,
    pub upward: bool,
    pub origin: OriginX,
}

impl Rise {
    pub const fn popover(origin: OriginX, upward: bool) -> Self {
        Rise {
            scaled: true,
            upward,
            origin,
        }
    }

    pub const fn lift(upward: bool) -> Self {
        Rise {
            scaled: false,
            upward,
            origin: OriginX::Left,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Pose {
    pub opacity: f32,
    pub scale: f32,
    pub dx: f32,
    pub dy: f32,
}

pub fn pose(rise: Rise, t: f32, size: Option<(f32, f32)>) -> Pose {
    let t = t.clamp(0.0, 1.0);
    let scale = if rise.scaled {
        SHRUNK + (1.0 - SHRUNK) * t
    } else {
        1.0
    };
    let (w, h) = size.unwrap_or((0.0, 0.0));
    let origin_x = match rise.origin {
        OriginX::Left => 0.0,
        OriginX::Centre => w / 2.0,
        OriginX::Right => w,
        OriginX::At(x) => x as f32,
    };
    let origin_y = if rise.upward { h } else { 0.0 };
    let lift = if rise.upward { SHIFT } else { -SHIFT };
    Pose {
        opacity: t,
        scale,
        dx: (1.0 - scale) * (origin_x - w / 2.0),
        dy: (1.0 - scale) * (origin_y - h / 2.0) + lift * (1.0 - t),
    }
}

thread_local! {
    static SIZES: RefCell<HashMap<ElementId, (f32, f32)>> = RefCell::new(HashMap::new());
}

fn measured(id: &ElementId) -> Option<(f32, f32)> {
    SIZES.with(|s| s.borrow().get(id).copied())
}

fn measure(id: ElementId) -> impl IntoElement {
    canvas(
        move |bounds, _, _| {
            let size = (
                crate::scale::points(bounds.size.width),
                crate::scale::points(bounds.size.height),
            );
            SIZES.with(|s| {
                let mut sizes = s.borrow_mut();
                if sizes.len() > 256 {
                    sizes.clear();
                }
                sizes.insert(id.clone(), size);
            });
        },
        |_, _, _, _| {},
    )
    .absolute()
    .inset_0()
}

pub fn rise(id: impl Into<ElementId>, element: impl IntoElement, rise: Rise) -> AnyElement {
    rise_over(id, element, rise, duration::BASE, Curve::Enter)
}

pub fn rise_over(
    id: impl Into<ElementId>,
    element: impl IntoElement,
    rise: Rise,
    length: Duration,
    curve: Curve,
) -> AnyElement {
    let id: ElementId = id.into();
    let key = id.clone();
    div()
        .relative()
        .child(element)
        .child(measure(id.clone()))
        .with_animation(
            id,
            Animation::new(length).with_easing(move |t| curve.ease(t)),
            move |el, t| {
                let pose = pose(rise, t, measured(&key));
                el.opacity(pose.opacity)
                    .when(rise.scaled, |el| el.scale(pose.scale))
                    .left(px(pose.dx))
                    .top(px(pose.dy))
            },
        )
        .into_any_element()
}

pub fn fall(element: impl IntoElement, rise: Rise, t: f32, size: Option<(f32, f32)>) -> AnyElement {
    let pose = pose(rise, t, size);
    div()
        .relative()
        .opacity(pose.opacity)
        .when(rise.scaled, |el| el.scale(pose.scale))
        .left(px(pose.dx))
        .top(px(pose.dy))
        .child(element)
        .into_any_element()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_popover_grows_from_its_anchor_corner_and_drops_four_points() {
        let start = pose(
            Rise::popover(OriginX::Right, false),
            0.0,
            Some((300.0, 200.0)),
        );
        assert_eq!(start.opacity, 0.0);
        assert!((start.scale - SHRUNK).abs() < 1e-6);
        assert!((start.dx - 0.06 * 150.0).abs() < 1e-4);
        assert!((start.dy - (-0.06 * 100.0 - SHIFT)).abs() < 1e-4);
        let end = pose(
            Rise::popover(OriginX::Right, false),
            1.0,
            Some((300.0, 200.0)),
        );
        assert_eq!(
            end,
            Pose {
                opacity: 1.0,
                scale: 1.0,
                dx: 0.0,
                dy: 0.0
            }
        );
    }

    #[test]
    fn an_upward_popover_rises_from_its_bottom_edge() {
        let start = pose(
            Rise::popover(OriginX::Left, true),
            0.0,
            Some((200.0, 100.0)),
        );
        assert!((start.dx - (-0.06 * 100.0)).abs() < 1e-4);
        assert!((start.dy - (0.06 * 50.0 + SHIFT)).abs() < 1e-4);
    }

    #[test]
    fn the_critical_spring_matches_the_peek_scrim_response() {
        assert_eq!(spring_remaining(0.0, 0.26), 1.0);
        let mid = 1.0 - spring_remaining(0.065, 0.26);
        assert!((mid - 0.465).abs() < 0.01, "{mid}");
        let (span, ease) = spring_ease(0.26);
        assert!(span.as_millis() > 300 && span.as_millis() < 450, "{span:?}");
        assert_eq!(ease(1.0), 1.0);
        assert!(ease(0.5) > 0.9);
    }

    #[test]
    fn the_default_timing_curve_is_symmetric_ease_in_out() {
        assert_eq!(timing_default(0.0), 0.0);
        assert_eq!(timing_default(1.0), 1.0);
        assert!((timing_default(0.5) - 0.5).abs() < 1e-4);
        assert!(timing_default(0.25) < 0.25);
        assert!((timing_default(0.25) + timing_default(0.75) - 1.0).abs() < 1e-4);
    }

    #[test]
    fn a_lift_only_moves_and_fades() {
        let mid = pose(Rise::lift(false), 0.5, Some((200.0, 100.0)));
        assert_eq!(mid.scale, 1.0);
        assert_eq!(mid.dx, 0.0);
        assert!((mid.dy + 2.0).abs() < 1e-4);
    }

    #[test]
    fn the_popover_curves_match_the_old_motion_tokens() {
        assert_eq!(duration::BASE.as_millis(), 150);
        assert_eq!(duration::FAST.as_millis(), 100);
        assert!((Curve::Enter.ease(0.5) - 0.875).abs() < 1e-4);
        assert!((Curve::Exit.ease(0.5) - 0.25).abs() < 1e-4);
    }
}
