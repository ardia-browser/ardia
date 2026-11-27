use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Duration, Instant};

use ardia_ui::media::share::{DisplaySource, SourceKind};
use parking_lot::Mutex;

pub const SOURCES_REFRESH: Duration = Duration::from_millis(2500);
pub const PREVIEW_REFRESH: Duration = Duration::from_millis(5000);
pub const SCREEN_RECORDING_SETTINGS: &str =
    "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture";

pub type Notify = Arc<dyn Fn() + Send + Sync>;

#[derive(Default)]
struct Cache {
    windows: Vec<DisplaySource>,
    windows_at: Option<Instant>,
    windows_loading: bool,
    thumbs: HashMap<String, (Arc<gpui::Image>, Instant)>,
    thumbs_loading: bool,
}

static CACHE: Mutex<Option<Cache>> = Mutex::new(None);

fn with_cache<R>(f: impl FnOnce(&mut Cache) -> R) -> R {
    let mut guard = CACHE.lock();
    f(guard.get_or_insert_with(Cache::default))
}

pub fn background() -> bool {
    std::env::var("ARDIA_BACKGROUND").is_ok_and(|v| v == "1")
}

pub fn may_capture(source: &str) -> bool {
    if !background() || !(source.starts_with("screen:") || source.starts_with("window:")) {
        return true;
    }
    log::info!(
        "background mode: {} capture refused, it would ask macOS for Screen Recording",
        source.split(':').next().unwrap_or_default()
    );
    false
}

pub fn source_number(source: &str) -> Option<(SourceKind, u32)> {
    let mut parts = source.split(':');
    let kind = match parts.next()? {
        "screen" => SourceKind::Screen,
        "window" => SourceKind::Window,
        _ => return None,
    };
    let number = parts.next()?.parse().ok()?;
    Some((kind, number))
}

pub fn screen_title(name: &str, index: usize) -> String {
    let name = name.trim();
    let generic = name
        .strip_prefix("Screen ")
        .is_some_and(|rest| !rest.is_empty() && rest.bytes().all(|b| b.is_ascii_digit()));
    if name.is_empty() || generic {
        format!("Display {}", index + 1)
    } else {
        name.to_owned()
    }
}

fn rgba_png(width: usize, height: usize, bytes_per_row: usize, bgra: &[u8]) -> Option<Vec<u8>> {
    let mut rgba = Vec::with_capacity(width * height * 4);
    for row in 0..height {
        let start = row * bytes_per_row;
        let line = bgra.get(start..start + width * 4)?;
        for px in line.as_chunks::<4>().0 {
            rgba.extend_from_slice(&[px[2], px[1], px[0], 255]);
        }
    }
    let mut out = Vec::new();
    image::codecs::png::PngEncoder::new(&mut out)
        .write_image(
            &rgba,
            width as u32,
            height as u32,
            image::ExtendedColorType::Rgba8,
        )
        .ok()?;
    Some(out)
}

use image::ImageEncoder;

#[cfg(target_os = "macos")]
mod mac {
    use super::*;
    use block2::RcBlock;
    use objc2::AnyThread;
    use objc2::rc::Retained;
    use objc2_app_kit::NSScreen;
    use objc2_core_graphics::{CGDataProvider, CGImage};
    use objc2_foundation::{MainThreadMarker, NSArray, NSError, NSNumber, NSString};
    use objc2_screen_capture_kit::{
        SCContentFilter, SCScreenshotManager, SCShareableContent, SCStreamConfiguration, SCWindow,
    };

    unsafe extern "C" {
        fn CGPreflightScreenCaptureAccess() -> bool;
        fn CGRequestScreenCaptureAccess() -> bool;
    }

    pub fn allowed() -> bool {
        !background() && unsafe { CGPreflightScreenCaptureAccess() }
    }

    pub fn request() -> bool {
        if allowed() {
            return true;
        }
        if background() {
            log::info!("background mode: Screen Recording request not shown");
            return false;
        }
        if unsafe { CGRequestScreenCaptureAccess() } {
            return true;
        }
        let _ = std::process::Command::new("/usr/bin/open")
            .arg(SCREEN_RECORDING_SETTINGS)
            .spawn();
        false
    }

    pub fn screens() -> Vec<DisplaySource> {
        let Some(mtm) = MainThreadMarker::new() else {
            return Vec::new();
        };
        let key = NSString::from_str("NSScreenNumber");
        NSScreen::screens(mtm)
            .iter()
            .enumerate()
            .filter_map(|(index, screen)| {
                let number = screen
                    .deviceDescription()
                    .objectForKey(&key)
                    .and_then(|value| value.downcast::<NSNumber>().ok())?
                    .unsignedIntValue();
                let frame = screen.frame();
                Some(DisplaySource {
                    id: format!("screen:{number}:0"),
                    kind: SourceKind::Screen,
                    name: screen_title(&screen.localizedName().to_string(), index),
                    app: String::new(),
                    pid: None,
                    width: frame.size.width,
                    height: frame.size.height,
                })
            })
            .collect()
    }

    fn window_source(window: &SCWindow) -> Option<DisplaySource> {
        unsafe {
            if window.windowLayer() != 0 || !window.isOnScreen() {
                return None;
            }
            let frame = window.frame();
            if frame.size.width < 50.0 || frame.size.height < 50.0 {
                return None;
            }
            let owner = window.owningApplication();
            let app = owner
                .as_ref()
                .map(|a| a.applicationName().to_string())
                .unwrap_or_default();
            let title = window.title().map(|t| t.to_string()).unwrap_or_default();
            Some(DisplaySource {
                id: format!("window:{}:0", window.windowID()),
                kind: SourceKind::Window,
                name: if title.is_empty() { app.clone() } else { title },
                app,
                pid: owner.map(|a| a.processID()),
                width: frame.size.width,
                height: frame.size.height,
            })
        }
    }

    pub fn with_content(done: impl Fn(Option<&SCShareableContent>) + 'static) {
        let block = RcBlock::new(
            move |content: *mut SCShareableContent, _error: *mut NSError| {
                done(unsafe { content.as_ref() });
            },
        );
        unsafe {
            SCShareableContent::getShareableContentExcludingDesktopWindows_onScreenWindowsOnly_completionHandler(
                true, true, &block,
            );
        }
    }

    pub fn refresh_windows(notify: Notify) {
        with_content(move |content| {
            let windows: Vec<DisplaySource> = content
                .map(|c| {
                    unsafe { c.windows() }
                        .iter()
                        .filter_map(|w| window_source(&w))
                        .collect()
                })
                .unwrap_or_default();
            with_cache(|cache| {
                cache.windows = windows;
                cache.windows_at = Some(Instant::now());
                cache.windows_loading = false;
            });
            notify();
        });
    }

    fn filter_for(source: &str, content: &SCShareableContent) -> Option<Retained<SCContentFilter>> {
        let (kind, number) = source_number(source)?;
        unsafe {
            match kind {
                SourceKind::Window => content
                    .windows()
                    .iter()
                    .find(|w| w.windowID() == number)
                    .map(|w| {
                        SCContentFilter::initWithDesktopIndependentWindow(
                            SCContentFilter::alloc(),
                            &w,
                        )
                    }),
                SourceKind::Screen => content
                    .displays()
                    .iter()
                    .find(|d| d.displayID() == number)
                    .map(|d| {
                        SCContentFilter::initWithDisplay_excludingWindows(
                            SCContentFilter::alloc(),
                            &d,
                            &NSArray::new(),
                        )
                    }),
                SourceKind::Tab => None,
            }
        }
    }

    fn encode(image: &CGImage) -> Option<Arc<gpui::Image>> {
        let width = CGImage::width(Some(image));
        let height = CGImage::height(Some(image));
        let row = CGImage::bytes_per_row(Some(image));
        let provider = CGImage::data_provider(Some(image))?;
        let data = CGDataProvider::data(Some(&provider))?;
        let png = rgba_png(width, height, row, &data.to_vec())?;
        Some(Arc::new(gpui::Image::from_bytes(
            gpui::ImageFormat::Png,
            png,
        )))
    }

    pub fn capture(ids: Vec<String>, width: f64, notify: Notify) {
        with_content(move |content| {
            let Some(content) = content else {
                with_cache(|cache| cache.thumbs_loading = false);
                return;
            };
            let pending = Arc::new(std::sync::atomic::AtomicUsize::new(ids.len()));
            let finish = {
                let pending = Arc::clone(&pending);
                let notify = Arc::clone(&notify);
                move || {
                    if pending.fetch_sub(1, std::sync::atomic::Ordering::AcqRel) == 1 {
                        with_cache(|cache| cache.thumbs_loading = false);
                        notify();
                    }
                }
            };
            for id in &ids {
                let Some(filter) = filter_for(id, content) else {
                    finish();
                    continue;
                };
                let config = unsafe { SCStreamConfiguration::new() };
                let rect = unsafe { filter.contentRect() };
                let height = if rect.size.width > 0.0 {
                    (width * rect.size.height / rect.size.width)
                        .round()
                        .max(1.0)
                } else {
                    width
                };
                unsafe {
                    config.setWidth(width as usize);
                    config.setHeight(height as usize);
                    config.setShowsCursor(false);
                }
                let id = id.clone();
                let finish = finish.clone();
                let block = RcBlock::new(move |image: *mut CGImage, _error: *mut NSError| {
                    if let Some(found) = unsafe { image.as_ref() }.and_then(encode) {
                        with_cache(|cache| {
                            cache.thumbs.insert(id.clone(), (found, Instant::now()));
                        });
                    }
                    finish();
                });
                unsafe {
                    SCScreenshotManager::captureImageWithFilter_configuration_completionHandler(
                        &filter,
                        &config,
                        Some(&block),
                    );
                }
            }
        });
    }
}

pub fn screen_recording_allowed() -> bool {
    #[cfg(target_os = "macos")]
    {
        mac::allowed()
    }
    #[cfg(not(target_os = "macos"))]
    {
        false
    }
}

pub fn request_screen_recording() -> bool {
    #[cfg(target_os = "macos")]
    {
        mac::request()
    }
    #[cfg(not(target_os = "macos"))]
    {
        false
    }
}

pub fn sources_with(notify: Notify) -> Vec<DisplaySource> {
    #[cfg(target_os = "macos")]
    {
        let mut out = mac::screens();
        if background() {
            return out;
        }
        let stale = with_cache(|cache| {
            let stale = !cache.windows_loading
                && cache
                    .windows_at
                    .is_none_or(|at| at.elapsed() >= SOURCES_REFRESH);
            if stale {
                cache.windows_loading = true;
            }
            out.extend(cache.windows.iter().cloned());
            stale
        });
        if stale && screen_recording_allowed() {
            mac::refresh_windows(notify);
        } else if stale {
            with_cache(|cache| cache.windows_loading = false);
        }
        out
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = notify;
        Vec::new()
    }
}

pub fn thumbnails(ids: &[String], width: f64, notify: Notify) -> HashMap<String, Arc<gpui::Image>> {
    if background() || ids.is_empty() || width < 1.0 {
        return HashMap::new();
    }
    let (found, stale) = with_cache(|cache| {
        let found: HashMap<String, Arc<gpui::Image>> = ids
            .iter()
            .filter_map(|id| {
                cache
                    .thumbs
                    .get(id)
                    .map(|(image, _)| (id.clone(), Arc::clone(image)))
            })
            .collect();
        let stale = !cache.thumbs_loading
            && ids.iter().any(|id| {
                cache
                    .thumbs
                    .get(id)
                    .is_none_or(|(_, at)| at.elapsed() >= PREVIEW_REFRESH)
            });
        if stale {
            cache.thumbs_loading = true;
        }
        (found, stale)
    });
    if stale {
        #[cfg(target_os = "macos")]
        mac::capture(ids.to_vec(), width, notify);
        #[cfg(not(target_os = "macos"))]
        let _ = notify;
    }
    found
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn source_ids_parse_and_screens_get_friendly_names() {
        assert_eq!(source_number("screen:69:0"), Some((SourceKind::Screen, 69)));
        assert_eq!(
            source_number("window:1234:0"),
            Some((SourceKind::Window, 1234))
        );
        assert_eq!(source_number("web-contents-media-stream://1:2"), None);
        assert_eq!(screen_title("Screen 2", 1), "Display 2");
        assert_eq!(screen_title("", 0), "Display 1");
        assert_eq!(
            screen_title("Built-in Retina Display", 0),
            "Built-in Retina Display"
        );
    }

    #[test]
    fn bgra_frames_turn_into_png() {
        let png = rgba_png(1, 1, 4, &[1, 2, 3, 255]).unwrap();
        assert!(png.starts_with(b"\x89PNG"));
        assert!(rgba_png(2, 1, 8, &[0; 4]).is_none());
    }
}
