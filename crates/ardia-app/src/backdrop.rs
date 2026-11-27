use std::collections::{HashMap, HashSet};
use std::hash::{DefaultHasher, Hash, Hasher};
use std::io::Cursor;
use std::sync::Arc;

use ardia_ui::host::PinnedBackdrop;
use ardia_ui::primitives::favicon::Favicon;
use ardia_ui::primitives::site_icons::SiteIcon;
use gpui::{Image, ImageFormat};
use image::{Rgba, RgbaImage};

use crate::coordinator::AppCoordinator;

pub const BLUR_SIGMA: f32 = 5.0;
pub const BLUR_REACH: u32 = 15;
pub const SPREAD: f32 = 2.5;
pub const TINT_OPACITY: f32 = 0.22;
pub const DARK_BACKING_WHITE: f32 = 0.2;
pub const DARK_RING_OPACITY: f32 = 0.75;
pub const DARK_SATURATION: f32 = 2.0;
pub const DARK_BRIGHTNESS: f32 = -0.1;
pub const MAX_BACKDROPS: usize = 64;
pub const MAX_BACKDROP_PIXELS: f32 = 1024.0;
pub const MAX_SOURCE_SIDE: u32 = 256;

#[derive(Clone, Debug)]
pub enum BackdropSource {
    Encoded(Arc<Image>),
    Site(SiteIcon, bool),
}

impl BackdropSource {
    pub fn of(icon: &Favicon, dark: bool) -> Option<Self> {
        match icon {
            Favicon::Image(image) | Favicon::Template { image, .. } => {
                Some(BackdropSource::Encoded(Arc::clone(image)))
            }
            Favicon::Site(site) => Some(BackdropSource::Site(*site, dark)),
            _ => None,
        }
    }

    fn identity(&self) -> u64 {
        let mut hasher = DefaultHasher::new();
        match self {
            BackdropSource::Encoded(image) => (0u8, image.id).hash(&mut hasher),
            BackdropSource::Site(site, dark) => (1u8, site, dark).hash(&mut hasher),
        }
        hasher.finish()
    }

    pub fn raster(&self) -> Option<RgbaImage> {
        let _span = ardia_profile::span(ardia_profile::Span::ImageDecode);
        let decoded = match self {
            BackdropSource::Encoded(image) => match image.format {
                ImageFormat::Svg => crate::favicons::svg_raster(&image.bytes, 64)?,
                _ => image::load_from_memory(&image.bytes).ok()?.to_rgba8(),
            },
            BackdropSource::Site(site, dark) => {
                image::load_from_memory(site.bytes(*dark)).ok()?.to_rgba8()
            }
        };
        let (width, height) = decoded.dimensions();
        if width == 0 || height == 0 {
            return None;
        }
        if width.max(height) <= MAX_SOURCE_SIDE {
            return Some(decoded);
        }
        let scale = MAX_SOURCE_SIDE as f32 / width.max(height) as f32;
        let fit = |extent: u32| ((extent as f32 * scale).round() as u32).max(1);
        Some(image::imageops::resize(
            &decoded,
            fit(width),
            fit(height),
            image::imageops::FilterType::Triangle,
        ))
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct BackdropKey {
    source: u64,
    look: [u32; 5],
    dark: bool,
    glass: bool,
}

impl BackdropKey {
    pub fn new(source: &BackdropSource, look: &PinnedBackdrop) -> Self {
        BackdropKey {
            source: source.identity(),
            look: [
                look.width.to_bits(),
                look.height.to_bits(),
                look.radius.to_bits(),
                look.stroke.to_bits(),
                look.scale.to_bits(),
            ],
            dark: look.dark,
            glass: look.glass,
        }
    }
}

#[derive(Default)]
pub struct BackdropCache {
    ready: HashMap<BackdropKey, Arc<Image>>,
    pending: HashSet<BackdropKey>,
}

impl BackdropCache {
    pub fn get(&self, key: &BackdropKey) -> Option<Arc<Image>> {
        self.ready.get(key).cloned()
    }

    pub fn begin(&mut self, key: BackdropKey) -> bool {
        !self.ready.contains_key(&key) && self.pending.insert(key)
    }

    pub fn finish(&mut self, key: BackdropKey, image: Option<Arc<Image>>) {
        self.pending.remove(&key);
        if let Some(image) = image {
            if self.ready.len() >= MAX_BACKDROPS {
                self.ready.clear();
            }
            self.ready.insert(key, image);
        }
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq)]
struct Pixel {
    r: f32,
    g: f32,
    b: f32,
    a: f32,
}

impl Pixel {
    fn scaled(self, by: f32) -> Pixel {
        Pixel {
            r: self.r * by,
            g: self.g * by,
            b: self.b * by,
            a: self.a * by,
        }
    }

    fn over(self, under: Pixel) -> Pixel {
        let keep = 1.0 - self.a;
        Pixel {
            r: self.r + under.r * keep,
            g: self.g + under.g * keep,
            b: self.b + under.b * keep,
            a: self.a + under.a * keep,
        }
    }

    fn mix(self, other: Pixel, t: f32) -> Pixel {
        self.scaled(1.0 - t).plus(other.scaled(t))
    }

    fn plus(self, other: Pixel) -> Pixel {
        Pixel {
            r: self.r + other.r,
            g: self.g + other.g,
            b: self.b + other.b,
            a: self.a + other.a,
        }
    }

    fn gray(level: f32, alpha: f32) -> Pixel {
        Pixel {
            r: level * alpha,
            g: level * alpha,
            b: level * alpha,
            a: alpha,
        }
    }
}

struct Plane {
    width: usize,
    height: usize,
    pixels: Vec<Pixel>,
}

impl Plane {
    fn from_image(image: &RgbaImage) -> Plane {
        let pixels = image
            .pixels()
            .map(|p| {
                let a = f32::from(p[3]) / 255.0;
                Pixel {
                    r: f32::from(p[0]) / 255.0 * a,
                    g: f32::from(p[1]) / 255.0 * a,
                    b: f32::from(p[2]) / 255.0 * a,
                    a,
                }
            })
            .collect();
        Plane {
            width: image.width() as usize,
            height: image.height() as usize,
            pixels,
        }
    }

    fn at(&self, x: i64, y: i64) -> Pixel {
        if x < 0 || y < 0 || x >= self.width as i64 || y >= self.height as i64 {
            return Pixel::default();
        }
        self.pixels[y as usize * self.width + x as usize]
    }

    fn sample(&self, x: f32, y: f32) -> Pixel {
        let x = x - 0.5;
        let y = y - 0.5;
        let x0 = x.floor();
        let y0 = y.floor();
        let (tx, ty) = (x - x0, y - y0);
        let (x0, y0) = (x0 as i64, y0 as i64);
        let top = self.at(x0, y0).mix(self.at(x0 + 1, y0), tx);
        let bottom = self.at(x0, y0 + 1).mix(self.at(x0 + 1, y0 + 1), tx);
        top.mix(bottom, ty)
    }
}

pub fn gaussian_weights() -> Vec<f32> {
    let reach = BLUR_REACH as i32;
    let raw: Vec<f32> = (-reach..=reach)
        .map(|d| (-(d * d) as f32 / (2.0 * BLUR_SIGMA * BLUR_SIGMA)).exp())
        .collect();
    let total: f32 = raw.iter().sum();
    raw.into_iter().map(|w| w / total).collect()
}

fn blur(source: &Plane) -> Plane {
    let reach = BLUR_REACH as i64;
    let weights = gaussian_weights();
    let width = source.width + 2 * BLUR_REACH as usize;
    let height = source.height + 2 * BLUR_REACH as usize;
    let mut rows = Vec::with_capacity(width * source.height);
    for y in 0..source.height as i64 {
        for x in 0..width as i64 {
            let mut sum = Pixel::default();
            for (i, weight) in weights.iter().enumerate() {
                let sx = x - reach + i as i64 - reach;
                sum = sum.plus(source.at(sx, y).scaled(*weight));
            }
            rows.push(sum);
        }
    }
    let rows = Plane {
        width,
        height: source.height,
        pixels: rows,
    };
    let mut out = Vec::with_capacity(width * height);
    for y in 0..height as i64 {
        for x in 0..width as i64 {
            let mut sum = Pixel::default();
            for (i, weight) in weights.iter().enumerate() {
                let sy = y - reach + i as i64 - reach;
                sum = sum.plus(rows.at(x, sy).scaled(*weight));
            }
            out.push(sum);
        }
    }
    Plane {
        width,
        height,
        pixels: out,
    }
}

pub fn color_controls(pixel: [f32; 4], saturation: f32, brightness: f32) -> [f32; 4] {
    let [r, g, b, a] = pixel;
    if a <= 0.0 {
        return [0.0, 0.0, 0.0, 0.0];
    }
    let (r, g, b) = (r / a, g / a, b / a);
    let luma = 0.2125 * r + 0.7154 * g + 0.0721 * b;
    let shift = |c: f32| (luma + saturation * (c - luma) + brightness).clamp(0.0, 1.0) * a;
    [shift(r), shift(g), shift(b), a]
}

fn dark_ring(plain: &Plane) -> Plane {
    let pixels = plain
        .pixels
        .iter()
        .map(|p| {
            let [r, g, b, a] =
                color_controls([p.r, p.g, p.b, p.a], DARK_SATURATION, DARK_BRIGHTNESS);
            Pixel { r, g, b, a }
        })
        .collect();
    Plane {
        width: plain.width,
        height: plain.height,
        pixels,
    }
}

fn rounded_coverage(x: f32, y: f32, width: f32, height: f32, radius: f32) -> f32 {
    if width <= 0.0 || height <= 0.0 {
        return 0.0;
    }
    let radius = radius.clamp(0.0, width.min(height) / 2.0);
    let qx = (x - width / 2.0).abs() - (width / 2.0 - radius);
    let qy = (y - height / 2.0).abs() - (height / 2.0 - radius);
    let outside = qx.max(0.0).hypot(qy.max(0.0));
    let distance = outside + qx.max(qy).min(0.0) - radius;
    (0.5 - distance).clamp(0.0, 1.0)
}

pub fn render_backdrop(source: &RgbaImage, look: &PinnedBackdrop) -> Option<RgbaImage> {
    let scale = look.scale.max(1.0);
    let width = (look.width * scale).round();
    let height = (look.height * scale).round();
    if !(width >= 1.0
        && height >= 1.0
        && width <= MAX_BACKDROP_PIXELS
        && height <= MAX_BACKDROP_PIXELS)
    {
        return None;
    }
    let plain = blur(&Plane::from_image(source));
    let classic_dark = look.dark && !look.glass;
    let ring_image = if classic_dark {
        dark_ring(&plain)
    } else {
        blur_copy(&plain)
    };
    let big_w = width * SPREAD;
    let big_h = height * SPREAD;
    let fit = (big_w / plain.width as f32).max(big_h / plain.height as f32);
    let left = (big_w - plain.width as f32 * fit) / 2.0;
    let top = (big_h - plain.height as f32 * fit) / 2.0;
    let inset_x = width * (SPREAD - 1.0) / 2.0;
    let inset_y = height * (SPREAD - 1.0) / 2.0;
    let radius = (look.radius * scale).min(width.min(height) / 2.0);
    let stroke = (look.stroke * scale).round().max(0.0);
    let backing = match (look.glass, look.dark) {
        (true, _) => Pixel::default(),
        (false, true) => Pixel::gray(1.0, DARK_BACKING_WHITE),
        (false, false) => Pixel::gray(1.0, 1.0),
    };
    let ring_backing = match (look.glass, look.dark) {
        (true, _) => Pixel::default(),
        (false, true) => Pixel::gray(0.0, 1.0),
        (false, false) => Pixel::gray(1.0, 1.0),
    };
    let ring_opacity = if classic_dark { DARK_RING_OPACITY } else { 1.0 };
    let tint_opacity = if look.glass { 0.0 } else { TINT_OPACITY };
    let mut out = RgbaImage::new(width as u32, height as u32);
    for (x, y, pixel) in out.enumerate_pixels_mut() {
        let cx = x as f32 + 0.5;
        let cy = y as f32 + 0.5;
        let u = (cx + inset_x - left) / fit;
        let v = (cy + inset_y - top) / fit;
        let fill = plain.sample(u, v).scaled(tint_opacity).over(backing);
        let ring = ring_image
            .sample(u, v)
            .scaled(ring_opacity)
            .over(ring_backing);
        let outer = rounded_coverage(cx, cy, width, height, radius);
        let inner = rounded_coverage(
            cx - stroke,
            cy - stroke,
            width - 2.0 * stroke,
            height - 2.0 * stroke,
            (radius - stroke).max(0.0),
        );
        let band = (outer - inner).clamp(0.0, 1.0);
        let shown = ring
            .scaled(band)
            .plus(fill.scaled(1.0 - band))
            .scaled(outer);
        *pixel = to_rgba(shown);
    }
    Some(out)
}

fn blur_copy(plain: &Plane) -> Plane {
    Plane {
        width: plain.width,
        height: plain.height,
        pixels: plain.pixels.clone(),
    }
}

fn to_rgba(pixel: Pixel) -> Rgba<u8> {
    let a = pixel.a.clamp(0.0, 1.0);
    let byte = |v: f32| (v.clamp(0.0, 1.0) * 255.0).round() as u8;
    if a <= 0.0 {
        return Rgba([0, 0, 0, 0]);
    }
    Rgba([
        byte(pixel.r / a),
        byte(pixel.g / a),
        byte(pixel.b / a),
        byte(a),
    ])
}

pub fn backdrop_image(source: &BackdropSource, look: &PinnedBackdrop) -> Option<Arc<Image>> {
    let raster = render_backdrop(&source.raster()?, look)?;
    let mut png = Cursor::new(Vec::new());
    raster.write_to(&mut png, image::ImageFormat::Png).ok()?;
    Some(Arc::new(Image::from_bytes(
        ImageFormat::Png,
        png.into_inner(),
    )))
}

impl AppCoordinator {
    pub fn pinned_backdrop(&self, icon: &Favicon, look: PinnedBackdrop) -> Option<Arc<Image>> {
        let source = BackdropSource::of(icon, look.dark)?;
        let key = BackdropKey::new(&source, &look);
        {
            let mut bridge = self.bridge.lock();
            if let Some(found) = bridge.backdrops.get(&key) {
                return Some(found);
            }
            if !bridge.backdrops.begin(key) {
                return None;
            }
        }
        let me = self.weak();
        let spawned = std::thread::Builder::new()
            .name("ardia-pinned-backdrop".into())
            .spawn(move || {
                let image = backdrop_image(&source, &look);
                if let Some(coordinator) = me.upgrade() {
                    coordinator.post(move |coordinator| coordinator.backdrop_ready(key, image));
                }
            });
        if let Err(problem) = spawned {
            log::debug!("the pinned backdrop wasn't drawn: {problem}");
            self.bridge.lock().backdrops.finish(key, None);
        }
        None
    }

    fn backdrop_ready(&self, key: BackdropKey, image: Option<Arc<Image>>) {
        self.bridge.lock().backdrops.finish(key, image);
        for window in self.store.snapshot().window_order.iter() {
            self.touch(window.clone());
        }
        self.wake();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn flat(side: u32, rgba: [u8; 4]) -> RgbaImage {
        RgbaImage::from_pixel(side, side, Rgba(rgba))
    }

    fn look(dark: bool) -> PinnedBackdrop {
        PinnedBackdrop {
            width: 66.0,
            height: 40.0,
            radius: 10.0,
            stroke: 3.0,
            dark,
            glass: false,
            scale: 2.0,
        }
    }

    #[test]
    fn the_raster_covers_the_tile_at_its_pixel_scale() {
        let out = render_backdrop(&flat(32, [220, 30, 30, 255]), &look(true)).unwrap();
        assert_eq!(out.dimensions(), (132, 80));
        assert_eq!(out.get_pixel(0, 0)[3], 0, "the corner is rounded away");
        assert!(
            render_backdrop(
                &flat(8, [1, 1, 1, 255]),
                &PinnedBackdrop {
                    width: 0.0,
                    ..look(true)
                }
            )
            .is_none()
        );
    }

    #[test]
    fn the_blur_is_a_gaussian_with_sigma_five_and_clear_edges() {
        let weights = gaussian_weights();
        assert_eq!(weights.len(), 2 * BLUR_REACH as usize + 1);
        let centre = weights[BLUR_REACH as usize];
        let five_away = weights[BLUR_REACH as usize + 5];
        assert!((five_away / centre - (-0.5f32).exp()).abs() < 1e-4);
        let mut dot = RgbaImage::new(1, 1);
        dot.put_pixel(0, 0, Rgba([255, 255, 255, 255]));
        let blurred = blur(&Plane::from_image(&dot));
        assert_eq!(blurred.width, 31);
        let peak = blurred.at(15, 15).a;
        assert!((blurred.at(20, 15).a / peak - (-0.5f32).exp()).abs() < 1e-3);
        let total: f32 = blurred.pixels.iter().map(|p| p.a).sum();
        assert!((total - 1.0).abs() < 1e-3);
        let square = blur(&Plane::from_image(&flat(32, [0, 0, 0, 255])));
        assert!(square.at(0, 0).a < 0.01, "outside the icon is clear");
        assert!(square.at(31, 31).a > 0.99);
    }

    #[test]
    fn flat_icons_composite_to_the_old_apps_colours() {
        let red = flat(200, [255, 0, 0, 255]);
        let dark = render_backdrop(&red, &look(true)).unwrap();
        let fill = dark.get_pixel(66, 40).0;
        let tint = TINT_OPACITY;
        let alpha = tint + DARK_BACKING_WHITE * (1.0 - tint);
        let red_premul = tint + DARK_BACKING_WHITE * (1.0 - tint);
        let green_premul = DARK_BACKING_WHITE * (1.0 - tint);
        assert!((f32::from(fill[3]) / 255.0 - alpha).abs() < 0.01);
        assert!((f32::from(fill[0]) / 255.0 - red_premul / alpha).abs() < 0.01);
        assert!((f32::from(fill[1]) / 255.0 - green_premul / alpha).abs() < 0.01);
        let ring = dark.get_pixel(66, 2).0;
        let [r, g, _, _] = color_controls([1.0, 0.0, 0.0, 1.0], DARK_SATURATION, DARK_BRIGHTNESS);
        assert_eq!(ring[3], 255);
        assert!((f32::from(ring[0]) / 255.0 - r * DARK_RING_OPACITY).abs() < 0.02);
        assert!((f32::from(ring[1]) / 255.0 - g * DARK_RING_OPACITY).abs() < 0.02);

        let light = render_backdrop(&red, &look(false)).unwrap();
        let fill = light.get_pixel(66, 40).0;
        assert_eq!(fill[3], 255);
        assert_eq!(fill[0], 255);
        let expected = ((1.0 - TINT_OPACITY) * 255.0).round() as u8;
        assert!(fill[1].abs_diff(expected) <= 1);
        let ring = light.get_pixel(66, 2).0;
        assert_eq!(
            ring,
            [255, 0, 0, 255],
            "the light ring is the plain blur at full strength"
        );
    }

    #[test]
    fn color_controls_follow_core_image() {
        let grey = color_controls([0.5, 0.5, 0.5, 1.0], 2.0, -0.1);
        assert!((grey[0] - 0.4).abs() < 1e-5 && (grey[2] - 0.4).abs() < 1e-5);
        assert_eq!(color_controls([0.0, 0.0, 0.0, 0.0], 2.0, -0.1), [0.0; 4]);
    }

    #[test]
    fn backdrops_are_cached_per_icon_and_look() {
        let mut cache = BackdropCache::default();
        let source = BackdropSource::Site(SiteIcon::Github, true);
        let key = BackdropKey::new(&source, &look(true));
        assert!(cache.begin(key));
        assert!(!cache.begin(key), "one render per key at a time");
        let image = backdrop_image(&source, &look(true)).unwrap();
        cache.finish(key, Some(Arc::clone(&image)));
        assert!(Arc::ptr_eq(&cache.get(&key).unwrap(), &image));
        assert!(!cache.begin(key));
        let light = BackdropKey::new(&BackdropSource::Site(SiteIcon::Github, false), &look(false));
        assert_ne!(key, light);
        let wider = BackdropKey::new(
            &source,
            &PinnedBackdrop {
                width: 70.0,
                ..look(true)
            },
        );
        assert_ne!(key, wider);
        assert!(cache.get(&wider).is_none());
    }

    #[test]
    fn the_host_hook_draws_off_the_main_thread_and_reuses_the_raster() {
        let store = Arc::new(ardia_state::BrowserStore::in_memory(
            ardia_state::BrowserState::from_session(
                ardia_state::persistence::session::SessionData::fresh(
                    ardia_state::persistence::session::LoadOptions::default(),
                ),
                1_795_000_000_000,
            ),
            ardia_state::ids::IdGen::with_launch("backdrop"),
        ));
        let engine: Arc<dyn ardia_engine::BrowserEngine> =
            Arc::new(ardia_engine::MockBrowserEngine::started());
        let app = AppCoordinator::new(store, engine, crate::CoordinatorConfig::default());
        app.set_waker(|| {});
        app.start();
        let icon = Favicon::Site(SiteIcon::Github);
        assert!(app.pinned_backdrop(&icon, look(true)).is_none());
        assert!(
            app.pinned_backdrop(&Favicon::Letter('X'), look(true))
                .is_none()
        );
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(20);
        let first = loop {
            app.pump();
            if let Some(found) = app.pinned_backdrop(&icon, look(true)) {
                break found;
            }
            assert!(
                std::time::Instant::now() < deadline,
                "the backdrop never arrived"
            );
            std::thread::sleep(std::time::Duration::from_millis(10));
        };
        let again = app.pinned_backdrop(&icon, look(true)).unwrap();
        assert!(Arc::ptr_eq(&first, &again));
        let decoded = image::load_from_memory(&first.bytes).unwrap();
        assert_eq!((decoded.width(), decoded.height()), (132, 80));
    }

    #[test]
    fn the_glass_ring_is_the_plain_blur_and_nothing_else() {
        let red = flat(200, [255, 0, 0, 255]);
        let glass = PinnedBackdrop {
            glass: true,
            stroke: 2.0,
            ..look(true)
        };
        let out = render_backdrop(&red, &glass).unwrap();
        assert_eq!(
            out.get_pixel(66, 40)[3],
            0,
            "the glass fill draws the inside"
        );
        assert_eq!(out.get_pixel(66, 1).0, [255, 0, 0, 255]);
        assert_eq!(out.get_pixel(66, 6)[3], 0, "the ring is two points wide");
        assert_ne!(
            BackdropKey::new(&BackdropSource::Site(SiteIcon::Google, true), &glass),
            BackdropKey::new(&BackdropSource::Site(SiteIcon::Google, true), &look(true))
        );
    }
}
