use std::collections::{HashMap, HashSet, VecDeque};
use std::io::{self, Cursor};
use std::path::{Path, PathBuf};
use std::sync::{Arc, mpsc};
use std::time::{Duration, Instant, SystemTime};

use ardia_theme::{IconPixels, IconTheme, classify_icon};
use base64::Engine as _;
use gpui::{Image, ImageFormat};

pub const MAX_ICON_BYTES: usize = 512 * 1024;
pub const MAX_ICON_SIDE: u32 = 1024;
const MAX_DECODE_ALLOC: u64 = 32 * 1024 * 1024;
pub const MAX_ICON_URL: usize = 2048;
pub const MAX_CACHED_ICONS: usize = 512;
pub const MAX_FAILED_ICONS: usize = 1024;
pub const RETRY_FAILED_AFTER: Duration = Duration::from_secs(300);
pub const DISK_ICON_TTL: Duration = Duration::from_secs(7 * 24 * 60 * 60);
const SVG_THEME_SIDE: u32 = 32;
pub const ICON_RASTER_SIDE: u32 = 64;
pub const MAX_PENDING_ICONS: usize = 128;
pub const MAX_ICON_FETCHES: usize = 6;
pub const MAX_DISK_JOBS: usize = MAX_PENDING_ICONS * 2;
pub const DISK_ICON_BUDGET: u64 = 20 * 1024 * 1024;
pub const PRUNE_EVERY_STORES: u32 = 64;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DecodedIcon {
    pub width: usize,
    pub height: usize,
    pub rgba: Vec<u8>,
}

impl DecodedIcon {
    pub fn pixels(&self) -> IconPixels<'_> {
        IconPixels {
            width: self.width,
            height: self.height,
            rgba: &self.rgba,
        }
    }

    pub fn theme(&self) -> IconTheme {
        classify_icon(self.pixels())
    }
}

fn looks_like_svg(bytes: &[u8]) -> bool {
    let head = &bytes[..bytes.len().min(256)];
    let text = String::from_utf8_lossy(head).to_ascii_lowercase();
    text.contains("<svg") || text.trim_start().starts_with("<?xml")
}

pub fn decode(bytes: &[u8]) -> Option<DecodedIcon> {
    if bytes.is_empty() || bytes.len() > MAX_ICON_BYTES || looks_like_svg(bytes) {
        return None;
    }
    let mut reader = image::ImageReader::new(Cursor::new(bytes))
        .with_guessed_format()
        .ok()?;
    let mut limits = image::Limits::default();
    limits.max_image_width = Some(MAX_ICON_SIDE);
    limits.max_image_height = Some(MAX_ICON_SIDE);
    limits.max_alloc = Some(MAX_DECODE_ALLOC);
    reader.limits(limits);
    let image = reader.decode().ok()?.to_rgba8();
    let (width, height) = image.dimensions();
    (width > 0 && height > 0).then(|| DecodedIcon {
        width: width as usize,
        height: height as usize,
        rgba: image.into_raw(),
    })
}

pub fn decode_rgba(width: usize, height: usize, rgba: &[u8]) -> Option<DecodedIcon> {
    let wanted = width.checked_mul(height)?.checked_mul(4)?;
    let fits = width > 0
        && height > 0
        && width <= MAX_ICON_SIDE as usize
        && height <= MAX_ICON_SIDE as usize
        && rgba.len() == wanted;
    fits.then(|| DecodedIcon {
        width,
        height,
        rgba: rgba.to_vec(),
    })
}

pub fn data_url_bytes(url: &str) -> Option<Vec<u8>> {
    let rest = url.strip_prefix("data:")?;
    let (meta, payload) = rest.split_once(',')?;
    if !meta
        .split(';')
        .any(|part| part.eq_ignore_ascii_case("base64"))
    {
        return None;
    }
    let compact: String = payload
        .chars()
        .filter(|c| !c.is_ascii_whitespace())
        .collect();
    if compact.len() > MAX_ICON_BYTES * 4 / 3 + 4 {
        return None;
    }
    base64::engine::general_purpose::STANDARD
        .decode(&compact)
        .or_else(|_| {
            base64::engine::general_purpose::STANDARD_NO_PAD.decode(compact.trim_end_matches('='))
        })
        .ok()
}

pub fn is_remote(url: &str) -> bool {
    if url.len() > MAX_ICON_URL || url.chars().any(char::is_control) {
        return false;
    }
    let scheme = url.get(..8).unwrap_or(url).to_ascii_lowercase();
    scheme.starts_with("https://") || scheme.starts_with("http://")
}

pub fn sniff(bytes: &[u8]) -> Option<ImageFormat> {
    let starts = |magic: &[u8]| bytes.starts_with(magic);
    if starts(b"\x89PNG\r\n\x1a\n") {
        Some(ImageFormat::Png)
    } else if starts(&[0xFF, 0xD8, 0xFF]) {
        Some(ImageFormat::Jpeg)
    } else if starts(b"GIF87a") || starts(b"GIF89a") {
        Some(ImageFormat::Gif)
    } else if bytes.len() >= 12 && starts(b"RIFF") && &bytes[8..12] == b"WEBP" {
        Some(ImageFormat::Webp)
    } else if starts(b"BM") {
        Some(ImageFormat::Bmp)
    } else if starts(&[0, 0, 1, 0]) {
        Some(ImageFormat::Ico)
    } else if looks_like_svg(bytes) {
        Some(ImageFormat::Svg)
    } else {
        None
    }
}

fn locked_down_svg_options() -> resvg::usvg::Options<'static> {
    resvg::usvg::Options {
        image_href_resolver: resvg::usvg::ImageHrefResolver {
            resolve_data: Box::new(|_, _, _| None),
            resolve_string: Box::new(|_, _| None),
        },
        ..resvg::usvg::Options::default()
    }
}

pub(crate) fn svg_raster(bytes: &[u8], side: u32) -> Option<image::RgbaImage> {
    if bytes.is_empty() || bytes.len() > MAX_ICON_BYTES {
        return None;
    }
    let tree = resvg::usvg::Tree::from_data(bytes, &locked_down_svg_options()).ok()?;
    let size = tree.size();
    let (width, height) = (size.width(), size.height());
    if !(width.is_finite() && height.is_finite() && width > 0.0 && height > 0.0) {
        return None;
    }
    let scale = (side as f32 / width).min(side as f32 / height);
    let fit = |extent: f32| ((extent * scale).ceil() as u32).clamp(1, side);
    let (out_width, out_height) = (fit(width), fit(height));
    let mut pixmap = resvg::tiny_skia::Pixmap::new(out_width, out_height)?;
    resvg::render(
        &tree,
        resvg::tiny_skia::Transform::from_scale(scale, scale),
        &mut pixmap.as_mut(),
    );
    let rgba: Vec<u8> = pixmap
        .pixels()
        .iter()
        .flat_map(|pixel| {
            let color = pixel.demultiply();
            [color.red(), color.green(), color.blue(), color.alpha()]
        })
        .collect();
    if rgba.iter().skip(3).step_by(4).all(|alpha| *alpha == 0) {
        return None;
    }
    image::RgbaImage::from_raw(out_width, out_height, rgba)
}

pub fn svg_theme(bytes: &[u8]) -> Option<IconTheme> {
    let raster = svg_raster(bytes, SVG_THEME_SIDE)?;
    Some(classify_icon(IconPixels {
        width: raster.width() as usize,
        height: raster.height() as usize,
        rgba: raster.as_raw(),
    }))
}

fn bounded_raster(bytes: &[u8]) -> Option<image::RgbaImage> {
    let raster = match sniff(bytes)? {
        ImageFormat::Svg => return svg_raster(bytes, ICON_RASTER_SIDE),
        _ => {
            let icon = decode(bytes)?;
            image::RgbaImage::from_raw(icon.width as u32, icon.height as u32, icon.rgba)?
        }
    };
    let (width, height) = raster.dimensions();
    if width <= ICON_RASTER_SIDE && height <= ICON_RASTER_SIDE {
        return Some(raster);
    }
    let scale = ICON_RASTER_SIDE as f32 / width.max(height) as f32;
    let fit = |extent: u32| ((extent as f32 * scale).round() as u32).clamp(1, ICON_RASTER_SIDE);
    Some(downscaled(&raster, fit(width), fit(height)))
}

pub fn downscaled(raster: &image::RgbaImage, width: u32, height: u32) -> image::RgbaImage {
    let premultiplied = image::Rgba32FImage::from_fn(raster.width(), raster.height(), |x, y| {
        let [r, g, b, a] = raster.get_pixel(x, y).0.map(|v| f32::from(v) / 255.0);
        image::Rgba([r * a, g * a, b * a, a])
    });
    let resized = image::imageops::resize(
        &premultiplied,
        width,
        height,
        image::imageops::FilterType::Lanczos3,
    );
    image::RgbaImage::from_fn(width, height, |x, y| {
        let [r, g, b, a] = resized.get_pixel(x, y).0;
        let alpha = a.clamp(0.0, 1.0);
        let channel = |value: f32| {
            let straight = if alpha > 0.0 { value / alpha } else { 0.0 };
            (straight.clamp(0.0, 1.0) * 255.0).round() as u8
        };
        image::Rgba([
            channel(r),
            channel(g),
            channel(b),
            (alpha * 255.0).round() as u8,
        ])
    })
}

#[derive(Clone, Debug)]
pub struct IconEntry {
    pub image: Arc<Image>,
    pub theme: IconTheme,
    pub template: Option<Arc<image::RgbaImage>>,
}

pub const MAX_INKED_ICONS: usize = 256;

pub fn is_white_template(theme: IconTheme) -> bool {
    matches!(theme, IconTheme::Template { mean, .. } if mean.luminance() > ardia_theme::icon_theme::NEAR_WHITE_LUMINANCE)
}

pub fn inked_raster(mask: &image::RgbaImage, color: [u8; 4]) -> image::RgbaImage {
    let [r, g, b, a] = color;
    image::RgbaImage::from_fn(mask.width(), mask.height(), |x, y| {
        let alpha = mask.get_pixel(x, y)[3];
        let shown = (u16::from(alpha) * u16::from(a) + 127) / 255;
        image::Rgba([r, g, b, shown as u8])
    })
}

pub fn ink_image(mask: &image::RgbaImage, color: [u8; 4]) -> Option<Arc<Image>> {
    let mut png = Cursor::new(Vec::new());
    inked_raster(mask, color)
        .write_to(&mut png, image::ImageFormat::Png)
        .ok()?;
    Some(Arc::new(Image::from_bytes(
        ImageFormat::Png,
        png.into_inner(),
    )))
}

pub fn prepare(bytes: &[u8]) -> Option<IconEntry> {
    if bytes.is_empty() || bytes.len() > MAX_ICON_BYTES {
        return None;
    }
    let _span = ardia_profile::span(ardia_profile::Span::FaviconDecode);
    let raster = bounded_raster(bytes)?;
    let theme = classify_icon(IconPixels {
        width: raster.width() as usize,
        height: raster.height() as usize,
        rgba: raster.as_raw(),
    });
    let mut png = Cursor::new(Vec::new());
    raster.write_to(&mut png, image::ImageFormat::Png).ok()?;
    Some(IconEntry {
        image: Arc::new(Image::from_bytes(ImageFormat::Png, png.into_inner())),
        theme,
        template: is_white_template(theme).then(|| Arc::new(raster)),
    })
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum IconRequest {
    Started,
    Waiting,
    FailedRecently,
    Busy,
}

#[derive(Default)]
pub struct IconCache {
    ready: HashMap<String, IconEntry>,
    order: VecDeque<String>,
    waiting: HashSet<String>,
    failed: HashMap<String, Instant>,
    fetching: usize,
    queued_fetches: VecDeque<(String, String)>,
    inked: HashMap<(String, [u8; 4]), Arc<Image>>,
}

impl IconCache {
    pub fn get(&self, url: &str) -> Option<&IconEntry> {
        self.ready.get(url)
    }

    pub fn inked(&mut self, url: &str, color: [u8; 4]) -> Option<Arc<Image>> {
        let key = (url.to_owned(), color);
        if let Some(found) = self.inked.get(&key) {
            return Some(Arc::clone(found));
        }
        let mask = self.ready.get(url)?.template.clone()?;
        let image = ink_image(&mask, color)?;
        if self.inked.len() >= MAX_INKED_ICONS {
            self.inked.clear();
        }
        self.inked.insert(key, Arc::clone(&image));
        Some(image)
    }

    pub fn status(&self, url: &str, now: Instant) -> Option<IconRequest> {
        if self.waiting.contains(url) {
            return Some(IconRequest::Waiting);
        }
        self.failed
            .get(url)
            .filter(|at| now.saturating_duration_since(**at) < RETRY_FAILED_AFTER)
            .map(|_| IconRequest::FailedRecently)
    }

    pub fn begin(&mut self, url: &str, now: Instant) -> IconRequest {
        if self.ready.contains_key(url) {
            return IconRequest::Waiting;
        }
        if let Some(status) = self.status(url, now) {
            return status;
        }
        if self.waiting.len() >= MAX_PENDING_ICONS {
            return IconRequest::Busy;
        }
        self.failed.remove(url);
        self.waiting.insert(url.to_owned());
        IconRequest::Started
    }

    pub fn claim_fetch(&mut self, profile: String, url: String) -> bool {
        if self.fetching < MAX_ICON_FETCHES {
            self.fetching += 1;
            return true;
        }
        if self.queued_fetches.len() < MAX_PENDING_ICONS {
            self.queued_fetches.push_back((profile, url));
        }
        false
    }

    pub fn release_fetch(&mut self) -> Option<(String, String)> {
        self.fetching = self.fetching.saturating_sub(1);
        let next = self.queued_fetches.pop_front()?;
        self.fetching += 1;
        Some(next)
    }

    pub fn abandon(&mut self, url: &str) {
        self.waiting.remove(url);
    }

    pub fn settle(&mut self, url: &str, entry: Option<IconEntry>, now: Instant) {
        self.waiting.remove(url);
        match entry {
            Some(entry) => {
                self.failed.remove(url);
                self.inked.retain(|(inked, _), _| inked != url);
                if self.ready.insert(url.to_owned(), entry).is_none() {
                    self.order.push_back(url.to_owned());
                }
                while self.order.len() > MAX_CACHED_ICONS {
                    if let Some(oldest) = self.order.pop_front() {
                        self.ready.remove(&oldest);
                        self.inked.retain(|(url, _), _| *url != oldest);
                    }
                }
            }
            None => {
                if self.failed.len() >= MAX_FAILED_ICONS {
                    self.failed
                        .retain(|_, at| now.saturating_duration_since(*at) < RETRY_FAILED_AFTER);
                    if self.failed.len() >= MAX_FAILED_ICONS {
                        self.failed.clear();
                    }
                }
                self.failed.insert(url.to_owned(), now);
            }
        }
    }

    pub fn len(&self) -> usize {
        self.ready.len()
    }

    pub fn is_empty(&self) -> bool {
        self.ready.is_empty()
    }
}

pub fn disk_name(url: &str) -> String {
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for byte in url.bytes() {
        hash ^= u64::from(byte);
        hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
    }
    format!("{hash:016x}.icon")
}

#[cfg_attr(debug_assertions, track_caller)]
pub fn read_cached(dir: &Path, url: &str, now: SystemTime) -> Option<Vec<u8>> {
    ardia_profile::strict::blocking(ardia_profile::strict::Blocking::File);
    let path = dir.join(disk_name(url));
    let meta = std::fs::metadata(&path).ok()?;
    let fresh = meta
        .modified()
        .ok()
        .map(|at| now.duration_since(at).unwrap_or(Duration::ZERO))
        .is_some_and(|age| age < DISK_ICON_TTL);
    if !fresh || meta.len() > (MAX_ICON_BYTES + MAX_ICON_URL + 1) as u64 {
        let _ = std::fs::remove_file(&path);
        return None;
    }
    let stored = std::fs::read(&path).ok()?;
    let body = stored.strip_prefix(url.as_bytes())?.strip_prefix(b"\n")?;
    (!body.is_empty()).then(|| body.to_vec())
}

pub fn prune_disk(dir: &Path, budget: u64, now: SystemTime) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    let mut icons: Vec<(SystemTime, u64, PathBuf)> = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        let is_icon = path
            .extension()
            .is_some_and(|ext| ext == "icon" || ext == "partial");
        let Ok(meta) = entry.metadata() else {
            continue;
        };
        if !is_icon || !meta.is_file() {
            continue;
        }
        let at = meta.modified().unwrap_or(SystemTime::UNIX_EPOCH);
        let expired = now.duration_since(at).unwrap_or(Duration::ZERO) >= DISK_ICON_TTL;
        if expired {
            let _ = std::fs::remove_file(&path);
        } else {
            icons.push((at, meta.len(), path));
        }
    }
    let mut used: u64 = icons.iter().map(|(_, size, _)| size).sum();
    icons.sort_by_key(|(at, _, _)| *at);
    for (_, size, path) in icons {
        if used <= budget {
            break;
        }
        if std::fs::remove_file(&path).is_ok() {
            used = used.saturating_sub(size);
        }
    }
}

pub fn write_cached(dir: &Path, url: &str, bytes: &[u8]) -> io::Result<()> {
    std::fs::create_dir_all(dir)?;
    let name = disk_name(url);
    let staging = dir.join(format!("{name}.partial"));
    let mut stored = Vec::with_capacity(url.len() + 1 + bytes.len());
    stored.extend_from_slice(url.as_bytes());
    stored.push(b'\n');
    stored.extend_from_slice(bytes);
    std::fs::write(&staging, &stored)?;
    std::fs::rename(&staging, dir.join(name))
}

#[derive(Debug)]
pub enum DiskJob {
    Load { url: String, profile: String },
    Store { url: String, bytes: Vec<u8> },
}

#[derive(Debug)]
pub enum DiskResult {
    Hit {
        url: String,
        entry: IconEntry,
    },
    Miss {
        url: String,
        profile: String,
    },
    Stored {
        url: String,
        entry: Option<IconEntry>,
    },
}

pub fn run_disk_job(dir: &Path, job: DiskJob) -> DiskResult {
    match job {
        DiskJob::Load { url, profile } => {
            match read_cached(dir, &url, SystemTime::now()).and_then(|bytes| prepare(&bytes)) {
                Some(entry) => DiskResult::Hit { url, entry },
                None => DiskResult::Miss { url, profile },
            }
        }
        DiskJob::Store { url, bytes } => {
            let entry = prepare(&bytes);
            if let Some(entry) = entry.as_ref()
                && let Err(problem) = write_cached(dir, &url, &entry.image.bytes)
            {
                log::debug!("a favicon wasn't cached on disk: {problem}");
            }
            DiskResult::Stored { url, entry }
        }
    }
}

pub struct DiskCache {
    jobs: mpsc::SyncSender<DiskJob>,
}

impl DiskCache {
    pub fn start(dir: PathBuf, deliver: impl Fn(DiskResult) + Send + 'static) -> Option<Self> {
        let (jobs, inbox) = mpsc::sync_channel::<DiskJob>(MAX_DISK_JOBS);
        let spawned = std::thread::Builder::new()
            .name("ardia-favicons".into())
            .spawn(move || {
                prune_disk(&dir, DISK_ICON_BUDGET, SystemTime::now());
                let mut stores = 0u32;
                for job in inbox {
                    let stored = matches!(job, DiskJob::Store { .. });
                    deliver(run_disk_job(&dir, job));
                    if stored {
                        stores += 1;
                        if stores.is_multiple_of(PRUNE_EVERY_STORES) {
                            prune_disk(&dir, DISK_ICON_BUDGET, SystemTime::now());
                        }
                    }
                }
            });
        match spawned {
            Ok(_) => Some(Self { jobs }),
            Err(problem) => {
                log::warn!("favicons won't be cached on disk: {problem}");
                None
            }
        }
    }

    pub fn send(&self, job: DiskJob) -> bool {
        self.jobs.try_send(job).is_ok()
    }
}

pub fn theme_for_bytes(bytes: &[u8]) -> IconTheme {
    decode(bytes).map_or(IconTheme::Default, |icon| icon.theme())
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use image::{ImageFormat, Rgba, RgbaImage};

    pub fn png(width: u32, height: u32, paint: impl Fn(u32, u32) -> [u8; 4]) -> Vec<u8> {
        let image = RgbaImage::from_fn(width, height, |x, y| Rgba(paint(x, y)));
        let mut out = Cursor::new(Vec::new());
        image.write_to(&mut out, ImageFormat::Png).unwrap();
        out.into_inner()
    }

    pub fn data_url(bytes: &[u8]) -> String {
        format!(
            "data:image/png;base64,{}",
            base64::engine::general_purpose::STANDARD.encode(bytes)
        )
    }

    #[test]
    fn a_flat_glyph_becomes_a_template_and_a_colorful_one_blurs() {
        let flat = png(16, 16, |_, _| [200, 30, 30, 255]);
        match theme_for_bytes(&flat) {
            IconTheme::Template { mean, spread } => {
                assert!(spread < 0.01);
                assert!((mean.r - 200.0 / 255.0).abs() < 0.01);
            }
            other => panic!("expected a template, got {other:?}"),
        }
        let colorful = png(32, 32, |x, _| {
            if x < 16 {
                [255, 0, 0, 255]
            } else {
                [0, 0, 255, 255]
            }
        });
        assert!(matches!(theme_for_bytes(&colorful), IconTheme::Blur { .. }));
        let clear = png(8, 8, |_, _| [0, 0, 0, 0]);
        assert_eq!(theme_for_bytes(&clear), IconTheme::Default);
    }

    #[test]
    fn other_containers_decode_too() {
        let image = RgbaImage::from_fn(16, 16, |_, _| Rgba([10, 120, 240, 255]));
        let mut ico = Cursor::new(Vec::new());
        image.write_to(&mut ico, ImageFormat::Ico).unwrap();
        assert!(matches!(
            theme_for_bytes(ico.get_ref()),
            IconTheme::Template { .. }
        ));
        let mut bmp = Cursor::new(Vec::new());
        image.write_to(&mut bmp, ImageFormat::Bmp).unwrap();
        assert_eq!(
            decode(bmp.get_ref()).map(|icon| (icon.width, icon.height)),
            Some((16, 16))
        );
        let raw = decode_rgba(2, 1, &[1, 2, 3, 255, 4, 5, 6, 255]).unwrap();
        assert_eq!(raw.width, 2);
        assert!(decode_rgba(2, 2, &[0; 4]).is_none());
        assert!(decode_rgba(0, 0, &[]).is_none());
    }

    #[test]
    fn garbage_svg_and_bombs_fall_back_to_the_default_look() {
        assert_eq!(
            theme_for_bytes(b"\x89PNG\r\n\x1a\nmock"),
            IconTheme::Default
        );
        assert_eq!(
            theme_for_bytes(b"<svg xmlns='http://www.w3.org/2000/svg'/>"),
            IconTheme::Default
        );
        assert_eq!(theme_for_bytes(&[]), IconTheme::Default);
        let huge = png(MAX_ICON_SIDE + 1, 1, |_, _| [1, 1, 1, 255]);
        assert!(decode(&huge).is_none(), "oversized icons aren't decoded");
        assert!(decode(&vec![0u8; MAX_ICON_BYTES + 1]).is_none());
    }

    #[test]
    fn data_urls_decode_without_a_fetch() {
        let flat = png(4, 4, |_, _| [0, 200, 0, 255]);
        let url = data_url(&flat);
        assert_eq!(data_url_bytes(&url).as_deref(), Some(flat.as_slice()));
        assert_eq!(data_url_bytes("data:image/png,plain"), None);
        assert_eq!(data_url_bytes("https://x/favicon.ico"), None);
        assert!(is_remote("https://x/favicon.ico") && !is_remote(&url));
        assert!(is_remote("HTTP://x/a.png"));
        assert!(!is_remote("chrome://favicon/x") && !is_remote("file:///etc/passwd"));
        assert!(!is_remote(&format!(
            "https://x/{}",
            "a".repeat(MAX_ICON_URL)
        )));
        assert!(!is_remote("https://x/\n"));
    }

    const WHITE_MARK: &str = "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'><circle cx='8' cy='8' r='7' fill='#fff'/></svg>";

    #[test]
    fn remote_bytes_become_images_with_a_theme() {
        let flat = png(16, 16, |_, _| [200, 30, 30, 255]);
        let entry = prepare(&flat).expect("a png icon");
        assert_eq!(entry.image.format, gpui::ImageFormat::Png);
        assert!(matches!(entry.theme, IconTheme::Template { .. }));
        let svg = prepare(WHITE_MARK.as_bytes()).expect("an svg icon");
        assert_eq!(svg.image.format, gpui::ImageFormat::Png);
        match svg.theme {
            IconTheme::Template { mean, .. } => assert!(mean.r > 0.9 && mean.g > 0.9),
            other => panic!("a flat svg glyph tints as a template, got {other:?}"),
        }
        assert!(prepare(b"<svg xmlns='http://www.w3.org/2000/svg'/>").is_none());
        assert!(prepare(b"<html>not an icon</html>").is_none());
        assert!(prepare(b"\x89PNG\r\n\x1a\nmock").is_none());
        assert!(prepare(&[]).is_none());
        let outside = "<svg xmlns='http://www.w3.org/2000/svg' xmlns:xlink='http://www.w3.org/1999/xlink' viewBox='0 0 16 16'><image width='16' height='16' xlink:href='/etc/hosts'/></svg>";
        assert!(
            prepare(outside.as_bytes()).is_none(),
            "svg icons never read files"
        );
    }

    #[test]
    fn the_icon_cache_dedupes_and_backs_off() {
        let now = Instant::now();
        let mut cache = IconCache::default();
        assert_eq!(cache.begin("https://a/i.png", now), IconRequest::Started);
        assert_eq!(cache.begin("https://a/i.png", now), IconRequest::Waiting);
        cache.settle("https://a/i.png", None, now);
        assert_eq!(
            cache.begin("https://a/i.png", now + Duration::from_secs(1)),
            IconRequest::FailedRecently
        );
        assert_eq!(
            cache.begin("https://a/i.png", now + RETRY_FAILED_AFTER),
            IconRequest::Started
        );
        let entry = prepare(&png(4, 4, |_, _| [0, 0, 200, 255])).unwrap();
        cache.settle("https://a/i.png", Some(entry), now);
        assert!(cache.get("https://a/i.png").is_some());
        for n in 0..MAX_CACHED_ICONS {
            let entry = prepare(&png(1, 1, |_, _| [1, 2, 3, 255])).unwrap();
            cache.settle(&format!("https://b/{n}.png"), Some(entry), now);
        }
        assert_eq!(cache.len(), MAX_CACHED_ICONS);
        assert!(
            cache.get("https://a/i.png").is_none(),
            "the oldest icon goes first"
        );
    }

    #[test]
    fn icons_round_trip_through_the_disk_cache() {
        let dir = tempfile::tempdir().unwrap();
        let url = "https://icons.example/favicon.png";
        let bytes = png(8, 8, |_, _| [10, 200, 10, 255]);
        let now = SystemTime::now();
        assert!(read_cached(dir.path(), url, now).is_none());
        write_cached(dir.path(), url, &bytes).unwrap();
        assert_eq!(
            read_cached(dir.path(), url, now).as_deref(),
            Some(bytes.as_slice())
        );
        assert!(read_cached(dir.path(), "https://icons.example/other.png", now).is_none());
        assert!(
            read_cached(
                dir.path(),
                url,
                now + DISK_ICON_TTL + Duration::from_secs(60)
            )
            .is_none()
        );
        std::fs::write(dir.path().join(disk_name(url)), b"https://elsewhere/\nxx").unwrap();
        assert!(
            read_cached(dir.path(), url, now).is_none(),
            "a hash collision isn't served"
        );
    }

    #[test]
    fn the_disk_worker_answers_off_the_main_thread() {
        let dir = tempfile::tempdir().unwrap();
        let (sender, results) = mpsc::channel();
        let cache = DiskCache::start(dir.path().to_path_buf(), move |result| {
            let _ = sender.send(result);
        })
        .expect("a worker");
        let url = "https://icons.example/a.png".to_owned();
        let wait = || {
            results
                .recv_timeout(Duration::from_secs(5))
                .expect("an answer")
        };
        assert!(cache.send(DiskJob::Load {
            url: url.clone(),
            profile: "p".into()
        }));
        assert!(matches!(wait(), DiskResult::Miss { profile, .. } if profile == "p"));
        assert!(cache.send(DiskJob::Store {
            url: url.clone(),
            bytes: png(4, 4, |_, _| [9, 9, 9, 255]),
        }));
        assert!(matches!(wait(), DiskResult::Stored { entry: Some(_), .. }));
        assert!(cache.send(DiskJob::Load {
            url,
            profile: "p".into()
        }));
        assert!(matches!(wait(), DiskResult::Hit { .. }));
        assert!(cache.send(DiskJob::Store {
            url: "https://icons.example/bad".into(),
            bytes: b"nope".to_vec(),
        }));
        assert!(matches!(wait(), DiskResult::Stored { entry: None, .. }));
        assert!(
            read_cached(dir.path(), "https://icons.example/bad", SystemTime::now()).is_none(),
            "bytes that don't decode never reach the disk"
        );
    }

    fn decoded_side(entry: &IconEntry) -> (u32, u32) {
        let image = image::load_from_memory(&entry.image.bytes).expect("a png");
        (image.width(), image.height())
    }

    #[test]
    fn icons_reach_gpui_only_as_small_static_pngs() {
        let outside = "<svg xmlns='http://www.w3.org/2000/svg' xmlns:xlink='http://www.w3.org/1999/xlink' viewBox='0 0 16 16'><rect width='16' height='16' fill='#08f'/><image width='16' height='16' xlink:href='file:///etc/hosts'/></svg>";
        let svg = prepare(outside.as_bytes()).expect("the drawable part survives");
        assert_eq!(svg.image.format, gpui::ImageFormat::Png);
        assert!(!String::from_utf8_lossy(&svg.image.bytes).contains("file:"));
        let (width, height) = decoded_side(&svg);
        assert!(width <= ICON_RASTER_SIDE && height <= ICON_RASTER_SIDE);
        let big = prepare(&png(300, 150, |_, _| [9, 9, 200, 255])).unwrap();
        assert_eq!(big.image.format, gpui::ImageFormat::Png);
        assert_eq!(decoded_side(&big), (ICON_RASTER_SIDE, ICON_RASTER_SIDE / 2));
        let mut gif = Vec::new();
        {
            let mut encoder = image::codecs::gif::GifEncoder::new(&mut gif);
            for shade in [10u8, 250] {
                let frame =
                    image::Frame::new(RgbaImage::from_fn(8, 8, |_, _| Rgba([shade, 0, 0, 255])));
                encoder.encode_frame(frame).unwrap();
            }
        }
        let animated = prepare(&gif).expect("the first frame");
        assert_eq!(animated.image.format, gpui::ImageFormat::Png);
        assert_eq!(decoded_side(&animated), (8, 8));
    }

    fn age(path: &Path, by: Duration) {
        let file = std::fs::File::options().write(true).open(path).unwrap();
        file.set_modified(SystemTime::now() - by).unwrap();
    }

    #[test]
    fn expired_icons_are_deleted_not_just_skipped() {
        let dir = tempfile::tempdir().unwrap();
        let url = "https://old.example/i.png".to_owned();
        write_cached(dir.path(), &url, &png(4, 4, |_, _| [1, 2, 3, 255])).unwrap();
        let path = dir.path().join(disk_name(&url));
        age(&path, DISK_ICON_TTL + Duration::from_secs(60));
        let result = run_disk_job(
            dir.path(),
            DiskJob::Load {
                url,
                profile: "p".into(),
            },
        );
        assert!(matches!(result, DiskResult::Miss { .. }));
        assert!(!path.exists(), "an expired icon leaves the disk");
    }

    #[test]
    fn the_disk_cache_keeps_to_its_byte_budget() {
        let dir = tempfile::tempdir().unwrap();
        let body = vec![7u8; 1000];
        for n in 0..10 {
            let url = format!("https://many.example/{n}.png");
            write_cached(dir.path(), &url, &body).unwrap();
            age(
                &dir.path().join(disk_name(&url)),
                Duration::from_secs(1000 - n * 10),
            );
        }
        let stray = dir.path().join("note.txt");
        std::fs::write(&stray, b"not an icon").unwrap();
        prune_disk(dir.path(), 4_500, SystemTime::now());
        let left: Vec<String> = std::fs::read_dir(dir.path())
            .unwrap()
            .filter_map(|entry| entry.ok())
            .map(|entry| entry.file_name().to_string_lossy().into_owned())
            .filter(|name| name.ends_with(".icon"))
            .collect();
        let used: u64 = left
            .iter()
            .map(|name| std::fs::metadata(dir.path().join(name)).unwrap().len())
            .sum();
        assert!(used <= 4_500, "{used}");
        assert!(
            left.contains(&disk_name("https://many.example/9.png")),
            "the newest stay"
        );
        assert!(
            !left.contains(&disk_name("https://many.example/0.png")),
            "the oldest go"
        );
        assert!(stray.exists(), "only icon files are touched");
    }

    #[test]
    fn pending_icons_and_fetches_are_capped() {
        let now = Instant::now();
        let mut cache = IconCache::default();
        for n in 0..MAX_PENDING_ICONS {
            assert_eq!(
                cache.begin(&format!("https://p/{n}"), now),
                IconRequest::Started
            );
        }
        assert_eq!(cache.begin("https://p/over", now), IconRequest::Busy);
        assert_eq!(
            cache.status("https://p/over", now),
            None,
            "a busy url isn't marked"
        );
        let mut started = 0;
        for n in 0..MAX_ICON_FETCHES + 3 {
            if cache.claim_fetch("p".into(), format!("https://f/{n}")) {
                started += 1;
            }
        }
        assert_eq!(started, MAX_ICON_FETCHES);
        let next = cache.release_fetch();
        assert_eq!(
            next,
            Some(("p".into(), format!("https://f/{MAX_ICON_FETCHES}")))
        );
        for _ in 0..MAX_ICON_FETCHES + 5 {
            cache.release_fetch();
        }
        assert!(cache.claim_fetch("p".into(), "https://f/again".into()));
    }

    #[test]
    fn only_near_white_flat_icons_count_as_templates() {
        let white = prepare(&png(16, 16, |x, y| {
            if (4..12).contains(&x) && (4..12).contains(&y) {
                [255, 255, 255, 255]
            } else {
                [0, 0, 0, 0]
            }
        }))
        .unwrap();
        assert!(is_white_template(white.theme) && white.template.is_some());
        let near_white = prepare(&png(8, 8, |_, _| [245, 245, 245, 255])).unwrap();
        assert!(near_white.template.is_some(), "luminance above 0.88 counts");
        let off_white = prepare(&png(8, 8, |_, _| [240, 240, 240, 255])).unwrap();
        assert!(
            off_white.template.is_none(),
            "luminance 0.87 stays as drawn"
        );
        let grey = prepare(&png(8, 8, |_, _| [200, 200, 200, 255])).unwrap();
        assert!(grey.template.is_none(), "a grey glyph stays as drawn");
        let red = prepare(&png(8, 8, |_, _| [220, 20, 20, 255])).unwrap();
        assert!(red.template.is_none());
        let colorful = prepare(&png(16, 16, |x, _| {
            if x < 8 {
                [255, 255, 255, 255]
            } else {
                [0, 0, 255, 255]
            }
        }))
        .unwrap();
        assert!(colorful.template.is_none(), "colourful icons blur instead");
    }

    #[test]
    fn inking_keeps_the_shape_and_takes_the_colour() {
        let mask = RgbaImage::from_fn(2, 1, |x, _| {
            Rgba(if x == 0 {
                [255, 255, 255, 255]
            } else {
                [250, 250, 250, 128]
            })
        });
        let inked = inked_raster(&mask, [20, 30, 40, 255]);
        assert_eq!(inked.get_pixel(0, 0).0, [20, 30, 40, 255]);
        assert_eq!(inked.get_pixel(1, 0).0, [20, 30, 40, 128]);
        let faint = inked_raster(&mask, [0, 0, 0, 128]);
        assert_eq!(faint.get_pixel(0, 0).0[3], 128);
        assert_eq!(faint.get_pixel(1, 0).0[3], 64);
    }

    #[test]
    fn inked_variants_are_cached_per_colour() {
        let now = Instant::now();
        let mut cache = IconCache::default();
        let url = "https://w.example/icon.png";
        let white = prepare(&png(8, 8, |_, _| [255, 255, 255, 255])).unwrap();
        cache.settle(url, Some(white), now);
        let ink = [10, 10, 10, 255];
        let first = cache.inked(url, ink).unwrap();
        assert!(Arc::ptr_eq(&first, &cache.inked(url, ink).unwrap()));
        assert!(!Arc::ptr_eq(
            &first,
            &cache.inked(url, [200, 0, 0, 255]).unwrap()
        ));
        let decoded = image::load_from_memory(&first.bytes).unwrap().to_rgba8();
        assert_eq!(decoded.get_pixel(3, 3).0, [10, 10, 10, 255]);
        let red_url = "https://r.example/icon.png";
        cache.settle(red_url, prepare(&png(8, 8, |_, _| [220, 20, 20, 255])), now);
        assert!(cache.inked(red_url, ink).is_none());
        assert!(cache.inked("https://missing.example/", ink).is_none());
    }

    #[test]
    fn downscaling_keeps_edges_free_of_dark_fringes() {
        let big = RgbaImage::from_fn(144, 144, |x, y| {
            let inside = (24..120).contains(&x) && (40..104).contains(&y);
            if inside {
                Rgba([234, 51, 35, 255])
            } else {
                Rgba([0, 0, 0, 0])
            }
        });
        let small = downscaled(&big, 32, 32);
        assert_eq!(small.dimensions(), (32, 32));
        for pixel in small.pixels() {
            let [r, g, b, a] = pixel.0;
            if a >= 16 {
                assert!(r >= 220, "a dark fringe crept in: {:?}", pixel.0);
                assert!(g <= 70 && b <= 55, "{:?}", pixel.0);
            }
        }
        assert_eq!(small.get_pixel(0, 0).0[3], 0);
        assert_eq!(small.get_pixel(16, 16).0, [234, 51, 35, 255]);
    }
}
