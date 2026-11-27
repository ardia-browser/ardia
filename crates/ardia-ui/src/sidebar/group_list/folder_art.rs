use std::time::{Duration, Instant};

use ardia_state::groups::GroupColor;
use ardia_state::settings::FolderStyle;
use ardia_theme::RgbaColor;
use ardia_theme::color::{from_oklab, oklab};
use gpui::{
    App, Bounds, Element, ElementId, GlobalElementId, Hsla, InspectorElementId, LayoutId, LineJoin,
    PathBuilder, PathStyle, Pixels, Point, StrokeOptions, Style, Window, linear_color_stop,
    linear_gradient, point, size,
};

use crate::primitives::theme_bridge::hsla;
use crate::scale::px;

type Rgb = [f64; 3];

const NEUTRAL_DARK: Rgb = [1.0, 1.0, 1.0];
const NEUTRAL_LIGHT: Rgb = [110.0 / 255.0, 110.0 / 255.0, 115.0 / 255.0];
pub const FOLDER_OUTLINE_CONTRAST: f64 = 3.3;
const OUTLINE_STEP: f64 = 0.01;

#[derive(Clone, Copy)]
struct InkSide {
    outline_start: f64,
    outline_end: f64,
    outline_chroma: f64,
    pastel_chroma: f64,
    pastel_chroma_max: f64,
    face: f64,
    face_chroma: f64,
    face_chroma_max: f64,
    inside_top: f64,
    inside_bottom: f64,
}

const LIGHT_INK: InkSide = InkSide {
    outline_start: 0.62,
    outline_end: 0.2,
    outline_chroma: 1.0,
    pastel_chroma: 2.0,
    pastel_chroma_max: 0.1,
    face: 0.94,
    face_chroma: 0.6,
    face_chroma_max: 0.05,
    inside_top: 0.3,
    inside_bottom: 0.55,
};

const DARK_INK: InkSide = InkSide {
    outline_start: 0.8,
    outline_end: 0.98,
    outline_chroma: 0.75,
    pastel_chroma: 0.0,
    pastel_chroma_max: 0.0,
    face: 0.32,
    face_chroma: 0.5,
    face_chroma_max: 0.05,
    inside_top: 0.45,
    inside_bottom: 0.2,
};

fn ink(dark: bool) -> InkSide {
    if dark { DARK_INK } else { LIGHT_INK }
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct FolderPalette {
    pub stroke: RgbaColor,
    pub face: RgbaColor,
    pub inside_top: RgbaColor,
    pub inside_bottom: RgbaColor,
}

fn quantize(rgb: Rgb) -> Rgb {
    rgb.map(|v| (v.clamp(0.0, 1.0) * 255.0).round() / 255.0)
}

fn of(color: RgbaColor) -> Rgb {
    quantize([f64::from(color.r), f64::from(color.g), f64::from(color.b)])
}

fn color(rgb: Rgb) -> RgbaColor {
    let [r, g, b] = quantize(rgb);
    RgbaColor::new(r as f32, g as f32, b as f32, 1.0)
}

fn mix(a: Rgb, b: Rgb, t: f64) -> Rgb {
    quantize([0, 1, 2].map(|i| a[i] + (b[i] - a[i]) * t))
}

fn luminance(rgb: Rgb) -> f64 {
    let channel = |s: f64| {
        if s <= 0.039_28 {
            s / 12.92
        } else {
            ((s + 0.055) / 1.055).powf(2.4)
        }
    };
    0.2126 * channel(rgb[0]) + 0.7152 * channel(rgb[1]) + 0.0722 * channel(rgb[2])
}

fn contrast(a: Rgb, b: Rgb) -> f64 {
    let (la, lb) = (luminance(a), luminance(b));
    (la.max(lb) + 0.05) / (la.min(lb) + 0.05)
}

#[derive(Clone, Copy)]
struct Lch {
    l: f64,
    c: f64,
    h: f64,
}

fn lch(rgb: Rgb) -> Lch {
    let [l, a, b] = oklab(rgb);
    Lch {
        l,
        c: a.hypot(b),
        h: b.atan2(a),
    }
}

fn in_gamut(rgb: Rgb) -> bool {
    rgb.iter().all(|v| *v >= -1e-4 && *v <= 1.0 + 1e-4)
}

fn lch_rgb(Lch { l, c, h }: Lch) -> Rgb {
    let at = |chroma: f64| from_oklab([l, chroma * h.cos(), chroma * h.sin()]);
    let (mut low, mut high) = (0.0, c);
    if in_gamut(at(c)) {
        low = c;
    } else {
        for _ in 0..16 {
            let mid = (low + high) / 2.0;
            if in_gamut(at(mid)) {
                low = mid;
            } else {
                high = mid;
            }
        }
    }
    quantize(at(low))
}

fn worst_contrast(rgb: Rgb, backdrops: &[Rgb]) -> f64 {
    backdrops
        .iter()
        .map(|b| contrast(rgb, *b))
        .fold(f64::INFINITY, f64::min)
}

fn outline_chroma(tint: Lch, side: InkSide) -> f64 {
    (tint.c * side.outline_chroma).max((tint.c * side.pastel_chroma).min(side.pastel_chroma_max))
}

fn outline_start(tint: Lch, dark: bool) -> f64 {
    if dark {
        tint.l.max(DARK_INK.outline_start)
    } else {
        tint.l.min(LIGHT_INK.outline_start)
    }
}

struct Outline {
    dark: bool,
    stroke: Rgb,
    contrast: f64,
}

fn folder_outline(tint_rgb: Rgb, dark: bool, backdrops: &[Rgb]) -> Outline {
    let side = ink(dark);
    let tint = lch(tint_rgb);
    let c = outline_chroma(tint, side);
    let start = outline_start(tint, dark);
    let mut l = start;
    let mut stroke = if start == tint.l {
        tint_rgb
    } else {
        lch_rgb(Lch { l, c, h: tint.h })
    };
    let mut contrast = if backdrops.is_empty() {
        f64::INFINITY
    } else {
        worst_contrast(stroke, backdrops)
    };
    while contrast < FOLDER_OUTLINE_CONTRAST
        && (if dark {
            l < side.outline_end
        } else {
            l > side.outline_end
        })
    {
        l += if dark { OUTLINE_STEP } else { -OUTLINE_STEP };
        stroke = lch_rgb(Lch { l, c, h: tint.h });
        contrast = worst_contrast(stroke, backdrops);
    }
    Outline {
        dark,
        stroke,
        contrast,
    }
}

fn face_is_dark(l: f64) -> bool {
    l >= (LIGHT_INK.outline_start + DARK_INK.outline_start) / 2.0
}

fn nearest_legible_outline(tint_rgb: Rgb, dark: bool, backdrops: &[Rgb]) -> Option<Outline> {
    let tint = lch(tint_rgb);
    let start = outline_start(tint, dark);
    let c = outline_chroma(tint, ink(dark));
    let mut k = 1;
    while f64::from(k) * OUTLINE_STEP <= 1.0 {
        for l in [
            start - f64::from(k) * OUTLINE_STEP,
            start + f64::from(k) * OUTLINE_STEP,
        ] {
            if !(0.0..=1.0).contains(&l) {
                continue;
            }
            let stroke = lch_rgb(Lch { l, c, h: tint.h });
            let contrast = worst_contrast(stroke, backdrops);
            if contrast >= FOLDER_OUTLINE_CONTRAST {
                return Some(Outline {
                    dark: face_is_dark(l),
                    stroke,
                    contrast,
                });
            }
        }
        k += 1;
    }
    let mut greys: Vec<(Rgb, f64)> = (0..=255)
        .map(|v| {
            let g = f64::from(v) / 255.0;
            let rgb = [g, g, g];
            (rgb, lch(rgb).l)
        })
        .collect();
    greys.sort_by(|a, b| (a.1 - start).abs().total_cmp(&(b.1 - start).abs()));
    greys.into_iter().find_map(|(rgb, l)| {
        let contrast = worst_contrast(rgb, backdrops);
        (contrast >= FOLDER_OUTLINE_CONTRAST).then_some(Outline {
            dark: face_is_dark(l),
            stroke: rgb,
            contrast,
        })
    })
}

fn legible_outline(tint: Rgb, dark: bool, backdrops: &[Rgb]) -> Outline {
    let preferred = folder_outline(tint, dark, backdrops);
    if preferred.contrast >= FOLDER_OUTLINE_CONTRAST {
        return preferred;
    }
    let opposite = folder_outline(tint, !dark, backdrops);
    if opposite.contrast >= FOLDER_OUTLINE_CONTRAST {
        return opposite;
    }
    if let Some(nearest) = nearest_legible_outline(tint, dark, backdrops) {
        return nearest;
    }
    if opposite.contrast > preferred.contrast {
        opposite
    } else {
        preferred
    }
}

fn neutral_palette(dark: bool) -> FolderPalette {
    let hex = |v: u32| of(RgbaColor::hex(v));
    let palette = if dark {
        let tint = NEUTRAL_DARK;
        [
            mix(hex(0xFFFFFF), tint, 0.64),
            mix(hex(0x211E29), tint, 0.12),
            mix(hex(0x211E29), tint, 0.4),
            mix(hex(0x15121E), tint, 0.24),
        ]
    } else {
        let tint = NEUTRAL_LIGHT;
        [
            tint,
            mix(hex(0xFFFFFF), tint, 0.06),
            mix(hex(0xFFFFFF), tint, 0.34),
            mix(hex(0xFFFFFF), tint, 0.64),
        ]
    };
    FolderPalette {
        stroke: color(palette[0]),
        face: color(palette[1]),
        inside_top: color(palette[2]),
        inside_bottom: color(palette[3]),
    }
}

pub fn folder_palette(
    group_tint: Option<RgbaColor>,
    dark: bool,
    profile_tint: RgbaColor,
    style: FolderStyle,
    backdrops: &[RgbaColor],
) -> FolderPalette {
    if group_tint.is_none() && style == FolderStyle::Neutral {
        return neutral_palette(dark);
    }
    let tint_rgb = of(group_tint.unwrap_or(profile_tint));
    let backdrops: Vec<Rgb> = backdrops.iter().map(|b| of(*b)).collect();
    let tint = lch(tint_rgb);
    let outline = legible_outline(tint_rgb, dark, &backdrops);
    let side = ink(outline.dark);
    let face = lch_rgb(Lch {
        l: side.face,
        c: (tint.c * side.face_chroma).min(side.face_chroma_max),
        h: tint.h,
    });
    FolderPalette {
        stroke: color(outline.stroke),
        face: color(face),
        inside_top: color(mix(face, outline.stroke, side.inside_top)),
        inside_bottom: color(mix(face, outline.stroke, side.inside_bottom)),
    }
}

type PaletteKey = (Option<u32>, bool, u32, bool, Vec<u32>);

thread_local! {
    static PALETTES: std::cell::RefCell<std::collections::HashMap<PaletteKey, FolderPalette>> =
        std::cell::RefCell::new(std::collections::HashMap::new());
}

pub fn cached_palette(
    group_tint: Option<RgbaColor>,
    dark: bool,
    profile_tint: RgbaColor,
    style: FolderStyle,
    backdrops: &[RgbaColor],
) -> FolderPalette {
    let key: PaletteKey = (
        group_tint.map(RgbaColor::to_u32),
        dark,
        profile_tint.to_u32(),
        style == FolderStyle::Neutral,
        backdrops.iter().map(|b| b.to_u32()).collect(),
    );
    if let Some(found) = PALETTES.with(|cache| cache.borrow().get(&key).copied()) {
        return found;
    }
    let palette = folder_palette(group_tint, dark, profile_tint, style, backdrops);
    PALETTES.with(|cache| {
        let mut cache = cache.borrow_mut();
        if cache.len() > 64 {
            cache.clear();
        }
        cache.insert(key, palette);
    });
    palette
}

pub fn group_tint(color: Option<GroupColor>) -> Option<RgbaColor> {
    Some(RgbaColor::hex(match color? {
        GroupColor::Grey => 0x8E8E93,
        GroupColor::Blue => 0x4C8DF6,
        GroupColor::Red => 0xE5534B,
        GroupColor::Yellow => 0xE3B341,
        GroupColor::Green => 0x3FB06C,
        GroupColor::Pink => 0xDB61A2,
        GroupColor::Purple => 0x9B6CF0,
        GroupColor::Cyan => 0x35B8C6,
        GroupColor::Orange => 0xEE8434,
        GroupColor::NoColor => return None,
    }))
}

type Polygon = [(f32, f32)];

const REAR_CLOSED: [(f32, f32); 8] = [
    (26., 88.),
    (26., 21.),
    (30., 18.),
    (54., 18.),
    (66., 26.),
    (92., 26.),
    (96., 30.),
    (96., 88.),
];
const REAR_OPEN: [(f32, f32); 8] = [
    (31., 88.),
    (15., 31.),
    (19., 28.),
    (37., 28.),
    (47., 34.),
    (67., 34.),
    (71., 38.),
    (91., 88.),
];
const FRONT_CLOSED: [(f32, f32); 4] = [(26., 36.), (96., 36.), (96., 88.), (26., 88.)];
const FRONT_OPEN: [(f32, f32); 4] = [(48.61, 43.), (106.65, 43.), (91., 88.), (31., 88.)];
const REAR_CORNER_RADIUS: f32 = 8.;
const FRONT_CORNER_RADIUS: f32 = 9.;
const STROKE_WIDTH: f32 = 8.;
const CLOSED_CENTER: (f32, f32) = (61., 53.);
const UNITS_PER_SIDE: f32 = 81.;
pub const FOLDER_OPEN_MS: u64 = 200;

pub fn smoothstep(p: f32) -> f32 {
    let p = p.clamp(0.0, 1.0);
    p * p * (3.0 - 2.0 * p)
}

pub fn blend<const N: usize>(a: &[(f32, f32); N], b: &[(f32, f32); N], u: f32) -> [(f32, f32); N] {
    std::array::from_fn(|i| {
        (
            a[i].0 + (b[i].0 - a[i].0) * u,
            a[i].1 + (b[i].1 - a[i].1) * u,
        )
    })
}

fn rounded_path(
    points: &Polygon,
    radius: f32,
    map: impl Fn((f32, f32)) -> Point<Pixels>,
    builder: &mut PathBuilder,
) {
    let n = points.len();
    for (i, v) in points.iter().enumerate() {
        let prev = points[(i + n - 1) % n];
        let next = points[(i + 1) % n];
        let d1 = (prev.0 - v.0).hypot(prev.1 - v.1);
        let d2 = (next.0 - v.0).hypot(next.1 - v.1);
        if d1 <= 0.0 || d2 <= 0.0 {
            continue;
        }
        let a = radius.min(d1 / 3.0) / d1;
        let b = radius.min(d2 / 3.0) / d2;
        let before = (v.0 + (prev.0 - v.0) * a, v.1 + (prev.1 - v.1) * a);
        let after = (v.0 + (next.0 - v.0) * b, v.1 + (next.1 - v.1) * b);
        if i == 0 {
            builder.move_to(map(before));
        } else {
            builder.line_to(map(before));
        }
        builder.curve_to(map(after), map(*v));
    }
    builder.close();
}

#[derive(Clone, Copy)]
struct FolderMotion {
    from: f32,
    to: f32,
    start: Instant,
    duration: Duration,
}

#[derive(Clone, Copy, Default)]
struct FolderState {
    progress: f32,
    wants_open: Option<bool>,
    motion: Option<FolderMotion>,
}

impl FolderState {
    fn now(&self) -> f32 {
        match self.motion {
            Some(m) => {
                let t = (m.start.elapsed().as_secs_f32() / m.duration.as_secs_f32()).clamp(0., 1.);
                m.from + (m.to - m.from) * t
            }
            None => self.progress,
        }
    }

    fn step(mut self, open: bool) -> Self {
        let to = if open { 1.0 } else { 0.0 };
        match self.wants_open {
            None => {
                self.progress = to;
                self.motion = None;
            }
            Some(was) if was != open => {
                let from = self.now();
                let ms = FOLDER_OPEN_MS as f32 * (to - from).abs();
                self.progress = to;
                self.motion = (ms > 0.0).then(|| FolderMotion {
                    from,
                    to,
                    start: Instant::now(),
                    duration: Duration::from_secs_f32(ms / 1000.0),
                });
            }
            Some(_) => {
                if self.motion.is_some_and(|m| m.start.elapsed() >= m.duration) {
                    self.motion = None;
                }
            }
        }
        self.wants_open = Some(open);
        self
    }
}

pub struct FolderArt {
    id: ElementId,
    open: bool,
    side: f32,
    palette: FolderPalette,
}

pub fn folder_art(
    id: impl Into<ElementId>,
    open: bool,
    side: f32,
    palette: FolderPalette,
) -> FolderArt {
    FolderArt {
        id: id.into(),
        open,
        side,
        palette,
    }
}

impl Element for FolderArt {
    type RequestLayoutState = ();
    type PrepaintState = f32;

    fn id(&self) -> Option<ElementId> {
        Some(self.id.clone())
    }

    fn source_location(&self) -> Option<&'static core::panic::Location<'static>> {
        None
    }

    fn request_layout(
        &mut self,
        _id: Option<&GlobalElementId>,
        _inspector_id: Option<&InspectorElementId>,
        window: &mut Window,
        cx: &mut App,
    ) -> (LayoutId, Self::RequestLayoutState) {
        let style = Style {
            size: size(px(self.side).into(), px(self.side).into()),
            flex_shrink: 0.0,
            ..Style::default()
        };
        (window.request_layout(style, [], cx), ())
    }

    fn prepaint(
        &mut self,
        id: Option<&GlobalElementId>,
        _inspector_id: Option<&InspectorElementId>,
        _bounds: Bounds<Pixels>,
        _request_layout: &mut Self::RequestLayoutState,
        window: &mut Window,
        _cx: &mut App,
    ) -> Self::PrepaintState {
        let open = self.open;
        let Some(id) = id else {
            return if open { 1.0 } else { 0.0 };
        };
        let state = window.with_element_state(id, |state: Option<FolderState>, _| {
            let next = state.unwrap_or_default().step(open);
            (next, next)
        });
        if state.motion.is_some() {
            window.request_animation_frame();
        }
        state.now()
    }

    fn paint(
        &mut self,
        _id: Option<&GlobalElementId>,
        _inspector_id: Option<&InspectorElementId>,
        bounds: Bounds<Pixels>,
        _request_layout: &mut Self::RequestLayoutState,
        progress: &mut Self::PrepaintState,
        window: &mut Window,
        _cx: &mut App,
    ) {
        let side = f32::from(bounds.size.width.min(bounds.size.height));
        if side <= 0.0 {
            return;
        }
        let unit = side / UNITS_PER_SIDE;
        let center = bounds.center();
        let map = |(x, y): (f32, f32)| {
            point(
                center.x + gpui::px((x - CLOSED_CENTER.0) * unit),
                center.y + gpui::px((y - CLOSED_CENTER.1) * unit),
            )
        };
        let u = smoothstep(*progress);
        let rear = blend(&REAR_CLOSED, &REAR_OPEN, u);
        let front = blend(&FRONT_CLOSED, &FRONT_OPEN, u);
        let stroke_style = || {
            PathStyle::Stroke(StrokeOptions {
                line_width: STROKE_WIDTH * unit,
                line_join: LineJoin::Round,
                ..StrokeOptions::default()
            })
        };
        let shape = |points: &Polygon, radius: f32, style: Option<PathStyle>| {
            let mut builder = match style {
                Some(style) => PathBuilder::fill().with_style(style),
                None => PathBuilder::fill(),
            };
            rounded_path(points, radius, map, &mut builder);
            builder.build().ok()
        };
        let palette = self.palette;
        let stroke: Hsla = hsla(palette.stroke);
        if let Some(path) = shape(&rear, REAR_CORNER_RADIUS, None) {
            window.paint_path(
                path,
                linear_gradient(
                    180.,
                    linear_color_stop(hsla(palette.inside_top), 0.),
                    linear_color_stop(hsla(palette.inside_bottom), 1.),
                ),
            );
        }
        if let Some(path) = shape(&rear, REAR_CORNER_RADIUS, Some(stroke_style())) {
            window.paint_path(path, stroke);
        }
        if let Some(path) = shape(&front, FRONT_CORNER_RADIUS, None) {
            window.paint_path(path, hsla(palette.face));
        }
        if let Some(path) = shape(&front, FRONT_CORNER_RADIUS, Some(stroke_style())) {
            window.paint_path(path, stroke);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn hex(c: RgbaColor) -> String {
        c.to_hex_rgb()
    }

    #[test]
    fn neutral_folders_use_the_fixed_greys() {
        let light = folder_palette(
            None,
            false,
            RgbaColor::hex(0xB5556B),
            FolderStyle::Neutral,
            &[],
        );
        assert_eq!(hex(light.stroke), "#6E6E73");
        let tinted = folder_palette(
            Some(RgbaColor::hex(0x4C8DF6)),
            false,
            RgbaColor::hex(0xB5556B),
            FolderStyle::Neutral,
            &[],
        );
        assert_ne!(hex(tinted.stroke), "#6E6E73");
    }

    #[test]
    fn dark_folders_lighten_their_outline_until_it_reads_on_the_backdrop() {
        let backdrop = RgbaColor::hex(0x6A3E5C);
        let palette = folder_palette(
            None,
            true,
            RgbaColor::hex(0xB5556B),
            FolderStyle::Profile,
            &[backdrop],
        );
        assert!(palette.stroke.contrast_ratio(backdrop) >= 3.2);
        assert!(palette.face.luminance() < palette.stroke.luminance());
    }

    #[test]
    fn the_folder_opens_on_a_smoothstep() {
        assert_eq!(smoothstep(0.0), 0.0);
        assert_eq!(smoothstep(1.0), 1.0);
        assert!((smoothstep(0.5) - 0.5).abs() < 1e-6);
        let half = blend(&FRONT_CLOSED, &FRONT_OPEN, 1.0);
        assert_eq!(half[1], (106.65, 43.));
    }

    #[test]
    fn a_folder_state_snaps_first_then_moves() {
        let first = FolderState::default().step(true);
        assert!(first.motion.is_none());
        assert_eq!(first.now(), 1.0);
        let closing = first.step(false);
        assert!(closing.motion.is_some());
        assert_eq!(closing.progress, 0.0);
    }
}
