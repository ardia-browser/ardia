use crate::color::{self, RgbaColor};
use crate::json;
use crate::tokens::{self, ColorRoles, HIGH_CONTRAST_INK, INCOGNITO_TINT, ProfileColor};
use serde::de::Error as _;
use serde::{Deserialize, Deserializer, Serialize, Serializer};
use serde_json::{Map, Value};
use std::f64::consts::PI;
use std::sync::Arc;

pub const MAX_THEME_STOPS: usize = 3;
pub const PAD_LIGHTNESS: f64 = 0.6;
pub const DEFAULT_THEME_ANGLE: f64 = 135.0;
pub const DARKENED_LOOK_KEEP: f64 = 0.4;
pub const STARTING_NOISE: f64 = 0.5;
pub const GRADIENT_LIGHTNESS_DELTA: f32 = 0.25;
pub const TINT_ALPHA: f32 = 0.36;
pub const NEUTRAL_TINT_ALPHA: f32 = 0.12;
pub const INACTIVE_GRAIN: f32 = 0.25;
pub const MIN_INK_CONTRAST: f32 = 3.0;
pub const MIN_SELECTION_LIGHTNESS: f32 = 0.06;

const BASE_REACH: f64 = 0.75;
const MAX_SANITIZED_STOPS: usize = 16;
const SAMPLE_POINTS: [f64; 3] = [0.0, 0.5, 1.0];
const MIN_BLACK_TEXT_CONTRAST: f64 = 3.0;
const MIN_WHITE_TEXT_CONTRAST: f64 = 2.0;
const MAX_FALLBACK_ALPHA: f32 = 0.5;
const MAX_LINE_ALPHA: f32 = 0.3;

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ThemeTexture {
    #[default]
    Grain,
    Sand,
    Denim,
    Tweed,
}

impl ThemeTexture {
    pub const ALL: [ThemeTexture; 4] = [
        ThemeTexture::Grain,
        ThemeTexture::Sand,
        ThemeTexture::Denim,
        ThemeTexture::Tweed,
    ];

    pub const fn strength(self) -> f64 {
        match self {
            ThemeTexture::Grain => 0.8,
            ThemeTexture::Sand => 0.15,
            ThemeTexture::Denim => 0.6,
            ThemeTexture::Tweed => 0.4,
        }
    }

    pub const fn key(self) -> &'static str {
        match self {
            ThemeTexture::Grain => "grain",
            ThemeTexture::Sand => "sand",
            ThemeTexture::Denim => "denim",
            ThemeTexture::Tweed => "tweed",
        }
    }

    pub fn from_key(key: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|t| t.key() == key)
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ThemeMode {
    #[default]
    Auto,
    Light,
    Dark,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash)]
pub enum LookSource {
    #[default]
    Own,
    App,
    Utility,
}

#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
pub struct ThemeColor {
    #[serde(serialize_with = "json::serialize_f64")]
    pub r: f64,
    #[serde(serialize_with = "json::serialize_f64")]
    pub g: f64,
    #[serde(serialize_with = "json::serialize_f64")]
    pub b: f64,
    #[serde(serialize_with = "json::serialize_f64")]
    pub a: f64,
}

impl ThemeColor {
    pub const fn new(r: f64, g: f64, b: f64, a: f64) -> Self {
        Self { r, g, b, a }
    }

    pub fn rgb(&self) -> [f64; 3] {
        [self.r, self.g, self.b]
    }

    pub fn to_rgba(&self) -> RgbaColor {
        RgbaColor::new(self.r as f32, self.g as f32, self.b as f32, self.a as f32)
    }

    pub fn from_rgba(c: RgbaColor) -> Self {
        Self::new(
            f64::from(c.r),
            f64::from(c.g),
            f64::from(c.b),
            f64::from(c.a),
        )
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
pub struct ThemeStop {
    pub color: ThemeColor,
    #[serde(serialize_with = "json::serialize_f64")]
    pub x: f64,
    #[serde(serialize_with = "json::serialize_f64")]
    pub y: f64,
}

#[derive(Clone, Debug, PartialEq)]
pub struct ThemeLook {
    pub stops: Vec<ThemeStop>,
    pub intensity: f64,
    pub grain: f64,
    pub texture: ThemeTexture,
    pub translucency: f64,
    pub angle: Option<f64>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct ProfileTheme {
    pub look: ThemeLook,
    pub mode: ThemeMode,
    pub dark: Option<ThemeLook>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct ShownLook {
    pub look: ProfileTheme,
    pub requested_dark: bool,
    pub dark: bool,
}

fn clamp01(v: f64) -> f64 {
    if v.is_nan() { 0.0 } else { v.clamp(0.0, 1.0) }
}

fn finite(v: &Value) -> Option<f64> {
    v.as_f64().filter(|n| n.is_finite())
}

fn number_or(v: Option<&Value>, fallback: f64) -> f64 {
    v.and_then(finite).unwrap_or(fallback)
}

fn normalized_angle(degrees: f64) -> f64 {
    let a = ((degrees % 360.0) + 360.0) % 360.0;
    if a == 0.0 { 0.0 } else { a }
}

fn js_round(x: f64) -> f64 {
    let r = x.round();
    if (r - x).abs() == 0.5 { x.ceil() } else { r }
}

impl ThemeLook {
    pub fn angle(&self) -> f64 {
        self.angle.unwrap_or(DEFAULT_THEME_ANGLE)
    }

    pub fn sanitize(value: &Value) -> Option<Self> {
        let fields = value.as_object()?;
        let raw = fields.get("stops")?.as_array()?;
        let mut stops = Vec::with_capacity(MAX_THEME_STOPS);
        for entry in raw.iter().take(MAX_SANITIZED_STOPS) {
            if stops.len() >= MAX_THEME_STOPS {
                break;
            }
            let Some(stop) = entry.as_object() else {
                continue;
            };
            let Some(color) = stop.get("color").and_then(sanitize_color) else {
                continue;
            };
            stops.push(ThemeStop {
                color,
                x: clamp01(number_or(stop.get("x"), 0.5)),
                y: clamp01(number_or(stop.get("y"), 0.5)),
            });
        }
        if stops.is_empty() {
            return None;
        }
        Some(ThemeLook {
            stops,
            intensity: clamp01(number_or(fields.get("intensity"), 0.6)),
            grain: clamp01(number_or(fields.get("grain"), 0.0)),
            texture: fields
                .get("texture")
                .and_then(Value::as_str)
                .and_then(ThemeTexture::from_key)
                .unwrap_or_default(),
            translucency: clamp01(number_or(fields.get("translucency"), 1.0)),
            angle: fields.get("angle").and_then(finite).map(normalized_angle),
        })
    }

    fn write_into(&self, out: &mut Map<String, Value>) {
        let stops = self
            .stops
            .iter()
            .map(|s| serde_json::to_value(s).unwrap_or(Value::Null))
            .collect();
        out.insert("stops".into(), Value::Array(stops));
        out.insert("intensity".into(), json::js_number(self.intensity));
        out.insert("grain".into(), json::js_number(self.grain));
        out.insert("texture".into(), self.texture.key().into());
        out.insert("translucency".into(), json::js_number(self.translucency));
        if let Some(angle) = self.angle {
            out.insert("angle".into(), json::js_number(angle));
        }
    }

    pub fn to_value(&self) -> Value {
        let mut out = Map::new();
        self.write_into(&mut out);
        Value::Object(out)
    }

    pub fn area(&self, x: f64, y: f64, width: f64, height: f64) -> [f64; 3] {
        let colors: Vec<[f64; 4]> = self
            .stops
            .iter()
            .map(|s| [s.color.r, s.color.g, s.color.b, s.color.a])
            .collect();
        arc_area(&colors, self.angle(), x, y, width, height)
    }

    pub fn accent(&self) -> RgbaColor {
        unit_color(self.area(0.5, 0.5, 1.0, 1.0))
    }

    pub fn palette(&self) -> Vec<RgbaColor> {
        self.stops
            .iter()
            .map(|s| unit_color(s.color.rgb()))
            .collect()
    }

    pub fn flat_colors(&self) -> Vec<f32> {
        self.stops
            .iter()
            .take(MAX_THEME_STOPS)
            .flat_map(|s| {
                [
                    s.color.r as f32,
                    s.color.g as f32,
                    s.color.b as f32,
                    s.color.a as f32,
                ]
            })
            .collect()
    }

    pub fn layer_alpha(&self) -> f64 {
        1.0 - clamp01(self.translucency) * (1.0 - arc_layer_alpha(self.intensity))
    }

    pub fn underlay_alpha(&self, dark: bool) -> f64 {
        let arc = arc_layer_alpha(self.intensity).min(0.5);
        clamp01(self.translucency) * if dark { 0.35 * arc } else { arc }
    }

    pub fn grain_alpha(&self) -> f64 {
        clamp01(self.grain) * self.texture.strength()
    }

    pub fn under_color(&self, dark: bool) -> RgbaColor {
        let grey = backdrop_under_grey(self.underlay_alpha(dark), dark);
        unit_color([grey, grey, grey])
    }

    fn composite(&self, dark: bool, x: f64, y: f64) -> [f64; 3] {
        let a = self.layer_alpha();
        let under = backdrop_under_grey(self.underlay_alpha(dark), dark);
        let area = self.area(x, y, 1.0, 1.0);
        [
            a * clamp01(area[0]) + (1.0 - a) * under,
            a * clamp01(area[1]) + (1.0 - a) * under,
            a * clamp01(area[2]) + (1.0 - a) * under,
        ]
    }

    pub fn opaque_tint(&self, dark: bool) -> [RgbaColor; 2] {
        [
            unit_color(self.composite(dark, 0.0, 0.0)),
            unit_color(self.composite(dark, 1.0, 1.0)),
        ]
    }

    pub fn luminance(&self, dark: bool) -> f64 {
        let mut sum = 0.0;
        for x in SAMPLE_POINTS {
            for y in SAMPLE_POINTS {
                sum += color::unit_relative_luminance(self.composite(dark, x, y));
            }
        }
        sum / (SAMPLE_POINTS.len() * SAMPLE_POINTS.len()) as f64
    }

    pub fn readable_dark(&self, dark: bool) -> bool {
        let y = self.luminance(dark);
        let black_text = (y + 0.05) / 0.05;
        let white_text = 1.05 / (y + 0.05);
        if dark {
            !(white_text < MIN_WHITE_TEXT_CONTRAST && black_text > white_text)
        } else {
            black_text < MIN_BLACK_TEXT_CONTRAST && white_text > black_text
        }
    }

    pub fn darkened(&self, keep: f64) -> Self {
        let mut look = self.clone();
        for stop in &mut look.stops {
            stop.color.r *= keep;
            stop.color.g *= keep;
            stop.color.b *= keep;
        }
        look
    }

    pub fn with_stop_at(&self, index: usize, x: f64, y: f64) -> Self {
        let mut look = self.clone();
        if let Some(stop) = look.stops.get_mut(index) {
            let alpha = stop.color.a;
            let lightness = stop_lightness(stop);
            stop.x = x;
            stop.y = y;
            stop.color = ThemeColor {
                a: alpha,
                ..pad_color(x, y, lightness)
            };
        }
        look
    }

    pub fn with_stop_lightness(&self, index: usize, lightness: f64) -> Self {
        let mut look = self.clone();
        if let Some(stop) = look.stops.get_mut(index) {
            let alpha = stop.color.a;
            stop.color = ThemeColor {
                a: alpha,
                ..pad_color(stop.x, stop.y, lightness)
            };
        }
        look
    }

    pub fn with_angle(&self, degrees: f64) -> Self {
        Self {
            angle: Some(normalized_angle(js_round(degrees))),
            ..self.clone()
        }
    }

    pub fn with_added_stop(&self) -> Self {
        if self.stops.len() >= MAX_THEME_STOPS {
            return self.clone();
        }
        let (lx, ly) = self.stops.last().map_or((0.8, 0.5), |s| (s.x, s.y));
        let angle = (ly - 0.5).atan2(lx - 0.5) + 2.0 * PI / 5.0;
        let radius = (lx - 0.5).hypot(ly - 0.5).max(0.3);
        let (x, y) = (0.5 + radius * angle.cos(), 0.5 + radius * angle.sin());
        let mut look = self.clone();
        look.stops.push(ThemeStop {
            x,
            y,
            color: pad_color(x, y, PAD_LIGHTNESS),
        });
        look
    }

    pub fn without_stop(&self, index: usize) -> Self {
        let mut look = self.clone();
        if look.stops.len() > 1 && index < look.stops.len() {
            look.stops.remove(index);
        }
        look
    }

    pub fn with_texture(&self, texture: ThemeTexture) -> Self {
        Self {
            texture,
            grain: if self.grain == 0.0 {
                STARTING_NOISE
            } else {
                self.grain
            },
            ..self.clone()
        }
    }
}

fn sanitize_color(v: &Value) -> Option<ThemeColor> {
    let c = v.as_object()?;
    let part = |key: &str| c.get(key).and_then(finite).filter(|n| n.abs() < 4.0);
    Some(ThemeColor {
        r: part("r")?,
        g: part("g")?,
        b: part("b")?,
        a: clamp01(number_or(c.get("a"), 1.0)),
    })
}

fn direction(degrees: f64) -> (f64, f64) {
    let r = degrees * PI / 180.0;
    (r.sin(), -r.cos())
}

pub fn arc_area(
    colors: &[[f64; 4]],
    angle: f64,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
) -> [f64; 3] {
    let Some(first) = colors.first() else {
        return [0.5, 0.5, 0.5];
    };
    let rgb = |c: &[f64; 4]| [c[0], c[1], c[2]];
    let second = colors.get(1).unwrap_or(first);
    let t = clamp01(along(angle, x, y, width, height, base_half) / BASE_REACH);
    let base = color::mix_oklab(rgb(first), rgb(second), t);
    let Some(third) = colors.get(2) else {
        return base;
    };
    let a = clamp01(along(angle + 45.0, x, y, width, height, overlay_half)) * third[3];
    [
        base[0] + (third[0] - base[0]) * a,
        base[1] + (third[1] - base[1]) * a,
        base[2] + (third[2] - base[2]) * a,
    ]
}

fn base_half(width: f64, height: f64, dx: f64, dy: f64) -> f64 {
    ((width * dx).hypot(height * dy) * width.hypot(height)) / (2.0 * width.max(height))
}

fn overlay_half(width: f64, height: f64, dx: f64, dy: f64) -> f64 {
    (width * dx.abs() + height * dy.abs()) / 2.0
}

fn along(
    degrees: f64,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
    half: fn(f64, f64, f64, f64) -> f64,
) -> f64 {
    let (dx, dy) = direction(degrees);
    let h = half(width, height, dx, dy);
    if h <= 0.0 {
        return 0.5;
    }
    ((x - width / 2.0) * dx + (y - height / 2.0) * dy) / (2.0 * h) + 0.5
}

fn unit_color([r, g, b]: [f64; 3]) -> RgbaColor {
    RgbaColor::new(clamp01(r) as f32, clamp01(g) as f32, clamp01(b) as f32, 1.0).quantized()
}

pub fn arc_layer_alpha(intensity: f64) -> f64 {
    0.2 + 0.55 * clamp01(intensity)
}

pub fn backdrop_under_grey(underlay_alpha: f64, dark: bool) -> f64 {
    let u = clamp01(underlay_alpha);
    let blur = if dark { 0.16 } else { 0.92 };
    (if dark { 0.0 } else { 1.0 }) * u + blur * (1.0 - u)
}

pub fn pad_color(x: f64, y: f64, lightness: f64) -> ThemeColor {
    let (dx, dy) = (clamp01(x) - 0.5, clamp01(y) - 0.5);
    let mut hue = dy.atan2(dx) / (2.0 * PI);
    if hue < 0.0 {
        hue += 1.0;
    }
    let sat = (dx.hypot(dy) / 0.5).min(1.0);
    let (r, g, b) = color::hsl_to_rgb(hue, sat, clamp01(lightness));
    ThemeColor::new(r, g, b, 1.0)
}

pub fn pad_position(c: ThemeColor) -> (f64, f64) {
    let (h, s, _) = color::rgb_to_hsl(clamp01(c.r), clamp01(c.g), clamp01(c.b));
    let angle = h * 2.0 * PI;
    (0.5 + 0.5 * s * angle.cos(), 0.5 + 0.5 * s * angle.sin())
}

pub fn stop_lightness(stop: &ThemeStop) -> f64 {
    color::rgb_to_hsl(
        clamp01(stop.color.r),
        clamp01(stop.color.g),
        clamp01(stop.color.b),
    )
    .2
}

impl ProfileTheme {
    pub fn sanitize(value: &Value) -> Option<Self> {
        let look = ThemeLook::sanitize(value)?;
        let fields = value.as_object()?;
        let mode = match fields.get("mode").and_then(Value::as_str) {
            Some("light") => ThemeMode::Light,
            Some("dark") => ThemeMode::Dark,
            _ => ThemeMode::Auto,
        };
        Some(ProfileTheme {
            look,
            mode,
            dark: fields.get("dark").and_then(ThemeLook::sanitize),
        })
    }

    pub fn to_value(&self) -> Value {
        let mut out = Map::new();
        self.look.write_into(&mut out);
        out.insert(
            "mode".into(),
            match self.mode {
                ThemeMode::Auto => "auto",
                ThemeMode::Light => "light",
                ThemeMode::Dark => "dark",
            }
            .into(),
        );
        if let Some(dark) = &self.dark {
            out.insert("dark".into(), dark.to_value());
        }
        Value::Object(out)
    }

    pub fn starting(swatch: RgbaColor) -> Self {
        let (bx, by) = pad_position(ThemeColor::from_rgba(swatch));
        let angle = (by - 0.5).atan2(bx - 0.5);
        let radius = (bx - 0.5).hypot(by - 0.5).max(0.3);
        let stop = |offset: f64| {
            let (x, y) = (
                0.5 + radius * (angle + offset).cos(),
                0.5 + radius * (angle + offset).sin(),
            );
            ThemeStop {
                x,
                y,
                color: pad_color(x, y, PAD_LIGHTNESS),
            }
        };
        ProfileTheme {
            look: ThemeLook {
                stops: vec![stop(-0.45), stop(0.45)],
                intensity: 0.6,
                grain: 0.0,
                texture: ThemeTexture::Grain,
                translucency: 1.0,
                angle: None,
            },
            mode: ThemeMode::Auto,
            dark: None,
        }
    }

    pub fn wants_dark(&self, app_dark: bool) -> bool {
        match self.mode {
            ThemeMode::Auto => app_dark,
            ThemeMode::Dark => true,
            ThemeMode::Light => false,
        }
    }

    pub fn resolved(&self, dark: bool) -> ProfileTheme {
        match (&self.dark, dark) {
            (Some(dark_look), true) => ProfileTheme {
                look: dark_look.clone(),
                mode: self.mode,
                dark: None,
            },
            _ => ProfileTheme {
                look: self.look.clone(),
                mode: self.mode,
                dark: None,
            },
        }
    }

    pub fn requested_dark(&self, app_dark: bool, source: LookSource) -> bool {
        if source == LookSource::Own {
            self.wants_dark(app_dark)
        } else {
            app_dark
        }
    }

    pub fn shown(&self, app_dark: bool, source: LookSource) -> ShownLook {
        let requested_dark = self.requested_dark(app_dark, source);
        let resolved = self.resolved(requested_dark);
        let light_only = self.mode != ThemeMode::Dark && self.dark.is_none();
        let look = if source != LookSource::Own
            && requested_dark
            && light_only
            && !resolved.look.readable_dark(true)
        {
            ProfileTheme {
                look: resolved.look.darkened(DARKENED_LOOK_KEEP),
                ..resolved
            }
        } else {
            resolved
        };
        let dark = if source == LookSource::Utility {
            requested_dark
        } else {
            look.look.readable_dark(requested_dark)
        };
        ShownLook {
            look,
            requested_dark,
            dark,
        }
    }

    pub fn accent(&self) -> RgbaColor {
        self.look.accent()
    }
}

impl Serialize for ProfileTheme {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        self.to_value().serialize(serializer)
    }
}

impl<'de> Deserialize<'de> for ProfileTheme {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let value = Value::deserialize(deserializer)?;
        ProfileTheme::sanitize(&value).ok_or_else(|| D::Error::custom("not a profile theme"))
    }
}

impl Serialize for ThemeLook {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        self.to_value().serialize(serializer)
    }
}

impl<'de> Deserialize<'de> for ThemeLook {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let value = Value::deserialize(deserializer)?;
        ThemeLook::sanitize(&value).ok_or_else(|| D::Error::custom("not a theme look"))
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct BackdropTint {
    pub color: RgbaColor,
    pub alpha: f32,
    pub lightness: f32,
}

impl BackdropTint {
    pub fn new(color: RgbaColor, neutral: bool) -> Self {
        BackdropTint {
            color,
            alpha: if neutral {
                NEUTRAL_TINT_ALPHA
            } else {
                TINT_ALPHA
            },
            lightness: GRADIENT_LIGHTNESS_DELTA,
        }
    }

    pub fn opaque(&self, dark: bool, fill: BlurFill) -> [RgbaColor; 2] {
        let a = f64::from(self.alpha) * if dark { 0.5 } else { 0.75 };
        let under = if dark {
            fill.dark.map(|f| 0.6 * f64::from(f))
        } else {
            fill.light.map(|f| 0.8 * 255.0 + 0.2 * f64::from(f))
        };
        let top = self.color.to_u8_unrounded();
        let bottom = self.color.lightened(self.lightness).to_u8_unrounded();
        let over = |c: [f64; 3]| {
            let mix =
                |i: usize| ((a * c[i] + (1.0 - a) * under[i]).clamp(0.0, 255.0).round()) as u8;
            RgbaColor::rgb8(mix(0), mix(1), mix(2))
        };
        [over(top), over(bottom)]
    }
}

trait Unrounded {
    fn to_u8_unrounded(self) -> [f64; 3];
}

impl Unrounded for RgbaColor {
    fn to_u8_unrounded(self) -> [f64; 3] {
        [
            f64::from(self.r) * 255.0,
            f64::from(self.g) * 255.0,
            f64::from(self.b) * 255.0,
        ]
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct BlurFill {
    pub dark: [f32; 3],
    pub light: [f32; 3],
}

pub const INACTIVE_FILL: BlurFill = BlurFill {
    dark: [40.7, 33.1, 31.8],
    light: [235.0, 231.0, 230.0],
};
pub const NEUTRAL_FILL: BlurFill = BlurFill {
    dark: [68.4, 68.4, 68.4],
    light: [211.0, 211.0, 211.0],
};

pub fn tint_for_hue(swatch: RgbaColor, grey: bool) -> RgbaColor {
    let hsl = swatch.to_hsl();
    RgbaColor::from_hsl(
        color::Hsl {
            h: hsl.h,
            s: if grey { 0.0 } else { 0.36 },
            l: 0.527,
        },
        1.0,
    )
    .quantized()
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum VibrancyMaterial {
    PrivateDark,
    HudWindow,
}

impl VibrancyMaterial {
    pub const fn raw(self) -> i64 {
        match self {
            VibrancyMaterial::PrivateDark => 29,
            VibrancyMaterial::HudWindow => 13,
        }
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct CustomBackdrop {
    pub colors: Vec<RgbaColor>,
    pub opacity: f32,
    pub base_alpha: f32,
    pub grain: f32,
    pub texture: ThemeTexture,
    pub appearance: ThemeMode,
    pub angle: f32,
}

impl CustomBackdrop {
    pub fn of(look: &ThemeLook, dark: bool, mode: ThemeMode) -> Self {
        CustomBackdrop {
            colors: look
                .stops
                .iter()
                .take(MAX_THEME_STOPS)
                .map(|s| s.color.to_rgba())
                .collect(),
            opacity: look.layer_alpha() as f32,
            base_alpha: look.underlay_alpha(dark) as f32,
            grain: look.grain_alpha() as f32,
            texture: look.texture,
            appearance: mode,
            angle: look.angle() as f32,
        }
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct WindowTreatment {
    pub dark: bool,
    pub material: VibrancyMaterial,
    pub base_tint: RgbaColor,
    pub gradient: Option<[RgbaColor; 2]>,
    pub gradient_opacity: f32,
    pub custom: Option<CustomBackdrop>,
    pub content_fill: RgbaColor,
}

impl WindowTreatment {
    pub fn preset(tint: &BackdropTint, dark: bool) -> Self {
        let top = tint.color.with_alpha(tint.alpha);
        let bottom = tint.color.lightened(tint.lightness).with_alpha(tint.alpha);
        WindowTreatment {
            dark,
            material: if dark {
                VibrancyMaterial::PrivateDark
            } else {
                VibrancyMaterial::HudWindow
            },
            base_tint: tokens::dia(dark).window_background_base_tint,
            gradient: Some([top, bottom]),
            gradient_opacity: if dark { 0.5 } else { 0.75 },
            custom: None,
            content_fill: tokens::dia(dark).window_content_rebrand_tint,
        }
    }

    pub fn custom(backdrop: CustomBackdrop, dark: bool) -> Self {
        let base = if dark {
            RgbaColor::black(backdrop.base_alpha)
        } else {
            RgbaColor::white(backdrop.base_alpha)
        };
        WindowTreatment {
            dark,
            material: if dark {
                VibrancyMaterial::PrivateDark
            } else {
                VibrancyMaterial::HudWindow
            },
            base_tint: base,
            gradient: None,
            gradient_opacity: if dark { 0.5 } else { 0.75 },
            custom: Some(backdrop),
            content_fill: tokens::dia(dark).window_content_rebrand_tint,
        }
    }

    pub fn composite(&self, x: f32, y: f32, blur: RgbaColor) -> RgbaColor {
        let blur = blur.opaque();
        let based = self.base_tint.over(blur);
        if let Some(custom) = &self.custom {
            let colors: Vec<[f64; 4]> = custom
                .colors
                .iter()
                .map(|c| {
                    [
                        f64::from(c.r),
                        f64::from(c.g),
                        f64::from(c.b),
                        f64::from(c.a),
                    ]
                })
                .collect();
            let [r, g, b] = arc_area(
                &colors,
                f64::from(custom.angle),
                f64::from(x.clamp(0.0, 1.0)),
                f64::from(y.clamp(0.0, 1.0)),
                1.0,
                1.0,
            );
            let layer =
                RgbaColor::new(r as f32, g as f32, b as f32, custom.opacity.clamp(0.0, 1.0));
            return layer.over(based);
        }
        match self.gradient {
            Some([top, bottom]) => {
                let at = top.mix(bottom, y.clamp(0.0, 1.0));
                at.with_alpha(at.a * self.gradient_opacity).over(based)
            }
            None => based,
        }
    }

    pub fn grain_opacity(&self, active: bool) -> f32 {
        let grain = self
            .custom
            .as_ref()
            .map_or(0.0, |c| c.grain.clamp(0.0, 1.0));
        grain * if active { 1.0 } else { INACTIVE_GRAIN }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum ThemeFamily {
    Preset(ProfileColor),
    Incognito,
}

impl ThemeFamily {
    pub fn preset(self) -> Option<ProfileColor> {
        match self {
            ThemeFamily::Preset(color) => Some(color),
            ThemeFamily::Incognito => None,
        }
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct Backdrop {
    pub tint: BackdropTint,
    pub custom: Option<CustomBackdrop>,
    pub appearance: ThemeMode,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Theme {
    pub roles: ColorRoles,
    pub row_selected_text: RgbaColor,
    pub pinned_divider: RgbaColor,
    pub adaptive_ink: bool,
    pub high_contrast_text: bool,
    pub family: ThemeFamily,
    pub nearest: ThemeFamily,
    pub backdrop: Backdrop,
    pub window_tint: [RgbaColor; 2],
    pub power_up_color: Option<RgbaColor>,
    pub power_up_palette: Vec<RgbaColor>,
    pub custom: Option<Arc<ProfileTheme>>,
}

#[derive(Clone, Copy, Debug)]
pub struct ProfileLook<'a> {
    pub color: ProfileColor,
    pub theme: Option<&'a ProfileTheme>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum FieldSurface {
    NtpBarSolid,
    Field,
    Panel,
    PopoverField,
}

impl FieldSurface {
    pub fn color(self, roles: &ColorRoles) -> RgbaColor {
        match self {
            FieldSurface::NtpBarSolid => roles.ntp_bar_solid,
            FieldSurface::Field => roles.field,
            FieldSurface::Panel => roles.panel,
            FieldSurface::PopoverField => popover_field_surface(roles),
        }
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash)]
pub enum SelectedTabGlow {
    #[default]
    Full,
    Soft,
    Off,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Glow {
    pub color: RgbaColor,
    pub opacity: f32,
    pub radius: f32,
}

fn backdrop_over(fill: RgbaColor, backdrop: RgbaColor) -> RgbaColor {
    fill.over(backdrop.opaque()).quantized()
}

fn worst_contrast(text: RgbaColor, rows: &[RgbaColor]) -> f32 {
    rows.iter()
        .map(|row| text.contrast_ratio(*row))
        .fold(f32::INFINITY, f32::min)
}

pub fn ink_on(rows: &[RgbaColor], dark: bool) -> RgbaColor {
    let (own, other) = if dark {
        (RgbaColor::WHITE, RgbaColor::BLACK)
    } else {
        (RgbaColor::BLACK, RgbaColor::WHITE)
    };
    let mine = worst_contrast(own, rows);
    if mine >= MIN_INK_CONTRAST || worst_contrast(other, rows) <= mine {
        own
    } else {
        other
    }
}

fn oklab_lightness(c: RgbaColor) -> f32 {
    c.to_oklab().l
}

pub fn selection_lightness_delta(fill: RgbaColor, backdrops: &[RgbaColor]) -> f32 {
    backdrops
        .iter()
        .map(|b| (oklab_lightness(backdrop_over(fill, *b)) - oklab_lightness(b.opaque())).abs())
        .fold(f32::INFINITY, f32::min)
}

fn overlay_at(c: RgbaColor, step: u32) -> RgbaColor {
    let byte = (f64::from(step) * 2.55).round().clamp(0.0, 255.0) as u8;
    let [r, g, b, _] = c.to_u8();
    RgbaColor::from([r, g, b, byte])
}

fn lifted(fill: RgbaColor, fallback: RgbaColor, backdrops: &[RgbaColor], cap: f32) -> RgbaColor {
    let passes = |c: RgbaColor| selection_lightness_delta(c, backdrops) >= MIN_SELECTION_LIGHTNESS;
    if backdrops.is_empty() || passes(fill) {
        return fill;
    }
    let steps = (f64::from(cap) * 100.0).round() as u32;
    for step in 1..=steps {
        let shown = overlay_at(fallback, step);
        if passes(shown) {
            return shown;
        }
    }
    overlay_at(fallback, steps)
}

pub fn visible_selection(
    fill: RgbaColor,
    fallback: RgbaColor,
    backdrops: &[RgbaColor],
) -> RgbaColor {
    lifted(fill, fallback, backdrops, MAX_FALLBACK_ALPHA)
}

pub fn visible_line(line: RgbaColor, ink: RgbaColor, backdrops: &[RgbaColor]) -> RgbaColor {
    lifted(line, ink, backdrops, MAX_LINE_ALPHA)
}

fn shown_contrast(c: RgbaColor, surface: RgbaColor) -> f32 {
    backdrop_over(c, surface).contrast_ratio(surface)
}

pub fn popover_field_surface(roles: &ColorRoles) -> RgbaColor {
    let ground = if roles.dark {
        RgbaColor::BLACK
    } else {
        RgbaColor::WHITE
    };
    let material = if roles.dark {
        tokens::POPOVER_MENU_MATERIAL_DARK
    } else {
        tokens::POPOVER_MENU_MATERIAL_LIGHT
    };
    let base = backdrop_over(roles.popover_fill, ground);
    backdrop_over(roles.popover_tint, backdrop_over(material, base))
}

pub fn nearest_preset(c: RgbaColor) -> ProfileColor {
    let hsl = c.to_hsl();
    if hsl.s < 0.12 {
        return ProfileColor::Neutral;
    }
    let mut best = ProfileColor::Plum;
    let mut distance = f32::INFINITY;
    for color in ProfileColor::ALL {
        if color == ProfileColor::Neutral {
            continue;
        }
        let h = color.spec().swatch.to_hsl().h;
        let d = (h - hsl.h).abs().min(1.0 - (h - hsl.h).abs());
        if d < distance {
            best = color;
            distance = d;
        }
    }
    best
}

pub fn profile_accent(look: ProfileLook<'_>) -> RgbaColor {
    look.theme
        .map_or(look.color.spec().swatch, ProfileTheme::accent)
}

pub fn profile_name_color(look: ProfileLook<'_>, dark: bool) -> RgbaColor {
    let base = match look.theme {
        Some(theme) => theme.resolved(dark).accent(),
        None => look.color.spec().action_color(),
    };
    if dark {
        base.mix(RgbaColor::WHITE, 0.6).opaque().quantized()
    } else {
        base.mix(RgbaColor::BLACK, 0.4).opaque().quantized()
    }
}

impl Theme {
    pub fn preset(family: ThemeFamily, dark: bool) -> Self {
        let roles = if family == ThemeFamily::Incognito || dark {
            tokens::DARK
        } else {
            tokens::LIGHT
        };
        let spec = family.preset().map(ProfileColor::spec);
        let neutral = spec.is_none_or(|s| s.is_neutral());
        let tint_color = spec.map_or(INCOGNITO_TINT, |s| {
            s.tint
                .unwrap_or_else(|| tint_for_hue(s.swatch, s.is_neutral()))
        });
        let tint = BackdropTint::new(tint_color, neutral);
        let power_up_color = spec.map(|s| s.power_up_color());
        Theme {
            row_selected_text: roles.tab_selected_text,
            pinned_divider: roles.divider,
            adaptive_ink: false,
            high_contrast_text: false,
            family,
            nearest: family,
            backdrop: Backdrop {
                tint,
                custom: None,
                appearance: ThemeMode::Auto,
            },
            window_tint: tint.opaque(roles.dark, INACTIVE_FILL),
            power_up_color,
            power_up_palette: power_up_color.into_iter().collect(),
            custom: None,
            roles,
        }
    }

    pub fn incognito() -> Self {
        Self::preset(ThemeFamily::Incognito, true)
    }

    pub fn custom(
        custom: &Arc<ProfileTheme>,
        color: ProfileColor,
        app_dark: bool,
        source: LookSource,
        adaptive_ink: bool,
    ) -> Self {
        let shown = custom.shown(app_dark, source);
        let dark = shown.dark;
        let look = &shown.look.look;
        let preset = Theme::preset(ThemeFamily::Preset(color), dark);
        let accent = look.accent();
        let palette = look.palette();
        let window_tint = look.opaque_tint(dark);
        let base = *tokens::roles(dark);
        let mut roles = preset.roles;
        let tab_selected = if base.dark {
            tokens::ARC_SELECTED_FILL_DARK
        } else {
            visible_selection(
                tokens::ARC_SELECTED_FILL_LIGHT,
                RgbaColor::BLACK,
                &window_tint,
            )
        };
        let ink_over = |fill: RgbaColor| {
            if adaptive_ink {
                let rows: Vec<RgbaColor> = window_tint
                    .iter()
                    .map(|t| backdrop_over(fill, *t))
                    .collect();
                ink_on(&rows, base.dark)
            } else {
                base.tab_selected_text
            }
        };
        roles.tab_selected = tab_selected;
        roles.pinned_selected_fill = visible_selection(
            base.pinned_selected_fill,
            if base.dark {
                RgbaColor::WHITE
            } else {
                RgbaColor::BLACK
            },
            &window_tint,
        );
        roles.tab_selected_text = ink_over(base.card);
        let row_selected_text = ink_over(tab_selected);
        let appearance = if dark != shown.requested_dark {
            if dark {
                ThemeMode::Dark
            } else {
                ThemeMode::Light
            }
        } else if source == LookSource::Own {
            custom.mode
        } else {
            ThemeMode::Auto
        };
        Theme {
            roles,
            row_selected_text,
            pinned_divider: visible_line(
                preset.roles.divider,
                ink_on(&window_tint, dark),
                &window_tint,
            ),
            adaptive_ink,
            high_contrast_text: false,
            family: ThemeFamily::Preset(color),
            nearest: ThemeFamily::Preset(nearest_preset(accent)),
            backdrop: Backdrop {
                tint: BackdropTint::new(accent, false),
                custom: Some(CustomBackdrop::of(look, dark, appearance)),
                appearance,
            },
            window_tint,
            power_up_color: Some(accent),
            power_up_palette: if palette.len() > 1 {
                palette
            } else {
                vec![palette.first().copied().unwrap_or(accent)]
            },
            custom: Some(Arc::clone(custom)),
        }
    }

    pub fn for_profile(
        color: ProfileColor,
        theme: Option<&Arc<ProfileTheme>>,
        app_dark: bool,
        source: LookSource,
        adapt_text_to_color: bool,
    ) -> Self {
        match theme {
            Some(theme) => Theme::custom(theme, color, app_dark, source, adapt_text_to_color),
            None => Theme::preset(ThemeFamily::Preset(color), app_dark),
        }
    }

    pub fn scoped(
        incognito: bool,
        color: ProfileColor,
        theme: Option<&Arc<ProfileTheme>>,
        app_dark: bool,
        source: LookSource,
        adapt_text_to_color: bool,
    ) -> Self {
        if incognito {
            Theme::incognito()
        } else {
            Theme::for_profile(color, theme, app_dark, source, adapt_text_to_color)
        }
    }

    pub fn dark(&self) -> bool {
        self.roles.dark
    }

    pub fn treatment(&self) -> WindowTreatment {
        match &self.backdrop.custom {
            Some(custom) => WindowTreatment::custom(custom.clone(), self.roles.dark),
            None => WindowTreatment::preset(&self.backdrop.tint, self.roles.dark),
        }
    }

    pub fn tinted(&self) -> Theme {
        if !self.adaptive_ink {
            return self.clone();
        }
        let own = if self.roles.dark {
            RgbaColor::WHITE
        } else {
            RgbaColor::BLACK
        };
        if ink_on(&self.window_tint, self.roles.dark) == own {
            return self.clone();
        }
        let mut roles = *tokens::roles(!self.roles.dark);
        roles.tab_selected = self.roles.tab_selected;
        roles.pinned_selected_fill = self.roles.pinned_selected_fill;
        Theme {
            roles,
            ..self.clone()
        }
    }

    pub fn high_contrast(&self) -> Theme {
        if self.high_contrast_text {
            return self.clone();
        }
        let ink = |alpha: f32| self.roles.text_primary.with_alpha(alpha);
        let mut roles = self.roles;
        roles.text_tab = ink(HIGH_CONTRAST_INK.tab);
        roles.text_secondary = ink(HIGH_CONTRAST_INK.secondary);
        roles.text_tertiary = ink(HIGH_CONTRAST_INK.tertiary);
        roles.placeholder = ink(HIGH_CONTRAST_INK.placeholder);
        roles.icon = self.roles.icon.with_alpha(HIGH_CONTRAST_INK.icon);
        Theme {
            roles,
            high_contrast_text: true,
            ..self.clone()
        }
    }

    fn opaque_surface(&self, surface: RgbaColor) -> RgbaColor {
        backdrop_over(
            surface,
            if self.roles.dark {
                RgbaColor::BLACK
            } else {
                RgbaColor::WHITE
            },
        )
    }

    fn stock_roles(&self) -> &'static ColorRoles {
        tokens::roles(self.roles.dark)
    }

    pub fn readable_ink(
        &self,
        preferred: RgbaColor,
        surface: RgbaColor,
        stock_surface: RgbaColor,
    ) -> RgbaColor {
        let shown_on = self.opaque_surface(surface);
        let floor = MIN_INK_CONTRAST.min(shown_contrast(
            preferred,
            self.opaque_surface(stock_surface),
        ));
        if shown_contrast(preferred, shown_on) >= floor {
            return preferred;
        }
        [self.roles.text_primary, RgbaColor::BLACK, RgbaColor::WHITE]
            .into_iter()
            .fold(preferred, |best, c| {
                if shown_contrast(c, shown_on) > shown_contrast(best, shown_on) {
                    c
                } else {
                    best
                }
            })
    }

    pub fn caret_color(&self, surface: FieldSurface) -> RgbaColor {
        let preferred = if self.roles.dark {
            tokens::CARET_DARK
        } else {
            tokens::CARET_LIGHT
        };
        self.readable_ink(
            preferred,
            surface.color(&self.roles),
            surface.color(self.stock_roles()),
        )
    }

    pub fn caret_color_on_row(&self, fill: RgbaColor, stock_fill: RgbaColor) -> RgbaColor {
        let stock = Theme::preset(self.nearest, self.roles.dark);
        let worst_on = |backdrops: &[RgbaColor], row: RgbaColor, c: RgbaColor| {
            backdrops
                .iter()
                .map(|t| shown_contrast(c, backdrop_over(row, *t)))
                .fold(f32::INFINITY, f32::min)
        };
        let preferred = if self.roles.dark {
            tokens::CARET_DARK
        } else {
            tokens::CARET_LIGHT
        };
        let floor = MIN_INK_CONTRAST.min(worst_on(&stock.window_tint, stock_fill, preferred));
        if worst_on(&self.window_tint, fill, preferred) >= floor {
            return preferred;
        }
        [self.roles.text_primary, RgbaColor::BLACK, RgbaColor::WHITE]
            .into_iter()
            .fold(preferred, |best, c| {
                if worst_on(&self.window_tint, fill, c) > worst_on(&self.window_tint, fill, best) {
                    c
                } else {
                    best
                }
            })
    }

    fn quiet_ink(&self) -> RgbaColor {
        if self.roles.dark || self.high_contrast_text {
            self.roles.text_tertiary
        } else {
            tokens::QUIET_GLYPH_LIGHT
        }
    }

    pub fn quiet_bar_glyph(&self) -> RgbaColor {
        self.readable_ink(
            self.quiet_ink(),
            self.roles.ntp_bar_solid,
            self.stock_roles().ntp_bar_solid,
        )
    }

    pub fn idle_go_fill(&self) -> RgbaColor {
        backdrop_over(self.roles.go_button_idle, self.roles.ntp_bar_solid)
    }

    pub fn quiet_go_label(&self) -> RgbaColor {
        let stock = self.stock_roles();
        self.readable_ink(
            self.quiet_ink(),
            self.idle_go_fill(),
            backdrop_over(stock.go_button_idle, stock.ntp_bar_solid),
        )
    }

    pub fn selected_tab_glow(&self, level: SelectedTabGlow) -> Glow {
        let (opacity, spread) = match level {
            SelectedTabGlow::Full => (1.0, 1.0),
            SelectedTabGlow::Soft => (0.45, 0.6),
            SelectedTabGlow::Off => (0.0, 1.0),
        };
        Glow {
            color: self.roles.tab_selected_shadow,
            opacity,
            radius: self.roles.tab_selected_shadow_radius * spread,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use proptest::prelude::*;
    use serde_json::json;

    fn plum_session_theme() -> Value {
        json!({
            "angle": 5, "grain": 1, "intensity": 0.8242658132530121, "mode": "auto", "texture": "grain", "translucency": 1,
            "stops": [
                {"color": {"a": 1, "b": 0.31436483901575474, "g": 0.6489455453423616, "r": 0.8856351609842452}, "x": 0.791969476744186, "y": 0.7055096293604651},
                {"color": {"a": 1, "b": 0.5349601410172073, "g": 0.3032914500656152, "r": 0.8967085499343848}, "x": 0.840320675872093, "y": 0.35256177325581395},
                {"color": {"a": 1, "b": 0.8458532186887178, "g": 0.6102686258229979, "r": 0.3541467813112822}, "x": 0.23055959302325582, "y": 0.3521984011627907}
            ]
        })
    }

    #[test]
    fn plum_window_tint_reproduces_the_inactive_capture_fit() {
        let theme = Theme::preset(ThemeFamily::Preset(ProfileColor::Plum), true);
        let [top, bottom] = theme.window_tint;
        assert_eq!(top.to_u8(), [52, 33, 35, 255]);
        let lightened = RgbaColor::hex(0xB25B6B).lightened(0.25);
        assert!(lightened.to_hsl().l > RgbaColor::hex(0xB25B6B).to_hsl().l);
        assert!(bottom.to_u8()[0] > top.to_u8()[0]);
        assert!(
            (i32::from(bottom.to_u8()[0]) - 59).abs() <= 1
                && (i32::from(bottom.to_u8()[1]) - 48).abs() <= 1
                && (i32::from(bottom.to_u8()[2]) - 49).abs() <= 1,
            "{:?}",
            bottom.to_u8()
        );
    }

    #[test]
    fn window_treatment_composite_matches_the_spec_formula() {
        let tint = BackdropTint::new(RgbaColor::hex(0xB25B6B), false);
        let dark = WindowTreatment::preset(&tint, true);
        let blur = RgbaColor::new(40.7 / 255.0, 33.1 / 255.0, 31.8 / 255.0, 1.0);
        let out = dark.composite(0.5, 0.0, blur);
        let expected = [
            0.18 * 178.0 + 0.82 * 0.6 * 40.7,
            0.18 * 91.0 + 0.82 * 0.6 * 33.1,
            0.18 * 107.0 + 0.82 * 0.6 * 31.8,
        ];
        for (got, want) in [out.r, out.g, out.b].iter().zip(expected) {
            assert!(
                (f64::from(*got) * 255.0 - want).abs() < 0.05,
                "{got} {want}"
            );
        }
        let light = WindowTreatment::preset(&tint, false);
        let out = light.composite(0.5, 0.0, RgbaColor::gray(0.5));
        let want = 0.27 * 178.0 + 0.73 * (0.8 * 255.0 + 0.2 * 127.5);
        assert!((f64::from(out.r) * 255.0 - want).abs() < 0.05);
        assert_eq!(dark.material.raw(), 29);
        assert_eq!(light.material.raw(), 13);
        assert_eq!(dark.content_fill.to_hex(), "#12121280");
    }

    #[test]
    fn custom_backdrops_composite_their_own_colors() {
        let red = ThemeLook {
            stops: vec![
                ThemeStop {
                    color: ThemeColor::new(1.0, 0.0, 0.0, 1.0),
                    x: 0.0,
                    y: 0.0,
                },
                ThemeStop {
                    color: ThemeColor::new(1.0, 0.0, 0.0, 1.0),
                    x: 1.0,
                    y: 1.0,
                },
            ],
            intensity: 1.0,
            grain: 0.0,
            texture: ThemeTexture::Grain,
            translucency: 0.0,
            angle: None,
        };
        let backdrop = CustomBackdrop::of(&red, true, ThemeMode::Dark);
        assert_eq!(backdrop.opacity, 1.0);
        let treatment = WindowTreatment::custom(backdrop, true);
        for (x, y) in [(0.0, 0.0), (0.5, 0.5), (1.0, 1.0)] {
            let out = treatment.composite(x, y, RgbaColor::black(1.0));
            assert_eq!(
                out.to_u8()[..3],
                [255, 0, 0],
                "an opaque red theme over black is red at {x},{y}"
            );
        }
        let mut half = treatment;
        half.custom.as_mut().unwrap().opacity = 0.5;
        let out = half.composite(0.5, 0.5, RgbaColor::black(1.0));
        assert!((i32::from(out.to_u8()[0]) - 128).abs() <= 1);
    }

    #[test]
    fn neutral_and_incognito_use_the_low_tint_alpha() {
        assert_eq!(
            Theme::preset(ThemeFamily::Preset(ProfileColor::Neutral), true)
                .backdrop
                .tint
                .alpha,
            NEUTRAL_TINT_ALPHA
        );
        let incognito = Theme::incognito();
        assert_eq!(incognito.backdrop.tint.alpha, NEUTRAL_TINT_ALPHA);
        assert_eq!(incognito.backdrop.tint.color, INCOGNITO_TINT);
        assert!(incognito.dark());
        assert_eq!(incognito.power_up_color, None);
    }

    #[test]
    fn session_theme_sanitizes_and_round_trips() {
        let theme = ProfileTheme::sanitize(&plum_session_theme()).unwrap();
        assert_eq!(theme.look.stops.len(), 3);
        assert_eq!(theme.look.angle, Some(5.0));
        assert_eq!(theme.mode, ThemeMode::Auto);
        let again = ProfileTheme::sanitize(&theme.to_value()).unwrap();
        assert_eq!(again, theme);
        let parsed: ProfileTheme = serde_json::from_value(plum_session_theme()).unwrap();
        assert_eq!(parsed, theme);
    }

    #[test]
    fn hostile_themes_are_refused_or_clamped() {
        assert!(ProfileTheme::sanitize(&json!(null)).is_none());
        assert!(ProfileTheme::sanitize(&json!({"stops": []})).is_none());
        assert!(
            ProfileTheme::sanitize(&json!({"stops": [{"color": {"r": 9, "g": 0, "b": 0}}]}))
                .is_none()
        );
        assert!(ProfileTheme::sanitize(&json!({"stops": "x"})).is_none());
        let many: Vec<Value> = (0..40)
            .map(|_| json!({"color": {"r": 0.5, "g": 0.5, "b": 0.5}, "x": 7, "y": -3}))
            .collect();
        let theme = ProfileTheme::sanitize(&json!({"stops": many, "intensity": 99, "angle": -45, "texture": "velvet", "mode": "sepia"})).unwrap();
        assert_eq!(theme.look.stops.len(), MAX_THEME_STOPS);
        assert_eq!((theme.look.stops[0].x, theme.look.stops[0].y), (1.0, 0.0));
        assert_eq!(theme.look.intensity, 1.0);
        assert_eq!(theme.look.angle, Some(315.0));
        assert_eq!(theme.look.texture, ThemeTexture::Grain);
        assert_eq!(theme.mode, ThemeMode::Auto);
        let skipped = ProfileTheme::sanitize(
            &json!({"stops": [null, 3, {"color": {"r": 0.1, "g": 0.2, "b": 0.3, "a": 5}}]}),
        )
        .unwrap();
        assert_eq!(skipped.look.stops.len(), 1);
        assert_eq!(skipped.look.stops[0].color.a, 1.0);
    }

    #[test]
    fn custom_theme_resolves_accent_palette_and_tint() {
        let theme = Arc::new(ProfileTheme::sanitize(&plum_session_theme()).unwrap());
        let resolved = Theme::custom(&theme, ProfileColor::Plum, true, LookSource::Own, true);
        assert_eq!(resolved.power_up_palette.len(), 3);
        assert!(resolved.backdrop.custom.is_some());
        assert_eq!(resolved.backdrop.tint.alpha, TINT_ALPHA);
        let treatment = resolved.treatment();
        assert!(treatment.custom.is_some() && treatment.gradient.is_none());
        assert!(
            (treatment.grain_opacity(false) - treatment.grain_opacity(true) * INACTIVE_GRAIN).abs()
                < 1e-6
        );
        assert!(resolved.window_tint.iter().all(|c| c.is_opaque()));
    }

    #[test]
    fn readable_dark_flips_bright_themes_to_light_ink() {
        let bright = ThemeLook {
            stops: vec![ThemeStop {
                color: ThemeColor::new(1.0, 1.0, 0.9, 1.0),
                x: 0.5,
                y: 0.5,
            }],
            intensity: 1.0,
            grain: 0.0,
            texture: ThemeTexture::Grain,
            translucency: 0.0,
            angle: None,
        };
        assert!(!bright.readable_dark(true));
        let deep = ThemeLook {
            stops: vec![ThemeStop {
                color: ThemeColor::new(0.05, 0.05, 0.1, 1.0),
                x: 0.5,
                y: 0.5,
            }],
            ..bright
        };
        assert!(deep.readable_dark(true));
        assert!(!deep.readable_dark(false) || deep.luminance(false) < 0.2);
        let theme = ProfileTheme {
            look: bright,
            mode: ThemeMode::Auto,
            dark: None,
        };
        let shown = theme.shown(true, LookSource::App);
        assert!(shown.requested_dark);
        assert!(shown.look.look.stops[0].color.r < 0.5);
    }

    #[test]
    fn ink_on_prefers_own_ink_until_it_is_unreadable() {
        assert_eq!(ink_on(&[RgbaColor::hex(0x2A191F)], true), RgbaColor::WHITE);
        assert_eq!(ink_on(&[RgbaColor::hex(0xF5F0E0)], true), RgbaColor::BLACK);
        assert_eq!(ink_on(&[RgbaColor::hex(0xF5F0E0)], false), RgbaColor::BLACK);
        assert_eq!(ink_on(&[RgbaColor::hex(0x101010)], false), RgbaColor::WHITE);
    }

    #[test]
    fn tinted_theme_swaps_palettes_on_a_light_custom_backdrop() {
        let bright = ProfileTheme {
            look: ThemeLook {
                stops: vec![ThemeStop {
                    color: ThemeColor::new(0.98, 0.95, 0.85, 1.0),
                    x: 0.5,
                    y: 0.5,
                }],
                intensity: 1.0,
                grain: 0.0,
                texture: ThemeTexture::Grain,
                translucency: 0.0,
                angle: None,
            },
            mode: ThemeMode::Dark,
            dark: None,
        };
        let theme = Theme::custom(
            &Arc::new(bright),
            ProfileColor::Yellow,
            true,
            LookSource::Utility,
            true,
        );
        assert!(theme.dark());
        let tinted = theme.tinted();
        assert!(!tinted.roles.dark);
        assert_eq!(tinted.roles.tab_selected, theme.roles.tab_selected);
        let strong = theme.high_contrast();
        assert!(strong.high_contrast_text && strong.roles.text_tab.a == 1.0);
        assert_eq!(strong.high_contrast(), strong);
    }

    #[test]
    fn visible_selection_lifts_invisible_fills() {
        let backdrop = [RgbaColor::WHITE];
        let lifted = visible_selection(RgbaColor::white(0.8), RgbaColor::BLACK, &backdrop);
        assert!(selection_lightness_delta(lifted, &backdrop) >= MIN_SELECTION_LIGHTNESS);
        assert_eq!(lifted.to_u8()[..3], [0, 0, 0]);
        let kept = visible_selection(RgbaColor::black(0.4), RgbaColor::BLACK, &backdrop);
        assert_eq!(kept, RgbaColor::black(0.4));
        assert_eq!(
            visible_line(RgbaColor::white(0.0), RgbaColor::WHITE, &[RgbaColor::WHITE]).to_u8()[3],
            77
        );
    }

    #[test]
    fn caret_stays_readable_on_custom_bar_fills() {
        let theme = Theme::preset(ThemeFamily::Preset(ProfileColor::Plum), true);
        assert_eq!(
            theme.caret_color(FieldSurface::NtpBarSolid),
            tokens::CARET_DARK
        );
        let mut odd = theme;
        odd.roles.ntp_bar_solid = RgbaColor::gray(0.97);
        assert_eq!(odd.caret_color(FieldSurface::NtpBarSolid), RgbaColor::BLACK);
        let light = Theme::preset(ThemeFamily::Preset(ProfileColor::Plum), false);
        assert_eq!(light.caret_color(FieldSurface::Field), tokens::CARET_LIGHT);
        assert!(
            light.caret_color_on_row(RgbaColor::white(0.7), RgbaColor::white(0.7))
                == tokens::CARET_LIGHT
        );
        let quiet = light.quiet_bar_glyph();
        assert!(quiet.a > 0.0);
    }

    #[test]
    fn nearest_preset_and_name_colors() {
        assert_eq!(
            nearest_preset(RgbaColor::hex(0x8E8E93)),
            ProfileColor::Neutral
        );
        assert_eq!(
            nearest_preset(RgbaColor::hex(0x3EB489)),
            ProfileColor::Green
        );
        assert_eq!(nearest_preset(RgbaColor::hex(0x4691C3)), ProfileColor::Blue);
        let name = profile_name_color(
            ProfileLook {
                color: ProfileColor::Plum,
                theme: None,
            },
            true,
        );
        assert_eq!(
            name,
            RgbaColor::hex(0xDD899B)
                .mix(RgbaColor::WHITE, 0.6)
                .quantized()
        );
        assert_eq!(
            profile_accent(ProfileLook {
                color: ProfileColor::Red,
                theme: None
            }),
            RgbaColor::hex(0xC1575C)
        );
    }

    #[test]
    fn stop_editing_helpers_keep_alpha_and_bounds() {
        let start = ProfileTheme::starting(ProfileColor::Blue.spec().swatch);
        assert_eq!(start.look.stops.len(), 2);
        let three = start.look.with_added_stop();
        assert_eq!(three.stops.len(), 3);
        assert_eq!(three.with_added_stop().stops.len(), 3);
        assert_eq!(three.without_stop(0).stops.len(), 2);
        assert_eq!(
            three
                .without_stop(0)
                .without_stop(0)
                .without_stop(0)
                .stops
                .len(),
            1
        );
        assert_eq!(start.look.with_angle(-90.4).angle, Some(270.0));
        assert_eq!(
            start.look.with_texture(ThemeTexture::Sand).grain,
            STARTING_NOISE
        );
        let moved = three.with_stop_at(1, 0.1, 0.9);
        assert_eq!((moved.stops[1].x, moved.stops[1].y), (0.1, 0.9));
        assert!((stop_lightness(&moved.stops[1]) - stop_lightness(&three.stops[1])).abs() < 1e-9);
    }

    #[test]
    fn selected_glow_levels() {
        let theme = Theme::preset(ThemeFamily::Preset(ProfileColor::Plum), true);
        assert_eq!(theme.selected_tab_glow(SelectedTabGlow::Soft).radius, 9.0);
        assert_eq!(theme.selected_tab_glow(SelectedTabGlow::Off).opacity, 0.0);
    }

    proptest! {
        #[test]
        fn theme_area_stays_finite(r in -3.9f64..3.9, g in 0f64..1.0, b in 0f64..1.0, x in 0f64..1.0, y in 0f64..1.0, angle in -720f64..720.0) {
            let look = ThemeLook { stops: vec![ThemeStop { color: ThemeColor::new(r, g, b, 1.0), x, y }, ThemeStop { color: ThemeColor::new(g, b, 0.3, 0.5), x: y, y: x }], intensity: 0.6, grain: 0.0, texture: ThemeTexture::Grain, translucency: 1.0, angle: Some(angle) };
            let area = look.area(x, y, 1.0, 1.0);
            prop_assert!(area.iter().all(|v| v.is_finite()));
            prop_assert!(look.opaque_tint(true).iter().all(|c| c.is_finite()));
        }

        #[test]
        fn sanitize_never_panics(text in ".{0,64}") {
            if let Ok(value) = serde_json::from_str::<Value>(&text) {
                let _ = ProfileTheme::sanitize(&value);
            }
        }
    }
}
