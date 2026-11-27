use std::time::{Duration, Instant};

use gpui::{BackdropGradient, BackdropGradients, BackdropLayerSpec, Pixels, Point, Rgba, Window};

use crate::primitives::theme_bridge::blend_backdrops;
use crate::window::motion::Curve;

pub const CROSS_FADE: Duration = Duration::from_millis(ardia_theme::motion::PROFILE_SETTLE_MS);

#[derive(Default)]
pub struct BackdropDriver {
    shown: Option<BackdropLayerSpec>,
    target: Option<BackdropLayerSpec>,
    fade: Option<(BackdropLayerSpec, Instant)>,
    lights: Option<Point<Pixels>>,
    size: Option<[f32; 4]>,
    gradients: BackdropGradients,
    gradients_shown: Option<BackdropGradients>,
    gradient_fade: Option<(BackdropGradients, Instant)>,
    gradient_override: Option<BackdropGradients>,
}

fn lerp(a: f32, b: f32, t: f32) -> f32 {
    a + (b - a) * t
}

fn lerp_rgba(a: Rgba, b: Rgba, t: f32) -> Rgba {
    Rgba {
        r: lerp(a.r, b.r, t),
        g: lerp(a.g, b.g, t),
        b: lerp(a.b, b.b, t),
        a: lerp(a.a, b.a, t),
    }
}

fn faded(gradient: &BackdropGradient, alpha: f32) -> BackdropGradient {
    BackdropGradient::new(
        gradient
            .colors()
            .iter()
            .zip(gradient.locations())
            .map(|(color, location)| {
                (
                    Rgba {
                        a: color.a * alpha,
                        ..*color
                    },
                    *location,
                )
            }),
        gradient.start_point(),
        gradient.end_point(),
    )
}

pub fn blend_gradient(
    from: Option<&BackdropGradient>,
    to: Option<&BackdropGradient>,
    t: f32,
) -> Option<BackdropGradient> {
    match (from, to) {
        (None, None) => None,
        (Some(from), None) => Some(faded(from, 1.0 - t)),
        (None, Some(to)) => Some(faded(to, t)),
        (Some(from), Some(to)) if from.len() == to.len() => Some(BackdropGradient::new(
            from.colors()
                .iter()
                .zip(to.colors())
                .zip(from.locations().iter().zip(to.locations()))
                .map(|((a, b), (la, lb))| (lerp_rgba(*a, *b, t), lerp(*la, *lb, t))),
            [
                lerp(from.start_point()[0], to.start_point()[0], t),
                lerp(from.start_point()[1], to.start_point()[1], t),
            ],
            [
                lerp(from.end_point()[0], to.end_point()[0], t),
                lerp(from.end_point()[1], to.end_point()[1], t),
            ],
        )),
        (Some(from), Some(to)) => Some(if t < 0.5 {
            faded(from, 1.0 - 2.0 * t)
        } else {
            faded(to, 2.0 * t - 1.0)
        }),
    }
}

pub fn blend_gradients(
    from: &BackdropGradients,
    to: &BackdropGradients,
    t: f32,
) -> BackdropGradients {
    let t = t.clamp(0.0, 1.0);
    BackdropGradients {
        base: blend_gradient(from.base.as_ref(), to.base.as_ref(), t),
        overlay: blend_gradient(from.overlay.as_ref(), to.overlay.as_ref(), t),
        opacity: match (from.base.is_some(), to.base.is_some()) {
            (true, true) | (false, false) => lerp(from.opacity, to.opacity, t),
            (true, false) => from.opacity,
            (false, true) => to.opacity,
        },
    }
}

impl BackdropDriver {
    pub fn target(&self) -> Option<&BackdropLayerSpec> {
        self.target.as_ref()
    }

    pub fn shown(&self) -> Option<&BackdropLayerSpec> {
        self.shown.as_ref()
    }

    pub fn aim(&mut self, spec: BackdropLayerSpec, cross_fade: bool, now: Instant) {
        if self.target == Some(spec) {
            return;
        }
        self.fade = match (cross_fade, self.shown) {
            (true, Some(shown)) => Some((shown, now)),
            _ => None,
        };
        self.target = Some(spec);
    }

    pub fn aim_gradients(&mut self, gradients: BackdropGradients) {
        if gradients != self.gradients
            && let Some((_, start)) = self.fade
        {
            let from = self.gradients_shown.unwrap_or(self.gradients);
            self.gradient_fade = Some((from, start));
        }
        self.gradients = gradients;
    }

    pub fn override_gradients(&mut self, gradients: Option<BackdropGradients>) {
        if gradients.is_none() && self.gradient_override.is_some() {
            self.gradient_fade = None;
        }
        self.gradient_override = gradients;
    }

    pub fn gradients(&self) -> BackdropGradients {
        self.gradients
    }

    pub fn fit(&mut self, look: &crate::look::Look, window: &Window) {
        let viewport = window.viewport_size();
        let size = [f32::from(viewport.width), f32::from(viewport.height)];
        let frame = [size[0], size[1], size[0] / 2.0, size[1] / 2.0];
        if self.size != Some(frame) {
            let spec = look.backdrop_in(
                crate::window::looks_active(window),
                size,
                [frame[2], frame[3]],
            );
            self.resize(frame, spec);
        }
        self.aim_gradients(look.backdrop_gradients(size));
    }

    pub fn size(&self) -> Option<[f32; 4]> {
        self.size
    }

    pub fn resize(&mut self, size: [f32; 4], spec: BackdropLayerSpec) {
        self.size = Some(size);
        self.target = Some(spec);
    }

    pub fn apply(&mut self, window: &mut Window, now: Instant) -> bool {
        let Some(target) = self.target else {
            return false;
        };
        let (spec, running) = match self.fade {
            Some((from, start)) => {
                let t =
                    now.saturating_duration_since(start).as_secs_f32() / CROSS_FADE.as_secs_f32();
                if t >= 1.0 {
                    self.fade = None;
                    (target, false)
                } else {
                    (
                        blend_backdrops(&from, &target, Curve::EaseOut.apply(t)),
                        true,
                    )
                }
            }
            None => (target, false),
        };
        let layer_changed = self.shown != Some(spec);
        if layer_changed {
            window.set_backdrop_layer(Some(spec));
            self.shown = Some(spec);
        }
        let (gradients, gradients_running) = match (self.gradient_override, self.gradient_fade) {
            (Some(gradients), _) => (gradients, false),
            (None, Some((from, start))) => {
                let t =
                    now.saturating_duration_since(start).as_secs_f32() / CROSS_FADE.as_secs_f32();
                if t >= 1.0 {
                    self.gradient_fade = None;
                    (self.gradients, false)
                } else {
                    (
                        blend_gradients(&from, &self.gradients, Curve::EaseOut.apply(t)),
                        true,
                    )
                }
            }
            (None, None) => (self.gradients, false),
        };
        if layer_changed || self.gradients_shown != Some(gradients) {
            window.set_backdrop_gradients(gradients);
            self.gradients_shown = Some(gradients);
        }
        running || gradients_running
    }

    pub fn place_lights(&mut self, origin: Point<Pixels>, window: &mut Window) {
        if self.lights != Some(origin) {
            window.set_traffic_light_origin(origin);
            self.lights = Some(origin);
        }
    }

    pub fn lights(&self) -> Option<Point<Pixels>> {
        self.lights
    }
}

#[cfg(test)]
mod gradient_tests {
    use super::*;

    fn stop(color: f32) -> BackdropGradient {
        BackdropGradient::even(
            &[
                Rgba {
                    r: color,
                    g: color,
                    b: color,
                    a: 1.0,
                },
                Rgba {
                    r: color,
                    g: 0.0,
                    b: 0.0,
                    a: 1.0,
                },
            ],
            [0.0, 0.0],
            [10.0, 10.0],
        )
    }

    #[test]
    fn gradients_blend_stop_by_stop() {
        let mixed = blend_gradient(Some(&stop(0.0)), Some(&stop(1.0)), 0.25).expect("both");
        assert!((mixed.colors()[0].r - 0.25).abs() < 1e-5);
        assert_eq!(mixed.len(), 2);
    }

    #[test]
    fn a_gradient_fades_out_toward_a_plain_backdrop() {
        let out = blend_gradient(Some(&stop(1.0)), None, 0.75).expect("from");
        assert!((out.colors()[0].a - 0.25).abs() < 1e-5);
        let incoming = blend_gradient(None, Some(&stop(1.0)), 0.4).expect("to");
        assert!((incoming.colors()[0].a - 0.4).abs() < 1e-5);
        assert!(blend_gradient(None, None, 0.5).is_none());
    }
}
