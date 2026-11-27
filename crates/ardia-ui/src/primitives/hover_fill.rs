use std::sync::Arc;
use std::time::{Duration, Instant};

use ardia_state::settings::PressMotion;
use ardia_theme::motion::Spring;
use gpui::{
    App, Div, ElementId, Entity, Global, InteractiveElement, MouseButton, Stateful,
    StatefulInteractiveElement, Window,
};

use crate::primitives::controls::hover_fill_tween;
use crate::primitives::tokens::{SNAPPY, Tween};

pub mod press_motion {
    use std::time::Duration;

    use ardia_theme::motion::Spring;

    pub const PRESS: Spring = Spring::new(0.12, 1.0);
    pub const RELEASE: Spring = Spring::new(0.28, 0.55);
    pub const BOUNCE_ICON_SCALE: f32 = 0.9;
    pub const BOUNCE_CONTROL_SCALE: f32 = 0.97;
    pub const SHORTEST_PRESS: Duration = Duration::from_millis(90);
    pub const STILL_REST: f32 = 0.001;
    pub const BOUNCE_REST: f32 = 0.0001;
}

pub struct PressMotionNow(pub PressMotion);

impl Global for PressMotionNow {}

pub fn press_motion(cx: &App) -> PressMotion {
    cx.try_global::<PressMotionNow>()
        .map_or(PressMotion::Still, |now| now.0)
}

pub fn set_press_motion(motion: PressMotion, cx: &mut App) {
    if press_motion(cx) != motion || !cx.has_global::<PressMotionNow>() {
        cx.set_global(PressMotionNow(motion));
    }
}

pub fn bounce_dip(pressed_scale: f32) -> f32 {
    use crate::primitives::tokens::press_scale;
    if pressed_scale == press_scale::ICON {
        press_motion::BOUNCE_ICON_SCALE
    } else if pressed_scale == press_scale::CONTROL {
        press_motion::BOUNCE_CONTROL_SCALE
    } else {
        pressed_scale
    }
}

pub fn release_delay(held: Duration) -> Duration {
    press_motion::SHORTEST_PRESS.saturating_sub(held)
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct ScaleSpring {
    from: f32,
    to: f32,
    velocity: f32,
    started: Option<Instant>,
    spring: Spring,
    rest: f32,
}

impl ScaleSpring {
    pub fn at(value: f32) -> Self {
        ScaleSpring {
            from: value,
            to: value,
            velocity: 0.0,
            started: None,
            spring: SNAPPY,
            rest: press_motion::STILL_REST,
        }
    }

    fn position(&self, seconds: f64) -> f32 {
        let span = self.to - self.from;
        if span == 0.0 {
            return self.to;
        }
        let progress = self.spring.value(seconds, f64::from(self.velocity / span));
        self.from + span * progress as f32
    }

    fn elapsed(&self, now: Instant) -> Option<f64> {
        self.started
            .map(|started| now.saturating_duration_since(started).as_secs_f64())
    }

    fn speed(&self, seconds: f64) -> f32 {
        let step = 0.001;
        let before = self.position((seconds - step).max(0.0));
        let after = self.position(seconds + step);
        (after - before) / ((seconds + step) - (seconds - step).max(0.0)) as f32
    }

    fn at_rest(&self, seconds: f64) -> bool {
        (self.position(seconds) - self.to).abs() <= self.rest
            && self.speed(seconds).abs() <= self.rest
    }

    pub fn value(&self, now: Instant) -> f32 {
        match self.elapsed(now) {
            Some(seconds) if !self.at_rest(seconds) => self.position(seconds),
            _ => self.to,
        }
    }

    pub fn velocity(&self, now: Instant) -> f32 {
        match self.elapsed(now) {
            Some(seconds) if !self.at_rest(seconds) => self.speed(seconds),
            _ => 0.0,
        }
    }

    pub fn running(&self, now: Instant) -> bool {
        self.elapsed(now)
            .is_some_and(|seconds| !self.at_rest(seconds))
    }

    pub fn start(&mut self, to: f32, spring: Spring, rest: f32, carry: bool, now: Instant) {
        let from = self.value(now);
        let velocity = if carry { self.velocity(now) } else { 0.0 };
        *self = ScaleSpring {
            from,
            to,
            velocity,
            started: Some(now),
            spring,
            rest,
        };
    }

    pub fn jump(&mut self, to: f32) {
        *self = ScaleSpring::at(to);
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Interaction {
    pub hovered: bool,
    pub pressed: bool,
    pub fill: f32,
    pub scale: f32,
    pub moving: bool,
}

pub struct PressState {
    hovered: bool,
    pressed: bool,
    shown: Option<(bool, bool)>,
    fill: Tween,
    scale: ScaleSpring,
    press_scale: Option<f32>,
    motion: PressMotion,
    pressed_at: Option<Instant>,
    release_at: Option<Instant>,
}

impl Default for PressState {
    fn default() -> Self {
        PressState {
            hovered: false,
            pressed: false,
            shown: None,
            fill: Tween::at(0.0),
            scale: ScaleSpring::at(1.0),
            press_scale: None,
            motion: PressMotion::Still,
            pressed_at: None,
            release_at: None,
        }
    }
}

impl PressState {
    pub fn hovered(&self) -> bool {
        self.hovered
    }

    pub fn pressed(&self) -> bool {
        self.pressed
    }

    pub fn set_press_scale(&mut self, scale: Option<f32>) {
        self.press_scale = scale;
        if scale.is_none() {
            self.release_at = None;
            self.scale.jump(1.0);
        }
    }

    pub fn set_motion(&mut self, motion: PressMotion) {
        self.motion = motion;
    }

    pub fn set_hovered(&mut self, hovered: bool, now: Instant) {
        self.hovered = hovered;
        if !hovered && self.pressed {
            self.set_pressed(false, now);
        }
    }

    pub fn set_pressed(&mut self, pressed: bool, now: Instant) {
        self.pressed = pressed;
        self.release_at = None;
        let Some(pressed_scale) = self.press_scale else {
            return;
        };
        match self.motion {
            PressMotion::Still => self.scale.jump(if pressed { pressed_scale } else { 1.0 }),
            PressMotion::Bounce if pressed => {
                self.pressed_at = Some(now);
                self.settle(true, now);
            }
            PressMotion::Bounce => {
                let held = self
                    .pressed_at
                    .map_or(Duration::MAX, |at| now.saturating_duration_since(at));
                let wait = release_delay(held);
                if wait.is_zero() {
                    self.settle(false, now);
                } else {
                    self.release_at = Some(now + wait);
                }
            }
        }
    }

    fn settle(&mut self, pressed: bool, now: Instant) {
        let Some(pressed_scale) = self.press_scale else {
            return;
        };
        let (to, spring) = if pressed {
            (bounce_dip(pressed_scale), press_motion::PRESS)
        } else {
            (1.0, press_motion::RELEASE)
        };
        self.scale
            .start(to, spring, press_motion::BOUNCE_REST, true, now);
    }

    fn release_due(&mut self, now: Instant) {
        let Some(at) = self.release_at.filter(|at| *at <= now) else {
            return;
        };
        self.release_at = None;
        match self.motion {
            PressMotion::Bounce => self.settle(false, at),
            PressMotion::Still => self.scale.jump(1.0),
        }
    }

    pub fn resolve(&mut self, shown: bool, instant: bool, now: Instant) -> Interaction {
        if self.shown != Some((shown, instant)) {
            let first = self.shown.is_none();
            self.shown = Some((shown, instant));
            hover_fill_tween(&mut self.fill, shown, instant || first, now);
        }
        self.release_due(now);
        let fill = self.fill.value(now);
        let scale = self.scale.value(now);
        Interaction {
            hovered: self.hovered,
            pressed: self.pressed,
            fill,
            scale,
            moving: self.fill.running(now) || self.scale.running(now) || self.release_at.is_some(),
        }
    }
}

pub fn state_key(id: &ElementId) -> ElementId {
    ElementId::NamedChild(Arc::new(id.clone()), "press-state".into())
}

pub fn press_state(id: &ElementId, window: &mut Window, cx: &mut App) -> Entity<PressState> {
    window.use_keyed_state(state_key(id), cx, |_, _| PressState::default())
}

pub fn resolve_interaction(
    state: &Entity<PressState>,
    shown: impl FnOnce(bool, bool) -> bool,
    instant: bool,
    window: &mut Window,
    cx: &mut App,
) -> Interaction {
    let quiet = cx.reduce_motion();
    let now = Instant::now();
    let interaction = state.update(cx, |state, _| {
        let shown = shown(state.hovered(), state.pressed());
        state.resolve(shown, instant || quiet, now)
    });
    if quiet {
        return Interaction {
            scale: 1.0,
            moving: false,
            ..interaction
        };
    }
    if interaction.moving {
        window.request_animation_frame();
    }
    interaction
}

pub fn track_press(
    element: Stateful<Div>,
    state: &Entity<PressState>,
    press_scale: Option<f32>,
    cx: &mut App,
) -> Stateful<Div> {
    let motion = press_motion(cx);
    state.update(cx, |state, _| {
        state.set_motion(motion);
        state.set_press_scale(press_scale);
    });
    let hover_state = state.clone();
    let down_state = state.clone();
    let up_state = state.clone();
    let out_state = state.clone();
    let release = |state: &Entity<PressState>, cx: &mut App| {
        state.update(cx, |state, cx| {
            if state.pressed() {
                state.set_pressed(false, Instant::now());
                cx.notify();
            }
        });
    };
    element
        .on_hover(move |hovered, _, cx| {
            hover_state.update(cx, |state, cx| {
                state.set_hovered(*hovered, Instant::now());
                cx.notify();
            });
        })
        .capture_any_mouse_down(move |event, _, cx| {
            if event.button == MouseButton::Left {
                down_state.update(cx, |state, cx| {
                    state.set_pressed(true, Instant::now());
                    cx.notify();
                });
            }
        })
        .capture_any_mouse_up(move |event, _, cx| {
            if event.button == MouseButton::Left {
                release(&up_state, cx);
            }
        })
        .on_mouse_up_out(MouseButton::Left, move |_, _, cx| release(&out_state, cx))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::primitives::tokens::press_scale;
    use std::time::Duration;

    #[test]
    fn hover_fill_fades_in_in_fifty_ms_and_out_in_two_hundred() {
        let start = Instant::now();
        let mut state = PressState::default();
        assert_eq!(state.resolve(false, false, start).fill, 0.0);
        let rising = state.resolve(true, false, start);
        assert_eq!(rising.fill, 0.0);
        assert!(rising.moving);
        let midway = state
            .resolve(true, false, start + Duration::from_millis(25))
            .fill;
        assert!(midway > 0.5 && midway < 0.8, "{midway}");
        let shown = state.resolve(true, false, start + Duration::from_millis(50));
        assert_eq!(shown.fill, 1.0);
        assert!(!shown.moving);
        let at = start + Duration::from_millis(60);
        state.resolve(false, false, at);
        let fading = state.resolve(false, false, at + Duration::from_millis(100));
        assert!(fading.fill > 0.0 && fading.fill < 1.0 && fading.moving);
        assert_eq!(
            state
                .resolve(false, false, at + Duration::from_millis(200))
                .fill,
            0.0
        );
    }

    #[test]
    fn active_buttons_fill_at_once_and_first_frames_do_not_fade() {
        let start = Instant::now();
        let mut toggled = PressState::default();
        assert_eq!(toggled.resolve(true, false, start).fill, 1.0);
        let mut instant = PressState::default();
        instant.resolve(false, false, start);
        assert_eq!(instant.resolve(true, true, start).fill, 1.0);
    }

    #[test]
    fn still_press_snaps_to_the_pressed_scale_and_back_like_the_measured_old_app() {
        let start = Instant::now();
        let mut state = PressState::default();
        state.set_press_scale(Some(press_scale::CONTROL));
        state.set_hovered(true, start);
        state.set_pressed(true, start);
        assert!(state.pressed());
        let pressed = state.resolve(true, false, start);
        assert_eq!(pressed.scale, press_scale::CONTROL);
        assert!(
            !state
                .resolve(true, false, start + Duration::from_millis(60))
                .moving
        );
        let leave = start + Duration::from_millis(600);
        state.set_hovered(false, leave);
        assert!(!state.pressed());
        let released = state.resolve(false, false, leave);
        assert_eq!(released.scale, 1.0);
    }

    #[test]
    fn buttons_without_a_press_scale_never_scale() {
        let start = Instant::now();
        let mut state = PressState::default();
        state.set_press_scale(None);
        state.set_pressed(true, start);
        assert_eq!(
            state
                .resolve(true, false, start + Duration::from_millis(30))
                .scale,
            1.0
        );
    }

    #[test]
    fn bounce_press_dips_deeper_and_holds_the_release_until_ninety_ms() {
        let start = Instant::now();
        let mut state = PressState::default();
        state.set_motion(PressMotion::Bounce);
        state.set_press_scale(Some(press_scale::CONTROL));
        state.set_pressed(true, start);
        let held = state.resolve(true, false, start + Duration::from_millis(500));
        assert_eq!(held.scale, press_motion::BOUNCE_CONTROL_SCALE);
        let quick = Instant::now();
        let mut tap = PressState::default();
        tap.set_motion(PressMotion::Bounce);
        tap.set_press_scale(Some(press_scale::ICON));
        tap.set_pressed(true, quick);
        tap.set_pressed(false, quick + Duration::from_millis(30));
        let waiting = tap.resolve(true, false, quick + Duration::from_millis(80));
        assert!(waiting.moving);
        assert!(waiting.scale < 1.0);
        let dip = tap
            .resolve(true, false, quick + Duration::from_millis(89))
            .scale;
        let rebound: Vec<f32> = (90..600)
            .step_by(8)
            .map(|ms| {
                tap.resolve(true, false, quick + Duration::from_millis(ms))
                    .scale
            })
            .collect();
        assert!(rebound.iter().any(|s| *s > 1.0), "release overshoots");
        assert!(rebound[0] <= dip + 0.01);
        assert_eq!(
            tap.resolve(true, false, quick + Duration::from_millis(2000))
                .scale,
            1.0
        );
    }

    #[test]
    fn bounce_dips_map_the_still_scales() {
        assert_eq!(bounce_dip(press_scale::ICON), 0.9);
        assert_eq!(bounce_dip(press_scale::CONTROL), 0.97);
        assert_eq!(bounce_dip(0.5), 0.5);
        assert_eq!(
            release_delay(Duration::from_millis(30)),
            Duration::from_millis(60)
        );
        assert_eq!(release_delay(Duration::from_millis(200)), Duration::ZERO);
    }

    #[test]
    fn release_springs_carry_the_press_velocity() {
        let start = Instant::now();
        let mut spring = ScaleSpring::at(1.0);
        spring.start(
            0.9,
            press_motion::PRESS,
            press_motion::BOUNCE_REST,
            true,
            start,
        );
        let at = start + Duration::from_millis(20);
        let falling = spring.velocity(at);
        assert!(falling < 0.0);
        spring.start(
            1.0,
            press_motion::RELEASE,
            press_motion::BOUNCE_REST,
            true,
            at,
        );
        assert!(
            (spring.velocity(at + Duration::from_millis(1)) - falling).abs() < falling.abs() * 0.5
        );
    }

    struct PressProbe {
        state: Entity<PressState>,
        clicks: std::rc::Rc<std::cell::Cell<usize>>,
    }

    impl gpui::Render for PressProbe {
        fn render(
            &mut self,
            _: &mut Window,
            cx: &mut gpui::Context<Self>,
        ) -> impl gpui::IntoElement {
            use gpui::{ParentElement, Styled, div, px};
            let clicks = self.clicks.clone();
            div().size_full().child(
                track_press(
                    div().id("probe"),
                    &self.state,
                    Some(press_scale::CONTROL),
                    cx,
                )
                .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
                .on_click(move |_, _, cx| {
                    cx.stop_propagation();
                    clicks.set(clicks.get() + 1);
                })
                .absolute()
                .left(px(10.))
                .top(px(10.))
                .size(px(40.)),
            )
        }
    }

    #[gpui::test]
    fn presses_register_even_when_the_button_stops_propagation(cx: &mut gpui::TestAppContext) {
        use gpui::AppContext as _;
        let clicks = std::rc::Rc::new(std::cell::Cell::new(0));
        let state = cx.update(|cx| cx.new(|_| PressState::default()));
        let probe_state = state.clone();
        let probe_clicks = clicks.clone();
        let window = cx.add_window(move |_, _| PressProbe {
            state: probe_state,
            clicks: probe_clicks,
        });
        let mut visual = gpui::VisualTestContext::from_window(window.into(), cx);
        visual.run_until_parked();
        let at = gpui::point(gpui::px(30.), gpui::px(30.));
        visual.simulate_mouse_move(at, None, gpui::Modifiers::none());
        visual.simulate_mouse_down(at, MouseButton::Left, gpui::Modifiers::none());
        visual.run_until_parked();
        assert!(visual.update(|_, cx| state.read(cx).pressed()));
        visual.simulate_mouse_up(at, MouseButton::Left, gpui::Modifiers::none());
        visual.run_until_parked();
        assert!(!visual.update(|_, cx| state.read(cx).pressed()));
        assert_eq!(clicks.get(), 1);
    }
}
