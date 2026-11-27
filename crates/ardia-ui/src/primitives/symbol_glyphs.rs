use std::collections::HashMap;
use std::sync::{Arc, OnceLock};

use gpui::{Bounds, Hsla, Pixels, RenderImage, point, size};
use image::{Frame, RgbaImage};
use parking_lot::{Mutex, RwLock};

use crate::icon_picker::symbols::{SymbolWeight, packed_rgba};

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct SymbolRaster<'a> {
    pub name: &'a str,
    pub point_size: f32,
    pub weight: SymbolWeight,
    pub scale: f32,
}

#[derive(Clone, Debug, PartialEq)]
pub struct SymbolMask {
    pub pixels_wide: u32,
    pub pixels_high: u32,
    pub alpha: Vec<u8>,
    pub width: f32,
    pub height: f32,
    pub ink_offset: (f32, f32),
}

impl SymbolMask {
    fn is_well_formed(&self) -> bool {
        self.pixels_wide > 0
            && self.pixels_high > 0
            && self.alpha.len() == self.pixels_wide as usize * self.pixels_high as usize
            && self.width.is_finite()
            && self.height.is_finite()
            && self.width > 0.0
            && self.height > 0.0
    }
}

pub type SymbolRenderer = fn(&SymbolRaster<'_>, f32) -> Option<SymbolMask>;

#[derive(Clone)]
pub struct SymbolGlyph {
    pub image: Arc<RenderImage>,
    pub width: f32,
    pub height: f32,
    pub pixels_wide: u32,
    pub pixels_high: u32,
    pub ink_offset: (f32, f32),
}

#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub struct MaskKey {
    name: String,
    point_hundredths: u32,
    scale_hundredths: u32,
    fit_thousandths: u32,
    weight: SymbolWeight,
}

impl MaskKey {
    pub fn new(raster: &SymbolRaster<'_>) -> Option<Self> {
        Self::fitted(raster, 1.0)
    }

    pub fn fitted(raster: &SymbolRaster<'_>, fit: f32) -> Option<Self> {
        let valid = |value: f32| value.is_finite() && value > 0.0;
        if raster.name.is_empty()
            || !valid(raster.point_size)
            || !valid(raster.scale)
            || !valid(fit)
        {
            return None;
        }
        Some(MaskKey {
            name: raster.name.to_owned(),
            point_hundredths: hundredths(raster.point_size.min(512.0)),
            scale_hundredths: hundredths(raster.scale.min(8.0)),
            fit_thousandths: (fit.min(1.0) * 1000.0).round() as u32,
            weight: raster.weight,
        })
    }
}

fn hundredths(value: f32) -> u32 {
    (value * 100.0).round() as u32
}

const MASK_LIMIT: usize = 1024;
const IMAGE_LIMIT: usize = 4096;

static RENDERER: OnceLock<SymbolRenderer> = OnceLock::new();

type MaskCache = HashMap<MaskKey, Option<Arc<SymbolMask>>>;
type ImageCache = HashMap<(MaskKey, u32), SymbolGlyph>;

fn masks() -> &'static Mutex<MaskCache> {
    static MASKS: OnceLock<Mutex<MaskCache>> = OnceLock::new();
    MASKS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn images() -> &'static Mutex<ImageCache> {
    static IMAGES: OnceLock<Mutex<ImageCache>> = OnceLock::new();
    IMAGES.get_or_init(|| Mutex::new(HashMap::new()))
}

fn renamed() -> &'static RwLock<Arc<HashMap<String, String>>> {
    static NAMES: OnceLock<RwLock<Arc<HashMap<String, String>>>> = OnceLock::new();
    NAMES.get_or_init(|| RwLock::new(Arc::new(HashMap::new())))
}

pub fn set_symbol_renderer(renderer: SymbolRenderer) -> bool {
    RENDERER.set(renderer).is_ok()
}

pub fn has_symbol_renderer() -> bool {
    RENDERER.get().is_some()
}

pub fn set_symbol_names(names: HashMap<String, String>) {
    *renamed().write() = Arc::new(names);
}

pub fn drawn_symbol_name(name: &str) -> String {
    renamed()
        .read()
        .get(name)
        .cloned()
        .unwrap_or_else(|| name.to_owned())
}

fn mask(
    key: &MaskKey,
    raster: &SymbolRaster<'_>,
    fit: f32,
    renderer: SymbolRenderer,
) -> Option<Arc<SymbolMask>> {
    if let Some(found) = masks().lock().get(key) {
        return found.clone();
    }
    let rendered = renderer(raster, fit.min(1.0))
        .filter(SymbolMask::is_well_formed)
        .map(Arc::new);
    let mut cache = masks().lock();
    if cache.len() >= MASK_LIMIT {
        cache.clear();
    }
    cache.insert(key.clone(), rendered.clone());
    rendered
}

pub fn tinted_pixels(mask: &SymbolMask, rgba: u32) -> Vec<u8> {
    let [red, green, blue, alpha] = rgba.to_be_bytes();
    let mut pixels = Vec::with_capacity(mask.alpha.len() * 4);
    for &coverage in &mask.alpha {
        let ink = (u16::from(coverage) * u16::from(alpha) + 127) / 255;
        pixels.extend_from_slice(&[blue, green, red, ink as u8]);
    }
    pixels
}

fn tinted(mask: &SymbolMask, rgba: u32) -> Option<SymbolGlyph> {
    let buffer = RgbaImage::from_raw(
        mask.pixels_wide,
        mask.pixels_high,
        tinted_pixels(mask, rgba),
    )?;
    Some(SymbolGlyph {
        image: Arc::new(RenderImage::new([Frame::new(buffer)])),
        width: mask.width,
        height: mask.height,
        pixels_wide: mask.pixels_wide,
        pixels_high: mask.pixels_high,
        ink_offset: mask.ink_offset,
    })
}

pub fn symbol_glyph(raster: &SymbolRaster<'_>, color: Hsla) -> Option<SymbolGlyph> {
    fitted_symbol_glyph(raster, 1.0, color)
}

pub fn fitted_symbol_glyph(
    raster: &SymbolRaster<'_>,
    fit: f32,
    color: Hsla,
) -> Option<SymbolGlyph> {
    let renderer = *RENDERER.get()?;
    let key = MaskKey::fitted(raster, fit)?;
    let rgba = packed_rgba(color);
    let image_key = (key, rgba);
    if let Some(found) = images().lock().get(&image_key) {
        return Some(found.clone());
    }
    let mask = mask(&image_key.0, raster, fit, renderer)?;
    let glyph = tinted(&mask, rgba)?;
    let mut cache = images().lock();
    if cache.len() >= IMAGE_LIMIT {
        cache.clear();
    }
    cache.insert(image_key, glyph.clone());
    Some(glyph)
}

pub fn glyph_bounds(
    frame: Bounds<Pixels>,
    glyph: &SymbolGlyph,
    scale: f32,
    centres_ink: bool,
) -> Bounds<Pixels> {
    let scale = if scale.is_finite() && scale > 0.0 {
        scale
    } else {
        1.0
    };
    let drawn = symbol_drawn_rect(
        frame,
        (glyph.width, glyph.height),
        None,
        centres_ink.then_some(glyph.ink_offset),
        scale,
    );
    Bounds {
        origin: drawn.origin,
        size: size(
            gpui::px(glyph.pixels_wide as f32 / scale),
            gpui::px(glyph.pixels_high as f32 / scale),
        ),
    }
}

pub fn symbol_fit(width: f32, height: f32, frame_width: f32, frame_height: f32) -> f32 {
    let usable = |value: f32| value.is_finite() && value > 0.0;
    if !(usable(width) && usable(height) && usable(frame_width) && usable(frame_height)) {
        return 1.0;
    }
    (frame_width / width).min(frame_height / height).min(1.0)
}

pub fn symbol_drawn_rect(
    frame: Bounds<Pixels>,
    image: (f32, f32),
    fit_frame: Option<(f32, f32)>,
    ink_offset: Option<(f32, f32)>,
    scale: f32,
) -> Bounds<Pixels> {
    let fit = fit_frame.map_or(1.0, |(width, height)| {
        symbol_fit(image.0, image.1, width, height)
    });
    let (dx, dy) = ink_offset.unwrap_or((0.0, 0.0));
    let scale = if scale.is_finite() && scale > 0.0 {
        scale
    } else {
        1.0
    };
    let (width, height) = (image.0 * fit, image.1 * fit);
    let center = frame.center();
    let left = f32::from(center.x) - width / 2.0 + dx * fit;
    let top = f32::from(center.y) - height / 2.0 - dy * fit;
    let snap = |value: f32| (value * scale).round() / scale;
    Bounds {
        origin: point(gpui::px(snap(left)), gpui::px(snap(top))),
        size: size(gpui::px(width), gpui::px(height)),
    }
}

pub fn ink_offset(
    alpha: &[u8],
    wide: usize,
    high: usize,
    scale: f32,
    width: f32,
    height: f32,
) -> (f32, f32) {
    let usable = |value: f32| value.is_finite() && value > 0.0;
    if wide == 0
        || high == 0
        || alpha.len() != wide * high
        || !usable(scale)
        || !usable(width)
        || !usable(height)
    {
        return (0.0, 0.0);
    }
    let mut columns = vec![0u8; wide];
    let mut rows = vec![0u8; high];
    for (y, row) in alpha.chunks_exact(wide).enumerate() {
        for (x, &value) in row.iter().enumerate() {
            columns[x] = columns[x].max(value);
            rows[y] = rows[y].max(value);
        }
    }
    let edges = |line: &[u8], extent: f32| -> Option<(f32, f32)> {
        let first = line.iter().position(|&value| value > 0)?;
        let last = line.iter().rposition(|&value| value > 0)?;
        let lead = first as f32 + 1.0 - f32::from(line[first]) / 255.0;
        let trail = extent - last as f32 - f32::from(line[last]) / 255.0;
        Some((lead, trail))
    };
    let (Some((left, right)), Some((top, bottom))) =
        (edges(&columns, width * scale), edges(&rows, height * scale))
    else {
        return (0.0, 0.0);
    };
    ((right - left) / 2.0 / scale, (top - bottom) / 2.0 / scale)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn raster(name: &str) -> SymbolRaster<'_> {
        SymbolRaster {
            name,
            point_size: 13.0,
            weight: SymbolWeight::Medium,
            scale: 2.0,
        }
    }

    #[test]
    fn mask_keys_separate_every_input_and_refuse_bad_ones() {
        let base = MaskKey::new(&raster("chevron.left")).expect("valid");
        assert_eq!(MaskKey::new(&raster("chevron.left")), Some(base.clone()));
        for other in [
            SymbolRaster {
                name: "chevron.right",
                ..raster("")
            },
            SymbolRaster {
                point_size: 13.5,
                ..raster("chevron.left")
            },
            SymbolRaster {
                scale: 1.0,
                ..raster("chevron.left")
            },
            SymbolRaster {
                weight: SymbolWeight::Regular,
                ..raster("chevron.left")
            },
        ] {
            assert_ne!(MaskKey::new(&other), Some(base.clone()), "{other:?}");
        }
        assert_eq!(MaskKey::new(&raster("")), None);
        assert_eq!(
            MaskKey::new(&SymbolRaster {
                point_size: 0.0,
                ..raster("x")
            }),
            None
        );
        assert_eq!(
            MaskKey::new(&SymbolRaster {
                scale: f32::NAN,
                ..raster("x")
            }),
            None
        );
    }

    #[test]
    fn no_renderer_means_no_glyph() {
        assert!(!has_symbol_renderer());
        assert!(symbol_glyph(&raster("chevron.left"), gpui::black()).is_none());
    }

    #[test]
    fn tint_keeps_straight_colour_and_scales_coverage() {
        let mask = SymbolMask {
            pixels_wide: 2,
            pixels_high: 1,
            alpha: vec![255, 128],
            width: 1.0,
            height: 0.5,
            ink_offset: (0.0, 0.0),
        };
        assert_eq!(
            tinted_pixels(&mask, 0x1020_30ff),
            vec![0x30, 0x20, 0x10, 255, 0x30, 0x20, 0x10, 128]
        );
        assert_eq!(tinted_pixels(&mask, 0x1020_3080)[3], 128);
        assert_eq!(tinted_pixels(&mask, 0x1020_3080)[7], 64);
    }

    #[test]
    fn glyphs_centre_on_the_frame_and_snap_to_device_pixels() {
        let mask = SymbolMask {
            pixels_wide: 31,
            pixels_high: 27,
            alpha: vec![0; 31 * 27],
            width: 15.3,
            height: 13.2,
            ink_offset: (0.5, 1.0),
        };
        let glyph = tinted(&mask, 0xffff_ffff).expect("tinted");
        let frame = Bounds {
            origin: point(gpui::px(10.0), gpui::px(20.0)),
            size: size(gpui::px(26.0), gpui::px(26.0)),
        };
        let placed = glyph_bounds(frame, &glyph, 2.0, false);
        assert_eq!(f32::from(placed.origin.x), 15.5);
        assert_eq!(f32::from(placed.origin.y), 26.5);
        assert_eq!(f32::from(placed.size.width), 15.5);
        assert_eq!(f32::from(placed.size.height), 13.5);
        let inked = glyph_bounds(frame, &glyph, 2.0, true);
        assert_eq!(f32::from(inked.origin.x), 16.0);
        assert_eq!(f32::from(inked.origin.y), 25.5);
    }

    fn frame(x: f32, y: f32, width: f32, height: f32) -> Bounds<Pixels> {
        Bounds {
            origin: point(gpui::px(x), gpui::px(y)),
            size: size(gpui::px(width), gpui::px(height)),
        }
    }

    fn rect(bounds: Bounds<Pixels>) -> (f32, f32, f32, f32) {
        (
            f32::from(bounds.origin.x),
            f32::from(bounds.origin.y),
            f32::from(bounds.size.width),
            f32::from(bounds.size.height),
        )
    }

    #[test]
    fn plain_frames_centre_the_whole_image_at_its_natural_size() {
        let drawn = symbol_drawn_rect(
            frame(100.0, 50.0, 10.0, 10.0),
            (16.0, 12.0),
            None,
            None,
            2.0,
        );
        assert_eq!(rect(drawn), (97.0, 49.0, 16.0, 12.0));
        let odd = symbol_drawn_rect(frame(0.0, 0.0, 22.0, 22.0), (21.5, 17.0), None, None, 2.0);
        assert_eq!(rect(odd), (0.5, 2.5, 21.5, 17.0));
    }

    #[test]
    fn fit_frames_scale_proportionally_down_then_centre_like_ns_image_view() {
        let fitted = symbol_drawn_rect(
            frame(100.0, 50.0, 16.0, 10.0),
            (16.0, 12.0),
            Some((16.0, 10.0)),
            None,
            2.0,
        );
        let (x, y, width, height) = rect(fitted);
        assert_eq!((x, y), (101.5, 50.0));
        assert!((width - 16.0 * 10.0 / 12.0).abs() < 1e-4);
        assert_eq!(height, 10.0);
        let roomy = symbol_drawn_rect(
            frame(0.0, 0.0, 16.0, 16.0),
            (12.0, 11.0),
            Some((16.0, 16.0)),
            None,
            2.0,
        );
        assert_eq!(rect(roomy), (2.0, 2.5, 12.0, 11.0));
        let wide = symbol_drawn_rect(
            frame(0.0, 0.0, 16.0, 10.0),
            (20.0, 10.0),
            Some((16.0, 10.0)),
            None,
            1.0,
        );
        assert_eq!(rect(wide), (0.0, 1.0, 16.0, 8.0));
    }

    #[test]
    fn ink_offsets_shrink_with_the_fit_and_flip_upwards() {
        let inked = symbol_drawn_rect(
            frame(0.0, 0.0, 16.0, 10.0),
            (16.0, 12.0),
            Some((16.0, 10.0)),
            Some((1.2, 1.2)),
            2.0,
        );
        assert_eq!(rect(inked).0, 2.5);
        assert_eq!(rect(inked).1, -1.0);
        let bad_scale = symbol_drawn_rect(
            frame(0.0, 0.0, 10.0, 10.0),
            (3.3, 3.3),
            None,
            None,
            f32::NAN,
        );
        assert_eq!(rect(bad_scale).0, 3.0);
    }

    #[test]
    fn fitted_mask_keys_differ_from_natural_ones() {
        let natural = MaskKey::new(&raster("person.2.fill")).expect("valid");
        assert_eq!(
            MaskKey::fitted(&raster("person.2.fill"), 1.0),
            Some(natural.clone())
        );
        assert_eq!(
            MaskKey::fitted(&raster("person.2.fill"), 4.0),
            Some(natural.clone())
        );
        assert_ne!(
            MaskKey::fitted(&raster("person.2.fill"), 10.0 / 12.0),
            Some(natural)
        );
        assert_eq!(MaskKey::fitted(&raster("person.2.fill"), 0.0), None);
        assert_eq!(MaskKey::fitted(&raster("person.2.fill"), f32::NAN), None);
    }

    #[test]
    fn ink_offset_moves_low_right_ink_back_to_the_middle() {
        let wide = 4;
        let high = 4;
        let mut alpha = vec![0u8; wide * high];
        alpha[3 * wide + 3] = 255;
        let (dx, dy) = ink_offset(&alpha, wide, high, 1.0, 4.0, 4.0);
        assert_eq!((dx, dy), (-1.5, 1.5));
        assert_eq!(ink_offset(&[0; 16], 4, 4, 1.0, 4.0, 4.0), (0.0, 0.0));
        assert_eq!(ink_offset(&[255; 3], 4, 4, 1.0, 4.0, 4.0), (0.0, 0.0));
    }

    #[test]
    fn look_renames_symbols_by_name() {
        assert_eq!(drawn_symbol_name("plus"), "plus");
        set_symbol_names(HashMap::from([(
            "plus".to_owned(),
            "plus.circle".to_owned(),
        )]));
        assert_eq!(drawn_symbol_name("plus"), "plus.circle");
        assert_eq!(drawn_symbol_name("minus"), "minus");
        set_symbol_names(HashMap::new());
        assert_eq!(drawn_symbol_name("plus"), "plus");
    }
}
