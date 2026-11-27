use std::collections::HashMap;
use std::sync::{Arc, OnceLock};

use gpui::{
    Background, Bounds, Hsla, Image, ImageFormat, IntoElement, ParentElement, PathBuilder, Pixels,
    RenderImage, Rgba, Styled, canvas, div, img, linear_color_stop, linear_gradient, point,
    prelude::*,
};
use image::{Frame, RgbaImage};
use parking_lot::Mutex;

use crate::scale::px;

pub const GLOW_MAX_SIDE: u32 = 64;
pub const GLOW_LIFT: f64 = 0.35;
pub const GLOW_CHROMA_GAIN: f64 = 1.5;
pub const HUE_OPACITY_DARK: f32 = 0.35;
pub const HUE_OPACITY_LIGHT: f32 = 0.3;
pub const SHEEN_TOP_DARK: f32 = 0.12;
pub const SHEEN_TOP_LIGHT: f32 = 0.4;
pub const SHEEN_END: f32 = 0.6;
pub const RIM_TOP_DARK: f32 = 0.5;
pub const RIM_BOTTOM_DARK: f32 = 0.14;
pub const RIM_TOP_LIGHT: f32 = 1.0;
pub const RIM_BOTTOM_LIGHT: f32 = 0.55;
pub const LIFT_SHADOW_DARK: f32 = 0.5;
pub const LIFT_SHADOW_LIGHT: f32 = 0.2;
const CACHE_LIMIT: usize = 128;

pub fn glow(rgb: [f64; 3]) -> ([f64; 3], f64) {
    let top = rgb[0].max(rgb[1]).max(rgb[2]);
    let low = rgb[0].min(rgb[1]).min(rgb[2]);
    if top <= 0.0 || !top.is_finite() {
        return ([0.0; 3], 0.0);
    }
    let chroma = top - low;
    let lifted = rgb.map(|channel| {
        let bright = channel / top;
        bright + (1.0 - bright) * GLOW_LIFT
    });
    (lifted, (chroma * GLOW_CHROMA_GAIN).min(1.0))
}

pub fn glow_color(color: Hsla) -> Option<Hsla> {
    let rgba = Rgba::from(color);
    let (rgb, strength) = glow([rgba.r.into(), rgba.g.into(), rgba.b.into()]);
    (strength > 0.0).then(|| {
        Hsla::from(Rgba {
            r: rgb[0] as f32,
            g: rgb[1] as f32,
            b: rgb[2] as f32,
            a: strength as f32,
        })
    })
}

pub fn glow_side(width: u32, height: u32) -> (u32, u32) {
    let scale = (f64::from(GLOW_MAX_SIDE) / f64::from(width.max(height).max(1))).min(1.0);
    (
        ((f64::from(width) * scale) as u32).max(1),
        ((f64::from(height) * scale) as u32).max(1),
    )
}

pub fn glow_pixels(source: &RgbaImage) -> RgbaImage {
    let (width, height) = glow_side(source.width(), source.height());
    let small =
        image::imageops::resize(source, width, height, image::imageops::FilterType::Triangle);
    let mut out = RgbaImage::new(width, height);
    for (x, y, pixel) in small.enumerate_pixels() {
        let [r, g, b, a] = pixel.0;
        let alpha = f64::from(a) / 255.0;
        if alpha <= 0.0 {
            continue;
        }
        let (rgb, strength) = glow([r, g, b].map(|c| f64::from(c) / 255.0));
        let shown = alpha * strength;
        let byte = |v: f64| (v.clamp(0.0, 1.0) * 255.0).round() as u8;
        out.put_pixel(
            x,
            y,
            image::Rgba([byte(rgb[2]), byte(rgb[1]), byte(rgb[0]), byte(shown)]),
        );
    }
    out
}

fn cache() -> &'static Mutex<HashMap<u64, Option<Arc<RenderImage>>>> {
    static CACHE: OnceLock<Mutex<HashMap<u64, Option<Arc<RenderImage>>>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

pub fn glow_image(blurred: &Image) -> Option<Arc<RenderImage>> {
    if let Some(found) = cache().lock().get(&blurred.id) {
        return found.clone();
    }
    let format = match blurred.format {
        ImageFormat::Png => image::ImageFormat::Png,
        ImageFormat::Jpeg => image::ImageFormat::Jpeg,
        ImageFormat::Webp => image::ImageFormat::WebP,
        _ => return None,
    };
    let made = image::load_from_memory_with_format(&blurred.bytes, format)
        .ok()
        .map(|decoded| glow_pixels(&decoded.to_rgba8()))
        .map(|pixels| Arc::new(RenderImage::new([Frame::new(pixels)])));
    let mut cache = cache().lock();
    if cache.len() >= CACHE_LIMIT {
        cache.clear();
    }
    cache.insert(blurred.id, made.clone());
    made
}

pub enum GlowHue {
    Image(Arc<RenderImage>),
    Color(Hsla),
}

fn white(alpha: f32) -> Hsla {
    gpui::white().opacity(alpha)
}

fn vertical(top: Hsla, bottom: Hsla, end: f32) -> Background {
    linear_gradient(
        180.,
        linear_color_stop(top, 0.),
        linear_color_stop(bottom, end),
    )
}

pub fn glass_glow(
    radius: f32,
    rim_width: f32,
    dark: bool,
    hue: Option<GlowHue>,
    big: Bounds<Pixels>,
) -> gpui::Div {
    let (sheen_top, rim_top, rim_bottom, hue_opacity) = if dark {
        (
            SHEEN_TOP_DARK,
            RIM_TOP_DARK,
            RIM_BOTTOM_DARK,
            HUE_OPACITY_DARK,
        )
    } else {
        (
            SHEEN_TOP_LIGHT,
            RIM_TOP_LIGHT,
            RIM_BOTTOM_LIGHT,
            HUE_OPACITY_LIGHT,
        )
    };
    let corner = px(radius);
    let stroke = px(rim_width);
    let rim = vertical(white(rim_top), white(rim_bottom), 1.);
    div()
        .absolute()
        .inset_0()
        .rounded(corner)
        .when_some(hue, |this, hue| {
            this.child(
                div()
                    .absolute()
                    .inset_0()
                    .rounded(corner)
                    .overflow_hidden()
                    .opacity(hue_opacity)
                    .map(|layer| match hue {
                        GlowHue::Color(color) => layer.bg(color),
                        GlowHue::Image(image) => layer.child(
                            img(image)
                                .absolute()
                                .left(big.origin.x)
                                .top(big.origin.y)
                                .w(big.size.width)
                                .h(big.size.height)
                                .object_fit(gpui::ObjectFit::Cover),
                        ),
                    }),
            )
        })
        .child(div().absolute().inset_0().rounded(corner).bg(vertical(
            white(sheen_top),
            white(0.),
            SHEEN_END,
        )))
        .child(gradient_rim(corner, stroke, rim))
}

pub fn gradient_rim(corner: Pixels, stroke: Pixels, fill: Background) -> impl IntoElement {
    canvas(
        |_, _, _| (),
        move |bounds, _, window, _| {
            let inset = stroke / 2.;
            let inner = Bounds::new(
                point(bounds.origin.x + inset, bounds.origin.y + inset),
                gpui::size(
                    (bounds.size.width - stroke).max(Pixels::ZERO),
                    (bounds.size.height - stroke).max(Pixels::ZERO),
                ),
            );
            let corner = (corner - inset).max(Pixels::ZERO);
            let mut path = PathBuilder::stroke(stroke);
            rounded_rect(&mut path, inner, corner);
            if let Ok(path) = path.build() {
                window.paint_path(path, fill);
            }
        },
    )
    .absolute()
    .inset_0()
}

fn rounded_rect(path: &mut PathBuilder, bounds: Bounds<Pixels>, radius: Pixels) {
    let radius = radius
        .min(bounds.size.width / 2.)
        .min(bounds.size.height / 2.);
    let (left, top) = (bounds.origin.x, bounds.origin.y);
    let (right, bottom) = (left + bounds.size.width, top + bounds.size.height);
    path.move_to(point(left + radius, top));
    path.line_to(point(right - radius, top));
    path.curve_to(point(right, top + radius), point(right, top));
    path.line_to(point(right, bottom - radius));
    path.curve_to(point(right - radius, bottom), point(right, bottom));
    path.line_to(point(left + radius, bottom));
    path.curve_to(point(left, bottom - radius), point(left, bottom));
    path.line_to(point(left, top + radius));
    path.curve_to(point(left + radius, top), point(left, top));
    path.close();
}

pub fn lift_shadow_opacity(dark: bool) -> f32 {
    if dark {
        LIFT_SHADOW_DARK
    } else {
        LIFT_SHADOW_LIGHT
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn close(a: f64, b: f64) -> bool {
        (a - b).abs() < 1e-6
    }

    #[test]
    fn glow_lifts_toward_white_and_scales_with_chroma() {
        let (rgb, strength) = glow([1.0, 0.0, 0.0]);
        assert!(close(rgb[0], 1.0) && close(rgb[1], 0.35) && close(rgb[2], 0.35));
        assert!(close(strength, 1.0));
        let (_, grey) = glow([0.5, 0.5, 0.5]);
        assert_eq!(grey, 0.0);
        let (_, soft) = glow([0.6, 0.5, 0.4]);
        assert!(close(soft, 0.3));
        assert_eq!(glow([0.0, 0.0, 0.0]), ([0.0; 3], 0.0));
    }

    #[test]
    fn grey_fills_have_no_glow_colour() {
        assert!(glow_color(gpui::white()).is_none());
        let red = glow_color(Hsla::from(Rgba {
            r: 1.0,
            g: 0.0,
            b: 0.0,
            a: 1.0,
        }))
        .unwrap_or_default();
        assert!((red.a - 1.0).abs() < 1e-5);
    }

    #[test]
    fn glow_rasters_shrink_to_sixty_four_and_keep_their_shape() {
        assert_eq!(glow_side(256, 128), (64, 32));
        assert_eq!(glow_side(40, 20), (40, 20));
        assert_eq!(glow_side(0, 0), (1, 1));
        let mut source = RgbaImage::new(128, 128);
        for pixel in source.pixels_mut() {
            *pixel = image::Rgba([255, 0, 0, 255]);
        }
        let out = glow_pixels(&source);
        assert_eq!((out.width(), out.height()), (64, 64));
        assert_eq!(out.get_pixel(10, 10).0, [89, 89, 255, 255]);
    }
}
