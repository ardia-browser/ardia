use std::collections::HashMap;
use std::sync::{Arc, OnceLock};

use ardia_ui::icon_picker::symbols::{SymbolRequest, SymbolWeight};
use ardia_ui::primitives::symbol_glyphs::{SymbolMask, SymbolRaster};
use gpui::Image;
use parking_lot::Mutex;

#[derive(Clone, Debug, PartialEq, Eq, Hash)]
struct SymbolKey {
    name: String,
    point_tenths: u32,
    box_tenths: u32,
    weight: SymbolWeight,
    rgba: u32,
}

const CACHE_LIMIT: usize = 512;

fn cache() -> &'static Mutex<HashMap<SymbolKey, Option<Arc<Image>>>> {
    static CACHE: OnceLock<Mutex<HashMap<SymbolKey, Option<Arc<Image>>>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

fn tenths(value: f32) -> u32 {
    (value.clamp(0.0, 512.0) * 10.0).round() as u32
}

pub fn symbol_image(request: SymbolRequest<'_>) -> Option<Arc<Image>> {
    if request.name.is_empty() || request.box_size <= 0.0 || request.point_size <= 0.0 {
        return None;
    }
    let key = SymbolKey {
        name: request.name.to_owned(),
        point_tenths: tenths(request.point_size),
        box_tenths: tenths(request.box_size),
        weight: request.weight,
        rgba: request.rgba,
    };
    if let Some(found) = cache().lock().get(&key) {
        return found.clone();
    }
    let rendered =
        render(&request).map(|png| Arc::new(Image::from_bytes(gpui::ImageFormat::Png, png)));
    let mut cache = cache().lock();
    if cache.len() >= CACHE_LIMIT {
        cache.clear();
    }
    cache.insert(key, rendered.clone());
    rendered
}

#[cfg(target_os = "macos")]
fn render(request: &SymbolRequest<'_>) -> Option<Vec<u8>> {
    macos::render(request)
}

pub fn symbol_mask(raster: &SymbolRaster<'_>) -> Option<SymbolMask> {
    fitted_symbol_mask(raster, 1.0)
}

#[cfg(target_os = "macos")]
pub fn fitted_symbol_mask(raster: &SymbolRaster<'_>, fit: f32) -> Option<SymbolMask> {
    macos::mask(raster, fit)
}

#[cfg(not(target_os = "macos"))]
pub fn fitted_symbol_mask(raster: &SymbolRaster<'_>, fit: f32) -> Option<SymbolMask> {
    let _ = (raster, fit);
    None
}

pub fn register_icon_symbols() {
    ardia_ui::primitives::symbol_glyphs::set_symbol_renderer(fitted_symbol_mask);
}

#[cfg(not(target_os = "macos"))]
fn render(request: &SymbolRequest<'_>) -> Option<Vec<u8>> {
    let _ = request;
    None
}

#[cfg(target_os = "macos")]
mod macos {
    use std::ffi::CString;
    use std::ptr::null_mut;

    use ardia_ui::icon_picker::symbols::{SymbolRequest, SymbolWeight};
    use ardia_ui::primitives::symbol_glyphs::{SymbolMask, SymbolRaster, ink_offset};
    use objc2::encode::{Encode, Encoding};
    use objc2::rc::autoreleasepool;
    use objc2::runtime::{AnyObject, Bool};
    use objc2::{class, msg_send};

    #[repr(C)]
    #[derive(Clone, Copy, Debug, Default)]
    struct Point {
        x: f64,
        y: f64,
    }

    #[repr(C)]
    #[derive(Clone, Copy, Debug, Default)]
    struct Size {
        width: f64,
        height: f64,
    }

    #[repr(C)]
    #[derive(Clone, Copy, Debug, Default)]
    struct Rect {
        origin: Point,
        size: Size,
    }

    unsafe impl Encode for Point {
        const ENCODING: Encoding = Encoding::Struct("CGPoint", &[f64::ENCODING, f64::ENCODING]);
    }

    unsafe impl Encode for Size {
        const ENCODING: Encoding = Encoding::Struct("CGSize", &[f64::ENCODING, f64::ENCODING]);
    }

    unsafe impl Encode for Rect {
        const ENCODING: Encoding = Encoding::Struct("CGRect", &[Point::ENCODING, Size::ENCODING]);
    }

    const COMPOSITE_SOURCE_IN: usize = 3;
    const PNG_FILE_TYPE: usize = 4;
    const PIXEL_SCALE: f64 = 2.0;

    #[link(name = "AppKit", kind = "framework")]
    unsafe extern "C" {
        fn NSRectFillUsingOperation(rect: Rect, operation: usize);
    }

    fn font_weight(weight: SymbolWeight) -> f64 {
        match weight {
            SymbolWeight::Regular => 0.0,
            SymbolWeight::Medium => 0.23,
            SymbolWeight::Semibold => 0.3,
            SymbolWeight::Bold => 0.4,
        }
    }

    unsafe fn ns_string(text: &str) -> *mut AnyObject {
        let Ok(text) = CString::new(text) else {
            return null_mut();
        };
        unsafe { msg_send![class!(NSString), stringWithUTF8String: text.as_ptr()] }
    }

    pub fn render(request: &SymbolRequest<'_>) -> Option<Vec<u8>> {
        autoreleasepool(|_| unsafe { draw(request) })
    }

    pub fn mask(raster: &SymbolRaster<'_>, fit: f32) -> Option<SymbolMask> {
        autoreleasepool(|_| unsafe { draw_mask(raster, fit) })
    }

    unsafe fn configured_symbol(
        name: &str,
        point_size: f32,
        weight: SymbolWeight,
    ) -> *mut AnyObject {
        unsafe {
            let name = ns_string(name);
            if name.is_null() {
                return null_mut();
            }
            let base: *mut AnyObject = msg_send![
                class!(NSImage),
                imageWithSystemSymbolName: name,
                accessibilityDescription: null_mut::<AnyObject>()
            ];
            if base.is_null() {
                return null_mut();
            }
            let config: *mut AnyObject = msg_send![
                class!(NSImageSymbolConfiguration),
                configurationWithPointSize: f64::from(point_size),
                weight: font_weight(weight)
            ];
            if config.is_null() {
                base
            } else {
                msg_send![base, imageWithSymbolConfiguration: config]
            }
        }
    }

    unsafe fn draw_mask(raster: &SymbolRaster<'_>, fit: f32) -> Option<SymbolMask> {
        unsafe {
            let image = configured_symbol(raster.name, raster.point_size, raster.weight);
            if image.is_null() {
                return None;
            }
            let natural: Size = msg_send![image, size];
            let scale = f64::from(raster.scale);
            let fit = f64::from(fit);
            if !(natural.width > 0.0 && natural.height > 0.0 && scale > 0.0 && fit > 0.0) {
                return None;
            }
            let glyph = Size {
                width: natural.width * fit.min(1.0),
                height: natural.height * fit.min(1.0),
            };
            let wide = (glyph.width * scale).ceil().clamp(1.0, 4096.0) as isize;
            let high = (glyph.height * scale).ceil().clamp(1.0, 4096.0) as isize;
            let space = ns_string("NSDeviceRGBColorSpace");
            let allocated: *mut AnyObject = msg_send![class!(NSBitmapImageRep), alloc];
            let rep: *mut AnyObject = msg_send![
                allocated,
                initWithBitmapDataPlanes: null_mut::<*mut u8>(),
                pixelsWide: wide,
                pixelsHigh: high,
                bitsPerSample: 8isize,
                samplesPerPixel: 4isize,
                hasAlpha: Bool::YES,
                isPlanar: Bool::NO,
                colorSpaceName: space,
                bytesPerRow: 0isize,
                bitsPerPixel: 0isize
            ];
            if rep.is_null() {
                return None;
            }
            let cell = Size {
                width: wide as f64 / scale,
                height: high as f64 / scale,
            };
            let _: () = msg_send![rep, setSize: cell];
            let context: *mut AnyObject =
                msg_send![class!(NSGraphicsContext), graphicsContextWithBitmapImageRep: rep];
            if context.is_null() {
                let _: () = msg_send![rep, release];
                return None;
            }
            let _: () = msg_send![class!(NSGraphicsContext), saveGraphicsState];
            let _: () = msg_send![class!(NSGraphicsContext), setCurrentContext: context];
            let frame = Rect {
                origin: Point {
                    x: 0.0,
                    y: cell.height - glyph.height,
                },
                size: glyph,
            };
            let _: () = msg_send![image, drawInRect: frame];
            let _: () = msg_send![context, flushGraphics];
            let _: () = msg_send![class!(NSGraphicsContext), restoreGraphicsState];
            let data: *const u8 = msg_send![rep, bitmapData];
            let row: isize = msg_send![rep, bytesPerRow];
            let (wide, high) = (wide as usize, high as usize);
            let alpha = if data.is_null() || (row as usize) < wide * 4 {
                None
            } else {
                let bytes = std::slice::from_raw_parts(data, row as usize * high);
                Some(
                    bytes
                        .chunks_exact(row as usize)
                        .flat_map(|line| {
                            line[..wide * 4]
                                .as_chunks::<4>()
                                .0
                                .iter()
                                .map(|pixel| pixel[3])
                        })
                        .collect::<Vec<u8>>(),
                )
            };
            let _: () = msg_send![rep, release];
            let alpha = alpha?;
            let (width, height) = (glyph.width as f32, glyph.height as f32);
            let ink_offset = ink_offset(&alpha, wide, high, raster.scale, width, height);
            Some(SymbolMask {
                pixels_wide: wide as u32,
                pixels_high: high as u32,
                alpha,
                width,
                height,
                ink_offset,
            })
        }
    }

    #[cfg(test)]
    pub fn image_view_ink_width(
        raster: &SymbolRaster<'_>,
        frame_width: f64,
        frame_height: f64,
    ) -> Option<f32> {
        autoreleasepool(|_| unsafe {
            let image = configured_symbol(raster.name, raster.point_size, raster.weight);
            if image.is_null() {
                return None;
            }
            let natural: Size = msg_send![image, size];
            let fit = (frame_width / natural.width)
                .min(frame_height / natural.height)
                .min(1.0);
            let drawn = Size {
                width: natural.width * fit,
                height: natural.height * fit,
            };
            let bounds = Rect {
                origin: Point::default(),
                size: drawn,
            };
            let allocated: *mut AnyObject = msg_send![class!(NSImageView), alloc];
            let view: *mut AnyObject = msg_send![allocated, initWithFrame: bounds];
            if view.is_null() {
                return None;
            }
            let _: () = msg_send![view, setImageScaling: 0usize];
            let _: () = msg_send![view, setImageAlignment: 0usize];
            let _: () = msg_send![view, setImage: image];
            let scale = f64::from(raster.scale);
            let wide = (drawn.width * scale).ceil() as isize;
            let high = (drawn.height * scale).ceil() as isize;
            let space = ns_string("NSDeviceRGBColorSpace");
            let allocated: *mut AnyObject = msg_send![class!(NSBitmapImageRep), alloc];
            let rep: *mut AnyObject = msg_send![
                allocated,
                initWithBitmapDataPlanes: null_mut::<*mut u8>(),
                pixelsWide: wide,
                pixelsHigh: high,
                bitsPerSample: 8isize,
                samplesPerPixel: 4isize,
                hasAlpha: Bool::YES,
                isPlanar: Bool::NO,
                colorSpaceName: space,
                bytesPerRow: 0isize,
                bitsPerPixel: 0isize
            ];
            if rep.is_null() {
                let _: () = msg_send![view, release];
                return None;
            }
            let _: () = msg_send![rep, setSize: drawn];
            let _: () = msg_send![view, cacheDisplayInRect: bounds, toBitmapImageRep: rep];
            let data: *const u8 = msg_send![rep, bitmapData];
            let row: isize = msg_send![rep, bytesPerRow];
            let (wide, high, row) = (wide as usize, high as usize, row as usize);
            let alpha = (!data.is_null()).then(|| {
                std::slice::from_raw_parts(data, row * high)
                    .chunks_exact(row)
                    .flat_map(|line| line[..wide * 4].as_chunks::<4>().0.iter().map(|p| p[3]))
                    .collect::<Vec<u8>>()
            });
            let _: () = msg_send![rep, release];
            let _: () = msg_send![view, release];
            super::ink_width(&alpha?, wide, raster.scale)
        })
    }

    unsafe fn draw(request: &SymbolRequest<'_>) -> Option<Vec<u8>> {
        unsafe {
            let name = ns_string(request.name);
            if name.is_null() {
                return None;
            }
            let base: *mut AnyObject = msg_send![
                class!(NSImage),
                imageWithSystemSymbolName: name,
                accessibilityDescription: null_mut::<AnyObject>()
            ];
            if base.is_null() {
                return None;
            }
            let config: *mut AnyObject = msg_send![
                class!(NSImageSymbolConfiguration),
                configurationWithPointSize: f64::from(request.point_size),
                weight: font_weight(request.weight)
            ];
            let image: *mut AnyObject = if config.is_null() {
                base
            } else {
                msg_send![base, imageWithSymbolConfiguration: config]
            };
            if image.is_null() {
                return None;
            }
            let glyph: Size = msg_send![image, size];
            let side = f64::from(request.box_size);
            let pixels = (side * PIXEL_SCALE).round().max(1.0) as isize;
            let space = ns_string("NSDeviceRGBColorSpace");
            let allocated: *mut AnyObject = msg_send![class!(NSBitmapImageRep), alloc];
            let rep: *mut AnyObject = msg_send![
                allocated,
                initWithBitmapDataPlanes: null_mut::<*mut u8>(),
                pixelsWide: pixels,
                pixelsHigh: pixels,
                bitsPerSample: 8isize,
                samplesPerPixel: 4isize,
                hasAlpha: Bool::YES,
                isPlanar: Bool::NO,
                colorSpaceName: space,
                bytesPerRow: 0isize,
                bitsPerPixel: 0isize
            ];
            if rep.is_null() {
                return None;
            }
            let _: () = msg_send![rep, setSize: Size { width: side, height: side }];
            let context: *mut AnyObject =
                msg_send![class!(NSGraphicsContext), graphicsContextWithBitmapImageRep: rep];
            if context.is_null() {
                let _: () = msg_send![rep, release];
                return None;
            }
            let _: () = msg_send![class!(NSGraphicsContext), saveGraphicsState];
            let _: () = msg_send![class!(NSGraphicsContext), setCurrentContext: context];
            let frame = Rect {
                origin: Point {
                    x: (side - glyph.width) / 2.0,
                    y: (side - glyph.height) / 2.0,
                },
                size: glyph,
            };
            let _: () = msg_send![image, drawInRect: frame];
            let channel = |shift: u32| f64::from((request.rgba >> shift) & 0xff) / 255.0;
            let color: *mut AnyObject = msg_send![
                class!(NSColor),
                colorWithSRGBRed: channel(24),
                green: channel(16),
                blue: channel(8),
                alpha: channel(0)
            ];
            if !color.is_null() {
                let _: () = msg_send![color, set];
                NSRectFillUsingOperation(
                    Rect {
                        origin: Point::default(),
                        size: Size {
                            width: side,
                            height: side,
                        },
                    },
                    COMPOSITE_SOURCE_IN,
                );
            }
            let _: () = msg_send![class!(NSGraphicsContext), restoreGraphicsState];
            let properties: *mut AnyObject = msg_send![class!(NSDictionary), dictionary];
            let data: *mut AnyObject =
                msg_send![rep, representationUsingType: PNG_FILE_TYPE, properties: properties];
            let bytes = if data.is_null() {
                None
            } else {
                let length: usize = msg_send![data, length];
                let start: *const std::ffi::c_void = msg_send![data, bytes];
                (!start.is_null() && length > 0)
                    .then(|| std::slice::from_raw_parts(start.cast::<u8>(), length).to_vec())
            };
            let _: () = msg_send![rep, release];
            bytes
        }
    }
}

#[cfg(test)]
fn ink_width(alpha: &[u8], wide: usize, scale: f32) -> Option<f32> {
    if wide == 0 || !alpha.len().is_multiple_of(wide) {
        return None;
    }
    let inked = |column: usize| alpha.chunks_exact(wide).any(|line| line[column] > 0);
    let first = (0..wide).find(|&column| inked(column))?;
    let last = (0..wide).rfind(|&column| inked(column))?;
    Some((last - first + 1) as f32 / scale)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request(name: &str) -> SymbolRequest<'_> {
        SymbolRequest {
            name,
            point_size: 11.0,
            box_size: 26.0,
            weight: SymbolWeight::Semibold,
            rgba: 0xffff_ffff,
        }
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn renders_system_symbols_as_png() {
        let image = symbol_image(request("house.fill")).expect("house.fill renders");
        assert!(image.bytes().starts_with(&[0x89, b'P', b'N', b'G']));
        assert!(symbol_image(request("not.a.real.symbol.name")).is_none());
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn masks_render_at_the_backing_scale_and_unknown_names_refuse() {
        let raster = SymbolRaster {
            name: "chevron.left",
            point_size: 13.0,
            weight: SymbolWeight::Medium,
            scale: 2.0,
        };
        let mask = symbol_mask(&raster).expect("chevron.left renders");
        assert_eq!(mask.pixels_wide, (mask.width * 2.0).ceil() as u32);
        assert_eq!(mask.pixels_high, (mask.height * 2.0).ceil() as u32);
        assert_eq!(
            mask.alpha.len(),
            (mask.pixels_wide * mask.pixels_high) as usize
        );
        assert!(mask.alpha.contains(&255));
        let single = symbol_mask(&SymbolRaster {
            scale: 1.0,
            ..raster
        })
        .expect("1x renders");
        assert!(single.pixels_wide < mask.pixels_wide);
        assert!(
            symbol_mask(&SymbolRaster {
                name: "ardia.mark",
                ..raster
            })
            .is_none()
        );
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn person_pair_matches_the_old_image_view_in_plain_and_fitted_frames() {
        let raster = SymbolRaster {
            name: "person.2.fill",
            point_size: 10.0,
            weight: SymbolWeight::Semibold,
            scale: 2.0,
        };
        let natural = symbol_mask(&raster).expect("person.2.fill renders");
        let plain = ink_width(&natural.alpha, natural.pixels_wide as usize, 2.0).expect("ink");
        let plain_reference = macos::image_view_ink_width(&raster, 64.0, 64.0).expect("reference");
        assert!(
            (plain - plain_reference).abs() <= 0.5,
            "plain {plain} vs AppKit {plain_reference}"
        );
        let fit = ardia_ui::primitives::symbol_glyphs::symbol_fit(
            natural.width,
            natural.height,
            16.0,
            10.0,
        );
        let fitted = fitted_symbol_mask(&raster, fit).expect("fitted renders");
        assert!((fitted.width - natural.width * fit).abs() < 1e-3);
        assert!((fitted.height - 10.0).abs() < 1e-3);
        let ours = ink_width(&fitted.alpha, fitted.pixels_wide as usize, 2.0).expect("ink");
        let reference = macos::image_view_ink_width(&raster, 16.0, 10.0).expect("reference");
        assert!(
            (ours - reference).abs() <= 0.5,
            "fitted {ours} vs AppKit {reference}"
        );
        assert!((10.0..=12.0).contains(&reference), "AppKit {reference}");
    }

    #[test]
    fn ink_width_measures_covered_columns_in_points() {
        assert_eq!(ink_width(&[0, 9, 0, 9, 0, 0, 0, 0], 4, 2.0), Some(1.5));
        assert_eq!(ink_width(&[0; 8], 4, 2.0), None);
        assert_eq!(ink_width(&[1; 7], 4, 2.0), None);
    }

    #[test]
    fn empty_requests_are_refused() {
        assert!(symbol_image(request("")).is_none());
        assert!(
            symbol_image(SymbolRequest {
                box_size: 0.0,
                ..request("house.fill")
            })
            .is_none()
        );
    }
}
