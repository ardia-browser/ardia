use ardia_theme::profile_theme::arc_area;
use ardia_theme::{CustomBackdrop, GrainTexture as ThemeGrain, RgbaColor, WindowTreatment};
use gpui::{
    BackdropAppearance, BackdropGradient, BackdropGradients, BackdropLayerSpec, Background,
    ColorSpace, DEFAULT_GRAIN_SEED, GrainTexture, Hsla, Pixels, Point, Rgba, point, px,
};

pub const TRAFFIC_LIGHT_BUTTON: f32 = 14.0;
pub const TUCKED_TRAFFIC_LIGHTS_X: f32 = -120.0;

pub const fn rgba(color: RgbaColor) -> Rgba {
    Rgba {
        r: color.r,
        g: color.g,
        b: color.b,
        a: color.a,
    }
}

pub fn hsla(color: RgbaColor) -> Hsla {
    Hsla::from(rgba(color))
}

pub const fn grain_texture(texture: ThemeGrain) -> GrainTexture {
    match texture {
        ThemeGrain::Grain => GrainTexture::Grain,
        ThemeGrain::Sand => GrainTexture::Sand,
        ThemeGrain::Denim => GrainTexture::Denim,
        ThemeGrain::Tweed => GrainTexture::Tweed,
        ThemeGrain::Film => GrainTexture::Film,
    }
}

pub const fn backdrop_appearance(dark: bool) -> BackdropAppearance {
    if dark {
        BackdropAppearance::Dark
    } else {
        BackdropAppearance::Light
    }
}

fn faded(color: RgbaColor, opacity: f32) -> Rgba {
    rgba(color.with_alpha((color.a * opacity).clamp(0.0, 1.0)))
}

pub const NOMINAL_BACKDROP_SIZE: [f32; 2] = [1200.0, 760.0];

const DEFAULT_THEME_ANGLE: f32 = 135.0;
const BACKDROP_SAMPLES: [f32; 3] = [0.0, 0.5, 1.0];

pub fn backdrop_spec(treatment: &WindowTreatment, active: bool) -> BackdropLayerSpec {
    let [width, height] = NOMINAL_BACKDROP_SIZE;
    backdrop_spec_sized(
        treatment,
        active,
        NOMINAL_BACKDROP_SIZE,
        [width / 2.0, height / 2.0],
    )
}

fn theme_angle(angle: f32) -> f32 {
    if angle.is_finite() {
        angle
    } else {
        DEFAULT_THEME_ANGLE
    }
}

fn arc_samples(custom: &CustomBackdrop, angle: f32, size: [f32; 2], focus: [f32; 2]) -> [Rgba; 3] {
    let opacity = custom.opacity.clamp(0.0, 1.0);
    if custom.colors.is_empty() {
        return [rgba(RgbaColor::TRANSPARENT); 3];
    }
    let colors: Vec<[f64; 4]> = custom
        .colors
        .iter()
        .map(|c| [c.r.into(), c.g.into(), c.b.into(), c.a.into()])
        .collect();
    let width = f64::from(size[0].max(1.0));
    let height = f64::from(size[1].max(1.0));
    let radians = f64::from(angle).to_radians();
    let (across, up) = (radians.sin(), radians.cos());
    let half = (width * across.abs() + height * up.abs()) / 2.0;
    let focus_x = f64::from(focus[0]).clamp(0.0, width) - width / 2.0;
    let focus_y = f64::from(focus[1]).clamp(0.0, height) - height / 2.0;
    let sideways = focus_x * up + focus_y * across;
    BACKDROP_SAMPLES.map(|at| {
        let reach = 2.0 * f64::from(at) - 1.0;
        let x = width / 2.0 + reach * across * half + sideways * up;
        let y = height / 2.0 - reach * up * half + sideways * across;
        let [r, g, b] = arc_area(&colors, f64::from(angle), x, y, width, height);
        Rgba {
            r: r as f32,
            g: g as f32,
            b: b as f32,
            a: opacity,
        }
    })
}

pub fn backdrop_gradients(treatment: &WindowTreatment, size: [f32; 2]) -> BackdropGradients {
    let Some(custom) = treatment.custom.as_ref().filter(|c| !c.colors.is_empty()) else {
        return BackdropGradients::default();
    };
    let colors: Vec<Rgba> = custom.colors.iter().map(|color| rgba(*color)).collect();
    BackdropGradients::arc(theme_angle(custom.angle), &colors, size)
        .opacity(custom.opacity.clamp(0.0, 1.0))
}

pub fn backdrop_spec_sized(
    treatment: &WindowTreatment,
    active: bool,
    size: [f32; 2],
    focus: [f32; 2],
) -> BackdropLayerSpec {
    let (colors, angle, texture, display_p3) = match &treatment.custom {
        Some(custom) => {
            let angle = theme_angle(custom.angle);
            (
                arc_samples(custom, angle, size, focus),
                angle,
                grain_texture(ThemeGrain::from_theme(custom.texture)),
                false,
            )
        }
        None => {
            let [first, last] = treatment
                .gradient
                .unwrap_or([RgbaColor::TRANSPARENT, RgbaColor::TRANSPARENT]);
            let opacity = treatment.gradient_opacity;
            (
                [
                    faded(first, opacity),
                    faded(first.mix(last, 0.5), opacity),
                    faded(last, opacity),
                ],
                180.0,
                GrainTexture::Film,
                true,
            )
        }
    };
    let [top, mid, bottom] = colors;
    BackdropLayerSpec {
        top,
        mid,
        bottom,
        gradient_angle: angle,
        gradient_stops: BACKDROP_SAMPLES,
        base_tint: rgba(treatment.base_tint),
        grain_intensity: treatment.grain_opacity(active),
        grain_seed: DEFAULT_GRAIN_SEED,
        grain_texture: texture,
        appearance: backdrop_appearance(treatment.dark),
        display_p3,
        active_opacity: 1.0,
        inactive_opacity: 1.0,
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct AxialFill {
    pub angle: f32,
    pub stops: [f32; 2],
    pub from: Rgba,
    pub to: Rgba,
    pub oklab: bool,
}

impl AxialFill {
    pub fn between(
        start: [f32; 2],
        end: [f32; 2],
        from: Rgba,
        to: Rgba,
        oklab: bool,
        size: [f32; 2],
    ) -> Option<Self> {
        let [w, h] = size.map(|side| f64::from(side.max(1.0)));
        let start = [f64::from(start[0]), 1.0 - f64::from(start[1])];
        let end = [f64::from(end[0]), 1.0 - f64::from(end[1])];
        let unit = [end[0] - start[0], end[1] - start[1]];
        let unit_length = unit[0] * unit[0] + unit[1] * unit[1];
        if !unit_length.is_finite() || unit_length <= 0.0 {
            return None;
        }
        let at_centre = ((0.5 - start[0]) * unit[0] + (0.5 - start[1]) * unit[1]) / unit_length;
        let slope = [unit[0] / w / unit_length, unit[1] / h / unit_length];
        Self::along_line(at_centre, slope, from, to, oklab, size)
    }

    fn along_line(
        at_centre: f64,
        slope: [f64; 2],
        from: Rgba,
        to: Rgba,
        oklab: bool,
        size: [f32; 2],
    ) -> Option<Self> {
        let [w, h] = size.map(|side| f64::from(side.max(1.0)));
        let steepness = slope[0].hypot(slope[1]);
        if !steepness.is_finite() || steepness <= 0.0 {
            return None;
        }
        let toward = [slope[0] / steepness, slope[1] / steepness];
        let shown = if w > h {
            [toward[0], toward[1] * w / h]
        } else {
            [toward[0] * h / w, toward[1]]
        };
        let radians = shown[1].atan2(shown[0]);
        let angle = (radians.to_degrees() + 90.0).rem_euclid(360.0);
        let extent = if w > h {
            if radians.cos().abs() > (radians.sin() * h / w).abs() {
                w
            } else {
                h
            }
        } else if (radians.cos() * w / h).abs() > radians.sin().abs() {
            w
        } else {
            h
        };
        let span = 1.0 / (extent * steepness);
        let first = 0.5 - at_centre * span;
        Some(Self {
            angle: angle as f32,
            stops: [first as f32, (first + span) as f32],
            from,
            to,
            oklab,
        })
    }

    fn line(&self, size: [f32; 2]) -> Option<(f64, [f64; 2])> {
        let [w, h] = size.map(f64::from);
        let radians = ((f64::from(self.angle) % 360.0) - 90.0).to_radians();
        let mut direction = [radians.cos(), radians.sin()];
        if w > h {
            direction[1] *= h / w;
        } else {
            direction[0] *= w / h;
        }
        let extent = if direction[0].abs() > direction[1].abs() {
            w
        } else {
            h
        };
        let length = direction[0].hypot(direction[1]);
        let span = f64::from(self.stops[1] - self.stops[0]);
        if length == 0.0 || extent == 0.0 || span == 0.0 {
            return None;
        }
        let scale = 1.0 / (length * extent * span);
        let at_centre = (0.5 - f64::from(self.stops[0])) / span;
        Some((at_centre, [direction[0] * scale, direction[1] * scale]))
    }

    pub fn reframed(&self, size: [f32; 2], origin: [f32; 2], within: [f32; 2]) -> Option<Self> {
        if self.from == self.to {
            return Some(*self);
        }
        let (at_centre, slope) = self.line(size)?;
        let shift = [
            f64::from(origin[0]) + f64::from(within[0]) / 2.0 - f64::from(size[0]) / 2.0,
            f64::from(origin[1]) + f64::from(within[1]) / 2.0 - f64::from(size[1]) / 2.0,
        ];
        let at = at_centre + shift[0] * slope[0] + shift[1] * slope[1];
        Self::along_line(at, slope, self.from, self.to, self.oklab, within)
    }

    pub fn background(&self) -> Background {
        let background = gpui::linear_gradient(
            self.angle,
            gpui::linear_color_stop(self.from, self.stops[0]),
            gpui::linear_color_stop(self.to, self.stops[1]),
        );
        if self.oklab {
            background.color_space(ColorSpace::Oklab)
        } else {
            background
        }
    }

    pub fn t_at(&self, size: [f32; 2], at: [f32; 2]) -> f32 {
        gradient_t(self.angle, self.stops, size, at)
    }

    pub fn color_at(&self, size: [f32; 2], at: [f32; 2]) -> Rgba {
        let t = self.t_at(size, at);
        if self.oklab {
            let channels = |c: Rgba| [f64::from(c.r), f64::from(c.g), f64::from(c.b)];
            let [r, g, b] =
                ardia_theme::color::mix_oklab(channels(self.from), channels(self.to), f64::from(t));
            Rgba {
                r: r as f32,
                g: g as f32,
                b: b as f32,
                a: lerp(self.from.a, self.to.a, t),
            }
        } else {
            lerp_rgba(self.from, self.to, t)
        }
    }
}

pub fn gradient_t(angle: f32, stops: [f32; 2], size: [f32; 2], at: [f32; 2]) -> f32 {
    let radians = ((angle % 360.0) - 90.0).to_radians();
    let mut direction = [radians.cos(), radians.sin()];
    if size[0] > size[1] {
        direction[1] *= size[1] / size[0];
    } else {
        direction[0] *= size[0] / size[1];
    }
    let extent = if direction[0].abs() > direction[1].abs() {
        size[0]
    } else {
        size[1]
    };
    let length = (direction[0] * direction[0] + direction[1] * direction[1]).sqrt();
    let span = stops[1] - stops[0];
    if length == 0.0 || extent == 0.0 || span == 0.0 {
        return 0.0;
    }
    let scale = 1.0 / (length * extent * span);
    let offset = (0.5 - stops[0]) / span;
    let along = (at[0] - size[0] / 2.0) * direction[0] + (at[1] - size[1] / 2.0) * direction[1];
    (along * scale + offset).clamp(0.0, 1.0)
}

pub fn over(top: Rgba, under: Rgba) -> Rgba {
    let a = top.a + under.a * (1.0 - top.a);
    if a <= 0.0 {
        return Rgba {
            r: 0.0,
            g: 0.0,
            b: 0.0,
            a: 0.0,
        };
    }
    let mix = |t: f32, u: f32| (t * top.a + u * under.a * (1.0 - top.a)) / a;
    Rgba {
        r: mix(top.r, under.r),
        g: mix(top.g, under.g),
        b: mix(top.b, under.b),
        a,
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct ThemedFill {
    pub under: Rgba,
    pub layers: Vec<AxialFill>,
}

impl ThemedFill {
    pub fn reframed(&self, size: [f32; 2], origin: [f32; 2], within: [f32; 2]) -> Self {
        ThemedFill {
            under: self.under,
            layers: self
                .layers
                .iter()
                .filter_map(|layer| layer.reframed(size, origin, within))
                .collect(),
        }
    }

    pub fn color_at(&self, size: [f32; 2], at: [f32; 2]) -> Rgba {
        self.layers.iter().fold(self.under, |shown, layer| {
            over(layer.color_at(size, at), shown)
        })
    }
}

fn gradient_ends(gradient: &BackdropGradient) -> Option<(Rgba, Rgba)> {
    let colors = gradient.colors();
    Some((*colors.first()?, *colors.last()?))
}

pub fn vibrancy_under(dark: bool) -> Rgba {
    let grey = ardia_theme::profile_theme::backdrop_under_grey(0.0, dark) as f32;
    Rgba {
        r: grey,
        g: grey,
        b: grey,
        a: 1.0,
    }
}

fn mean_grain(treatment: &WindowTreatment) -> Option<AxialFill> {
    let custom = treatment.custom.as_ref()?;
    let tile = ardia_theme::GrainTile::get(ThemeGrain::from_theme(custom.texture));
    let alpha = tile.mean_alpha() * treatment.grain_opacity(true);
    let shade = Rgba {
        r: 0.0,
        g: 0.0,
        b: 0.0,
        a: alpha,
    };
    (alpha > 0.0).then_some(AxialFill {
        angle: 180.0,
        stops: [0.0, 1.0],
        from: shade,
        to: shade,
        oklab: false,
    })
}

pub fn themed_fill(treatment: &WindowTreatment, size: [f32; 2], panel: Rgba) -> ThemedFill {
    let under = over(rgba(treatment.base_tint), panel);
    let gradients = backdrop_gradients(treatment, size);
    let layers = match (&treatment.custom, gradients.base) {
        (Some(_), Some(base)) => {
            let opacity = gradients.opacity.clamp(0.0, 1.0);
            let base_layer = gradient_ends(&base).and_then(|(from, to)| {
                AxialFill::between(
                    base.start_point(),
                    base.end_point(),
                    Rgba {
                        a: from.a * opacity,
                        ..from
                    },
                    Rgba {
                        a: to.a * opacity,
                        ..to
                    },
                    true,
                    size,
                )
            });
            let overlay_layer = gradients.overlay.as_ref().and_then(|overlay| {
                let (from, to) = gradient_ends(overlay)?;
                let seen = Rgba {
                    r: lerp(under.r, to.r, opacity),
                    g: lerp(under.g, to.g, opacity),
                    b: lerp(under.b, to.b, opacity),
                    a: 1.0,
                };
                AxialFill::between(
                    overlay.start_point(),
                    overlay.end_point(),
                    Rgba { a: from.a, ..seen },
                    Rgba { a: to.a, ..seen },
                    false,
                    size,
                )
            });
            base_layer
                .into_iter()
                .chain(overlay_layer)
                .chain(mean_grain(treatment))
                .collect()
        }
        _ => {
            let spec = backdrop_spec_sized(treatment, true, size, [size[0] / 2.0, size[1] / 2.0]);
            vec![AxialFill {
                angle: spec.gradient_angle,
                stops: [spec.gradient_stops[0], spec.gradient_stops[2]],
                from: spec.top,
                to: spec.bottom,
                oklab: false,
            }]
        }
    };
    ThemedFill { under, layers }
}

fn lerp(from: f32, to: f32, t: f32) -> f32 {
    from + (to - from) * t
}

fn lerp_rgba(from: Rgba, to: Rgba, t: f32) -> Rgba {
    Rgba {
        r: lerp(from.r, to.r, t),
        g: lerp(from.g, to.g, t),
        b: lerp(from.b, to.b, t),
        a: lerp(from.a, to.a, t),
    }
}

pub fn blend_backdrops(
    from: &BackdropLayerSpec,
    to: &BackdropLayerSpec,
    t: f32,
) -> BackdropLayerSpec {
    let t = t.clamp(0.0, 1.0);
    let settled = if t < 0.5 { from } else { to };
    BackdropLayerSpec {
        top: lerp_rgba(from.top, to.top, t),
        mid: lerp_rgba(from.mid, to.mid, t),
        bottom: lerp_rgba(from.bottom, to.bottom, t),
        gradient_angle: lerp(from.gradient_angle, to.gradient_angle, t),
        gradient_stops: to.gradient_stops,
        base_tint: lerp_rgba(from.base_tint, to.base_tint, t),
        grain_intensity: lerp(from.grain_intensity, to.grain_intensity, t),
        grain_seed: to.grain_seed,
        grain_texture: settled.grain_texture,
        appearance: settled.appearance,
        display_p3: to.display_p3,
        active_opacity: lerp(from.active_opacity, to.active_opacity, t),
        inactive_opacity: lerp(from.inactive_opacity, to.inactive_opacity, t),
    }
}

pub fn traffic_light_origin(center: [f32; 2]) -> Point<Pixels> {
    let half = TRAFFIC_LIGHT_BUTTON / 2.0;
    point(px(center[0] - half), px(center[1] - half))
}

pub fn tucked_traffic_lights(center_y: f32) -> Point<Pixels> {
    traffic_light_origin([TUCKED_TRAFFIC_LIGHTS_X, center_y])
}

#[cfg(test)]
mod tests {
    use super::*;
    use ardia_theme::{ProfileColor, Theme, ThemeFamily};

    fn close(a: f32, b: f32) -> bool {
        (a - b).abs() < 1e-4
    }

    #[test]
    fn colors_convert_without_changing_channels() {
        let color = RgbaColor::new(0.2, 0.4, 0.6, 0.8);
        let converted = rgba(color);
        assert_eq!(
            [converted.r, converted.g, converted.b, converted.a],
            [0.2, 0.4, 0.6, 0.8]
        );
        let hsla = hsla(RgbaColor::WHITE);
        assert!(close(hsla.l, 1.0) && close(hsla.a, 1.0));
    }

    #[test]
    fn every_grain_texture_maps_to_the_platform_texture() {
        for texture in ThemeGrain::ALL {
            assert_eq!(grain_texture(texture).index(), {
                match texture {
                    ThemeGrain::Film => 0,
                    ThemeGrain::Grain => 1,
                    ThemeGrain::Sand => 2,
                    ThemeGrain::Denim => 3,
                    ThemeGrain::Tweed => 4,
                }
            });
        }
    }

    #[test]
    fn preset_backdrop_matches_the_dia_window_treatment() {
        let theme = Theme::preset(ThemeFamily::Preset(ProfileColor::Plum), true);
        let spec = backdrop_spec(&theme.treatment(), true);
        assert_eq!(spec.appearance, BackdropAppearance::Dark);
        assert!(close(spec.base_tint.a, 0.4) && close(spec.base_tint.r, 0.0));
        assert!(close(spec.top.a, 0.36 * 0.5));
        assert!(close(spec.bottom.a, 0.36 * 0.5));
        assert!(spec.bottom.r > spec.top.r);
        assert_eq!(spec.gradient_angle, 180.0);
        assert_eq!(spec.grain_intensity, 0.0);
        let light = backdrop_spec(
            &Theme::preset(ThemeFamily::Preset(ProfileColor::Plum), false).treatment(),
            true,
        );
        assert_eq!(light.appearance, BackdropAppearance::Light);
        assert!(close(light.base_tint.a, 0.8) && close(light.base_tint.r, 1.0));
        assert!(close(light.top.a, 0.36 * 0.75));
    }

    #[test]
    fn custom_backdrops_carry_their_grain_and_fade_it_when_inactive() {
        let custom = ardia_theme::CustomBackdrop {
            colors: vec![RgbaColor::hex(0xFF0000), RgbaColor::hex(0x0000FF)],
            opacity: 0.5,
            base_alpha: 0.3,
            grain: 0.8,
            texture: ardia_theme::ThemeTexture::Tweed,
            appearance: ardia_theme::ThemeMode::Auto,
            angle: 135.0,
        };
        let treatment = WindowTreatment::custom(custom, true);
        let active = backdrop_spec(&treatment, true);
        let inactive = backdrop_spec(&treatment, false);
        assert_eq!(active.grain_texture, GrainTexture::Tweed);
        assert!(close(active.grain_intensity, 0.8));
        assert!(close(inactive.grain_intensity, 0.2));
        assert!(close(active.top.r, 1.0) && close(active.top.a, 0.5));
        assert!(close(active.bottom.b, 1.0));
        let centre = arc_area(
            &[[1.0, 0.0, 0.0, 1.0], [0.0, 0.0, 1.0, 1.0]],
            135.0,
            600.0,
            380.0,
            1200.0,
            760.0,
        );
        assert!(close(active.mid.r, centre[0] as f32) && close(active.mid.b, centre[2] as f32));
        assert!(!active.display_p3);
        assert_eq!(active.gradient_angle, 135.0);
        assert!(close(active.base_tint.a, 0.3));
    }

    fn three_stop_theme() -> WindowTreatment {
        let custom = ardia_theme::CustomBackdrop {
            colors: vec![
                RgbaColor::new(0.886, 0.649, 0.314, 1.0),
                RgbaColor::new(0.897, 0.303, 0.535, 1.0),
                RgbaColor::new(0.354, 0.610, 0.846, 1.0),
            ],
            opacity: 0.65,
            base_alpha: 0.1,
            grain: 0.3,
            texture: ardia_theme::ThemeTexture::Grain,
            appearance: ardia_theme::ThemeMode::Auto,
            angle: 5.0,
        };
        WindowTreatment::custom(custom, true)
    }

    #[test]
    fn custom_backdrops_sample_the_arc_gradient_along_the_window_axis() {
        let treatment = three_stop_theme();
        let custom = treatment.custom.clone().unwrap_or_else(|| unreachable!());
        let colors: Vec<[f64; 4]> = custom
            .colors
            .iter()
            .map(|c| [c.r.into(), c.g.into(), c.b.into(), c.a.into()])
            .collect();
        let (width, height) = (1000.0_f64, 600.0_f64);
        let spec = backdrop_spec_sized(&treatment, true, [1000.0, 600.0], [500.0, 300.0]);
        let radians = 5.0_f64.to_radians();
        let half = (width * radians.sin().abs() + height * radians.cos().abs()) / 2.0;
        for (shown, at) in [(spec.top, -1.0), (spec.mid, 0.0), (spec.bottom, 1.0)] {
            let x = width / 2.0 + at * radians.sin() * half;
            let y = height / 2.0 - at * radians.cos() * half;
            let want = arc_area(&colors, 5.0, x, y, width, height);
            assert!(close(shown.r, want[0] as f32), "{at}");
            assert!(close(shown.g, want[1] as f32), "{at}");
            assert!(close(shown.b, want[2] as f32), "{at}");
            assert!(close(shown.a, 0.65));
        }
        assert!(spec.bottom.b > spec.top.b);
        assert_eq!(spec.gradient_stops, [0.0, 0.5, 1.0]);
    }

    #[test]
    fn the_focus_point_sits_on_each_sampled_level_line() {
        let treatment = three_stop_theme();
        let custom = treatment.custom.clone().unwrap_or_else(|| unreachable!());
        let colors: Vec<[f64; 4]> = custom
            .colors
            .iter()
            .map(|c| [c.r.into(), c.g.into(), c.b.into(), c.a.into()])
            .collect();
        let spec = backdrop_spec_sized(&treatment, true, [1200.0, 760.0], [100.0, 380.0]);
        let radians = 5.0_f64.to_radians();
        let (across, up) = (radians.sin(), radians.cos());
        let sideways = -500.0 * up;
        let half = (1200.0 * across + 760.0 * up) / 2.0;
        let x = 600.0 + sideways * up;
        let y = 380.0 + sideways * across;
        let want = arc_area(&colors, 5.0, x, y, 1200.0, 760.0);
        assert!(close(spec.mid.r, want[0] as f32) && close(spec.mid.b, want[2] as f32));
        let top = arc_area(
            &colors,
            5.0,
            x + across * half,
            y - up * half,
            1200.0,
            760.0,
        );
        assert!(close(spec.bottom.g, top[1] as f32));
        let centred = backdrop_spec_sized(&treatment, true, [1200.0, 760.0], [600.0, 380.0]);
        assert_ne!(spec.mid, centred.mid);
    }

    #[test]
    fn only_custom_backdrops_follow_the_window_shape() {
        let treatment = three_stop_theme();
        let wide = backdrop_spec_sized(&treatment, true, [1600.0, 500.0], [0.0, 0.0]);
        let tall = backdrop_spec_sized(&treatment, true, [500.0, 1600.0], [0.0, 0.0]);
        assert_ne!(wide, tall);
        let preset = Theme::preset(ThemeFamily::Preset(ProfileColor::Green), true).treatment();
        assert_eq!(
            backdrop_spec_sized(&preset, true, [1600.0, 500.0], [0.0, 0.0]),
            backdrop_spec_sized(&preset, true, [500.0, 1600.0], [0.0, 0.0])
        );
        let empty = ardia_theme::CustomBackdrop {
            colors: Vec::new(),
            ..treatment.custom.unwrap_or_else(|| unreachable!())
        };
        let bare = backdrop_spec(&WindowTreatment::custom(empty, true), true);
        assert_eq!(bare.top.a, 0.0);
        assert_eq!(bare.bottom.a, 0.0);
    }

    #[test]
    fn custom_themes_draw_the_arc_gradient_layers_and_presets_none() {
        let treatment = three_stop_theme();
        let gradients = backdrop_gradients(&treatment, [1200.0, 760.0]);
        let base = gradients.base.unwrap_or_else(|| unreachable!());
        let overlay = gradients.overlay.unwrap_or_else(|| unreachable!());
        assert!(base.len() > 3);
        assert!(close(gradients.opacity, 0.65));
        assert!(close(base.colors()[0].a, 1.0));
        assert!(close(overlay.colors()[0].a, 0.0));
        assert!(close(overlay.colors()[1].a, 1.0));
        assert!(close(overlay.colors()[1].b, 0.846));
        let preset = Theme::preset(ThemeFamily::Preset(ProfileColor::Green), true).treatment();
        assert!(backdrop_gradients(&preset, [1200.0, 760.0]).is_empty());
    }

    #[test]
    fn blending_backdrops_lands_on_both_ends() {
        let a = backdrop_spec(
            &Theme::preset(ThemeFamily::Preset(ProfileColor::Plum), true).treatment(),
            true,
        );
        let b = backdrop_spec(
            &Theme::preset(ThemeFamily::Preset(ProfileColor::Green), false).treatment(),
            true,
        );
        assert_eq!(blend_backdrops(&a, &b, 0.0), a);
        assert_eq!(blend_backdrops(&a, &b, 1.0), b);
        let half = blend_backdrops(&a, &b, 0.5);
        assert!(close(
            half.base_tint.a,
            (a.base_tint.a + b.base_tint.a) / 2.0
        ));
        assert_eq!(half.appearance, b.appearance);
    }

    #[test]
    fn axial_fills_reproduce_the_core_animation_gradient_line() {
        for size in [[1500.0, 1000.0], [400.0, 900.0], [600.0, 600.0]] {
            for angle in [5.0, 50.0, 135.0, 180.0, 290.0] {
                let (start, end) = gpui::arc_base_points(angle, size);
                let fill = AxialFill::between(
                    start,
                    end,
                    rgba(RgbaColor::BLACK),
                    rgba(RgbaColor::WHITE),
                    false,
                    size,
                )
                .unwrap_or_else(|| unreachable!());
                let s = [start[0], 1.0 - start[1]];
                let g = [end[0] - start[0], start[1] - end[1]];
                let g2 = g[0] * g[0] + g[1] * g[1];
                for at in [
                    [0.0, 0.0],
                    [size[0], size[1]],
                    [size[0] * 0.3, size[1] * 0.8],
                ] {
                    let want =
                        (((at[0] / size[0] - s[0]) * g[0] + (at[1] / size[1] - s[1]) * g[1]) / g2)
                            .clamp(0.0, 1.0);
                    let shown = fill.t_at(size, at);
                    assert!((shown - want).abs() < 1e-3, "{size:?} {angle} {at:?}");
                }
            }
        }
    }

    #[test]
    fn themed_cards_composite_the_arc_gradient_at_their_own_size() {
        let treatment = three_stop_theme();
        let custom = treatment.custom.clone().unwrap_or_else(|| unreachable!());
        let colors: Vec<[f64; 4]> = custom
            .colors
            .iter()
            .map(|c| [c.r.into(), c.g.into(), c.b.into(), c.a.into()])
            .collect();
        let panel = Rgba {
            r: 0.12,
            g: 0.12,
            b: 0.13,
            a: 1.0,
        };
        let under = over(rgba(treatment.base_tint), panel);
        let size = [1500.0_f32, 1000.0];
        let fill = themed_fill(&treatment, size, panel);
        assert_eq!(fill.layers.len(), 3);
        let grain = ardia_theme::GrainTile::get(ThemeGrain::Grain).mean_alpha()
            * treatment.grain_opacity(true);
        assert!(grain > 0.0);
        for at in [
            [0.0, 0.0],
            [0.0, size[1]],
            [size[0], 0.0],
            [size[0], size[1]],
            [size[0] / 2.0, size[1] / 2.0],
            [200.0, 900.0],
        ] {
            let [r, g, b] = arc_area(
                &colors,
                5.0,
                at[0].into(),
                at[1].into(),
                size[0].into(),
                size[1].into(),
            );
            let want = over(
                Rgba {
                    r: 0.0,
                    g: 0.0,
                    b: 0.0,
                    a: grain,
                },
                over(
                    Rgba {
                        r: r as f32,
                        g: g as f32,
                        b: b as f32,
                        a: custom.opacity,
                    },
                    under,
                ),
            );
            let shown = fill.color_at(size, at);
            for (s, w) in [(shown.r, want.r), (shown.g, want.g), (shown.b, want.b)] {
                assert!((s - w).abs() < 2e-3, "{at:?} {shown:?} {want:?}");
            }
        }
        let bottom_left = fill.color_at(size, [0.0, size[1]]);
        assert!(bottom_left.r > bottom_left.b);
    }

    #[test]
    fn a_reframed_fill_shows_the_window_gradient_inside_a_panel() {
        let size = [1200.0, 760.0];
        let fill = themed_fill(&three_stop_theme(), size, vibrancy_under(false));
        let origin = [8.0, 40.0];
        let within = [240.0, 700.0];
        let panel = fill.reframed(size, origin, within);
        assert_eq!(panel.layers.len(), fill.layers.len());
        for at in [
            [0.0, 0.0],
            [240.0, 0.0],
            [0.0, 700.0],
            [120.0, 350.0],
            [240.0, 700.0],
        ] {
            let shown = panel.color_at(within, at);
            let want = fill.color_at(size, [origin[0] + at[0], origin[1] + at[1]]);
            for (s, w) in [(shown.r, want.r), (shown.g, want.g), (shown.b, want.b)] {
                assert!((s - w).abs() < 2e-3, "{at:?} {shown:?} {want:?}");
            }
        }
    }

    #[test]
    fn preset_cards_keep_the_vertical_tint_gradient() {
        let treatment = Theme::preset(ThemeFamily::Preset(ProfileColor::Plum), true).treatment();
        let panel = rgba(RgbaColor::BLACK);
        let fill = themed_fill(&treatment, [800.0, 500.0], panel);
        assert_eq!(fill.layers.len(), 1);
        assert_eq!(fill.layers[0].angle, 180.0);
        assert_eq!(fill.under, over(rgba(treatment.base_tint), panel));
    }

    #[test]
    fn traffic_lights_are_placed_by_their_centre() {
        let origin = traffic_light_origin([25.0, 30.0]);
        assert_eq!(origin, point(px(18.0), px(23.0)));
        assert!(tucked_traffic_lights(30.0).x < px(-100.0));
    }
}
